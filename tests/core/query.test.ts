import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { runReadOnlyQuery } from '../../src/core/query.ts';
import { createAccount } from '../../src/core/accounts.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

test('SELECT выполняется и возвращает строки', () => {
  const db = freshDb();
  createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });

  const rows = runReadOnlyQuery(db, 'SELECT name, currency FROM accounts');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: 'Карта BYN', currency: 'BYN' });
});

test('INSERT отвергается', () => {
  const db = freshDb();
  assert.throws(
    () => runReadOnlyQuery(db, "INSERT INTO accounts (name,currency,kind) VALUES ('x','BYN','cash')"),
    /только чтение/i,
  );
});

test('UPDATE отвергается', () => {
  const db = freshDb();
  createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  assert.throws(
    () => runReadOnlyQuery(db, "UPDATE accounts SET name = 'B'"),
    /только чтение/i,
  );
  const row = db.prepare('SELECT name FROM accounts').get() as { name: string };
  assert.equal(row.name, 'A', 'данные не должны измениться');
});

test('DELETE отвергается', () => {
  const db = freshDb();
  createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  assert.throws(() => runReadOnlyQuery(db, 'DELETE FROM accounts'), /только чтение/i);
  const n = db.prepare('SELECT COUNT(*) c FROM accounts').get() as { c: number };
  assert.equal(n.c, 1);
});

test('DROP отвергается', () => {
  const db = freshDb();
  assert.throws(() => runReadOnlyQuery(db, 'DROP TABLE accounts'), /только чтение/i);
});

test('PRAGMA отвергается', () => {
  const db = freshDb();
  assert.throws(() => runReadOnlyQuery(db, 'PRAGMA foreign_keys = OFF'), /только чтение/i);
});

test('ATTACH отвергается', () => {
  const db = freshDb();
  assert.throws(() => runReadOnlyQuery(db, "ATTACH DATABASE '/tmp/x.db' AS x"), /только чтение/i);
});

test('несколько запросов в одной строке отвергаются', () => {
  const db = freshDb();
  createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  assert.throws(
    () => runReadOnlyQuery(db, 'SELECT 1; DELETE FROM accounts'),
    /один запрос|только чтение/i,
  );
  const n = db.prepare('SELECT COUNT(*) c FROM accounts').get() as { c: number };
  assert.equal(n.c, 1, 'вторая инструкция не должна выполниться');
});

test('WITH ... SELECT разрешён', () => {
  const db = freshDb();
  const rows = runReadOnlyQuery(db, 'WITH t(x) AS (SELECT 1) SELECT x FROM t');
  assert.deepEqual(rows, [{ x: 1 }]);
});

test('результат ограничен по числу строк', () => {
  const db = freshDb();
  for (let i = 0; i < 60; i += 1) {
    createAccount(db, { name: `счёт ${i}`, currency: 'BYN', kind: 'cash' });
  }
  const rows = runReadOnlyQuery(db, 'SELECT name FROM accounts', 50);
  assert.equal(rows.length, 50, 'выдача должна обрезаться, чтобы не раздувать контекст');
});

test('синтаксическая ошибка даёт понятное сообщение', () => {
  const db = freshDb();
  assert.throws(() => runReadOnlyQuery(db, 'SELEKT * FROM accounts'), /SQL/i);
});
