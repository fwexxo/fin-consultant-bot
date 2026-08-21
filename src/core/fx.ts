import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { IsoDate } from './dates.ts';
import { rateToStored } from './money.ts';

/**
 * Курсы валют.
 *
 * Базовая валюта задаётся настройкой, а не прибита к белорусскому рублю:
 * проект должен годиться и человеку в Варшаве, и человеку в Тбилиси.
 */

let baseCurrency = 'USD';
let defaultFetcher: RatesFetcher | null = null;

export function setBaseCurrency(code: Currency): void {
  baseCurrency = code;
}

export function getBaseCurrency(): Currency {
  return baseCurrency;
}

/** Задаёт источник курсов по умолчанию (из настройки FX_SOURCE). */
export function setDefaultFetcher(fetcher: RatesFetcher): void {
  defaultFetcher = fetcher;
}

/** Возвращает курсы всех валют к базовой на указанную дату. */
export type RatesFetcher = (base: Currency, date: IsoDate) => Promise<Record<string, number>>;

// ---------------------------------------------------------------------
// Источник по умолчанию: open.er-api.com — без ключа, около 160 валют.
// ---------------------------------------------------------------------

export function parseErApi(data: unknown, base: Currency): Record<string, number> {
  const d = data as { result?: string; rates?: Record<string, number> };
  if (d.result !== 'success' || !d.rates) {
    throw new Error('Неожиданный ответ сервиса курсов');
  }
  // Сервис отдаёт «сколько валюты за одну базовую», а нам нужно обратное:
  // сколько базовой стоит одна единица валюты.
  const out: Record<string, number> = {};
  for (const [code, perBase] of Object.entries(d.rates)) {
    if (typeof perBase === 'number' && perBase > 0) out[code] = 1 / perBase;
  }
  out[base] = 1;
  return out;
}

export const fetchRatesFromErApi: RatesFetcher = async (base) => {
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Сервис курсов вернул ${res.status}`);
  return parseErApi(await res.json(), base);
};

// ---------------------------------------------------------------------
// Источник для Беларуси: Нацбанк РБ. Точнее для BYN и знает историю,
// но работает только когда базовая валюта — белорусский рубль.
// ---------------------------------------------------------------------

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
  if (scale <= 0) throw new Error(`Некорректный Cur_Scale: ${scale}`);
  return official / scale;
}

export function createNbrbFetcher(currencies: string[]): RatesFetcher {
  return async (base, date) => {
    if (base !== 'BYN') {
      throw new Error('Источник НБРБ работает только с базовой валютой BYN');
    }
    const out: Record<string, number> = { BYN: 1 };
    for (const code of currencies) {
      if (code === 'BYN') continue;
      const res = await fetch(
        `https://api.nbrb.by/exrates/rates/${code}?parammode=2&ondate=${date}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      // Валюты, которых у НБРБ нет, просто пропускаем.
      if (!res.ok) continue;
      out[code] = parseNbrbResponse(await res.json() as NbrbRate);
    }
    return out;
  };
}

// ---------------------------------------------------------------------

export function pickFetcher(source: string | undefined, currencies: string[]): RatesFetcher {
  return source === 'nbrb' ? createNbrbFetcher(currencies) : fetchRatesFromErApi;
}

/**
 * Курс валюты к базовой в хранимом виде (× 1e8).
 *
 * Порядок поиска: точная дата в кеше → загрузка из сети → ближайшая
 * известная дата. Последний шаг нужен, потому что бесплатные источники
 * отдают только текущие курсы: для операции задним числом берётся
 * ближайший известный, а не выдуманный.
 */
export async function getRate(
  db: Db,
  currency: Currency,
  date: IsoDate,
  fetcher?: RatesFetcher,
): Promise<number> {
  const source = fetcher ?? defaultFetcher ?? fetchRatesFromErApi;
  if (currency === baseCurrency) return rateToStored(1);

  const cached = db.prepare(
    'SELECT rate FROM fx_rates WHERE date = ? AND base = ? AND quote = ?',
  ).get(date, baseCurrency, currency) as { rate: number } | undefined;
  if (cached) return cached.rate;

  // Сеть за пределами транзакции: при ошибке в кеш не попадает ничего,
  // иначе неверный курс закрепился бы навсегда.
  let rates: Record<string, number> | null = null;
  try {
    rates = await source(baseCurrency, date);
  } catch (err) {
    const nearest = db.prepare(`
      SELECT rate FROM fx_rates
      WHERE base = ? AND quote = ?
      ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1
    `).get(baseCurrency, currency, date) as { rate: number } | undefined;

    if (nearest) return nearest.rate;
    throw new Error(`Не удалось получить курс ${currency}: ${(err as Error).message}`);
  }

  // Одним запросом приходят все валюты — сохраняем сразу, чтобы
  // следующая операция в другой валюте не ходила в сеть повторно.
  const insert = db.prepare(
    'INSERT OR REPLACE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)',
  );
  db.transaction(() => {
    for (const [code, rate] of Object.entries(rates!)) {
      if (rate > 0) insert.run(date, baseCurrency, code, rateToStored(rate));
    }
  })();

  const found = rates[currency];
  if (found === undefined) {
    throw new Error(`Источник курсов не знает валюту ${currency}`);
  }
  return rateToStored(found);
}
