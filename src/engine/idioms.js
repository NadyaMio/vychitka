'use strict';

/**
 * Set phrases («цельные выражения») and the commas that must not be inside them.
 *
 * Data, merged at load():
 *   - a built-in list: the note to § 146 of the 1956 rules («ни то ни сё», «и так и этак»,
 *     «и то и другое»…), the stable comparisons of § 150 («как по маслу», «бледен как смерть») and
 *     Розенталь's list of cohesive pairs;
 *   - the ни…ни / и…и pairs of bases/rules/punct-extra.json (homogeneous.niIdioms / iIdioms);
 *   - bases/wiktionary/idioms.json — «Устойчивые сочетания/ru» and «Фразеологизмы/ru» of the
 *     Russian Wiktionary (CC BY-SA 4.0), built by scripts/fetch-wiktionary.py.
 *
 * Three uses:
 *   check(ctx, out)                 «и то, и другое» → punct.idiom-no-comma: the comma inside a cohesive
 *                                   pair joined by a repeated «и» / «ни» is removed (§ 146, note);
 *   isIdiomSpan(text, start, end)   the span lies inside a known set phrase — other rules keep quiet
 *                                   («ни свет ни заря» for repeated conjunctions, «как по маслу» for «как»);
 *   explainSpan(text, start, end)   { idiom, note, ref, url, definition, kind } for the interface
 *                                   («запятая не нужна: устойчивое выражение, § 146»), or null.
 *
 * Matching is by word sequence (ё = е, case-insensitive); between the words only spaces and at most
 * one comma are allowed, so «ни свет, ни заря» is found as the phrase «ни свет ни заря» with a stray comma.
 * Phrases whose Wiktionary title itself contains a comma («не кто иной, как») never hide a comma at
 * that boundary and are never «fixed».
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeIssue, loadJson } = require('./util');
const rules1956 = require('./rules1956');

const WORD_RE_SRC = '[а-яё]+(?:-[а-яё]+)*';
const GAP_RE = /^[  \t]*(,?)[  \t]*$/; // spaces and at most one comma between the words of a phrase
const REPEATED_RE = /^(и|ни|то|либо|или|не то|то ли|что|хоть) (.+?) \1 (.+)$/;
const SURE_CONJ = new Set(['и', 'ни']); // § 146 note speaks only about и…и and ни…ни
const MAX_WORDS = 12;
const CACHE_MAX = 32;
const WIKI_SOURCE = 'Викисловарь (CC BY-SA 4.0)';

/** § 146 (note) and Розенталь: cohesive pairs with repeated и / ни — no comma inside. */
const BUILTIN_REPEATED = [
  'ни то ни сё', 'и так и этак', 'ни тот ни другой', 'ни да ни нет', 'и день и ночь', 'и стар и млад', 'и смех и горе',
  'ни жив ни мёртв', 'ни взад ни вперёд', 'ни рыба ни мясо', 'ни дать ни взять',
  'и то и другое', 'и тот и другой', 'и та и другая', 'и те и другие', 'и того и другого', 'и тому и другому', 'и тем и другим',
  'и том и другом', 'и ту и другую', 'и той и другой', 'и тех и других', 'и теми и другими',
  'ни то ни другое', 'ни та ни другая', 'ни те ни другие', 'ни того ни другого', 'ни тому ни другому', 'ни тем ни другим',
  'ни ту ни другую', 'ни той ни другой', 'ни тех ни других', 'ни теми ни другими', 'ни тот ни этот', 'ни та ни эта',
  'и так и сяк', 'и так и эдак', 'ни так ни сяк', 'ни так ни этак', 'и туда и сюда', 'ни туда ни сюда', 'и там и сям', 'ни там ни сям',
  'и то и сё', 'ни свет ни заря', 'и смех и грех', 'ни больше ни меньше', 'ни много ни мало', 'ни с того ни с сего',
  'ни за что ни про что', 'ни конца ни края', 'ни конца ни краю', 'ни пуха ни пера', 'ни слуху ни духу', 'ни кола ни двора',
  'ни ответа ни привета', 'ни шатко ни валко', 'ни два ни полтора', 'ни сном ни духом', 'ни складу ни ладу', 'ни тпру ни ну',
  'ни бе ни ме', 'ни себе ни людям', 'ни нашим ни вашим', 'и нашим и вашим', 'ни к селу ни к городу', 'и вкривь и вкось',
  'и днём и ночью', 'ни днём ни ночью', 'и зимой и летом', 'и летом и зимой', 'и холод и голод', 'и в хвост и в гриву', 'и в пир и в мир',
  'и швец и жнец', 'и стыд и срам', 'и честь и хвала', 'ни брат ни сват', 'ни дна ни покрышки', 'ни мычит ни телится',
  'ни пава ни ворона', 'ни стать ни сесть', 'ни встать ни сесть', 'ни убавить ни прибавить', 'ни стыда ни совести',
  'ни гроша ни копейки', 'ни рук ни ног', 'ни кожи ни рожи', 'ни уму ни сердцу', 'ни души ни тела', 'и душой и телом',
  'ни капли ни крошки', 'ни слова ни полслова', 'и верой и правдой', 'и кнутом и пряником', 'и волки сыты и овцы целы',
  'ни богу свечка ни чёрту кочерга', 'и дома и на работе', 'и на работе и дома', 'и в будни и в праздники', 'и утром и вечером',
];

