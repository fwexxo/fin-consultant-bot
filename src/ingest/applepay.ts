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
  /**
   * Идентификатор запуска, если команда его прислала. Без него защита
   * от повторной доставки строится по содержимому и времени.
   */
  id?: string | null;
  merchant?: string | null;
  amount: string | number;
  currency?: string | null;
  /** ГГГГ-ММ-ДД; если не прислали — берём сегодняшнюю дату. */
  date?: string | null;
}

/** Окно, внутри которого одинаковые оплаты считаем повторной доставкой. */
export const DUPLICATE_WINDOW_SECONDS = 90;

export interface ApplePayResult {
  seen: number;
  skippedDuplicate: number;
  /** Отсеяно по совпадению содержимого — возможно, это была вторая покупка. */
  maybeDuplicate: { merchant: string; amountMinor: number; currency: Currency }[];
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

const SYMBOLS: Record<string, Currency> = {
  'BR': 'BYN', 'BYR': 'BYN', 'Р.': 'RUB', 'Р': 'RUB', '₽': 'RUB', 'RUR': 'RUB',
  '$': 'USD', '€': 'EUR', '£': 'GBP', '₸': 'KZT', '₴': 'UAH', 'ZŁ': 'PLN',
};

/**
 * Код валюты из того, что прислала команда; null — не распознали.
 *
 * Сюда попадает и сама сумма целиком: iOS не отдаёт код валюты отдельным
 * полем, он зашит в отформатированную строку вроде «22,27 Br» или «$9.99».
 * Поэтому ищем валюту в любом месте строки, а не только целиком.
 */
export function parseCurrency(raw: string | null | undefined): Currency | null {
  if (!raw) return null;
  const text = raw.trim().toUpperCase();

  if (/^[A-Z]{3}$/.test(text) && isKnownCurrency(text)) return text;
  if (SYMBOLS[text]) return SYMBOLS[text];

  // Трёхбуквенный код отдельным словом: «22,27 BYN», но не «BRAND».
  const code = /(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/.exec(text);
  if (code && isKnownCurrency(code[1]!)) return code[1]!;

  // Символ где угодно в строке. Длинные обозначения проверяем раньше
  // коротких, иначе «ZŁ» распознается как неизвестная «Z».
  for (const sym of Object.keys(SYMBOLS).sort((a, b) => b.length - a.length)) {
    // Буквенные обозначения ищем только отдельным словом: иначе магазин
    // «BRAND» превратился бы в белорусские рубли из-за «Br» внутри.
    const alphabetic = /^\p{L}+$/u.test(sym);
    const found = alphabetic
      ? new RegExp(`(?:^|[^\\p{L}])${sym}(?:[^\\p{L}]|$)`, 'u').test(text)
      : text.includes(sym);
    if (found) return SYMBOLS[sym]!;
  }
  return null;
}

/**
 * Разбирает то, что присылает быстрая команда с айфона.
 *
 * Формат простой и построчный, а не JSON: название магазина приходит
 * из внешнего мира и вполне может содержать кавычку, которая сломала бы
 * JSON и потеряла бы всю оплату. Ключ отделяется первым двоеточием,
 * поэтому двоеточие внутри названия ничему не мешает.
 *
 * JSON тоже принимаем — им удобно проверять руками.
 */
export function parseEvents(raw: string): ApplePayEvent[] {
  const text = raw.trim();
  if (text === '') return [];

  if (text.startsWith('{') || text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed as ApplePayEvent[] : [parsed as ApplePayEvent];
  }

  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    if (key !== '' && !fields.has(key)) fields.set(key, line.slice(at + 1).trim());
  }

  const amount = fields.get('amount');
  if (amount === undefined) throw new Error('нет строки amount:');

  return [{
    id: fields.get('id') ?? null,
    amount,
    // Валюта отдельным полем приходит редко: обычно она внутри суммы.
    currency: fields.get('currency') ?? amount,
    merchant: fields.get('merchant') || fields.get('name') || null,
    date: fields.get('date') ?? null,
  }];
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
    seen: events.length, skippedDuplicate: 0, maybeDuplicate: [],
    rejected: [], recorded: [], balance: null,
  };

  const account = listAccounts(db).find((a) => a.name === opts.accountName);
  if (!account) throw new Error(`Нет счёта «${opts.accountName}» — сначала создай его`);

  const seenExact = db.prepare(
    'SELECT 1 FROM sms_ingested WHERE source = ? AND source_id = ? LIMIT 1',
  );
  const seenRecent = db.prepare(`
    SELECT 1 FROM sms_ingested
    WHERE source = ? AND source_id = ?
      AND ingested_at > datetime('now', ?)
    LIMIT 1
  `);
  const markIngested = db.prepare(
    'INSERT INTO sms_ingested (source, source_id, tx_id, raw) VALUES (?,?,?,?)',
  );

  for (const ev of events) {
    const raw = JSON.stringify(ev);

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

    // Своего идентификатора у оплаты Apple Pay нет: iOS его не даёт.
    // Поэтому от повторной доставки защищаемся по содержимому, но только
    // в пределах короткого окна — две одинаковые покупки в разное время
    // это две покупки, и терять вторую нельзя.
    const explicit = (ev.id ?? '').trim();
    const sourceId = explicit || `${date}|${amountMinor}|${account.currency}|${merchant}`;

    const seen = explicit
      ? seenExact.get('applepay', sourceId)
      : seenRecent.get('applepay', sourceId, `-${DUPLICATE_WINDOW_SECONDS} seconds`);

    if (seen) {
      result.skippedDuplicate += 1;
      // Не молчим: если это была вторая одинаковая покупка подряд,
      // человек должен узнать, что её не записали.
      if (!explicit) result.maybeDuplicate.push({ merchant, amountMinor, currency: account.currency });
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
    markIngested.run('applepay', sourceId, txId, raw);

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
  if (r.recorded.length === 0 && r.maybeDuplicate.length === 0) return null;

  if (r.recorded.length === 0) {
    return `Не записал — выглядит как повтор только что записанной оплаты:\n${r.maybeDuplicate
      .map((d) => `  ${formatMoney(d.amountMinor, d.currency)} — ${d.merchant}`)
      .join('\n')}\nЕсли это была вторая такая же покупка, скажи — запишу.`;
  }

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
