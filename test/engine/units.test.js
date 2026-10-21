'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, describe, engine } = require('./helpers');
const tokenize = require('../../src/engine/tokenize');
const worker = require('../../src/engine/worker');

const NBSP = ' ';

function one(paras, pred, settings) {
  const { issues } = engine.check(doc(paras), settings);
  const hit = issues.find(pred);
  return { hit, issues };
}

test('tokenize: sentences, abbreviations, decimals, quotes', () => {
  const text = 'Это было в 2026 г. в Москве, т. е. давно. Цена 3.5 млн. Он спросил: «Ты идёшь?» Она кивнула... И ушла!';
  const { sentences } = tokenize.analyze(text);
  const texts = sentences.map((s) => text.slice(s.start, s.end));
  assert.equal(texts[0], 'Это было в 2026 г. в Москве, т. е. давно.');
  // «млн.» is an abbreviation, so the period after it does not end the sentence
  assert.ok(texts.some((t) => t.startsWith('Цена 3.5 млн.') && t.endsWith('«Ты идёшь?»')), JSON.stringify(texts));
  assert.equal(texts[texts.length - 1], 'И ушла!');
  assert.equal(texts.length, 4);
  assert.deepEqual(tokenize.quoteSpans('Он сказал "привет" и «пока „да“ нет»'), [[10, 18], [27, 31], [21, 36]]);
  assert.deepEqual(tokenize.speechSpans('— Привет, — сказал он, — что делаешь?'), [[2, 9], [25, 37]]);
  const toks = tokenize.tokenize('Кто-то пришёл в 15:30, из-за угла.').filter((t) => t.type !== 'space').map((t) => `${t.type}:${t.text}`);
  assert.deepEqual(toks, ['word:Кто-то', 'word:пришёл', 'word:в', 'num:15', 'punct::', 'num:30', 'punct:,', 'word:из-за', 'word:угла', 'punct:.']);
});

test('spelling: phrase rules respect their conditions', async () => {
  await ready();
  assert.ok(one(['Мы пришли из за дождя.'], (is) => is.before === 'из за' && is.after === 'из-за').hit);
  assert.ok(one(['Он не придёт, что бы ни случилось.'], (is) => is.before === 'что бы').hit === undefined);
  assert.ok(one(['Что бы вы хотели заказать?'], (is) => is.before === 'Что бы').hit === undefined);
  assert.ok(one(['Нужно иметь в виду сроки.'], (is) => is.before === 'в виду').hit === undefined);
  assert.ok(one(['Мы опоздали в виду того, что было темно.'], (is) => is.before === 'в виду того').hit);
  assert.ok(one(['Она стояла, не смотря на него.'], (is) => is.before.startsWith('не смотря')).hit === undefined);
  assert.ok(one(['Кто нибудь видел ключи?'], (is) => is.after === 'Кто-нибудь').hit);
  assert.ok(one(['Он говорит по русски.'], (is) => is.after === 'по-русски').hit);
  assert.ok(one(['Письмо ушло по новому адресу.'], (is) => is.before === 'по новому').hit === undefined);
  assert.ok(one(['Вообщем, всё получилось.'], (is) => is.before === 'Вообщем' && is.after === 'В общем').hit);
});

test('spelling: unknown words, suggestions, user dictionary, extra list', async () => {
  await ready();
  const a = one(['Сабака лаяла всю ночь.'], (is) => is.ruleId === 'spell.unknown');
  assert.ok(a.hit && a.hit.after === 'Собака');
  assert.ok(a.hit.ref.includes(11));
  const b = one(['Мы обсудили онбординг и дедлайны по лонгриду.'], (is) => is.category === 'spelling');
  assert.equal(b.hit, undefined, describe(b.issues));
  const c = one(['Это был настоящий флибустьерщик.'], (is) => is.category === 'spelling');
  assert.ok(c.hit);
  engine.setUserWords(['Флибустьерщик']);
  const d = one(['Это был настоящий флибустьерщик.'], (is) => is.category === 'spelling');
  assert.equal(d.hit, undefined);
  engine.setUserWords([]);
  const e = one(['Мы коментируем праграмму.'], (is) => is.before === 'коментируем');
  assert.ok(e.hit && e.hit.after === 'комментируем');
  const f = one(['Он придти не смог.'], (is) => is.before === 'придти');
  assert.ok(f.hit && f.hit.after === 'прийти');
});

