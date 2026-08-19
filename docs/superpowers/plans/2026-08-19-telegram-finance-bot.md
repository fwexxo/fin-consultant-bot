# Телеграм-бот «Финансовый консультант» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Персональный телеграм-бот, который ведёт мини-бухгалтерию в RUB/BYN/USD, напоминает о регулярных платежах и отвечает на вопросы по собственным финансам владельца.

**Architecture:** Три слоя с жёсткой границей. Слой учёта — чистый TypeScript + SQLite, детерминированный и полностью тестируемый без сети. Слой разбора — Claude превращает свободный текст в структурированную запись. Слой консультанта — Claude отвечает на открытые вопросы, читая базу через SQL-инструмент. Слой учёта не знает о существовании Claude.

**Tech Stack:** Node 22 · TypeScript · better-sqlite3 · grammY · node-cron · `@anthropic-ai/claude-agent-sdk` · тесты на `node:test` через `tsx`.

## Global Constraints

- Node.js 22 (на маке и на VPS — v22.23.2). Не использовать API новее Node 22.
- Все денежные суммы — `INTEGER` в минорных единицах (копейках). Float для денег запрещён.
- Базовая валюта — `BYN`. Поддерживаемые валюты — ровно `RUB`, `BYN`, `USD`.
- Курсы валют — только API Нацбанка РБ (`https://api.nbrb.by`). Обязательно делить `Cur_OfficialRate` на `Cur_Scale`: для RUB масштаб равен 100.
- Курс хранится как `INTEGER` = курс × 1e8. Умножение суммы на курс — только через `BigInt`, иначе переполнение `Number.MAX_SAFE_INTEGER`.
- Доступ к боту — строго по числовому `OWNER_ID`. Whitelist по username запрещён.
- Секреты только в `.env` (в `.gitignore`). Ни один секрет не попадает в репозиторий, логи или сообщения бота.
- Часовой пояс расчётов — `Europe/Minsk`.
- Персональные инвестиционные рекомендации не реализуются.
- Коммиты частые, по одному на задачу.

## Файловая структура

| Файл | Ответственность |
|---|---|
| `src/config.ts` | Чтение и валидация `.env`, единственная точка доступа к настройкам |
| `src/core/money.ts` | Минорные единицы, конвертация по курсу, форматирование |
| `src/core/dates.ts` | Вычисление даты платежа (`day_of_month` / `is_last_day`), границы периодов |
| `src/db/index.ts` | Открытие БД, WAL, `foreign_keys` |
| `src/db/migrations.ts` | Раннер миграций с версионированием |
| `src/db/migrations/001_initial.sql` | Начальная схема |
| `src/core/accounts.ts` | Счета и балансы |
| `src/core/transactions.ts` | Запись транзакций и переводов |
| `src/core/fx.ts` | Загрузка и кеш курсов НБРБ |
| `src/core/recurring.ts` | Правила регулярных платежей, генерация инстансов |
| `src/core/reports.ts` | Отчёты и прогноз |
| `src/claude/queue.ts` | Очередь вызовов Claude с конкурентностью 1 |
| `src/claude/parse.ts` | Разбор свободного текста в транзакцию |
| `src/claude/consult.ts` | Консультант с read-only SQL |
| `src/bot/index.ts` | grammY, whitelist, роутинг |
| `src/bot/confirm.ts` | Карточка подтверждения транзакции |
| `src/jobs/reminders.ts` | Ежедневная проверка платежей |
| `src/index.ts` | Точка входа: миграции → бот → cron |

---

### Task 1: Каркас проекта и конфигурация

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`, тип `Config` с полями `botToken: string`, `ownerId: number | null`, `baseCurrency: 'BYN'`, `databasePath: string`, `reminderHour: number`, `timezone: string`

- [ ] **Step 1: Создать package.json**

```json
{
  "name": "fin-consultant-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "migrate": "tsx src/db/migrate-cli.ts",
    "test": "node --import tsx --test \"tests/**/*.test.ts\""
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "better-sqlite3": "^11.5.0",
    "dotenv": "^16.4.5",
    "grammy": "^1.30.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.9.0",
    "@types/node-cron": "^3.0.11",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Создать tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Установить зависимости**

Run: `npm install`
Expected: `node_modules/` создан, ошибок сборки `better-sqlite3` нет.

Если `better-sqlite3` не собирается — установить инструменты сборки:
`sudo apt-get install -y build-essential python3` (на VPS), на маке — Xcode CLT.

- [ ] **Step 4: Написать падающий тест конфигурации**

Файл `tests/config.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig читает корректное окружение', () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: 'abc',
    OWNER_ID: '12345',
    BASE_CURRENCY: 'BYN',
    DATABASE_PATH: './data/x.db',
    REMINDER_HOUR: '10',
    TZ: 'Europe/Minsk',
  } as NodeJS.ProcessEnv);

  assert.equal(cfg.botToken, 'abc');
  assert.equal(cfg.ownerId, 12345);
  assert.equal(cfg.reminderHour, 10);
});

test('пустой OWNER_ID даёт null, а не падение', () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: 'abc',
    OWNER_ID: '',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.ownerId, null);
});

test('отсутствие токена — фатальная ошибка', () => {
  assert.throws(
    () => loadConfig({} as NodeJS.ProcessEnv),
    /TELEGRAM_BOT_TOKEN/,
  );
});

test('REMINDER_HOUR вне 0-23 отвергается', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: 'a', REMINDER_HOUR: '99' } as NodeJS.ProcessEnv),
    /REMINDER_HOUR/,
  );
});
```

- [ ] **Step 5: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — модуль `../src/config.ts` не найден.

- [ ] **Step 6: Реализовать config.ts**

Файл `src/config.ts`:

```typescript
export type Currency = 'RUB' | 'BYN' | 'USD';

export interface Config {
  botToken: string;
  ownerId: number | null;
  baseCurrency: Currency;
  databasePath: string;
  reminderHour: number;
  timezone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан — бот не может стартовать');
  }

  const rawOwner = env.OWNER_ID?.trim();
  let ownerId: number | null = null;
  if (rawOwner) {
    const parsed = Number(rawOwner);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`OWNER_ID должен быть положительным целым, получено: ${rawOwner}`);
    }
    ownerId = parsed;
  }

  const reminderHour = Number(env.REMINDER_HOUR?.trim() || '10');
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) {
    throw new Error(`REMINDER_HOUR должен быть целым 0-23, получено: ${env.REMINDER_HOUR}`);
  }

  return {
    botToken,
    ownerId,
    baseCurrency: 'BYN',
    databasePath: env.DATABASE_PATH?.trim() || './data/finance.db',
    reminderHour,
    timezone: env.TZ?.trim() || 'Europe/Minsk',
  };
}
```

- [ ] **Step 7: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS, 4 теста.

- [ ] **Step 8: Коммит**

```bash
git add package.json package-lock.json tsconfig.json src/config.ts tests/config.test.ts
git commit -m "Каркас проекта и валидация конфигурации"
```

---

### Task 2: Деньги — минорные единицы и конвертация

**Files:**
- Create: `src/core/money.ts`
- Test: `tests/core/money.test.ts`

**Interfaces:**
- Consumes: тип `Currency` из `src/config.ts`
- Produces:
  - `MINOR_UNITS: Record<Currency, number>` — множитель минорных единиц (везде 100)
  - `RATE_SCALE: 100_000_000` — масштаб хранения курса
  - `toMinor(amount: number, currency: Currency): number`
  - `fromMinor(minor: number, currency: Currency): number`
  - `rateToStored(rate: number): number`
  - `convertMinor(amountMinor: number, rateStored: number): number`
  - `formatMoney(minor: number, currency: Currency): string`

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/money.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor, fromMinor, rateToStored, convertMinor, formatMoney, RATE_SCALE,
} from '../../src/core/money.ts';

test('toMinor переводит в копейки без потери точности', () => {
  assert.equal(toMinor(5, 'RUB'), 500);
  assert.equal(toMinor(30.45, 'BYN'), 3045);
  assert.equal(toMinor(0.01, 'USD'), 1);
});

test('toMinor корректно округляет проблемные для float значения', () => {
  // 19.99 * 100 в float даёт 1998.9999999999998
  assert.equal(toMinor(19.99, 'BYN'), 1999);
  assert.equal(toMinor(1.005, 'USD'), 101);
});

test('fromMinor обратен toMinor', () => {
  assert.equal(fromMinor(3045, 'BYN'), 30.45);
});

test('rateToStored хранит курс целым числом', () => {
  assert.equal(rateToStored(3.4), 340_000_000);
  assert.equal(RATE_SCALE, 100_000_000);
});

test('convertMinor умножает сумму на курс', () => {
  // 100.00 RUB при курсе 0.035 BYN за рубль = 3.50 BYN
  const rate = rateToStored(0.035);
  assert.equal(convertMinor(10_000, rate), 350);
});

test('convertMinor не переполняется на больших суммах', () => {
  // 10 млн рублей в копейках × курс 3.4 — произведение > Number.MAX_SAFE_INTEGER
  const rate = rateToStored(3.4);
  const result = convertMinor(1_000_000_000, rate);
  assert.equal(result, 3_400_000_000);
  assert.ok(Number.isSafeInteger(result));
});

test('convertMinor округляет к ближайшему, а не отбрасывает', () => {
  const rate = rateToStored(0.333333);
  // 100 копеек × 0.333333 = 33.3333 → 33
  assert.equal(convertMinor(100, rate), 33);
  // 1000 копеек × 0.333333 = 333.333 → 333
  assert.equal(convertMinor(1000, rate), 333);
});

test('convertMinor корректен для отрицательных сумм', () => {
  const rate = rateToStored(2);
  assert.equal(convertMinor(-150, rate), -300);
});

