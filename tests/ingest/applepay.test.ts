import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate, fixedRates } from '../helpers.ts';
import { createAccount, accountBalance } from '../../src/core/accounts.ts';
import {
  parseAmount, parseCurrency, ingestApplePay, formatApplePaySummary,
} from '../../src/ingest/applepay.ts';

const OPTS = { accountName: 'Карта BYN', today: '2026-08-26' as const };

function setup() {
  const db = testDb();
  const byn = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
  return { db, byn };
}

const ev = (over: Record<string, unknown> = {}) => ({
  id: 'uuid-1', merchant: 'EVROOPT', amount: '22,27', currency: 'BYN', ...over,
});

// --- разбор суммы: тут ошибка стоит реальных денег ---

test('запятая как разделитель копеек', () => {
  assert.equal(parseAmount('22,27'), 22.27);
});

test('точка как разделитель копеек', () => {
  assert.equal(parseAmount('22.27'), 22.27);
});

test('символ валюты и пробелы отбрасываются', () => {
  assert.equal(parseAmount('Br 22,27'), 22.27);
  assert.equal(parseAmount('$1.50'), 1.5);
  assert.equal(parseAmount('  12,00 BYN '), 12);
});

test('неразрывный пробел в разряде тысяч не ломает число', () => {
  assert.equal(parseAmount('1 234,56'), 1234.56);
  assert.equal(parseAmount('1 234,56'), 1234.56);
});

test('английский формат с запятой в тысячах', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('$12,345.67'), 12345.67);
});

test('запятая в тысячах без копеек не превращается в дробь', () => {
  assert.equal(parseAmount('1,234'), 1234, '1,234 — это тысяча двести, а не 1.234');
  assert.equal(parseAmount('12,345'), 12345);
});

test('точка в тысячах по-европейски', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1.234'), 1234);
});

test('целое без копеек', () => {
  assert.equal(parseAmount('101'), 101);
  assert.equal(parseAmount(56.72), 56.72);
});

test('минус игнорируется — направление задаём мы, а не текст', () => {
  assert.equal(parseAmount('-22,27'), 22.27);
  assert.equal(parseAmount('−22,27'), 22.27, 'юникодный минус тоже');
});

test('мусор без цифр отвергается, а не превращается в ноль', () => {
  assert.throws(() => parseAmount('нет суммы'), /не вижу цифр/);
  assert.throws(() => parseAmount(''), /не вижу цифр/);
  assert.throws(() => parseAmount('Br'), /не вижу цифр/);
});

test('ноль и не-числа отвергаются', () => {
  assert.throws(() => parseAmount('0'), /больше нуля/);
  assert.throws(() => parseAmount('0,00'), /больше нуля/);
  assert.throws(() => parseAmount(Number.NaN), /не число/);
});

// --- валюта ---

test('код валюты и символы распознаются', () => {
  assert.equal(parseCurrency('BYN'), 'BYN');
  assert.equal(parseCurrency('byn'), 'BYN');
  assert.equal(parseCurrency('Br'), 'BYN');
  assert.equal(parseCurrency('$'), 'USD');
  assert.equal(parseCurrency('₽'), 'RUB');
});

test('неизвестное не выдумывается', () => {
  assert.equal(parseCurrency('ZZZ'), null);
  assert.equal(parseCurrency(''), null);
  assert.equal(parseCurrency(null), null);
});

// --- запись ---

test('оплата ложится расходом на счёт карты', async () => {
  const { db, byn } = setup();
  const r = await ingestApplePay(db, [ev()], OPTS);

  assert.equal(r.recorded.length, 1);
  assert.equal(accountBalance(db, byn), -2227);
  assert.equal(r.balance?.minor, -2227);

  const row = db.prepare('SELECT note, ts FROM transactions').get() as { note: string; ts: string };
  assert.equal(row.note, 'EVROOPT');
  assert.equal(row.ts, '2026-08-26');
});

test('повторная доставка того же запуска ничего не добавляет', async () => {
  const { db, byn } = setup();
  await ingestApplePay(db, [ev()], OPTS);
  const after = accountBalance(db, byn);

  const r2 = await ingestApplePay(db, [ev()], OPTS);
  assert.equal(r2.skippedDuplicate, 1);
  assert.equal(r2.recorded.length, 0);
  assert.equal(accountBalance(db, byn), after);
});

test('две одинаковые покупки подряд — две записи', async () => {
  const { db, byn } = setup();
  await ingestApplePay(db, [ev({ id: 'a' }), ev({ id: 'b' })], OPTS);
  assert.equal(accountBalance(db, byn), -4454, 'совпадение сумм не повод терять покупку');
});

