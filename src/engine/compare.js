'use strict';

/**
 * Compare two versions of a document: paragraph alignment (LCS over normalised
 * paragraphs + similarity pairing), then word-level diff inside each pair.
 */

const Diff = require('diff');

const SIMILAR_THRESHOLD = 0.5;
const EXCERPT = 60;
const TITLES = {
  lost: 'Потерян абзац',
  added: 'Добавлен абзац',
  notApplied: 'Правка не применена',
  space: 'Слетел пробел',
  changed: 'Текст изменён',
};

const WORD_RE = /[\p{L}\p{N}]+(?:(?:-\r?\n[ \t]*|['’-])[\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

/** Tokens with positions; `key` glues soft line-break hyphenation («дизайн-\nер» → «дизайнер»). */
function tokenizeWords(text) {
  const out = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    const key = raw.replace(/-\r?\n[ \t]*/g, '').toLowerCase();
    out.push({ raw, key, start: m.index, end: m.index + raw.length, word: /[\p{L}\p{N}]/u.test(raw) });
  }
  return out;
}

function normalizeParagraph(text) {
  return tokenizeWords(text).map((t) => t.key).join(' ');
}

function wordsOf(text) {
  return tokenizeWords(text).filter((t) => t.word).map((t) => t.key);
}

function dice(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const w of a) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of b) {
    const c = counts.get(w) || 0;
    if (c > 0) { common++; counts.set(w, c - 1); }
  }
  return (2 * common) / (a.length + b.length);
}

/** LCS alignment of two arrays of strings; returns pairs of indexes. */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Align paragraphs. Exact (normalised) matches anchor the alignment; the
 * unmatched runs in between are paired by similarity.
 */
function alignParagraphs(aTexts, bTexts) {
  const an = aTexts.map(normalizeParagraph);
  const bn = bTexts.map(normalizeParagraph);
  const anchors = lcsPairs(an, bn);
  const pairs = [];
  let ai = 0;
  let bi = 0;
  const flushGap = (aEnd, bEnd) => {
    const aRun = [];
    const bRun = [];
    for (let i = ai; i < aEnd; i++) aRun.push(i);
    for (let j = bi; j < bEnd; j++) bRun.push(j);
    const aWords = aRun.map((i) => wordsOf(aTexts[i]));
    const bWords = bRun.map((j) => wordsOf(bTexts[j]));
    const usedB = new Set();
    for (let x = 0; x < aRun.length; x++) {
      let best = -1;
      let bestScore = SIMILAR_THRESHOLD;
      for (let y = 0; y < bRun.length; y++) {
        if (usedB.has(y)) continue;
        const s = dice(aWords[x], bWords[y]);
        if (s > bestScore) { bestScore = s; best = y; }
      }
      if (best === -1) pairs.push({ a: aRun[x], b: null });
      else {
        for (let y = 0; y < best; y++) if (!usedB.has(y)) { usedB.add(y); pairs.push({ a: null, b: bRun[y] }); }
        usedB.add(best);
        pairs.push({ a: aRun[x], b: bRun[best] });
      }
    }
    for (let y = 0; y < bRun.length; y++) if (!usedB.has(y)) pairs.push({ a: null, b: bRun[y] });
  };
  for (const [i, j] of anchors) {
    flushGap(i, j);
    pairs.push({ a: i, b: j });
    ai = i + 1;
    bi = j + 1;
  }
  flushGap(aTexts.length, bTexts.length);
  return pairs;
}

function excerpt(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > EXCERPT ? t.slice(0, EXCERPT).trim() + '…' : t;
}

function stripSpaces(s) {
  return s.replace(/[\s ]+/g, '');
}

function findAll(hay, needle) {
  const out = [];
  if (!needle) return out;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    out.push([pos, pos + needle.length]);
    pos = hay.indexOf(needle, pos + 1);
  }
  return out;
}

function intersects(range, list) {
  return list.some(([s, e]) => range[0] < e && s < range[1]) || list.some(([s, e]) => range[0] === range[1] && range[0] >= s && range[0] <= e);
}

