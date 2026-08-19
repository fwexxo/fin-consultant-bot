export type Currency = 'RUB' | 'BYN' | 'USD';

export const CURRENCIES: readonly Currency[] = ['RUB', 'BYN', 'USD'];

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
