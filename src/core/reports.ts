import type { Db } from '../db/index.ts';
import type { Period } from './dates.ts';
import { convertMinor, RATE_SCALE } from './money.ts';
import { totalInBase } from './transactions.ts';

/**
 * Расходы по категориям за период в базовой валюте.
 *
 * Каждая операция пересчитывается по курсу, зафиксированному на её
 * дату, поэтому позднее движение курса не переписывает историю.
 * Переводы не попадают в выборку: direction='expense' их исключает.
 */
export function expensesByCategory(
  db: Db,
  period: Period,
): { category: string; totalBase: number }[] {
  const rows = db.prepare(`
    SELECT COALESCE(c.name, 'без категории') AS category,
           t.amount_minor, t.fx_rate_to_base
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.direction = 'expense' AND substr(t.ts, 1, 7) = ?
  `).all(period) as { category: string; amount_minor: number; fx_rate_to_base: number }[];

  const totals = new Map<string, number>();
  for (const r of rows) {
    const base = convertMinor(r.amount_minor, r.fx_rate_to_base);
    totals.set(r.category, (totals.get(r.category) ?? 0) + base);
  }

  return [...totals.entries()]
    .map(([category, totalBase]) => ({ category, totalBase }))
    .sort((a, b) => b.totalBase - a.totalBase);
}

export function monthSummary(
  db: Db,
  period: Period,
): { incomeBase: number; expenseBase: number; savingsRate: number } {
  const rows = db.prepare(`
    SELECT direction, amount_minor, fx_rate_to_base
    FROM transactions
    WHERE direction IN ('income','expense') AND substr(ts, 1, 7) = ?
  `).all(period) as { direction: string; amount_minor: number; fx_rate_to_base: number }[];

  let incomeBase = 0;
  let expenseBase = 0;
  for (const r of rows) {
    const base = convertMinor(r.amount_minor, r.fx_rate_to_base);
    if (r.direction === 'income') incomeBase += base;
    else expenseBase += base;
  }

  // Без явной проверки деление дало бы Infinity или NaN, которые
  // потом молча растекутся по отчёту.
  const savingsRate = incomeBase > 0 ? (incomeBase - expenseBase) / incomeBase : 0;

  return { incomeBase, expenseBase, savingsRate };
}

/**
 * Сумма неоплаченных обязательств за период в базовой валюте.
 *
 * Плавающие платежи с неизвестной суммой не учитываются: лучше
 * недооценить обязательства, чем выдумать цифру. По той же причине
 * платёж в валюте без известного курса пропускается, а не считается
 * по курсу 1:1.
 */
export function unpaidObligations(db: Db, period: Period): number {
  const rows = db.prepare(`
    SELECT r.amount_minor, r.currency, pi.due_date
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.status = 'pending' AND pi.period = ?
      AND r.is_active = 1 AND r.amount_minor IS NOT NULL
  `).all(period) as { amount_minor: number; currency: string; due_date: string }[];

  let total = 0;
  for (const r of rows) {
    if (r.currency === 'BYN') {
      total += convertMinor(r.amount_minor, RATE_SCALE);
      continue;
    }
    const rateRow = db.prepare(`
      SELECT rate FROM fx_rates
      WHERE base = 'BYN' AND quote = ?
      ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1
    `).get(r.currency, r.due_date) as { rate: number } | undefined;

    if (rateRow === undefined) continue;
    total += convertMinor(r.amount_minor, rateRow.rate);
  }
  return total;
}

export function forecast(
  db: Db,
  period: Period,
): { availableBase: number; unpaidBase: number; freeBase: number } {
  const availableBase = totalInBase(db);
  const unpaidBase = unpaidObligations(db, period);
  return { availableBase, unpaidBase, freeBase: availableBase - unpaidBase };
}