/** § 150: comparisons that became set phrases — not separated by commas. */
const BUILTIN_KAK = [
  'как по маслу', 'как из ведра', 'бледен как смерть', 'бледна как смерть', 'бледный как смерть', 'бледная как смерть',
  'покраснел как рак', 'покраснела как рак', 'красный как рак', 'красная как рак', 'белый как снег', 'белая как снег',
  'белое как снег', 'белые как снег', 'как снег на голову', 'как две капли воды', 'как рыба в воде', 'как с гуся вода',
  'как сыр в масле', 'как белка в колесе', 'как гром среди ясного неба', 'как свои пять пальцев', 'как об стенку горох',
  'как в воду канул', 'как в воду канула', 'как на иголках', 'как по нотам', 'как сельдей в бочке', 'как грибы после дождя',
  'голодный как волк', 'голоден как волк', 'хитрый как лиса', 'хитёр как лиса', 'здоров как бык', 'здоровый как бык',
  'упрям как осёл', 'упрямый как осёл', 'нем как рыба', 'немой как рыба', 'чёрный как смоль', 'холодный как лёд',
  'твёрдый как камень', 'лёгкий как пёрышко', 'острый как бритва', 'как ни в чём не бывало', 'как бы то ни было',
  'как сквозь землю провалился', 'как сквозь землю провалилась', 'как ветром сдуло', 'как рукой сняло', 'как в воду глядел',
  'как в воду глядела', 'как у христа за пазухой', 'как дважды два', 'как дважды два четыре', 'как зеницу ока',
  'как манны небесной', 'как пить дать', 'как угорелый', 'как угорелая', 'как ошпаренный', 'как ошпаренная', 'как вкопанный',
  'как вкопанная', 'как миленький', 'как миленькая', 'как сумасшедший', 'как сумасшедшая', 'как попало', 'как следует',
  'как нельзя лучше', 'как нельзя кстати', 'как можно скорее', 'как можно больше', 'как можно меньше', 'как можно быстрее',
  'как можно раньше', 'как можно дальше', 'как ни крути', 'как ни странно', 'как ни в чём не бывало',
];

const state = {
  entries: [],
  byFirst: new Map(),
  byKey: new Map(),
  cache: new Map(),
  info: { available: false, count: 0, retrieved: '', bytes: 0, file: null, conj: 0, intro: 0, particles: 0, withDefinition: 0 },
};

/* ---------- compilation ---------- */

function normWord(w) {
  return w.toLowerCase().replace(/ё/g, 'е');
}

/** Words of a phrase title with the positions of commas inside it (index of the word a comma follows). */
function splitTitle(title) {
  const words = [];
  const commaAfter = new Set();
  const re = new RegExp(WORD_RE_SRC, 'giu');
  let m;
  let last = 0;
  while ((m = re.exec(title)) !== null) {
    if (words.length && /[,;]/.test(title.slice(last, m.index))) commaAfter.add(words.length - 1);
    words.push(normWord(m[0]));
    last = m.index + m[0].length;
  }
  return { words, commaAfter };
}

/**
 * Register a phrase. Returns 'added', 'merged' (a Wiktionary duplicate of a built-in phrase:
 * definition and url are attached to the existing entry) or false (too short / too long).
 */