test('formatMoney выводит человекочитаемо', () => {
  assert.equal(formatMoney(3045, 'BYN'), '30.45 BYN');
  assert.equal(formatMoney(-500, 'RUB'), '-5.00 RUB');
  assert.equal(formatMoney(0, 'USD'), '0.00 USD');
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/core/money.ts` не существует.

- [ ] **Step 3: Реализовать money.ts**

Файл `src/core/money.ts`:

```typescript
import type { Currency } from '../config.ts';

/** Минорных единиц в одной основной. У всех трёх валют — 100. */
export const MINOR_UNITS: Record<Currency, number> = {
  RUB: 100,
  BYN: 100,
  USD: 100,
};

/** Курс хранится целым числом = курс × RATE_SCALE. */
export const RATE_SCALE = 100_000_000;

export function toMinor(amount: number, currency: Currency): number {
  const factor = MINOR_UNITS[currency];
  // Math.round на произведении float даёт верный результат для сумм
  // реального масштаба; toFixed использован чтобы срезать двоичный шум
  // вида 1998.9999999999998 до начала округления.
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
 * Умножение идёт в BigInt: amountMinor × rateStored легко превышает
 * Number.MAX_SAFE_INTEGER (9.007e15) уже на сумме 10 млн и курсе 3.4.
 */
export function convertMinor(amountMinor: number, rateStored: number): number {
  const product = BigInt(amountMinor) * BigInt(rateStored);
  const scale = BigInt(RATE_SCALE);

  // Деление BigInt отбрасывает дробную часть, поэтому округляем к
  // ближайшему вручную, симметрично для отрицательных значений.
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
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS, все тесты money.

- [ ] **Step 5: Коммит**

```bash
git add src/core/money.ts tests/core/money.test.ts
git commit -m "Работа с деньгами в минорных единицах и конвертация через BigInt"
```

---

### Task 3: Даты платежей

**Files:**
- Create: `src/core/dates.ts`
- Test: `tests/core/dates.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `type Period = string` (формат `YYYY-MM`)
  - `lastDayOfMonth(year: number, month: number): number` — month 1-12
  - `dueDateFor(period: Period, dayOfMonth: number | null, isLastDay: boolean): string` — возвращает `YYYY-MM-DD`
  - `currentPeriod(now: Date): Period`
  - `addDays(isoDate: string, days: number): string`

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/dates.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastDayOfMonth, dueDateFor, currentPeriod, addDays,
} from '../../src/core/dates.ts';

test('lastDayOfMonth знает длину месяцев', () => {
  assert.equal(lastDayOfMonth(2026, 1), 31);
  assert.equal(lastDayOfMonth(2026, 4), 30);
  assert.equal(lastDayOfMonth(2026, 2), 28);
});

test('lastDayOfMonth учитывает високосный год', () => {
  assert.equal(lastDayOfMonth(2024, 2), 29);
  assert.equal(lastDayOfMonth(2000, 2), 29);  // делится на 400
  assert.equal(lastDayOfMonth(1900, 2), 28);  // делится на 100, но не на 400
});

test('dueDateFor для фиксированного числа', () => {
  assert.equal(dueDateFor('2026-08', 15, false), '2026-08-15');
  assert.equal(dueDateFor('2026-01', 15, false), '2026-01-15');
});

test('dueDateFor для последнего числа месяца', () => {
  assert.equal(dueDateFor('2026-08', null, true), '2026-08-31');
  assert.equal(dueDateFor('2026-04', null, true), '2026-04-30');
  assert.equal(dueDateFor('2026-02', null, true), '2026-02-28');
  assert.equal(dueDateFor('2024-02', null, true), '2024-02-29');
});

test('dueDateFor обрезает слишком большое число по длине месяца', () => {
  // правило "31-го" в феврале даёт 28-е, а не 3 марта
  assert.equal(dueDateFor('2026-02', 31, false), '2026-02-28');
  assert.equal(dueDateFor('2026-04', 31, false), '2026-04-30');
});

test('dueDateFor отвергает некорректный период', () => {
  assert.throws(() => dueDateFor('2026-13', 1, false), /период/i);
  assert.throws(() => dueDateFor('август', 1, false), /период/i);
});

test('dueDateFor требует день или флаг последнего числа', () => {
  assert.throws(() => dueDateFor('2026-08', null, false), /day_of_month/);
});

test('currentPeriod форматирует YYYY-MM', () => {
  assert.equal(currentPeriod(new Date('2026-08-19T12:00:00Z')), '2026-08');
  assert.equal(currentPeriod(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('addDays переходит через границу месяца', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-08-15', -3), '2026-08-12');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/core/dates.ts` не существует.

- [ ] **Step 3: Реализовать dates.ts**

Файл `src/core/dates.ts`:

```typescript
export type Period = string;   // YYYY-MM
export type IsoDate = string;  // YYYY-MM-DD

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export function lastDayOfMonth(year: number, month: number): number {
  // Day 0 следующего месяца = последний день текущего.
  // Date.UTC избавляет от влияния локального часового пояса.
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
    if (dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error(`day_of_month вне 1-31: ${dayOfMonth}`);
    }
    // Обрезаем по длине месяца: правило "31-го" в феврале — это 28-е.
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
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/dates.ts tests/core/dates.test.ts
git commit -m "Вычисление дат платежей с поддержкой последнего числа месяца"
```

---

### Task 4: Схема БД и миграции

**Files:**
- Create: `src/db/index.ts`, `src/db/migrations.ts`, `src/db/migrations/001_initial.sql`, `src/db/migrate-cli.ts`
- Test: `tests/db/migrations.test.ts`

**Interfaces:**
- Consumes: `Config` из `src/config.ts`
- Produces:
  - `openDatabase(path: string): Database` (тип `Database` из `better-sqlite3`)
  - `runMigrations(db: Database): number` — возвращает номер применённой версии
  - `MIGRATIONS: { version: number; sql: string }[]`

- [ ] **Step 1: Написать SQL начальной схемы**

Файл `src/db/migrations/001_initial.sql`:

```sql
CREATE TABLE accounts (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  currency    TEXT    NOT NULL CHECK (currency IN ('RUB','BYN','USD')),
  kind        TEXT    NOT NULL CHECK (kind IN ('cash','card','deposit')),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('expense','income')),
  UNIQUE (name, kind)
);

CREATE TABLE transactions (
  id                 INTEGER PRIMARY KEY,
  ts                 TEXT    NOT NULL,          -- YYYY-MM-DD
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  amount_minor       INTEGER NOT NULL,          -- всегда > 0, знак задаёт direction
  currency           TEXT    NOT NULL CHECK (currency IN ('RUB','BYN','USD')),
  category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  direction          TEXT    NOT NULL CHECK (direction IN ('expense','income','transfer')),
  counter_account_id INTEGER REFERENCES accounts(id),
  note               TEXT,
  raw_text           TEXT,
  fx_rate_to_base    INTEGER NOT NULL,          -- курс × 1e8 к BYN
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_minor > 0),
  CHECK (direction <> 'transfer' OR counter_account_id IS NOT NULL),
  CHECK (direction =  'transfer' OR counter_account_id IS NULL)
);

CREATE INDEX idx_tx_ts        ON transactions(ts);
CREATE INDEX idx_tx_account   ON transactions(account_id);
CREATE INDEX idx_tx_category  ON transactions(category_id);

CREATE TABLE recurring_payments (
  id                 INTEGER PRIMARY KEY,
  title              TEXT    NOT NULL,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount_minor       INTEGER,                   -- NULL для плавающих сумм
  currency           TEXT    NOT NULL CHECK (currency IN ('RUB','BYN','USD')),
  day_of_month       INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  is_last_day        INTEGER NOT NULL DEFAULT 0 CHECK (is_last_day IN (0,1)),
  is_variable        INTEGER NOT NULL DEFAULT 0 CHECK (is_variable IN (0,1)),
  remind_days_before INTEGER NOT NULL DEFAULT 3 CHECK (remind_days_before >= 0),
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  -- срок задан ровно одним способом
  CHECK ((day_of_month IS NOT NULL AND is_last_day = 0)
      OR (day_of_month IS NULL     AND is_last_day = 1)),
  -- фиксированная сумма обязана быть указана
  CHECK (is_variable = 1 OR amount_minor IS NOT NULL)
);

CREATE TABLE payment_instances (
  id           INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_payments(id) ON DELETE CASCADE,
  period       TEXT    NOT NULL,                -- YYYY-MM
  due_date     TEXT    NOT NULL,                -- YYYY-MM-DD
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','paid','skipped')),
  paid_tx_id   INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  notified_on  TEXT,                            -- дата последнего напоминания
  UNIQUE (recurring_id, period)
);

CREATE INDEX idx_pi_status_due ON payment_instances(status, due_date);

CREATE TABLE fx_rates (
  date  TEXT    NOT NULL,       -- YYYY-MM-DD
  base  TEXT    NOT NULL,       -- всегда 'BYN'
  quote TEXT    NOT NULL,       -- RUB | USD | BYN
  rate  INTEGER NOT NULL,       -- сколько base за 1 quote, × 1e8
  PRIMARY KEY (date, base, quote)
);

CREATE TABLE budgets (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      TEXT    NOT NULL,
  limit_minor INTEGER NOT NULL CHECK (limit_minor > 0),
  currency    TEXT    NOT NULL CHECK (currency IN ('RUB','BYN','USD')),
  UNIQUE (category_id, period)
);

INSERT INTO categories (name, kind) VALUES
  ('продукты','expense'), ('кафе','expense'), ('транспорт','expense'),
  ('жильё','expense'), ('связь','expense'), ('коммуналка','expense'),
  ('интернет','expense'), ('здоровье','expense'), ('спорт','expense'),
  ('подписки','expense'), ('серверы','expense'), ('одежда','expense'),
  ('развлечения','expense'), ('прочее','expense'),
  ('зарплата','income'), ('фриланс','income'), ('прочее','income');
```

- [ ] **Step 2: Написать падающий тест**

Файл `tests/db/migrations.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

test('миграции создают все таблицы', () => {
  const db = freshDb();
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((r: any) => r.name);

  for (const t of ['accounts','budgets','categories','fx_rates',
                   'payment_instances','recurring_payments',
                   'schema_migrations','transactions']) {
    assert.ok(names.includes(t), `нет таблицы ${t}`);
  }
});

test('миграции идемпотентны', () => {
  const db = openDatabase(':memory:');
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test('foreign_keys включены', () => {
  const db = freshDb();
  const [row] = db.pragma('foreign_keys') as any[];
  assert.equal(row.foreign_keys, 1);
});

test('транзакция-перевод обязана иметь counter_account_id', () => {
  const db = freshDb();
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('нал BYN','BYN','cash')").run();
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,fx_rate_to_base)
      VALUES ('2026-08-19',1,100,'BYN','transfer',100000000)`).run();
  }, /CHECK/);
});

