import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, flatRate, fixedRates } from '../helpers.ts';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, accountBalance, listAccounts } from '../../src/core/accounts.ts';
import {
  ingestSms, formatIngestSummary, DEFAULT_DRIFT_ALERT_MINOR,
} from '../../src/ingest/sms-ingest.ts';

const OPTS = {
  card: 'MIR-0000',
  cardAccountName: 'Карта RUB',
  cashAccountName: 'Наличные RUB',
  sinceDate: '2026-08-22',
};

function setup() {
  const db = testDb();
  const card = createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
  return { db, card };
}

const sms = (rowid: number, date: string, text: string) => ({ rowid, date, text });

test('покупка записывается расходом в рублях списания', async () => {
  const { db, card } = setup();
  const r = await ingestSms(db, [
    sms(1, '2026-08-22', 'Счёт карты MIR-0000 13:22 Покупка 14BYN (399.12р) CAFE EXAMPLE Баланс: 10 159.37р'),
  ], OPTS);

  assert.equal(r.recorded.length, 1);
  assert.equal(accountBalance(db, card), -39912, 'списаны рубли, а не байны');

  const note = db.prepare('SELECT note FROM transactions').get() as { note: string };
  assert.match(note.note, /CAFE EXAMPLE/);
  assert.match(note.note, /14 BYN/, 'исходная валюта должна сохраниться справочно');
});

test('повторная подача того же СМС ничего не добавляет', async () => {
  const { db, card } = setup();
  const batch = [sms(1, '2026-08-22', 'Счёт карты MIR-0000 13:22 Покупка 100р Магазин Баланс: 900р')];

  await ingestSms(db, batch, OPTS);
  const after1 = accountBalance(db, card);

  const r2 = await ingestSms(db, batch, OPTS);
  assert.equal(r2.skippedDuplicate, 1);
  assert.equal(r2.recorded.length, 0);
  assert.equal(accountBalance(db, card), after1, 'баланс не должен измениться');
});

test('операции раньше начальной даты пропускаются', async () => {
  const { db, card } = setup();
  const r = await ingestSms(db, [
    sms(1, '2026-08-21', 'Счёт карты MIR-0000 10:00 Покупка 500р Вчера Баланс: 100р'),
  ], OPTS);

  assert.equal(r.skippedTooOld, 1);
  assert.equal(r.recorded.length, 0);
  assert.equal(accountBalance(db, card), 0);
});

test('снятие наличных — перевод, деньги не исчезают', async () => {
  const { db, card } = setup();
  await ingestSms(db, [
    sms(1, '2026-08-22', 'Счёт карты MIR-0000 18:45 Выдача 50 000р ATM 60323204 Баланс: 20 914.4р'),
  ], OPTS);

  const cash = listAccounts(db).find((a) => a.name === 'Наличные RUB');
  assert.ok(cash, 'счёт наличных должен создаться сам');
  assert.equal(accountBalance(db, card), -5_000_000);
  assert.equal(accountBalance(db, cash.id), 5_000_000);

  const expenses = db.prepare("SELECT COUNT(*) c FROM transactions WHERE direction='expense'")
    .get() as { c: number };
  assert.equal(expenses.c, 0, 'снятие не должно считаться тратой');
});

test('внесение наличных — обратный перевод', async () => {
  const { db, card } = setup();
  await ingestSms(db, [
    sms(1, '2026-08-22', 'Счёт карты MIR-0000 17:34 зачисление 34 000р ATM 60209937 Баланс: 50 010.9р'),
  ], OPTS);

  const cash = listAccounts(db).find((a) => a.name === 'Наличные RUB')!;
  assert.equal(accountBalance(db, card), 3_400_000);
  assert.equal(accountBalance(db, cash.id), -3_400_000);
});

test('покупка с выдачей даёт две записи из одного СМС', async () => {
  const { db, card } = setup();
  const r = await ingestSms(db, [
    sms(1, '2026-08-22',
      'Счёт карты MIR-0000 09:14 покупка с выдачей 109.99р SUPERMARKET 1234 покупка 9.99р выдача 100.00р Баланс: 122.34р'),
  ], OPTS);

  assert.equal(r.recorded.length, 2);
  const cash = listAccounts(db).find((a) => a.name === 'Наличные RUB')!;
  assert.equal(accountBalance(db, cash.id), 10_000);
  assert.equal(accountBalance(db, card), -10_999, 'ушло 9.99 покупкой и 100 наличными');
});

test('обе записи из одного СМС защищены от дублей', async () => {
  const { db } = setup();
  const batch = [sms(1, '2026-08-22',
    'Счёт карты MIR-0000 09:14 покупка с выдачей 109.99р SUPERMARKET 1234 покупка 9.99р выдача 100.00р Баланс: 122.34р')];

  await ingestSms(db, batch, OPTS);
  const r2 = await ingestSms(db, batch, OPTS);
  assert.equal(r2.recorded.length, 0);

  const n = db.prepare('SELECT COUNT(*) c FROM sms_ingested').get() as { c: number };
  assert.equal(n.c, 2, 'по одной отметке на каждую операцию');
});

test('дата берётся из СМС, а не из времени доставки', async () => {
  const { db } = setup();
  await ingestSms(db, [
    sms(1, '2026-08-25', 'Счёт карты MIR-0000 24.08.26 23:05 возврат покупки 100р Магазин Баланс: 500р'),
  ], OPTS);

  const row = db.prepare('SELECT ts FROM transactions').get() as { ts: string };
  assert.equal(row.ts, '2026-08-24');
});

