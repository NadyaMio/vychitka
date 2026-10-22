'use strict';

/**
 * «Толковый словарь живого великорусского языка» В. И. Даля, 2-е издание
 * (1880–1882), по русской Викитеке (страницы «ТСД2/…»). Данные —
 * basesDir/dal/dal.json.gz (+ meta.json), собираются scripts/fetch-dal.py.
 *
 * Загрузка ленивая: configure() на init только запоминает пути и читает
 * крошечный meta.json; сам словарь (~40 МБ JSON в gzip) распаковывается при
 * первом lookup(), чтобы init оставался быстрым.
 *
 * Формат dal.json.gz:
 *   { count, retrieved, articles: [{ head, text, url, vol, page }],
 *     index:  { ключ → [номер статьи, …] },   // заглавные слова статей
 *     nested: { ключ → [номер статьи, …] } }  // слова-гнёзда внутри статей
 * Ключ — современная орфография: ѣ→е, і→и, ѳ→ф, ѵ→и, ё→е, без конечного ъ,
 * без ударений, нижний регистр (normalizeKey, зеркало normalize_key в скрипте).
 *
 * Exports: configure(basesDir), lookup(word, lemma), excerpt(text, max), info(), normalizeKey(word), isLoaded().
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DATA_FILE = 'dal.json.gz';
const META_FILE = 'meta.json';
const DEFAULT_EXCERPT = 1200;
const MIN_EXCERPT_RATIO = 0.45;
const MIN_PREFIX = 5;        // shortest headword prefix accepted by the nest fallback
const MIN_PREFIX_RATIO = 0.35; // …and at least this share of the word («ответ» for «ответственный»)

const state = {
  dir: null,
  file: null,
  meta: null,
  data: null,
  error: null,
};

/**
 * Remember where the dictionary lives; read only meta.json (a few hundred bytes).
 * Missing files are not an error: lookup() then returns null and info().loaded is false.
 * @param {string} basesDir
 */
function configure(basesDir) {
  state.dir = path.join(basesDir, 'dal');
  state.file = path.join(state.dir, DATA_FILE);
  state.data = null;
  state.error = null;
  state.meta = null;
  const metaFile = path.join(state.dir, META_FILE);
  if (fs.existsSync(metaFile)) {
    try {
      state.meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch (err) {
      state.meta = null;
      console.warn(`dal: cannot read ${metaFile}: ${err.message}`);
    }
  }
}

/** True when the data file exists on disk (not necessarily loaded yet). */
function available() {
  return !!state.file && fs.existsSync(state.file);
}

/** True once the dictionary has been decompressed into memory. */
function isLoaded() {
  return !!state.data;
}

/**
 * Decompress and parse the dictionary on first use. A broken file is reported
 * once via console.error and treated as absent afterwards.
 * @returns {object|null}
 */
function load() {
  if (state.data) return state.data;
  if (state.error || !available()) return null;
  try {
    const raw = fs.readFileSync(state.file);
    const json = zlib.gunzipSync(raw).toString('utf8');
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.articles) || typeof data.index !== 'object') {
      throw new Error('unexpected structure (articles/index missing)');
    }
    data.nested = data.nested || {};
    state.data = data;
    return data;
  } catch (err) {
    state.error = err;
    console.error(`dal: cannot load ${state.file}: ${err.message}`);
    return null;
  }
}

/**
 * Search key in modern orthography: lowercase, no stress marks, ѣ→е, ё→е,
 * і/ї/ѵ→и, ѳ→ф, final ъ dropped. Mirrors normalize_key() in scripts/fetch-dal.py.
 * @param {string} word
 * @returns {string}
 */
function normalizeKey(word) {
  let s = String(word || '').normalize('NFC').toLowerCase();
  // stress marks only (U+0306/U+0308 are parts of й/ё after NFD and must survive)
  s = s.normalize('NFD').replace(/[̀́̂]/g, '').normalize('NFC');
  s = s.replace(/ѣ/g, 'е').replace(/ё/g, 'е').replace(/[іїѵ]/g, 'и').replace(/ѳ/g, 'ф').replace(/ъ-/g, '-');
  s = s.replace(/[^a-zа-яё-]+/g, '');
  s = s.replace(/ъ+$/, '');
  return s.replace(/^-+|-+$/g, '');
}

function entry(data, idx) {
  const a = data.articles[idx];
  if (!a) return null;
  return { head: a.head, text: a.text, url: encodeURI(a.url) };
}

function firstHit(data, table, key) {
  if (!key) return null;
  const list = table[key];
  return Array.isArray(list) && list.length ? entry(data, list[0]) : null;
}

/**
 * Dal groups words into nests («отвѣтственный» is explained inside «Отвѣчать»
 * and is never a headword). When neither the word nor its lemma is a key, take
 * the longest headword that is a prefix of the word (≥ MIN_PREFIX letters and
 * ≥ MIN_PREFIX_RATIO of the word) — that is the nest in most cases.
 */
function nestByPrefix(data, key) {
  const minLen = Math.max(MIN_PREFIX, Math.ceil(key.length * MIN_PREFIX_RATIO));
  for (let n = key.length - 1; n >= minLen; n--) {
    const p = key.slice(0, n);
    const hit = firstHit(data, data.index, p) || firstHit(data, data.nested, p);
    if (hit) return { ...hit, approx: true };
  }
  return null;
}

/**
 * Find the article for a word: own article by the word, own article by the
 * lemma, then a nested word inside another article (word, then lemma), then
 * the nearest nest by prefix (result carries `approx: true`).
 * @param {string} word  as written (any orthography, ё/ѣ accepted)
 * @param {string|null} [lemma]  normal form from Az (fallback)
 * @returns {{ head:string, text:string, url:string, approx?:boolean }|null}
 */
function lookup(word, lemma) {
  const data = load();
  if (!data) return null;
  const k1 = normalizeKey(word);
  if (!k1) return null;
  const k2 = lemma ? normalizeKey(lemma) : '';
  const keys = k2 && k2 !== k1 ? [k1, k2] : [k1];
  for (const k of keys) {
    const hit = firstHit(data, data.index, k);
    if (hit) return hit;
  }
  for (const k of keys) {
    const hit = firstHit(data, data.nested, k);
    if (hit) return hit;
  }
  for (const k of keys) {
    const hit = nestByPrefix(data, k);
    if (hit) return hit;
  }
  return null;
}

/**
 * Shorten an article to about `max` characters at a sentence boundary and add «…».
 * @param {string} text
 * @param {number} [max=1200]
 * @returns {string}
 */
function excerpt(text, max = DEFAULT_EXCERPT) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  let cut = -1;
  const re = /[.!?…](?=\s)/g;
  let m;
  while ((m = re.exec(head)) !== null) cut = m.index + 1;
  if (cut < max * MIN_EXCERPT_RATIO) {
    const sp = head.lastIndexOf(' ');
    cut = sp > max * MIN_EXCERPT_RATIO ? sp : max;
  }
  return head.slice(0, cut).replace(/[\s,;:—-]+$/, '') + '…';
}

/** Summary for basesInfo(): count comes from meta.json, so no load is triggered. */
function info() {
  const m = state.meta || {};
  const count = typeof m.count === 'number' ? m.count : (state.data ? state.data.count : 0);
  return {
    available: available(),
    loaded: isLoaded(),
    count,
    retrieved: m.retrieved || '',
    file: state.file,
    bytes: available() ? fs.statSync(state.file).size : 0,
  };
}

module.exports = { configure, lookup, excerpt, info, normalizeKey, isLoaded, load };
