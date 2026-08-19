export type Period = string;   // YYYY-MM
export type IsoDate = string;  // YYYY-MM-DD

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

/**
 * Длина месяца. month задаётся 1-12, как в человеческой записи,
 * а не 0-11, как в Date.
 */
export function lastDayOfMonth(year: number, month: number): number {
  // День 0 следующего месяца — это последний день текущего.
  // Date.UTC убирает влияние локального часового пояса: без него
  // машина в UTC+3 могла бы получить предыдущие сутки.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parsePeriod(period: Period): { year: number; month: number } {
  const m = PERIOD_RE.exec(period);
  if (!m) {
    throw new Error(`Некорректный период "${period}", ожидается YYYY-MM`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Некорректный период "${period}": месяц вне 01-12`);
  }
  return { year, month };
}

/**
 * Дата платежа за конкретный месяц.
 *
 * Два способа задать срок, потому что «последнее число» — это 28, 29, 30
 * или 31 в зависимости от месяца, и одним числом это не выражается.
 */
export function dueDateFor(
  period: Period,
  dayOfMonth: number | null,
  isLastDay: boolean,
): IsoDate {
  const { year, month } = parsePeriod(period);
  const last = lastDayOfMonth(year, month);

  let day: number;
  if (isLastDay) {
    day = last;
  } else {
    if (dayOfMonth === null) {
      throw new Error('Нужен day_of_month либо is_last_day=true');
    }
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error(`day_of_month вне 1-31: ${dayOfMonth}`);
    }
    // Обрезаем по длине месяца: правило «31-го» в феврале — это 28-е,
    // а не 3 марта.
    day = Math.min(dayOfMonth, last);
  }

  return `${period}-${String(day).padStart(2, '0')}`;
}

export function currentPeriod(now: Date): Period {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function addDays(isoDate: IsoDate, days: number): IsoDate {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Некорректная дата "${isoDate}"`);
  }
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
