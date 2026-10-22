'use strict';

/**
 * Set phrases (src/engine/idioms.js): the stray comma inside «и то, и другое», silence of the
 * repeated-conjunction and «как» rules inside idioms, explainSpan() for the interface, and the
 * Wiktionary-derived additions to conj.json / intro.json. All sentences are written for the tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ready, doc, describe, engine, BASES_DIR } = require('./helpers');
const idioms = require('../../src/engine/idioms');
const worker = require('../../src/engine/worker');

const WIKI_FILE = path.join(BASES_DIR, 'wiktionary', 'idioms.json');

function run(text, ruleId, settings) {
  const { issues } = engine.check(doc([text]), settings);
  return ruleId ? issues.filter((is) => is.ruleId === ruleId) : issues;
}

function expectFix(text, ruleId, before, after, confidence) {
  const hits = run(text, ruleId);
  const hit = hits.find((is) => is.before === before);
  assert.ok(hit, `expected ${ruleId} «${before}» in «${text}»\n${describe(run(text))}`);
  assert.equal(hit.after, after, `after for «${text}»`);
  if (confidence) assert.equal(hit.confidence, confidence, `confidence for «${text}»`);
  assert.equal(text.slice(hit.start, hit.end), hit.before, `before === slice for «${text}»`);
  assert.ok(hit.why && hit.why.length > 10, `why for «${text}»`);
  return hit;
}

function expectClean(texts, ruleId) {
  for (const text of texts) {
    const hits = run(text, ruleId);
    assert.equal(hits.length, 0, `unexpected ${ruleId} in «${text}»:\n${describe(hits)}`);
  }
}

/* ---------- 1. stray comma inside a cohesive pair ---------- */

test('idioms: «И то и другое нормально» is clean, «И то, и другое» loses the comma (sure, § 146)', async () => {
  await ready();
  expectClean(['И то и другое нормально: можно так и так.', 'Ни то ни сё.', 'Он был ни жив ни мёртв.'], 'punct.idiom-no-comma');
  assert.equal(run('И то и другое нормально: можно так и так.').filter((is) => is.category === 'punctuation').length, 0, describe(run('И то и другое нормально: можно так и так.')));
  const hit = expectFix('И то, и другое нормально.', 'punct.idiom-no-comma', 'то, и', 'то и', 'sure');
  assert.deepEqual(hit.ref, [146]);
  assert.match(hit.source, /^Правила 1956 · § 146/);
  assert.match(hit.why, /цельного выражения «и то и другое»/);
  assert.ok(hit.manualRef && hit.manualRef.includes('pm-homog-idioms') && engine.manualRule('pm-homog-idioms'), 'manualRef');
  assert.equal(hit.meta.idiom, 'и то и другое');
  // applying the fix gives the canonical text
  const fixed = engine.applyIssues(doc(['И то, и другое нормально.']), [hit]);
  assert.equal(fixed.paragraphs[0].text, 'И то и другое нормально.');
});

test('idioms: other § 146 pairs — ни свет, ни заря / ни рыба, ни мясо / и стар, и млад / ни жив, ни мёртв', async () => {
  await ready();
  expectFix('Он явился ни свет, ни заря.', 'punct.idiom-no-comma', 'свет, ни', 'свет ни', 'sure');
  expectFix('Этот план — ни рыба, ни мясо.', 'punct.idiom-no-comma', 'рыба, ни', 'рыба ни', 'sure');
  expectFix('На праздник пришли и стар, и млад.', 'punct.idiom-no-comma', 'стар, и', 'стар и', 'sure');
  expectFix('Он стоял ни жив, ни мёртв.', 'punct.idiom-no-comma', 'жив, ни', 'жив ни', 'sure');
  expectFix('Она сидела ни жива, ни мертва.'.replace('ни жива, ни мертва', 'ни жив, ни мертв'), 'punct.idiom-no-comma', 'жив, ни', 'жив ни', 'sure'); // е instead of ё
  expectFix('Мы крутили и так, и этак.', 'punct.idiom-no-comma', 'так, и', 'так и', 'sure');
  const hit = expectFix('Исчез ни с того, ни с сего.', 'punct.idiom-no-comma', 'того, ни', 'того ни', 'sure');
  assert.equal(hit.meta.conj, 'ни');
});