test('punctuation: conjunctions, intro words, однако, ли, prepositions', async () => {
  await ready();
  assert.ok(one(['Он сказал что придёт.'], (is) => is.before === 'сказал что' && is.after === 'сказал, что' && is.confidence === 'sure').hit);
  assert.ok(one(['Это дом в котором мы жили.'], (is) => is.before === 'дом в' && is.after === 'дом, в').hit);
  assert.ok(one(['Конечно мы придём.'], (is) => is.before === 'Конечно мы' && is.after === 'Конечно, мы' && is.ref[0] === 155).hit);
  assert.ok(one(['Мы, конечно придём.'], (is) => is.before === 'конечно придём' && is.after === 'конечно, придём').hit);
  assert.ok(one(['Не знаю приду ли я.'], (is) => is.ruleId === 'punct.comma-li' && is.after === 'знаю, приду').hit);
  assert.ok(one(['Однако, мы опоздали.'], (is) => is.ruleId === 'punct.odnako-start' && is.after === 'Однако').hit);
  assert.ok(one(['Он устал но продолжал идти.'], (is) => is.before === 'устал но' && is.after === 'устал, но').hit);
  assert.ok(one(['Мы ушли потому что было поздно.'], (is) => is.before === 'ушли потому' && is.ref[0] === 141).hit);
  // not flagged
  const clean = ['Он работал как лошадь.', 'Мне кажется, что он прав.', 'Это было кстати.', 'Я знаю, что делать, и когда.', 'Купи хлеб, а также молоко.', 'Даже если пойдёт дождь, мы поедем.'];
  const res = engine.check(doc(clean));
  assert.equal(res.issues.filter((is) => is.category === 'punctuation').length, 0, describe(res.issues));
  // mechanical
  assert.ok(one(['Привет ,как дела?'], (is) => is.ruleId === 'punct.space-before').hit);
  assert.ok(one(['Привет,как дела?'], (is) => is.ruleId === 'punct.space-after').hit);
  assert.ok(one(['Привет,, как дела?'], (is) => is.ruleId === 'punct.double').hit);
  // inside quotes punctuation is skipped
  const q = one(['Он написал: «думаю что это правда».'], (is) => is.category === 'punctuation');
  assert.equal(q.hit, undefined, describe(q.issues));
  const q2 = one(['Он написал: «думаю что это правда».'], (is) => is.category === 'punctuation', { skipQuotes: false });
  assert.ok(q2.hit);
});

test('grammar: prepositions, government, одеть/надеть, agreement', async () => {
  await ready();
  assert.ok(one(['По приезду мы позвонили.'], (is) => is.before === 'По приезду' && is.after === 'По приезде' && is.confidence === 'sure').hit);
  assert.ok(one(['Согласно приказа все вышли.'], (is) => is.before === 'приказа' && is.after === 'приказу').hit);
  assert.ok(one(['Нужно оплатить за проезд.'], (is) => is.before === 'оплатить за' && is.after === 'оплатить').hit);
  assert.ok(one(['Он одел куртку и вышел.'], (is) => is.before === 'одел' && is.after === 'надел').hit);
  assert.ok(one(['Он одел ребёнка и вышел.'], (is) => is.ruleId === 'gram.odet-nadet').hit === undefined);
  assert.ok(one(['Красивый девушка вошла в зал.'], (is) => is.ruleId === 'gram.agreement' && is.after === 'Красивая').hit);
  assert.ok(one(['В течении реки много порогов.'], (is) => is.ruleId === 'gram.v-techenie').hit === undefined);
  assert.ok(one(['В течении двух недель всё решится.'], (is) => is.ruleId === 'gram.v-techenie').hit);
  const clean = engine.check(doc(['Два больших дома стояли у реки.', 'Прошлой зимой было холодно.', 'Согласно договору работы начнутся в мае.']));
  assert.equal(clean.issues.filter((is) => is.category === 'grammar').length, 0, describe(clean.issues));
});

