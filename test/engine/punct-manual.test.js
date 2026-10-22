'use strict';

/**
 * Checks derived from the punctuation manual (bases/reference/punct-manual.json):
 * the reference layer (manualRule, searchRules, Issue.manualRef) and every new
 * punctuation rule — positive examples, negative examples, confidence.
 * All sentences here are written for the tests; none come from the manual.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, describe, engine } = require('./helpers');
const worker = require('../../src/engine/worker');

const NBSP = ' ';

/** Issues of one paragraph filtered by ruleId. */
function run(text, ruleId, settings) {
  const { issues } = engine.check(doc([text]), settings);
  return ruleId ? issues.filter((is) => is.ruleId === ruleId) : issues;
}

/** Assert that `text` yields an issue of `ruleId` with the given before → after (and confidence). */
function expectFix(text, ruleId, before, after, confidence) {
  const hits = run(text, ruleId);
  const hit = hits.find((is) => is.before === before);
  assert.ok(hit, `expected ${ruleId} «${before}» in «${text}»\n${describe(run(text))}`);
  assert.equal(hit.after, after, `after for «${text}»`);
  if (confidence) assert.equal(hit.confidence, confidence, `confidence for «${text}»`);
  assert.ok(hit.why && hit.why.length > 10, `why for «${text}»`);
  assert.ok(hit.source, `source for «${text}»`);
  assert.ok(Array.isArray(hit.manualRef) && hit.manualRef.length && hit.manualRef.every((id) => engine.manualRule(id)), `manualRef for «${text}»: ${JSON.stringify(hit.manualRef)}`);
  for (const n of hit.ref) assert.ok(engine.rule(n), `ref § ${n} for «${text}»`);
  if (hit.ref.length) assert.match(hit.source, /^Правила 1956 · § \d+/, `source for «${text}»: ${hit.source}`);
  assert.equal(text.slice(hit.start, hit.end), hit.before, `before === slice for «${text}»`);
  return hit;
}

/** Assert that none of the texts produce an issue of `ruleId`. */
function expectClean(texts, ruleId) {
  for (const text of texts) {
    const hits = run(text, ruleId);
    assert.equal(hits.length, 0, `unexpected ${ruleId} in «${text}»:\n${describe(hits)}`);
  }
}

/* ---------- reference layer ---------- */

