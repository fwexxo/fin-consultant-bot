import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Currency } from '../config.ts';
import type { IsoDate } from '../core/dates.ts';

const CURRENCIES: readonly string[] = ['RUB', 'BYN', 'USD'];
const DIRECTIONS: readonly string[] = ['expense', 'income'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ParsedTx {
  amount: number;
  currency: Currency;
  category: string | null;
  date: IsoDate;
  direction: 'expense' | 'income';
  note: string | null;
  confidence: 'high' | 'low';
}

export interface ParseContext {
  today: IsoDate;
  categories: string[];
  defaultCurrency: Currency;
}

/** Достаёт JSON-объект из ответа, даже если он обёрнут в markdown. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`В ответе нет JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Проверка ответа модели. Чистая функция без сети — именно здесь
 * ловятся выдуманные валюты, отрицательные суммы и даты из будущего,
 * поэтому она тестируется изолированно от Claude.
 */
export function validateParsed(raw: unknown, today: IsoDate): ParsedTx {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Разбор не дал объекта');
  }
  const o = raw as Record<string, unknown>;

  const amount = typeof o.amount === 'number' ? o.amount : Number(o.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Некорректная сумма: ${String(o.amount)}`);
  }

  const currency = String(o.currency ?? '').toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    throw new Error(`Неподдерживаемая валюта: ${String(o.currency)}`);
  }

  const direction = String(o.direction ?? 'expense');
  if (!DIRECTIONS.includes(direction)) {
    throw new Error(`Неизвестное направление: ${String(o.direction)}`);
  }

  // Нераспознанная дата — не повод падать: сегодняшняя почти всегда верна.
  const date = typeof o.date === 'string' && ISO_DATE_RE.test(o.date) ? o.date : today;
  if (date > today) {
    throw new Error(`Дата из будущего: ${date}`);
  }

  return {
    amount,
    currency: currency as Currency,
    category: typeof o.category === 'string' && o.category ? o.category : null,
    date,
    direction: direction as 'expense' | 'income',
    note: typeof o.note === 'string' && o.note ? o.note : null,
    confidence: o.confidence === 'low' ? 'low' : 'high',
  };
}

const SYSTEM_PROMPT = `Ты разбираешь короткие записи о личных тратах и доходах на русском языке.

Верни СТРОГО один JSON-объект без пояснений:
{"amount": число, "currency": "RUB"|"BYN"|"USD", "category": строка|null,
 "date": "YYYY-MM-DD", "direction": "expense"|"income", "note": строка|null,
 "confidence": "high"|"low"}

Правила:
- amount — положительное число в основных единицах (5.50, а не 550).
- Валюта из текста: "руб","р","rub","рублей" → RUB; "бр","byn","бел" → BYN;
  "$","usd","бакс","долларов" → USD. Не указана — бери валюту по умолчанию.
- category выбирай ТОЛЬКО из списка в контексте. Ничего не подходит — null.
- date: "вчера", "позавчера", "5 августа" переводи в YYYY-MM-DD относительно
  сегодняшней даты. Не указана — сегодняшняя.
- direction: "получил", "зарплата", "зп", "пришло", "аванс" → income;
  во всех прочих случаях expense.
- confidence ставь "low", если сумма, валюта или смысл записи неоднозначны.`;

export async function parseTransaction(
  text: string,
  ctx: ParseContext,
): Promise<ParsedTx> {
  const prompt = [
    `Сегодня: ${ctx.today}`,
    `Валюта по умолчанию: ${ctx.defaultCurrency}`,
    `Доступные категории: ${ctx.categories.join(', ')}`,
    '',
    `Запись: ${text}`,
  ].join('\n');

  let output = '';
  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      // Разбор текста не требует инструментов. Пустой список надёжнее
      // любого режима разрешений: разрешать попросту нечего.
      allowedTools: [],
      maxTurns: 1,
    },
  })) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') output += block.text;
      }
    }
  }

  return validateParsed(extractJson(output), ctx.today);
}
