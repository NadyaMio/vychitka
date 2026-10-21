'use strict';

/**
 * Morphology layer on top of Az.js (OpenCorpora dictionary).
 *
 * Responsibilities:
 *  - load dictionaries from basesDir/az (never from node_modules/az/dicts);
 *  - isKnown(word): dictionary / extra list / user words;
 *  - parse(word), lemma(word), tag descriptions in Russian;
 *  - spelling candidates: distance-1 edits, distance-2 through typical errors;
 *  - frequency ranks for ranking suggestions.
 *
 * All lookups are memoised in Maps that are cleared on init().
 */

const fs = require('node:fs');
const path = require('node:path');
const Az = require('az');
const { levenshtein } = require('./util');

const ALPHABET = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const MAX_CACHE = 150000;

const state = {
  ready: false,
  dir: null,
  freq: new Map(),       // lower word -> rank (1 = most frequent)
  extra: new Set(),      // bases/extra/words.txt
  user: new Set(),       // "Мой словарь"
  knownCache: new Map(),
  parseCache: new Map(),
  candCache: new Map(),
};

function boundedSet(map, key, value) {
  if (map.size >= MAX_CACHE) map.clear();
  map.set(key, value);
  return value;
}

/**
 * Load Az dictionaries and auxiliary lists.
 * @param {string} basesDir
 * @returns {Promise<void>}
 */
async function init(basesDir) {
  const azDir = path.join(basesDir, 'az');
  if (!fs.existsSync(path.join(azDir, 'words.dawg'))) {
    throw new Error(`Az dictionaries not found in ${azDir}`);
  }
  await new Promise((resolve, reject) => {
    Az.Morph.init(azDir, (err) => (err ? reject(err) : resolve()));
  });
  state.dir = basesDir;
  state.knownCache.clear();
  state.parseCache.clear();
  state.candCache.clear();
  state.freq = loadFreq(path.join(basesDir, 'freq', 'ru_50k.txt'));
  state.ready = true;
}

function loadFreq(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let rank = 0;
  for (const line of lines) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const w = line.slice(0, sp).toLowerCase();
    rank++;
    if (!map.has(w)) map.set(w, rank);
  }
  return map;
}

function assertReady() {
  if (!state.ready) throw new Error('Engine is not initialised: call init({ basesDir }) first');
}

/** Replace the extra-words list (from bases/extra/words.txt). */
function setExtraWords(set) {
  state.extra = set && typeof set.has === 'function' ? set : new Set(set || []);
  state.knownCache.clear();
  state.candCache.clear();
}

/** Replace user words ("Мой словарь"). Any letter case is accepted. */
function setUserWords(words) {
  state.user = new Set((words || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean));
  state.candCache.clear();
}

/** Frequency rank of a word form (1 = most frequent) or 0 when unknown. */
function freqRank(word) {
  return state.freq.get(word.toLowerCase()) || 0;
}

/**
 * Full morphological parse (all Az parsers), memoised by exact spelling.
 * @param {string} word
 * @returns {object[]} Az parses sorted by score
 */
function parse(word) {
  assertReady();
  const hit = state.parseCache.get(word);
  if (hit) return hit;
  return boundedSet(state.parseCache, word, Az.Morph(word, { stutter: 0 }));
}

/** Dictionary parses only (parser === 'Dictionary'). */
function dictParses(word) {
  return parse(word).filter((p) => p.parser === 'Dictionary');
}

/**
 * True when the dictionary knows the word exactly (е/ё interchangeable,
 * capitalised proper nouns accepted only when capitalised).
 * @param {string} word
 * @returns {boolean}
 */