test('расход не может иметь counter_account_id', () => {
  const db = freshDb();
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('нал BYN','BYN','cash')").run();
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('карта','BYN','card')").run();
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,counter_account_id,fx_rate_to_base)
      VALUES ('2026-08-19',1,100,'BYN','expense',2,100000000)`).run();
  }, /CHECK/);
});

test('правило платежа не может задавать срок двумя способами', () => {
  const db = freshDb();
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('нал BYN','BYN','cash')").run();
  assert.throws(() => {
    db.prepare(`INSERT INTO recurring_payments
      (title,account_id,amount_minor,currency,day_of_month,is_last_day)
      VALUES ('интернет',1,3000,'BYN',15,1)`).run();
  }, /CHECK/);
});

test('отрицательная сумма транзакции отвергается', () => {
  const db = freshDb();
  db.prepare("INSERT INTO accounts (name,currency,kind) VALUES ('нал BYN','BYN','cash')").run();
  assert.throws(() => {
    db.prepare(`INSERT INTO transactions
      (ts,account_id,amount_minor,currency,direction,fx_rate_to_base)
      VALUES ('2026-08-19',1,-100,'BYN','expense',100000000)`).run();
  }, /CHECK/);
});

test('базовые категории засеяны', () => {
  const db = freshDb();
  const n = db.prepare("SELECT COUNT(*) c FROM categories").get() as any;
  assert.ok(n.c >= 15);
});
```

- [ ] **Step 3: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — модули `src/db/*` не существуют.

- [ ] **Step 4: Реализовать db/index.ts**

Файл `src/db/index.ts`:

```typescript
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  // WAL даёт конкурентное чтение во время записи — нужно, потому что
  // cron-задача напоминаний и обработчик сообщений работают параллельно.
  db.pragma('journal_mode = WAL');
  // По умолчанию SQLite игнорирует внешние ключи. Без этого CASCADE
  // и ссылочная целостность не работают.
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 5: Реализовать db/migrations.ts**

Файл `src/db/migrations.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS: { version: number; file: string }[] = [
  { version: 1, file: '001_initial.sql' },
];

export function runMigrations(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version),
  );

  let last = Math.max(0, ...applied);

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const sql = readFileSync(join(here, 'migrations', m.file), 'utf8');
    // Каждая миграция применяется атомарно: либо вся, либо никак.
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    })();
    last = m.version;
  }

  return last;
}
```

- [ ] **Step 6: Реализовать migrate-cli.ts**

Файл `src/db/migrate-cli.ts`:

```typescript
import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './index.ts';
import { runMigrations } from './migrations.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
const version = runMigrations(db);
console.log(`Схема БД на версии ${version} (${cfg.databasePath})`);
db.close();
```

- [ ] **Step 7: Убедиться, что SQL копируется в сборку**

`tsc` не копирует `.sql`. Добавить в `package.json` в скрипт `build`:

```json
"build": "tsc && cp -R src/db/migrations dist/db/migrations"
```

- [ ] **Step 8: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS, все тесты миграций.

- [ ] **Step 9: Коммит**

```bash
git add src/db tests/db package.json
git commit -m "Схема БД с ограничениями целостности и раннер миграций"
```

---

### Task 5: Курсы валют НБРБ

**Files:**
- Create: `src/core/fx.ts`
- Test: `tests/core/fx.test.ts`

**Interfaces:**
- Consumes: `Db`, `rateToStored`, `RATE_SCALE`
- Produces:
  - `type RateFetcher = (currency: Currency, date: IsoDate) => Promise<number>`
  - `fetchRateFromNbrb: RateFetcher`
  - `getRate(db: Db, currency: Currency, date: IsoDate, fetcher?: RateFetcher): Promise<number>` — возвращает курс в хранимом виде (× 1e8)

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/fx.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { getRate, parseNbrbResponse } from '../../src/core/fx.ts';
import { rateToStored } from '../../src/core/money.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

test('parseNbrbResponse делит на Cur_Scale', () => {
  // USD: масштаб 1, курс 3.4 → 3.4 BYN за доллар
  assert.equal(
    parseNbrbResponse({ Cur_Scale: 1, Cur_OfficialRate: 3.4 }),
    3.4,
  );
  // RUB: масштаб 100, курс 3.5 → 0.035 BYN за рубль
  assert.equal(
    parseNbrbResponse({ Cur_Scale: 100, Cur_OfficialRate: 3.5 }),
    0.035,
  );
});

test('parseNbrbResponse отвергает мусор', () => {
  assert.throws(() => parseNbrbResponse({ Cur_Scale: 0, Cur_OfficialRate: 1 }), /Cur_Scale/);
  assert.throws(() => parseNbrbResponse({} as any), /НБРБ/);
});

test('курс BYN к BYN равен единице и не ходит в сеть', async () => {
  const db = freshDb();
  let called = false;
  const rate = await getRate(db, 'BYN', '2026-08-19', async () => {
    called = true;
    return 999;
  });
  assert.equal(rate, rateToStored(1));
  assert.equal(called, false);
});

test('курс кешируется — второй вызов не ходит в сеть', async () => {
  const db = freshDb();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 3.4; };

  const a = await getRate(db, 'USD', '2026-08-19', fetcher);
  const b = await getRate(db, 'USD', '2026-08-19', fetcher);

  assert.equal(a, rateToStored(3.4));
  assert.equal(b, rateToStored(3.4));
  assert.equal(calls, 1, 'второй запрос должен браться из кеша');
});

test('разные даты кешируются раздельно', async () => {
  const db = freshDb();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 3.4; };

  await getRate(db, 'USD', '2026-08-19', fetcher);
  await getRate(db, 'USD', '2026-08-20', fetcher);
  assert.equal(calls, 2);
});

test('ошибка сети пробрасывается, мусор в кеш не пишется', async () => {
  const db = freshDb();
  await assert.rejects(
    () => getRate(db, 'USD', '2026-08-19', async () => { throw new Error('сеть недоступна'); }),
    /сеть недоступна/,
  );
  const rows = db.prepare('SELECT COUNT(*) c FROM fx_rates').get() as any;
  assert.equal(rows.c, 0);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/core/fx.ts` не существует.

- [ ] **Step 3: Реализовать fx.ts**

Файл `src/core/fx.ts`:

```typescript
import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { IsoDate } from './dates.ts';
import { rateToStored } from './money.ts';

const BASE: Currency = 'BYN';

export type RateFetcher = (currency: Currency, date: IsoDate) => Promise<number>;

interface NbrbRate {
  Cur_Scale?: number;
  Cur_OfficialRate?: number;
}

/**
 * НБРБ отдаёт курс за Cur_Scale единиц валюты, а не за одну:
 * для RUB масштаб равен 100. Деление обязательно, иначе рубль
 * будет стоить в сто раз дороже.
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

/** Возвращает курс валюты к BYN в хранимом виде (× 1e8). */
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

  // Сеть за пределами транзакции: при ошибке в кеш ничего не попадает.
  const raw = await fetcher(currency, date);
  const stored = rateToStored(raw);

  db.prepare(
    'INSERT OR REPLACE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)',
  ).run(date, BASE, currency, stored);

  return stored;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Проверить реальный запрос к НБРБ вручную**

Run: `curl -s "https://api.nbrb.by/exrates/rates/RUB?parammode=2" | head -c 300`
Expected: JSON с полями `Cur_Scale` (для RUB — 100) и `Cur_OfficialRate`.

- [ ] **Step 6: Коммит**

```bash
git add src/core/fx.ts tests/core/fx.test.ts
git commit -m "Курсы валют НБРБ с кешем и учётом Cur_Scale"
```

---

### Task 6: Счета и транзакции

**Files:**
- Create: `src/core/accounts.ts`, `src/core/transactions.ts`
- Test: `tests/core/accounts.test.ts`, `tests/core/transactions.test.ts`

**Interfaces:**
- Consumes: `Db`, `getRate`, `convertMinor`
- Produces:
  - `createAccount(db, input: { name: string; currency: Currency; kind: AccountKind }): number`
  - `listAccounts(db): Account[]`
  - `accountBalance(db, accountId: number): number` — в минорных единицах валюты счёта
  - `type AccountKind = 'cash' | 'card' | 'deposit'`
  - `recordTransaction(db, input: TxInput): Promise<number>` где `TxInput = { ts: IsoDate; accountId: number; amountMinor: number; direction: 'expense'|'income'; categoryId?: number|null; note?: string|null; rawText?: string|null; rateFetcher?: RateFetcher }`
  - `recordTransfer(db, input: TransferInput): Promise<number>`
  - `totalInBase(db, accountIds?: number[]): number`

- [ ] **Step 1: Написать падающий тест счетов**

Файл `tests/core/accounts.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, listAccounts, accountBalance } from '../../src/core/accounts.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

test('createAccount возвращает id и счёт появляется в списке', () => {
  const db = freshDb();
  const id = createAccount(db, { name: 'карта BYN', currency: 'BYN', kind: 'card' });
  assert.ok(id > 0);

  const accounts = listAccounts(db);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.name, 'карта BYN');
  assert.equal(accounts[0]!.currency, 'BYN');
});

test('дублирующее имя счёта отвергается', () => {
  const db = freshDb();
  createAccount(db, { name: 'карта', currency: 'BYN', kind: 'card' });
  assert.throws(
    () => createAccount(db, { name: 'карта', currency: 'USD', kind: 'card' }),
    /UNIQUE|уже существует/i,
  );
});

test('баланс нового счёта равен нулю', () => {
  const db = freshDb();
  const id = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  assert.equal(accountBalance(db, id), 0);
});
```

- [ ] **Step 2: Написать падающий тест транзакций**

Файл `tests/core/transactions.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, accountBalance } from '../../src/core/accounts.ts';
import { recordTransaction, recordTransfer, totalInBase } from '../../src/core/transactions.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const rate = (v: number) => async () => v;

test('расход уменьшает баланс, доход увеличивает', async () => {
  const db = freshDb();
  const acc = createAccount(db, { name: 'нал BYN', currency: 'BYN', kind: 'cash' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: acc, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransaction(db, {
    ts: '2026-08-19', accountId: acc, amountMinor: 3_045,
    direction: 'expense', rateFetcher: rate(1),
  });

  assert.equal(accountBalance(db, acc), 6_955);
});

test('перевод между счетами не меняет общий итог в базовой валюте', async () => {
  const db = freshDb();
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'cash' });
  const usd = createAccount(db, { name: 'USD', currency: 'USD', kind: 'deposit' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: byn, amountMinor: 34_000,
    direction: 'income', rateFetcher: rate(1),
  });

  const before = totalInBase(db);

  // 100 BYN уходят, приходят 29.41 USD по курсу 3.4
  await recordTransfer(db, {
    ts: '2026-08-19',
    fromAccountId: byn, fromAmountMinor: 10_000,
    toAccountId: usd,   toAmountMinor: 2_941,
    rateFetcher: async (c) => (c === 'USD' ? 3.4 : 1),
  });

  assert.equal(accountBalance(db, byn), 24_000);
  assert.equal(accountBalance(db, usd), 2_941);

  // 240 BYN + 29.41 USD × 3.4 = 240 + 99.99 ≈ исходные 340 BYN
  const after = totalInBase(db);
  assert.ok(Math.abs(after - before) <= 2, `итог сместился на ${after - before} копеек`);
});

test('переводы исключены из расходов', async () => {
  const db = freshDb();
  const a = createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  const b = createAccount(db, { name: 'B', currency: 'BYN', kind: 'card' });

  await recordTransaction(db, {
    ts: '2026-08-19', accountId: a, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1),
  });
  await recordTransfer(db, {
    ts: '2026-08-19', fromAccountId: a, fromAmountMinor: 5_000,
    toAccountId: b, toAmountMinor: 5_000, rateFetcher: rate(1),
  });

  const expenses = db.prepare(
    "SELECT COUNT(*) c FROM transactions WHERE direction = 'expense'",
  ).get() as any;
  assert.equal(expenses.c, 0, 'перевод не должен считаться расходом');
});

test('нулевая сумма отвергается', async () => {
  const db = freshDb();
  const acc = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  await assert.rejects(
    () => recordTransaction(db, {
      ts: '2026-08-19', accountId: acc, amountMinor: 0,
      direction: 'expense', rateFetcher: rate(1),
    }),
    /сумма/i,
  );
});

test('перевод на тот же счёт отвергается', async () => {
  const db = freshDb();
  const a = createAccount(db, { name: 'A', currency: 'BYN', kind: 'cash' });
  await assert.rejects(
    () => recordTransfer(db, {
      ts: '2026-08-19', fromAccountId: a, fromAmountMinor: 100,
      toAccountId: a, toAmountMinor: 100, rateFetcher: rate(1),
    }),
    /один и тот же счёт/i,
  );
});
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

Run: `npm test`
Expected: FAIL — модули не существуют.

- [ ] **Step 4: Реализовать accounts.ts**

Файл `src/core/accounts.ts`:

