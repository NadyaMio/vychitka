'use strict';

/**
 * Small shared helpers for the engine: issue construction, case handling,
 * Cyrillic-aware regex boundaries, Levenshtein distance, JSON loading.
 * No module state lives here.
 */

const fs = require('node:fs');

const CYR = 'а-яё';
const CYR_RE = /^[а-яё]+(?:-[а-яё]+)*$/i;

/** True when the character is an uppercase letter (any script). */
function isUpper(ch) {
  return typeof ch === 'string' && ch.length > 0 && ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/** True when the character is a lowercase letter. */
function isLower(ch) {
  return typeof ch === 'string' && ch.length > 0 && ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

/**
 * Copy the capitalisation pattern of `src` onto `repl`:
 * all-caps source → all-caps result, capitalised source → capitalised result.
 * @param {string} src
 * @param {string} repl
 * @returns {string}
 */
function matchCase(src, repl) {
  if (!src || !repl) return repl;
  const letters = src.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return repl.toUpperCase();
  if (isUpper(src[0])) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/**
 * Build a case-insensitive regex that matches `pattern` as whole Cyrillic words.
 * `\b` does not work for Cyrillic in JS, so lookarounds are used instead.
 * @param {string} pattern  regex source (groups allowed)
 * @param {string} [extraFlags]
 * @returns {RegExp}
 */
function wordRegex(pattern, extraFlags = '') {
  const flags = 'giu' + extraFlags.replace(/[giu]/g, '');
  return new RegExp(`(?<![\\p{L}\\p{N}-])(?:${pattern})(?![\\p{L}\\p{N}-])`, flags);
}

/**
 * Levenshtein edit distance (iterative, O(n*m)); used only on short words.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/**
 * Create a normalised Issue object. `id` is derived from ruleId/para/start so
 * that it is stable for identical input.
 * @param {object} o
 * @returns {object}
 */
function makeIssue(o) {
  const issue = {
    id: `${o.ruleId}:${o.para}:${o.start}`,
    para: o.para,
    start: o.start,
    end: o.end,
    category: o.category,
    ruleId: o.ruleId,
    before: o.before,
    after: o.after,
    alternatives: o.alternatives || [],
    confidence: o.confidence || 'check',
    why: o.why,
    source: o.source || '',
    ref: Array.isArray(o.ref) ? o.ref.slice() : [],
  };
  if (o.note) issue.note = o.note;
  if (o.meta) issue.meta = o.meta;
  if (o.metric) issue.metric = o.metric;
  return issue;
}

/**
 * Read and parse a JSON file; throws with the path in the message on failure.
 * @param {string} file
 * @returns {any}
 */
function loadJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
}

/**
 * Read a plain word list (one word per line, `#` comments allowed) into a Set
 * of lowercase words.
 * @param {string} file
 * @returns {Set<string>}
 */
function loadWordList(file) {
  const set = new Set();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const w = line.replace(/#.*$/, '').trim().toLowerCase();
    if (w) set.add(w);
  }
  return set;
}

/**
 * Drop overlapping issues. Priority: category rank, then longer span, then
 * earlier start. A comma-insertion issue («слово что») that collides with a
 * higher-priority issue on the conjunction is trimmed to «слово » → «слово, »
 * instead of being dropped, so both cards survive.
 * @param {object[]} issues
 * @param {Record<string, number>} rank category → priority (higher wins)
 * @param {(issue: object) => boolean} [standalone] issues that never conflict (whole-sentence signals)
 * @returns {object[]} sorted by para, start
 */
function resolveOverlaps(issues, rank, standalone) {
  const sorted = issues.slice().sort((a, b) =>
    (rank[b.category] || 0) - (rank[a.category] || 0)
    || (b.end - b.start) - (a.end - a.start)
    || a.para - b.para
    || a.start - b.start);
  const kept = [];
  const overlaps = (x) => kept.find((k) => k.para === x.para && x.start < k.end && k.start < x.end && !(standalone && standalone(k)));
  for (const issue of sorted) {
    if (standalone && standalone(issue)) {
      kept.push(issue);
      continue;
    }
    const hit = overlaps(issue);
    if (!hit) {
      kept.push(issue);
      continue;
    }
    const meta = issue.meta;
    if (meta && meta.kind === 'comma-before' && typeof meta.conjStart === 'number' && hit.start >= meta.conjStart && meta.conjStart > issue.start) {
      const before = issue.before.slice(0, meta.conjStart - issue.start);
      const trimmed = {
        ...issue,
        end: meta.conjStart,
        before,
        after: before.replace(/(\s+)$/, ',$1'),
      };
      if (trimmed.after !== trimmed.before && !overlaps(trimmed)) kept.push(trimmed);
    }
  }
  return kept.sort((a, b) => a.para - b.para || a.start - b.start || a.end - b.end);
}

/**
 * Apply issues (after ≠ before) to a document; returns a new document.
 * Overlapping issues are applied right-to-left per paragraph; the first
 * (leftmost after sorting) wins when ranges collide.
 * @param {{paragraphs: Array<{text:string, kind?:string}>}} doc
 * @param {object[]} issues
 * @returns {{paragraphs: Array<{text:string, kind?:string}>}}
 */
function applyIssues(doc, issues) {
  const paragraphs = doc.paragraphs.map((p) => ({ ...p }));
  const byPara = new Map();
  for (const is of issues) {
    if (!is || is.after === is.before || typeof is.after !== 'string') continue;
    if (!byPara.has(is.para)) byPara.set(is.para, []);
    byPara.get(is.para).push(is);
  }
  for (const [para, list] of byPara) {
    if (!paragraphs[para]) continue;
    list.sort((a, b) => b.start - a.start || b.end - a.end);
    let text = paragraphs[para].text;
    let lastStart = Infinity;
    for (const is of list) {
      if (is.end > lastStart) continue;
      if (text.slice(is.start, is.end) !== is.before) continue;
      text = text.slice(0, is.start) + is.after + text.slice(is.end);
      lastStart = is.start;
    }
    paragraphs[para].text = text;
  }
  return { paragraphs };
}

/** Escape a string for use inside a RegExp. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise whitespace variants to a plain space. */
function plainSpaces(s) {
  return s.replace(/[   ]/g, ' ');
}

module.exports = {
  CYR,
  CYR_RE,
  isUpper,
  isLower,
  matchCase,
  wordRegex,
  levenshtein,
  makeIssue,
  resolveOverlaps,
  applyIssues,
  loadJson,
  loadWordList,
  escapeRegex,
  plainSpaces,
};
