import type { Currency } from '../config.ts';

/**
 * Сколько минорных единиц в одной основной.
 *
 * «Сто копеек в рубле» верно не везде: у иены и воны дробной части нет
 * вовсе, у кувейтского динара их тысяча. Ошибка здесь означает сумму,
 * завышенную или заниженную в сто раз.
 *
 * Встроенный список — запасной вариант; в рабочем режиме он заменяется
 * данными из таблицы currencies, чтобы человек мог добавить свою валюту
 * без правки исходников.
 */
const BUILT_IN: Record<string, number> = {
  USD: 2, EUR: 2, RUB: 2, BYN: 2, GBP: 2, CHF: 2, PLN: 2, CZK: 2,
  UAH: 2, KZT: 2, GEL: 2, AMD: 2, AZN: 2, TRY: 2, RSD: 2, CNY: 2,
  INR: 2, AED: 2, THB: 2, CAD: 2, AUD: 2, SEK: 2, NOK: 2, ILS: 2,
  JPY: 0, KRW: 0, HUF: 0, CLP: 0, ISK: 0, VND: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3,
};

let registry = new Map<string, number>(Object.entries(BUILT_IN));

/** Заполняет список валют из базы. Вызывается после миграций. */
export function loadCurrencies(rows: { code: string; minor_units: number }[]): void {
  if (rows.length === 0) return;
  registry = new Map(rows.map((r) => [r.code, r.minor_units]));
}

export function knownCurrencies(): string[] {
  return [...registry.keys()].sort();
}

export function isKnownCurrency(code: string): boolean {
  return registry.has(code);
}

/**
 * Число минорных единиц валюты.
 *
 * Неизвестная валюта — это ошибка, а не повод подставить двойку:
 * молча посчитать иену как рубль значит завысить сумму в сто раз.
 */
export function minorUnits(currency: Currency): number {
  const units = registry.get(currency);
  if (units === undefined) {
    throw new Error(`Неизвестная валюта: ${currency}`);
  }
  return units;
}

/** Курс хранится целым числом = курс × RATE_SCALE. */
export const RATE_SCALE = 100_000_000;

/**
 * Переводит сумму в минорные единицы.
 *
 * toFixed перед округлением не косметика: 19.99 * 100 в двоичном float
 * равно 1998.9999999999998. Двоичный шум срезается до начала округления,
 * иначе он накапливается в последующих операциях.
 */
export function toMinor(amount: number, currency: Currency): number {
  const factor = 10 ** minorUnits(currency);
  return Math.round(Number((amount * factor).toFixed(4)));
}

export function fromMinor(minor: number, currency: Currency): number {
  return minor / 10 ** minorUnits(currency);
}

export function rateToStored(rate: number): number {
  return Math.round(Number((rate * RATE_SCALE).toFixed(2)));
}

/**
 * Переводит сумму в минорных единицах по курсу.
 *
 * Умножение идёт в BigInt намеренно: amountMinor × rateStored превышает
 * Number.MAX_SAFE_INTEGER (9.007e15) уже на сумме 10 млн при курсе 3.4,
 * и обычное умножение молча вернуло бы неточный результат.
 */
export function convertMinor(amountMinor: number, rateStored: number): number {
  const product = BigInt(amountMinor) * BigInt(rateStored);
  const scale = BigInt(RATE_SCALE);

  // Деление BigInt усекает к нулю, поэтому округляем к ближайшему
  // вручную и симметрично для отрицательных значений.
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + scale / 2n) / scale;
  const result = negative ? -rounded : rounded;

  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`Результат конвертации вне безопасного диапазона: ${result}`);
  }
  return asNumber;
}

export function formatMoney(minor: number, currency: Currency): string {
  const digits = minorUnits(currency);
  const factor = 10 ** digits;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);

  // У валют без дробной части (иена, вона) дробь не печатаем вовсе.
  if (digits === 0) {
    return `${negative ? '-' : ''}${whole} ${currency}`;
  }

  const frac = String(abs % factor).padStart(digits, '0');
  return `${negative ? '-' : ''}${whole}.${frac} ${currency}`;
}
