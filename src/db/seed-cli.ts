import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './index.ts';
import { runMigrations } from './migrations.ts';
import { createAccount, listAccounts } from '../core/accounts.ts';
import { listRecurring } from '../core/recurring.ts';
import { initCurrencies } from '../core/init.ts';
import { knownCurrencies } from '../core/money.ts';

/**
 * Первичное наполнение базы.
 *
 * Создаёт два счёта в базовой валюте, чтобы было с чего начать.
 * Остальное — свои счета, валюты и регулярные платежи — проще завести
 * через бота словами, чем править этот файл.
 */

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
runMigrations(db);
initCurrencies(db, cfg.baseCurrency, process.env.FX_SOURCE);

if (listAccounts(db).length > 0 || listRecurring(db).length > 0) {
  console.log('База уже наполнена — выхожу, чтобы ничего не задвоить.');
  process.exit(0);
}

const base = cfg.baseCurrency;
createAccount(db, { name: `Карта ${base}`, currency: base, kind: 'card' });
createAccount(db, { name: `Наличные ${base}`, currency: base, kind: 'cash' });

console.log(`Базовая валюта: ${base}`);
console.log(`Валют в справочнике: ${knownCurrencies().length}`);
console.log('\nСозданы счета:');
for (const a of listAccounts(db)) console.log(`  ${a.name} (${a.currency})`);

console.log(`
Дальше проще через бота — просто напиши ему:
  «заведи счёт в евро»
  «добавь валюту сингапурский доллар»
  «добавь платёж за интернет 30 евро 15 числа»
  «переименуй Карту ${base} в Основную»
`);

db.close();
