'use strict';

/**
 * Punctuation: commas before subordinate/adversative conjunctions, introductory
 * words, «несмотря на» at sentence start, sentence-initial «Однако,», and
 * mechanical defects (double marks, space before a mark, missing space after).
 */

const morph = require('./morph');
const { makeIssue, matchCase } = require('./util');
const { ABBREVIATIONS } = require('./tokenize');

const SRC_ROSENTAL = 'Розенталь · сложноподчинённое предложение';
const KOTORYJ_FORMS = new Set(['который', 'которая', 'которое', 'которые', 'которого', 'которой', 'которому', 'которую', 'которым', 'которыми', 'которых', 'котором']);
const KAKOJ_FORMS = new Set(['какой', 'какая', 'какое', 'какие', 'какого', 'какую', 'каким', 'каких', 'какому', 'каком', 'какими']);
const CHEJ_FORMS = new Set(['чей', 'чья', 'чьё', 'чье', 'чьи', 'чьего', 'чьей', 'чьему', 'чьим', 'чьих', 'чью', 'чьими', 'чьём', 'чьем']);
const RELATIVE_WORDS = new Set(['что', 'кто', 'чем', 'чего', 'чему', 'ком', 'кого', 'кому', 'кем', 'где', 'куда', 'откуда']);
const NESMOTRYA_PRONOUNS = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'все', 'всё', 'это', 'никто', 'ничто', 'каждый', 'многие', 'некоторые', 'кто-то', 'что-то', 'нам', 'мне', 'ему', 'ей', 'им', 'вам', 'тебе']);
const COORD_BEFORE_INTRO = new Set(['а', 'и', 'но', 'да']);

function compileIntro(items) {
  return items
    .filter((it) => it.confidence !== 'skip')
    .map((it) => ({ ...it, words: it.text.toLowerCase().split(' ') }))
    .sort((a, b) => b.words.length - a.words.length);
}

function compileConj(data) {
  const sub = data.subordinating.map((it) => {
    const entry = { ...it, words: it.text.toLowerCase().split(' ') };
    if (it.forms) {
      if (it.text === 'который') entry.formSet = KOTORYJ_FORMS;
      else if (it.text === 'какой') entry.formSet = KAKOJ_FORMS;
      else if (it.text === 'чей') entry.formSet = CHEJ_FORMS;
    }
    return entry;
  }).sort((a, b) => b.words.length - a.words.length);
  return {
    subordinating: sub,
    adversative: data.adversative.map((it) => ({ ...it, words: it.text.toLowerCase().split(' ') })).sort((a, b) => b.words.length - a.words.length),
    stops: new Set(data.stops),
    headPos: new Set(data.head_pos),
    prepositions: new Set(data.prepositions),
  };
}

/** Are word tokens wi..wi+k-1 (indexes into sentence.words) separated only by spaces? */
function adjacent(ctx, sentence, wi, k) {
  for (let j = 0; j < k - 1; j++) {
    const a = ctx.tokens[sentence.words[wi + j]];
    const b = ctx.tokens[sentence.words[wi + j + 1]];
    for (let t = a.i + 1; t < b.i; t++) if (ctx.tokens[t].type !== 'space') return false;
  }
  return true;
}

function matchEntry(ctx, sentence, wi, entry) {
  const words = sentence.words;
  if (wi + entry.words.length > words.length) return false;
  for (let j = 0; j < entry.words.length; j++) {
    const tok = ctx.tokens[words[wi + j]];
    const want = entry.words[j];
    if (j === 0 && entry.formSet) {
      if (!entry.formSet.has(tok.lower)) return false;
    } else if (tok.lower !== want) return false;
  }
  return adjacent(ctx, sentence, wi, entry.words.length);
}

function isHead(ctx, tok, headPos) {
  if (!tok || tok.type !== 'word') return tok && (tok.type === 'num');
  if (tok.cap) return true; // proper noun
  const parses = morph.dictParses(tok.text);
  if (!parses.length) return morph.parse(tok.text).some((p) => headPos.has(p.tag.POS));
  return parses.some((p) => headPos.has(p.tag.POS));
}