```typescript
import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';

export type AccountKind = 'cash' | 'card' | 'deposit';

export interface Account {
  id: number;
  name: string;
  currency: Currency;
  kind: AccountKind;
  is_active: number;
}

export function createAccount(
  db: Db,
  input: { name: string; currency: Currency; kind: AccountKind },
): number {
  const info = db.prepare(
    'INSERT INTO accounts (name, currency, kind) VALUES (?,?,?)',
  ).run(input.name, input.currency, input.kind);
  return Number(info.lastInsertRowid);
}

export function listAccounts(db: Db): Account[] {
  return db.prepare(
    'SELECT id, name, currency, kind, is_active FROM accounts WHERE is_active = 1 ORDER BY id',
  ).all() as Account[];
}

export function getAccount(db: Db, id: number): Account {
  const row = db.prepare(
    'SELECT id, name, currency, kind, is_active FROM accounts WHERE id = ?',
  ).get(id) as Account | undefined;
  if (!row) throw new Error(`Счёт ${id} не найден`);
  return row;
}

/**
 * Баланс в минорных единицах валюты счёта.
 * Переводы учитываются с обеих сторон: счёт-источник теряет,
 * счёт-получатель приобретает.
 */
export function accountBalance(db: Db, accountId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS balance FROM (
      SELECT CASE direction
               WHEN 'income'   THEN  amount_minor
               WHEN 'expense'  THEN -amount_minor
               WHEN 'transfer' THEN -amount_minor
             END AS delta
      FROM transactions WHERE account_id = ?
      UNION ALL
      SELECT amount_minor AS delta
      FROM transactions
      WHERE direction = 'transfer' AND counter_account_id = ?
    )
  `).get(accountId, accountId) as { balance: number };
  return row.balance;
}
```

Примечание: для перевода пишутся **две** строки — расходная на счёте-источнике
(`direction='transfer'`, `account_id=from`, `counter_account_id=to`) и приходная
(`direction='transfer'`, `account_id=to`, `counter_account_id=from`). Запрос выше
их и складывает. Реализация в `recordTransfer` обязана создавать обе.

- [ ] **Step 5: Реализовать transactions.ts**

Файл `src/core/transactions.ts`:

```typescript
import type { Db } from '../db/index.ts';
import type { IsoDate } from './dates.ts';
import { getRate, type RateFetcher } from './fx.ts';
import { convertMinor } from './money.ts';
import { getAccount } from './accounts.ts';

export interface TxInput {
  ts: IsoDate;
  accountId: number;
  amountMinor: number;
  direction: 'expense' | 'income';
  categoryId?: number | null;
  note?: string | null;
  rawText?: string | null;
  rateFetcher?: RateFetcher;
}

export interface TransferInput {
  ts: IsoDate;
  fromAccountId: number;
  fromAmountMinor: number;
  toAccountId: number;
  toAmountMinor: number;
  note?: string | null;
  rateFetcher?: RateFetcher;
}

export async function recordTransaction(db: Db, input: TxInput): Promise<number> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error(`Сумма должна быть положительным целым, получено: ${input.amountMinor}`);
  }
  const account = getAccount(db, input.accountId);
  const rate = await getRate(db, account.currency, input.ts, input.rateFetcher);

  const info = db.prepare(`
    INSERT INTO transactions
      (ts, account_id, amount_minor, currency, category_id, direction,
       counter_account_id, note, raw_text, fx_rate_to_base)
    VALUES (?,?,?,?,?,?,NULL,?,?,?)
  `).run(
    input.ts, input.accountId, input.amountMinor, account.currency,
    input.categoryId ?? null, input.direction,
    input.note ?? null, input.rawText ?? null, rate,
  );
  return Number(info.lastInsertRowid);
}

export async function recordTransfer(db: Db, input: TransferInput): Promise<number> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error('Перевод на один и тот же счёт бессмыслен');
  }
  if (input.fromAmountMinor <= 0 || input.toAmountMinor <= 0) {
    throw new Error('Суммы перевода должны быть положительными');
  }

  const from = getAccount(db, input.fromAccountId);
  const to = getAccount(db, input.toAccountId);

  // Курсы берём до открытия транзакции: getRate может ходить в сеть,
  // а держать SQLite-транзакцию открытой на время сетевого запроса нельзя.
  const fromRate = await getRate(db, from.currency, input.ts, input.rateFetcher);
  const toRate = await getRate(db, to.currency, input.ts, input.rateFetcher);

  const insert = db.prepare(`
    INSERT INTO transactions
      (ts, account_id, amount_minor, currency, category_id, direction,
       counter_account_id, note, raw_text, fx_rate_to_base)
    VALUES (?,?,?,?,NULL,'transfer',?,?,NULL,?)
  `);

  let firstId = 0;
  db.transaction(() => {
    const a = insert.run(input.ts, input.fromAccountId, input.fromAmountMinor,
      from.currency, input.toAccountId, input.note ?? null, fromRate);
    insert.run(input.ts, input.toAccountId, input.toAmountMinor,
      to.currency, input.fromAccountId, input.note ?? null, toRate);
    firstId = Number(a.lastInsertRowid);
  })();

  return firstId;
}

/** Суммарный остаток по всем счетам, пересчитанный в базовую валюту. */
export function totalInBase(db: Db, accountIds?: number[]): number {
  const rows = db.prepare(`
    SELECT id, currency FROM accounts
    WHERE is_active = 1 ${accountIds ? 'AND id IN (' + accountIds.map(() => '?').join(',') + ')' : ''}
  `).all(...(accountIds ?? [])) as { id: number; currency: string }[];

  let total = 0;
  for (const acc of rows) {
    const balance = accountBalanceRaw(db, acc.id);
    if (balance === 0) continue;
    const rateRow = db.prepare(`
      SELECT fx_rate_to_base FROM transactions
      WHERE account_id = ? ORDER BY ts DESC, id DESC LIMIT 1
    `).get(acc.id) as { fx_rate_to_base: number } | undefined;
    // Остаток пересчитывается по последнему известному курсу этого счёта.
    total += convertMinor(balance, rateRow?.fx_rate_to_base ?? 100_000_000);
  }
  return total;
}

function accountBalanceRaw(db: Db, accountId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS balance FROM (
      SELECT CASE direction
               WHEN 'income'   THEN  amount_minor
               WHEN 'expense'  THEN -amount_minor
               WHEN 'transfer' THEN -amount_minor
             END AS delta
      FROM transactions WHERE account_id = ?
      UNION ALL
      SELECT amount_minor FROM transactions
      WHERE direction = 'transfer' AND counter_account_id = ?
    )
  `).get(accountId, accountId) as { balance: number };
  return row.balance;
}
```

- [ ] **Step 6: Запустить тесты и убедиться, что они проходят**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add src/core/accounts.ts src/core/transactions.ts tests/core/accounts.test.ts tests/core/transactions.test.ts
git commit -m "Счета, балансы, транзакции и переводы между валютами"
```

---

### Task 7: Регулярные платежи

**Files:**
- Create: `src/core/recurring.ts`
- Test: `tests/core/recurring.test.ts`

**Interfaces:**
- Consumes: `Db`, `dueDateFor`, `currentPeriod`, `addDays`, `recordTransaction`
- Produces:
  - `createRecurring(db, input: RecurringInput): number`
  - `listRecurring(db): Recurring[]`
  - `ensureInstances(db, period: Period): number` — сколько инстансов создано
  - `dueSoon(db, today: IsoDate): DueInstance[]`
  - `markPaid(db, instanceId: number, amountMinor: number, today: IsoDate, rateFetcher?): Promise<number>`

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/recurring.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount, accountBalance } from '../../src/core/accounts.ts';
import {
  createRecurring, ensureInstances, dueSoon, markPaid,
} from '../../src/core/recurring.ts';

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  const rub = createAccount(db, { name: 'RUB', currency: 'RUB', kind: 'card' });
  return { db, byn, rub };
}

const rate = (v: number) => async () => v;

test('белорусские платежи 15-го числа', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });

  const created = ensureInstances(db, '2026-08');
  assert.equal(created, 1);

  const rows = db.prepare('SELECT due_date FROM payment_instances').all() as any[];
  assert.equal(rows[0].due_date, '2026-08-15');
});

test('российские платежи в последнее число месяца', () => {
  const { db, rub } = setup();
  createRecurring(db, {
    title: 'сервер', accountId: rub, amountMinor: 50_000,
    currency: 'RUB', dayOfMonth: null, isLastDay: true,
  });

  ensureInstances(db, '2026-02');
  ensureInstances(db, '2026-04');
  ensureInstances(db, '2024-02');

  const dates = (db.prepare(
    'SELECT due_date FROM payment_instances ORDER BY due_date',
  ).all() as any[]).map((r) => r.due_date);

  assert.deepEqual(dates, ['2024-02-29', '2026-02-28', '2026-04-30']);
});

test('ensureInstances идемпотентна', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'зал', accountId: byn, amountMinor: 5_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });

  assert.equal(ensureInstances(db, '2026-08'), 1);
  assert.equal(ensureInstances(db, '2026-08'), 0, 'повторный вызов не должен дублировать');

  const n = db.prepare('SELECT COUNT(*) c FROM payment_instances').get() as any;
  assert.equal(n.c, 1);
});

test('неактивные правила инстансы не порождают', () => {
  const { db, byn } = setup();
  const id = createRecurring(db, {
    title: 'старое', accountId: byn, amountMinor: 100,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  db.prepare('UPDATE recurring_payments SET is_active = 0 WHERE id = ?').run(id);

  assert.equal(ensureInstances(db, '2026-08'), 0);
});

test('dueSoon отдаёт платежи в пределах remind_days_before', () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3,
  });
  ensureInstances(db, '2026-08');

  assert.equal(dueSoon(db, '2026-08-11').length, 0, 'за 4 дня — рано');
  assert.equal(dueSoon(db, '2026-08-12').length, 1, 'за 3 дня — пора');
  assert.equal(dueSoon(db, '2026-08-15').length, 1, 'в день срока — пора');
  assert.equal(dueSoon(db, '2026-08-20').length, 1, 'просроченный всё ещё виден');
});

test('markPaid создаёт транзакцию и закрывает инстанс', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as any;

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));

  const after = db.prepare('SELECT status, paid_tx_id FROM payment_instances WHERE id = ?')
    .get(inst.id) as any;
  assert.equal(after.status, 'paid');
  assert.ok(after.paid_tx_id > 0);
  assert.equal(accountBalance(db, byn), -3_000);
});

test('оплаченный инстанс исчезает из dueSoon', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as any;

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));
  assert.equal(dueSoon(db, '2026-08-15').length, 0);
});

test('повторная оплата отвергается', async () => {
  const { db, byn } = setup();
  createRecurring(db, {
    title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false,
  });
  ensureInstances(db, '2026-08');
  const inst = db.prepare('SELECT id FROM payment_instances').get() as any;

  await markPaid(db, inst.id, 3_000, '2026-08-15', rate(1));
  await assert.rejects(
    () => markPaid(db, inst.id, 3_000, '2026-08-15', rate(1)),
    /уже оплачен/i,
  );
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/core/recurring.ts` не существует.

- [ ] **Step 3: Реализовать recurring.ts**

Файл `src/core/recurring.ts`:

```typescript
import type { Currency } from '../config.ts';
import type { Db } from '../db/index.ts';
import { dueDateFor, addDays, type IsoDate, type Period } from './dates.ts';
import { recordTransaction } from './transactions.ts';
import type { RateFetcher } from './fx.ts';

export interface RecurringInput {
  title: string;
  accountId: number;
  amountMinor: number | null;
  currency: Currency;
  categoryId?: number | null;
  dayOfMonth: number | null;
  isLastDay: boolean;
  isVariable?: boolean;
  remindDaysBefore?: number;
}

export interface Recurring {
  id: number;
  title: string;
  account_id: number;
  category_id: number | null;
  amount_minor: number | null;
  currency: Currency;
  day_of_month: number | null;
  is_last_day: number;
  is_variable: number;
  remind_days_before: number;
}

export interface DueInstance {
  id: number;
  title: string;
  due_date: IsoDate;
  period: Period;
  amount_minor: number | null;
  currency: Currency;
  is_variable: number;
  account_id: number;
  notified_on: string | null;
}

export function createRecurring(db: Db, input: RecurringInput): number {
  const info = db.prepare(`
    INSERT INTO recurring_payments
      (title, account_id, category_id, amount_minor, currency,
       day_of_month, is_last_day, is_variable, remind_days_before)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    input.title, input.accountId, input.categoryId ?? null,
    input.amountMinor, input.currency,
    input.dayOfMonth, input.isLastDay ? 1 : 0,
    input.isVariable ? 1 : 0, input.remindDaysBefore ?? 3,
  );
  return Number(info.lastInsertRowid);
}

