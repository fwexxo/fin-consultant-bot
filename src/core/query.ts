import type { Db } from '../db/index.ts';

/** Инструкции, которые не должны попадать в read-only канал даже случайно. */
const FORBIDDEN = /^\s*(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback)\b/i;

/**
 * Выполняет один SELECT и возвращает строки.
 *
 * Защита двухслойная. Первый слой — better-sqlite3: prepare принимает
 * ровно одну инструкцию (так отсекается «SELECT 1; DELETE FROM ...»),
 * а флаг reader отличает читающий запрос от изменяющего. Второй слой —
 * список запрещённых ключевых слов на случай инструкций, которые
 * SQLite считает читающими, но которые меняют состояние.
 */
export function runReadOnlyQuery(db: Db, sql: string, maxRows = 200): unknown[] {
  const trimmed = sql.trim();

  if (FORBIDDEN.test(trimmed)) {
    throw new Error('Разрешено только чтение: запрос должен начинаться с SELECT или WITH');
  }

  let stmt;
  try {
    stmt = db.prepare(trimmed);
  } catch (err) {
    const message = (err as Error).message;
    // prepare ругается и на множественные инструкции, и на синтаксис —
    // разводим их, чтобы модель понимала, что именно исправлять.
    if (/more than one statement|multiple statements/i.test(message)) {
      throw new Error('Разрешён только один запрос за раз');
    }
    throw new Error(`Ошибка SQL: ${message}`);
  }

  if (!stmt.reader) {
    throw new Error('Разрешено только чтение: этот запрос изменяет данные');
  }

  const rows = stmt.all() as unknown[];
  return rows.slice(0, maxRows);
}
