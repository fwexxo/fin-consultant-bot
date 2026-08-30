import type { Db } from '../db/index.ts';
import type { Currency } from '../config.ts';
import type { IsoDate } from '../core/dates.ts';
import { toMinor, formatMoney, convertMinor, RATE_SCALE, isKnownCurrency } from '../core/money.ts';
import { listAccounts, accountBalance } from '../core/accounts.ts';
import { recordTransaction } from '../core/transactions.ts';
import { getRate, type RatesFetcher } from '../core/fx.ts';

/**
 * Одна оплата Apple Pay, как её отдаёт быстрая команда на айфоне.
 *
 * Все поля приходят строками: iOS отдаёт сумму в человеческом виде
 * («Br 22,27»), а не числом. Разбираем на сервере, а не в команде —
 * там такой разбор не написать и, главное, нечем проверить.
 */
export interface ApplePayEvent {
  /** UUID, который команда генерирует на каждый запуск: защита от повторной доставки. */
  id: string;
  merchant?: string | null;
  amount: string | number;
  currency?: string | null;
  /** ГГГГ-ММ-ДД; если не прислали — берём сегодняшнюю дату. */
  date?: string | null;
}

export interface ApplePayResult {
  seen: number;
  skippedDuplicate: number;
  rejected: { raw: string; reason: string }[];
  recorded: {
    merchant: string;
    amountMinor: number;
    currency: Currency;
    original?: { amount: number; currency: Currency };
  }[];
  balance: { name: string; minor: number; currency: Currency } | null;
}

/**
 * Превращает сумму из уведомления в число.
 *
 * Сюда прилетает что угодно: «Br 22,27», «1 234,56 BYN», «$1,234.56»,
 * неразрывные пробелы, юникодные минусы. Ошибиться здесь — значит
 * записать не ту сумму денег, поэтому всё сомнительное отвергаем,
 * а не угадываем.
 */
export function parseAmount(raw: string | number): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error('сумма не число');
    return Math.abs(raw);
  }

  // Юникодные минусы и пробелы приводим к обычным, иначе они уцелеют
  // в чистке и превратятся в мусор.
  const text = raw
    .replace(/[‐-―−]/g, '-')
    .replace(/[   ]/g, ' ');

  const digits = text.replace(/[^\d.,]/g, '');
  if (digits === '') throw new Error(`не вижу цифр в «${raw}»`);

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  const sep = Math.max(lastComma, lastDot);

  let normalized: string;
  if (sep === -1) {
    normalized = digits;
  } else {
    const tail = digits.slice(sep + 1);
    // Разделитель дробной части — только если за ним 1-2 цифры и он
    // последний. «1,234» это тысячи, «1,23» это копейки.
    const isDecimal = /^\d{1,2}$/.test(tail);
    normalized = isDecimal
      ? `${digits.slice(0, sep).replace(/[.,]/g, '')}.${tail}`
      : digits.replace(/[.,]/g, '');
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error(`не разобрал сумму «${raw}»`);
  if (value <= 0) throw new Error(`сумма должна быть больше нуля, получено «${raw}»`);
  return value;
}

/** Код валюты из того, что прислала команда; null — не распознали. */
export function parseCurrency(raw: string | null | undefined): Currency | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && isKnownCurrency(code)) return code;

  const SYMBOLS: Record<string, Currency> = {
    'BR': 'BYN', 'BYR': 'BYN', 'Р.': 'RUB', '₽': 'RUB', 'RUR': 'RUB',
    '$': 'USD', '€': 'EUR', '£': 'GBP', '₸': 'KZT', '₴': 'UAH', 'ZŁ': 'PLN',
  };
  return SYMBOLS[code] ?? null;
}

/** Пересчёт между двумя валютами через базовую: обе к базе, потом делим. */
async function toAccountCurrency(
  db: Db, amountMinor: number, from: Currency, to: Currency,
  date: IsoDate, fetcher?: RatesFetcher,
): Promise<number> {
  const fromRate = await getRate(db, from, date, fetcher);
  const toRate = await getRate(db, to, date, fetcher);
  if (toRate <= 0) throw new Error(`нет курса для ${to}`);

  const inBase = convertMinor(amountMinor, fromRate);
  // Обратный ход: делим на курс счёта, то есть умножаем на обратный.
  return convertMinor(inBase, Math.round((RATE_SCALE / toRate) * RATE_SCALE));
}

