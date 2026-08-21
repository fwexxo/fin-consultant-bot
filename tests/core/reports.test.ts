import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate, fixedRates } from '../helpers.ts';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount } from '../../src/core/accounts.ts';
import { recordTransaction, recordTransfer } from '../../src/core/transactions.ts';
import { createRecurring, ensureInstances, markPaid } from '../../src/core/recurring.ts';
import {
  expensesByCategory, monthSummary, unpaidObligations, forecast,
} from '../../src/core/reports.ts';

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  const cat = (n: string) => (db.prepare(
    "SELECT id FROM categories WHERE name = ? AND kind = 'expense'",
  ).get(n) as { id: number }).id;
  return { db, byn, cat };
}

const rate = (v: number) => flatRate(v);

test('expensesByCategory группирует и суммирует', async () => {
  const { db, byn, cat } = setup();
  await recordTransaction(db, {
    ts: '2026-08-05', accountId: byn, amountMinor: 1_500,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });
  await recordTransaction(db, {
    ts: '2026-08-19', accountId: byn, amountMinor: 2_500,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });

  const rows = expensesByCategory(db, '2026-08');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, 'кафе');
  assert.equal(rows[0]!.totalBase, 4_000);
});

test('expensesByCategory сортирует по убыванию', async () => {
  const { db, byn, cat } = setup();
  await recordTransaction(db, {
    ts: '2026-08-05', accountId: byn, amountMinor: 1_000,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });
  await recordTransaction(db, {
    ts: '2026-08-06', accountId: byn, amountMinor: 9_000,
    direction: 'expense', categoryId: cat('продукты'), rateFetcher: rate(1),
  });

  const rows = expensesByCategory(db, '2026-08');
  assert.equal(rows[0]!.category, 'продукты');
  assert.equal(rows[1]!.category, 'кафе');
});

test('expensesByCategory игнорирует другие месяцы', async () => {
  const { db, byn, cat } = setup();
  await recordTransaction(db, {
    ts: '2026-07-31', accountId: byn, amountMinor: 9_999,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });
  assert.equal(expensesByCategory(db, '2026-08').length, 0);
});

test('expensesByCategory не считает переводы расходом', async () => {
  const { db, byn } = setup();
  const other = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  await recordTransaction(db, {
    ts: '2026-08-01', accountId: byn, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransfer(db, {
    ts: '2026-08-02', fromAccountId: byn, fromAmountMinor: 5_000,
    toAccountId: other, toAmountMinor: 5_000, rateFetcher: rate(1),
  });

  assert.equal(expensesByCategory(db, '2026-08').length, 0);
});

test('расход в чужой валюте пересчитывается по курсу операции', async () => {
  const { db, cat } = setup();
  const usd = createAccount(db, { name: 'USD', currency: 'USD', kind: 'card' });
  // 10 USD по курсу 3.4 = 34 BYN
  await recordTransaction(db, {
    ts: '2026-08-05', accountId: usd, amountMinor: 1_000,
    direction: 'expense', categoryId: cat('подписки'), rateFetcher: rate(3.4),
  });

  const rows = expensesByCategory(db, '2026-08');
  assert.equal(rows[0]!.totalBase, 3_400);
});

test('monthSummary считает норму сбережений', async () => {
  const { db, byn, cat } = setup();
  await recordTransaction(db, {
    ts: '2026-08-01', accountId: byn, amountMinor: 100_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransaction(db, {
    ts: '2026-08-10', accountId: byn, amountMinor: 25_000,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });

  const s = monthSummary(db, '2026-08');
  assert.equal(s.incomeBase, 100_000);
  assert.equal(s.expenseBase, 25_000);
  assert.equal(s.savingsRate, 0.75);
});

test('monthSummary при нулевом доходе не делит на ноль', async () => {
  const { db, byn, cat } = setup();
  await recordTransaction(db, {
    ts: '2026-08-10', accountId: byn, amountMinor: 5_000,
    direction: 'expense', categoryId: cat('кафе'), rateFetcher: rate(1),
  });

  const s = monthSummary(db, '2026-08');
  assert.equal(s.incomeBase, 0);
  assert.equal(s.savingsRate, 0);
  assert.ok(Number.isFinite(s.savingsRate), 'norma не должна быть NaN или Infinity');
});

test('unpaidObligations суммирует неоплаченное за период', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  createRecurring(db, {
    title: 'зал', accountId: byn, amountMinor: 5_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');

  assert.equal(unpaidObligations(db, '2026-08'), 8_000);
});

test('оплаченное из обязательств уходит', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));
  assert.equal(unpaidObligations(db, '2026-08'), 0);
});

test('плавающие платежи без суммы не ломают подсчёт', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'коммуналка', accountId: byn, amountMinor: null,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, isVariable: true,
  });
  ensureInstances(db, '2026-08');

  assert.equal(unpaidObligations(db, '2026-08'), 0);
});

test('обязательство в чужой валюте без известного курса пропускается', () => {
  const { db } = setup();
  const rub = createAccount(db, { name: 'RUB', currency: 'RUB', kind: 'card' });
  createRecurring(db, {
    title: 'сервер', accountId: rub, amountMinor: 50_000,
    currency: 'RUB', dayOfMonth: null, isLastDay: true,
  });
  ensureInstances(db, '2026-08');

  // курса в fx_rates нет — выдумывать 1:1 нельзя
  assert.equal(unpaidObligations(db, '2026-08'), 0);
});

test('обязательство в чужой валюте считается по известному курсу', () => {
  const { db } = setup();
  const rub = createAccount(db, { name: 'RUB', currency: 'RUB', kind: 'card' });
  db.prepare("INSERT INTO fx_rates (date,base,quote,rate) VALUES ('2026-08-01','BYN','RUB',3563200)").run();
  createRecurring(db, {
    title: 'сервер', accountId: rub, amountMinor: 50_000,
    currency: 'RUB', dayOfMonth: null, isLastDay: true,
  });
  ensureInstances(db, '2026-08');

  // 500 RUB × 0.035632 = 17.816 BYN → 1782 копейки
  assert.equal(unpaidObligations(db, '2026-08'), 1_782);
});

test('forecast вычитает обязательства из остатка', async () => {
  const { db, byn } = setup();
  await recordTransaction(db, {
    ts: '2026-08-01', accountId: byn, amountMinor: 100_000,
    direction: 'income', rateFetcher: rate(1),
  });
  createRecurring(db, {
    title: 'аренда', accountId: byn, amountMinor: 60_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');

  const f = forecast(db, '2026-08');
  assert.equal(f.availableBase, 100_000);
  assert.equal(f.unpaidBase, 60_000);
  assert.equal(f.freeBase, 40_000);
});
