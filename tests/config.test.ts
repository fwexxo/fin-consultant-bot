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
  assert.equal(cfg.baseCurrency, 'BYN');
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

test('нечисловой OWNER_ID отвергается, а не превращается в NaN', () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: 'a', OWNER_ID: 'fwexxo' } as NodeJS.ProcessEnv),
    /OWNER_ID/,
  );
});

test('значения по умолчанию подставляются', () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: 'a' } as NodeJS.ProcessEnv);
  assert.equal(cfg.reminderHour, 10);
  assert.equal(cfg.timezone, 'Europe/Minsk');
  assert.equal(cfg.databasePath, './data/finance.db');
});
