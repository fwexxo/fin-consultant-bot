import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate } from '../helpers.ts';
import { createAccount } from '../../src/core/accounts.ts';
import { createRecurring, ensureInstances, markPaid } from '../../src/core/recurring.ts';
import { renderDue, fetchInstances, idsFromKeyboard } from '../../src/bot/due-message.ts';

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
  const rent = createRecurring(db, {
    title: 'Аренда', accountId: byn, amountMinor: 135_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  const net = createRecurring(db, {
    title: 'Интернет', accountId: byn, amountMinor: 6_500,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');
  const ids = (db.prepare('SELECT id FROM payment_instances ORDER BY id').all() as { id: number }[])
    .map((r) => r.id);
  return { db, byn, rent, net, ids };
}

test('все платежи попадают в одно сообщение', () => {
  const { db, ids } = setup();
  const { text } = renderDue(fetchInstances(db, ids), '2026-08-23');

  assert.match(text, /Аренда/);
  assert.match(text, /Интернет/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('•')).length, 2);
});

test('итог считается только по неоплаченным', async () => {
  const { db, ids } = setup();
  await markPaid(db, ids[0]!, 135_000, '2026-08-21', flatRate(1));

  const { text } = renderDue(fetchInstances(db, ids), '2026-08-23');
  assert.match(text, /Итого осталось: 65\.00 BYN/);
  assert.match(text, /✓ Аренда — оплачено/);
});

test('суммы разных валют не складываются в одну', () => {
  const { db } = setup();
  const rub = createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
  createRecurring(db, {
    title: 'Сервер', accountId: rub, amountMinor: 50_000,
    currency: 'RUB', dayOfMonth: null, isLastDay: true, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');
  const ids = (db.prepare('SELECT id FROM payment_instances').all() as { id: number }[])
    .map((r) => r.id);

  const { text } = renderDue(fetchInstances(db, ids), '2026-08-23');
  assert.match(text, /Итого осталось: [^\n]*BYN[^\n]*RUB/);
});

test('просроченный помечен, будущий — нет', () => {
  const { db, ids } = setup();
  assert.match(renderDue(fetchInstances(db, ids), '2026-08-23').text, /просрочен/);
  assert.doesNotMatch(renderDue(fetchInstances(db, ids), '2026-08-13').text, /просрочен/);
});

test('плавающая сумма не молчит и не искажает итог', () => {
  const db = testDb();
  const acc = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
  createRecurring(db, {
    title: 'Коммуналка', accountId: acc, amountMinor: null, isVariable: true,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');
  const ids = (db.prepare('SELECT id FROM payment_instances').all() as { id: number }[])
    .map((r) => r.id);

  const { text } = renderDue(fetchInstances(db, ids), '2026-08-23');
  assert.match(text, /сумма плавающая/);
  assert.doesNotMatch(text, /Итого осталось/);
});

test('на каждый платёж своя кнопка', () => {
  const { db, ids } = setup();
  const { keyboard } = renderDue(fetchInstances(db, ids), '2026-08-23');
  assert.deepEqual(idsFromKeyboard(keyboard), ids);
});

test('id восстанавливаются из разметки уже отправленного сообщения', () => {
  const markup = {
    inline_keyboard: [
      [{ text: 'Оплачено: Аренда', callback_data: 'paid:7' }],
      [{ text: 'Оплачено: Интернет', callback_data: 'paid:9' }],
      [{ text: 'Что-то ещё', callback_data: 'other:1' }],
    ],
  };
  assert.deepEqual(idsFromKeyboard(markup), [7, 9]);
  assert.deepEqual(idsFromKeyboard(undefined), [], 'сообщение без кнопок не должно ронять бота');
});
