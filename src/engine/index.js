'use strict';

/**
 * Public API of the «Вычитка» engine (see docs/ENGINE_SPEC.md, docs/ENGINE.md).
 *
 *   await init({ basesDir, userWords })
 *   setUserWords(words)
 *   basesInfo()
 *   check(doc, settings)
 *   literary(doc, settings)
 *   wordInfo(word, { para, start, end, doc })
 *   compare(aDoc, bDoc, { appliedFixes })
 *   rule(n), searchRules(query, limit), manualRule(id)
 *   applyNbsp(text), applyIssues(doc, issues), defaultSettings()
 */

const fs = require('node:fs');
const path = require('node:path');
const morph = require('./morph');
const rules1956 = require('./rules1956');
const punctManual = require('./punctmanual');
const dal = require('./dal');
const idioms = require('./idioms');
const { buildContext } = require('./context');
const spelling = require('./spelling');
const punctuation = require('./punctuation');
const ltRules = require('./ltrules');
const grammar = require('./grammar');
const typography = require('./typography');
const repeats = require('./repeats');
const literaryMod = require('./literary');
const { wordInfo: wordInfoImpl } = require('./wordinfo');
const { compare: compareImpl } = require('./compare');
const { loadJson, loadWordList, wordRegex, resolveOverlaps, applyIssues: applyIssuesImpl } = require('./util');

const DEFAULT_SETTINGS = Object.freeze({
  checks: Object.freeze({ spelling: true, punctuation: true, grammar: true, typography: true, repeats: true }),
  yo: 'meaning',
  quotes: 'elochki',
  dash: 'em',
  numbers: true,
  uncertain: 'mark',
  skipQuotes: true,
  strict: false, // «Строгий режим»: picky-правила LanguageTool и шумные вводные слова (intro.json → strict: true)
});

const CHECK_RANK = { spelling: 5, grammar: 4, punctuation: 3, typography: 2, repeat: 1 };
const DEFAULT_SOURCE = 'Профиль: редакционная норма';

const state = {
  ready: false,
  basesDir: null,
  manifest: null,
  rules: null,
  userWords: [],
  moduleStatus: {},
};

