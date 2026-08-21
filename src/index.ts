import 'dotenv/config';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrations.ts';
import { Queue } from './claude/queue.ts';
import { createBot } from './bot/index.ts';
import { startReminders } from './jobs/reminders.ts';
import { loadWhisperConfig, createWhisperTranscriber } from './speech/whisper.ts';
import { initCurrencies } from './core/init.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
runMigrations(db);
initCurrencies(db, cfg.baseCurrency, process.env.FX_SOURCE);

const queue = new Queue();

const whisper = loadWhisperConfig(process.env);
if (whisper) {
  console.log(`Распознавание речи включено: ${whisper.modelPath} (${whisper.language})`);
} else {
  console.log('Распознавание речи выключено: WHISPER_BIN или WHISPER_MODEL не заданы');
}

const bot = createBot({
  cfg,
  db,
  queue,
  transcribe: whisper ? createWhisperTranscriber(whisper) : undefined,
});

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
