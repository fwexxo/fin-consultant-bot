import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { IsoDate } from './dates.ts';
import { rateToStored } from './money.ts';

const BASE: Currency = 'BYN';

export type RateFetcher = (currency: Currency, date: IsoDate) => Promise<number>;

export interface NbrbRate {
  Cur_Scale?: number;
  Cur_OfficialRate?: number;
}

/**
 * НБРБ отдаёт курс за Cur_Scale единиц валюты, а не за одну:
 * для российского рубля масштаб равен 100. Деление обязательно,
 * иначе рубль окажется в сто раз дороже, чем есть.
 */
export function parseNbrbResponse(data: NbrbRate): number {
  const { Cur_Scale: scale, Cur_OfficialRate: official } = data;
  if (typeof scale !== 'number' || typeof official !== 'number') {
    throw new Error('Неожиданный ответ НБРБ: нет Cur_Scale или Cur_OfficialRate');
  }
  if (scale <= 0) {
    throw new Error(`Некорректный Cur_Scale: ${scale}`);
  }
  return official / scale;
}

export const fetchRateFromNbrb: RateFetcher = async (currency, date) => {
  const url = `https://api.nbrb.by/exrates/rates/${currency}?parammode=2&ondate=${date}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`НБРБ вернул ${res.status} для ${currency} на ${date}`);
  }
  return parseNbrbResponse(await res.json() as NbrbRate);
};

/** Курс валюты к BYN в хранимом виде (× 1e8), с кешированием по дате. */
export async function getRate(
  db: Db,
  currency: Currency,
  date: IsoDate,
  fetcher: RateFetcher = fetchRateFromNbrb,
): Promise<number> {
  if (currency === BASE) {
    return rateToStored(1);
  }

  const cached = db.prepare(
    'SELECT rate FROM fx_rates WHERE date = ? AND base = ? AND quote = ?',
  ).get(date, BASE, currency) as { rate: number } | undefined;

  if (cached) return cached.rate;

  // Сетевой запрос вне транзакции: при ошибке в кеш не должно
  // попасть ничего, иначе неверный курс закрепится навсегда.
  const raw = await fetcher(currency, date);
  const stored = rateToStored(raw);

  db.prepare(
    'INSERT OR REPLACE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)',
  ).run(date, BASE, currency, stored);

  return stored;
}
