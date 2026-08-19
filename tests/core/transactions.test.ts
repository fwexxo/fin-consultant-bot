import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, listAccounts, accountBalance } from '../../src/core/accounts.ts';
import { recordTransaction, recordTransfer, totalInBase } from '../../src/core/transactions.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const rate = (v: number) => async () => v;

test('createAccount возвращает id и счёт появляется в списке', () => {
  const db = freshDb();
  const id = createAccount(db, { name: 'карта BYN', currency: 'BYN', kind: 'card' });
  assert.ok(id > 0);

  const accounts = listAccounts(db);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.name, 'карта BYN');
  assert.equal(accounts[0]!.currency, 'BYN');
});

test('дублирующее имя счёта отвергается', () => {
  const db = freshDb();
  createAccount(db, { name: 'карта', currency: 'BYN', kind: 'card' });
  assert.throws(
    () => createAccount(db, { name: 'карта', currency: 'USD', kind: 'card' }),
    /UNIQUE/,
  );
});

test('баланс нового счёта равен нулю', () => {
  const db = freshDb();
  const id = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  assert.equal(accountBalance(db, id), 0);
});

test('расход уменьшает баланс, доход увеличивает', async () => {
  const db = freshDb();
  const acc = createAccount(db, { name: 'нал BYN', currency: 'BYN', kind: 'cash' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: acc, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransaction(db, {
    ts: '2026-08-19', accountId: acc, amountMinor: 3_045,
    direction: 'expense', rateFetcher: rate(1),
  });

  assert.equal(accountBalance(db, acc), 6_955);
});

test('перевод между счетами не меняет общий итог в базовой валюте', async () => {
  const db = freshDb();
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'cash' });
  const usd = createAccount(db, { name: 'USD', currency: 'USD', kind: 'deposit' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: byn, amountMinor: 34_000,
    direction: 'income', rateFetcher: rate(1),
  });

  const before = totalInBase(db);

  // 100 BYN уходят, приходят 29.41 USD по курсу 3.4
  await recordTransfer(db, {
    ts: '2026-08-19',
    fromAccountId: byn, fromAmountMinor: 10_000,
    toAccountId: usd, toAmountMinor: 2_941,
    rateFetcher: async (c) => (c === 'USD' ? 3.4 : 1),
  });

  assert.equal(accountBalance(db, byn), 24_000);
  assert.equal(accountBalance(db, usd), 2_941);

  const after = totalInBase(db);
  assert.ok(Math.abs(after - before) <= 2, `итог сместился на ${after - before} копеек`);
});

test('переводы не попадают в расходы', async () => {
  const db = freshDb();
  const a = createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  const b = createAccount(db, { name: 'B', currency: 'BYN', kind: 'card' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: a, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransfer(db, {
    ts: '2026-08-19', fromAccountId: a, fromAmountMinor: 5_000,
    toAccountId: b, toAmountMinor: 5_000, rateFetcher: rate(1),
  });

  const expenses = db.prepare(
    "SELECT COUNT(*) c FROM transactions WHERE direction = 'expense'",
  ).get() as { c: number };
  assert.equal(expenses.c, 0, 'перевод не должен считаться расходом');

  assert.equal(accountBalance(db, a), 5_000);
  assert.equal(accountBalance(db, b), 5_000);
});

test('нулевая и отрицательная сумма отвергаются', async () => {
  const db = freshDb();
  const acc = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  for (const amountMinor of [0, -5]) {
    await assert.rejects(
      () => recordTransaction(db, {
        ts: '2026-08-19', accountId: acc, amountMinor,
        direction: 'expense', rateFetcher: rate(1),
      }),
      /Сумма/,
    );
  }
});

test('перевод на тот же счёт отвергается', async () => {
  const db = freshDb();
  const a = createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  await assert.rejects(
    () => recordTransfer(db, {
      ts: '2026-08-19', fromAccountId: a, fromAmountMinor: 100,
      toAccountId: a, toAmountMinor: 100, rateFetcher: rate(1),
    }),
    /один и тот же счёт/,
  );
});

test('операция по несуществующему счёту отвергается', async () => {
  const db = freshDb();
  await assert.rejects(
    () => recordTransaction(db, {
      ts: '2026-08-19', accountId: 999, amountMinor: 100,
      direction: 'expense', rateFetcher: rate(1),
    }),
    /не найден/,
  );
});

test('перевод атомарен: при сбое не остаётся половины', async () => {
  const db = freshDb();
  const a = createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  await assert.rejects(
    () => recordTransfer(db, {
      ts: '2026-08-19', fromAccountId: a, fromAmountMinor: 100,
      toAccountId: 999, toAmountMinor: 100, rateFetcher: rate(1),
    }),
    /не найден/,
  );
  const n = db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number };
  assert.equal(n.c, 0, 'не должно остаться ни одной строки');
});

test('валюта транзакции берётся у счёта, а не задаётся снаружи', async () => {
  const db = freshDb();
  const usd = createAccount(db, { name: 'USD', currency: 'USD', kind: 'deposit' });
  await recordTransaction(db, {
    ts: '2026-08-19', accountId: usd, amountMinor: 1_000,
    direction: 'expense', rateFetcher: rate(3.4),
  });
  const row = db.prepare('SELECT currency, fx_rate_to_base FROM transactions').get() as {
    currency: string; fx_rate_to_base: number;
  };
  assert.equal(row.currency, 'USD');
  assert.equal(row.fx_rate_to_base, 340_000_000);
});
