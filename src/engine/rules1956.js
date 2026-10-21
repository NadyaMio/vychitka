'use strict';

/**
 * «Правила русской орфографии и пунктуации» (1956) — справочник, на который
 * ссылаются правки (`Issue.ref`). Загружается из basesDir/reference/rules-1956.json.
 *
 * Exports: load(file), rule(n), search(query, limit), source(ref), has(n), info().
 */

const fs = require('node:fs');

const TITLE = 'Правила 1956';
const PART_WEIGHT = { rule: 3, item: 2, note: 1.5, ex: 1 };
const TITLE_WEIGHT = 8;

const state = {
  file: null,
  paragraphs: [],
  byN: new Map(),
  index: [], // { n, parts: [{ t, text, norm }] }
  meta: { source: '', sourceUrl: '', retrieved: '' },
};

/** Normalise text for search: lowercase, ё→е, collapse spaces, strip accents. */
function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/́/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Load the reference file. Missing file is not fatal: the engine keeps working
 * with empty refs (status 'missing' in basesInfo()).
 * @param {string} file
 * @returns {boolean} true when loaded
 */
function load(file) {
  state.file = file;
  state.paragraphs = [];
  state.byN = new Map();
  state.index = [];
  if (!fs.existsSync(file)) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${err.message}`);
  }
  const list = Array.isArray(data) ? data : data.paragraphs || [];
  state.meta = { source: data.source || '', sourceUrl: data.sourceUrl || '', retrieved: data.retrieved || '' };
  for (const p of list) {
    if (typeof p.n !== 'number') continue;
    state.paragraphs.push(p);
    state.byN.set(p.n, p);
    state.index.push({
      n: p.n,
      title: norm(p.section || ''),
      parts: (p.parts || []).map((part) => ({ t: part.t, text: part.text, norm: norm(part.text) })),
    });
  }
  return state.paragraphs.length > 0;
}

/** True when paragraph n exists. */
function has(n) {
  return state.byN.has(n);
}

/**
 * Paragraph by number (a copy), or null.
 * @param {number} n
 * @returns {object|null}
 */
function rule(n) {
  const p = state.byN.get(Number(n));
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

/**
 * Full-text search over rules and examples.
 * Ranking: matches in the rule part weigh more than in examples; paragraphs
 * containing every query word rank above partial matches.
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Array<{n:number, section:string, group:string, url:string, snippet:string, score:number}>}
 */
function search(query, limit = 20) {
  const q = norm(query || '');
  if (!q) return [];
  const words = [...new Set(q.split(' ').filter(Boolean))];
  if (!words.length) return [];
  const phrase = words.length > 1 ? q : null;
  // single letters («буква ё») match whole words only; longer words match as substrings
  const finder = (w) => (w.length === 1
    ? (text, from) => { const re = new RegExp(`(?:^| )${w}(?= |$)`, 'g'); re.lastIndex = from; const mm = re.exec(text); return mm ? mm.index + (mm[0].startsWith(' ') ? 1 : 0) : -1; }
    : (text, from) => text.indexOf(w, from));
  const results = [];
  for (const entry of state.index) {
    let score = 0;
    let matchedWords = 0;
    let snippetPart = null;
    let snippetPos = -1;
    for (const w of words) {
      const find = finder(w);
      let wordHit = false;
      for (const part of entry.parts) {
        let pos = find(part.norm, 0);
        if (pos === -1) continue;
        wordHit = true;
        const firstPos = pos;
        let count = 0;
        while (pos !== -1 && count < 5) {
          count++;
          pos = find(part.norm, pos + w.length);
        }
        score += (PART_WEIGHT[part.t] || 1) * count;
        if (!snippetPart || (PART_WEIGHT[part.t] || 1) > (PART_WEIGHT[snippetPart.t] || 1)) {
          snippetPart = part;
          snippetPos = firstPos;
        }
      }
      if (wordHit) matchedWords++;
    }
    // section title («Буква ё», «Вводные слова») is the strongest signal
    const titleWords = ` ${entry.title} `;
    for (const w of words) if (titleWords.includes(w.length === 1 ? ` ${w} ` : w)) { score += TITLE_WEIGHT; matchedWords = Math.max(matchedWords, 1); }
    if (phrase && entry.title.includes(phrase)) score += TITLE_WEIGHT * 2;
    if (!matchedWords) continue;
    if (matchedWords === words.length) score += 10;
    if (phrase) {
      for (const part of entry.parts) {
        if (part.norm.includes(phrase)) {
          score += 6 * (PART_WEIGHT[part.t] || 1);
          if (part.t === 'rule') {
            snippetPart = part;
            snippetPos = part.norm.indexOf(phrase);
          }
        }
      }
    }
    const p = state.byN.get(entry.n);
    results.push({
      n: entry.n,
      section: p.section,
      group: p.group,
      url: p.url,
      snippet: makeSnippet(snippetPart ? snippetPart.text : '', snippetPos, words[0]),
      score: Math.round(score * 10) / 10,
    });
  }
  results.sort((a, b) => b.score - a.score || a.n - b.n);
  return results.slice(0, Math.max(1, limit | 0));
}

function makeSnippet(text, approxPos, word) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  let pos = clean.toLowerCase().replace(/ё/g, 'е').indexOf(word);
  if (pos === -1) pos = Math.max(0, approxPos);
  const start = Math.max(0, pos - 70);
  const end = Math.min(clean.length, pos + 110);
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '');
}

/**
 * Source string for an issue: «Правила 1956 · § 140 · Главное и придаточное предложения».
 * Multiple refs: «Правила 1956 · § 61, 62 · Двойные согласные» (section of the first).
 * @param {number[]} ref
 * @param {string} [fallback]
 * @returns {string}
 */
function source(ref, fallback = 'Профиль: редакционная норма') {
  const nums = (ref || []).filter((n) => state.byN.has(n));
  if (!nums.length) return fallback;
  const first = state.byN.get(nums[0]);
  return `${TITLE} · § ${nums.join(', ')} · ${first.section}`;
}

/** Keep only existing paragraph numbers. */
function validRefs(ref) {
  return (ref || []).filter((n) => state.byN.has(n));
}

/** Summary for basesInfo(). */
function info() {
  return {
    loaded: state.paragraphs.length > 0,
    count: state.paragraphs.length,
    file: state.file,
    ...state.meta,
  };
}

module.exports = { load, rule, search, source, has, validRefs, info, norm };
