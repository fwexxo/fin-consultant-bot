import 'dotenv/config';
import { Bot } from 'grammy';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrations.ts';
import {
  ingestSms, formatIngestSummary, DEFAULT_DRIFT_ALERT_MINOR, type IncomingSms,
} from '../ingest/sms-ingest.ts';
import { initCurrencies } from '../core/init.ts';

/**
 * Принимает пачку СМС и записывает новые операции.
 *
 * Читает JSON-массив со stdin, чтобы вызывающему (наблюдателю на маке)
 * не требовалось ни открытого порта, ни отдельной авторизации: всё идёт
 * по уже доверенному SSH-каналу.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const cfg = loadConfig(process.env);

const card = process.env.SMS_CARD?.trim();
const cardAccountName = process.env.SMS_CARD_ACCOUNT?.trim();
const cashAccountName = process.env.SMS_CASH_ACCOUNT?.trim() || 'Наличные RUB';
const sinceDate = process.env.SMS_SINCE?.trim();
const driftAlert = parseDriftAlert(process.env.SMS_DRIFT_ALERT);

/** Порог задаётся в рублях, внутри считаем в копейках. */
function parseDriftAlert(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DRIFT_ALERT_MINOR;
  const rub = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(rub) || rub < 0) {
    console.error(`SMS_DRIFT_ALERT=«${raw}» — не число, беру значение по умолчанию`);
    return DEFAULT_DRIFT_ALERT_MINOR;
  }
  return Math.round(rub * 100);
}

if (!card || !cardAccountName || !sinceDate) {
  console.error('Нужны SMS_CARD, SMS_CARD_ACCOUNT и SMS_SINCE в окружении');
  process.exit(2);
}

const raw = await readStdin();
let messages: IncomingSms[];
try {
  messages = JSON.parse(raw);
  if (!Array.isArray(messages)) throw new Error('ожидался массив');
} catch (err) {
  console.error(`Не разобрал вход: ${(err as Error).message}`);
  process.exit(2);
}

const db = openDatabase(cfg.databasePath);
runMigrations(db);
initCurrencies(db, cfg.baseCurrency, process.env.FX_SOURCE);

try {
  const result = await ingestSms(db, messages, {
    card, cardAccountName, cashAccountName, sinceDate,
  });

  const summary = formatIngestSummary(result, cardAccountName, driftAlert);

  // SMS_NOTIFY=0 глушит отправку — нужно, чтобы проверки на копии базы
  // не слали владельцу сообщения о несуществующих операциях.
  const notify = process.env.SMS_NOTIFY?.trim() !== '0';

  // Сообщение отправляем только когда есть что сказать: молчание
  // при пустой пачке — это норма, а не сбой.
  if (notify && summary && cfg.ownerId !== null) {
    try {
      await new Bot(cfg.botToken).api.sendMessage(cfg.ownerId, summary);
    } catch (err) {
      console.error(`Записал, но не отправил в Телеграм: ${(err as Error).message}`);
    }
  }

  console.log(JSON.stringify({
    seen: result.seen,
    recorded: result.recorded.length,
    duplicate: result.skippedDuplicate,
    tooOld: result.skippedTooOld,
    unparsed: result.skippedUnparsed,
    drift: result.drift?.driftMinor ?? null,
  }));
} finally {
  db.close();
}