export function listRecurring(db: Db): Recurring[] {
  return db.prepare(
    'SELECT * FROM recurring_payments WHERE is_active = 1 ORDER BY is_last_day, day_of_month, id',
  ).all() as Recurring[];
}

/** Создаёт недостающие инстансы за период. Возвращает число созданных. */
export function ensureInstances(db: Db, period: Period): number {
  const rules = listRecurring(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO payment_instances (recurring_id, period, due_date)
    VALUES (?,?,?)
  `);

  let created = 0;
  db.transaction(() => {
    for (const r of rules) {
      const due = dueDateFor(period, r.day_of_month, r.is_last_day === 1);
      const info = insert.run(r.id, period, due);
      created += info.changes;
    }
  })();

  return created;
}

/**
 * Неоплаченные платежи, до срока которых осталось не больше
 * remind_days_before дней. Просроченные тоже возвращаются: о них
 * важнее напомнить, чем о предстоящих.
 */
export function dueSoon(db: Db, today: IsoDate): DueInstance[] {
  return db.prepare(`
    SELECT pi.id, pi.due_date, pi.period, pi.notified_on,
           r.title, r.amount_minor, r.currency, r.is_variable, r.account_id
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.status = 'pending'
      AND date(pi.due_date, '-' || r.remind_days_before || ' days') <= date(?)
    ORDER BY pi.due_date
  `).all(today) as DueInstance[];
}

export async function markPaid(
  db: Db,
  instanceId: number,
  amountMinor: number,
  today: IsoDate,
  rateFetcher?: RateFetcher,
): Promise<number> {
  const inst = db.prepare(`
    SELECT pi.id, pi.status, r.account_id, r.category_id, r.title
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.id = ?
  `).get(instanceId) as any;

  if (!inst) throw new Error(`Платёж ${instanceId} не найден`);
  if (inst.status === 'paid') throw new Error(`Платёж «${inst.title}» уже оплачен`);

  const txId = await recordTransaction(db, {
    ts: today,
    accountId: inst.account_id,
    amountMinor,
    direction: 'expense',
    categoryId: inst.category_id,
    note: inst.title,
    rateFetcher,
  });

  db.prepare(
    "UPDATE payment_instances SET status = 'paid', paid_tx_id = ? WHERE id = ?",
  ).run(txId, instanceId);

  return txId;
}

export function markNotified(db: Db, instanceId: number, today: IsoDate): void {
  db.prepare('UPDATE payment_instances SET notified_on = ? WHERE id = ?')
    .run(today, instanceId);
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/recurring.ts tests/core/recurring.test.ts
git commit -m "Регулярные платежи: правила, генерация инстансов, отметка об оплате"
```

---

### Task 8: Отчёты и прогноз

**Files:**
- Create: `src/core/reports.ts`
- Test: `tests/core/reports.test.ts`

**Interfaces:**
- Consumes: `Db`, `convertMinor`, `totalInBase`
- Produces:
  - `expensesByCategory(db, period: Period): { category: string; totalBase: number }[]`
  - `monthSummary(db, period: Period): { incomeBase: number; expenseBase: number; savingsRate: number }`
  - `unpaidObligations(db, period: Period): number` — в базовой валюте
  - `forecast(db, period: Period): { availableBase: number; unpaidBase: number; freeBase: number }`

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/reports.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount } from '../../src/core/accounts.ts';
import { recordTransaction, recordTransfer } from '../../src/core/transactions.ts';
import { createRecurring, ensureInstances } from '../../src/core/recurring.ts';
import { expensesByCategory, monthSummary, unpaidObligations } from '../../src/core/reports.ts';

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  const cafe = (db.prepare("SELECT id FROM categories WHERE name='кафе'").get() as any).id;
  return { db, byn, cafe };
}

const rate = (v: number) => async () => v;

test('expensesByCategory группирует и суммирует', async () => {
  const { db, byn, cafe } = setup();
  await recordTransaction(db, { ts: '2026-08-05', accountId: byn, amountMinor: 1_500,
    direction: 'expense', categoryId: cafe, rateFetcher: rate(1) });
  await recordTransaction(db, { ts: '2026-08-19', accountId: byn, amountMinor: 2_500,
    direction: 'expense', categoryId: cafe, rateFetcher: rate(1) });

  const rows = expensesByCategory(db, '2026-08');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.category, 'кафе');
  assert.equal(rows[0]!.totalBase, 4_000);
});

test('expensesByCategory игнорирует другие месяцы', async () => {
  const { db, byn, cafe } = setup();
  await recordTransaction(db, { ts: '2026-07-31', accountId: byn, amountMinor: 9_999,
    direction: 'expense', categoryId: cafe, rateFetcher: rate(1) });
  assert.equal(expensesByCategory(db, '2026-08').length, 0);
});

test('expensesByCategory не считает переводы расходом', async () => {
  const { db, byn } = setup();
  const other = createAccount(db, { name: 'нал', currency: 'BYN', kind: 'cash' });
  await recordTransaction(db, { ts: '2026-08-01', accountId: byn, amountMinor: 10_000,
    direction: 'income', rateFetcher: rate(1) });
  await recordTransfer(db, { ts: '2026-08-02', fromAccountId: byn, fromAmountMinor: 5_000,
    toAccountId: other, toAmountMinor: 5_000, rateFetcher: rate(1) });

  assert.equal(expensesByCategory(db, '2026-08').length, 0);
});

test('monthSummary считает норму сбережений', async () => {
  const { db, byn, cafe } = setup();
  await recordTransaction(db, { ts: '2026-08-01', accountId: byn, amountMinor: 100_000,
    direction: 'income', rateFetcher: rate(1) });
  await recordTransaction(db, { ts: '2026-08-10', accountId: byn, amountMinor: 25_000,
    direction: 'expense', categoryId: cafe, rateFetcher: rate(1) });

  const s = monthSummary(db, '2026-08');
  assert.equal(s.incomeBase, 100_000);
  assert.equal(s.expenseBase, 25_000);
  assert.equal(s.savingsRate, 0.75);
});

test('monthSummary при нулевом доходе не делит на ноль', async () => {
  const { db, byn, cafe } = setup();
  await recordTransaction(db, { ts: '2026-08-10', accountId: byn, amountMinor: 5_000,
    direction: 'expense', categoryId: cafe, rateFetcher: rate(1) });

  const s = monthSummary(db, '2026-08');
  assert.equal(s.incomeBase, 0);
  assert.equal(s.savingsRate, 0);
  assert.ok(Number.isFinite(s.savingsRate));
});

test('unpaidObligations суммирует неоплаченное за период', () => {
  const { db, byn } = setup();
  createRecurring(db, { title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false });
  createRecurring(db, { title: 'зал', accountId: byn, amountMinor: 5_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false });
  ensureInstances(db, '2026-08');

  assert.equal(unpaidObligations(db, '2026-08'), 8_000);
});

test('плавающие платежи без суммы не ломают подсчёт', () => {
  const { db, byn } = setup();
  createRecurring(db, { title: 'коммуналка', accountId: byn, amountMinor: null,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, isVariable: true });
  ensureInstances(db, '2026-08');

  assert.equal(unpaidObligations(db, '2026-08'), 0);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/core/reports.ts` не существует.

- [ ] **Step 3: Реализовать reports.ts**

Файл `src/core/reports.ts`:

```typescript
import type { Db } from '../db/index.ts';
import type { Period } from './dates.ts';
import { convertMinor } from './money.ts';
import { totalInBase } from './transactions.ts';

/**
 * Расходы по категориям за период, пересчитанные в базовую валюту
 * по курсу, зафиксированному на дату каждой операции.
 * Переводы исключены: direction = 'expense'.
 */
export function expensesByCategory(
  db: Db,
  period: Period,
): { category: string; totalBase: number }[] {
  const rows = db.prepare(`
    SELECT COALESCE(c.name, 'без категории') AS category,
           t.amount_minor, t.fx_rate_to_base
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.direction = 'expense' AND substr(t.ts, 1, 7) = ?
  `).all(period) as { category: string; amount_minor: number; fx_rate_to_base: number }[];

  const totals = new Map<string, number>();
  for (const r of rows) {
    const base = convertMinor(r.amount_minor, r.fx_rate_to_base);
    totals.set(r.category, (totals.get(r.category) ?? 0) + base);
  }

  return [...totals.entries()]
    .map(([category, totalBase]) => ({ category, totalBase }))
    .sort((a, b) => b.totalBase - a.totalBase);
}

export function monthSummary(
  db: Db,
  period: Period,
): { incomeBase: number; expenseBase: number; savingsRate: number } {
  const rows = db.prepare(`
    SELECT direction, amount_minor, fx_rate_to_base
    FROM transactions
    WHERE direction IN ('income','expense') AND substr(ts, 1, 7) = ?
  `).all(period) as { direction: string; amount_minor: number; fx_rate_to_base: number }[];

  let incomeBase = 0;
  let expenseBase = 0;
  for (const r of rows) {
    const base = convertMinor(r.amount_minor, r.fx_rate_to_base);
    if (r.direction === 'income') incomeBase += base;
    else expenseBase += base;
  }

  // Деление на ноль даёт Infinity/NaN, которые потом молча портят отчёт.
  const savingsRate = incomeBase > 0 ? (incomeBase - expenseBase) / incomeBase : 0;

  return { incomeBase, expenseBase, savingsRate };
}

/**
 * Сумма неоплаченных обязательств за период в базовой валюте.
 * Плавающие платежи с неизвестной суммой в подсчёт не входят —
 * лучше недооценить обязательства, чем выдумать цифру.
 */
export function unpaidObligations(db: Db, period: Period): number {
  const rows = db.prepare(`
    SELECT r.amount_minor, r.currency, pi.due_date
    FROM payment_instances pi
    JOIN recurring_payments r ON r.id = pi.recurring_id
    WHERE pi.status = 'pending' AND pi.period = ? AND r.amount_minor IS NOT NULL
  `).all(period) as { amount_minor: number; currency: string; due_date: string }[];

  let total = 0;
  for (const r of rows) {
    const rateRow = db.prepare(`
      SELECT rate FROM fx_rates
      WHERE base = 'BYN' AND quote = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `).get(r.currency, r.due_date) as { rate: number } | undefined;

    const rate = r.currency === 'BYN' ? 100_000_000 : rateRow?.rate;
    // Без известного курса платёж пропускаем, а не считаем по курсу 1:1.
    if (rate === undefined) continue;
    total += convertMinor(r.amount_minor, rate);
  }
  return total;
}

export function forecast(
  db: Db,
  period: Period,
): { availableBase: number; unpaidBase: number; freeBase: number } {
  const availableBase = totalInBase(db);
  const unpaidBase = unpaidObligations(db, period);
  return { availableBase, unpaidBase, freeBase: availableBase - unpaidBase };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/reports.ts tests/core/reports.test.ts
git commit -m "Отчёты по категориям, сводка месяца и прогноз свободных средств"
```

---

### Task 9: Очередь и разбор текста через Claude

**Files:**
- Create: `src/claude/queue.ts`, `src/claude/parse.ts`
- Test: `tests/claude/queue.test.ts`, `tests/claude/parse.test.ts`

**Interfaces:**
- Consumes: `Db`, категории из БД
- Produces:
  - `class Queue { run<T>(fn: () => Promise<T>): Promise<T> }`
  - `type ParsedTx = { amount: number; currency: Currency; category: string | null; date: IsoDate; direction: 'expense'|'income'; note: string | null; confidence: 'high'|'low' }`
  - `parseTransaction(text: string, ctx: ParseContext): Promise<ParsedTx>`
  - `validateParsed(raw: unknown, today: IsoDate): ParsedTx` — чистая функция, тестируется без Claude

- [ ] **Step 1: Написать падающий тест очереди**

Файл `tests/claude/queue.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../../src/claude/queue.ts';

test('очередь выполняет задачи строго по одной', async () => {
  const q = new Queue();
  let running = 0;
  let maxConcurrent = 0;

  const task = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
    return 'ok';
  };

  await Promise.all([q.run(task), q.run(task), q.run(task)]);
  assert.equal(maxConcurrent, 1, `одновременно выполнялось ${maxConcurrent}`);
});

test('очередь сохраняет порядок', async () => {
  const q = new Queue();
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) =>
    q.run(async () => { order.push(n); })));
  assert.deepEqual(order, [1, 2, 3]);
});