test('idioms: lists with three members, quoted text and real rows are not touched', async () => {
  await ready();
  expectClean([
    'Мы обсуждали и так, и этак, и сяк.', // a row of three — the commas are right
    'Он сказал: «Ни свет, ни заря», — и ушёл.', // inside quotes (skipQuotes)
    'Он любит и книги, и фильмы.', // not an idiom — the comma is right
    'Купили и хлеб, и молоко, и масло.',
    'То дождь, то снег шёл весь день.', // то…то — a row, not a pair
    'Ни он, ни она не пришли.',
  ], 'punct.idiom-no-comma');
});

/* ---------- 2. silence of the comma rules inside idioms ---------- */

test('idioms: the repeated-conjunction rule still fires for real rows and keeps quiet inside idioms', async () => {
  await ready();
  expectFix('Он любит и книги и фильмы.', 'punct.comma-repeated-conj', 'книги и', 'книги, и', 'check');
  expectFix('Ни он ни она не пришли.', 'punct.comma-repeated-conj', 'он ни', 'он, ни', 'check');
  expectClean([
    'Он явился ни свет ни заря.',
    'Он стоял ни жив ни мёртв.',
    'На праздник пришли и стар и млад.',
    'И то и другое нормально.',
    'Ни тот ни другой не ответил.',
    'Работали и день и ночь.',
    'Получилось ни то ни сё.',
    'Исчез ни с того ни с сего.',
    'Он был ни рыба ни мясо.',
  ], 'punct.comma-repeated-conj');
});

test('idioms: comparisons that became set phrases («как по маслу», «белый как снег») are not flagged', async () => {
  await ready();
  expectClean([
    'Жизнь их текла как по маслу.',
    'Всё прошло как по маслу.',
    'Платок был белый как снег.',
    'Он покраснел как рак.',
    'Она была бледна как смерть.',
    'Дождь лил как из ведра.',
    'Новость свалилась как снег на голову.',
    'Он знал город как свои пять пальцев.',
    'Они похожи как две капли воды.',
    'Он вёл себя как ни в чём не бывало.',
  ], 'punct.comma-comparative');
  // real comparisons and clauses are still flagged
  expectFix('Дом стоял как крепость на холме.', 'punct.comma-comparative', 'стоял как', 'стоял, как', 'check');
  expectFix('Я видел как он уходил.', 'punct.comma-comparative', 'видел как', 'видел, как', 'check');
});

/* ---------- 3. isIdiomSpan / explainSpan ---------- */

test('idioms: isIdiomSpan() covers phrases and respects commas written in the title', async () => {
  await ready();
  const t = 'Он явился ни свет ни заря и ушёл.';
  const i = t.indexOf('ни свет');
  assert.equal(idioms.isIdiomSpan(t, i, i + 'ни свет ни заря'.length), true);
  assert.equal(idioms.isIdiomSpan(t, i + 3, i + 10), true); // «свет ни» inside
  assert.equal(idioms.isIdiomSpan(t, i, t.indexOf('ушёл') + 4), false); // sticks out
  assert.equal(idioms.isIdiomSpan(t, 0, 2), false); // «Он»
  assert.equal(idioms.isIdiomSpan('', 0, 1), false);
  assert.equal(idioms.isIdiomSpan(t, 5, 5), false); // empty span
  // minWords: a 3-word phrase is not accepted when 4 are required
  const k = 'Всё шло как по маслу.';
  const kk = k.indexOf('как');
  assert.equal(idioms.isIdiomSpan(k, kk, kk + 3, 3), true);
  assert.equal(idioms.isIdiomSpan(k, kk, kk + 3, 4), false);
});

test('idioms: explainSpan() returns the phrase, a note and § for the interface; null elsewhere', async () => {
  await ready();
  const t = 'И то и другое нормально.';
  const r = engine.explainSpan(t, 2, 4);
  assert.ok(r, 'explanation expected');
  assert.equal(r.idiom, 'и то и другое');
  assert.deepEqual(r.ref, [146]);
  assert.match(r.note, /Запятая не нужна/);
  assert.match(r.note, /§ 146/);
  assert.equal(r.kind, 'repeated');
  assert.equal(t.slice(r.start, r.end), 'И то и другое');
  // a click (no end) inside «как по маслу»
  const k = 'Всё шло как по маслу.';
  const rk = engine.explainSpan(k, k.indexOf('маслу'));
  assert.ok(rk && rk.idiom === 'как по маслу' && rk.ref[0] === 150 && rk.kind === 'kak', JSON.stringify(rk));
  // selection sticking out of the phrase still finds it
  const rs = engine.explainSpan(k, 0, k.length);
  assert.ok(rs && rs.idiom === 'как по маслу', JSON.stringify(rs));
  assert.equal(engine.explainSpan('Просто текст без идиом.', 3), null);
  assert.equal(engine.explainSpan('Просто текст.', 100), null);
  assert.throws(() => engine.explainSpan(null, 0), TypeError);
  assert.throws(() => engine.explainSpan('текст', 'x'), TypeError);
  // exposed through the worker
  assert.ok(worker.METHODS.has('explainSpan'));
  const reply = await worker.handle({ id: 7, method: 'explainSpan', args: [t, 2, 4] });
  assert.equal(reply.id, 7);
  assert.equal(reply.result.idiom, 'и то и другое');
  const none = await worker.handle({ id: 8, method: 'explainSpan', args: ['Просто текст.', 1] });
  assert.equal(none.result, null);
});