function dictKnown(word) {
  assertReady();
  const hit = state.knownCache.get(word);
  if (hit !== undefined) return hit;
  let known = Az.Morph(word, { parsers: ['Dictionary'], stutter: 0 }).length > 0;
  if (!known && word.includes('-')) {
    const parts = word.split('-');
    if (parts.every((p) => p.length > 0)) {
      const ps = Az.Morph(word, { stutter: 0 });
      known = ps.some((p) => !p.typosCnt && !p.stutterCnt &&
        (p.parser === 'HyphenParticle' || p.parser === 'HyphenAdverb' || p.parser === 'HyphenWords'));
      if (!known && parts.length === 2) known = parts.every((p) => dictKnown(p));
    }
  }
  return boundedSet(state.knownCache, word, known);
}

/**
 * True when the word is in the dictionary, the extra list or the user list.
 * @param {string} word
 * @returns {boolean}
 */
function isKnown(word) {
  const lower = word.toLowerCase();
  if (state.user.has(lower) || state.extra.has(lower)) return true;
  if (word.includes('-')) {
    const parts = lower.split('-');
    if (parts.every((p) => state.user.has(p) || state.extra.has(p) || dictKnown(p))) return true;
  }
  return dictKnown(word);
}

/** Lemma (normal form) of a word, or the lowercase word itself. */
function lemma(word) {
  const ps = parse(word);
  if (!ps.length) return word.toLowerCase();
  const best = ps[0];
  const n = best.normalize();
  return n ? String(n.word || n) : word.toLowerCase();
}

/** Best parse (highest score) or null. */
function bestParse(word) {
  const ps = parse(word);
  return ps.length ? ps[0] : null;
}

/* ---------- Russian tag descriptions ---------- */

const POS_TITLES = {
  NOUN: 'существительное', ADJF: 'прилагательное', ADJS: 'краткое прилагательное', COMP: 'сравнительная степень',
  VERB: 'глагол', INFN: 'глагол (неопределённая форма)', PRTF: 'причастие', PRTS: 'краткое причастие',
  GRND: 'деепричастие', NUMR: 'числительное', ADVB: 'наречие', NPRO: 'местоимение', PRED: 'предикатив',
  PREP: 'предлог', CONJ: 'союз', PRCL: 'частица', INTJ: 'междометие', NUMB: 'число', LATN: 'латиница',
  PNCT: 'знак препинания', ROMN: 'римское число', UNKN: 'неизвестно',
};
const CASES = { nomn: 'им. п.', gent: 'род. п.', datv: 'дат. п.', accs: 'вин. п.', ablt: 'тв. п.', loct: 'пр. п.', voct: 'зват. п.', gen2: 'род. п.', loc2: 'пр. п.', acc2: 'вин. п.' };
const NUMBERS = { sing: 'ед. ч.', plur: 'мн. ч.' };
const GENDERS = { masc: 'м. р.', femn: 'ж. р.', neut: 'ср. р.' };
const TENSES = { past: 'прош. вр.', pres: 'наст. вр.', futr: 'буд. вр.' };
const PERSONS = { '1per': '1 л.', '2per': '2 л.', '3per': '3 л.' };

/** Human title of a part of speech. */
function posTitle(tag) {
  return (tag && POS_TITLES[tag.POS]) || 'слово';
}

/**
 * Short Russian description of grammatical form: "вин. п., мн. ч.".
 * @param {object} tag Az tag
 * @returns {string}
 */
