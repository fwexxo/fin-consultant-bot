import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';

export type AccountKind = 'cash' | 'card' | 'deposit';

export interface Account {
  id: number;
  name: string;
  currency: Currency;
  kind: AccountKind;
  is_active: number;
}

export function createAccount(
  db: Db,
  input: { name: string; currency: Currency; kind: AccountKind },
): number {
  const info = db.prepare(
    'INSERT INTO accounts (name, currency, kind) VALUES (?,?,?)',
  ).run(input.name, input.currency, input.kind);
  return Number(info.lastInsertRowid);
}

export function listAccounts(db: Db): Account[] {
  return db.prepare(
    'SELECT id, name, currency, kind, is_active FROM accounts WHERE is_active = 1 ORDER BY id',
  ).all() as Account[];
}

export function getAccount(db: Db, id: number): Account {
  const row = db.prepare(
    'SELECT id, name, currency, kind, is_active FROM accounts WHERE id = ?',
  ).get(id) as Account | undefined;
  if (!row) throw new Error(`Счёт ${id} не найден`);
  return row;
}

/**
 * Баланс в минорных единицах валюты счёта.
 *
 * Перевод записан двумя строками — transfer_out на счёте-источнике и
 * transfer_in на счёте-получателе, каждая со своей суммой в своей
 * валюте. Поэтому достаточно смотреть на account_id: каждая сторона
 * перевода уже принадлежит своему счёту.
 */
export function accountBalance(db: Db, accountId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS balance FROM (
      SELECT CASE direction
               WHEN 'income'       THEN  amount_minor
               WHEN 'transfer_in'  THEN  amount_minor
               WHEN 'expense'      THEN -amount_minor
               WHEN 'transfer_out' THEN -amount_minor
             END AS delta
      FROM transactions
      WHERE account_id = ?
    )
  `).get(accountId) as { balance: number };
  return row.balance;
}
