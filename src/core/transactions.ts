import type { Db } from '../db/index.ts';
import type { IsoDate } from './dates.ts';
import { getRate, type RateFetcher } from './fx.ts';
import { convertMinor, RATE_SCALE } from './money.ts';
import { getAccount, listAccounts, accountBalance } from './accounts.ts';

export interface TxInput {
  ts: IsoDate;
  accountId: number;
  amountMinor: number;
  direction: 'expense' | 'income';
  categoryId?: number | null;
  note?: string | null;
  rawText?: string | null;
  rateFetcher?: RateFetcher;
}

export interface TransferInput {
  ts: IsoDate;
  fromAccountId: number;
  fromAmountMinor: number;
  toAccountId: number;
  toAmountMinor: number;
  note?: string | null;
  rateFetcher?: RateFetcher;
}

const INSERT_TX = `
  INSERT INTO transactions
    (ts, account_id, amount_minor, currency, category_id, direction,
     counter_account_id, note, raw_text, fx_rate_to_base)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`;

export async function recordTransaction(db: Db, input: TxInput): Promise<number> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error(`Сумма должна быть положительным целым, получено: ${input.amountMinor}`);
  }

  // Валюта берётся у счёта, а не от вызывающего: счёт в USD не может
  // содержать операцию в рублях.
  const account = getAccount(db, input.accountId);
  const rate = await getRate(db, account.currency, input.ts, input.rateFetcher);

  const info = db.prepare(INSERT_TX).run(
    input.ts, input.accountId, input.amountMinor, account.currency,
    input.categoryId ?? null, input.direction, null,
    input.note ?? null, input.rawText ?? null, rate,
  );
  return Number(info.lastInsertRowid);
}

export async function recordTransfer(db: Db, input: TransferInput): Promise<number> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error('Перевод на один и тот же счёт бессмыслен');
  }
  if (!Number.isInteger(input.fromAmountMinor) || input.fromAmountMinor <= 0
    || !Number.isInteger(input.toAmountMinor) || input.toAmountMinor <= 0) {
    throw new Error('Суммы перевода должны быть положительными целыми');
  }

  // Оба счёта проверяются ДО записи: иначе несуществующий получатель
  // оставил бы висящую расходную половину перевода.
  const from = getAccount(db, input.fromAccountId);
  const to = getAccount(db, input.toAccountId);

  // Курсы берём до открытия транзакции: getRate может ходить в сеть,
  // а держать транзакцию SQLite открытой на время HTTP-запроса нельзя.
  const fromRate = await getRate(db, from.currency, input.ts, input.rateFetcher);
  const toRate = await getRate(db, to.currency, input.ts, input.rateFetcher);

  const insert = db.prepare(INSERT_TX);

  let outId = 0;
  db.transaction(() => {
    const out = insert.run(
      input.ts, input.fromAccountId, input.fromAmountMinor, from.currency,
      null, 'transfer_out', input.toAccountId, input.note ?? null, null, fromRate,
    );
    insert.run(
      input.ts, input.toAccountId, input.toAmountMinor, to.currency,
      null, 'transfer_in', input.fromAccountId, input.note ?? null, null, toRate,
    );
    outId = Number(out.lastInsertRowid);
  })();

  return outId;
}

/**
 * Суммарный остаток по активным счетам, пересчитанный в базовую валюту.
 *
 * Остаток каждого счёта переводится по последнему курсу, встреченному
 * в операциях этого счёта. Это приближение: для прогноза его достаточно,
 * для точной переоценки — нет.
 */
export function totalInBase(db: Db, accountIds?: number[]): number {
  const accounts = listAccounts(db)
    .filter((a) => accountIds === undefined || accountIds.includes(a.id));

  let total = 0;
  for (const acc of accounts) {
    const balance = accountBalance(db, acc.id);
    if (balance === 0) continue;

    const rateRow = db.prepare(`
      SELECT fx_rate_to_base FROM transactions
      WHERE account_id = ? ORDER BY ts DESC, id DESC LIMIT 1
    `).get(acc.id) as { fx_rate_to_base: number } | undefined;

    total += convertMinor(balance, rateRow?.fx_rate_to_base ?? RATE_SCALE);
  }
  return total;
}