test('manual: manualRule() returns entries with url into the PDF, unknown id → null', async () => {
  await ready();
  const r = engine.manualRule('pm-dash-nouns');
  assert.ok(r);
  assert.equal(r.id, 'pm-dash-nouns');
  assert.equal(r.section, 'Тире между подлежащим и сказуемым');
  assert.ok(r.rule.length > 20 && Array.isArray(r.examples) && r.examples.length >= 1);
  assert.deepEqual(r.ref1956, [164]);
  assert.equal(r.page, 5);
  assert.match(r.url, /^https:\/\/xn--80aakd6ani0ae\.xn--p1ai\/.+\.pdf#page=5$/);
  assert.equal(engine.manualRule('pm-nope'), null);
  assert.equal(engine.manualRule(''), null);
  // every ref1956 of every entry exists in the 1956 rules
  for (const q of ['тире', 'запятая', 'обращение', 'прямая речь', 'цитата', 'двоеточие']) {
    for (const hit of engine.searchRules(q, 40).filter((x) => x.source === 'manual')) {
      const e = engine.manualRule(hit.id);
      for (const n of e.ref1956) assert.ok(engine.rule(n), `${e.id}: § ${n} missing`);
    }
  }
});

test('manual: searchRules() mixes 1956 paragraphs and manual entries, shape of manual hits', async () => {
  await ready();
  const res = engine.searchRules('тире подлежащее сказуемое', 10);
  assert.ok(res.length > 0 && res.length <= 10);
  const manual = res.filter((x) => x.source === 'manual');
  const rules = res.filter((x) => typeof x.n === 'number');
  assert.ok(manual.length >= 1, JSON.stringify(res));
  assert.ok(rules.some((x) => x.n === 164 || x.n === 165), JSON.stringify(res));
  for (const m of manual) {
    assert.equal(m.n, null);
    assert.match(m.id, /^pm-/);
    assert.equal(m.group, 'Пособие по пунктуации');
    assert.match(m.url, /\.pdf#page=\d+$/);
    assert.ok(m.section && m.snippet);
  }
  // existing expectations about the 1956 search still hold with the manual mixed in
  assert.equal(engine.searchRules('буква ё', 3)[0].n, 10);
  assert.ok(engine.searchRules('запятая придаточное главное').slice(0, 3).some((x) => x.n === 140));
  assert.deepEqual(engine.searchRules(''), []);
  const addr = engine.searchRules('обращение', 5);
  assert.equal(addr.length, 5);
  assert.ok(addr.every((x) => x.source === 'manual' || typeof x.n === 'number'));
});

test('manual: worker exposes manualRule; basesInfo lists the manual module', async () => {
  await ready();
  assert.ok(worker.METHODS.has('manualRule'));
  const reply = await worker.handle({ id: 1, method: 'manualRule', args: ['pm-yes-no'] });
  assert.ok(!reply.error && reply.result && reply.result.page === 18);
  const mod = engine.basesInfo().modules.find((m) => m.id === 'punct-manual');
  assert.ok(mod && mod.status === 'builtin' && /81/.test(mod.detail) && mod.toggle === false);
});

test('manual: issues from the manual carry manualRef, and source falls back to the manual section without a 1956 ref', async () => {
  await ready();
  const hit = expectFix('Москва столица России.', 'punct.dash-subject', 'Москва столица', `Москва${NBSP}— столица`, 'sure');
  assert.deepEqual(hit.manualRef, ['pm-dash-nouns']);
  assert.deepEqual(hit.ref, [164]);
  assert.equal(hit.source, 'Правила 1956 · § 164 · Тире');
  // uncertain=skip hides 'check' issues of the new rules too
  const sure = engine.check(doc(['Книга источник знаний.']), { uncertain: 'skip' });
  assert.ok(!sure.issues.some((is) => is.ruleId === 'punct.dash-subject'));
});

/* ---------- 1. dash between subject and predicate ---------- */

test('dash: two nominative nouns («Москва столица России»)', async () => {
  await ready();
  expectFix('Москва столица России.', 'punct.dash-subject', 'Москва столица', `Москва${NBSP}— столица`, 'sure');
  expectFix('Иванов директор завода.', 'punct.dash-subject', 'Иванов директор', `Иванов${NBSP}— директор`, 'sure');
  expectFix('Книга источник знаний.', 'punct.dash-subject', 'Книга источник', `Книга${NBSP}— источник`, 'check');
  expectFix('Старший брат мой учитель.', 'punct.dash-subject', 'брат мой', `брат${NBSP}— мой`, 'check');
  expectFix('Все люди братья.', 'punct.dash-subject', 'люди братья', `люди${NBSP}— братья`, 'check');
  expectClean([
    'Город Москва стоит на реке.', // apposition
    'Иван Петров пришёл домой.', // full name
    'Москва река широкая.', // «Москва-река»
    'Яндекс Метрика показывает визиты.', // product name
    'Она врач.', // personal pronoun
    'Бедность не порок.', // particle «не»
    'Город как муравейник.', // comparative conjunction
    'Товарищ майор вызывает вас.', // title
    'Кафе бар на углу закрыт.', // indeclinable compound
    'Дом культуры открыт до вечера.', // genitive
    'Тысяча человек пришла на концерт.',
    'Москва столица России?', // question
    'Запятая перед союзом ставится один раз.',
    'Мама купила хлеб и молоко.',
  ], 'punct.dash-subject');
  // headings are left alone
  const h = engine.check({ paragraphs: [{ text: 'Москва столица России', kind: 'h' }] });
  assert.ok(!h.issues.some((is) => is.ruleId === 'punct.dash-subject'));
});

test('dash: «это», «вот», «значит» («Жизнь прожить это не поле перейти»)', async () => {
  await ready();
  expectFix('Жизнь прожить это не поле перейти.', 'punct.dash-subject', 'прожить это', `прожить${NBSP}— это`, 'check');
  expectFix('Чтение это лучший отдых.', 'punct.dash-subject', 'Чтение это', `Чтение${NBSP}— это`, 'sure');
  expectFix('Москва это сердце страны.', 'punct.dash-subject', 'Москва это', `Москва${NBSP}— это`, 'sure');
  expectFix('Терпение вот что нам нужно.', 'punct.dash-subject', 'Терпение вот', `Терпение${NBSP}— вот`, 'check');
  expectFix('Жить значит бороться.', 'punct.dash-subject', 'Жить значит', `Жить${NBSP}— значит`, 'check');
  expectClean([
    'Мама это письмо получила вчера.',
    'Я видел это кино.',
    'Мне нравится это место.',
    'Всё это ерунда.',
    'Что это значит?',
    'Мы купили всё это вчера.',
  ], 'punct.dash-subject');
  // «значит» between infinitives is not reported as an intro word
  assert.equal(run('Жить значит бороться.', 'punct.intro').length, 0);
});

test('dash: infinitives and numerals («Курить вредить здоровью»)', async () => {
  await ready();
  expectFix('Курить вредить здоровью.', 'punct.dash-subject', 'Курить вредить', `Курить${NBSP}— вредить`, 'check');
  expectFix('Наша задача закончить проект к пятнице.', 'punct.dash-subject', 'задача закончить', `задача${NBSP}— закончить`, 'check');
  expectFix('Дважды два четыре.', 'punct.dash-subject', 'два четыре', `два${NBSP}— четыре`, 'check');
  expectFix('Длина маршрута двенадцать километров.', 'punct.dash-subject', 'маршрута двенадцать', `маршрута${NBSP}— двенадцать`, 'check');
  expectClean([
    'Начать работать было трудно.', // phase verb
    'Время собирать камни.',
    'Книга стоит сто рублей.',
    'Глава пятая.',
  ], 'punct.dash-subject');
});

/* ---------- 2. generalizing words ---------- */

test('generalizing word: colon before the list, dash after it', async () => {
  await ready();
  expectFix('В корзине было всё грибы, ягоды, орехи.', 'punct.general-colon', 'всё грибы', 'всё: грибы', 'check');
  expectFix('Везде на столе, на полу, на окнах лежала пыль.', 'punct.general-colon', 'Везде на', 'Везде: на', 'check');
  expectClean(['Мы купили всё это вчера.', 'Он всё лето провёл на даче.', 'Везде было тихо.', 'Все книги, тетради и ручки лежали на столе.'], 'punct.general-colon');
  expectFix('Ни дождь, ни ветер ничто не остановило путников.', 'punct.general-dash', 'ветер ничто', `ветер${NBSP}— ничто`, 'check');
  expectFix('Дом, работа, друзья всё осталось в прошлом.', 'punct.general-dash', 'друзья всё', `друзья${NBSP}— всё`, 'check');
  expectFix('Книги, посуда, одежда словом всё было упаковано.', 'punct.general-dash', 'одежда словом всё', `одежда${NBSP}— словом, всё`, 'check');
  expectClean(['Как известно, в городе всё спокойно.', 'Мы купили хлеб, молоко и всё остальное.', 'Конечно, всё хорошо.'], 'punct.general-dash');
});

/* ---------- 3. repeated and double conjunctions ---------- */

test('repeated conjunctions: и…и, ни…ни, или…или, то…то — but not idioms or different rows', async () => {
  await ready();
  expectFix('И дождь и ветер и холод не пугали нас.', 'punct.comma-repeated-conj', 'ветер и', 'ветер, и', 'check');
  expectFix('Ни он ни она не пришли.', 'punct.comma-repeated-conj', 'он ни', 'он, ни', 'check');
  expectFix('Или сегодня или никогда.', 'punct.comma-repeated-conj', 'сегодня или', 'сегодня, или', 'check');
  expectFix('То дождь то снег шёл весь день.', 'punct.comma-repeated-conj', 'дождь то', 'дождь, то', 'check');
  expectFix('Он пришёл и сел и начал есть.', 'punct.comma-repeated-conj', 'сел и', 'сел, и', 'check');
  expectClean([
    'Он явился ни свет ни заря.', // idiom
    'На праздник вышли и стар и млад.',
    'Мы купили хлеб и молоко и пошли домой.', // different rows
    'Прямоугольники и эллипсы с заливкой и радиусом.',
    'Сверяй размер до и после правки.',
    'И вдруг он понял и успокоился.', // sentence-initial «и»
    'Он знал то слово и то место.',
    'Мама купила хлеб и молоко.',
  ], 'punct.comma-repeated-conj');
});

test('double conjunctions: как … так и, если … то', async () => {
  await ready();
  expectFix('Как в городе так и в деревне люди ждали весны.', 'punct.comma-double-conj', 'городе так', 'городе, так', 'sure');
  expectFix('Если не сегодня то завтра.', 'punct.comma-double-conj', 'сегодня то', 'сегодня, то', 'sure');
  expectFix('Если пойдёт дождь то мы останемся дома.', 'punct.comma-double-conj', 'дождь то', 'дождь, то', 'sure');
  expectClean([
    'Как в городе, так и в деревне люди ждали весны.',
    'Если пойдёт дождь, то мы останемся дома.',
    'Он знал то слово.',
    'Если ты знаешь то слово, скажи.',
    'Как он так и не понял?',
    'Если хочешь, то есть и другой путь.',
  ], 'punct.comma-double-conj');
});

/* ---------- 4. comparative «как», «нежели» ---------- */

test('comparative «как» / «нежели»: comparisons and clauses are flagged as check, idioms and «в качестве» are not', async () => {
  await ready();
  expectFix('Он скорее умён нежели красив.', 'punct.comma-comparative', 'умён нежели', 'умён, нежели', 'sure');
  expectFix('Я видел как он уходил.', 'punct.comma-comparative', 'видел как', 'видел, как', 'check');
  expectFix('Я помню как мы встретились.', 'punct.comma-comparative', 'помню как', 'помню, как', 'check');
  expectFix('Шапка как и шарф была красной.', 'punct.comma-comparative', 'Шапка как', 'Шапка, как', 'check');
  expectFix('Дом стоял как крепость на холме.', 'punct.comma-comparative', 'стоял как', 'стоял, как', 'check');
  expectClean([
    'Текст читается как детектив.', // «читаться как» — manner, left alone
    'Она поёт как соловей.', // simile with an animal — usually manner of action, no comma
    'Он работал как вол.', // idiom
    'Он бледный как смерть.',
    'Будь как дома.',
    'Делай как следует.',
    'Мы как всегда опоздали.',
    'Он сделал всё как надо.',
    'Её пригласили как эксперта.', // в качестве
    'Он работал как инженер.',
    'Отчёт опубликован как артефакт.',
    'Смартфоном пользуются как справочником.',
    'Она отметила это как ошибку.',
    'Площадь как огромный каток.', // predicate
    'Он мне как брат.',
    'Результат как и ожидалось оказался нулевым.',
    'Он работал как лошадь.',
  ], 'punct.comma-comparative');
});

/* ---------- 5. addresses ---------- */

test('address at the start and at the end of a sentence', async () => {
  await ready();
  expectFix('Мама купи мороженое.', 'punct.address', 'Мама купи', 'Мама, купи', 'sure');
  expectFix('Ребята бегите сюда!', 'punct.address', 'Ребята бегите', 'Ребята, бегите', 'sure');
  expectFix('Друзья начинаем.', 'punct.address', 'Друзья начинаем', 'Друзья, начинаем', 'check');
  expectFix('Коллеги напоминаю о встрече.', 'punct.address', 'Коллеги напоминаю', 'Коллеги, напоминаю', 'check');
  expectFix('Ольга ты идёшь?', 'punct.address', 'Ольга ты', 'Ольга, ты', 'check');
  expectFix('Дорогие друзья поздравляю вас с праздником.', 'punct.address', 'друзья поздравляю', 'друзья, поздравляю', 'check');
  expectFix('Спасибо за помощь Иван.', 'punct.address', 'помощь Иван', 'помощь, Иван', 'check');
  expectFix('Приходи завтра Маша.', 'punct.address', 'завтра Маша', 'завтра, Маша', 'check');
  expectFix('Ты придёшь Маша?', 'punct.address', 'придёшь Маша', 'придёшь, Маша', 'check');
  expectClean([
    'Друзья помогли мне.',
    'Мама пришла домой.',
    'Иван принёс книгу.',
    'Это сделал Иван.',
    'Вы знаете, что сделал Иван?',
    'Маша и Петя идите сюда.', // a list before the verb — not handled, must stay silent
    'Мама мой брат пришёл.',
    'Вера пришла вовремя.',
    'Коллеги, напоминаю о встрече.',
  ], 'punct.address');
  // the address issue does not swallow the neighbouring «напоминаю, что» comma
  const both = run('Коллеги напоминаю что отчёт нужно сдать до пятницы.');
  assert.ok(both.some((is) => is.ruleId === 'punct.address'), describe(both));
  assert.ok(both.some((is) => is.ruleId === 'punct.comma-before-conj' && is.after === ', что'), describe(both));
});

/* ---------- 6. interjections, да/нет, что ж ---------- */

test('interjections, «да»/«нет», «что ж» at the start of a sentence', async () => {
  await ready();
  expectFix('Эй подождите меня!', 'punct.interjection', 'Эй подождите', 'Эй, подождите', 'sure');
  expectFix('Увы это так.', 'punct.interjection', 'Увы это', 'Увы, это', 'sure');
  expectFix('Ура мы победили!', 'punct.interjection', 'Ура мы', 'Ура, мы', 'sure');
  expectFix('Ох устал я сегодня.', 'punct.interjection', 'Ох устал', 'Ох, устал', 'check');
  expectClean([
    'Ах ты какой упрямый!', // particle
    'Ох уж эти дети.',
    'Ах какой ты молодец!',
    'Эй, подождите меня!',
    'Ну пошли.',
    'О море, как ты красиво!',
    'Увы и ах.',
  ], 'punct.interjection');
  expectFix('Да я согласен.', 'punct.yes-no', 'Да я', 'Да, я', 'check');
  expectFix('Нет так не пойдёт.', 'punct.yes-no', 'Нет так', 'Нет, так', 'check');
  expectFix('Нет я не пойду.', 'punct.yes-no', 'Нет я', 'Нет, я', 'check');
  expectFix('Что ж начнём.', 'punct.yes-no', 'ж начнём', 'ж, начнём', 'check');
  expectClean([
    'Да будет свет.',
    'Да ладно тебе.',
    'Да здравствует солнце!',
    'Нет времени объяснять.',
    'Нет ничего лучше дома.',
    'Что же ты наделал?',
    'Да, я согласен.',
  ], 'punct.yes-no');
});

/* ---------- 7. direct speech ---------- */

test('direct speech: colon before, comma and dash after', async () => {
  await ready();
  expectFix('Он сказал «Пора идти».', 'punct.speech-colon', 'сказал «', 'сказал: «', 'sure');
  expectFix('Она спросила «Ты успеешь?»', 'punct.speech-colon', 'спросила «', 'спросила: «', 'sure');
  expectFix('Он сказал, «Пора идти».', 'punct.speech-colon', ', «', ': «', 'sure');
  expectFix('Сервер отвечает «Элемент не найден» для чужих книг.', 'punct.speech-colon', 'отвечает «', 'отвечает: «', 'check');
  expectClean([
    'Он прочитал «Войну и мир».',
    'Он написал «Евгения Онегина».',
    'Фильм «Брат» вышел в 1997 году.',
    'Он сказал «да» и ушёл.', // lowercase — a mentioned word
    'Он сказал: «Пора идти».',
  ], 'punct.speech-colon');
  expectFix('«Пора идти» сказал он.', 'punct.speech-after', '» ', `»,${NBSP}— `, 'sure');
  expectFix('«Пора идти», сказал он.', 'punct.speech-after', '», ', `»,${NBSP}— `, 'sure');
  expectFix('«Пора идти,» сказал он.', 'punct.speech-after', ',» ', `»,${NBSP}— `, 'sure');
  expectFix('«Ты успеешь?» спросила она.', 'punct.speech-after', '» ', `»${NBSP}— `, 'sure');
  expectFix('«Ты успеешь?», — спросила она.', 'punct.speech-after', '», — ', '» — ', 'sure'); // the existing space before the dash is kept
  expectFix('«Пора идти» — сказал он.', 'punct.speech-after', '» — ', '», — ', 'sure');
  expectFix('«Да» сказал он.', 'punct.speech-after', '» ', `»,${NBSP}— `, 'check');
  expectClean([
    '«Пора идти», — сказал он.',
    `«Пора идти»,${NBSP}— сказал он.`,
    '«Ты успеешь?» — спросила она.',
    'Файл «Презентации» отвечает ошибкой.',
    'Книга «Идиот» написана Достоевским.',
  ], 'punct.speech-after');
  // applying the fix gives the reference spelling
  const fixed = engine.applyIssues(doc(['«Пора идти» сказал он.']), run('«Пора идти» сказал он.'));
  assert.equal(fixed.paragraphs[0].text, `«Пора идти»,${NBSP}— сказал он.`);
});

/* ---------- 8. gerunds, participles, «кроме» ---------- */

test('gerund phrases: sentence-initial and mid-sentence', async () => {
  await ready();
  expectFix('Улыбаясь она открыла дверь.', 'punct.gerund', 'Улыбаясь она', 'Улыбаясь, она', 'sure');
  expectFix('Прочитав книгу он уснул.', 'punct.gerund', 'книгу он', 'книгу, он', 'sure');
  expectFix('Открыв письмо мама заплакала.', 'punct.gerund', 'письмо мама', 'письмо, мама', 'check');
  expectFix('Он улыбаясь ответил на вопрос.', 'punct.gerund', 'Он улыбаясь ответил', 'Он, улыбаясь, ответил', 'check');
  expectFix('Он шёл улыбаясь.', 'punct.gerund', 'шёл улыбаясь', 'шёл, улыбаясь', 'check');
  expectFix('Он отложил книгу задумавшись о прошлом.', 'punct.gerund', 'книгу задумавшись', 'книгу, задумавшись', 'check');
  expectClean([
    'Он шёл не спеша.', // adverbialised
    'Он сидел молча.',
    'Он бежал сломя голову.',
    'Улыбаясь, она открыла дверь.',
    'Ушло ТРИ пуша.',
    'Катя открыла дверь.',
    'Он скорее умён, нежели красив.',
  ], 'punct.gerund');
});

test('participial phrase after the noun; «кроме / включая» phrases', async () => {
  await ready();
  expectFix('Статья опубликованная вчера вызвала споры.', 'punct.participle', 'Статья опубликованная вчера вызвала', 'Статья, опубликованная вчера, вызвала', 'check');
  expectFix('Письмо написанное наспех лежало на столе.', 'punct.participle', 'Письмо написанное наспех лежало', 'Письмо, написанное наспех, лежало', 'check');
  expectFix('Человек идущий навстречу улыбнулся.', 'punct.participle', 'Человек идущий навстречу улыбнулся', 'Человек, идущий навстречу, улыбнулся', 'check');
  expectClean([
    'Он читал написанную книгу.', // before the noun
    'Письмо, написанное наспех, лежало на столе.',
    'Данный документ является основой проекта.',
    'Мы обсудили опубликованные вчера статьи.',
  ], 'punct.participle');
  expectFix('Все кроме дежурного ушли домой.', 'punct.isolated-object', 'Все кроме', 'Все, кроме', 'check');
  expectFix('Расходы включая доставку оплатил заказчик.', 'punct.isolated-object', 'Расходы включая', 'Расходы, включая', 'check');
  expectFix('Никто кроме него не знал ответа.', 'punct.isolated-object', 'Никто кроме', 'Никто, кроме', 'check');
  expectClean([
    'Кроме того, мы опоздали.',
    'Он пошёл вместо меня.',
    'Это помимо прочего важно.',
    'Все, кроме дежурного, ушли домой.',
    'Кроме как здесь, нигде не было тихо.',
  ], 'punct.isolated-object');
});

/* ---------- regression: clean prose stays clean ---------- */

test('manual rules: ordinary prose produces no issues from the new rules', async () => {
  await ready();
  const NEW = ['punct.dash-subject', 'punct.general-colon', 'punct.general-dash', 'punct.comma-repeated-conj', 'punct.comma-double-conj', 'punct.comma-comparative', 'punct.address', 'punct.interjection', 'punct.yes-no', 'punct.speech-colon', 'punct.speech-after', 'punct.gerund', 'punct.participle', 'punct.isolated-object'];
  const { issues } = engine.check(doc([
    'Весной в городе открылся новый парк. Дорожки проложили вдоль реки, а на холме поставили беседку, откуда видно весь район.',
    'Директор школы Анна Сергеевна собрала учителей и родителей, чтобы обсудить расписание на следующий год.',
    `«Расписание готово», — сказала она и раздала листы. Учителя, как всегда, нашли, что поправить.`,
    'Мы купили хлеб, молоко и сыр, зашли в аптеку и вернулись домой до дождя. Папа римский в этот день выступал по телевизору.',
    'Пётр Иванович, наш сосед, работает инженером на заводе и каждое утро ездит туда на велосипеде.',
    'Если хочешь успеть, выходи заранее: автобусы ходят редко, и ждать приходится долго.',
    'Коллеги, напоминаю: отчёт сдаём в пятницу. Шаблон лежит в общей папке, инструкция там же.',
    'Да, это было давно. Нет, я ничего не забыл. Ах ты хитрец! Ну что ж, посмотрим.',
    'Он работал как проклятый, ел как птичка и спал как убитый. Читал он много, особенно по вечерам.',
    'Улыбаясь, Маша открыла дверь. Открыв окно, мы услышали, как во дворе играют дети.',
  ]));
  const bad = issues.filter((is) => NEW.includes(is.ruleId));
  assert.equal(bad.length, 0, describe(bad));
});

module.exports = { run, expectFix, expectClean };

test('compound sentence with «и»: subject + predicate after «и» → comma (§ 137); rows, shared conjunction, questions stay clean', async () => {
  await ready();
  expectFix('Поговорила с директором и он мне обещал позвонить вечером.', 'punct.comma-compound-and', 'директором и', 'директором, и', 'check');
  expectFix('Лестница закончилась и они прошли огромную арку.', 'punct.comma-compound-and', 'закончилась и', 'закончилась, и', 'sure');
  expectFix('Мне было 16 и я влюбилась в парня своей подруги.', 'punct.comma-compound-and', '16 и', '16, и', 'check');
  expectFix('Я ревела так долго и папа пошёл рыться в помойке.', 'punct.comma-compound-and', 'долго и', 'долго, и', 'check');
  expectFix('Остались аудиокассеты с нашими альбомами и вот в выходные я откопал две.', 'punct.comma-compound-and', 'альбомами и', 'альбомами, и', 'check');
  expectClean([
    'Мы купили хлеб и молоко и пошли домой.',
    'Мой коллега интересуется историей и часто посещает музеи и выставки.',
    'Когда он пришёл и мы сели ужинать, зазвонил телефон.',
    'Кто ты и что тебе нужно?',
    'Он встал и вышел.',
    'Я видел его и её.',
    'Мобильных тогда не было и звонила из телефонных будок.',
    'Лестница закончилась, и они прошли огромную арку.',
  ], 'punct.comma-compound-and');
});

test('repeated «и»: a single «и» between two members of one row is not a repeated conjunction', async () => {
  await ready();
  expectClean([
    'Мой коллега интересуется историей и часто посещает музеи и выставки.',
    'Серые дома и мостовые, угрюмые лица и беспросветные сумерки.',
    'Девушки и парни — это разные понятия, как лёд и огонь, коты и собаки.',
    'Её хочется хвалить снова и снова.',
    'Действия и результаты оказались полностью рассчитанными и предсказанными.',
    'Ни один из них нельзя считать ни полным, ни точным.',
    'Распределить по бумаге натёртый имбирь и цедру и сушить 30 минут.',
  ], 'punct.comma-repeated-conj');
  expectFix('Он и опять поднимался и опять делал то же.', 'punct.comma-repeated-conj', 'поднимался и', 'поднимался, и', 'check');
});