/* ---------- loading ---------- */

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function loadRules(basesDir) {
  const dir = path.join(basesDir, 'rules');
  const read = (name) => loadJson(path.join(dir, name));
  const intro = read('intro.json');
  const conj = read('conj.json');
  const phrases = read('phrases.json');
  const kanc = read('kanc.json');
  const nominal = read('nominal-verbs.json');
  const intensifiers = read('intensifiers.json');
  const yo = read('yo.json');
  const grammarData = read('grammar.json');
  const passive = read('passive.json');
  const punctExtraFile = path.join(dir, 'punct-extra.json');
  const punctExtra = fs.existsSync(punctExtraFile) ? punctuation.compileExtra(loadJson(punctExtraFile)) : null; // checks from the punctuation manual

  const impfToPerf = new Map();
  for (const [perf, impf] of Object.entries(nominal.verbs)) if (impf) impfToPerf.set(impf, perf);

  return {
    intro,
    conj,
    phrases,
    kanc,
    nominal: { ...nominal, impfToPerf },
    intensifiers,
    yo,
    grammar: grammarData,
    passive,
    punctExtra,
    introCompiled: punctuation.compileIntro(intro.items),
    conjCompiled: punctuation.compileConj(conj),
    phrasesCompiled: spelling.compilePhrases(phrases.items),
    kancCompiled: kanc.items.map((it) => ({ ...it, re: wordRegex(it.pattern) })),
    intensCompiled: intensifiers.items.map((it) => ({ ...it, re: wordRegex(it.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })),
    passiveSet: new Set(passive.reflexivePassive),
    counts: {
      intro: intro.items.length,
      conj: conj.subordinating.length + conj.adversative.length,
      phrases: phrases.items.length,
      kanc: kanc.items.length,
      nominal: nominal.pairs.length,
      intensifiers: intensifiers.items.length,
      yo: yo.meaning.length,
      passive: passive.reflexivePassive.length,
    },
  };
}

/**
 * Load dictionaries and rule data from basesDir. Calling again reloads everything.
 * @param {{ basesDir: string, userWords?: string[] }} opts
 * @returns {Promise<void>}
 */
async function init(opts = {}) {
  const basesDir = opts.basesDir;
  if (!basesDir || typeof basesDir !== 'string') throw new TypeError('init: basesDir is required');
  if (!fs.existsSync(basesDir)) throw new Error(`init: basesDir not found: ${basesDir}`);
  state.ready = false;
  await morph.init(basesDir);
  const extraFile = path.join(basesDir, 'extra', 'words.txt');
  const extra = fs.existsSync(extraFile) ? loadWordList(extraFile) : new Set();
  morph.setExtraWords(expandExtra(extra));
  state.rules = loadRules(basesDir);
  ltRules.load(path.join(basesDir, 'rules')); // LanguageTool punctuation rules (lt-punct.json); absent file → no-op
  const refFile = path.join(basesDir, 'reference', 'rules-1956.json');
  const refLoaded = rules1956.load(refFile);
  punctManual.load(path.join(basesDir, 'reference', 'punct-manual.json'));
  dal.configure(basesDir); // paths + meta.json only; the dictionary itself loads on the first word card
  idioms.load(basesDir); // set phrases: built-in § 146/§ 150 lists + punct-extra pairs + bases/wiktionary/idioms.json
  const manifestFile = path.join(basesDir, 'manifest.json');
  state.manifest = fs.existsSync(manifestFile) ? loadJson(manifestFile) : null;
  state.basesDir = basesDir;
  state.extraCount = extra.size;
  state.refLoaded = refLoaded;
  setUserWords(opts.userWords || state.userWords);
  state.ready = true;
}

const EXTRA_ENDINGS = ['', 'а', 'у', 'ом', 'е', 'ы', 'ов', 'ам', 'ами', 'ах', 'и', 'я', 'ю', 'ем', 'ей', 'ью', 'ями', 'ях', 'ой', 'ев', 'ью', 'ия', 'ий', 'ый', 'ая', 'ое', 'ые', 'ого', 'ому', 'ым', 'ых', 'ыми', 'ую', 'ий', 'его', 'ему', 'им', 'их', 'ими', 'юю', 'ее', 'ие', 'ею', 'ть', 'л', 'ла', 'ли', 'ло', 'ят', 'ит', 'ишь', 'им', 'ите', 'ют', 'ет', 'ешь', 'ете', 'ем', 'йте', 'й', 'ься', 'лся', 'лась', 'лись', 'тся', 'ится', 'ятся', 'ется', 'ются', 'ила', 'или', 'ил', 'ило', 'ить'];

/** Expand lemma list into a Set that also recognises inflected forms (stem + ending). */
function expandExtra(lemmas) {
  const set = new Set();
  const stems = new Set();
  for (const w of lemmas) {
    set.add(w);
    const stem = /[аяоеьйыи]$/.test(w) && w.length > 3 ? w.slice(0, -1) : w;
    stems.add(stem);
  }
  const proxy = {
    has(word) {
      if (set.has(word)) return true;
      for (const end of EXTRA_ENDINGS) {
        if (!word.endsWith(end)) continue;
        const stem = word.slice(0, word.length - end.length);
        if (stem.length >= 3 && stems.has(stem)) return true;
      }
      return false;
    },
    get size() { return set.size; },
    [Symbol.iterator]() { return set[Symbol.iterator](); },
  };
  return proxy;
}

function assertReady() {
  if (!state.ready) throw new Error('Engine is not initialised: call init({ basesDir }) first');
}

/** Replace the user dictionary («Мой словарь»). */
function setUserWords(words) {
  state.userWords = Array.isArray(words) ? words.map((w) => String(w)) : [];
  morph.setUserWords(state.userWords);
}

/** Merge user settings with the «Редакционная норма» defaults. */
function mergeSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    checks: { ...DEFAULT_SETTINGS.checks, ...(s.checks || {}) },
  };
}

