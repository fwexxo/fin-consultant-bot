import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);

  // WAL даёт конкурентное чтение во время записи: задача напоминаний
  // и обработчик сообщений работают параллельно.
  db.pragma('journal_mode = WAL');

  // SQLite по умолчанию ИГНОРИРУЕТ внешние ключи. Без этой строки
  // ON DELETE CASCADE и ссылочная целостность молча не работают.
  db.pragma('foreign_keys = ON');

  return db;
}
