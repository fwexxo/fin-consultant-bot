import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './index.ts';
import { runMigrations } from './migrations.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
const version = runMigrations(db);
console.log(`Схема БД на версии ${version} (${cfg.databasePath})`);
db.close();
