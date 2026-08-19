import 'dotenv/config';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrations.ts';
import { Queue } from './claude/queue.ts';
import { createBot } from './bot/index.ts';
import { startReminders } from './jobs/reminders.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
runMigrations(db);

const queue = new Queue();
const bot = createBot({ cfg, db, queue });

if (cfg.ownerId === null) {
  console.warn(
    'OWNER_ID не задан: напоминания выключены, бот только сообщит твой Telegram ID.',
  );
} else {
  startReminders({ cfg, db, bot });
}

function shutdown(signal: string) {
  console.log(`${signal} — останавливаюсь`);
  void bot.stop().finally(() => {
    db.close();
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

console.log(`Бот запущен, база: ${cfg.databasePath}`);
await bot.start();