test('расхождение с банком фиксируется', async () => {
  const { db } = setup();
  const r = await ingestSms(db, [
    sms(1, '2026-08-22', 'Счёт карты MIR-0000 13:22 Покупка 100р Магазин Баланс: 900р'),
  ], OPTS);

  assert.ok(r.drift);
  assert.equal(r.drift.bankMinor, 90_000);
  assert.equal(r.drift.oursMinor, -10_000, 'у нас нет истории до начальной даты');
  assert.equal(r.drift.driftMinor, -100_000);

  const check = db.prepare('SELECT COUNT(*) c FROM balance_checks').get() as { c: number };
  assert.equal(check.c, 1);
});

test('чужие и нераспознанные сообщения считаются отдельно', async () => {
  const { db } = setup();
  const r = await ingestSms(db, [
    sms(1, '2026-08-22', 'СЧЁТ5547 14:21 Зачисление зарплаты 29 897.92р Баланс: 51 914.4р'),
    sms(2, '2026-08-22', 'Никому не сообщайте код 7904'),
  ], OPTS);

  assert.equal(r.skippedUnparsed, 2);
  assert.equal(r.recorded.length, 0);
});

test('отсутствие счёта карты — явная ошибка, а не тихий пропуск', async () => {
  const db = testDb();
  await assert.rejects(
    () => ingestSms(db, [sms(1, '2026-08-22', 'Счёт карты MIR-0000 13:22 Покупка 100р М Баланс: 900р')], OPTS),
    /Карта RUB/,
  );
});

test('сводка пустая, когда записывать нечего', () => {
  assert.equal(formatIngestSummary({
    seen: 0, skippedDuplicate: 0, skippedTooOld: 0, skippedUnparsed: 0,
    recorded: [], drift: null,
  }, 'Карта RUB'), null);
});

test('сводка перечисляет операции и предупреждает о расхождении', () => {
  const text = formatIngestSummary({
    seen: 1, skippedDuplicate: 0, skippedTooOld: 0, skippedUnparsed: 0,
    recorded: [{
      kind: 'expense', date: '2026-08-22', amountRub: 399.12, merchant: 'CAFE EXAMPLE',
      original: { amount: 14, currency: 'BYN' },
    }],
    drift: { bankMinor: 90_000, oursMinor: 80_000, driftMinor: -10_000 },
  }, 'Карта RUB');

  assert.ok(text);
  assert.match(text, /CAFE EXAMPLE/);
  assert.match(text, /399\.12/);
  assert.match(text, /14 BYN/);
  assert.match(text, /Расхождение/);
});

test('сводка не поднимает тревогу, когда баланс сошёлся', () => {
  const text = formatIngestSummary({
    seen: 1, skippedDuplicate: 0, skippedTooOld: 0, skippedUnparsed: 0,
    recorded: [{ kind: 'expense', date: '2026-08-22', amountRub: 100, merchant: 'Магазин' }],
    drift: { bankMinor: 90_000, oursMinor: 90_000, driftMinor: 0 },
  }, 'Карта RUB');

  assert.ok(text);
  assert.doesNotMatch(text, /Расхождение/);
});

const oneOp = (driftMinor: number) => ({
  seen: 1, skippedDuplicate: 0, skippedTooOld: 0, skippedUnparsed: 0,
  recorded: [{ kind: 'expense' as const, date: '2026-08-25', amountRub: 100, merchant: 'Магазин' }],
  drift: { bankMinor: 100_000, oursMinor: 100_000 + driftMinor, driftMinor },
});

test('расхождение в пять копеек не поднимает тревогу', () => {
  const text = formatIngestSummary(oneOp(-5), 'Карта RUB');
  assert.ok(text);
  assert.match(text, /Магазин/, 'сами операции показать всё равно надо');
  assert.doesNotMatch(text, /Расхождение/);
});

test('расхождение ровно на порог уже показывается', () => {
  const text = formatIngestSummary(oneOp(-DEFAULT_DRIFT_ALERT_MINOR), 'Карта RUB')!;
  assert.match(text, /Расхождение/);
});

test('на копейку меньше порога — тишина', () => {
  const text = formatIngestSummary(oneOp(DEFAULT_DRIFT_ALERT_MINOR - 1), 'Карта RUB')!;
  assert.doesNotMatch(text, /Расхождение/);
});

test('порог смотрит на модуль: недостача и излишек равноправны', () => {
  const big = DEFAULT_DRIFT_ALERT_MINOR + 1;
  assert.match(formatIngestSummary(oneOp(big), 'Карта RUB')!, /Расхождение/);
  assert.match(formatIngestSummary(oneOp(-big), 'Карта RUB')!, /Расхождение/);
});

test('свой порог перекрывает значение по умолчанию', () => {
  const drift = oneOp(-10_000);
  assert.match(formatIngestSummary(drift, 'Карта RUB')!, /Расхождение/, '100 руб выше 50');
  assert.doesNotMatch(
    formatIngestSummary(drift, 'Карта RUB', 20_000)!, /Расхождение/,
    'при пороге 200 руб сотня должна молчать',
  );
});

test('нулевой порог возвращает старое поведение', () => {
  assert.match(formatIngestSummary(oneOp(-5), 'Карта RUB', 0)!, /Расхождение/);
  assert.doesNotMatch(
    formatIngestSummary(oneOp(0), 'Карта RUB', 0)!, /Расхождение/,
    'при точном совпадении говорить не о чем',
  );
});
