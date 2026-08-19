import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS: { version: number; file: string }[] = [
  { version: 1, file: '001_initial.sql' },
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

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const sql = readFileSync(join(here, 'migrations', m.file), 'utf8');
    // Миграция применяется атомарно: либо вся, либо никак. Иначе
    // прерванный запуск оставил бы схему в наполовину созданном виде.
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    })();
    last = m.version;
  }

  return last;
}
