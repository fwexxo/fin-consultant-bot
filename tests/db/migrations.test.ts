import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function seedAccount(db: ReturnType<typeof freshDb>, name = 'нал BYN') {
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES (?,'BYN','cash')").run(name);
}

test('миграции создают все таблицы', () => {
  const db = freshDb();
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);

  for (const t of ['accounts', 'budgets', 'categories', 'fx_rates',
    'payment_instances', 'recurring_payments',
    'schema_migrations', 'transactions']) {
    assert.ok(names.includes(t), `нет таблицы ${t}`);
  }
});

test('миграции идемпотентны', () => {
  const db = openDatabase(':memory:');
  assert.equal(runMigrations(db), 1);
  assert.equal(runMigrations(db), 1);
  const n = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number };
  assert.equal(n.c, 1);
});

test('foreign_keys включены', () => {
  const db = freshDb();
  const rows = db.pragma('foreign_keys') as { foreign_keys: number }[];
  assert.equal(rows[0]!.foreign_keys, 1);
});

test('обе стороны перевода обязаны иметь counter_account_id', () => {
  const db = freshDb();
  seedAccount(db);
  for (const dir of ['transfer_out', 'transfer_in']) {
    assert.throws(() => {
      db.prepare(`INSERT INTO transactions
        (ts,account_id,amount_minor,currency,direction,fx_rate_to_base)
        VALUES ('2026-08-19',1,100,'BYN',?,100000000)`).run(dir);
    }, /CHECK/, `${dir} без counter_account_id должен отвергаться`);
  }
});

test('неизвестное направление отвергается', () => {
  const db = freshDb();
  seedAccount(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,fx_rate_to_base)
      VALUES ('2026-08-19',1,100,'BYN','transfer',100000000)`).run();
  }, /CHECK/, 'слитный transfer больше не допускается');
});

test('расход не может иметь counter_account_id', () => {
  const db = freshDb();
  seedAccount(db, 'A');
  seedAccount(db, 'B');
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,counter_account_id,fx_rate_to_base)
      VALUES ('2026-08-19',1,100,'BYN','expense',2,100000000)`).run();
  }, /CHECK/);
});

test('отрицательная сумма транзакции отвергается', () => {
  const db = freshDb();
  seedAccount(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,fx_rate_to_base)
      VALUES ('2026-08-19',1,-100,'BYN','expense',100000000)`).run();
  }, /CHECK/);
});

test('неизвестная валюта отвергается', () => {
  const db = freshDb();
  assert.throws(() => {
    db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('евро','EUR','cash')").run();
  }, /CHECK/);
});

test('правило платежа не может задавать срок двумя способами', () => {
  const db = freshDb();
  seedAccount(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO recurring_payments
      (title,account_id,amount_minor,currency,day_of_month,is_last_day)
      VALUES ('интернет',1,3000,'BYN',15,1)`).run();
  }, /CHECK/);
});

test('правило платежа не может остаться без срока', () => {
  const db = freshDb();
  seedAccount(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO recurring_payments
      (title,account_id,amount_minor,currency,day_of_month,is_last_day)
      VALUES ('интернет',1,3000,'BYN',NULL,0)`).run();
  }, /CHECK/);
});

test('фиксированный платёж обязан иметь сумму', () => {
  const db = freshDb();
  seedAccount(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO recurring_payments
      (title,account_id,amount_minor,currency,day_of_month,is_variable)
      VALUES ('интернет',1,NULL,'BYN',15,0)`).run();
  }, /CHECK/);
});

test('плавающий платёж без суммы допустим', () => {
  const db = freshDb();
  seedAccount(db);
  db.prepare(`INSERT INTO recurring_payments
    (title,account_id,amount_minor,currency,day_of_month,is_variable)
    VALUES ('коммуналка',1,NULL,'BYN',15,1)`).run();
  const n = db.prepare('SELECT COUNT(*) c FROM recurring_payments').get() as { c: number };
  assert.equal(n.c, 1);
});

test('один платёж не задваивается в одном периоде', () => {
  const db = freshDb();
  seedAccount(db);
  db.prepare(`INSERT INTO recurring_payments
    (title,account_id,amount_minor,currency,day_of_month)
    VALUES ('интернет',1,3000,'BYN',15)`).run();
  db.prepare("INSERT INTO payment_instances (recurring_id,period,due_date) VALUES (1,'2026-08','2026-08-15')").run();
  assert.throws(() => {
    db.prepare("INSERT INTO payment_instances (recurring_id,period,due_date) VALUES (1,'2026-08','2026-08-15')").run();
  }, /UNIQUE/);
});

test('удаление правила уносит его инстансы', () => {
  const db = freshDb();
  seedAccount(db);
  db.prepare(`INSERT INTO recurring_payments
    (title,account_id,amount_minor,currency,day_of_month)
    VALUES ('интернет',1,3000,'BYN',15)`).run();
  db.prepare("INSERT INTO payment_instances (recurring_id,period,due_date) VALUES (1,'2026-08','2026-08-15')").run();

  db.prepare('DELETE FROM recurring_payments WHERE id = 1').run();
  const n = db.prepare('SELECT COUNT(*) c FROM payment_instances').get() as { c: number };
  assert.equal(n.c, 0, 'CASCADE не сработал — foreign_keys выключены?');
});

test('базовые категории засеяны', () => {
  const db = freshDb();
  const n = db.prepare('SELECT COUNT(*) c FROM categories').get() as { c: number };
  assert.ok(n.c >= 15, `категорий всего ${n.c}`);
});

test('одноимённые категории разного вида сосуществуют', () => {
  const db = freshDb();
  const n = db.prepare("SELECT COUNT(*) c FROM categories WHERE name = 'прочее'")
    .get() as { c: number };
  assert.equal(n.c, 2, 'прочее должно быть и в расходах, и в доходах');
});
