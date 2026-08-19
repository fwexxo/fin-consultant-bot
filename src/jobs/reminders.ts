import cron from 'node-cron';
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import {
  ensureInstances, dueSoon, markNotified, type DueInstance,
} from '../core/recurring.ts';
import { currentPeriod, type IsoDate } from '../core/dates.ts';
import { formatMoney } from '../core/money.ts';

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

    for (const d of due) {
      const amount = d.amount_minor === null
        ? 'сумма плавающая — напиши фактическую'
        : formatMoney(d.amount_minor, d.currency);
      const overdue = d.due_date < today ? ' (просрочен)' : '';
      const kb = new InlineKeyboard().text('Оплачено', `paid:${d.id}`);

      try {
        await bot.api.sendMessage(
          ownerId,
          `Платёж: ${d.title}\n${amount}\nСрок: ${d.due_date}${overdue}`,
          { reply_markup: kb },
        );
      } catch (err) {
        // Сбой одного сообщения не должен ронять остальные напоминания.
        console.error(`Не отправилось напоминание ${d.id}:`, err);
      }
    }
  }, { timezone: cfg.timezone });

  console.log(`Напоминания включены: ежедневно в ${cfg.reminderHour}:00 (${cfg.timezone})`);
}