function describeTag(tag) {
  if (!tag) return '';
  const out = [];
  const pos = tag.POS;
  if (pos === 'NOUN' || pos === 'NPRO' || pos === 'NUMR') {
    if (tag.CAse && CASES[tag.CAse]) out.push(CASES[tag.CAse]);
    if (tag.NMbr) out.push(NUMBERS[tag.NMbr]);
  } else if (pos === 'ADJF' || pos === 'PRTF') {
    if (tag.NMbr === 'sing' && tag.GNdr) out.push(GENDERS[tag.GNdr]);
    if (tag.CAse && CASES[tag.CAse]) out.push(CASES[tag.CAse]);
    if (tag.NMbr) out.push(NUMBERS[tag.NMbr]);
  } else if (pos === 'ADJS' || pos === 'PRTS') {
    out.push(pos === 'ADJS' ? 'кр. ф.' : 'кр. прич.');
    if (tag.NMbr === 'sing' && tag.GNdr) out.push(GENDERS[tag.GNdr]);
    if (tag.NMbr) out.push(NUMBERS[tag.NMbr]);
  } else if (pos === 'VERB') {
    if (tag.TEns) out.push(TENSES[tag.TEns]);
    if (tag.PErs) out.push(PERSONS[tag.PErs]);
    if (tag.TEns === 'past' && tag.NMbr === 'sing' && tag.GNdr) out.push(GENDERS[tag.GNdr]);
    if (tag.NMbr) out.push(NUMBERS[tag.NMbr]);
    if (tag.MOOd === 'impr') out.push('повел. накл.');
  } else if (pos === 'INFN') {
    out.push('неопр. ф.');
  } else if (pos === 'GRND') {
    out.push('деепр.');
  } else if (pos === 'COMP') {
    out.push('сравн. ст.');
  } else if (pos) {
    out.push(POS_TITLES[pos] || pos);
  }
  return out.join(', ');
}

/* ---------- Spelling candidates ---------- */

const TYPICAL_PAIRS = [
  ['о', 'а'], ['а', 'о'], ['е', 'и'], ['и', 'е'], ['е', 'э'], ['э', 'е'], ['и', 'ы'], ['ы', 'и'],
  ['т', 'д'], ['д', 'т'], ['с', 'з'], ['з', 'с'], ['г', 'к'], ['к', 'г'], ['б', 'п'], ['п', 'б'],
  ['в', 'ф'], ['ф', 'в'], ['ж', 'ш'], ['ш', 'ж'], ['ь', 'ъ'], ['ъ', 'ь'], ['ё', 'е'], ['е', 'ё'],
  ['я', 'е'], ['е', 'я'], ['ю', 'у'], ['у', 'ю'], ['й', 'и'], ['и', 'й'], ['ч', 'ш'], ['ш', 'ч'],
  ['щ', 'ш'], ['ш', 'щ'], ['ц', 'тс'], ['тс', 'ц'],
];
const VOWELS = 'аеёиоуыэюя';

/**
 * Classify the edit that turns `word` into `cand`.
 * @returns {string|null} 'nn' | 'tsya' | 'soft' | 'hard' | 'vowel' | 'double' | 'consonant' | 'transpose' | null
 */
function classifyEdit(word, cand) {
  if (word === cand) return null;
  const a = word;
  const b = cand;
  if (Math.abs(a.length - b.length) === 1) {
    const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < shorter.length && longer[i] === shorter[i]) i++;
    if (longer.slice(i + 1) !== shorter.slice(i)) return null;
    const ch = longer[i];
    const neighbours = (longer[i - 1] || '') + (longer[i + 1] || '');
    if (ch === 'ь' && longer.slice(i).startsWith('ься') && longer.slice(i + 1) === 'ся') return 'tsya';
    if (ch === 'ь') return 'soft';
    if (ch === 'ъ') return 'hard';
    if (ch === 'н' && neighbours.includes('н')) return 'nn';
    if (neighbours.includes(ch) && !VOWELS.includes(ch)) return 'double';
    return 'edit';
  }
  if (a.length === b.length) {
    const diffs = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) {
      const i = diffs[0];
      const x = a[i];
      const y = b[i];
      if ((x === 'ь' && y === 'ъ') || (x === 'ъ' && y === 'ь')) return 'hard';
      if (VOWELS.includes(x) && VOWELS.includes(y)) return 'vowel';
      if (TYPICAL_PAIRS.some(([p, q]) => p === x && q === y)) return 'consonant';
      return 'replace';
    }
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]) return 'transpose';
  }
  return null;
}

