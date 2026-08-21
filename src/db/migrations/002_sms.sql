-- Журнал принятых СМС.
--
-- Одно сообщение может породить несколько операций (покупка с выдачей
-- наличных), поэтому связь один-ко-многим, а не колонка в transactions.
-- source_id — это ROWID сообщения в базе Messages: он не меняется и
-- служит защитой от повторной записи при перезапуске наблюдателя.
CREATE TABLE sms_ingested (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,        -- 'imessage'
  source_id   TEXT    NOT NULL,        -- ROWID сообщения
  tx_id       INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  raw         TEXT    NOT NULL,        -- исходный текст, чтобы можно было разобраться
  ingested_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sms_lookup ON sms_ingested(source, source_id);

-- Сверка с банком: банк присылает свой остаток, и расхождение с нашим
-- расчётом — сигнал, что операция потерялась или записана дважды.
CREATE TABLE balance_checks (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  checked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  bank_minor   INTEGER NOT NULL,       -- остаток по версии банка
  ours_minor   INTEGER NOT NULL,       -- наш расчёт
  drift_minor  INTEGER NOT NULL        -- разница; ноль означает сходимость
);

CREATE INDEX idx_balance_checks_acc ON balance_checks(account_id, checked_at);