function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function validateDoc(doc, name = 'doc') {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.paragraphs)) throw new TypeError(`${name}: expected { paragraphs: [{ text, kind }] }`);
  doc.paragraphs.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.text !== 'string') throw new TypeError(`${name}.paragraphs[${i}]: text must be a string`);
  });
}

function finalizeIssue(issue) {
  issue.ref = rules1956.validRefs(issue.ref);
  if (issue.manualRef !== undefined) {
    issue.manualRef = punctManual.validRefs(issue.manualRef);
    if (!issue.manualRef.length) delete issue.manualRef;
  }
  // source: «Правила 1956 · § N · Раздел» when there is a 1956 ref; otherwise the manual section; otherwise the rule's own source
  if (!issue.source) issue.source = issue.ref.length ? rules1956.source(issue.ref) : issue.manualRef ? punctManual.source(issue.manualRef) : DEFAULT_SOURCE;
  else if (issue.ref.length && !/^Правила 1956/.test(issue.source)) issue.source = rules1956.source(issue.ref, issue.source);
  if (!Array.isArray(issue.alternatives)) issue.alternatives = [];
  return issue;
}

/* ---------- public API ---------- */

/**
 * Run proofreading checks.
 * @param {{paragraphs: Array<{text:string, kind?:string}>}} doc
 * @param {object} [settings]
 * @returns {{ issues: object[], stats: { chars:number, words:number, paragraphs:number, ms:number } }}
 */
function check(doc, settings) {
  assertReady();
  validateDoc(doc);
  const t0 = Date.now();
  const s = mergeSettings(settings);
  const env = { rules: state.rules };
  const all = [];
  let chars = 0;
  let words = 0;
  doc.paragraphs.forEach((p, para) => {
    const text = p.text;
    chars += text.length;
    if (!text.trim()) return;
    const ctx = buildContext(text, para, s, env);
    ctx.kind = p.kind;
    words += ctx.tokens.reduce((n, t) => n + (t.type === 'word' || t.type === 'latin' || t.type === 'mixed' ? 1 : 0), 0);
    if (s.checks.spelling) all.push(...spelling.check(ctx));
    if (s.checks.punctuation) all.push(...punctuation.check(ctx));
    if (s.checks.grammar) all.push(...grammar.check(ctx));
    if (s.checks.typography) all.push(...typography.check(ctx));
    if (s.checks.repeats) all.push(...repeats.check(ctx));
  });
  let issues = resolveOverlaps(all, CHECK_RANK);
  if (s.uncertain === 'skip') issues = issues.filter((is) => is.confidence === 'sure');
  issues.forEach(finalizeIssue);
  return { issues, stats: { chars, words, paragraphs: doc.paragraphs.length, ms: Date.now() - t0 } };
}

/**
 * Literary editing analysis.
 * @param {{paragraphs: Array<{text:string, kind?:string}>}} doc
 * @param {object} [settings]
 * @returns {{ score:number, scoreAfter:number, metrics:object[], issues:object[] }}
 */
function literary(doc, settings) {
  assertReady();
  validateDoc(doc);
  const s = mergeSettings(settings);
  const res = literaryMod.analyze(doc, s, { rules: state.rules });
  res.issues.forEach(finalizeIssue);
  return res;
}

/**
 * Word card.
 * @param {string} word
 * @param {{ para?:number, start?:number, end?:number, doc?:object }} [opts]
 */
function wordInfo(word, opts) {
  assertReady();
  return wordInfoImpl(word, opts || {});
}

/**
 * Compare two versions.
 * @param {object} aDoc
 * @param {object} bDoc
 * @param {{ appliedFixes?: Array<{before:string, after:string}> }} [opts]
 */
function compare(aDoc, bDoc, opts) {
  validateDoc(aDoc, 'aDoc');
  validateDoc(bDoc, 'bDoc');
  return compareImpl(aDoc, bDoc, opts || {});
}

/** Paragraph of the 1956 rules by number, or null. */
function rule(n) {
  return rules1956.rule(n);
}

/**
 * Search the 1956 rules and the punctuation manual together. Results are
 * merged by score; on a tie the 1956 paragraph goes first. Manual entries
 * have `n: null`, `id`, `source: 'manual'` and a `url` into the original PDF.
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {object[]}
 */
