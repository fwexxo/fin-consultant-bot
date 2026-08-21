import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import { dueDateFor, type IsoDate, type Period } from './dates.ts';
import { recordTransaction } from './transactions.ts';
import type { RatesFetcher } from './fx.ts';

export interface RecurringInput {
  title: string;
  accountId: number;
  amountMinor: number | null;
  currency: Currency;
  categoryId?: number | null;
  dayOfMonth: number | null;
  isLastDay: boolean;
  isVariable?: boolean;
  remindDaysBefore?: number;
}

export interface Recurring {
  id: number;
  title: string;
  account_id: number;
  category_id: number | null;
  amount_minor: number | null;
  currency: Currency;
  day_of_month: number | null;
  is_last_day: number;
  is_variable: number;
  remind_days_before: number;
}

export interface DueInstance {
  id: number;
  title: string;
  due_date: IsoDate;
  period: Period;
  amount_minor: number | null;
  currency: Currency;
  is_variable: number;
  account_id: number;
  notified_on: string | null;
}

export function createRecurring(db: Db, input: RecurringInput): number {
  const info = db.prepare(`
    INSERT INTO recurring_payments
      (title, account_id, category_id, amount_minor, currency,
       day_of_month, is_last_day, is_variable, remind_days_before)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    input.title, input.accountId, input.categoryId ?? null,
    input.amountMinor, input.currency,
    input.dayOfMonth, input.isLastDay ? 1 : 0,
    input.isVariable ? 1 : 0, input.remindDaysBefore ?? 3,
  );
  return Number(info.lastInsertRowid);
}

export function listRecurring(db: Db): Recurring[] {
  return db.prepare(
    'SELECT * FROM recurring_payments WHERE is_active = 1 ORDER BY is_last_day, day_of_month, id',
  ).all() as Recurring[];
}

/**
 * Создаёт недостающие инстансы за период. Возвращает число созданных.
 * INSERT OR IGNORE вместе с UNIQUE(recurring_id, period) делает вызов
 * идемпотентным: cron может дёргать его хоть каждый день.
 */
export function ensureInstances(db: Db, period: Period): number {
  const rules = listRecurring(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO payment_instances (recurring_id, period, due_date)
    VALUES (?,?,?)
  `);

  let created = 0;
  db.transaction(() => {
    for (const r of rules) {
      const due = dueDateFor(period, r.day_of_month, r.is_last_day === 1);
      created += insert.run(r.id, period, due).changes;
    }
  })();

  return created;
}

/**
 * Неоплаченные платежи, до срока которых осталось не больше
 * remind_days_before дней. Просроченные тоже попадают в выборку:
 * о них напомнить важнее, чем о предстоящих.
 */
export function dueSoon(db: Db, today: IsoDate): DueInstance[] {
  return db.prepare(`
    SELECT pi.id, pi.due_date, pi.period, pi.notified_on,
           r.title, r.amount_minor, r.currency, r.is_variable, r.account_id
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.status = 'pending'
      AND r.is_active = 1
      AND date(pi.due_date, '-' || r.remind_days_before || ' days') <= date(?)
    ORDER BY pi.due_date
  `).all(today) as DueInstance[];
}

export async function markPaid(
  db: Db,
  instanceId: number,
  amountMinor: number,
  today: IsoDate,
  rateFetcher?: RatesFetcher,
): Promise<number> {
  const inst = db.prepare(`
    SELECT pi.id, pi.status, r.account_id, r.category_id, r.title
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.id = ?
  `).get(instanceId) as {
    id: number; status: string; account_id: number;
    category_id: number | null; title: string;
  } | undefined;

  if (!inst) throw new Error(`Платёж ${instanceId} не найден`);
  if (inst.status === 'paid') throw new Error(`Платёж «${inst.title}» уже оплачен`);

  const txId = await recordTransaction(db, {
    ts: today,
    accountId: inst.account_id,
    amountMinor,
    direction: 'expense',
    categoryId: inst.category_id,
    note: inst.title,
    rateFetcher,
  });

  db.prepare(
    "UPDATE payment_instances SET status = 'paid', paid_tx_id = ? WHERE id = ?",
  ).run(txId, instanceId);

  return txId;
}

export function markNotified(db: Db, instanceId: number, today: IsoDate): void {
  db.prepare('UPDATE payment_instances SET notified_on = ? WHERE id = ?')
    .run(today, instanceId);
}