test('idioms: basesInfo() lists the Wiktionary module', async () => {
  await ready();
  const m = engine.basesInfo().modules.find((x) => x.id === 'wiktionary');
  assert.ok(m, 'module row');
  assert.match(m.title, /Викисловарь/);
  const present = fs.existsSync(WIKI_FILE);
  assert.equal(m.status, present ? 'builtin' : 'missing');
  if (present) assert.match(m.detail, /устойчивых сочетаний .* союзов .* вводных слов .* CC BY-SA 4\.0/);
});

/* ---------- 4. Wiktionary data (only when bases/wiktionary/ is built) ---------- */

test('idioms: Wiktionary file — shape, licence, thousands of phrases, definitions and urls', { skip: !fs.existsSync(WIKI_FILE) && 'bases/wiktionary/idioms.json not built' }, async () => {
  await ready();
  const data = JSON.parse(fs.readFileSync(WIKI_FILE, 'utf8'));
  assert.match(data.license, /CC BY-SA 4\.0/);
  assert.ok(data.count >= 5000, `count ${data.count}`);
  assert.equal(data.count, data.items.length);
  for (const it of data.items.slice(0, 500)) {
    assert.equal(typeof it.t, 'string');
    assert.ok(it.t.length >= 3);
    assert.match(it.url, /^https:\/\/ru\.wiktionary\.org\/wiki\//);
    assert.ok(it.d.length <= 201, `definition too long: ${it.t}`);
  }
  const byTitle = new Map(data.items.map((it) => [it.t, it]));
  for (const t of ['ни свет ни заря', 'как по маслу', 'ни то ни сё', 'и так и этак', 'как снег на голову']) assert.ok(byTitle.has(t), `missing «${t}»`);
  assert.match(byTitle.get('ни свет ни заря').d, /рано/);
  // a Wiktionary-only phrase is used by the engine: explanation carries the definition and the url
  const r = engine.explainSpan('Он явился ни свет ни заря.', 11);
  assert.ok(r && r.definition && r.url.includes('wiktionary'), JSON.stringify(r));
  const info = idioms.info();
  assert.ok(info.available && info.count >= 5000 && info.total > info.count, JSON.stringify(info));
});

test('idioms: Wiktionary-only phrases with repeated conjunctions silence the comma rule and lose a stray comma', { skip: !fs.existsSync(WIKI_FILE) && 'bases/wiktionary/idioms.json not built' }, async () => {
  await ready();
  // these pairs are not in the built-in list — they come from the Wiktionary file (the test picks them from the data)
  const data = JSON.parse(fs.readFileSync(WIKI_FILE, 'utf8'));
  const pairs = data.items.map((it) => it.t).filter((t) => /^(и|ни) [а-яё-]+ \1 [а-яё-]+$/.test(t) && !/[,;]/.test(t));
  assert.ok(pairs.length >= 10, `only ${pairs.length} pairs in the data`);
  let checked = 0;
  let enriched = 0;
  for (const t of pairs) {
    const r = idioms.explainSpan(`Это ${t} сегодня.`, 4, 4 + t.length);
    assert.ok(r && r.idiom.toLowerCase() === t.toLowerCase(), `explainSpan for «${t}»: ${JSON.stringify(r)}`);
    assert.match(r.source, /Викисловарь/, `source for «${t}»`);
    if (r.origin !== 'wiktionary') { enriched++; continue; } // also in the built-in list — gets the Wiktionary url/definition
    const [c, a, , b] = t.split(' ');
    expectClean([`Это ${t} сегодня.`], 'punct.comma-repeated-conj');
    expectFix(`Это ${c} ${a}, ${c} ${b} сегодня.`, 'punct.idiom-no-comma', `${a}, ${c}`, `${a} ${c}`);
    if (++checked >= 15) break;
  }
  assert.ok(checked >= 2, `checked only ${checked} Wiktionary-only pairs`);
  assert.ok(enriched >= 3, `built-in pairs enriched from Wiktionary: ${enriched}`);
  // a built-in phrase present in Wiktionary carries the Wiktionary url in the fix card
  const hit = expectFix('Он явился ни свет, ни заря.', 'punct.idiom-no-comma', 'свет, ни', 'свет ни', 'sure');
  assert.match(hit.source, /Викисловарь/);
  assert.match(hit.meta.url, /wiktionary/);
});

/* ---------- 5. conj / intro additions from Wiktionary ---------- */

test('idioms: Wiktionary entries merged into conj.json / intro.json have source and no duplicates', async () => {
  await ready();
  const conj = JSON.parse(fs.readFileSync(path.join(BASES_DIR, 'rules', 'conj.json'), 'utf8'));
  const intro = JSON.parse(fs.readFileSync(path.join(BASES_DIR, 'rules', 'intro.json'), 'utf8'));
  const texts = (list) => list.map((it) => it.text.toLowerCase());
  for (const list of [texts(conj.subordinating), texts(conj.adversative), texts(intro.items)]) {
    assert.equal(new Set(list).size, list.length, `duplicates: ${list.filter((t, i) => list.indexOf(t) !== i).join(', ')}`);
  }
  const wikiIntro = intro.items.filter((it) => it.source === 'wiktionary');
  const wikiConj = conj.subordinating.filter((it) => it.source === 'wiktionary');
  if (!fs.existsSync(WIKI_FILE)) return; // nothing merged yet
  assert.ok(wikiIntro.length >= 5, `intro from wiktionary: ${wikiIntro.length}`);
  assert.ok(wikiConj.length >= 3, `conj from wiktionary: ${wikiConj.length}`);
  for (const it of wikiIntro) assert.equal(it.confidence, 'check', `new intro words are 'check': ${it.text}`);
  for (const it of wikiConj) assert.equal(it.confidence, 'check', `new conjunctions are 'check': ${it.text}`);
});

test('idioms: new intro words from Wiktionary are separated (check) and their homonyms are left alone', { skip: !fs.existsSync(WIKI_FILE) && 'bases/wiktionary not built' }, async () => {
  await ready();
  expectFix('Он дескать не знал.', 'punct.intro', 'Он дескать не', 'Он, дескать, не', 'check');
  expectFix('Мол не виноват.', 'punct.intro', 'Мол не', 'Мол, не', 'check');
  expectFix('Кажись дождь собирается.', 'punct.intro', 'Кажись дождь', 'Кажись, дождь', 'check');
  expectFix('Иными словами проект закрыт.', 'punct.intro', 'Иными словами проект', 'Иными словами, проект', 'check');
  expectFix('По идее всё должно работать.', 'punct.intro', 'По идее всё', 'По идее, всё', 'check');
  expectFix('Он бывало сидел у окна.', 'punct.intro', 'Он бывало сидел', 'Он, бывало, сидел', 'check');
  expectFix('Вероятнее всего мы опоздаем.', 'punct.intro', 'Вероятнее всего мы', 'Вероятнее всего, мы', 'check');
  expectFix('В-шестых нужен бюджет.', 'punct.intro', 'В-шестых нужен', 'В-шестых, нужен', 'check');
  expectClean([
    'Мы положим книгу на стол.', // verb, not «положим,»
    'По идее автора книга короткая.', // «по идее» + genitive
    'Такого не бывало.', // «не бывало»
    'Он вошёл как ни в чём не бывало.',
    'Знамо дело.', // «знамо дело» is one phrase
    'Волны бились о мол.', // the noun «мол»
  ], 'punct.intro');
});

test('idioms: new conjunctions from Wiktionary get a comma before them (check)', { skip: !fs.existsSync(WIKI_FILE) && 'bases/wiktionary not built' }, async () => {
  await ready();
  expectFix('Мы ускорили сборку благодаря чему релиз вышел раньше.', 'punct.comma-before-conj', 'сборку благодаря', 'сборку, благодаря', 'check');
  expectFix('Я остался потому как было поздно.', 'punct.comma-before-conj', 'остался потому', 'остался, потому', 'check');
  expectFix('Приходи коли хочешь.', 'punct.comma-before-conj', 'Приходи коли', 'Приходи, коли', 'check');
  const hit = expectFix('Он спорил причём громко.', 'punct.comma-adversative', 'спорил причём', 'спорил, причём', 'check');
  assert.match(hit.why, /присоединительным союзом «причём»/);
  assert.deepEqual(hit.ref, [138]);
  expectClean(['Причём тут я?', 'Коли дрова, пока светло.'], 'punct.comma-adversative');
});