function searchRules(query, limit = 20) {
  const lim = Math.max(1, limit | 0);
  const a = rules1956.search(query, lim);
  const b = punctManual.search(query, lim);
  if (!b.length) return a;
  if (!a.length) return b;
  const merged = [];
  let i = 0;
  let j = 0;
  while (merged.length < lim && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && a[i].score >= b[j].score)) merged.push(a[i++]);
    else merged.push(b[j++]);
  }
  return merged;
}

/** Entry of the punctuation manual by id ('pm-dash-nouns' …), or null. */
function manualRule(id) {
  return punctManual.rule(id);
}

/**
 * Set phrase around a position or selection in a paragraph — for the «why no comma here» hint.
 * @param {string} paragraphText
 * @param {number} start
 * @param {number} [end]
 * @returns {{ idiom:string, note:string, ref:number[], kind:string, start:number, end:number, url:string, definition:string, source:string } | null}
 */
function explainSpan(paragraphText, start, end) {
  assertReady();
  if (typeof paragraphText !== 'string') throw new TypeError('explainSpan: paragraphText must be a string');
  if (typeof start !== 'number' || !Number.isFinite(start)) throw new TypeError('explainSpan: start must be a number');
  return idioms.explainSpan(paragraphText, start, end);
}

/**
 * Information about loaded bases for the «Словари и базы» screen.
 * @returns {{ version:string, date:string, modules:object[] }}
 */
