'use strict';

/**
 * Tokeniser: splits a paragraph into tokens (words, numbers, punctuation,
 * spaces) and groups them into sentences. All positions are UTF-16 indexes
 * into the paragraph text. Non-breaking spaces count as spaces.
 */

const { isUpper } = require('./util');

const TOKEN_RE = /(\s+)|([\p{L}\p{M}\d]+(?:['’][\p{L}\p{M}]+)*(?:-[\p{L}\p{M}\d]+(?:['’][\p{L}\p{M}]+)*)*)|(.)/suy;
const CYR_WORD_RE = /^[а-яё]+(?:-[а-яё]+)*$/i;
const LAT_WORD_RE = /^[a-z]+(?:-[a-z]+)*$/i;
const NUM_RE = /^\d+$/;
const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['»', '"', '”', '“', ')', ']', '’', "'"]);
const OPENERS = new Set(['«', '"', '„', '“', '(', '[', '—', '–', '-']);

/** Abbreviations after which a period does not end a sentence. */
const ABBREVIATIONS = new Set([
  'т', 'е', 'д', 'п', 'г', 'гг', 'ул', 'им', 'др', 'пр', 'см', 'ср', 'стр', 'тыс', 'млн', 'млрд',
  'руб', 'коп', 'обл', 'кв', 'проч', 'тел', 'напр', 'англ', 'рус', 'лат', 'нем', 'фр', 'экз', 'изд',
  'сб', 'вс', 'пн', 'вт', 'чт', 'пт', 'мин', 'сек', 'час', 'доп', 'искл', 'абз', 'гл', 'ст', 'п',
  'пп', 'рис', 'табл', 'прим', 'ред', 'сост', 'пер', 'авт', 'доц', 'проф', 'акад', 'ак', 'ген',
]);

/**
 * @typedef {object} Token
 * @property {number} i        index in the token array
 * @property {string} type     'word' | 'latin' | 'num' | 'mixed' | 'punct' | 'space'
 * @property {string} text
 * @property {string} lower
 * @property {number} start
 * @property {number} end
 * @property {boolean} cap     first letter uppercase, rest not all uppercase
 * @property {boolean} allCaps whole token uppercase (2+ letters)
 * @property {number} si       sentence index
 */

/**
 * Split text into tokens.
 * @param {string} text
 * @returns {Token[]}
 */
function tokenize(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  let i = 0;
  while (TOKEN_RE.lastIndex < text.length && (m = TOKEN_RE.exec(text)) !== null) {
    const start = m.index;
    const tok = m[0];
    const end = start + tok.length;
    let type;
    if (m[1] !== undefined) type = 'space';
    else if (m[2] !== undefined) {
      if (CYR_WORD_RE.test(tok)) type = 'word';
      else if (NUM_RE.test(tok)) type = 'num';
      else if (LAT_WORD_RE.test(tok)) type = 'latin';
      else type = 'mixed';
    } else type = 'punct';
    const lower = tok.toLowerCase();
    const letters = type === 'word' || type === 'latin' || type === 'mixed';
    tokens.push({
      i: i++,
      type,
      text: tok,
      lower,
      start,
      end,
      cap: letters && isUpper(tok[0]) && tok.slice(1) !== tok.slice(1).toUpperCase(),
      allCaps: letters && tok.length > 1 && tok === tok.toUpperCase() && tok !== lower,
      si: 0,
    });
    if (end === start) TOKEN_RE.lastIndex++;
  }
  return tokens;
}

/** Index of the previous non-space token, or -1. */
function prevIndex(tokens, i) {
  for (let k = i - 1; k >= 0; k--) if (tokens[k].type !== 'space') return k;
  return -1;
}

/** Index of the next non-space token, or -1. */
function nextIndex(tokens, i) {
  for (let k = i + 1; k < tokens.length; k++) if (tokens[k].type !== 'space') return k;
  return -1;
}

/**
 * Decide whether the terminator token at `i` ends a sentence.
 * @param {Token[]} tokens
 * @param {number} i
 * @returns {number} index of the last token belonging to the sentence, or -1
 */
