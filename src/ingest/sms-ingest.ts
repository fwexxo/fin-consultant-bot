import type { Db } from '../db/index.ts';
import { parseSms, type ParsedSms } from '../core/sms.ts';
import { toMinor, formatMoney } from '../core/money.ts';
import {
  listAccounts, createAccount, accountBalance, type Account,
} from '../core/accounts.ts';
import { recordTransaction, recordTransfer } from '../core/transactions.ts';

export interface IncomingSms {
  rowid: number;
  date: string;   // YYYY-MM-DD, когда сообщение получено
  text: string;
}

export interface IngestOptions {
  card: string;
  cardAccountName: string;
  cashAccountName: string;
  /** Операции строго с этой даты включительно. */
  sinceDate: string;
}

export interface IngestedOp {
  kind: ParsedSms['kind'];
  date: string;
  amountRub: number;
  merchant: string | null;
  original?: { amount: number; currency: string };
}

export interface IngestResult {
  seen: number;
  skippedDuplicate: number;
  skippedTooOld: number;
  skippedUnparsed: number;
  recorded: IngestedOp[];
  /** Расхождение с банком в копейках; null — сверка не проводилась. */
  drift: { bankMinor: number; oursMinor: number; driftMinor: number } | null;
}

function findOrCreateAccount(db: Db, name: string, currency: 'RUB'): Account {
  const existing = listAccounts(db).find((a) => a.name === name);
  if (existing) return existing;
  const id = createAccount(db, { name, currency, kind: 'cash' });
  return listAccounts(db).find((a) => a.id === id)!;
}

/**
 * Записывает новые операции из СМС.
 *
 * Идемпотентна: сообщение, уже отмеченное в sms_ingested, пропускается,
 * поэтому наблюдатель может слать одну и ту же пачку сколько угодно раз.
 */
export async function ingestSms(
  db: Db,
  messages: IncomingSms[],
  opts: IngestOptions,
): Promise<IngestResult> {
  const result: IngestResult = {
    seen: messages.length,
    skippedDuplicate: 0,
    skippedTooOld: 0,
    skippedUnparsed: 0,
    recorded: [],
    drift: null,
  };

  const cardAccount = listAccounts(db).find((a) => a.name === opts.cardAccountName);
  if (!cardAccount) {
    throw new Error(`Нет счёта «${opts.cardAccountName}» — сначала создай его`);
  }

  const seenBefore = db.prepare(
    'SELECT 1 FROM sms_ingested WHERE source = ? AND source_id = ? LIMIT 1',
  );
  const markIngested = db.prepare(
    'INSERT INTO sms_ingested (source, source_id, tx_id, raw) VALUES (?,?,?,?)',
  );

  let lastBalanceRub: number | null = null;

  for (const msg of messages) {
    if (seenBefore.get('imessage', String(msg.rowid))) {
      result.skippedDuplicate += 1;
      continue;
    }

    const ops = parseSms(msg.text, opts.card);
    if (ops.length === 0) {
      result.skippedUnparsed += 1;
      continue;
    }

    // Дата из самого СМС важнее даты доставки: отложенные уведомления
    // приходят позже, чем произошла операция.
    const date = ops[0]!.date ?? msg.date;
    if (date < opts.sinceDate) {
      result.skippedTooOld += 1;
      continue;
    }

    for (const op of ops) {
      const amountMinor = toMinor(op.amountRub, 'RUB');
      const note = [
        op.merchant,
        op.original ? `${op.original.amount} ${op.original.currency}` : null,
      ].filter(Boolean).join(' · ') || null;

      let txId: number | null = null;

      if (op.kind === 'expense' || op.kind === 'income') {
        txId = await recordTransaction(db, {
          ts: date,
          accountId: cardAccount.id,
          amountMinor,
          direction: op.kind,
          note,
          rawText: msg.text,
        });
      } else {
        // Наличные не исчезают и не появляются — они переезжают между
        // картой и карманом. Поэтому перевод, а не расход или доход.
        const cash = findOrCreateAccount(db, opts.cashAccountName, 'RUB');
        const [from, to] = op.kind === 'cash_withdrawal'
          ? [cardAccount, cash]
          : [cash, cardAccount];

        txId = await recordTransfer(db, {
          ts: date,
          fromAccountId: from.id,
          fromAmountMinor: amountMinor,
          toAccountId: to.id,
          toAmountMinor: amountMinor,
          note,
        });
      }

      markIngested.run('imessage', String(msg.rowid), txId, msg.text);
      result.recorded.push({
        kind: op.kind,
        date,
        amountRub: op.amountRub,
        merchant: op.merchant,
        original: op.original,
      });
    }

    lastBalanceRub = ops[ops.length - 1]!.balanceRub;
  }

  // Сверка с банком по последнему присланному остатку.
  if (lastBalanceRub !== null) {
    const bankMinor = toMinor(lastBalanceRub, 'RUB');
    const oursMinor = accountBalance(db, cardAccount.id);
    const driftMinor = oursMinor - bankMinor;

    db.prepare(
      'INSERT INTO balance_checks (account_id, bank_minor, ours_minor, drift_minor) VALUES (?,?,?,?)',
    ).run(cardAccount.id, bankMinor, oursMinor, driftMinor);

    result.drift = { bankMinor, oursMinor, driftMinor };
  }

  return result;
}

const KIND_LABEL: Record<ParsedSms['kind'], string> = {
  expense: 'трата',
  income: 'поступление',
  cash_withdrawal: 'снятие наличных',
  cash_deposit: 'внесение наличных',
};

/**
 * Порог, ниже которого о расхождении не сообщаем: 50 рублей.
 *
 * Мелкое расхождение обычно постоянное — банк округляет остаток, или пара
 * копеек разошлась на самой первой сверке и с тех пор просто переносится.
 * Предупреждать о нём при каждой покупке значит приучить не читать
 * предупреждения вообще, и настоящую пропажу тогда тоже пролистают.
 */
export const DEFAULT_DRIFT_ALERT_MINOR = 5_000;

/** Человеческая сводка для отправки в Телеграм. */
export function formatIngestSummary(
  r: IngestResult,
  cardAccountName: string,
  driftAlertMinor: number = DEFAULT_DRIFT_ALERT_MINOR,
): string | null {
  if (r.recorded.length === 0) return null;

  const lines = r.recorded.map((op) => {
    const what = op.merchant ?? KIND_LABEL[op.kind];
    const orig = op.original ? ` (${op.original.amount} ${op.original.currency})` : '';
    const sign = op.kind === 'income' || op.kind === 'cash_deposit' ? '+' : '−';
    return `  ${sign}${op.amountRub.toFixed(2)} ₽${orig} — ${what}`;
  });

  let text = `Записал с «${cardAccountName}»:\n${lines.join('\n')}`;

  // Сверка всё равно пишется в balance_checks — молчим только в сообщении,
  // историю расхождений это не обрезает.
  const drift = r.drift?.driftMinor ?? 0;
  if (r.drift && drift !== 0 && Math.abs(drift) >= driftAlertMinor) {
    text += `\n\n⚠️ Расхождение с банком: ${formatMoney(r.drift.driftMinor, 'RUB')}.`
      + `\nУ банка ${formatMoney(r.drift.bankMinor, 'RUB')}, у меня ${formatMoney(r.drift.oursMinor, 'RUB')}.`
      + `\nВероятно, часть операций не попала в бота.`;
  }

  return text;
}
