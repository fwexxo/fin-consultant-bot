import { openDatabase, type Db } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrations.ts';
import { initCurrencies } from '../src/core/init.ts';
import type { RatesFetcher } from '../src/core/fx.ts';

/**
 * База в памяти со схемой, справочником валют и заданной базовой валютой.
 *
 * Без initCurrencies число минорных единиц бралось бы из встроенного
 * списка, а базовая валюта осталась бы значением по умолчанию.
 */
export function testDb(base = 'BYN'): Db {
  const db = openDatabase(':memory:');
  runMigrations(db);
  initCurrencies(db, base);
  return db;
}

/**
 * Источник курсов с заранее заданными значениями.
 *
 * Ключ — код валюты, значение — сколько базовой стоит одна её единица.
 * Сеть не задействуется, поэтому тесты остаются быстрыми и независимыми.
 */
export function fixedRates(rates: Record<string, number>): RatesFetcher {
  return async () => ({ ...rates });
}

/** Все валюты по одному курсу — когда конкретные значения не важны. */
export function flatRate(value = 1): RatesFetcher {
  return async () => ({ BYN: value, RUB: value, USD: value, EUR: value });
}
