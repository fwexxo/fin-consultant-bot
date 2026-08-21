import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate, fixedRates } from '../helpers.ts';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, accountBalance } from '../../src/core/accounts.ts';
import {
  createRecurring, listRecurring, ensureInstances, dueSoon, markPaid,
} from '../../src/core/recurring.ts';

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  const rub = createAccount(db, { name: 'RUB', currency: 'RUB', kind: 'card' });
  return { db, byn, rub };
}

const rate = (v: number) => flatRate(v);

test('белорусские платежи 15-го числа', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });

  assert.equal(ensureInstances(db, '2026-08'), 1);
  const rows = db.prepare('SELECT due_date FROM payment_instances').all() as { due_date: string }[];
  assert.equal(rows[0]!.due_date, '2026-08-15');
});

test('российские платежи в последнее число месяца', () => {
  const { db, rub } = setup();
  createRecurring(db, {
    title: 'сервер', accountId: rub, amountMinor: 50_000,
    currency: 'RUB', dayOfMonth: null, isLastDay: true,
  });

  ensureInstances(db, '2026-02');
  ensureInstances(db, '2026-04');
  ensureInstances(db, '2024-02');

  const dates = (db.prepare(
    'SELECT due_date FROM payment_instances ORDER BY due_date',
  ).all() as { due_date: string }[]).map((r) => r.due_date);

  assert.deepEqual(dates, ['2024-02-29', '2026-02-28', '2026-04-30']);
});

test('ensureInstances идемпотентна', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'зал', accountId: byn, amountMinor: 5_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });

  assert.equal(ensureInstances(db, '2026-08'), 1);
  assert.equal(ensureInstances(db, '2026-08'), 0, 'повторный вызов не должен дублировать');

  const n = db.prepare('SELECT COUNT(*) c FROM payment_instances').get() as { c: number };
  assert.equal(n.c, 1);
});

test('неактивные правила инстансы не порождают', () => {
  const { db, byn } = setup();
  const id = createRecurring(db, {
    title: 'старое', accountId: byn, amountMinor: 100,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  db.prepare('UPDATE recurring_payments SET is_active = 0 WHERE id = ?').run(id);

  assert.equal(ensureInstances(db, '2026-08'), 0);
  assert.equal(listRecurring(db).length, 0);
});

test('dueSoon отдаёт платежи в пределах remind_days_before', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');

  assert.equal(dueSoon(db, '2026-08-11').length, 0, 'за 4 дня — рано');
  assert.equal(dueSoon(db, '2026-08-12').length, 1, 'за 3 дня — пора');
  assert.equal(dueSoon(db, '2026-08-15').length, 1, 'в день срока — пора');
  assert.equal(dueSoon(db, '2026-08-20').length, 1, 'просроченный всё ещё виден');
});

test('markPaid создаёт транзакцию и закрывает инстанс', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));

  const after = db.prepare('SELECT status, paid_tx_id FROM payment_instances WHERE id = ?')
    .get(inst.id) as { status: string; paid_tx_id: number };
  assert.equal(after.status, 'paid');
  assert.ok(after.paid_tx_id > 0);
  assert.equal(accountBalance(db, byn), -3_000);
});

test('оплаченный инстанс исчезает из dueSoon', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));
  assert.equal(dueSoon(db, '2026-08-15').length, 0);
});

test('повторная оплата отвергается', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));
  await assert.rejects(
    () => markPaid(db, inst.id, 3_000, '2026-08-15', rate(1)),
    /уже оплачен/,
  );
});

test('плавающий платёж оплачивается фактической суммой', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'коммуналка', accountId: byn, amountMinor: null,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, isVariable: true,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };

  await markPaid(db, inst.id, 8_734, '2026-08-15', rate(1));
  assert.equal(accountBalance(db, byn), -8_734);
});

test('две группы платежей сосуществуют с разными сроками', () => {
  const { db, byn, rub } = setup();
  createRecurring(db, {
    title: 'аренда', accountId: byn, amountMinor: null, currency: 'BYN',
    dayOfMonth: 15, isLastDay: false, isVariable: true,
  });
  createRecurring(db, {
    title: 'серверы', accountId: rub, amountMinor: null, currency: 'RUB',
    dayOfMonth: null, isLastDay: true, isVariable: true,
  });

  assert.equal(ensureInstances(db, '2026-08'), 2);

  const rows = db.prepare(`
    SELECT r.title, pi.due_date FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    ORDER BY pi.due_date
  `).all() as { title: string; due_date: string }[];

  assert.deepEqual(rows, [
    { title: 'аренда', due_date: '2026-08-15' },
    { title: 'серверы', due_date: '2026-08-31' },
  ]);
});

test('markPaid по несуществующему инстансу отвергается', async () => {
  const { db } = setup();
  await assert.rejects(() => markPaid(db, 999, 100, '2026-08-15', rate(1)), /не найден/);
});