function basesInfo() {
  const m = state.manifest || {};
  const version = m.version || '';
  const date = m.date || '';
  const dir = state.basesDir || '';
  const ok = (cond) => (cond ? 'builtin' : 'missing');
  const counts = state.rules ? state.rules.counts : {};
  const azOk = !!dir && fs.existsSync(path.join(dir, 'az', 'words.dawg'));
  const freqOk = !!dir && fs.existsSync(path.join(dir, 'freq', 'ru_50k.txt'));
  const extraOk = !!dir && fs.existsSync(path.join(dir, 'extra', 'words.txt'));
  const refInfo = rules1956.info();
  const manualInfo = punctManual.info();
  const ltInfo = ltRules.info();
  const dalInfo = dal.info();
  const dalDetail = dalInfo.available
    ? `${dalInfo.count.toLocaleString('ru-RU')} статей · 2-е издание · по Викитеке (CC BY-SA)`
    : 'файл bases/dal/dal.json.gz не найден';
  const wikiInfo = idioms.info();
  const wikiDetail = wikiInfo.available
    ? `${wikiInfo.count.toLocaleString('ru-RU')} устойчивых сочетаний · ${wikiInfo.conj} союзов · ${wikiInfo.intro} вводных слов · CC BY-SA 4.0`
    : `файл bases/wiktionary/idioms.json не найден · работает встроенный список (${wikiInfo.total} выражений)`;
  const modules = [
    { id: 'spelling-opencorpora', title: 'Орфографический словарь (OpenCorpora)', detail: '389 022 лексемы · морфология Az.js', version, status: ok(azOk), bytes: dir ? fileSize(path.join(dir, 'az', 'words.dawg')) + fileSize(path.join(dir, 'az', 'paradigms.array')) : 0, toggle: true },
    { id: 'spelling-extra', title: 'Дополнительный словарь', detail: `${state.extraCount || 0} современных слов (референс, онбординг, дедлайн…)`, version, status: ok(extraOk), bytes: dir ? fileSize(path.join(dir, 'extra', 'words.txt')) : 0, toggle: true },
    { id: 'spelling-freq', title: 'Частотный список', detail: '50 000 словоформ · FrequencyWords (CC BY-SA 4.0) · ранжирование подсказок', version, status: ok(freqOk), bytes: dir ? fileSize(path.join(dir, 'freq', 'ru_50k.txt')) : 0, toggle: false },
    { id: 'spelling-phrases', title: 'Орфография: слитно, раздельно, через дефис', detail: `${counts.phrases || 0} правил (чтобы, несмотря на, из-за, -нибудь…)`, version, status: ok(!!state.rules), toggle: true },
    { id: 'punctuation-rules', title: 'Пунктуация: запятые и вводные слова', detail: `${counts.conj || 0} союзов · ${counts.intro || 0} вводных слов`, version, status: ok(!!state.rules), toggle: true },
    { id: 'punctuation-lt', title: 'Пунктуация: правила LanguageTool', detail: `${ltInfo.enabled || 0} правил из ${ltInfo.count || 0} (${ltInfo.groups || 0} групп) · LanguageTool, LGPL 2.1+ · languagetool.org`, version: ltInfo.converted || version, status: ltInfo.loaded ? 'builtin' : 'missing', bytes: ltInfo.file ? fileSize(ltInfo.file) : 0, toggle: false },
    { id: 'grammar-rules', title: 'Грамматика и управление', detail: 'в течение, по приезде, согласно + дат. п., оплатить, одеть/надеть, согласование', version, status: ok(!!state.rules), toggle: true },
    { id: 'typography-rules', title: 'Типографика', detail: 'тире, кавычки-ёлочки, разряды чисел, многоточие, буква ё', version, status: ok(!!state.rules), toggle: true },
    { id: 'kanc-style', title: 'Литературная правка: канцелярит и штампы', detail: `${counts.kanc || 0} шаблонов · ${counts.nominal || 0} пар «существительное → глагол» · ${counts.intensifiers || 0} усилителей`, version, status: ok(!!state.rules), toggle: true },
    { id: 'rules1956', title: 'Правила орфографии и пунктуации (1956)', detail: '203 параграфа · по публикации therules.ru', version: refInfo.retrieved || version, status: refInfo.loaded ? 'builtin' : 'missing', bytes: refInfo.file ? fileSize(refInfo.file) : 0, toggle: false },
    { id: 'punct-manual', title: 'Пособие по пунктуации (таблицы, 2020)', detail: `${manualInfo.count || 0} правил в пересказе · ${manualInfo.compiler || 'Е. П. Чечулина'}, Ревдинский многопрофильный техникум · полный текст по ссылке`, version: manualInfo.retrieved || version, status: manualInfo.loaded ? 'builtin' : 'missing', bytes: manualInfo.file ? fileSize(manualInfo.file) : 0, toggle: false },
    { id: 'ozhegov', title: 'Толковый словарь Ожегова', detail: 'не входит в комплект — требуется лицензия правообладателя', version: '', status: 'license', toggle: false },
    { id: 'lopatin', title: 'Русский орфографический словарь (Лопатин)', detail: 'не входит в комплект — требуется лицензия правообладателя', version: '', status: 'license', toggle: false },
    { id: 'zaliznyak', title: 'Грамматический словарь Зализняка', detail: 'не входит в комплект — требуется лицензия правообладателя', version: '', status: 'license', toggle: false },
    { id: 'gramota', title: 'Грамота.ру', detail: 'справочный портал — открывается в браузере', version: '', status: 'link', toggle: false },
    { id: 'nkrya', title: 'Национальный корпус русского языка', detail: 'не подключён', version: '', status: 'missing', toggle: false },
    { id: 'dal', title: 'Толковый словарь Даля', detail: dalDetail, version: dalInfo.retrieved || version, status: dalInfo.available ? 'builtin' : 'missing', bytes: dalInfo.bytes, toggle: false },
    { id: 'wiktionary', title: 'Викисловарь: устойчивые сочетания, союзы, вводные слова', detail: wikiDetail, version: wikiInfo.retrieved || version, status: wikiInfo.available ? 'builtin' : 'missing', bytes: wikiInfo.bytes, toggle: false },
  ];
  return { version, date, modules };
}

module.exports = {
  init,
  setUserWords,
  basesInfo,
  check,
  literary,
  wordInfo,
  compare,
  rule,
  searchRules,
  manualRule,
  explainSpan,
  applyNbsp: typography.applyNbsp,
  applyIssues: applyIssuesImpl,
  defaultSettings,
  DEFAULT_SETTINGS,
};