export interface ApplePayOptions {
  accountName: string;
  today: IsoDate;
  rateFetcher?: RatesFetcher;
}

/**
 * Записывает оплаты Apple Pay на указанный счёт.
 *
 * Повторную доставку одного и того же запуска команды отсекаем по её
 * UUID: две одинаковые покупки подряд — это две разные записи, а вот
 * дважды доехавшая одна покупка деньги бы удвоила.
 */
export async function ingestApplePay(
  db: Db, events: ApplePayEvent[], opts: ApplePayOptions,
): Promise<ApplePayResult> {
  const result: ApplePayResult = {
    seen: events.length, skippedDuplicate: 0, rejected: [], recorded: [], balance: null,
  };

  const account = listAccounts(db).find((a) => a.name === opts.accountName);
  if (!account) throw new Error(`Нет счёта «${opts.accountName}» — сначала создай его`);

  const seenBefore = db.prepare(
    'SELECT 1 FROM sms_ingested WHERE source = ? AND source_id = ? LIMIT 1',
  );
  const markIngested = db.prepare(
    'INSERT INTO sms_ingested (source, source_id, tx_id, raw) VALUES (?,?,?,?)',
  );

  for (const ev of events) {
    const raw = JSON.stringify(ev);

    if (!ev.id || typeof ev.id !== 'string') {
      result.rejected.push({ raw, reason: 'нет идентификатора запуска' });
      continue;
    }
    if (seenBefore.get('applepay', ev.id)) {
      result.skippedDuplicate += 1;
      continue;
    }

    let amount: number;
    try {
      amount = parseAmount(ev.amount);
    } catch (err) {
      result.rejected.push({ raw, reason: (err as Error).message });
      continue;
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(ev.date ?? '') ? ev.date! : opts.today;
    const merchant = (ev.merchant ?? '').trim() || 'оплата Apple Pay';
    const from = parseCurrency(ev.currency) ?? account.currency;

    let amountMinor = toMinor(amount, from);
    let original: { amount: number; currency: Currency } | undefined;

    // Покупка в чужой валюте: банк спишет со счёта своё, мы пересчитываем
    // по своему курсу и честно оставляем исходную сумму в примечании —
    // иначе 22.27 USD легли бы на счёт как 22.27 BYN.
    if (from !== account.currency) {
      try {
        amountMinor = await toAccountCurrency(
          db, amountMinor, from, account.currency, date, opts.rateFetcher,
        );
        original = { amount, currency: from };
      } catch (err) {
        result.rejected.push({ raw, reason: `не пересчитал ${from}: ${(err as Error).message}` });
        continue;
      }
    }

    if (amountMinor <= 0) {
      result.rejected.push({ raw, reason: 'после пересчёта сумма обнулилась' });
      continue;
    }

    const note = original
      ? `${merchant} (${original.amount} ${original.currency} по нашему курсу)`
      : merchant;

    const txId = await recordTransaction(db, {
      accountId: account.id, direction: 'expense', amountMinor,
      ts: date, note, rawText: raw,
      rateFetcher: opts.rateFetcher,
    });
    markIngested.run('applepay', ev.id, txId, raw);

    result.recorded.push({ merchant, amountMinor, currency: account.currency, original });
  }

  if (result.recorded.length > 0) {
    result.balance = {
      name: account.name, minor: accountBalance(db, account.id), currency: account.currency,
    };
  }
  return result;
}

/** Сводка для Телеграма; null — говорить не о чем. */
export function formatApplePaySummary(r: ApplePayResult): string | null {
  if (r.recorded.length === 0) return null;

  const lines = r.recorded.map((op) => {
    const orig = op.original ? ` (${op.original.amount} ${op.original.currency})` : '';
    return `  −${formatMoney(op.amountMinor, op.currency)}${orig} — ${op.merchant}`;
  });

  let text = `Apple Pay:\n${lines.join('\n')}`;
  if (r.balance) {
    text += `\n\nОстаток «${r.balance.name}»: ${formatMoney(r.balance.minor, r.balance.currency)}`;
  }
  return text;
}
