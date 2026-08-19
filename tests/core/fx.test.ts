import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { getRate, parseNbrbResponse } from '../../src/core/fx.ts';
import { rateToStored } from '../../src/core/money.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

test('parseNbrbResponse делит на Cur_Scale', () => {
  // USD: масштаб 1, курс 3.4 → 3.4 BYN за доллар
  assert.equal(parseNbrbResponse({ Cur_Scale: 1, Cur_OfficialRate: 3.4 }), 3.4);
  // RUB: масштаб 100, курс 3.5 → 0.035 BYN за рубль.
  // Без деления рубль стоил бы в сто раз дороже.
  assert.equal(parseNbrbResponse({ Cur_Scale: 100, Cur_OfficialRate: 3.5 }), 0.035);
});

test('parseNbrbResponse отвергает мусор', () => {
  assert.throws(() => parseNbrbResponse({ Cur_Scale: 0, Cur_OfficialRate: 1 }), /Cur_Scale/);
  assert.throws(() => parseNbrbResponse({}), /НБРБ/);
  assert.throws(() => parseNbrbResponse({ Cur_Scale: 1 }), /НБРБ/);
});

test('курс BYN к BYN равен единице и не ходит в сеть', async () => {
  const db = freshDb();
  let called = false;
  const rate = await getRate(db, 'BYN', '2026-08-19', async () => {
    called = true;
    return 999;
  });
  assert.equal(rate, rateToStored(1));
  assert.equal(called, false);
});

test('курс кешируется — второй вызов не ходит в сеть', async () => {
  const db = freshDb();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 3.4; };

  const a = await getRate(db, 'USD', '2026-08-19', fetcher);
  const b = await getRate(db, 'USD', '2026-08-19', fetcher);

  assert.equal(a, rateToStored(3.4));
  assert.equal(b, rateToStored(3.4));
  assert.equal(calls, 1, 'второй запрос должен браться из кеша');
});

test('разные даты кешируются раздельно', async () => {
  const db = freshDb();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 3.4; };

  await getRate(db, 'USD', '2026-08-19', fetcher);
  await getRate(db, 'USD', '2026-08-20', fetcher);
  assert.equal(calls, 2);
});

test('разные валюты кешируются раздельно', async () => {
  const db = freshDb();
  const fetcher = async (c: string) => (c === 'USD' ? 3.4 : 0.035);

  assert.equal(await getRate(db, 'USD', '2026-08-19', fetcher as never), rateToStored(3.4));
  assert.equal(await getRate(db, 'RUB', '2026-08-19', fetcher as never), rateToStored(0.035));
});

test('ошибка сети пробрасывается, мусор в кеш не пишется', async () => {
  const db = freshDb();
  await assert.rejects(
    () => getRate(db, 'USD', '2026-08-19', async () => {
      throw new Error('сеть недоступна');
    }),
    /сеть недоступна/,
  );
  const rows = db.prepare('SELECT COUNT(*) c FROM fx_rates').get() as { c: number };
  assert.equal(rows.c, 0, 'при ошибке в кеш не должно попасть ничего');
});
