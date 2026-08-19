import { Bot, InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Queue } from '../claude/queue.ts';
import { runAgent, type Turn } from '../claude/agent.ts';
import { isOwner } from './guard.ts';
import { listAccounts, accountBalance } from '../core/accounts.ts';
import { expensesByCategory, monthSummary, forecast } from '../core/reports.ts';
import { dueSoon, markPaid } from '../core/recurring.ts';
import { formatMoney } from '../core/money.ts';
import { currentPeriod } from '../core/dates.ts';

export { isOwner };

export interface BotDeps {
  cfg: Config;
  db: Db;
  queue: Queue;
}

const HISTORY_LIMIT = 10;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Держит индикатор «печатает» живым: Telegram гасит его через ~5 секунд,
 * а вызов агента с инструментами занимает заметно дольше.
 */
function keepTyping(send: () => Promise<unknown>): () => void {
  void send().catch(() => {});
  const timer = setInterval(() => { void send().catch(() => {}); }, 4000);
  return () => clearInterval(timer);
}

export function createBot(deps: BotDeps): Bot {
  const { cfg, db, queue } = deps;
  const bot = new Bot(cfg.botToken);

  // История диалога живёт в памяти: после перезапуска бот начинает
  // с чистого листа, что для личного помощника приемлемо.
  const history: Turn[] = [];

  function remember(role: Turn['role'], text: string) {
    history.push({ role, text });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  }

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
    history.length = 0;
    await ctx.reply(
      'Привет. Пиши как есть — «кофе 5 руб», «на карту пришло 20000», '
      + '«сколько я трачу на еду?». Разберусь.\n\n'
      + 'Быстрые команды: /balance /month /cat /due /forecast\n'
      + '/reset — забыть контекст разговора',
    );
  });

  bot.command('reset', async (ctx) => {
    history.length = 0;
    await ctx.reply('Контекст очищен.');
  });

  bot.command('balance', async (ctx) => {
    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      await ctx.reply('Счетов пока нет.');
      return;
    }
    await ctx.reply(accounts
      .map((a) => `${a.name}: ${formatMoney(accountBalance(db, a.id), a.currency)}`)
      .join('\n'));
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
    await ctx.reply(`Расходы за ${period}\n\n${rows
      .map((r) => `${r.category}: ${formatMoney(r.totalBase, cfg.baseCurrency)}`)
      .join('\n')}`);
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
      await ctx.reply(`${r.title} — ${amount}\nСрок: ${r.due_date}${overdue}`, {
        reply_markup: new InlineKeyboard().text('Оплачено', `paid:${r.id}`),
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
      await ctx.answerCallbackQuery();
      // Сумму спросим текстом: дальше её подхватит агент, у которого
      // этот вопрос окажется в истории диалога.
      remember('assistant', `Сколько вышло за «${row.title}» (платёж ${instanceId})?`);
      await ctx.reply(`Сколько вышло за «${row.title}»? Напиши сумму.`);
      return;
    }

    try {
      await markPaid(db, instanceId, row.amount_minor, today());
      await ctx.editMessageText(
        `${row.title} — оплачено\n${formatMoney(row.amount_minor, row.currency)}`,
      );
      await ctx.answerCallbackQuery('Записано');
    } catch (err) {
      await ctx.answerCallbackQuery(String((err as Error).message).slice(0, 190));
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const stopTyping = keepTyping(() => ctx.replyWithChatAction('typing'));

    try {
      const answer = await queue.run(() => runAgent({ cfg, db }, text, [...history]));
      remember('user', text);
      remember('assistant', answer);
      await ctx.reply(answer);
    } catch (err) {
      console.error('Агент упал:', err);
      await ctx.reply(`Что-то пошло не так: ${(err as Error).message}`);
    } finally {
      stopTyping();
    }
  });

  bot.catch((err) => {
    console.error('Ошибка бота:', err.error);
  });

  return bot;
}
