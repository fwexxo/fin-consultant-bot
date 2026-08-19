import type { Currency } from '../config.ts';

/** Минорных единиц в одной основной. У всех трёх валют — 100. */
export const MINOR_UNITS: Record<Currency, number> = {
  RUB: 100,
  BYN: 100,
  USD: 100,
};

/** Курс хранится целым числом = курс × RATE_SCALE. */
export const RATE_SCALE = 100_000_000;

/**
 * Переводит сумму в минорные единицы.
 *
 * toFixed перед округлением не косметика: 19.99 * 100 в двоичном float
 * равно 1998.9999999999998, и Math.round дал бы 1999 верно, а 0.29 * 100
 * = 28.999999999999996 — тоже. Но накопление таких ошибок в других
 * операциях делает результат непредсказуемым, поэтому двоичный шум
 * срезается до начала округления.
 */
export function toMinor(amount: number, currency: Currency): number {
  const factor = MINOR_UNITS[currency];
  return Math.round(Number((amount * factor).toFixed(4)));
}

export function fromMinor(minor: number, currency: Currency): number {
  return minor / MINOR_UNITS[currency];
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
  const factor = MINOR_UNITS[currency];
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac} ${currency}`;
}
