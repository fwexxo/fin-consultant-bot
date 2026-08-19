import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParsed, extractJson } from '../../src/claude/parse.ts';

test('валидный разбор проходит', () => {
  const r = validateParsed({
    amount: 5, currency: 'RUB', category: 'кафе',
    date: '2026-08-19', direction: 'expense', note: 'кофе', confidence: 'high',
  }, '2026-08-19');
  assert.equal(r.amount, 5);
  assert.equal(r.currency, 'RUB');
  assert.equal(r.category, 'кафе');
});

test('валюта приводится к верхнему регистру', () => {
  const r = validateParsed({
    amount: 5, currency: 'rub', category: null,
    date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19');
  assert.equal(r.currency, 'RUB');
});

test('неподдерживаемая валюта отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'EUR', category: null,
    date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19'), /валют/i);
});

test('отрицательная или нулевая сумма отвергается', () => {
  for (const amount of [0, -5]) {
    assert.throws(() => validateParsed({
      amount, currency: 'RUB', category: null,
      date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
    }, '2026-08-19'), /сумм/i);
  }
});

test('нечисловая сумма отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 'пять', currency: 'RUB', category: null,
    date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19'), /сумм/i);
});

test('дата из будущего отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'RUB', category: null,
    date: '2027-01-01', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19'), /будущ/i);
});

test('отсутствующая или кривая дата заменяется сегодняшней', () => {
  for (const date of [undefined, 'вчера', '19.08.2026']) {
    const r = validateParsed({
      amount: 5, currency: 'RUB', category: null,
      date, direction: 'expense', note: null, confidence: 'high',
    }, '2026-08-19');
    assert.equal(r.date, '2026-08-19');
  }
});

test('мусор вместо объекта отвергается', () => {
  assert.throws(() => validateParsed('не объект', '2026-08-19'), /объект/i);
  assert.throws(() => validateParsed(null, '2026-08-19'), /объект/i);
  assert.throws(() => validateParsed([], '2026-08-19'), /объект/i);
});

test('неизвестное направление отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'RUB', category: null,
    date: '2026-08-19', direction: 'подарок', note: null, confidence: 'high',
  }, '2026-08-19'), /направлени/i);
});

test('пустая категория превращается в null', () => {
  const r = validateParsed({
    amount: 5, currency: 'RUB', category: '',
    date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19');
  assert.equal(r.category, null);
});

test('confidence по умолчанию high, low распознаётся', () => {
  const high = validateParsed({
    amount: 5, currency: 'RUB', category: null, date: '2026-08-19',
    direction: 'expense', note: null,
  }, '2026-08-19');
  assert.equal(high.confidence, 'high');

  const low = validateParsed({
    amount: 5, currency: 'RUB', category: null, date: '2026-08-19',
    direction: 'expense', note: null, confidence: 'low',
  }, '2026-08-19');
  assert.equal(low.confidence, 'low');
});

test('extractJson достаёт объект из markdown-обёртки', () => {
  const text = 'Вот результат:\n```json\n{"amount": 5}\n```\nГотово.';
  assert.deepEqual(extractJson(text), { amount: 5 });
});

test('extractJson работает с голым JSON', () => {
  assert.deepEqual(extractJson('{"amount": 5}'), { amount: 5 });
});

test('extractJson падает понятно, если JSON нет', () => {
  assert.throws(() => extractJson('никакого json тут нет'), /JSON/);
});