function commaIssue(ctx, prevTok, conjTok, ruleId, confidence, why, ref, source, meta) {
  const gap = ctx.text.slice(prevTok.end, conjTok.start);
  const before = ctx.text.slice(prevTok.start, conjTok.end);
  const after = prevTok.text + ',' + gap + conjTok.text;
  return makeIssue({
    para: ctx.para,
    start: prevTok.start,
    end: conjTok.end,
    category: 'punctuation',
    ruleId,
    before,
    after,
    confidence,
    why,
    ref,
    source,
    meta: { kind: 'comma-before', conjStart: conjTok.start, ...(meta || {}) },
  });
}

function refFor(entry) {
  if (entry.ref) return entry.ref;
  if (entry.kind === 'li') return [140];
  if (['будто', 'как будто', 'словно'].includes(entry.text)) return [140, 150];
  if (entry.text === 'чем') return [150];
  if (entry.words.length > 1) return [141];
  return [140];
}

function whyFor(entry, shifted, prepText) {
  if (entry.kind === 'li') return 'Косвенный вопрос с «ли» — это придаточное предложение, перед ним ставится запятая.';
  if (shifted) return `Запятая ставится перед предлогом, с которого начинается придаточное: «…, ${prepText} ${entry.text}…».`;
  if (entry.words.length > 1) return `Перед сложным союзом «${entry.text}» ставится запятая — один раз, перед первым словом.`;
  if (entry.formSet) return `Перед союзным словом «${entry.text}» начинается придаточное — нужна запятая.`;
  return `Придаточное предложение отделяется запятой: перед «${entry.text}» нужна запятая.`;
}

