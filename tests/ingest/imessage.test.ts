import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAttributedText, readSms } from '../../src/ingest/imessage.ts';

/** Собирает attributedBody так же, как это делает macOS. */
function makeBlob(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.from('\x04\x0bstreamtyped...NSString\x01\x95', 'binary');
  const marker = Buffer.from([0x84, 0x01, 0x2b]);

  let lenPart: Buffer;
  if (body.length < 0x81) {
    lenPart = Buffer.from([body.length]);
  } else {
    lenPart = Buffer.alloc(3);
    lenPart[0] = 0x81;
    lenPart.writeUInt16LE(body.length, 1);
  }
  return Buffer.concat([head, marker, lenPart, body]);
}

/** Apple считает время в наносекундах от 2001-01-01. */
function appleTime(iso: string): number {
  return (Date.parse(iso) / 1000 - 978307200) * 1_000_000_000;
}

function makeChatDb(rows: { rowid: number; iso: string; text: string; sender?: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'chatdb-'));
  const path = join(dir, 'chat.db');
  const db = new Database(path);

  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, handle_id INTEGER,
      text TEXT, attributedBody BLOB, date INTEGER
    );
    INSERT INTO handle (ROWID, id) VALUES (1, '900'), (2, '+70001112233');
  `);

  const ins = db.prepare(
    'INSERT INTO message (ROWID, handle_id, text, attributedBody, date) VALUES (?,?,NULL,?,?)',
  );
  for (const r of rows) {
    ins.run(r.rowid, r.sender === 'other' ? 2 : 1, makeBlob(r.text), appleTime(r.iso));
  }
  db.close();

  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('extractAttributedText достаёт короткую строку', () => {
  assert.equal(extractAttributedText(makeBlob('кофе 5 рублей')), 'кофе 5 рублей');
});

test('extractAttributedText достаёт длинную строку с двухбайтовой длиной', () => {
  const long = 'Счёт карты MIR-0000 '.repeat(20);
  assert.equal(extractAttributedText(makeBlob(long)), long);
});

test('extractAttributedText на мусоре возвращает null', () => {
  assert.equal(extractAttributedText(null), null);
  assert.equal(extractAttributedText(Buffer.alloc(0)), null);
  assert.equal(extractAttributedText(Buffer.from('без маркера')), null);
});

test('readSms читает только нужного отправителя', () => {
  const { path, cleanup } = makeChatDb([
    { rowid: 1, iso: '2026-08-22T10:00:00Z', text: 'от банка' },
    { rowid: 2, iso: '2026-08-22T11:00:00Z', text: 'от друга', sender: 'other' },
  ]);
  try {
    const rows = readSms({ dbPath: path, sender: '900' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, 'от банка');
  } finally { cleanup(); }
});

test('readSms отдаёт только сообщения новее afterRowid', () => {
  const { path, cleanup } = makeChatDb([
    { rowid: 1, iso: '2026-08-22T10:00:00Z', text: 'первое' },
    { rowid: 2, iso: '2026-08-22T11:00:00Z', text: 'второе' },
    { rowid: 3, iso: '2026-08-22T12:00:00Z', text: 'третье' },
  ]);
  try {
    const rows = readSms({ dbPath: path, sender: '900', afterRowid: 1 });
    assert.deepEqual(rows.map((r) => r.text), ['второе', 'третье']);
  } finally { cleanup(); }
});

test('лимит применяется ПОСЛЕ отбора по дате, а не до него', () => {
  // Ключевая проверка: если отбор по дате идёт после LIMIT, то лимит
  // съедят старые сообщения и до свежих очередь никогда не дойдёт.
  const rows = [];
  for (let i = 1; i <= 30; i += 1) {
    rows.push({ rowid: i, iso: '2026-07-01T10:00:00Z', text: `старое ${i}` });
  }
  rows.push({ rowid: 31, iso: '2026-08-22T10:00:00Z', text: 'свежее' });

  const { path, cleanup } = makeChatDb(rows);
  try {
    const got = readSms({ dbPath: path, sender: '900', sinceDate: '2026-08-22', limit: 5 });
    assert.equal(got.length, 1, 'должно найтись свежее сообщение, а не пустота');
    assert.equal(got[0]!.text, 'свежее');
  } finally { cleanup(); }
});

test('без sinceDate возвращается всё', () => {
  const { path, cleanup } = makeChatDb([
    { rowid: 1, iso: '2020-01-01T10:00:00Z', text: 'древнее' },
    { rowid: 2, iso: '2026-08-22T10:00:00Z', text: 'свежее' },
  ]);
  try {
    assert.equal(readSms({ dbPath: path, sender: '900' }).length, 2);
  } finally { cleanup(); }
});

test('дата возвращается в формате YYYY-MM-DD', () => {
  const { path, cleanup } = makeChatDb([
    { rowid: 1, iso: '2026-08-22T10:00:00Z', text: 'привет' },
  ]);
  try {
    const [r] = readSms({ dbPath: path, sender: '900' });
    assert.match(r!.date, /^\d{4}-\d{2}-\d{2}$/);
  } finally { cleanup(); }
});
