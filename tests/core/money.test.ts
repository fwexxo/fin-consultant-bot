import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor, fromMinor, rateToStored, convertMinor, formatMoney, RATE_SCALE,
} from '../../src/core/money.ts';

test('toMinor переводит в копейки', () => {
  assert.equal(toMinor(5, 'RUB'), 500);
  assert.equal(toMinor(30.45, 'BYN'), 3045);
  assert.equal(toMinor(0.01, 'USD'), 1);
});

test('toMinor корректно округляет проблемные для float значения', () => {
  // 19.99 * 100 в float даёт 1998.9999999999998
  assert.equal(toMinor(19.99, 'BYN'), 1999);
  assert.equal(toMinor(1.005, 'USD'), 101);
  assert.equal(toMinor(0.29, 'BYN'), 29);
  assert.equal(toMinor(1.1, 'RUB'), 110);
});

test('fromMinor обратен toMinor', () => {
  assert.equal(fromMinor(3045, 'BYN'), 30.45);
  assert.equal(fromMinor(0, 'USD'), 0);
});

test('rateToStored хранит курс целым числом', () => {
  assert.equal(rateToStored(3.4), 340_000_000);
  assert.equal(rateToStored(0.035), 3_500_000);
  assert.equal(RATE_SCALE, 100_000_000);
});

test('convertMinor умножает сумму на курс', () => {
  // 100.00 RUB при курсе 0.035 BYN за рубль = 3.50 BYN
  assert.equal(convertMinor(10_000, rateToStored(0.035)), 350);
});

test('convertMinor не переполняется на больших суммах', () => {
  // 10 млн в копейках × курс 3.4 — произведение превышает
  // Number.MAX_SAFE_INTEGER, поэтому внутри обязан быть BigInt
  const result = convertMinor(1_000_000_000, rateToStored(3.4));
  assert.equal(result, 3_400_000_000);
  assert.ok(Number.isSafeInteger(result));
});

test('convertMinor округляет к ближайшему, а не отбрасывает', () => {
  const rate = rateToStored(0.333333);
  assert.equal(convertMinor(100, rate), 33);
  assert.equal(convertMinor(1000, rate), 333);
});

test('convertMinor корректен для отрицательных сумм', () => {
  assert.equal(convertMinor(-150, rateToStored(2)), -300);
  // округление должно быть симметричным относительно нуля
  assert.equal(convertMinor(-100, rateToStored(0.333333)), -33);
});

test('convertMinor на нуле даёт ноль', () => {
  assert.equal(convertMinor(0, rateToStored(3.4)), 0);
});

test('formatMoney выводит человекочитаемо', () => {
  assert.equal(formatMoney(3045, 'BYN'), '30.45 BYN');
  assert.equal(formatMoney(-500, 'RUB'), '-5.00 RUB');
  assert.equal(formatMoney(0, 'USD'), '0.00 USD');
  assert.equal(formatMoney(5, 'BYN'), '0.05 BYN');
  assert.equal(formatMoney(100, 'BYN'), '1.00 BYN');
});
