import cron from 'node-cron';
import type { Bot } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import {
  ensureInstances, dueSoon, markNotified, type DueInstance,
} from '../core/recurring.ts';
import { currentPeriod, type IsoDate } from '../core/dates.ts';
import { renderDue, fetchInstances } from '../bot/due-message.ts';

/**
 * Достраивает инстансы текущего месяца и возвращает те, о которых
 * сегодня ещё не напоминали.
 *
 * Отметка notified_on ставится здесь же, а не в вызывающем коде:
 * иначе сбой отправки в Telegram оставил бы платёж «уже отмеченным»
 * или, наоборот, привёл бы к череде дублей.
 */
export function collectReminders(db: Db, today: IsoDate): DueInstance[] {
  ensureInstances(db, currentPeriod(new Date(`${today}T00:00:00Z`)));

  const due = dueSoon(db, today).filter((d) => d.notified_on !== today);
  for (const d of due) {
    markNotified(db, d.id, today);
  }
  return due;
}

export function startReminders(deps: { cfg: Config; db: Db; bot: Bot }): void {
  const { cfg, db, bot } = deps;
  const ownerId = cfg.ownerId;
  if (ownerId === null) return;

  cron.schedule(`0 ${cfg.reminderHour} * * *`, async () => {
    const today = new Date().toISOString().slice(0, 10);

    let due: DueInstance[];
    try {
      due = collectReminders(db, today);
    } catch (err) {
      console.error('Не удалось собрать напоминания:', err);
      return;
    }

    if (due.length === 0) return;

    // Одно сообщение на все платежи: пять писем каждое утро человек
    // начинает пролистывать не читая, и просроченное тонет вместе с ними.
    const { text, keyboard } = renderDue(fetchInstances(db, due.map((d) => d.id)), today);
    try {
      await bot.api.sendMessage(ownerId, text, { reply_markup: keyboard });
    } catch (err) {
      console.error('Не отправились напоминания:', err);
    }
  }, { timezone: cfg.timezone });

  console.log(`Напоминания включены: ежедневно в ${cfg.reminderHour}:00 (${cfg.timezone})`);
}