function subordinatingIssue(ctx, sentence, wi, conj) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  for (const entry of conj.subordinating) {
    if (!matchEntry(ctx, sentence, wi, entry)) continue;
    const lastTok = ctx.tokens[words[wi + entry.words.length - 1]];
    const next = ctx.nextTokenFrom(lastTok.end);
    const nextWord = next && next.type === 'word' ? next : null;
    if (entry.skipIfNext && nextWord && entry.skipIfNext.includes(nextWord.lower)) return null;
    if (entry.skipIfLast && (!next || next.type === 'punct')) return null;
    if (entry.nextVerb) {
      let w = nextWord;
      if (w && w.lower === 'не') w = ctx.nextWordFrom(w.end);
      if (!w || !morph.dictParses(w.text).some((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN')) return null;
    }

    if (entry.kind === 'li') {
      if (wi < 2) return null;
      const clauseTok = ctx.tokens[words[wi - 1]];
      if (!adjacent(ctx, sentence, wi - 1, 2)) return null;
      if (entry.skipIfPrev && entry.skipIfPrev.includes(clauseTok.lower)) return null;
      const headTok = ctx.prevTokenBefore(clauseTok.start);
      if (!headTok || headTok.type !== 'word' || headTok.si !== tok.si) return null;
      if (conj.stops.has(headTok.lower)) return null;
      if (!morph.dictParses(headTok.text).some((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN' || p.tag.POS === 'ADVB' || p.tag.POS === 'PRED')) return null;
      if (!morph.dictParses(clauseTok.text).some((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN' || p.tag.POS === 'ADVB' || p.tag.POS === 'NOUN' || p.tag.POS === 'ADJS' || p.tag.POS === 'NPRO')) return null;
      return commaIssue(ctx, headTok, clauseTok, 'punct.comma-li', 'check', whyFor(entry), refFor(entry), undefined);
    }

    let prevTok = ctx.prevTokenBefore(tok.start);
    if (!prevTok || prevTok.type !== 'word' || prevTok.si !== tok.si) return null;
    let shifted = false;
    let prepText = '';
    const relative = entry.formSet || RELATIVE_WORDS.has(entry.text);
    if (entry.shiftPrep && relative && conj.prepositions.has(prevTok.lower)) {
      const beforePrep = ctx.prevTokenBefore(prevTok.start);
      if (!beforePrep || beforePrep.type !== 'word' || beforePrep.si !== tok.si) return null;
      if (!entry.formSet && !['что', 'чем', 'кто'].includes(entry.text)) return null;
      shifted = true;
      prepText = prevTok.text;
      const anchor = prevTok;
      prevTok = beforePrep;
      if (conj.stops.has(prevTok.lower)) return null;
      if (entry.skipIfPrev && entry.skipIfPrev.includes(prevTok.lower)) return null;
      const confidence = isHead(ctx, prevTok, conj.headPos) ? entry.confidence : 'check';
      return commaIssue(ctx, prevTok, anchor, 'punct.comma-before-conj', confidence, whyFor(entry, true, prepText), refFor(entry), undefined, { conj: entry.text });
    }
    if (conj.stops.has(prevTok.lower)) {
      // «то, что» is allowed unless «не то что»
      if (!(prevTok.lower === 'то' && entry.text === 'что')) return null;
    }
    if (prevTok.lower === 'то') {
      const beforeTo = ctx.prevTokenBefore(prevTok.start);
      if (beforeTo && beforeTo.type === 'word' && ['не', 'и', 'а', 'да'].includes(beforeTo.lower)) return null;
    }
    if (entry.skipIfPrev && entry.skipIfPrev.includes(prevTok.lower)) return null;
    if (conj.prepositions.has(prevTok.lower) && !entry.formSet) return null; // «о чём», «за что» – pronoun after preposition
    let confidence = entry.confidence || 'check';
    if (entry.needsHead && !isHead(ctx, prevTok, conj.headPos)) confidence = 'check';
    return commaIssue(ctx, prevTok, tok, 'punct.comma-before-conj', confidence, whyFor(entry, false), refFor(entry), undefined, { conj: entry.text });
  }
  return null;
}

function adversativeIssue(ctx, sentence, wi, conj) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  for (const entry of conj.adversative) {
    if (!matchEntry(ctx, sentence, wi, entry)) continue;
    const prevTok = ctx.prevTokenBefore(tok.start);
    if (!prevTok || prevTok.type !== 'word' || prevTok.si !== tok.si) return null;
    if (conj.stops.has(prevTok.lower)) return null;
    if (entry.skipIfPrev && entry.skipIfPrev.includes(prevTok.lower)) return null;
    if (prevTok.text.length === 1 && entry.text === 'а') return null; // «от А до Я»
    const next = ctx.nextTokenFrom(tok.end);
    if (!next) return null;
    if (entry.text === 'а' && next.type === 'punct') return null;
    if (entry.text === 'то есть') {
      const nextWord = next.type === 'word' ? next : null;
      if (!nextWord) return null;
    }
    const ref = entry.text === 'а' ? [137, 144] : entry.text === 'то есть' ? [154] : [138, 144];
    const why = entry.text === 'однако'
      ? 'Если «однако» здесь значит «но», перед ним нужна запятая; если это вводное «впрочем» — выделите с двух сторон.'
      : entry.text === 'то есть'
        ? 'Пояснительный союз «то есть» отделяется запятой.'
        : `Перед противительным союзом «${entry.text}» ставится запятая.`;
    return commaIssue(ctx, prevTok, tok, 'punct.comma-adversative', entry.confidence || 'check', why, ref, undefined, { conj: entry.text });
  }
  return null;
}

function introIssue(ctx, sentence, wi, intro) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  for (const entry of intro) {
    if (!matchEntry(ctx, sentence, wi, entry)) continue;
    const atStart = wi === 0;
    if (entry.startOnly && !atStart) return null;
    const lastTok = ctx.tokens[words[wi + entry.words.length - 1]];
    const prevTok = ctx.prevTokenBefore(tok.start);
    const prevWord = prevTok && prevTok.type === 'word' && prevTok.si === tok.si ? prevTok : null;
    const nextTok = ctx.nextTokenFrom(lastTok.end);
    const nextWord = nextTok && nextTok.type === 'word' && nextTok.si === tok.si ? nextTok : null;
    if (entry.skipIfPrev && prevWord && entry.skipIfPrev.includes(prevWord.lower)) return null;
    if (entry.skipIfNext && nextWord && entry.skipIfNext.includes(nextWord.lower)) return null;
    if (nextWord && (nextWord.lower === 'ли' || nextWord.lower === 'бы')) return null;
    if (entry.skipIfNextGen && nextWord && morph.dictParses(nextWord.text).some((p) => p.tag.CAse === 'gent' && ['NOUN', 'ADJF', 'NPRO'].includes(p.tag.POS))) return null;
    if (entry.skipIfNextCase && nextWord && morph.dictParses(nextWord.text).some((p) => entry.skipIfNextCase.includes(p.tag.CAse) && ['NOUN', 'ADJF', 'NPRO'].includes(p.tag.POS))) return null;
    let needBefore = !atStart && prevTok && prevTok.type !== 'punct' && prevTok.si === tok.si;
    if (needBefore && prevWord && COORD_BEFORE_INTRO.has(prevWord.lower)) needBefore = false;
    const needAfter = nextTok && nextTok.type !== 'punct' && nextTok.si === tok.si;
    if (!needBefore && !needAfter) return null;
    const startTok = needBefore ? prevWord : tok;
    const endTok = needAfter ? nextWord : lastTok;
    if (!startTok || !endTok) return null;
    const introText = ctx.text.slice(tok.start, lastTok.end);
    let after = '';
    if (needBefore) after += prevWord.text + ',' + ctx.text.slice(prevWord.end, tok.start);
    after += introText;
    if (needAfter) after += ',' + ctx.text.slice(lastTok.end, nextWord.start) + nextWord.text;
    const confidence = atStart ? (entry.confidenceStart || entry.confidence) : entry.confidence;
    const why = atStart
      ? `Вводное слово «${entry.text}» в начале предложения отделяется запятой.`
      : needAfter && needBefore
        ? `Вводное слово «${entry.text}» выделяется запятыми с обеих сторон.`
        : `Вводное слово «${entry.text}» отделяется запятой.`;
    return makeIssue({
      para: ctx.para,
      start: startTok.start,
      end: endTok.end,
      category: 'punctuation',
      ruleId: 'punct.intro',
      before: ctx.text.slice(startTok.start, endTok.end),
      after,
      confidence: confidence || 'check',
      why,
      ref: [155],
      meta: { kind: 'intro', intro: entry.text },
    });
  }
  return null;
}

/** «Однако, …» at sentence start: the comma is usually wrong (однако = но). */
function odnakoStart(ctx, sentence) {
  if (!sentence.words.length) return null;
  const tok = ctx.tokens[sentence.words[0]];
  if (tok.lower !== 'однако') return null;
  const next = ctx.nextTokenFrom(tok.end);
  if (!next || next.type !== 'punct' || next.text !== ',' || next.start !== tok.end) return null;
  return makeIssue({
    para: ctx.para,
    start: tok.start,
    end: next.end,
    category: 'punctuation',
    ruleId: 'punct.odnako-start',
    before: ctx.text.slice(tok.start, next.end),
    after: tok.text,
    confidence: 'check',
    why: 'В начале предложения «однако» — союз «но», запятая после него не ставится. Оставьте запятую, только если это вводное слово в значении «впрочем».',
    ref: [127, 138],
  });
}

/** «Несмотря на X …, подлежащее» at sentence start without the closing comma. */
function nesmotryaStart(ctx, sentence) {
  const w = sentence.words;
  if (w.length < 4) return null;
  const t0 = ctx.tokens[w[0]];
  let objStart;
  if (t0.lower === 'несмотря' && ctx.tokens[w[1]].lower === 'на') objStart = 2;
  else if (t0.lower === 'не' && ctx.tokens[w[1]].lower === 'смотря' && ctx.tokens[w[2]].lower === 'на') objStart = 3;
  else return null;
  if (objStart >= w.length - 1) return null;
  const limit = Math.min(w.length - 1, objStart + 6);
  for (let k = objStart + 1; k <= limit; k++) {
    const tok = ctx.tokens[w[k]];
    const prevTok = ctx.prevTokenBefore(tok.start);
    if (!prevTok || prevTok.type === 'punct') return null; // comma already there or другая граница
    const parses = morph.dictParses(tok.text);
    let boundary = NESMOTRYA_PRONOUNS.has(tok.lower);
    if (!boundary && parses.some((p) => p.tag.POS === 'VERB')) boundary = true;
    if (!boundary && parses.length && parses.every((p) => p.tag.POS === 'NOUN') && parses.some((p) => p.tag.CAse === 'nomn') && !parses.some((p) => p.tag.CAse === 'accs' || p.tag.CAse === 'gent')) boundary = true;
    if (!boundary) continue;
    if (k === objStart) return null;
    return commaIssue(ctx, prevTok, tok, 'punct.nesmotrya', 'check',
      'Оборот с «несмотря на» в начале предложения отделяется запятой от главной части.', [153], undefined, { kind: 'comma-before' });
  }
  return null;
}

/** Mechanical defects over raw text. */
function mechanical(ctx, out) {
  const text = ctx.text;
  let m;
  const dbl = /([,;:])\1+/g;
  while ((m = dbl.exec(text)) !== null) {
    out.push(makeIssue({ para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'punctuation', ruleId: 'punct.double',
      before: m[0], after: m[1], confidence: 'sure', why: 'Удвоенный знак препинания.', ref: [] }));
  }
  const twoDots = /(?<!\.)\.\.(?!\.)/g;
  while ((m = twoDots.exec(text)) !== null) {
    out.push(makeIssue({ para: ctx.para, start: m.index, end: m.index + 2, category: 'punctuation', ruleId: 'punct.double',
      before: '..', after: '.', confidence: 'check', why: 'Две точки подряд: либо одна точка, либо многоточие «…».', alternatives: [{ text: '…', note: 'многоточие' }], ref: [185] }));
  }
  const spaceBefore = /([\p{L}\p{N}»")\]])([  ]+)([,;:!?…]|\.(?![.\d]))/gu;
  while ((m = spaceBefore.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const end = start + m[2].length + m[3].length;
    if (ctx.inSkip(start, end) && m[3] !== ',' ) continue;
    out.push(makeIssue({ para: ctx.para, start, end, category: 'punctuation', ruleId: 'punct.space-before',
      before: text.slice(start, end), after: m[3], confidence: 'sure', why: 'Перед знаком препинания пробел не ставится.', ref: [] }));
  }
  const noSpaceAfter = /([а-яё]{2,})([,;:!?])([а-яё])/giu;
  while ((m = noSpaceAfter.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const end = start + 1;
    out.push(makeIssue({ para: ctx.para, start, end, category: 'punctuation', ruleId: 'punct.space-after',
      before: m[2], after: m[2] + ' ', confidence: 'sure', why: 'После знака препинания нужен пробел.', ref: [] }));
    noSpaceAfter.lastIndex = m.index + m[0].length - 1;
  }
  const noSpaceAfterDot = /([а-яё]{2,})\.([а-яё])/giu;
  while ((m = noSpaceAfterDot.exec(text)) !== null) {
    if (ABBREVIATIONS.has(m[1].toLowerCase())) continue;
    const start = m.index + m[1].length;
    out.push(makeIssue({ para: ctx.para, start, end: start + 1, category: 'punctuation', ruleId: 'punct.space-after',
      before: '.', after: '. ', confidence: 'check', why: 'После точки нужен пробел (если это не сокращение).', ref: [] }));
    noSpaceAfterDot.lastIndex = m.index + m[0].length - 1;
  }
}

/**
 * Run punctuation checks for one paragraph.
 * @param {object} ctx
 * @returns {object[]}
 */
function check(ctx) {
  const out = [];
  const { conjCompiled: conj, introCompiled: intro } = ctx.rules;
  for (const sentence of ctx.sentences) {
    const odn = odnakoStart(ctx, sentence);
    if (odn) out.push(odn);
    const nes = nesmotryaStart(ctx, sentence);
    if (nes) out.push(nes);
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const tok = ctx.tokens[sentence.words[wi]];
      if (ctx.inSkip(tok.start, tok.end)) continue;
      let issue = introIssue(ctx, sentence, wi, intro);
      if (issue) { out.push(issue); continue; }
      if (wi === 0) continue;
      issue = subordinatingIssue(ctx, sentence, wi, conj);
      if (!issue) issue = adversativeIssue(ctx, sentence, wi, conj);
      if (issue) out.push(issue);
    }
  }
  mechanical(ctx, out);
  for (const issue of out) if (!issue.source && !issue.ref.length) issue.source = SRC_ROSENTAL;
  return out;
}

module.exports = { check, compileIntro, compileConj, matchCase };