test('typography: dashes, quotes, numbers, ё modes, nbsp', async () => {
  await ready();
  assert.ok(one(['Слово - дело.'], (is) => is.ruleId === 'typo.dash' && is.after === `${NBSP}—`).hit);
  assert.ok(one(['- Привет, - сказал он.'], (is) => is.ruleId === 'typo.dash' && is.start === 0 && is.after === '—').hit);
  const nested = one(['Он сказал: "это "вложенная" цитата".'], (is) => is.ruleId === 'typo.quotes');
  assert.ok(nested.hit && nested.hit.after === '«это „вложенная“ цитата»', describe(nested.issues));
  assert.ok(one(['Нас было 2500000 человек.'], (is) => is.after === `2${NBSP}500${NBSP}000`).hit);
  assert.ok(one(['Звоните 89161234567 или пишите.'], (is) => is.ruleId === 'typo.number-group').hit === undefined);
  assert.ok(one(['Заказ № 123456 отправлен.'], (is) => is.ruleId === 'typo.number-group').hit === undefined);
  assert.ok(one(['Мы ждали...'], (is) => is.ruleId === 'typo.ellipsis' && is.after === '…').hit);
  assert.ok(one(['Два  пробела.'], (is) => is.ruleId === 'typo.double-space').hit);
  assert.ok(one(['Он еще не пришел.'], (is) => is.before === 'еще' && is.after === 'ещё', { yo: 'always' }).hit);
  assert.ok(one(['Все ушли.'], (is) => is.ruleId.startsWith('typo.yo'), { yo: 'always' }).hit === undefined);
  assert.ok(one(['Он ещё не пришёл.'], (is) => is.before === 'ещё' && is.after === 'еще', { yo: 'never' }).hit);
  assert.ok(one(['Он еще не пришел. Все ушли.'], (is) => is.ruleId.startsWith('typo.yo')).hit === undefined);
  assert.ok(one(['Мы узнаем об этом завтра.'], (is) => is.ruleId === 'typo.yo-meaning' && is.confidence === 'check').hit);
  assert.ok(one(['Слово - дело.'], (is) => is.ruleId === 'typo.dash', { dash: 'off' }).hit === undefined);
  assert.ok(one(['Нас было 2500000 человек.'], (is) => is.ruleId === 'typo.number-group', { numbers: false }).hit === undefined);
  const nb = engine.applyNbsp('Мы пошли в кино с Аней — и т. д. Было 5 книг и 150 000 рублей, А. С. Пушкин же.');
  assert.equal(nb, `Мы пошли в${NBSP}кино с${NBSP}Аней${NBSP}— и${NBSP}т.${NBSP}д. Было 5${NBSP}книг и${NBSP}150${NBSP}000${NBSP}рублей, А.${NBSP}С.${NBSP}Пушкин${NBSP}же.`);
});

test('settings: toggles and uncertain=skip', async () => {
  await ready();
  const text = ['Наверное мы опоздаем, но не смотря на усталость все согласились.'];
  const all = engine.check(doc(text));
  assert.ok(all.issues.some((is) => is.confidence === 'check'));
  const sure = engine.check(doc(text), { uncertain: 'skip' });
  assert.ok(sure.issues.length > 0 && sure.issues.every((is) => is.confidence === 'sure'));
  const noPunct = engine.check(doc(text), { checks: { punctuation: false } });
  assert.ok(!noPunct.issues.some((is) => is.category === 'punctuation'));
  assert.ok(noPunct.issues.some((is) => is.category === 'spelling'));
  assert.throws(() => engine.check({}), TypeError);
  assert.deepEqual(engine.defaultSettings().checks, { spelling: true, punctuation: true, grammar: true, typography: true, repeats: true });
});

test('repeats: near lemma repeats within 3 sentences, idioms ignored', async () => {
  await ready();
  const r = one(['Проект стартовал в мае. Команда проекта работала быстро.'], (is) => is.ruleId === 'repeat.near');
  assert.ok(r.hit && r.hit.before === 'проекта' && r.hit.after === 'проекта' && /«проект»/.test(r.hit.why));
  const idiom = one(['В конце концов мы договорились. Друг друга они поняли.'], (is) => is.ruleId === 'repeat.near');
  assert.equal(idiom.hit, undefined, describe(idiom.issues));
});

