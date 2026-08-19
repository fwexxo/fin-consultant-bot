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
  console.log('База уже наполнена — выхожу, чтобы ничего не задвоить.');
  process.exit(0);
}

const bynCard = createAccount(db, { name: 'Карта BYN', currency: 'BYN', kind: 'card' });
createAccount(db, { name: 'Наличные BYN', currency: 'BYN', kind: 'cash' });
const rubCard = createAccount(db, { name: 'Карта RUB', currency: 'RUB', kind: 'card' });
createAccount(db, { name: 'Сбережения USD', currency: 'USD', kind: 'deposit' });

const cat = (name: string): number | null => {
  const r = db.prepare("SELECT id FROM categories WHERE name = ? AND kind = 'expense'")
    .get(name) as { id: number } | undefined;
  return r?.id ?? null;
};

// Белорусская группа — 15-е число, BYN.
// Все заводятся с плавающей суммой: точные величины владелец назовёт
// при первой оплате. Записать сюда ноль было бы враньём в данных.
const belarus: { title: string; category: string }[] = [
  { title: 'Аренда жилья', category: 'жильё' },
  { title: 'Коммунальные', category: 'коммуналка' },
  { title: 'Интернет', category: 'интернет' },
  { title: 'Мобильная связь', category: 'связь' },
  { title: 'Спортзал', category: 'спорт' },
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
  console.log(`  ${r.title} — ${when}, ${r.currency}, сумма плавающая`);
}
console.log('\nТочные суммы бот спросит при первой оплате.');

db.close();
