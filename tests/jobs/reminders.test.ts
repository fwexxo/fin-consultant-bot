import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate, fixedRates } from '../helpers.ts';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount } from '../../src/core/accounts.ts';
import { createRecurring, markPaid } from '../../src/core/recurring.ts';
import { collectReminders } from '../../src/jobs/reminders.ts';

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  return { db, byn };
}

function internet(db: ReturnType<typeof setup>['db'], byn: number) {
  return createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
}

test('collectReminders сам достраивает инстансы текущего месяца', () => {
  const { db, byn } = setup();
  internet(db, byn);

  const rows = collectReminders(db, '2026-08-13');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'интернет');
});

test('дважды за день не напоминает', () => {
  const { db, byn } = setup();
  internet(db, byn);

  assert.equal(collectReminders(db, '2026-08-13').length, 1);
  assert.equal(collectReminders(db, '2026-08-13').length, 0, 'повтор в тот же день недопустим');
});

test('на следующий день напоминает снова', () => {
  const { db, byn } = setup();
  internet(db, byn);

  collectReminders(db, '2026-08-13');
  assert.equal(collectReminders(db, '2026-08-14').length, 1);
});

test('до срока напоминания рано — тишина', () => {
  const { db, byn } = setup();
  internet(db, byn);
  assert.equal(collectReminders(db, '2026-08-01').length, 0);
});

test('оплаченный платёж больше не напоминает', async () => {
  const { db, byn } = setup();
  internet(db, byn);
  collectReminders(db, '2026-08-13');

  const inst = db.prepare('SELECT id FROM payment_instances').get() as { id: number };
  await markPaid(db, inst.id, 3_000, '2026-08-14', flatRate(1));

  assert.equal(collectReminders(db, '2026-08-14').length, 0);
});

test('просроченный напоминает каждый день', () => {
  const { db, byn } = setup();
  internet(db, byn);

  assert.equal(collectReminders(db, '2026-08-20').length, 1);
  assert.equal(collectReminders(db, '2026-08-21').length, 1);
  assert.equal(collectReminders(db, '2026-08-22').length, 1);
});