/** Word-level hunks for one aligned pair. */
function pairHunks(aText, bText) {
  const at = tokenizeWords(aText);
  const bt = tokenizeWords(bText);
  const parts = Diff.diffArrays(at.map((t) => t.key), bt.map((t) => t.key));
  const hunks = [];
  let ai = 0;
  let bi = 0;
  let cur = null;
  for (const part of parts) {
    const len = part.value.length;
    if (part.removed) {
      if (!cur) cur = { aFrom: ai, aTo: ai, bFrom: bi, bTo: bi };
      cur.aTo = ai + len;
      ai += len;
    } else if (part.added) {
      if (!cur) cur = { aFrom: ai, aTo: ai, bFrom: bi, bTo: bi };
      cur.bTo = bi + len;
      bi += len;
    } else {
      if (cur) { hunks.push(cur); cur = null; }
      ai += len;
      bi += len;
    }
  }
  if (cur) hunks.push(cur);
  return hunks.map((h) => {
    const aRange = h.aTo > h.aFrom ? [at[h.aFrom].start, at[h.aTo - 1].end] : [h.aFrom < at.length ? at[h.aFrom].start : aText.length, h.aFrom < at.length ? at[h.aFrom].start : aText.length];
    const bRange = h.bTo > h.bFrom ? [bt[h.bFrom].start, bt[h.bTo - 1].end] : [h.bFrom < bt.length ? bt[h.bFrom].start : bText.length, h.bFrom < bt.length ? bt[h.bFrom].start : bText.length];
    return { aRange, bRange, aText: aText.slice(aRange[0], aRange[1]), bText: bText.slice(bRange[0], bRange[1]) };
  });
}

const LETTER = /[а-яёa-z0-9]/i;
const stripPunct = (t) => t.replace(/[^а-яёa-z0-9]/gi, '').toLowerCase();
/** Expand a range to whole whitespace-delimited words. */
function wordSpan(text, [s, e]) {
  let a = s, b = e;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return [a, b];
}
/** End of the word after position `e` (skipping the whitespace in between). */
function nextWordEnd(text, e) {
  let b = e;
  while (b < text.length && /\s/.test(text[b])) b++;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return b;
}
/** Start of the word before position `s` (skipping the whitespace in between). */
function prevWordStart(text, s) {
  let a = s;
  while (a > 0 && /\s/.test(text[a - 1])) a--;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  return a;
}

/** Whitespace-only differences between equal word sequences. */
function spaceHunks(aText, bText) {
  const at = tokenizeWords(aText);
  const bt = tokenizeWords(bText);
  const out = [];
  if (at.length !== bt.length) return out;
  for (let i = 0; i < at.length - 1; i++) {
    const ga = aText.slice(at[i].end, at[i + 1].start);
    const gb = bText.slice(bt[i].end, bt[i + 1].start);
    if (ga === gb) continue;
    out.push({ aRange: [at[i].start, at[i + 1].end], bRange: [bt[i].start, bt[i + 1].end], aText: aText.slice(at[i].start, at[i + 1].end), bText: bText.slice(bt[i].start, bt[i + 1].end) });
  }
  return out;
}

/**
 * Compare two documents.
 * @param {{paragraphs: Array<{text:string}>}} aDoc original
 * @param {{paragraphs: Array<{text:string}>}} bDoc new version
 * @param {{ appliedFixes?: Array<{before:string, after:string}> }} [opts]
 * @returns {{ pairs:Array<{a:number|null,b:number|null}>, diffs:object[], similarity:number, words:number }}
 */
