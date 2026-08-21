/**
 * Разбор СМС от банка (номер 900).
 *
 * Формат жёсткий, поэтому здесь регулярные выражения, а не модель:
 * они быстрее, бесплатны, воспроизводимы и полностью покрыты тестами.
 * Незнакомую форму парсер отвергает — записать наугад хуже, чем пропустить.
 */

export type SmsKind = 'expense' | 'income' | 'cash_withdrawal' | 'cash_deposit';

export interface ParsedSms {
  card: string;
  time: string;                 // HH:MM
  /** Дата из самого СМС (YYYY-MM-DD), если банк её указал. */
  date?: string;
  kind: SmsKind;
  amountRub: number;            // сколько реально ушло со счёта или пришло на него
  original?: { amount: number; currency: string };  // если операция была в другой валюте
  merchant: string | null;
  balanceRub: number;           // остаток по версии банка
}

/** Банк разделяет тысячи неразрывным пробелом — parseFloat на нём споткнётся. */
function toNumber(raw: string): number {
  return Number(raw.replace(/[\s ]/g, '').replace(',', '.'));
}

/** «11.05.26» → «2026-05-11». Банк шлёт двузначный год. */
function toIsoDate(dotted: string): string | undefined {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(dotted);
  if (!m) return undefined;
  return `20${m[3]}-${m[2]}-${m[1]}`;
}

// Дата перед временем появляется у отложенных уведомлений и не обязательна.
const HEAD = /^Счёт карты (\S+)\s+(?:(\d{2}\.\d{2}\.\d{2})\s+)?(\d{2}:\d{2})\s+(.+)$/;
const BALANCE = /\s+Баланс:\s*([\d\s .,]+?)р\.?\s*$/;

// «покупка с выдачей» — одно СМС на две операции: покупка плюс наличные.
const PURCHASE_WITH_CASH =
  /^покупка\s+с\s+выдачей\s+[\d\s .,]+?р\s+(.*?)\s+покупка\s+([\d\s .,]+?)р\s+выдача\s+([\d\s .,]+?)р$/i;

// Порядок важен: «возврат покупки» и «Отмена покупки» проверяются раньше
// «Покупка», иначе возврат уедет в расходы.
const KINDS: { re: RegExp; kind: SmsKind }[] = [
  { re: /^возврат\s+покупки(\s+по\s+СБП)?\s+/i, kind: 'income' },
  { re: /^отмена\s+покупки(\s+по\s+СБП)?\s+/i, kind: 'income' },
  { re: /^выдача\s+/i, kind: 'cash_withdrawal' },
  { re: /^зачисление\s+/i, kind: 'cash_deposit' },
  { re: /^покупка(\s+по\s+СБП)?\s+/i, kind: 'expense' },
  { re: /^оплата(\s+по\s+СБП)?\s+/i, kind: 'expense' },
];

// «14BYN (399.12р)» — операция в валюте со списанием в рублях.
const FOREIGN = /^([\d\s .,]+?)([A-Z]{3})\s*\(\s*([\d\s .,]+?)р\s*\)\s*(.*)$/;
// «406р МАГАЗИН» — обычная рублёвая операция.
const RUBLES = /^([\d\s .,]+?)р\s*(.*)$/;

/**
 * Разбирает СМС в список операций.
 *
 * Пустой массив означает «это не операция по нужной карте»: чужой счёт,
 * код подтверждения, реклама или незнакомая форма. Массив из двух элементов
 * возвращается для покупки с выдачей наличных — это действительно две
 * разные операции, склеенные банком в одно сообщение.
 */
export function parseSms(text: string, card: string): ParsedSms[] {
  const head = HEAD.exec(text.trim());
  if (!head) return [];

  const [, cardId, dotted, time, tail] = head;
  if (cardId !== card) return [];

  // Без баланса сообщение бесполезно: не с чем сверяться.
  const bal = BALANCE.exec(tail!);
  if (!bal) return [];
  const balanceRub = toNumber(bal[1]!);
  if (!Number.isFinite(balanceRub)) return [];

  const body = tail!.slice(0, bal.index).trim();
  const date = dotted ? toIsoDate(dotted) : undefined;
  const base = { card: cardId!, time: time!, date, balanceRub };

  const combo = PURCHASE_WITH_CASH.exec(body);
  if (combo) {
    const merchant = combo[1]!.trim() || null;
    const purchase = toNumber(combo[2]!);
    const cash = toNumber(combo[3]!);
    if (!Number.isFinite(purchase) || !Number.isFinite(cash)) return [];

    const out: ParsedSms[] = [];
    if (purchase > 0) {
      out.push({ ...base, kind: 'expense', amountRub: purchase, merchant });
    }
    if (cash > 0) {
      out.push({ ...base, kind: 'cash_withdrawal', amountRub: cash, merchant });
    }
    return out;
  }

  const matched = KINDS.find((k) => k.re.test(body));
  if (!matched) return [];

  const rest = body.replace(matched.re, '').trim();

  let amountRub: number;
  let original: { amount: number; currency: string } | undefined;
  let merchant: string;

  const foreign = FOREIGN.exec(rest);
  if (foreign) {
    // Списывается рублёвая сумма — она и есть движение по счёту.
    // Исходная валюта сохраняется справочно.
    original = { amount: toNumber(foreign[1]!), currency: foreign[2]! };
    amountRub = toNumber(foreign[3]!);
    merchant = foreign[4]!.trim();
  } else {
    const rub = RUBLES.exec(rest);
    if (!rub) return [];
    amountRub = toNumber(rub[1]!);
    merchant = rub[2]!.trim();
  }

  if (!Number.isFinite(amountRub) || amountRub <= 0) return [];

  return [{
    ...base,
    kind: matched.kind,
    amountRub,
    original,
    merchant: merchant || null,
  }];
}
