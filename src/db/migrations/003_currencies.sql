-- Валюты становятся данными, а не жёстким списком в схеме.
--
-- Раньше допустимые валюты были прибиты в CHECK-ограничениях четырёх
-- таблиц: добавить свою было нельзя без правки исходников. SQLite не
-- умеет менять CHECK, поэтому таблицы пересобираются целиком.
--
-- minor_units хранится у каждой валюты, потому что «сто копеек в рубле»
-- верно не везде: у иены дробной части нет, у динара их тысяча.

CREATE TABLE currencies (
  code        TEXT PRIMARY KEY,                    -- ISO 4217, например USD
  name        TEXT NOT NULL,
  minor_units INTEGER NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, name, minor_units) VALUES
  ('USD','Доллар США',2),        ('EUR','Евро',2),
  ('RUB','Российский рубль',2),  ('BYN','Белорусский рубль',2),
  ('GBP','Фунт стерлингов',2),   ('CHF','Швейцарский франк',2),
  ('PLN','Польский злотый',2),   ('CZK','Чешская крона',2),
  ('UAH','Гривна',2),            ('KZT','Тенге',2),
  ('GEL','Лари',2),              ('AMD','Драм',2),
  ('AZN','Манат',2),             ('TRY','Турецкая лира',2),
  ('RSD','Сербский динар',2),    ('CNY','Юань',2),
  ('INR','Рупия',2),             ('AED','Дирхам ОАЭ',2),
  ('THB','Бат',2),               ('CAD','Канадский доллар',2),
  ('AUD','Австралийский доллар',2), ('SEK','Шведская крона',2),
  ('NOK','Норвежская крона',2),  ('ILS','Шекель',2),
  ('JPY','Иена',0),              ('KRW','Вона',0),
  ('HUF','Форинт',0),            ('CLP','Чилийское песо',0),
  ('ISK','Исландская крона',0),  ('VND','Донг',0),
  ('BHD','Бахрейнский динар',3), ('KWD','Кувейтский динар',3),
  ('OMR','Оманский риал',3),     ('TND','Тунисский динар',3);

-- ---- accounts ----
CREATE TABLE accounts_new (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  currency    TEXT    NOT NULL REFERENCES currencies(code),
  kind        TEXT    NOT NULL CHECK (kind IN ('cash','card','deposit')),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO accounts_new SELECT id,name,currency,kind,is_active,created_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- ---- transactions ----
CREATE TABLE transactions_new (
  id                 INTEGER PRIMARY KEY,
  ts                 TEXT    NOT NULL,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  amount_minor       INTEGER NOT NULL,
  currency           TEXT    NOT NULL REFERENCES currencies(code),
  category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  direction          TEXT    NOT NULL
                     CHECK (direction IN ('expense','income','transfer_out','transfer_in')),
  counter_account_id INTEGER REFERENCES accounts(id),
  note               TEXT,
  raw_text           TEXT,
  fx_rate_to_base    INTEGER NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_minor > 0),
  CHECK ((direction IN ('transfer_out','transfer_in') AND counter_account_id IS NOT NULL)
      OR (direction IN ('expense','income')          AND counter_account_id IS NULL))
);
INSERT INTO transactions_new SELECT id,ts,account_id,amount_minor,currency,category_id,
  direction,counter_account_id,note,raw_text,fx_rate_to_base,created_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_tx_ts       ON transactions(ts);
CREATE INDEX idx_tx_account  ON transactions(account_id);
CREATE INDEX idx_tx_category ON transactions(category_id);

-- ---- recurring_payments ----
CREATE TABLE recurring_payments_new (
  id                 INTEGER PRIMARY KEY,
  title              TEXT    NOT NULL,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount_minor       INTEGER,
  currency           TEXT    NOT NULL REFERENCES currencies(code),
  day_of_month       INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  is_last_day        INTEGER NOT NULL DEFAULT 0 CHECK (is_last_day IN (0,1)),
  is_variable        INTEGER NOT NULL DEFAULT 0 CHECK (is_variable IN (0,1)),
  remind_days_before INTEGER NOT NULL DEFAULT 3 CHECK (remind_days_before >= 0),
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK ((day_of_month IS NOT NULL AND is_last_day = 0)
      OR (day_of_month IS NULL     AND is_last_day = 1)),
  CHECK (is_variable = 1 OR amount_minor IS NOT NULL)
);
INSERT INTO recurring_payments_new SELECT id,title,account_id,category_id,amount_minor,
  currency,day_of_month,is_last_day,is_variable,remind_days_before,is_active,created_at
  FROM recurring_payments;
DROP TABLE recurring_payments;
ALTER TABLE recurring_payments_new RENAME TO recurring_payments;

-- ---- budgets ----
CREATE TABLE budgets_new (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      TEXT    NOT NULL,
  limit_minor INTEGER NOT NULL CHECK (limit_minor > 0),
  currency    TEXT    NOT NULL REFERENCES currencies(code),
  UNIQUE (category_id, period)
);
INSERT INTO budgets_new SELECT id,category_id,period,limit_minor,currency FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;

-- payment_instances ссылается на recurring_payments, пересозданную выше:
-- пересобираем и её, чтобы внешний ключ указывал на новую таблицу.
CREATE TABLE payment_instances_new (
  id           INTEGER PRIMARY KEY,
  recurring_id INTEGER NOT NULL REFERENCES recurring_payments(id) ON DELETE CASCADE,
  period       TEXT    NOT NULL,
  due_date     TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','paid','skipped')),
  paid_tx_id   INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  notified_on  TEXT,
  UNIQUE (recurring_id, period)
);
INSERT INTO payment_instances_new SELECT id,recurring_id,period,due_date,status,paid_tx_id,notified_on
  FROM payment_instances;
DROP TABLE payment_instances;
ALTER TABLE payment_instances_new RENAME TO payment_instances;

CREATE INDEX idx_pi_status_due ON payment_instances(status, due_date);
