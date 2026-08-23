import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate } from '../helpers.ts';
import { createAccount, accountBalance } from '../../src/core/accounts.ts';
import { recordTransaction } from '../../src/core/transactions.ts';
import {
  createRecurring, ensureInstances, markPaid, findMatchingPending,
  linkPaymentToTransaction,
} from '../../src/core/recurring.ts';

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
  const rub = createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
  createRecurring(db, {
    title: 'Аренда квартиры', accountId: byn, amountMinor: 135_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  createRecurring(db, {
    title: 'Абонемент в зал', accountId: byn, amountMinor: 19_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');
  return { db, byn, rub };
}

test('трата с тем же словом узнаётся как регулярный платёж', () => {
  const { db, byn } = setup();
  const m = findMatchingPending(db, 'аренда квартиры', byn);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.title, 'Аренда квартиры');
});

test('регистр не мешает', () => {
  const { db, byn } = setup();
  assert.equal(findMatchingPending(db, 'АРЕНДА', byn).length, 1);
});

test('посторонняя трата ни с чем не путается', () => {
  const { db, byn } = setup();
  assert.deepEqual(findMatchingPending(db, 'кофе в кафе', byn), []);
});

test('оплаченный платёж больше не предлагается', async () => {
  const { db, byn } = setup();
  const inst = db.prepare(`
    SELECT pi.id FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE r.title = 'Аренда квартиры'
  `).get() as { id: number };
  await markPaid(db, inst.id, 135_000, '2026-08-21', flatRate(1));

  assert.deepEqual(findMatchingPending(db, 'аренда квартиры', byn), []);
});

test('чужой счёт не подтягивает платежи', () => {
  const { db, rub } = setup();
  assert.deepEqual(findMatchingPending(db, 'аренда квартиры', rub), []);
});

test('без пояснения угадывать нечего', () => {
  const { db, byn } = setup();
  assert.deepEqual(findMatchingPending(db, null, byn), [], 'молчаливая трата — не повод гадать');
  assert.deepEqual(findMatchingPending(db, 'за', byn), [], 'короткие слова совпадают со всем подряд');
});

test('неактивный платёж не всплывает', () => {
  const { db, byn } = setup();
  db.prepare("UPDATE recurring_payments SET is_active = 0 WHERE title = 'Аренда квартиры'").run();
  assert.deepEqual(findMatchingPending(db, 'аренда квартиры', byn), []);
});

test('связывание закрывает платёж, не трогая деньги', async () => {
  const { db, byn } = setup();
  const before = accountBalance(db, byn);
  const tx = await recordTransaction(db, {
    accountId: byn, direction: 'expense', amountMinor: 135_000,
    currency: 'BYN', ts: '2026-08-21', note: 'аренда квартиры',
  }, flatRate(1));
  const after = accountBalance(db, byn);

  const inst = findMatchingPending(db, 'аренда квартиры', byn)[0]!;
  const r = linkPaymentToTransaction(db, inst.id, tx);

  assert.equal(r.title, 'Аренда квартиры');
  assert.equal(accountBalance(db, byn), after, 'связывание не должно менять баланс');
  assert.notEqual(after, before);
  assert.deepEqual(findMatchingPending(db, 'аренда квартиры', byn), [], 'платёж закрыт');
});

test('одна операция не закрывает два платежа', async () => {
  const { db, byn } = setup();
  const tx = await recordTransaction(db, {
    accountId: byn, direction: 'expense', amountMinor: 19_000,
    currency: 'BYN', ts: '2026-08-21', note: null,
  }, flatRate(1));

  const ids = (db.prepare('SELECT id FROM payment_instances ORDER BY id').all() as { id: number }[])
    .map((r) => r.id);
  linkPaymentToTransaction(db, ids[0]!, tx);

  assert.throws(() => linkPaymentToTransaction(db, ids[1]!, tx), /уже закрывает/);
});

test('доходом платёж не закроешь', async () => {
  const { db, byn } = setup();
  const tx = await recordTransaction(db, {
    accountId: byn, direction: 'income', amountMinor: 135_000,
    currency: 'BYN', ts: '2026-08-21', note: null,
  }, flatRate(1));
  const inst = findMatchingPending(db, 'аренда квартиры', byn)[0]!;

  assert.throws(() => linkPaymentToTransaction(db, inst.id, tx), /только с расходом/);
});

test('повторное связывание уже оплаченного отклоняется', async () => {
  const { db, byn } = setup();
  const tx = await recordTransaction(db, {
    accountId: byn, direction: 'expense', amountMinor: 135_000,
    currency: 'BYN', ts: '2026-08-21', note: null,
  }, flatRate(1));
  const inst = findMatchingPending(db, 'аренда квартиры', byn)[0]!;
  linkPaymentToTransaction(db, inst.id, tx);

  assert.throws(() => linkPaymentToTransaction(db, inst.id, tx), /уже отмечен/);
});
