import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './index.ts';
import { runMigrations } from './migrations.ts';
import { initCurrencies } from '../core/init.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
const version = runMigrations(db);
initCurrencies(db, cfg.baseCurrency, process.env.FX_SOURCE);
console.log(`Схема БД на версии ${version} (${cfg.databasePath})`);
db.close();