test('без идентификатора не записываем: защиты от дублей не будет', async () => {
  const { db, byn } = setup();
  const r = await ingestApplePay(db, [ev({ id: '' })], OPTS);
  assert.equal(r.recorded.length, 0);
  assert.match(r.rejected[0]!.reason, /идентификатор/);
  assert.equal(accountBalance(db, byn), 0);
});

test('нечитаемая сумма отвергается, остальные из пачки проходят', async () => {
  const { db, byn } = setup();
  const r = await ingestApplePay(db, [
    ev({ id: 'a', amount: 'что-то' }),
    ev({ id: 'b', amount: '10,00' }),
  ], OPTS);

  assert.equal(r.recorded.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(accountBalance(db, byn), -1000);
});

test('пустой магазин не оставляет операцию безымянной', async () => {
  const { db } = setup();
  await ingestApplePay(db, [ev({ merchant: '  ' })], OPTS);
  const row = db.prepare('SELECT note FROM transactions').get() as { note: string };
  assert.equal(row.note, 'оплата Apple Pay');
});

test('чужая валюта пересчитывается и остаётся в примечании', async () => {
  const { db, byn } = setup();
  // 1 USD = 3 BYN, база BYN
  const rates = fixedRates({ BYN: 1, USD: 3 });
  const r = await ingestApplePay(db, [ev({ amount: '10.00', currency: 'USD' })], {
    ...OPTS, rateFetcher: rates,
  });

  assert.equal(accountBalance(db, byn), -3000, '10 USD по курсу 3 — это 30 BYN');
  assert.deepEqual(r.recorded[0]!.original, { amount: 10, currency: 'USD' });

  const row = db.prepare('SELECT note FROM transactions').get() as { note: string };
  assert.match(row.note, /10 USD по нашему курсу/);
});

test('нераспознанная валюта считается валютой счёта', async () => {
  const { db, byn } = setup();
  await ingestApplePay(db, [ev({ currency: 'ZZZ', amount: '5,00' })], OPTS);
  assert.equal(accountBalance(db, byn), -500);
});

test('дата из события важнее сегодняшней', async () => {
  const { db } = setup();
  await ingestApplePay(db, [ev({ date: '2026-08-20' })], OPTS);
  const row = db.prepare('SELECT ts FROM transactions').get() as { ts: string };
  assert.equal(row.ts, '2026-08-20');
});

test('кривая дата не роняет запись, берётся сегодняшняя', async () => {
  const { db } = setup();
  await ingestApplePay(db, [ev({ date: '26 августа' })], OPTS);
  const row = db.prepare('SELECT ts FROM transactions').get() as { ts: string };
  assert.equal(row.ts, '2026-08-26');
});

test('нет такого счёта — явная ошибка, а не тихий пропуск', async () => {
  const db = testDb();
  await assert.rejects(
    () => ingestApplePay(db, [ev()], OPTS),
    /Карта BYN/,
  );
});

// --- сводка ---

test('сводка показывает трату и остаток', async () => {
  const { db } = setup();
  const r = await ingestApplePay(db, [ev()], OPTS);
  const text = formatApplePaySummary(r)!;

  assert.match(text, /EVROOPT/);
  assert.match(text, /22\.27 BYN/);
  assert.match(text, /Остаток «Карта BYN»: -22\.27 BYN/);
});

test('без записей сводки нет', async () => {
  const { db } = setup();
  const r = await ingestApplePay(db, [ev({ id: '' })], OPTS);
  assert.equal(formatApplePaySummary(r), null);
});

test('пересчёт через базовую, когда счёт не в базовой валюте', async () => {
  const db = testDb('BYN');
  createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
  // 1 USD = 3 BYN, 1 RUB = 0.03 BYN  =>  10 USD = 30 BYN = 1000 RUB
  const rates = fixedRates({ BYN: 1, USD: 3, RUB: 0.03 });

  const r = await ingestApplePay(db, [ev({ amount: '10.00', currency: 'USD' })], {
    accountName: 'Карта RUB', today: '2026-08-26', rateFetcher: rates,
  });

  assert.equal(r.recorded[0]!.amountMinor, 100_000, '10 USD должны стать 1000 RUB');
  assert.equal(r.recorded[0]!.currency, 'RUB');
});

test('обратный пересчёт не теряет копейки на некруглом курсе', async () => {
  const db = testDb('BYN');
  createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
  // 1 BYN = 30.5 RUB: курс RUB к базе — 1/30.5, число непериодическое только в двоичке
  const rates = fixedRates({ BYN: 1, RUB: 1 / 30.5 });

  const r = await ingestApplePay(db, [ev({ amount: '100.00', currency: 'BYN' })], {
    accountName: 'Карта RUB', today: '2026-08-26', rateFetcher: rates,
  });

  const rub = r.recorded[0]!.amountMinor;
  assert.ok(Math.abs(rub - 305_000) <= 2, `ожидали ~3050 RUB, получили ${rub / 100}`);
});
