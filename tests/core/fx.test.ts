import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, fixedRates } from '../helpers.ts';
import {
  getRate, setBaseCurrency, getBaseCurrency,
  parseNbrbResponse, parseErApi,
} from '../../src/core/fx.ts';
import { rateToStored } from '../../src/core/money.ts';

test('parseErApi переворачивает курс к базовой валюте', () => {
  // Сервис отдаёт «сколько валюты за один доллар», нам нужно обратное
  const rates = parseErApi(
    { result: 'success', rates: { RUB: 80, EUR: 0.5 } },
    'USD',
  );
  assert.equal(rates.RUB, 1 / 80, '1 RUB стоит 1/80 доллара');
  assert.equal(rates.EUR, 2, '1 EUR стоит 2 доллара');
  assert.equal(rates.USD, 1, 'базовая валюта всегда равна единице');
});

test('parseErApi отвергает неуспешный ответ', () => {
  assert.throws(() => parseErApi({ result: 'error' }, 'USD'), /курсов/);
  assert.throws(() => parseErApi({}, 'USD'), /курсов/);
});

test('parseErApi пропускает нулевые и нечисловые курсы', () => {
  const rates = parseErApi(
    { result: 'success', rates: { RUB: 80, BAD: 0, ALSOBAD: 'нет' as never } },
    'USD',
  );
  assert.ok('RUB' in rates);
  assert.ok(!('BAD' in rates), 'нулевой курс дал бы деление на ноль');
  assert.ok(!('ALSOBAD' in rates));
});

test('parseNbrbResponse делит на Cur_Scale', () => {
  assert.equal(parseNbrbResponse({ Cur_Scale: 1, Cur_OfficialRate: 3.4 }), 3.4);
  // Для рубля масштаб 100: без деления он был бы в сто раз дороже
  assert.equal(parseNbrbResponse({ Cur_Scale: 100, Cur_OfficialRate: 3.5 }), 0.035);
});

test('parseNbrbResponse отвергает мусор', () => {
  assert.throws(() => parseNbrbResponse({ Cur_Scale: 0, Cur_OfficialRate: 1 }), /Cur_Scale/);
  assert.throws(() => parseNbrbResponse({}), /НБРБ/);
});

test('курс базовой валюты к самой себе равен единице и не ходит в сеть', async () => {
  const db = testDb('BYN');
  let called = false;
  const rate = await getRate(db, 'BYN', '2026-08-19', async () => {
    called = true;
    return { BYN: 999 };
  });
  assert.equal(rate, rateToStored(1));
  assert.equal(called, false);
});

test('курс кешируется — второй вызов не ходит в сеть', async () => {
  const db = testDb('BYN');
  let calls = 0;
  const fetcher = async () => { calls += 1; return { USD: 3.4, BYN: 1 }; };

  const a = await getRate(db, 'USD', '2026-08-19', fetcher);
  const b = await getRate(db, 'USD', '2026-08-19', fetcher);

  assert.equal(a, rateToStored(3.4));
  assert.equal(b, rateToStored(3.4));
  assert.equal(calls, 1, 'второй запрос должен браться из кеша');
});

test('один запрос кеширует все валюты сразу', async () => {
  const db = testDb('BYN');
  let calls = 0;
  const fetcher = async () => { calls += 1; return { USD: 3.4, RUB: 0.035, BYN: 1 }; };

  await getRate(db, 'USD', '2026-08-19', fetcher);
  await getRate(db, 'RUB', '2026-08-19', fetcher);

  assert.equal(calls, 1, 'курс рубля пришёл тем же запросом, что и доллара');
});

test('разные даты кешируются раздельно', async () => {
  const db = testDb('BYN');
  let calls = 0;
  const fetcher = async () => { calls += 1; return { USD: 3.4, BYN: 1 }; };

  await getRate(db, 'USD', '2026-08-19', fetcher);
  await getRate(db, 'USD', '2026-08-20', fetcher);
  assert.equal(calls, 2);
});

test('при сбое сети берётся ближайший известный курс', async () => {
  const db = testDb('BYN');
  await getRate(db, 'USD', '2026-08-19', fixedRates({ USD: 3.4, BYN: 1 }));

  // Сеть недоступна, но курс за соседний день уже есть
  const rate = await getRate(db, 'USD', '2026-08-20', async () => {
    throw new Error('сеть недоступна');
  });
  assert.equal(rate, rateToStored(3.4));
});

test('при сбое сети и пустом кеше ошибка пробрасывается', async () => {
  const db = testDb('BYN');
  await assert.rejects(
    () => getRate(db, 'USD', '2026-08-19', async () => {
      throw new Error('сеть недоступна');
    }),
    /сеть недоступна/,
  );
  const rows = db.prepare('SELECT COUNT(*) c FROM fx_rates').get() as { c: number };
  assert.equal(rows.c, 0, 'при ошибке в кеш не должно попасть ничего');
});

test('валюта, которой нет у источника, даёт понятную ошибку', async () => {
  const db = testDb('BYN');
  await assert.rejects(
    () => getRate(db, 'JPY', '2026-08-19', fixedRates({ USD: 3.4, BYN: 1 })),
    /не знает валюту JPY/,
  );
});

test('базовая валюта настраивается', () => {
  setBaseCurrency('EUR');
  assert.equal(getBaseCurrency(), 'EUR');
  setBaseCurrency('BYN');
  assert.equal(getBaseCurrency(), 'BYN');
});