test('literary: deletions, kanc templates, long sentences', async () => {
  await ready();
  const res = engine.literary(doc([
    'Очень важно сдать отчёт. Мы осуществляем контроль качества на постоянной основе.',
    'Данный документ является основой проекта, и в настоящее время мы имеем возможность его обсудить.',
  ]));
  const by = (pred) => res.issues.find(pred);
  assert.ok(by((is) => is.before === 'Очень важно' && is.after === 'Важно'), describe(res.issues));
  assert.ok(by((is) => is.before === 'осуществляем контроль качества' && is.after === 'контролируем качество'), describe(res.issues));
  assert.ok(by((is) => is.before === 'на постоянной основе' && is.after === 'постоянно'));
  assert.ok(by((is) => is.before === 'Данный' && is.after === 'Этот'));
  // the dependent genitive «проекта» stays as is: «документ — основа проекта»
  assert.ok(by((is) => is.before === 'является основой' && is.after === '— основа' && is.ref[0] === 164), describe(res.issues));
  assert.ok(by((is) => is.before === 'в настоящее время' && is.after === 'сейчас'));
  assert.ok(by((is) => is.before === 'имеем возможность' && is.after === 'можем'));
  const long = engine.literary(doc(['Когда мы вышли из дома, который стоял на холме, где когда-то жил старик, что знал всех в округе, потому что прожил там всю жизнь, уже темнело.']));
  assert.ok(long.issues.some((is) => is.ruleId === 'style.long' && /придаточн/.test(is.why)));
  const passive = engine.literary(doc(['Работа была выполнена вовремя. Отчёт рассматривается руководством.']));
  assert.ok(passive.issues.some((is) => is.ruleId === 'style.passive' && is.before === 'была выполнена'));
  assert.ok(passive.issues.some((is) => is.ruleId === 'style.passive-sya' && is.before === 'рассматривается'));
});

test('wordInfo: known and unknown words', async () => {
  await ready();
  const known = engine.wordInfo('ответственных');
  assert.equal(known.known, true);
  assert.equal(known.lemma, 'ответственный');
  assert.equal(known.posTitle, 'прилагательное');
  assert.equal(known.tags, 'род. п., мн. ч.');
  assert.match(known.forms, /^ответственный;/);
  assert.match(known.forms, /кр\. ф\./);
  assert.ok(known.morph.length >= 6 && known.morph.length <= 12);
  assert.ok(known.morph.every((m) => m.form && typeof m.tags === 'string'));
  assert.equal(known.dal, null);
  const unknown = engine.wordInfo('ответственых');
  assert.equal(unknown.known, false);
  assert.ok(unknown.suggestions.length > 0 && unknown.suggestions.length <= 5);
  assert.equal(unknown.suggestions[0].word, 'ответственных');
  assert.equal(unknown.suggestions[0].fits, true);
  assert.match(unknown.rule, /две «н»/);
  const noun = engine.wordInfo('решение');
  assert.equal(noun.posTitle, 'существительное');
  assert.match(noun.forms, /род\. п\. решения/);
  const verb = engine.wordInfo('согласились');
  assert.equal(verb.lemma, 'согласиться');
  assert.equal(verb.posTitle, 'глагол');
  assert.ok(verb.morph.some((m) => m.form === 'согласиться'));
  assert.equal(engine.wordInfo('').known, false);
});

