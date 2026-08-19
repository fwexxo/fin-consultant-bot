import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastDayOfMonth, dueDateFor, currentPeriod, addDays,
} from '../../src/core/dates.ts';

test('lastDayOfMonth знает длину месяцев', () => {
  assert.equal(lastDayOfMonth(2026, 1), 31);
  assert.equal(lastDayOfMonth(2026, 4), 30);
  assert.equal(lastDayOfMonth(2026, 2), 28);
  assert.equal(lastDayOfMonth(2026, 12), 31);
});

test('lastDayOfMonth учитывает високосный год', () => {
  assert.equal(lastDayOfMonth(2024, 2), 29);
  assert.equal(lastDayOfMonth(2000, 2), 29, 'делится на 400 — високосный');
  assert.equal(lastDayOfMonth(1900, 2), 28, 'делится на 100, но не на 400');
});

test('dueDateFor для фиксированного числа', () => {
  assert.equal(dueDateFor('2026-08', 15, false), '2026-08-15');
  assert.equal(dueDateFor('2026-01', 15, false), '2026-01-15');
  assert.equal(dueDateFor('2026-08', 1, false), '2026-08-01');
});

test('dueDateFor для последнего числа месяца', () => {
  assert.equal(dueDateFor('2026-08', null, true), '2026-08-31');
  assert.equal(dueDateFor('2026-04', null, true), '2026-04-30');
  assert.equal(dueDateFor('2026-02', null, true), '2026-02-28');
  assert.equal(dueDateFor('2024-02', null, true), '2024-02-29');
});

test('dueDateFor обрезает слишком большое число по длине месяца', () => {
  // правило "31-го" в феврале даёт 28-е, а не 3 марта
  assert.equal(dueDateFor('2026-02', 31, false), '2026-02-28');
  assert.equal(dueDateFor('2026-04', 31, false), '2026-04-30');
  assert.equal(dueDateFor('2024-02', 30, false), '2024-02-29');
});

test('dueDateFor отвергает некорректный период', () => {
  assert.throws(() => dueDateFor('2026-13', 1, false), /период/i);
  assert.throws(() => dueDateFor('2026-00', 1, false), /период/i);
  assert.throws(() => dueDateFor('август', 1, false), /период/i);
  assert.throws(() => dueDateFor('2026-8', 1, false), /период/i);
});

test('dueDateFor требует день или флаг последнего числа', () => {
  assert.throws(() => dueDateFor('2026-08', null, false), /day_of_month/);
});

test('dueDateFor отвергает день вне диапазона', () => {
  assert.throws(() => dueDateFor('2026-08', 0, false), /day_of_month/);
  assert.throws(() => dueDateFor('2026-08', 32, false), /day_of_month/);
});

test('currentPeriod форматирует YYYY-MM', () => {
  assert.equal(currentPeriod(new Date('2026-08-19T12:00:00Z')), '2026-08');
  assert.equal(currentPeriod(new Date('2026-01-01T00:00:00Z')), '2026-01');
  assert.equal(currentPeriod(new Date('2026-12-31T23:00:00Z')), '2026-12');
});

test('addDays переходит через границу месяца и года', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-08-15', -3), '2026-08-12');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('addDays отвергает мусор', () => {
  assert.throws(() => addDays('не дата', 1), /дата/i);
});