const TYPICAL_WEIGHT = { nn: 3, tsya: 3.2, soft: 2.6, hard: 2.6, vowel: 2.2, double: 1.8, consonant: 1.6, transpose: 0.8, edit: 0.5, replace: 0.4 };
const SURE_KINDS = new Set(['nn', 'tsya', 'soft', 'hard']);

function edits1(word) {
  const out = new Set();
  const n = word.length;
  for (let i = 0; i < n; i++) {
    out.add(word.slice(0, i) + word.slice(i + 1)); // delete
    if (i < n - 1 && word[i] !== word[i + 1]) out.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)); // transpose
    for (const ch of ALPHABET) {
      if (ch !== word[i]) out.add(word.slice(0, i) + ch + word.slice(i + 1)); // replace
      out.add(word.slice(0, i) + ch + word.slice(i)); // insert
    }
  }
  for (const ch of ALPHABET) out.add(word + ch);
  out.delete(word);
  return out;
}

/** Edits reachable through typical Russian spelling errors only. */
function typicalEdits(word) {
  const out = new Set();
  const n = word.length;
  for (let i = 0; i < n; i++) {
    const ch = word[i];
    for (const [p, q] of TYPICAL_PAIRS) {
      if (word.startsWith(p, i)) out.add(word.slice(0, i) + q + word.slice(i + p.length));
    }
    if (ch === 'н') out.add(word.slice(0, i) + 'нн' + word.slice(i + 1));
    if (ch === 'н' && word[i + 1] === 'н') out.add(word.slice(0, i) + word.slice(i + 1));
    if (ch === 'ь' || ch === 'ъ') out.add(word.slice(0, i) + word.slice(i + 1));
    if (!VOWELS.includes(ch) && ch !== 'ь' && ch !== 'ъ' && ch !== 'й') {
      out.add(word.slice(0, i) + ch + word.slice(i)); // doubled consonant
      if (word[i + 1] === ch) out.add(word.slice(0, i) + word.slice(i + 1));
    }
    if (i > 0 && !VOWELS.includes(word[i - 1])) {
      out.add(word.slice(0, i) + 'ь' + word.slice(i));
      out.add(word.slice(0, i) + 'ъ' + word.slice(i));
    }
  }
  if (word.endsWith('тся')) out.add(word.slice(0, -3) + 'ться');
  if (word.endsWith('ться')) out.add(word.slice(0, -4) + 'тся');
  out.add(word + 'ь');
  out.delete(word);
  return out;
}

function sameCase(src, cand) {
  if (src[0] !== src[0].toLowerCase()) return cand[0].toUpperCase() + cand.slice(1);
  return cand;
}

/**
 * Predicted grammatical features of an unknown word (Az suffix predictor).
 * @returns {{POS:string,CAse:string,NMbr:string}|null}
 */
function predictedTag(word) {
  const ps = parse(word);
  for (const p of ps) {
    if (p.parser === 'SuffixKnown' || p.parser === 'PrefixUnknown' || p.parser === 'PrefixKnown') {
      return { POS: p.tag.POS, CAse: p.tag.CAse, NMbr: p.tag.NMbr };
    }
  }
  return null;
}

function scoreCandidate(word, cand, kind, pred) {
  let score = TYPICAL_WEIGHT[kind] || 0;
  const rank = freqRank(cand);
  if (rank) score += 2 * (1 - rank / 50000) + 0.5;
  if (cand[0] === word[0]) score += 0.5;
  if (cand.length === word.length) score += 0.2;
  if (pred) {
    const ps = dictParses(cand);
    if (ps.some((p) => p.tag.POS === pred.POS && (!pred.CAse || p.tag.CAse === pred.CAse) && (!pred.NMbr || p.tag.NMbr === pred.NMbr))) score += 1.2;
    else if (ps.some((p) => p.tag.POS === pred.POS)) score += 0.4;
  }
  return score;
}

