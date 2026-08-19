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
  fx_rate_to_base    INTEGER NOT NULL,          -- курс к BYN × 1e8
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_minor > 0),
  -- перевод обязан указывать вторую сторону, обычная операция — не должна
  CHECK (direction <> 'transfer' OR counter_account_id IS NOT NULL),
  CHECK (direction =  'transfer' OR counter_account_id IS NULL)
);

CREATE INDEX idx_tx_ts       ON transactions(ts);
CREATE INDEX idx_tx_account  ON transactions(account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);

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
  -- срок задан ровно одним способом, не двумя и не нулём
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