test('ошибка задачи не блокирует очередь', async () => {
  const q = new Queue();
  await assert.rejects(() => q.run(async () => { throw new Error('упало'); }), /упало/);
  const result = await q.run(async () => 'следующая работает');
  assert.equal(result, 'следующая работает');
});
```

- [ ] **Step 2: Написать падающий тест валидации разбора**

Файл `tests/claude/parse.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParsed } from '../../src/claude/parse.ts';

test('валидный разбор проходит', () => {
  const r = validateParsed({
    amount: 5, currency: 'RUB', category: 'кафе',
    date: '2026-08-19', direction: 'expense', note: 'кофе', confidence: 'high',
  }, '2026-08-19');
  assert.equal(r.amount, 5);
  assert.equal(r.currency, 'RUB');
});

test('неизвестная валюта отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'EUR', category: null,
    date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19'), /валют/i);
});

test('отрицательная или нулевая сумма отвергается', () => {
  for (const amount of [0, -5]) {
    assert.throws(() => validateParsed({
      amount, currency: 'RUB', category: null,
      date: '2026-08-19', direction: 'expense', note: null, confidence: 'high',
    }, '2026-08-19'), /сумм/i);
  }
});

test('дата из будущего отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'RUB', category: null,
    date: '2027-01-01', direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19'), /будущ/i);
});

test('отсутствующая дата заменяется сегодняшней', () => {
  const r = validateParsed({
    amount: 5, currency: 'RUB', category: null,
    direction: 'expense', note: null, confidence: 'high',
  }, '2026-08-19');
  assert.equal(r.date, '2026-08-19');
});

test('мусор вместо объекта отвергается', () => {
  assert.throws(() => validateParsed('не объект', '2026-08-19'), /разбор/i);
  assert.throws(() => validateParsed(null, '2026-08-19'), /разбор/i);
});

test('неизвестное направление отвергается', () => {
  assert.throws(() => validateParsed({
    amount: 5, currency: 'RUB', category: null,
    date: '2026-08-19', direction: 'подарок', note: null, confidence: 'high',
  }, '2026-08-19'), /направлени/i);
});
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

Run: `npm test`
Expected: FAIL — модули не существуют.

- [ ] **Step 4: Реализовать queue.ts**

Файл `src/claude/queue.ts`:

```typescript
/**
 * Последовательная очередь. Claude Agent SDK запускает `claude` CLI
 * подпроцессом; на VPS с 2 ГБ RAM параллельные запуски могут
 * исчерпать память, поэтому конкурентность жёстко равна единице.
 */
export class Queue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    // Хвост не должен наследовать отказ: иначе одна упавшая задача
    // отклонит все последующие.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

- [ ] **Step 5: Реализовать parse.ts**

Файл `src/claude/parse.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Currency } from '../config.ts';
import type { IsoDate } from '../core/dates.ts';

const CURRENCIES: readonly string[] = ['RUB', 'BYN', 'USD'];
const DIRECTIONS: readonly string[] = ['expense', 'income'];

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

/** Чистая проверка ответа модели. Никакой сети — тестируется изолированно. */
export function validateParsed(raw: unknown, today: IsoDate): ParsedTx {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Разбор не дал объекта');
  }
  const o = raw as Record<string, unknown>;

  const amount = Number(o.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Некорректная сумма: ${o.amount}`);
  }

  const currency = String(o.currency ?? '').toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    throw new Error(`Неподдерживаемая валюта: ${o.currency}`);
  }

  const direction = String(o.direction ?? 'expense');
  if (!DIRECTIONS.includes(direction)) {
    throw new Error(`Неизвестное направление: ${o.direction}`);
  }

  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date)
    ? o.date
    : today;
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

Верни СТРОГО один JSON-объект без markdown-обёртки и без пояснений:
{"amount": число, "currency": "RUB"|"BYN"|"USD", "category": строка|null,
 "date": "YYYY-MM-DD", "direction": "expense"|"income", "note": строка|null,
 "confidence": "high"|"low"}

Правила:
- amount — положительное число в основных единицах (5.50, не 550).
- Валюта из текста: "руб/р/rub" → RUB, "бр/byn/руб.бел" → BYN, "$/usd/бакс" → USD.
  Если валюта не указана — используй валюту по умолчанию из контекста.
- category выбирай ТОЛЬКО из предложенного списка. Не подходит ни одна — null.
- date: "вчера", "позавчера", "5 августа" переводи в YYYY-MM-DD относительно
  сегодняшней даты из контекста. Не указано — сегодняшняя дата.
- direction: "получил", "зарплата", "пришло" → income; иначе expense.
- confidence: "low", если сумма, валюта или смысл записи неоднозначны.`;

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
      allowedTools: [],          // разбор текста не требует инструментов
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') output += block.text;
      }
    }
  }

  // Модель может обернуть JSON в ```json ... ``` — вырезаем содержимое
  // первой фигурной скобки до последней.
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Не удалось найти JSON в ответе: ${output.slice(0, 200)}`);
  }

  return validateParsed(JSON.parse(output.slice(start, end + 1)), ctx.today);
}
```

- [ ] **Step 6: Запустить тесты и убедиться, что они проходят**

Run: `npm test`
Expected: PASS. Тесты `parse` проверяют только `validateParsed` и в сеть не ходят.

- [ ] **Step 7: Проверить реальный разбор вручную**

Предварительно выполнить `claude setup-token` и положить токен в `.env` как
`CLAUDE_CODE_OAUTH_TOKEN`.

Run:
```bash
npx tsx -e "
import 'dotenv/config';
import { parseTransaction } from './src/claude/parse.ts';
const r = await parseTransaction('кофе 5 руб', {
  today: '2026-08-19', categories: ['кафе','продукты','транспорт'], defaultCurrency: 'BYN',
});
console.log(r);
"
```
Expected: объект с `amount: 5`, `currency: 'RUB'`, `category: 'кафе'`.

- [ ] **Step 8: Коммит**

```bash
git add src/claude tests/claude
git commit -m "Очередь вызовов Claude и разбор свободного текста в транзакцию"
```

---

### Task 10: Телеграм-бот с whitelist владельца

**Files:**
- Create: `src/bot/index.ts`, `src/bot/confirm.ts`, `src/index.ts`
- Test: `tests/bot/guard.test.ts`

**Interfaces:**
- Consumes: всё из `src/core/*`, `src/claude/*`
- Produces:
  - `isOwner(ownerId: number | null, fromId: number | undefined): boolean`
  - `createBot(deps: BotDeps): Bot`
  - `startBot(deps: BotDeps): Promise<void>`

- [ ] **Step 1: Написать падающий тест whitelist**

Файл `tests/bot/guard.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwner } from '../../src/bot/index.ts';

test('владелец пропускается', () => {
  assert.equal(isOwner(12345, 12345), true);
});

test('посторонний не пропускается', () => {
  assert.equal(isOwner(12345, 99999), false);
});

test('отсутствующий отправитель не пропускается', () => {
  assert.equal(isOwner(12345, undefined), false);
});

test('при незаданном OWNER_ID не пропускается никто', () => {
  assert.equal(isOwner(null, 12345), false);
  assert.equal(isOwner(null, undefined), false);
});

test('строковое совпадение не проходит за числовое', () => {
  // защита от случайного сравнения '12345' == 12345
  assert.equal(isOwner(12345, '12345' as unknown as number), false);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/bot/index.ts` не существует.

- [ ] **Step 3: Реализовать bot/index.ts**

Файл `src/bot/index.ts`:

```typescript
import { Bot, InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { Queue } from '../claude/queue.ts';
import { parseTransaction } from '../claude/parse.ts';
import { listAccounts, accountBalance } from '../core/accounts.ts';
import { recordTransaction } from '../core/transactions.ts';
import { expensesByCategory, monthSummary, forecast } from '../core/reports.ts';
import { dueSoon, markPaid } from '../core/recurring.ts';
import { formatMoney, toMinor } from '../core/money.ts';
import { currentPeriod } from '../core/dates.ts';

export function isOwner(ownerId: number | null, fromId: number | undefined): boolean {
  // Строгое сравнение чисел: username в Telegram меняется и передаётся
  // другому человеку, числовой id — нет.
  return ownerId !== null
    && typeof fromId === 'number'
    && fromId === ownerId;
}

export interface BotDeps {
  cfg: Config;
  db: Db;
  queue: Queue;
}

/** Незавершённые подтверждения: ключ — id сообщения с карточкой. */
const pending = new Map<number, {
  amountMinor: number; currency: string; categoryId: number | null;
  date: string; direction: 'expense' | 'income'; accountId: number; rawText: string;
}>();

export function createBot(deps: BotDeps): Bot {
  const { cfg, db, queue } = deps;
  const bot = new Bot(cfg.botToken);

  // Единственный барьер доступа. Стоит первым, до любых обработчиков.
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;

    if (cfg.ownerId === null) {
      // Режим начальной настройки: сообщаем id и ничего не делаем.
      if (fromId) {
        await ctx.reply(
          `OWNER_ID не задан.\nТвой Telegram ID: ${fromId}\n\n` +
          `Впиши его в .env как OWNER_ID=${fromId} и перезапусти бота.`,
        );
      }
      return;
    }

    if (!isOwner(cfg.ownerId, fromId)) {
      // Молча игнорируем: ответ подтвердил бы существование бота.
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Финансовый консультант готов.\n\n' +
      'Пиши тратами как человеку: «кофе 5 руб», «зп 1200 usd».\n\n' +
      'Команды:\n' +
      '/balance — остатки по счетам\n' +
      '/month — сводка за месяц\n' +
      '/cat — расходы по категориям\n' +
      '/due — ближайшие платежи\n' +
      '/forecast — сколько свободно',
    );
  });

  bot.command('balance', async (ctx) => {
    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      await ctx.reply('Счетов пока нет. Добавь первый: /addaccount');
      return;
    }
    const lines = accounts.map((a) =>
      `${a.name}: ${formatMoney(accountBalance(db, a.id), a.currency)}`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('month', async (ctx) => {
    const period = currentPeriod(new Date());
    const s = monthSummary(db, period);
    await ctx.reply(
      `Сводка за ${period}\n\n` +
      `Доход:  ${formatMoney(s.incomeBase, cfg.baseCurrency)}\n` +
      `Расход: ${formatMoney(s.expenseBase, cfg.baseCurrency)}\n` +
      `Отложено: ${(s.savingsRate * 100).toFixed(0)}%`,
    );
  });

  bot.command('cat', async (ctx) => {
    const period = currentPeriod(new Date());
    const rows = expensesByCategory(db, period);
    if (rows.length === 0) {
      await ctx.reply(`За ${period} расходов ещё нет.`);
      return;
    }
    const lines = rows.map((r) =>
      `${r.category}: ${formatMoney(r.totalBase, cfg.baseCurrency)}`);
    await ctx.reply(`Расходы за ${period}\n\n${lines.join('\n')}`);
  });

  bot.command('due', async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = dueSoon(db, today);
    if (rows.length === 0) {
      await ctx.reply('Ближайших платежей нет.');
      return;
    }
    for (const r of rows) {
      const amount = r.amount_minor === null
        ? 'сумма плавающая'
        : formatMoney(r.amount_minor, r.currency as any);
      const kb = new InlineKeyboard().text('Оплачено', `paid:${r.id}`);
      await ctx.reply(`${r.title} — ${amount}, срок ${r.due_date}`, { reply_markup: kb });
    }
  });

  bot.command('forecast', async (ctx) => {
    const period = currentPeriod(new Date());
    const f = forecast(db, period);
    await ctx.reply(
      `Прогноз на ${period}\n\n` +
      `Всего на счетах: ${formatMoney(f.availableBase, cfg.baseCurrency)}\n` +
      `Неоплаченные обязательства: ${formatMoney(f.unpaidBase, cfg.baseCurrency)}\n` +
      `Свободно: ${formatMoney(f.freeBase, cfg.baseCurrency)}`,
    );
  });

  bot.callbackQuery(/^paid:(\d+)$/, async (ctx) => {
    const instanceId = Number(ctx.match![1]);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const row = db.prepare(`
        SELECT r.amount_minor, r.currency, r.title
        FROM payment_instances pi JOIN recurring_payments r ON r.id = pi.recurring_id
        WHERE pi.id = ?
      `).get(instanceId) as any;

      if (row.amount_minor === null) {
        await ctx.answerCallbackQuery('Напиши фактическую сумму сообщением');
        return;
      }
      await markPaid(db, instanceId, row.amount_minor, today);
      await ctx.editMessageText(`${row.title} — оплачено ✓`);
      await ctx.answerCallbackQuery('Записано');
    } catch (err) {
      await ctx.answerCallbackQuery(String((err as Error).message).slice(0, 190));
    }
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    const key = Number(ctx.match![1]);
    const draft = pending.get(key);
    if (!draft) {
      await ctx.answerCallbackQuery('Черновик устарел, введи заново');
      return;
    }
    await recordTransaction(db, {
      ts: draft.date, accountId: draft.accountId,
      amountMinor: draft.amountMinor, direction: draft.direction,
      categoryId: draft.categoryId, rawText: draft.rawText,
    });
    pending.delete(key);
    await ctx.editMessageText('Записано ✓');
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    pending.delete(Number(ctx.match![1]));
    await ctx.editMessageText('Отменено');
    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      await ctx.reply('Сначала добавь счёт: /addaccount');
      return;
    }

    const categories = (db.prepare(
      "SELECT name FROM categories WHERE kind = 'expense'",
    ).all() as { name: string }[]).map((r) => r.name);

    await ctx.replyWithChatAction('typing');

    let parsed;
    try {
      parsed = await queue.run(() => parseTransaction(text, {
        today: new Date().toISOString().slice(0, 10),
        categories,
        defaultCurrency: cfg.baseCurrency,
      }));
    } catch (err) {
      await ctx.reply(`Не понял запись: ${(err as Error).message}`);
      return;
    }

    const account = accounts.find((a) => a.currency === parsed.currency) ?? accounts[0]!;
    const categoryRow = parsed.category
      ? db.prepare("SELECT id FROM categories WHERE name = ? AND kind = 'expense'")
          .get(parsed.category) as { id: number } | undefined
      : undefined;

    const key = Date.now() % 1_000_000;
    pending.set(key, {
      amountMinor: toMinor(parsed.amount, parsed.currency),
      currency: parsed.currency,
      categoryId: categoryRow?.id ?? null,
      date: parsed.date,
      direction: parsed.direction,
      accountId: account.id,
      rawText: text,
    });

    const kb = new InlineKeyboard()
      .text('Записать', `ok:${key}`)
      .text('Отмена', `cancel:${key}`);

    const warn = parsed.confidence === 'low' ? '\n\n⚠️ Разбор неоднозначен, проверь' : '';
    await ctx.reply(
      `${parsed.direction === 'income' ? 'Доход' : 'Расход'}\n` +
      `Сумма: ${parsed.amount} ${parsed.currency}\n` +
      `Категория: ${parsed.category ?? 'без категории'}\n` +
      `Дата: ${parsed.date}\n` +
      `Счёт: ${account.name}${warn}`,
      { reply_markup: kb },
    );
  });

  bot.catch((err) => {
    console.error('Ошибка бота:', err.error);
  });

  return bot;
}
```

- [ ] **Step 4: Реализовать точку входа**

Файл `src/index.ts`:

```typescript
import 'dotenv/config';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrations.ts';
import { Queue } from './claude/queue.ts';
import { createBot } from './bot/index.ts';
import { startReminders } from './jobs/reminders.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
runMigrations(db);

const queue = new Queue();
const bot = createBot({ cfg, db, queue });

if (cfg.ownerId !== null) {
  startReminders({ cfg, db, bot });
} else {
  console.warn('OWNER_ID не задан — напоминания выключены, бот только сообщит твой id');
}

process.once('SIGINT', () => { bot.stop(); db.close(); });
process.once('SIGTERM', () => { bot.stop(); db.close(); });

console.log('Бот запущен');
await bot.start();
```

- [ ] **Step 5: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/bot src/index.ts tests/bot
git commit -m "Телеграм-бот: whitelist владельца, команды, карточка подтверждения"
```

---

### Task 11: Ежедневные напоминания

**Files:**
- Create: `src/jobs/reminders.ts`
- Test: `tests/jobs/reminders.test.ts`

**Interfaces:**
- Consumes: `Db`, `ensureInstances`, `dueSoon`, `markNotified`
- Produces:
  - `collectReminders(db, today: IsoDate): DueInstance[]` — чистая, тестируемая без Telegram
  - `startReminders(deps: { cfg: Config; db: Db; bot: Bot }): void`

- [ ] **Step 1: Написать падающий тест**

Файл `tests/jobs/reminders.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { createAccount } from '../../src/core/accounts.ts';
import { createRecurring } from '../../src/core/recurring.ts';
import { collectReminders } from '../../src/jobs/reminders.ts';

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const byn = createAccount(db, { name: 'BYN', currency: 'BYN', kind: 'card' });
  return { db, byn };
}

test('collectReminders сам достраивает инстансы текущего месяца', () => {
  const { db, byn } = setup();
  createRecurring(db, { title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3 });

  const rows = collectReminders(db, '2026-08-13');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'интернет');
});

test('дважды за день не напоминает', () => {
  const { db, byn } = setup();
  createRecurring(db, { title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3 });

  const first = collectReminders(db, '2026-08-13');
  assert.equal(first.length, 1);

  const second = collectReminders(db, '2026-08-13');
  assert.equal(second.length, 0, 'повтор в тот же день недопустим');
});