function sentenceEndAt(tokens, i) {
  const t = tokens[i];
  if (t.type !== 'punct' || !TERMINATORS.has(t.text)) return -1;
  // "3.5", "10.000" – decimal separators
  const p = prevIndex(tokens, i);
  const prev = p >= 0 ? tokens[p] : null;
  if (t.text === '.' && prev && prev.type === 'num' && i + 1 < tokens.length && tokens[i + 1].type === 'num') return -1;
  // Abbreviations and initials: "т. е.", "А. С. Пушкин", "г. Москва"
  if (t.text === '.' && prev && prev.end === t.start) {
    if (prev.type === 'word' && (prev.text.length === 1 || ABBREVIATIONS.has(prev.lower))) return -1;
  }
  // absorb following terminators and closing quotes/brackets
  let last = i;
  let k = i + 1;
  while (k < tokens.length && tokens[k].type === 'punct' && (TERMINATORS.has(tokens[k].text) || CLOSERS.has(tokens[k].text))) {
    last = k;
    k++;
  }
  const n = nextIndex(tokens, last);
  if (n === -1) return last;
  const next = tokens[n];
  if (tokens[last].end === next.start && next.type !== 'punct') return -1; // "слово.слово" – no space, not a boundary
  if (next.type === 'punct') return OPENERS.has(next.text) ? last : -1;
  if (next.type === 'num') return last;
  if (isUpper(next.text[0])) return last;
  return -1;
}

/**
 * Tokenise a paragraph and group the tokens into sentences.
 * @param {string} text
 * @returns {{ tokens: Token[], sentences: Array<{start:number,end:number,tokens:number[],words:number[]}> }}
 */
function analyze(text) {
  const tokens = tokenize(text);
  const sentences = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.tokens.length) {
      cur.start = tokens[cur.tokens[0]].start;
      cur.end = tokens[cur.tokens[cur.tokens.length - 1]].end;
      sentences.push(cur);
    }
    cur = null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'space' && !cur) continue;
    if (!cur) cur = { start: t.start, end: t.end, tokens: [], words: [] };
    cur.tokens.push(i);
    if (t.type === 'word') cur.words.push(i);
    t.si = sentences.length;
    const last = sentenceEndAt(tokens, i);
    if (last !== -1) {
      for (let k = i + 1; k <= last; k++) {
        cur.tokens.push(k);
        tokens[k].si = sentences.length;
      }
      i = last;
      flush();
    }
  }
  flush();
  // trim trailing spaces from sentence token lists
  for (const s of sentences) {
    while (s.tokens.length && tokens[s.tokens[s.tokens.length - 1]].type === 'space') s.tokens.pop();
    if (s.tokens.length) s.end = tokens[s.tokens[s.tokens.length - 1]].end;
  }
  return { tokens, sentences };
}

/**
 * Spans of text inside quotes («…», "…", „…“, “…”) — used for `skipQuotes`.
 * Unbalanced quotes produce no span.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function quoteSpans(text) {
  const spans = [];
  const stack = [];
  const pairs = { '«': '»', '„': '“', '“': '”' };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (stack.length && stack[stack.length - 1].ch === '"') {
        spans.push([stack.pop().pos, i + 1]);
      } else {
        stack.push({ ch: '"', pos: i });
      }
    } else if (stack.length && stack[stack.length - 1].close === ch) {
      spans.push([stack.pop().pos, i + 1]);
    } else if (pairs[ch]) {
      stack.push({ ch, pos: i, close: pairs[ch] });
    }
  }
  return spans;
}

/**
 * Spans of direct speech in a dialogue paragraph (starts with a dash):
 * segments alternate speech / author words split by " — ".
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function speechSpans(text) {
  const m = /^\s*[—–-]\s*/.exec(text);
  if (!m) return [];
  const spans = [];
  let pos = m[0].length;
  let speech = true;
  const re = /\s[—–-]\s/g;
  re.lastIndex = pos;
  let d;
  while ((d = re.exec(text)) !== null) {
    if (speech) spans.push([pos, d.index]);
    pos = d.index + d[0].length;
    speech = !speech;
  }
  if (speech) spans.push([pos, text.length]);
  return spans;
}

/** True when [start,end) lies inside any of the spans. */
function inSpans(spans, start, end) {
  for (const [s, e] of spans) if (start >= s && end <= e) return true;
  return false;
}

module.exports = {
  tokenize,
  analyze,
  prevIndex,
  nextIndex,
  quoteSpans,
  speechSpans,
  inSpans,
  TERMINATORS,
  ABBREVIATIONS,
};
