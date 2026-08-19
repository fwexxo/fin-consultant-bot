import { Bot, InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Queue } from '../claude/queue.ts';
import { parseTransaction } from '../claude/parse.ts';
import { isOwner } from './guard.ts';
import { listAccounts, accountBalance } from '../core/accounts.ts';
import { recordTransaction } from '../core/transactions.ts';
import { expensesByCategory, monthSummary, forecast } from '../core/reports.ts';
import { dueSoon, markPaid } from '../core/recurring.ts';
import { formatMoney, toMinor } from '../core/money.ts';
import { currentPeriod } from '../core/dates.ts';

export { isOwner };

export interface BotDeps {
  cfg: Config;
  db: Db;
  queue: Queue;
}

interface Draft {
  amountMinor: number;
  categoryId: number | null;
  date: string;
  direction: 'expense' | 'income';
  accountId: number;
  accountName: string;
  currency: 'RUB' | 'BYN' | 'USD';
  rawText: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createBot(deps: BotDeps): Bot {
  const { cfg, db, queue } = deps;
  const bot = new Bot(cfg.botToken);

  // Черновики транзакций до подтверждения. Живут в памяти: после
  // перезапуска бота неподтверждённый черновик просто исчезает, что
  // безопаснее, чем записать его вслепую.
  const drafts = new Map<number, Draft>();
  let draftSeq = 0;

  // Инстанс платежа с плавающей суммой, для которого ждём число.
  let awaitingAmountFor: number | null = null;

  // Единственный барьер доступа. Стоит первым, до любых обработчиков.
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;

    if (cfg.ownerId === null) {
      if (fromId !== undefined) {
        await ctx.reply(
          `OWNER_ID не задан.\n\nТвой Telegram ID: ${fromId}\n\n`
          + `Впиши в .env строку OWNER_ID=${fromId} и перезапусти бота.`,
        );
      }
      return;
    }

    if (!isOwner(cfg.ownerId, fromId)) {
      // Молчим намеренно: любой ответ подтвердил бы, что бот живой.
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Финансовый консультант готов.\n\n'
      + 'Пиши тратами как человеку: «кофе 5 руб», «зп 1200 usd».\n\n'
      + 'Команды:\n'
      + '/balance — остатки по счетам\n'
      + '/month — сводка за месяц\n'
      + '/cat — расходы по категориям\n'
      + '/due — ближайшие платежи\n'
      + '/forecast — сколько свободно',
    );
  });

  bot.command('balance', async (ctx) => {
    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      await ctx.reply('Счетов пока нет. Запусти на сервере: npm run seed');
      return;
    }
    const lines = accounts.map(
      (a) => `${a.name}: ${formatMoney(accountBalance(db, a.id), a.currency)}`,
    );
    await ctx.reply(lines.join('\n'));
  });

  bot.command('month', async (ctx) => {
    const period = currentPeriod(new Date());
    const s = monthSummary(db, period);
    await ctx.reply(
      `Сводка за ${period}\n\n`
      + `Доход:  ${formatMoney(s.incomeBase, cfg.baseCurrency)}\n`
      + `Расход: ${formatMoney(s.expenseBase, cfg.baseCurrency)}\n`
      + `Отложено: ${(s.savingsRate * 100).toFixed(0)}%`,
    );
  });

  bot.command('cat', async (ctx) => {
    const period = currentPeriod(new Date());
    const rows = expensesByCategory(db, period);
    if (rows.length === 0) {
      await ctx.reply(`За ${period} расходов ещё нет.`);
      return;
    }
    const lines = rows.map((r) => `${r.category}: ${formatMoney(r.totalBase, cfg.baseCurrency)}`);
    await ctx.reply(`Расходы за ${period}\n\n${lines.join('\n')}`);
  });

  bot.command('due', async (ctx) => {
    const rows = dueSoon(db, today());
    if (rows.length === 0) {
      await ctx.reply('Ближайших платежей нет.');
      return;
    }
    for (const r of rows) {
      const amount = r.amount_minor === null
        ? 'сумма плавающая'
        : formatMoney(r.amount_minor, r.currency);
      const overdue = r.due_date < today() ? ' (просрочен)' : '';
      const kb = new InlineKeyboard().text('Оплачено', `paid:${r.id}`);
      await ctx.reply(`${r.title} — ${amount}\nСрок: ${r.due_date}${overdue}`, {
        reply_markup: kb,
      });
    }
  });

  bot.command('forecast', async (ctx) => {
    const period = currentPeriod(new Date());
    const f = forecast(db, period);
    await ctx.reply(
      `Прогноз на ${period}\n\n`
      + `Всего на счетах: ${formatMoney(f.availableBase, cfg.baseCurrency)}\n`
      + `Неоплаченные обязательства: ${formatMoney(f.unpaidBase, cfg.baseCurrency)}\n`
      + `Свободно: ${formatMoney(f.freeBase, cfg.baseCurrency)}`,
    );
  });

  bot.callbackQuery(/^paid:(\d+)$/, async (ctx) => {
    const instanceId = Number(ctx.match[1]);
    const row = db.prepare(`
      SELECT r.amount_minor, r.currency, r.title, pi.status
      FROM payment_instances pi
      JOIN recurring_payments r ON r.id = pi.recurring_id
      WHERE pi.id = ?
    `).get(instanceId) as {
      amount_minor: number | null; currency: 'RUB' | 'BYN' | 'USD';
      title: string; status: string;
    } | undefined;

    if (!row) {
      await ctx.answerCallbackQuery('Платёж не найден');
      return;
    }
    if (row.status === 'paid') {
      await ctx.answerCallbackQuery('Уже оплачен');
      return;
    }

    if (row.amount_minor === null) {
      awaitingAmountFor = instanceId;
      await ctx.answerCallbackQuery();
      await ctx.reply(`Сколько вышло за «${row.title}»? Напиши число в ${row.currency}.`);
      return;
    }

    try {
      await markPaid(db, instanceId, row.amount_minor, today());
      await ctx.editMessageText(
        `${row.title} — оплачено ✓\n${formatMoney(row.amount_minor, row.currency)}`,
      );
      await ctx.answerCallbackQuery('Записано');
    } catch (err) {
      await ctx.answerCallbackQuery(String((err as Error).message).slice(0, 190));
    }
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    const key = Number(ctx.match[1]);
    const draft = drafts.get(key);
    if (!draft) {
      await ctx.answerCallbackQuery('Черновик устарел, введи заново');
      return;
    }

    try {
      await recordTransaction(db, {
        ts: draft.date,
        accountId: draft.accountId,
        amountMinor: draft.amountMinor,
        direction: draft.direction,
        categoryId: draft.categoryId,
        rawText: draft.rawText,
      });
      drafts.delete(key);
      await ctx.editMessageText(
        `Записано ✓\n${formatMoney(draft.amountMinor, draft.currency)} — ${draft.accountName}\n`
        + `Остаток: ${formatMoney(accountBalance(db, draft.accountId), draft.currency)}`,
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      await ctx.answerCallbackQuery(String((err as Error).message).slice(0, 190));
    }
  });

  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    drafts.delete(Number(ctx.match[1]));
    await ctx.editMessageText('Отменено');
    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // Ждём фактическую сумму плавающего платежа.
    if (awaitingAmountFor !== null) {
      const instanceId = awaitingAmountFor;
      const amount = Number(text.replace(',', '.').replace(/[^\d.]/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        await ctx.reply('Не понял сумму. Напиши число, например: 87.34');
        return;
      }
      const row = db.prepare(`
        SELECT r.currency, r.title FROM payment_instances pi
        JOIN recurring_payments r ON r.id = pi.recurring_id WHERE pi.id = ?
      `).get(instanceId) as { currency: 'RUB' | 'BYN' | 'USD'; title: string };

      awaitingAmountFor = null;
      try {
        await markPaid(db, instanceId, toMinor(amount, row.currency), today());
        await ctx.reply(
          `${row.title} — оплачено ✓\n${formatMoney(toMinor(amount, row.currency), row.currency)}`,
        );
      } catch (err) {
        await ctx.reply(`Не записалось: ${(err as Error).message}`);
      }
      return;
    }

    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      await ctx.reply('Счетов пока нет. Запусти на сервере: npm run seed');
      return;
    }

    const categories = (db.prepare(
      "SELECT name FROM categories WHERE kind = 'expense'",
    ).all() as { name: string }[]).map((r) => r.name);

    await ctx.replyWithChatAction('typing');

    let parsed;
    try {
      parsed = await queue.run(() => parseTransaction(text, {
        today: today(),
        categories,
        defaultCurrency: cfg.baseCurrency,
      }));
    } catch (err) {
      await ctx.reply(`Не понял запись: ${(err as Error).message}`);
      return;
    }

    // Счёт подбирается по валюте: трата в рублях идёт на рублёвый счёт.
    const account = accounts.find((a) => a.currency === parsed.currency) ?? accounts[0]!;

    const kind = parsed.direction === 'income' ? 'income' : 'expense';
    const categoryRow = parsed.category
      ? db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?')
        .get(parsed.category, kind) as { id: number } | undefined
      : undefined;

    const key = ++draftSeq;
    const amountMinor = toMinor(parsed.amount, parsed.currency);
    drafts.set(key, {
      amountMinor,
      categoryId: categoryRow?.id ?? null,
      date: parsed.date,
      direction: parsed.direction,
      accountId: account.id,
      accountName: account.name,
      currency: parsed.currency,
      rawText: text,
    });

    const kb = new InlineKeyboard()
      .text('Записать', `ok:${key}`)
      .text('Отмена', `cancel:${key}`);

    const warn = parsed.confidence === 'low'
      ? '\n\n⚠️ Разбор неоднозначен — проверь перед записью'
      : '';

    await ctx.reply(
      `${parsed.direction === 'income' ? 'Доход' : 'Расход'}\n`
      + `Сумма: ${formatMoney(amountMinor, parsed.currency)}\n`
      + `Категория: ${parsed.category ?? 'без категории'}\n`
      + `Дата: ${parsed.date}\n`
      + `Счёт: ${account.name}${warn}`,
      { reply_markup: kb },
    );
  });

  bot.catch((err) => {
    console.error('Ошибка бота:', err.error);
  });

  return bot;
}