/**
 * Spelling candidates for an unknown word.
 * @param {string} word  as written (case preserved)
 * @returns {Array<{word:string, kind:string|null, distance:number, score:number}>} sorted best-first
 */
function candidates(word) {
  assertReady();
  const hit = state.candCache.get(word);
  if (hit) return hit;
  const lower = word.toLowerCase();
  const pred = predictedTag(word);
  const found = new Map();
  const consider = (cand, kind, distance) => {
    if (cand === lower || cand.length < 2 || found.has(cand)) return;
    if (!/^[а-яё]+(?:-[а-яё]+)*$/.test(cand)) return;
    if (!dictKnown(sameCase(word, cand))) return;
    found.set(cand, { word: sameCase(word, cand), kind, distance, score: scoreCandidate(lower, cand, kind, pred) - (distance - 1) * 1.5 });
  };
  for (const cand of edits1(lower)) consider(cand, classifyEdit(lower, cand), 1);
  if (!found.size && lower.length >= 4) {
    const first = typicalEdits(lower);
    for (const t of first) {
      const k1 = classifyEdit(lower, t);
      for (const cand of typicalEdits(t)) {
        if (found.has(cand) || cand === lower) continue;
        const k2 = classifyEdit(t, cand);
        const kind = [k1, k2].filter(Boolean).sort((a, b) => (TYPICAL_WEIGHT[b] || 0) - (TYPICAL_WEIGHT[a] || 0))[0] || 'edit';
        consider(cand, kind, 2);
      }
    }
  }
  const list = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  return boundedSet(state.candCache, word, list);
}

/**
 * Other forms of the candidate's lexeme that are close to the misspelled word
 * (the ending may be wrong as well as the stem).
 * @param {string} word misspelled word
 * @param {string} cand best candidate
 * @param {number} maxDistance
 * @returns {Array<{word:string, tag:object, distance:number}>}
 */
function closeForms(word, cand, maxDistance = 2) {
  const lower = word.toLowerCase();
  const out = [];
  const seen = new Set([cand.toLowerCase()]);
  for (const p of dictParses(cand)) {
    if (typeof p.formCnt !== 'number') continue;
    for (let i = 0; i < p.formCnt; i++) {
      const f = p.inflect(i);
      if (!f) continue;
      const w = String(f.word);
      if (seen.has(w)) continue;
      const d = levenshtein(lower, w);
      if (d <= maxDistance) {
        seen.add(w);
        out.push({ word: sameCase(word, w), tag: f.tag, distance: d });
      }
    }
    break; // first dictionary parse is enough — forms are the same lexeme
  }
  out.sort((a, b) => a.distance - b.distance || (freqRank(b.word) ? 1 : 0) - (freqRank(a.word) ? 1 : 0));
  return out;
}

/**
 * Inflect a dictionary word to the grammemes of another parse/tag.
 * @param {string} word
 * @param {object} tagOrParse
 * @param {string[]} grammemes
 * @returns {string|null}
 */
function inflectTo(word, tagOrParse, grammemes) {
  for (const p of dictParses(word)) {
    const f = p.inflect(tagOrParse, grammemes);
    if (f) return String(f.word);
  }
  return null;
}

/** Inflect a dictionary word to the given list of grammemes (e.g. ['datv']). */
function inflectGram(word, grammemes, posFilter) {
  for (const p of dictParses(word)) {
    if (posFilter && !posFilter.includes(p.tag.POS)) continue;
    const f = p.inflect(grammemes);
    if (f) return String(f.word);
  }
  return null;
}

module.exports = {
  init,
  setExtraWords,
  setUserWords,
  isKnown,
  dictKnown,
  parse,
  dictParses,
  bestParse,
  lemma,
  freqRank,
  candidates,
  closeForms,
  classifyEdit,
  describeTag,
  posTitle,
  inflectTo,
  inflectGram,
  SURE_KINDS,
  POS_TITLES,
  CASES,
  state,
};