test('на следующий день напоминает снова', () => {
  const { db, byn } = setup();
  createRecurring(db, { title: 'интернет', accountId: byn, amountMinor: 3_000,
    currency: 'BYN', dayOfMonth: 15, isLastDay: false, remindDaysBefore: 3 });

  collectReminders(db, '2026-08-13');
  assert.equal(collectReminders(db, '2026-08-14').length, 1);
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — `src/jobs/reminders.ts` не существует.

- [ ] **Step 3: Реализовать reminders.ts**

Файл `src/jobs/reminders.ts`:

```typescript
import cron from 'node-cron';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { ensureInstances, dueSoon, markNotified, type DueInstance } from '../core/recurring.ts';
import { currentPeriod, type IsoDate } from '../core/dates.ts';
import { formatMoney } from '../core/money.ts';

/**
 * Достраивает инстансы текущего месяца и возвращает те, о которых
 * сегодня ещё не напоминали. Отметка notified_on ставится здесь же,
 * поэтому повторный вызов в тот же день вернёт пустой список.
 */
export function collectReminders(db: Db, today: IsoDate): DueInstance[] {
  ensureInstances(db, currentPeriod(new Date(`${today}T00:00:00Z`)));

  const due = dueSoon(db, today).filter((d) => d.notified_on !== today);
  for (const d of due) {
    markNotified(db, d.id, today);
  }
  return due;
}

export function startReminders(deps: { cfg: Config; db: Db; bot: Bot }): void {
  const { cfg, db, bot } = deps;

  const schedule = `0 ${cfg.reminderHour} * * *`;
  cron.schedule(schedule, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let due: DueInstance[];
    try {
      due = collectReminders(db, today);
    } catch (err) {
      console.error('Не удалось собрать напоминания:', err);
      return;
    }

    for (const d of due) {
      const amount = d.amount_minor === null
        ? 'сумма плавающая — напиши фактическую'
        : formatMoney(d.amount_minor, d.currency);
      const overdue = d.due_date < today ? ' (просрочен)' : '';
      const kb = new InlineKeyboard().text('Оплачено', `paid:${d.id}`);
      try {
        await bot.api.sendMessage(
          cfg.ownerId!,
          `Платёж: ${d.title}\n${amount}\nСрок: ${d.due_date}${overdue}`,
          { reply_markup: kb },
        );
      } catch (err) {
        console.error(`Не отправилось напоминание ${d.id}:`, err);
      }
    }
  }, { timezone: cfg.timezone });

  console.log(`Напоминания включены: ежедневно в ${cfg.reminderHour}:00 (${cfg.timezone})`);
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/jobs tests/jobs
git commit -m "Ежедневные напоминания о платежах с защитой от повторов"
```

---

### Task 12: Наполнение реальными платежами и счетами

**Files:**
- Create: `src/db/seed-cli.ts`
- Modify: `package.json` (скрипт `seed`)

**Interfaces:**
- Consumes: `createAccount`, `createRecurring`
- Produces: CLI-команда `npm run seed`

- [ ] **Step 1: Написать скрипт наполнения**

Файл `src/db/seed-cli.ts`:

```typescript
import 'dotenv/config';
import { loadConfig } from '../config.ts';
import { openDatabase } from './index.ts';
import { runMigrations } from './migrations.ts';
import { createAccount, listAccounts } from '../core/accounts.ts';
import { createRecurring, listRecurring } from '../core/recurring.ts';

const cfg = loadConfig(process.env);
const db = openDatabase(cfg.databasePath);
runMigrations(db);

if (listAccounts(db).length > 0 || listRecurring(db).length > 0) {
  console.log('База уже наполнена — выхожу, чтобы не задвоить.');
  process.exit(0);
}

const bynCard = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
const bynCash = createAccount(db, { name: 'Наличные BYN', currency: 'BYN', kind: 'cash' });
const rubCard = createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
const usdSave = createAccount(db, { name: 'Сбережения USD', currency: 'USD', kind: 'deposit' });

const cat = (name: string): number | null => {
  const r = db.prepare("SELECT id FROM categories WHERE name = ? AND kind = 'expense'")
    .get(name) as { id: number } | undefined;
  return r?.id ?? null;
};

// Белорусская группа — 15-е число, BYN.
// Все создаются с плавающей суммой: точные величины владелец назовёт
// при первой оплате. Записать здесь ноль было бы враньём в данных.
const belarus: { title: string; category: string }[] = [
  { title: 'Аренда жилья', category: 'жильё'      },
  { title: 'Коммунальные',      category: 'коммуналка' },
  { title: 'Интернет',        category: 'интернет'   },
  { title: 'Мобильная связь', category: 'связь'      },
  { title: 'Спортзал', category: 'спорт'      },
];

for (const p of belarus) {
  createRecurring(db, {
    title: p.title,
    accountId: bynCard,
    categoryId: cat(p.category),
    amountMinor: null,
    currency: 'BYN',
    dayOfMonth: 15,
    isLastDay: false,
    isVariable: true,
    remindDaysBefore: 3,
  });
}

// Российская группа — последнее число месяца, RUB.
createRecurring(db, {
  title: 'Серверы',
  accountId: rubCard,
  categoryId: cat('серверы'),
  amountMinor: null,
  currency: 'RUB',
  dayOfMonth: null,
  isLastDay: true,
  isVariable: true,
  remindDaysBefore: 3,
});

console.log('Созданы счета:');
for (const a of listAccounts(db)) console.log(`  ${a.name} (${a.currency})`);
console.log('\nСозданы регулярные платежи:');
for (const r of listRecurring(db)) {
  const when = r.is_last_day ? 'последнее число' : `${r.day_of_month}-е число`;
  console.log(`  ${r.title} — ${when}, ${r.currency}${r.is_variable ? ', сумма плавающая' : ''}`);
}
console.log('\nСуммы фиксированных платежей задай через бота.');

db.close();
```

- [ ] **Step 2: Добавить скрипт в package.json**

```json
"seed": "tsx src/db/seed-cli.ts"
```

- [ ] **Step 3: Запустить и проверить**

Run: `npm run seed && npm run seed`
Expected: первый запуск создаёт 4 счёта и 6 платежей; второй печатает
«База уже наполнена» и ничего не дублирует.

- [ ] **Step 4: Коммит**

```bash
git add src/db/seed-cli.ts package.json
git commit -m "Наполнение базы реальными счетами и регулярными платежами"
```

---

### Task 13: Деплой на VPS

**Files:**
- Create: `deploy/fin-bot.service`, `deploy/deploy.sh`, `deploy/backup.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: собранный `dist/`
- Produces: работающий systemd-сервис `fin-bot` на VPS 203.0.113.10

- [ ] **Step 1: Написать systemd-юнит**

Файл `deploy/fin-bot.service`:

```ini
[Unit]
Description=Финансовый консультант — телеграм-бот
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=finbot
Group=finbot
WorkingDirectory=/opt/fin-bot
EnvironmentFile=/opt/fin-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

# Жёсткий потолок памяти: Claude Agent SDK запускает `claude` CLI
# подпроцессом, и без ограничения бот способен исчерпать RAM машины.
MemoryMax=700M
MemoryHigh=600M

# Ограничение прав: боту нужен только свой каталог.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/fin-bot/data /opt/fin-bot/backups

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Написать скрипт бэкапа**

Файл `deploy/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DB=/opt/fin-bot/data/finance.db
DEST=/opt/fin-bot/backups
STAMP=$(date +%Y%m%d-%H%M)

mkdir -p "$DEST"

# .backup корректно копирует базу в режиме WAL, в отличие от cp.
sqlite3 "$DB" ".backup '$DEST/finance-$STAMP.db'"
gzip -f "$DEST/finance-$STAMP.db"

# Держим 30 последних копий.
ls -1t "$DEST"/finance-*.db.gz | tail -n +31 | xargs -r rm --
echo "Бэкап готов: $DEST/finance-$STAMP.db.gz"
```

- [ ] **Step 3: Написать скрипт деплоя**

Файл `deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

HOST=${1:-root@203.0.113.10}
APP=/opt/fin-bot

echo "==> Сборка"
npm ci
npm run build

echo "==> Подготовка машины"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
id -u finbot >/dev/null 2>&1 || useradd --system --home /opt/fin-bot --shell /usr/sbin/nologin finbot
mkdir -p /opt/fin-bot/{data,backups}
command -v sqlite3 >/dev/null || (apt-get update -qq && apt-get install -y -qq sqlite3)
REMOTE

echo "==> Загрузка кода"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude data --exclude backups --exclude .env \
  dist package.json package-lock.json "$HOST:$APP/"

echo "==> Зависимости на сервере"
ssh "$HOST" "cd $APP && npm ci --omit=dev"

echo "==> Сервис"
scp deploy/fin-bot.service "$HOST:/etc/systemd/system/fin-bot.service"
scp deploy/backup.sh "$HOST:$APP/backup.sh"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
chmod +x $APP/backup.sh
chown -R finbot:finbot $APP
chmod 600 $APP/.env 2>/dev/null || true
systemctl daemon-reload
systemctl enable fin-bot
systemctl restart fin-bot
sleep 3
systemctl is-active fin-bot
REMOTE

echo "==> Готово. Логи: ssh $HOST journalctl -u fin-bot -f"
```

- [ ] **Step 4: Подготовить .env на сервере вручную**

Секреты не передаются скриптом деплоя намеренно — так они не попадут
ни в git, ни в историю команд.

```bash
ssh root@203.0.113.10 'mkdir -p /opt/fin-bot && cat > /opt/fin-bot/.env' <<'ENV'
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
OWNER_ID=<числовой id владельца>
BASE_CURRENCY=BYN
DATABASE_PATH=/opt/fin-bot/data/finance.db
TZ=Europe/Minsk
REMINDER_HOUR=10
CLAUDE_CODE_OAUTH_TOKEN=<вывод команды claude setup-token>
ENV
ssh root@203.0.113.10 'chmod 600 /opt/fin-bot/.env'
```

- [ ] **Step 5: Установить Claude CLI на сервере**

Agent SDK запускает `claude` как подпроцесс, поэтому CLI обязан быть в `PATH`.

Run: `ssh root@203.0.113.10 'npm install -g @anthropic-ai/claude-code && claude --version'`
Expected: печатается версия.

- [ ] **Step 6: Выполнить деплой**

Run: `chmod +x deploy/deploy.sh && ./deploy/deploy.sh`
Expected: последняя строка — `active`.

- [ ] **Step 7: Настроить cron для бэкапов**

```bash
ssh root@203.0.113.10 \
  '(crontab -l 2>/dev/null; echo "30 3 * * * /opt/fin-bot/backup.sh >> /var/log/fin-bot-backup.log 2>&1") | crontab -'
```

- [ ] **Step 8: Проверить, что бот отвечает**

Написать боту `/start` в Telegram.
Expected: приходит приветствие со списком команд.

Run: `ssh root@203.0.113.10 'systemctl status fin-bot --no-pager | head -12'`
Expected: `active (running)`, память заметно ниже 700M.

- [ ] **Step 9: Проверить, что посторонний не проходит**

Попросить любого другого человека написать боту.
Expected: бот молчит; в `journalctl -u fin-bot` нет обработки его сообщения.

- [ ] **Step 10: Дополнить README разделом о деплое и закоммитить**

```bash
git add deploy README.md
git commit -m "Деплой на VPS: systemd с лимитом памяти, бэкапы, скрипт выката"
git push
```

---

## Self-Review

**Покрытие спеки:**

| Требование спеки | Задача |
|---|---|
| Три слоя с жёсткой границей | 6, 8 (учёт) · 9 (разбор) · 10 (бот) |
| Деньги целыми числами | 2 |
| Мультивалютность с курсом на дату | 2, 5, 6 |
| Курсы НБРБ с делением на Cur_Scale | 5 |
| Модель данных со всеми таблицами | 4 |
| Переводы исключены из расходов | 6, 8 |
| Срок: число месяца или последнее | 3, 4, 7 |
| Подтверждение перед записью | 10 |
| Напоминания за N дней | 11 |
| Кнопка «Оплачено» | 10, 11 |
| Плавающие суммы | 7, 10, 12 |
| Очередь Claude с конкурентностью 1 | 9 |
| MemoryMax в systemd | 13 |
| Whitelist по числовому ID | 10 |
| Секреты вне git | 13 |
| Тесты границ месяца | 3, 7 |
| Отчёты и прогноз | 8 |

**Не покрыто планом намеренно:** консультант со свободными вопросами через
SQL-инструмент (`src/claude/consult.ts`). Он требует работающего учёта и данных,
поэтому выносится в отдельный план после первого месяца эксплуатации — на живых
данных будет видно, какие вопросы реально возникают. Команды `/addaccount` и
редактирование правил платежей также остаются на следующую итерацию;
до тех пор счета и правила заводятся через `npm run seed`.

**Проверка имён:** `openDatabase`, `runMigrations`, `createAccount`,
`accountBalance`, `recordTransaction`, `recordTransfer`, `totalInBase`,
`createRecurring`, `ensureInstances`, `dueSoon`, `markPaid`, `markNotified`,
`expensesByCategory`, `monthSummary`, `unpaidObligations`, `forecast`,
`Queue.run`, `parseTransaction`, `validateParsed`, `isOwner`, `createBot`,
`collectReminders`, `startReminders` — совпадают между определением и
использованием во всех задачах.

**Известная шероховатость:** `totalInBase` пересчитывает остаток по последнему
курсу, встреченному в транзакциях этого счёта. Для счёта без транзакций остаток
нулевой, поэтому курс не нужен. Для активного счёта это приближение достаточно
для прогноза, но не для точной переоценки — если понадобится, задача выносится
отдельно.
