import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor, fromMinor, rateToStored, convertMinor, formatMoney, RATE_SCALE,
  isKnownCurrency, loadCurrencies,
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

test('валюты без дробной части считаются верно', () => {
  // У иены нет дробной части: 500 иен — это 500 минорных единиц, а не 50000
  assert.equal(toMinor(500, 'JPY'), 500);
  assert.equal(fromMinor(500, 'JPY'), 500);
  assert.equal(formatMoney(500, 'JPY'), '500 JPY', 'дробь не должна печататься');
  assert.equal(formatMoney(-500, 'JPY'), '-500 JPY');
});

test('валюты с тремя знаками считаются верно', () => {
  // У кувейтского динара тысяча фильсов
  assert.equal(toMinor(1.5, 'KWD'), 1500);
  assert.equal(formatMoney(1500, 'KWD'), '1.500 KWD');
  assert.equal(formatMoney(5, 'KWD'), '0.005 KWD');
});

test('неизвестная валюта — ошибка, а не молчаливая двойка', () => {
  // Посчитать иену как рубль значит завысить сумму в сто раз
  assert.throws(() => toMinor(100, 'ZZZ'), /Неизвестная валюта/);
  assert.throws(() => formatMoney(100, 'ZZZ'), /Неизвестная валюта/);
});

test('справочник валют пополняется', () => {
  assert.equal(isKnownCurrency('SGD'), false);
  loadCurrencies([
    { code: 'SGD', minor_units: 2 },
    { code: 'USD', minor_units: 2 },
  ]);
  assert.equal(isKnownCurrency('SGD'), true);
  assert.equal(toMinor(10.5, 'SGD'), 1050);

  // возвращаем встроенный список, чтобы не влиять на соседние тесты
  loadCurrencies([
    { code: 'BYN', minor_units: 2 }, { code: 'RUB', minor_units: 2 },
    { code: 'USD', minor_units: 2 }, { code: 'JPY', minor_units: 0 },
    { code: 'KWD', minor_units: 3 },
  ]);
});
