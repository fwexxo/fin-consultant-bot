import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwner } from '../../src/bot/guard.ts';

test('владелец пропускается', () => {
  assert.equal(isOwner(123456789, 123456789), true);
});

test('посторонний не пропускается', () => {
  assert.equal(isOwner(123456789, 99999), false);
});

test('отсутствующий отправитель не пропускается', () => {
  assert.equal(isOwner(123456789, undefined), false);
});

test('при незаданном OWNER_ID не пропускается никто', () => {
  assert.equal(isOwner(null, 123456789), false);
  assert.equal(isOwner(null, undefined), false);
});

test('строковый id не проходит за числовой', () => {
  // защита от нестрогого сравнения '123' == 123
  assert.equal(isOwner(123, '123' as unknown as number), false);
});

test('ноль и отрицательные не проходят', () => {
  assert.equal(isOwner(0 as number, 0), false);
  assert.equal(isOwner(-1, -1), false);
});