function addEntry(title, source, extra) {
  const { words, commaAfter } = splitTitle(title);
  if (words.length < 2 || words.length > MAX_WORDS) return false;
  const key = words.join(' ');
  const existing = state.byKey.get(key);
  if (existing) {
    if (source !== 'wiktionary') return false;
    existing.wiki = true;
    if (!existing.definition && extra && extra.definition) existing.definition = extra.definition;
    if (!existing.url && extra && extra.url) existing.url = extra.url;
    return 'merged';
  }
  const rep = REPEATED_RE.exec(key);
  let kind = 'other';
  let conj = '';
  let secondAt = -1;
  if (rep) {
    kind = 'repeated';
    conj = rep[1];
    const conjWords = conj.split(' ');
    const partA = rep[2].split(' ').length;
    secondAt = conjWords.length + partA;
  } else if (words.includes('как')) kind = 'kak';
  const partsShort = rep ? rep[2].split(' ').length <= 2 && rep[3].split(' ').length <= 2 : false;
  const entry = {
    title,
    words,
    n: words.length,
    kind,
    conj,
    secondAt,
    commaAfter,
    origin: source, // 'builtin' | 'rules' | 'wiktionary' — where the phrase was first listed
    wiki: source === 'wiktionary', // present in the Wiktionary file (also true for built-in phrases found there)
    definition: (extra && extra.definition) || '',
    url: (extra && extra.url) || '',
    // the stray comma «и то, и другое» is removed only in cohesive pairs with и / ни whose title has no comma
    fixable: kind === 'repeated' && SURE_CONJ.has(conj) && commaAfter.size === 0 && (source !== 'wiktionary' || partsShort),
  };
  entry.sure = entry.fixable && (source !== 'wiktionary' || words.length <= 6);
  state.entries.push(entry);
  state.byKey.set(key, entry);
  let list = state.byFirst.get(words[0]);
  if (!list) state.byFirst.set(words[0], (list = []));
  list.push(entry);
  return 'added';
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Load the phrase lists. Safe to call again (reloads). Missing bases/wiktionary/ is not an error:
 * the built-in and punct-extra phrases still work.
 * @param {string} basesDir
 * @returns {{ available: boolean, count: number }}
 */
function load(basesDir) {
  state.entries = [];
  state.byFirst = new Map();
  state.byKey = new Map();
  state.cache = new Map();
  state.info = { available: false, count: 0, retrieved: '', bytes: 0, file: null, conj: 0, intro: 0, particles: 0, withDefinition: 0 };
  for (const t of BUILTIN_REPEATED) addEntry(t, 'builtin');
  for (const t of BUILTIN_KAK) addEntry(t, 'builtin');
  const extraFile = path.join(basesDir, 'rules', 'punct-extra.json');
  if (fs.existsSync(extraFile)) {
    const hom = (loadJson(extraFile).homogeneous) || {};
    for (const [a, b] of hom.niIdioms || []) addEntry(`ни ${a} ни ${b}`, 'rules');
    for (const [a, b] of hom.iIdioms || []) addEntry(`и ${a} и ${b}`, 'rules');
  }
  const file = path.join(basesDir, 'wiktionary', 'idioms.json');
  if (fs.existsSync(file)) {
    const data = loadJson(file);
    let added = 0;
    let withDef = 0;
    for (const it of data.items || []) {
      if (!it || typeof it.t !== 'string') continue;
      if (addEntry(it.t, 'wiktionary', { definition: it.d || '', url: it.url || '' })) {
        added++; // added or merged into a built-in phrase — either way a Wiktionary phrase the engine knows
        if (it.d) withDef++;
      }
    }
    state.info.available = true;
    state.info.count = added;
    state.info.withDefinition = withDef;
    state.info.retrieved = data.retrieved || '';
    state.info.file = file;
    state.info.bytes = fileSize(file);
    const metaFile = path.join(basesDir, 'wiktionary', 'meta.json');
    if (fs.existsSync(metaFile)) {
      const sets = (loadJson(metaFile).sets) || {};
      state.info.conj = (sets.conj && sets.conj.count) || 0;
      state.info.intro = (sets.intro && sets.intro.count) || 0;
      state.info.particles = (sets.particles && sets.particles.count) || 0;
      for (const id of ['conj', 'intro', 'particles']) state.info.bytes += fileSize(path.join(basesDir, 'wiktionary', `${id}.json`));
    }
  }
  return { available: state.info.available, count: state.entries.length };
}

/** Status for basesInfo(): Wiktionary file present?, counts, bytes. */
function info() {
  return { ...state.info, total: state.entries.length };
}

/* ---------- matching ---------- */

/**
 * All phrase occurrences in a paragraph (cached by text).
 * @param {string} text
 * @returns {{ words: Array<{w:string,start:number,end:number}>, matches: Array<{start:number,end:number,entry:object,commas:number[],wi:number}> }}
 */
function scan(text) {
  const hit = state.cache.get(text);
  if (hit) return hit;
  const words = [];
  const re = new RegExp(WORD_RE_SRC, 'giu');
  let m;
  while ((m = re.exec(text)) !== null) words.push({ w: normWord(m[0]), start: m.index, end: m.index + m[0].length });
  const matches = [];
  for (let i = 0; i < words.length; i++) {
    const cands = state.byFirst.get(words[i].w);
    if (!cands) continue;
    for (const e of cands) {
      const n = e.n;
      if (i + n > words.length) continue;
      let ok = true;
      const commas = [];
      for (let j = 1; j < n; j++) {
        if (words[i + j].w !== e.words[j]) { ok = false; break; }
        const gap = text.slice(words[i + j - 1].end, words[i + j].start);
        const g = GAP_RE.exec(gap);
        if (!g) { ok = false; break; }
        if (g[1]) commas.push(words[i + j - 1].end + gap.indexOf(','));
      }
      if (!ok) continue;
      matches.push({ start: words[i].start, end: words[i + n - 1].end, entry: e, commas, wi: i });
    }
  }
  const result = { words, matches };
  if (state.cache.size >= CACHE_MAX) state.cache.delete(state.cache.keys().next().value);
  state.cache.set(text, result);
  return result;
}

/** A comma written in the phrase title lies at a word boundary touched by [start, end)? */
function titleCommaBlocks(scanned, m, start, end) {
  if (!m.entry.commaAfter.size) return false;
  for (const j of m.entry.commaAfter) {
    const before = scanned.words[m.wi + j];
    const after = scanned.words[m.wi + j + 1];
    if (before && after && start <= after.start && before.end <= end) return true;
  }
  return false;
}

function covering(text, start, end, minWords) {
  const scanned = scan(text);
  let best = null;
  for (const m of scanned.matches) {
    if (m.start > start || m.end < end) continue;
    if (m.entry.n < (minWords || 2)) continue;
    if (titleCommaBlocks(scanned, m, start, end)) continue;
    if (!best || m.entry.n > best.entry.n || (m.entry.n === best.entry.n && m.start < best.start)) best = m;
  }
  return best;
}

/**
 * Does [start, end) lie inside a known set phrase? Used by other rules to keep quiet:
 * «ни свет ни заря» (repeated conjunctions), «как по маслу» (comparative «как»).
 * @param {string} text paragraph text
 * @param {number} start
 * @param {number} end
 * @param {number} [minWords=2] ignore shorter phrases («как раз» should not hide a real comparison)
 * @returns {boolean}
 */
function isIdiomSpan(text, start, end, minWords = 2) {
  if (typeof text !== 'string' || !(end > start)) return false;
  return covering(text, start, end, minWords) !== null;
}

function noteFor(entry) {
  const q = `«${entry.title}»`;
  if (entry.kind === 'repeated' && SURE_CONJ.has(entry.conj)) {
    return { note: `Запятая не нужна: ${q} — цельное выражение с повторяющимся союзом «${entry.conj}», внутри него запятая не ставится (Правила 1956, § 146, примечание).`, ref: [146] };
  }
  if (entry.kind === 'repeated') {
    return { note: `${q} — устойчивое сочетание с повторяющимся союзом «${entry.conj}»; в таких оборотах запятая обычно не ставится, если это одно целое, а не перечисление (Правила 1956, § 146).`, ref: [146] };
  }
  if (entry.kind === 'kak') {
    return { note: `Запятая не нужна: ${q} — устойчивый оборот с «как», ставший цельным выражением; такие сравнения запятыми не выделяются (Правила 1956, § 150).`, ref: [150] };
  }
  return { note: `${q} — устойчивое сочетание; знаки внутри него ставятся как в словарной форме.`, ref: [] };
}

/**
 * Explain the set phrase around a position or selection, for the interface.
 * @param {string} text paragraph text
 * @param {number} start
 * @param {number} [end=start+1]
 * @returns {{ idiom:string, note:string, ref:number[], kind:string, start:number, end:number, url:string, definition:string, source:string } | null}
 */
function explainSpan(text, start, end) {
  if (typeof text !== 'string' || typeof start !== 'number') return null;
  const s = Math.max(0, start | 0);
  const e = typeof end === 'number' && end > s ? end | 0 : Math.min(text.length, s + 1);
  let m = covering(text, s, e, 2);
  if (!m) {
    // selection sticks out of the phrase: take the longest overlapping one
    for (const x of scan(text).matches) {
      if (x.start < e && s < x.end && (!m || x.entry.n > m.entry.n)) m = x;
    }
  }
  if (!m) return null;
  const entry = m.entry;
  const { note, ref } = noteFor(entry);
  const sources = [];
  if (ref.length) sources.push(`Правила 1956, § ${ref[0]}`);
  if (entry.wiki) sources.push(WIKI_SOURCE);
  return {
    idiom: entry.title,
    note: entry.definition ? `${note} Значение: ${entry.definition}.` : note,
    ref,
    kind: entry.kind,
    start: m.start,
    end: m.end,
    url: entry.url,
    definition: entry.definition,
    origin: entry.origin,
    source: sources.join(' · ') || 'Профиль: редакционная норма',
  };
}

/* ---------- check ---------- */

function sourceFor(entry) {
  const base = rules1956.source([146], 'Правила 1956 · § 146');
  return entry.wiki ? `${base} · ${WIKI_SOURCE}` : base;
}

/**
 * «и то, и другое», «ни свет, ни заря» → remove the comma inside a cohesive pair (§ 146, note).
 * Issues are appended to `out`.
 * @param {object} ctx paragraph context (context.js)
 * @param {object[]} out
 */
function check(ctx, out) {
  if (!state.entries.length) return;
  const text = ctx.text;
  const scanned = scan(text);
  for (const m of scanned.matches) {
    const e = m.entry;
    if (!e.fixable || m.commas.length !== 1) continue;
    const left = scanned.words[m.wi + e.secondAt - 1];
    const right = scanned.words[m.wi + e.secondAt];
    const cpos = m.commas[0];
    if (!left || !right || cpos < left.end || cpos >= right.start) continue; // the comma is elsewhere in the phrase
    if (ctx.inSkip(m.start, m.end)) continue;
    // a longer row of the same conjunction («и так, и этак, и сяк») is a list, not a pair
    const conjRe = e.conj.replace(/ /g, '[ \\u00a0]+');
    if (new RegExp(`^[ \\u00a0]*,[ \\u00a0]*${conjRe}(?![а-яё-])`, 'iu').test(text.slice(m.end, m.end + 16))) continue;
    if (new RegExp(`(?:^|[^а-яё-])${conjRe}[ \\u00a0]+[а-яё-]+[ \\u00a0]*,[ \\u00a0]*$`, 'iu').test(text.slice(Math.max(0, m.start - 40), m.start))) continue;
    const before = text.slice(left.start, right.end);
    const after = text.slice(left.start, cpos) + text.slice(cpos + 1, right.end);
    if (after === before) continue;
    out.push(makeIssue({
      para: ctx.para,
      start: left.start,
      end: right.end,
      category: 'punctuation',
      ruleId: 'punct.idiom-no-comma',
      before,
      after,
      confidence: e.sure ? 'sure' : 'check',
      why: `Внутри цельного выражения «${e.title}» запятая не ставится: повторяющийся союз «${e.conj}» здесь соединяет два слова, образующие одно целое, а не перечисление.`,
      ref: [146],
      manualRef: ['pm-homog-idioms'],
      source: sourceFor(e),
      meta: { kind: 'idiom-no-comma', idiom: e.title, conj: e.conj, url: e.url, definition: e.definition },
    }));
  }
}

module.exports = { load, info, check, isIdiomSpan, explainSpan, scan };
