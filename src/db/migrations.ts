import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS: { version: number; file: string }[] = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_sms.sql' },
  { version: 3, file: '003_currencies.sql' },
];

/** Применяет недостающие миграции. Возвращает итоговую версию схемы. */
export function runMigrations(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version),
  );

  let last = applied.size > 0 ? Math.max(...applied) : 0;

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return last;

  // Внешние ключи выключаются на время миграций: SQLite не умеет менять
  // CHECK-ограничения, поэтому таблицы пересобираются через DROP и RENAME,
  // а при включённых ключах DROP уронил бы связанные записи.
  // Переключать этот режим внутри транзакции нельзя — только снаружи.
  db.pragma('foreign_keys = OFF');
  try {
    for (const m of pending) {
      const sql = readFileSync(join(here, 'migrations', m.file), 'utf8');
      // Миграция применяется атомарно: либо вся, либо никак. Иначе
      // прерванный запуск оставил бы схему в наполовину созданном виде.
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      })();
      last = m.version;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // После пересборки таблиц убеждаемся, что ни одна ссылка не повисла.
  const broken = db.pragma('foreign_key_check') as unknown[];
  if (broken.length > 0) {
    throw new Error(
      `Миграции нарушили ссылочную целостность: ${JSON.stringify(broken.slice(0, 3))}`,
    );
  }

  return last;
}
