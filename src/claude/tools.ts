import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '../db/index.ts';
import { runReadOnlyQuery } from '../core/query.ts';
import { listAccounts, accountBalance, getAccount } from '../core/accounts.ts';
import { recordTransaction, recordTransfer } from '../core/transactions.ts';
import { dueSoon, markPaid } from '../core/recurring.ts';
import { toMinor, formatMoney, convertMinor, RATE_SCALE } from '../core/money.ts';
import { getRate } from '../core/fx.ts';
import type { Currency } from '../config.ts';

const CURRENCY = z.enum(['RUB', 'BYN', 'USD']);
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате YYYY-MM-DD');

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Оборачивает обработчик: ошибка возвращается модели текстом, а не роняет вызов. */
async function guard(fn: () => Promise<string> | string) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(`Ошибка: ${(err as Error).message}`);
  }
}

function categoryId(db: Db, name: string | undefined, kind: 'expense' | 'income'): number | null {
  if (!name) return null;
  const row = db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?')
    .get(name, kind) as { id: number } | undefined;
  return row?.id ?? null;
}

export function buildTools(db: Db, today: () => string) {
  const recordExpense = tool(
    'record_expense',
    'Записать расход. Используй, когда человек сообщает, что потратил деньги.',
    {
      amount: z.number().positive().describe('сумма в основных единицах, например 5.50'),
      currency: CURRENCY,
      account_id: z.number().int().describe('id счёта, с которого ушли деньги'),
      category: z.string().optional().describe('название категории из списка'),
      date: ISO_DATE.optional().describe('дата операции, по умолчанию сегодня'),
      note: z.string().optional(),
    },
    async (args) => guard(async () => {
      const account = getAccount(db, args.account_id);
      const amountMinor = toMinor(args.amount, args.currency as Currency);
      const id = await recordTransaction(db, {
        ts: args.date ?? today(),
        accountId: args.account_id,
        amountMinor,
        direction: 'expense',
        categoryId: categoryId(db, args.category, 'expense'),
        note: args.note ?? null,
      });
      const balance = accountBalance(db, args.account_id);
      return `Расход записан (id=${id}): ${formatMoney(amountMinor, account.currency)} `
        + `со счёта «${account.name}». Остаток: ${formatMoney(balance, account.currency)}`;
    }),
  );

  const recordIncome = tool(
    'record_income',
    'Записать доход или пополнение счёта. Используй, когда деньги ПРИШЛИ: зарплата, '
    + 'аванс, перевод от кого-то, пополнение карты, возврат.',
    {
      amount: z.number().positive(),
      currency: CURRENCY,
      account_id: z.number().int().describe('id счёта, на который пришли деньги'),
      category: z.string().optional(),
      date: ISO_DATE.optional(),
      note: z.string().optional(),
    },
    async (args) => guard(async () => {
      const account = getAccount(db, args.account_id);
      const amountMinor = toMinor(args.amount, args.currency as Currency);
      const id = await recordTransaction(db, {
        ts: args.date ?? today(),
        accountId: args.account_id,
        amountMinor,
        direction: 'income',
        categoryId: categoryId(db, args.category, 'income'),
        note: args.note ?? null,
      });
      const balance = accountBalance(db, args.account_id);
      return `Доход записан (id=${id}): ${formatMoney(amountMinor, account.currency)} `
        + `на счёт «${account.name}». Остаток: ${formatMoney(balance, account.currency)}`;
    }),
  );

  const transfer = tool(
    'record_transfer',
    'Перевод между своими счетами. При обмене валют суммы отличаются: '
    + 'from_amount в валюте счёта-источника, to_amount — получателя.',
    {
      from_account_id: z.number().int(),
      to_account_id: z.number().int(),
      from_amount: z.number().positive(),
      to_amount: z.number().positive(),
      date: ISO_DATE.optional(),
      note: z.string().optional(),
    },
    async (args) => guard(async () => {
      const from = getAccount(db, args.from_account_id);
      const to = getAccount(db, args.to_account_id);
      await recordTransfer(db, {
        ts: args.date ?? today(),
        fromAccountId: args.from_account_id,
        fromAmountMinor: toMinor(args.from_amount, from.currency),
        toAccountId: args.to_account_id,
        toAmountMinor: toMinor(args.to_amount, to.currency),
        note: args.note ?? null,
      });
      return `Перевод записан: «${from.name}» → «${to.name}». `
        + `Остатки: ${formatMoney(accountBalance(db, from.id), from.currency)} / `
        + `${formatMoney(accountBalance(db, to.id), to.currency)}`;
    }),
  );

  const deleteTx = tool(
    'delete_transaction',
    'Удалить ошибочно записанную операцию по её id. Используй, когда человек просит '
    + 'отменить, удалить или исправить запись. Для исправления — удали и запиши заново.',
    { transaction_id: z.number().int() },
    async (args) => guard(() => {
      const row = db.prepare(
        'SELECT t.id, t.amount_minor, t.currency, t.direction, t.ts, a.name AS account '
        + 'FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?',
      ).get(args.transaction_id) as {
        id: number; amount_minor: number; currency: Currency;
        direction: string; ts: string; account: string;
      } | undefined;

      if (!row) return `Операции ${args.transaction_id} нет`;

      if (row.direction.startsWith('transfer')) {
        return 'Это половина перевода. Удаляй переводы целиком: найди обе строки '
          + 'через query_db по counter_account_id и удали обе.';
      }

      // Отвязываем от регулярного платежа, иначе он останется «оплаченным»
      // без подтверждающей операции.
      db.prepare("UPDATE payment_instances SET status='pending', paid_tx_id=NULL WHERE paid_tx_id=?")
        .run(args.transaction_id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(args.transaction_id);

      return `Удалено: ${row.direction === 'income' ? 'доход' : 'расход'} `
        + `${formatMoney(row.amount_minor, row.currency)} от ${row.ts} («${row.account}»)`;
    }),
  );

  const queryDb = tool(
    'query_db',
    'Выполнить SELECT к базе, чтобы ответить на вопрос про финансы. '
    + 'Таблицы: accounts(id,name,currency,kind), transactions(id,ts,account_id,'
    + 'amount_minor,currency,category_id,direction,counter_account_id,note,fx_rate_to_base), '
    + 'categories(id,name,kind), recurring_payments(id,title,account_id,amount_minor,'
    + 'currency,day_of_month,is_last_day,is_variable), payment_instances(id,recurring_id,'
    + 'period,due_date,status). Суммы в amount_minor — КОПЕЙКИ (дели на 100). '
    + "direction: 'expense'|'income'|'transfer_out'|'transfer_in'.",
    { sql: z.string().describe('один SELECT-запрос') },
    async (args) => guard(() => {
      const rows = runReadOnlyQuery(db, args.sql);
      return rows.length === 0 ? 'Пусто' : JSON.stringify(rows, null, 1);
    }),
  );

  const accounts = tool(
    'list_accounts',
    'Список счетов с остатками.',
    {},
    async () => guard(() => {
      const rows = listAccounts(db).map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        balance: formatMoney(accountBalance(db, a.id), a.currency),
      }));
      return JSON.stringify(rows, null, 1);
    }),
  );

  const due = tool(
    'list_due_payments',
    'Регулярные платежи, которые скоро нужно оплатить или уже просрочены.',
    {},
    async () => guard(() => {
      const rows = dueSoon(db, today()).map((d) => ({
        payment_id: d.id,
        title: d.title,
        due_date: d.due_date,
        amount: d.amount_minor === null
          ? 'плавающая'
          : formatMoney(d.amount_minor, d.currency),
        currency: d.currency,
      }));
      return rows.length === 0 ? 'Ближайших платежей нет' : JSON.stringify(rows, null, 1);
    }),
  );

  const payPayment = tool(
    'mark_payment_paid',
    'Отметить регулярный платёж оплаченным. Создаёт расход на указанную сумму.',
    {
      payment_id: z.number().int().describe('id из list_due_payments'),
      amount: z.number().positive().describe('фактически уплаченная сумма'),
    },
    async (args) => guard(async () => {
      const row = db.prepare(
        'SELECT r.currency, r.title FROM payment_instances pi '
        + 'JOIN recurring_payments r ON r.id = pi.recurring_id WHERE pi.id = ?',
      ).get(args.payment_id) as { currency: Currency; title: string } | undefined;
      if (!row) return `Платежа ${args.payment_id} нет`;

      const minor = toMinor(args.amount, row.currency);
      await markPaid(db, args.payment_id, minor, today());
      return `«${row.title}» отмечен оплаченным: ${formatMoney(minor, row.currency)}`;
    }),
  );

  const setRecurringAmount = tool(
    'set_recurring_amount',
    'Задать фиксированную сумму регулярного платежа, чтобы бот перестал спрашивать её каждый раз.',
    {
      recurring_id: z.number().int(),
      amount: z.number().positive(),
    },
    async (args) => guard(() => {
      const row = db.prepare('SELECT title, currency FROM recurring_payments WHERE id = ?')
        .get(args.recurring_id) as { title: string; currency: Currency } | undefined;
      if (!row) return `Правила ${args.recurring_id} нет`;

      const minor = toMinor(args.amount, row.currency);
      db.prepare('UPDATE recurring_payments SET amount_minor = ?, is_variable = 0 WHERE id = ?')
        .run(minor, args.recurring_id);
      return `«${row.title}»: сумма зафиксирована — ${formatMoney(minor, row.currency)}`;
    }),
  );

  const exchangeRate = tool(
    'get_exchange_rate',
    'Курс валюты к BYN по данным Нацбанка РБ на дату. Возвращает, сколько BYN стоит '
    + 'одна единица валюты. Ходит в сеть, если курса нет в кеше.',
    {
      currency: CURRENCY,
      date: ISO_DATE.optional().describe('по умолчанию сегодня'),
    },
    async (args) => guard(async () => {
      const date = args.date ?? today();
      const stored = await getRate(db, args.currency as Currency, date);
      return `1 ${args.currency} = ${(stored / RATE_SCALE).toFixed(4)} BYN на ${date}`;
    }),
  );

  const totalInBase = tool(
    'total_in_base',
    'Суммарные деньги на всех счетах, пересчитанные в BYN по текущему курсу Нацбанка. '
    + 'Используй для вопросов «сколько у меня всего».',
    {},
    async () => guard(async () => {
      const date = today();
      const parts: string[] = [];
      let total = 0;

      for (const a of listAccounts(db)) {
        const balance = accountBalance(db, a.id);
        if (balance === 0) continue;
        const rate = await getRate(db, a.currency, date);
        const inBase = convertMinor(balance, rate);
        total += inBase;
        parts.push(`  ${a.name}: ${formatMoney(balance, a.currency)} = ${formatMoney(inBase, 'BYN')}`);
      }

      if (parts.length === 0) return 'На счетах пусто';
      return `${parts.join('\n')}\n  ИТОГО: ${formatMoney(total, 'BYN')} (курс НБРБ на ${date})`;
    }),
  );

  return createSdkMcpServer({
    name: 'finance',
    version: '1.0.0',
    tools: [
      recordExpense, recordIncome, transfer, deleteTx,
      queryDb, accounts, due, payPayment, setRecurringAmount,
      exchangeRate, totalInBase,
    ],
  });
}

/** Полные имена инструментов для allowedTools. */
export const TOOL_NAMES = [
  'record_expense', 'record_income', 'record_transfer', 'delete_transaction',
  'query_db', 'list_accounts', 'list_due_payments', 'mark_payment_paid',
  'set_recurring_amount', 'get_exchange_rate', 'total_in_base',
].map((n) => `mcp__finance__${n}`);
