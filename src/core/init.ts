import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import { loadCurrencies, isKnownCurrency, knownCurrencies } from './money.ts';
import { setBaseCurrency, setDefaultFetcher, pickFetcher } from './fx.ts';

/**
 * Готовит справочник валют к работе.
 *
 * Вызывается после миграций и до любых денежных операций: без этого
 * число минорных единиц бралось бы из встроенного списка, а не из базы,
 * и добавленная человеком валюта осталась бы неизвестной.
 */
export function initCurrencies(db: Db, base: Currency, fxSource?: string): void {
  const rows = db.prepare(
    'SELECT code, minor_units FROM currencies',
  ).all() as { code: string; minor_units: number }[];

  loadCurrencies(rows);

  if (!isKnownCurrency(base)) {
    throw new Error(
      `Базовая валюта ${base} не найдена. Известные: ${knownCurrencies().join(', ')}.\n`
      + 'Добавь её командой: INSERT INTO currencies (code,name,minor_units) VALUES (...)',
    );
  }
  setBaseCurrency(base);

  // Источнику НБРБ передаём только используемые валюты: он опрашивает
  // каждую отдельным запросом, и весь справочник означал бы три десятка
  // обращений к сети ради одной операции.
  const used = new Set<string>([base]);
  for (const row of db.prepare('SELECT DISTINCT currency FROM accounts').all() as
    { currency: string }[]) {
    used.add(row.currency);
  }
  setDefaultFetcher(pickFetcher(fxSource, [...used]));
}
