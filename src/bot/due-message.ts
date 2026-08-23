import { InlineKeyboard } from 'grammy';
import type { Db } from '../db/index.ts';
import { formatMoney } from '../core/money.ts';
import type { Currency } from '../config.ts';
import type { IsoDate } from '../core/dates.ts';

export interface DueRow {
  id: number;
  title: string;
  amount_minor: number | null;
  currency: Currency;
  due_date: IsoDate;
  status: string;
}

/**
 * Достаёт платежи по списку id, сохраняя порядок по сроку.
 *
 * Нужно, чтобы перерисовать уже отправленное сообщение по актуальному
 * состоянию базы: список id берётся из кнопок самого сообщения, а статусы —
 * отсюда. Так ничего не приходится хранить между перезапусками бота.
 */
export function fetchInstances(db: Db, ids: number[]): DueRow[] {
  if (ids.length === 0) return [];
  const holes = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT pi.id, pi.due_date, pi.status, r.title, r.amount_minor, r.currency
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.id IN (${holes})
    ORDER BY pi.due_date, r.title
  `).all(...ids) as DueRow[];
}

/** «2026-08-15» → «15.08» — год в напоминании только мешает. */
function shortDate(date: IsoDate): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}`;
}

/**
 * Одно сообщение на все платежи вместо письма на каждый.
 *
 * Пять отдельных сообщений каждое утро — это шум, который начинают
 * пролистывать не читая. Кнопки остаются по одной на платёж: нажатие
 * должно закрывать конкретный платёж, а не «все сразу».
 */
export function renderDue(
  rows: DueRow[],
  today: IsoDate,
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [];
  const totals = new Map<Currency, number>();
  const keyboard = new InlineKeyboard();

  for (const r of rows) {
    if (r.status === 'paid') {
      lines.push(`✓ ${r.title} — оплачено`);
      keyboard.text(`✓ ${r.title}`, `paid:${r.id}`).row();
      continue;
    }

    const amount = r.amount_minor === null
      ? 'сумма плавающая'
      : formatMoney(r.amount_minor, r.currency);
    const overdue = r.due_date < today ? ', просрочен' : '';
    lines.push(`• ${r.title} — ${amount}, до ${shortDate(r.due_date)}${overdue}`);

    if (r.amount_minor !== null) {
      totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount_minor);
    }
    keyboard.text(`Оплачено: ${r.title}`, `paid:${r.id}`).row();
  }

  const sums = [...totals].map(([cur, minor]) => formatMoney(minor, cur));
  const footer = sums.length > 0 ? `\n\nИтого осталось: ${sums.join(' + ')}` : '';
  const variable = rows.some((r) => r.status !== 'paid' && r.amount_minor === null);

  return {
    text: `Платежи к оплате\n\n${lines.join('\n')}${footer}`
      + (variable ? '\n(плавающие суммы сюда не вошли)' : ''),
    keyboard,
  };
}

/** Собирает id платежей из кнопок уже отправленного сообщения. */
export function idsFromKeyboard(markup: unknown): number[] {
  const rows = (markup as { inline_keyboard?: { callback_data?: string }[][] })
    ?.inline_keyboard;
  if (!Array.isArray(rows)) return [];

  const ids: number[] = [];
  for (const row of rows) {
    for (const btn of row) {
      const m = /^paid:(\d+)$/.exec(btn.callback_data ?? '');
      if (m) ids.push(Number(m[1]));
    }
  }
  return ids;
}