test('rules 1956: rule(), searchRules(), basesInfo()', async () => {
  await ready();
  const r = engine.rule(140);
  assert.ok(r && r.n === 140 && r.section === 'Главное и придаточное предложения' && r.url);
  assert.equal(engine.rule(9999), null);
  const res = engine.searchRules('запятая придаточное главное');
  assert.ok(res.length > 0 && res.length <= 20);
  assert.ok(res.slice(0, 3).some((x) => x.n === 140), JSON.stringify(res.slice(0, 5)));
  assert.ok(res[0].snippet && res[0].url && res[0].section && res[0].group);
  const yo = engine.searchRules('буква ё', 3);
  assert.equal(yo.length, 3);
  assert.equal(yo[0].n, 10);
  const chtoby = engine.searchRules('чтобы слитно');
  assert.ok(chtoby.slice(0, 3).some((x) => x.n === 85));
  assert.deepEqual(engine.searchRules(''), []);
  const info = engine.basesInfo();
  assert.ok(Array.isArray(info.modules) && info.modules.length >= 10);
  const ids = info.modules.map((m) => m.id);
  for (const sub of ['spelling', 'punctuation', 'grammar', 'typography', 'kanc']) assert.ok(ids.some((id) => id.includes(sub)), sub);
  const r1956 = info.modules.find((m) => m.id === 'rules1956');
  assert.ok(r1956 && r1956.status === 'builtin' && r1956.toggle === false && /203/.test(r1956.detail));
  assert.equal(info.modules.find((m) => m.id === 'ozhegov').status, 'license');
  assert.equal(info.modules.find((m) => m.id === 'gramota').status, 'link');
  assert.equal(info.modules.find((m) => m.id === 'nkrya').status, 'missing');
  for (const m of info.modules) {
    assert.ok(['builtin', 'license', 'link', 'missing'].includes(m.status), m.id);
    assert.ok(typeof m.title === 'string' && typeof m.detail === 'string' && 'version' in m);
  }
});

test('worker protocol: handle() answers with result or error', async () => {
  await ready();
  const ok = await worker.handle({ id: 7, method: 'check', args: [doc(['Мы решили что пора.'])] });
  assert.equal(ok.id, 7);
  assert.ok(ok.result.issues.length === 1 && !ok.error);
  const bad = await worker.handle({ id: 8, method: 'eval', args: ['1'] });
  assert.equal(bad.id, 8);
  assert.ok(bad.error && /Unknown engine method/.test(bad.error.message));
  const thrown = await worker.handle({ id: 9, method: 'check', args: [null] });
  assert.ok(thrown.error && thrown.error.name === 'TypeError');
  assert.ok(worker.METHODS.has('searchRules') && worker.METHODS.has('rule'));
});

test('worker thread: init + check round trip through worker_threads', async () => {
  const { Worker } = require('node:worker_threads');
  const path = require('node:path');
  const w = new Worker(path.resolve(__dirname, '..', '..', 'src', 'engine', 'worker.js'));
  const call = (id, method, args) => new Promise((resolve, reject) => {
    const onMessage = (msg) => { if (msg.id === id) { w.off('message', onMessage); resolve(msg); } };
    w.on('message', onMessage);
    w.once('error', reject);
    w.postMessage({ id, method, args });
  });
  try {
    const init = await call(1, 'init', [{ basesDir: path.resolve(__dirname, '..', '..', 'bases') }]);
    assert.ok(!init.error, init.error && init.error.message);
    const res = await call(2, 'check', [doc(['Мы решили что пора.'])]);
    assert.equal(res.result.issues.length, 1);
    assert.equal(res.result.issues[0].after, 'решили, что');
    const info = await call(3, 'basesInfo', []);
    assert.ok(info.result.modules.some((m) => m.id === 'rules1956'));
    const rule = await call(4, 'rule', [140]);
    assert.equal(rule.result.n, 140);
    const bad = await call(5, 'nope', []);
    assert.ok(bad.error);
  } finally {
    await w.terminate();
  }
});

test('compare: hyphenation glued, whitespace-only, added paragraph', async () => {
  await ready();
  const same = engine.compare(doc(['Наш дизайнер ушёл.']), doc(['Наш дизай-\nнер ушёл.']));
  assert.equal(same.diffs.length, 0);
  assert.equal(same.similarity, 100);
  const added = engine.compare(doc(['Один.']), doc(['Один.', 'Два.']));
  assert.deepEqual(added.diffs.map((d) => d.type), ['added']);
  const space = engine.compare(doc([`150${NBSP}000 рублей`]), doc(['150 000 рублей']));
  assert.deepEqual(space.diffs.map((d) => d.type), ['space']);
});
