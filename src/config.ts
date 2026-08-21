/**
 * Код валюты по ISO 4217.
 *
 * Не перечисление: список валют живёт в таблице currencies, чтобы
 * человек мог добавить свою без правки исходников. Проверка кода
 * происходит во время работы, а не при компиляции.
 */
export type Currency = string;

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

  // Пустой OWNER_ID — это режим начальной настройки, а не ошибка:
  // бот сообщит владельцу его id и на этом остановится.
  const rawOwner = env.OWNER_ID?.trim();
  let ownerId: number | null = null;
  if (rawOwner) {
    const parsed = Number(rawOwner);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`OWNER_ID должен быть положительным целым, получено: ${rawOwner}`);
    }
    ownerId = parsed;
  }

  // Базовая валюта отчётов. Проверяется по таблице currencies при старте.
  const baseCurrency = (env.BASE_CURRENCY?.trim() || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCurrency)) {
    throw new Error(`BASE_CURRENCY должен быть кодом из трёх букв, получено: ${baseCurrency}`);
  }

  const reminderHour = Number(env.REMINDER_HOUR?.trim() || '10');
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) {
    throw new Error(`REMINDER_HOUR должен быть целым 0-23, получено: ${env.REMINDER_HOUR}`);
  }

  return {
    botToken,
    ownerId,
    baseCurrency,
    databasePath: env.DATABASE_PATH?.trim() || './data/finance.db',
    reminderHour,
    timezone: env.TZ?.trim() || 'Europe/Minsk',
  };
}
