'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, engine, initMs } = require('./helpers');

const BASE = [
  'Вчера вечером мы собрались в небольшом кафе на Покровке что бы обсудить план нового проекта. Как и ожидалось, разговор затянулся до поздна: каждый хотел высказатся, но мало кто слушал других.',
  'В среду правительство утвердило план развития городского транспорта до 2030 года. Документ предусматривает строительство трёх новых линий метро, обновление автобусного парка и запуск сети выделенных полос на главных магистралях.',
  'Дождь шёл с самого утра, и к полудню улица превратилась в мутный ручей. Марина стояла у окна, прижав ладонь к холодному стеклу, и смотрела, как редкие прохожие перебегают от подъезда к подъезду.',
  'В рамках данного проекта командой было принято решение осуществить проведение серии встреч с читателями. Данные встречи являются важным инструментом, который позволяет нам получать обратную связь.',
  'Коллеги, напоминаю что отчёт за третий квартал нужно сдать до пятницы. Шаблон лежит в общей папке, там же - инструкция по заполнению. Если у вас возникнут вопросы по цифрам, пишите Ольге: она отвечает за сводную таблицу.',
  'Отдельно прошу проверить контакты клиентов в базе. В прошлом месяце мы потеряли два заказа из-за неверных адресов, и повторять этот опыт не хочется. Спасибо всем, кто уже обновил данные.',
];

function repeatTo(chars) {
  const out = [];
  let n = 0;
  while (n < chars) {
    for (const p of BASE) {
      out.push(p);
      n += p.length;
    }
  }
  return out;
}

test('perf: init ≤ 1.5 s', async () => {
  await ready();
  assert.ok(initMs() <= 1500, `init took ${initMs()} ms`);
});

test('perf: check of ~3 000 chars ≤ 300 ms', async () => {
  await ready();
  const paras = repeatTo(3000);
  const d = doc(paras);
  engine.check(d); // warm caches like a real session would
  const t = Date.now();
  const res = engine.check(d);
  const ms = Date.now() - t;
  assert.ok(res.stats.chars >= 3000);
  assert.ok(ms <= 300, `check took ${ms} ms`);
});

test('perf: check of ~300 000 chars (a book) ≤ 30 s', async () => {
  await ready();
  const paras = repeatTo(300000);
  const d = doc(paras);
  const t = Date.now();
  const res = engine.check(d);
  const ms = Date.now() - t;
  assert.ok(res.stats.chars >= 300000, `chars ${res.stats.chars}`);
  assert.ok(ms <= 30000, `check took ${ms} ms`);
  assert.ok(res.issues.length > 100);
});

test('perf: literary of ~300 000 chars ≤ 30 s', async () => {
  await ready();
  const d = doc(repeatTo(300000));
  const t = Date.now();
  const res = engine.literary(d);
  const ms = Date.now() - t;
  assert.ok(ms <= 30000, `literary took ${ms} ms`);
  assert.ok(res.score >= 0 && res.score <= 10);
});
