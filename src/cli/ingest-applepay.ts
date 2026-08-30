import 'dotenv/config';
import { Bot } from 'grammy';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrations.ts';
import {
  ingestApplePay, formatApplePaySummary, parseEvents, type ApplePayEvent,
} from '../ingest/applepay.ts';
import { initCurrencies } from '../core/init.ts';

/**
 * Принимает оплату Apple Pay с айфона.
 *
 * Читает со stdin либо один объект, либо массив: быстрая команда шлёт
 * по одной оплате, но накопленную пачку принять тоже надо.
 *
 * Вызывается по SSH ключом, которому в authorized_keys прописана ровно
 * эта команда, — поэтому телефон не может запустить на сервере ничего
 * другого, даже если попадёт в чужие руки.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const cfg = loadConfig(process.env);
const accountName = process.env.APPLEPAY_ACCOUNT?.trim();

if (!accountName) {
  console.error('Нужен APPLEPAY_ACCOUNT в окружении');
  process.exit(2);
}

const raw = (await readStdin()).trim();
if (raw === '') {
  console.error('Пустой вход');
  process.exit(2);
}

let events: ApplePayEvent[];
try {
  events = parseEvents(raw);
} catch (err) {
  console.error(`Не разобрал вход: ${(err as Error).message}`);
  process.exit(2);
}

const db = openDatabase(cfg.databasePath);
runMigrations(db);
initCurrencies(db, cfg.baseCurrency, process.env.FX_SOURCE);

try {
  const today = new Date().toISOString().slice(0, 10);
  const result = await ingestApplePay(db, events, { accountName, today });

  const summary = formatApplePaySummary(result);
  const notify = process.env.APPLEPAY_NOTIFY?.trim() !== '0';

  if (notify && summary && cfg.ownerId !== null) {
    try {
      await new Bot(cfg.botToken).api.sendMessage(cfg.ownerId, summary);
    } catch (err) {
      console.error(`Записал, но не отправил в Телеграм: ${(err as Error).message}`);
    }
  }

  // Отвергнутое не замалчиваем: молчание выглядит как успех, а деньги
  // при этом мимо кассы.
  for (const bad of result.rejected) {
    console.error(`не записал: ${bad.reason} — ${bad.raw}`);
  }

  console.log(JSON.stringify({
    recorded: result.recorded.length,
    duplicate: result.skippedDuplicate,
    rejected: result.rejected.length,
  }));

  if (result.recorded.length === 0 && result.rejected.length > 0) process.exit(1);
} finally {
  db.close();
}
