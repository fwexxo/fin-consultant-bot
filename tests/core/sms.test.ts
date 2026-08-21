import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSms } from '../../src/core/sms.ts';

const CARD = 'MIR-0000';

test('покупка за границей: списываются рубли, валюта покупки идёт в примечание', () => {
  const [r] = parseSms('Счёт карты MIR-0000 13:22 Покупка 14BYN (399.12р) CAFE EXAMPLE Баланс: 10 159.37р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'expense');
  assert.equal(r.amountRub, 399.12);
  assert.deepEqual(r.original, { amount: 14, currency: 'BYN' });
  assert.equal(r.merchant, 'CAFE EXAMPLE');
  assert.equal(r.balanceRub, 10 159.37);
  assert.equal(r.time, '13:22');
});

test('покупка с дробной валютной суммой', () => {
  const [r] = parseSms('Счёт карты MIR-0000 11:38 Покупка 9.80BYN (279.39р) TAXI Баланс: 10 558.49р', CARD);
  assert.ok(r);
  assert.equal(r.amountRub, 279.39);
  assert.deepEqual(r.original, { amount: 9.8, currency: 'BYN' });
  assert.equal(r.merchant, 'TAXI');
});

test('покупка по СБП в рублях без валютной вставки', () => {
  const [r] = parseSms('Счёт карты MIR-0000 10:23 Покупка по СБП 406р SHOP.EXAMPLE Баланс: 20 249.86р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'expense');
  assert.equal(r.amountRub, 406);
  assert.equal(r.original, undefined);
  assert.equal(r.merchant, 'SHOP.EXAMPLE');
});

test('оплата услуг с валютной вставкой', () => {
  const [r] = parseSms('Счёт карты MIR-0000 17:56 Оплата 137.03BYN (3924.43р) 100/200 UTILITYPAYMENT Баланс: 20 000.78р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'expense');
  assert.equal(r.amountRub, 3924.43);
  assert.equal(r.merchant, '100/200 UTILITYPAYMENT');
});

test('снятие наличных — отдельный вид, не расход', () => {
  const [r] = parseSms('Счёт карты MIR-0000 18:45 Выдача 50 000р ATM 60323204 Баланс: 20 914.4р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'cash_withdrawal');
  assert.equal(r.amountRub, 50000, 'неразрывный пробел в сумме должен схлопываться');
  assert.equal(r.balanceRub, 20 914.4);
});

test('возврат покупки — доход', () => {
  const [r] = parseSms('Счёт карты MIR-0000 10:26 возврат покупки 659р ДоставкаЕды Баланс: 10 831.19р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'income');
  assert.equal(r.amountRub, 659);
  assert.equal(r.merchant, 'ДоставкаЕды');
});

test('отмена покупки — доход', () => {
  const [r] = parseSms('Счёт карты MIR-0000 01:13 Отмена покупки 5582р SOME-MERCHANT Баланс: 10 760.22р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'income');
  assert.equal(r.amountRub, 5582);
});

test('обычный пробел в сумме тоже схлопывается', () => {
  const [r] = parseSms('Счёт карты MIR-0000 17:53 возврат покупки 659р Еда Баланс: 10 951.06р', CARD);
  assert.ok(r);
  assert.equal(r.balanceRub, 10 951.06);
});

test('чужой счёт игнорируется', () => {
  assert.deepEqual(
    parseSms('СЧЁТ5547 14:21 Зачисление зарплаты 29 897.92р Баланс: 51 914.4р', CARD),
    [],
  );
  assert.deepEqual(
    parseSms('Сбер.счёт *2085 15:50 Перевод 75 000.08р на СЧЁТ5547. Баланс счёта *2085: 0р, баланс *5547: 93 950.23р', CARD),
    [],
  );
});

test('не-транзакции игнорируются', () => {
  assert.deepEqual(
    parseSms('Никому не сообщайте код 7904 Списание 21.54BYN с MIR-0000 ombshop', CARD),
    [],
    'сообщение с кодом подтверждения не должно записываться',
  );
  assert.deepEqual(
    parseSms('Сергей Игоревич, просто напоминаем. Вы получаете зарплату на Сбер', CARD),
    [],
  );
  assert.deepEqual(parseSms('', CARD), []);
});

test('неизвестный вид операции не выдумывается', () => {
  assert.deepEqual(
    parseSms('Счёт карты MIR-0000 12:00 Блокировка 100р Банк Баланс: 500р', CARD),
    [],
    'незнакомую операцию лучше пропустить, чем угадать направление',
  );
});

test('сообщение без баланса отвергается', () => {
  assert.deepEqual(
    parseSms('Счёт карты MIR-0000 13:22 Покупка 14BYN (399.12р) CAFE EXAMPLE', CARD),
    [],
    'без баланса нельзя свериться с банком',
  );
});

test('мерчанта может не быть', () => {
  const [r] = parseSms('Счёт карты MIR-0000 22:34 Оплата 2000р Баланс: 1258.30р', CARD);
  assert.ok(r);
  assert.equal(r.amountRub, 2000);
  assert.equal(r.merchant, null);
});

test('внесение наличных в банкомат — не расход и не доход', () => {
  const [r] = parseSms('Счёт карты MIR-0000 17:34 зачисление 34 000р ATM 60209937 Баланс: 50 010.9р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'cash_deposit');
  assert.equal(r.amountRub, 34000);
  assert.equal(r.balanceRub, 50 010.9);
});

test('отложенное уведомление с датой перед временем', () => {
  const [r] = parseSms('Счёт карты MIR-0000 11.05.26 23:05 возврат покупки 1212.60р TICKETS-ONLINE Баланс: 20 821.42р', CARD);
  assert.ok(r);
  assert.equal(r.date, '2026-05-11', 'дата из СМС важнее даты получения');
  assert.equal(r.kind, 'income');
  assert.equal(r.amountRub, 1212.6);
  assert.equal(r.merchant, 'TICKETS-ONLINE');
});

test('покупка с выдачей наличных распадается на две операции', () => {
  const rows = parseSms(
    'Счёт карты MIR-0000 09:14 покупка с выдачей 109.99р SUPERMARKET 1234 покупка 9.99р выдача 100.00р Баланс: 122.34р',
    CARD,
  );
  assert.equal(rows.length, 2, 'это две разные операции, склеенные банком');

  assert.equal(rows[0]!.kind, 'expense');
  assert.equal(rows[0]!.amountRub, 9.99);
  assert.equal(rows[0]!.merchant, 'SUPERMARKET 1234');

  assert.equal(rows[1]!.kind, 'cash_withdrawal');
  assert.equal(rows[1]!.amountRub, 100);

  // Сумма частей обязана сойтись с общей, иначе баланс поедет
  assert.equal(rows[0]!.amountRub + rows[1]!.amountRub, 109.99);
});

test('обычное СМС даёт ровно одну операцию', () => {
  assert.equal(
    parseSms('Счёт карты MIR-0000 13:22 Покупка 14BYN (399.12р) CAFE EXAMPLE Баланс: 10 159.37р', CARD).length,
    1,
  );
});

test('возврат по СБП — тоже доход', () => {
  const [r] = parseSms('Счёт карты MIR-0000 12:45 Возврат покупки по СБП 600р Сервисы Примера Баланс: 10 645.35р', CARD);
  assert.ok(r);
  assert.equal(r.kind, 'income');
  assert.equal(r.amountRub, 600);
  assert.equal(r.merchant, 'Сервисы Примера');
});
