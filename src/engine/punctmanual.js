'use strict';

/**
 * «Пособие по пунктуации» — учебное пособие Е. П. Чечулиной «Русский язык
 * (таблицы по пунктуации)» (2020), пересказанное своими словами в
 * basesDir/reference/punct-manual.json. Записи пособия дополняют Правила 1956 г.
 * в справочнике (searchRules) и в карточках правок (Issue.manualRef).
 *
 * Exports: load(file), rule(id), search(query, limit), source(id), has(id), info(), GROUP.
 */

const fs = require('node:fs');
const { norm, rankEntries } = require('./rules1956');

const GROUP = 'Пособие по пунктуации';
const SOURCE_PREFIX = 'Пособие по пунктуации';

const state = {
  file: null,
  items: [],
  byId: new Map(),
  index: [], // { key, title, parts: [{ t, text, norm }] } — same shape as rules1956 index
  meta: { source: null, note: '', retrieved: '', url: '' },
};

/**
 * Load the manual. A missing file is not fatal: the engine keeps working
 * without manual entries (status 'missing' in basesInfo()).
 * @param {string} file
 * @returns {boolean} true when at least one entry was loaded
 */
function load(file) {
  state.file = file;
  state.items = [];
  state.byId = new Map();
  state.index = [];
  state.meta = { source: null, note: '', retrieved: '', url: '' };
  if (!fs.existsSync(file)) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${err.message}`);
  }
  const src = data.source && typeof data.source === 'object' ? data.source : {};
  state.meta = { source: src, note: data.note || '', retrieved: data.retrieved || '', url: src.url || '' };
  for (const it of data.items || []) {
    if (!it || typeof it.id !== 'string' || !it.id) continue;
    const entry = {
      id: it.id,
      section: it.section || '',
      title: it.title || '',
      rule: it.rule || '',
      examples: Array.isArray(it.examples) ? it.examples.map(String) : [],
      ref1956: Array.isArray(it.ref1956) ? it.ref1956.filter((n) => typeof n === 'number') : [],
      page: typeof it.page === 'number' ? it.page : null,
    };
    state.items.push(entry);
    state.byId.set(entry.id, entry);
    state.index.push({
      key: entry.id,
      title: norm(`${entry.section} ${entry.title}`),
      parts: [
        { t: 'rule', text: entry.rule, norm: norm(entry.rule) },
        ...entry.examples.map((ex) => ({ t: 'ex', text: ex, norm: norm(ex) })),
      ],
    });
  }
  return state.items.length > 0;
}

/** Link to the page of the original PDF. */
function urlFor(page) {
  const base = state.meta.url || '';
  if (!base) return '';
  return typeof page === 'number' ? `${base}#page=${page}` : base;
}

/** True when an entry with this id exists. */
function has(id) {
  return state.byId.has(String(id));
}

/**
 * Entry by id (a copy with the `url` of the original page), or null.
 * @param {string} id  e.g. 'pm-dash-nouns'
 * @returns {{id:string, section:string, title:string, rule:string, examples:string[], ref1956:number[], page:number|null, url:string}|null}
 */
function rule(id) {
  const e = state.byId.get(String(id));
  if (!e) return null;
  return { ...e, examples: e.examples.slice(), ref1956: e.ref1956.slice(), url: urlFor(e.page) };
}

/**
 * Full-text search over the manual (same ranking as the 1956 rules).
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Array<{n:null, id:string, section:string, group:string, url:string, snippet:string, score:number, source:'manual'}>}
 */
function search(query, limit = 20) {
  const ranked = rankEntries(state.index, query);
  const out = [];
  for (const r of ranked) {
    const e = state.byId.get(r.key);
    if (!e) continue;
    out.push({
      n: null,
      id: e.id,
      section: e.title ? `${e.section}: ${e.title}` : e.section,
      group: GROUP,
      url: urlFor(e.page),
      snippet: r.snippet || e.rule,
      score: r.score,
      source: 'manual',
    });
  }
  return out.slice(0, Math.max(1, limit | 0));
}

/**
 * Source string for an issue without 1956 refs: «Пособие по пунктуации · Тире между подлежащим и сказуемым».
 * @param {string|string[]} ids
 * @param {string} [fallback]
 * @returns {string}
 */
function source(ids, fallback = 'Профиль: редакционная норма') {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => state.byId.has(id));
  if (!list.length) return fallback;
  return `${SOURCE_PREFIX} · ${state.byId.get(list[0]).section}`;
}

/** Keep only existing ids. */
function validRefs(ids) {
  return (Array.isArray(ids) ? ids : []).map(String).filter((id) => state.byId.has(id));
}

/** Summary for basesInfo(). */
function info() {
  const src = state.meta.source || {};
  return {
    loaded: state.items.length > 0,
    count: state.items.length,
    file: state.file,
    title: src.title || '',
    compiler: src.compiler || '',
    year: src.year || null,
    url: state.meta.url,
    retrieved: state.meta.retrieved,
    note: state.meta.note,
  };
}

module.exports = { load, rule, search, source, has, validRefs, info, GROUP };