function compare(aDoc, bDoc, opts = {}) {
  const aTexts = (aDoc && aDoc.paragraphs ? aDoc.paragraphs : []).map((p) => String(p.text || ''));
  const bTexts = (bDoc && bDoc.paragraphs ? bDoc.paragraphs : []).map((p) => String(p.text || ''));
  const fixes = (opts.appliedFixes || []).filter((f) => f && typeof f.before === 'string' && typeof f.after === 'string' && f.before !== f.after);
  const pairs = alignParagraphs(aTexts, bTexts);
  const diffs = [];
  const push = (d) => {
    diffs.push({ id: `cmp:${d.type}:${d.aPara === null ? '-' : d.aPara}:${d.bPara === null ? '-' : d.bPara}:${d.aRange ? d.aRange[0] : d.bRange ? d.bRange[0] : 0}`, ...d, title: TITLES[d.type] });
  };
  for (const pair of pairs) {
    if (pair.a !== null && pair.b === null) {
      push({ type: 'lost', aPara: pair.a, bPara: null, aRange: [0, aTexts[pair.a].length], bRange: null, text: `Абзац ${pair.a + 1} есть в исходной версии, но отсутствует в новой: «${excerpt(aTexts[pair.a])}».` });
      continue;
    }
    if (pair.a === null && pair.b !== null) {
      push({ type: 'added', aPara: null, bPara: pair.b, aRange: null, bRange: [0, bTexts[pair.b].length], text: `В новой версии появился абзац, которого нет в исходной: «${excerpt(bTexts[pair.b])}».` });
      continue;
    }
    const aText = aTexts[pair.a];
    const bText = bTexts[pair.b];
    if (aText === bText) continue;
    const fixHitsA = fixes.map((f) => findAll(aText, f.after));
    const fixHitsB = fixes.map((f) => findAll(bText, f.before));
    const hunks = pairHunks(aText, bText);
    const seen = new Set();
    for (const h of hunks) {
      let type = 'changed';
      // show whole words (and the neighbouring words when only punctuation differs), not raw character slices
      const punctOnly = stripSpaces(h.aText) !== stripSpaces(h.bText) && stripPunct(h.aText) === stripPunct(h.bText);
      const trimP = (t) => t.replace(/^[«»"„“(.,;:!?]+|[«»"„“).,;:!?]+$/g, '');
      let wa = wordSpan(aText, h.aRange), wb = wordSpan(bText, h.bRange);
      if (punctOnly) {
        wa = [prevWordStart(aText, h.aRange[0]), nextWordEnd(aText, h.aRange[1])];
        wb = [prevWordStart(bText, h.bRange[0]), nextWordEnd(bText, h.bRange[1])];
      }
      const sa = punctOnly ? aText.slice(wa[0], wa[1]) : trimP(aText.slice(wa[0], wa[1]));
      const sb = punctOnly ? bText.slice(wb[0], wb[1]) : trimP(bText.slice(wb[0], wb[1]));
      const note = /-\n/.test(sb) ? ': неверный перенос попал в текст' : punctOnly ? ': другая пунктуация' : '';
      let text = `«${excerpt(sa).replace(/-\s+/g, '-')}» → «${excerpt(sb).replace(/-\s+/g, '-')}»${note}.`;
      if (punctOnly) { h.aRange = wa; h.bRange = wb; }
      if (stripSpaces(h.aText) === stripSpaces(h.bText)) {
        type = 'space';
        text = `Различие только в пробелах: «${h.aText}» → «${h.bText}».`;
      } else {
        for (let k = 0; k < fixes.length; k++) {
          if (!fixHitsA[k].length || !fixHitsB[k].length) continue;
          if (intersects(h.aRange, fixHitsA[k]) && intersects(h.bRange, fixHitsB[k])) {
            type = 'notApplied';
            text = `Правка «${fixes[k].before} → ${fixes[k].after}» была принята, но в новой версии по-прежнему «${h.bText || fixes[k].before}».`;
            break;
          }
        }
      }
      const key = `${type}:${h.aRange[0]}:${h.bRange[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      push({ type, aPara: pair.a, bPara: pair.b, aRange: h.aRange, bRange: h.bRange, text });
    }
    if (!hunks.length) {
      for (const h of spaceHunks(aText, bText)) {
        push({ type: 'space', aPara: pair.a, bPara: pair.b, aRange: h.aRange, bRange: h.bRange, text: `Различие только в пробелах: «${h.aText}» → «${h.bText}».` });
      }
    }
  }
  const aWords = aTexts.flatMap(wordsOf);
  const bWords = bTexts.flatMap(wordsOf);
  let common = 0;
  for (const part of Diff.diffArrays(aWords, bWords)) if (!part.added && !part.removed) common += part.value.length;
  const similarity = aWords.length + bWords.length ? Math.round((200 * common) / (aWords.length + bWords.length)) : 100;
  diffs.sort((x, y) => {
    const xa = x.aPara === null ? x.bPara : x.aPara;
    const ya = y.aPara === null ? y.bPara : y.aPara;
    return xa - ya || ((x.aRange || x.bRange)[0] - (y.aRange || y.bRange)[0]);
  });
  return { pairs, diffs, similarity, words: aWords.length };
}

module.exports = { compare, alignParagraphs, tokenizeWords };
