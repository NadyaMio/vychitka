'use strict';

/**
 * Repeats: the same lemma within 3 sentences (repeat.near) and the same
 * two-word combination inside one sentence (repeat.bigram, literary only).
 */

const morph = require('./morph');
const { makeIssue } = require('./util');

const WINDOW = 3;
const MIN_LEMMA_LEN = 4;
const IDIOM_DISTANCE = 2; // same lemma within 2 words = idiom («в конце концов»), skipped
const STOP_POS = new Set(['PREP', 'CONJ', 'PRCL', 'NPRO', 'INTJ', 'NUMR', 'PRED', 'NUMB', 'LATN', 'PNCT', 'UNKN']);
const STOP_LEMMAS = new Set(['быть', 'мочь', 'стать', 'являться', 'иметь', 'весь', 'сам', 'самый', 'один', 'другой', 'свой', 'также', 'тоже', 'очень', 'ещё', 'уже', 'сейчас', 'потом', 'здесь', 'сюда', 'там', 'тогда', 'когда', 'если', 'чтобы', 'потому', 'поэтому', 'просто', 'только', 'даже', 'почти', 'более', 'менее', 'много', 'мало', 'всегда', 'иногда', 'именно', 'такой', 'этот', 'который', 'какой', 'каждый', 'любой', 'никакой', 'некоторый', 'всякий', 'этого', 'надо', 'нужно', 'можно', 'нельзя', 'очень', 'сегодня', 'вчера', 'завтра', 'снова', 'опять', 'тоже', 'либо', 'хотя', 'пока', 'либо', 'весьма', 'вроде', 'около']);
const SOURCE = 'Профиль: редакционная норма';
const BIGRAM_STOP = new Set(['и', 'в', 'на', 'с', 'не', 'что', 'это', 'как', 'по', 'но', 'а', 'из', 'за', 'от', 'до', 'к', 'о', 'у', 'же', 'бы', 'ли', 'для', 'при', 'про', 'так', 'то', 'все', 'всё', 'мы', 'вы', 'он', 'она', 'они', 'я', 'ты', 'его', 'её', 'их', 'ещё', 'уже', 'или', 'ни', 'да', 'нет', 'был', 'была', 'было', 'были', 'есть', 'тот', 'та', 'те', 'этот', 'эта', 'эти', 'нам', 'вам', 'им', 'ему', 'ей', 'мне', 'тебе', 'нас', 'вас', 'них', 'нем', 'нём', 'ней', 'кто', 'чем', 'чтобы', 'если', 'когда', 'где', 'куда', 'там', 'тут', 'здесь']);

function times(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} раз`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} раза`;
  return `${n} раз`;
}

/**
 * Content lemma of a token or null when the token should be ignored.
 * @param {object} tok
 * @param {boolean} properNoun true when token is capitalised mid-sentence
 */
function contentLemma(tok, properNoun) {
  if (tok.type !== 'word' || tok.allCaps || properNoun) return null;
  const parses = morph.parse(tok.text);
  if (!parses.length) return null;
  const best = parses[0];
  const tag = best.tag;
  if (STOP_POS.has(tag.POS) || tag.Apro || tag.Anph || tag.Prnt) return null;
  if (best.parser !== 'Dictionary' && !morph.isKnown(tok.text)) return null;
  let lemma = tok.lower;
  if (best.parser === 'Dictionary') {
    const n = best.normalize();
    if (n && n.word) lemma = String(n.word);
  } else {
    lemma = morph.lemma(tok.text);
  }
  if (lemma.length < MIN_LEMMA_LEN || STOP_LEMMAS.has(lemma)) return null;
  return lemma;
}

/**
 * Same lemma 2+ times within 3 sentences of one paragraph.
 * @param {object} ctx
 * @returns {object[]}
 */
function near(ctx) {
  const out = [];
  const occurrences = new Map(); // lemma -> [{si, tok, order}]
  let wordOrder = 0;
  for (const sentence of ctx.sentences) {
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const i = sentence.words[wi];
      const tok = ctx.tokens[i];
      const lemma = contentLemma(tok, tok.cap && wi > 0);
      if (!lemma) continue;
      if (!occurrences.has(lemma)) occurrences.set(lemma, []);
      occurrences.get(lemma).push({ si: tok.si, tok, order: wordOrder++ });
    }
  }
  for (const [lemma, list] of occurrences) {
    if (list.length < 2) continue;
    for (let k = 1; k < list.length; k++) {
      const cur = list[k];
      // «в конце концов», «друг друга», «день за днём» — intentional repeats (§ 149), not style defects
      const idiom = (o) => o.si === cur.si && cur.order - o.order <= IDIOM_DISTANCE;
      if (idiom(list[k - 1])) continue;
      const inWindow = list.filter((o) => o === cur || (o.si >= cur.si - (WINDOW - 1) && o.si <= cur.si && !idiom(o)));
      if (inWindow.length < 2 || inWindow[0].tok === cur.tok) continue;
      out.push(makeIssue({
        para: ctx.para,
        start: cur.tok.start,
        end: cur.tok.end,
        category: 'repeat',
        ruleId: 'repeat.near',
        before: cur.tok.text,
        after: cur.tok.text,
        confidence: 'check',
        why: `Слово «${lemma}» повторяется рядом (${times(inWindow.length)} в ${WINDOW} предложениях).`,
        source: SOURCE,
        ref: [],
        metric: 'repeat',
        meta: { lemma, count: inWindow.length },
      }));
    }
  }
  return out;
}

/**
 * The same two-word combination twice in one sentence.
 * @param {object} ctx
 * @returns {object[]}
 */
function bigrams(ctx) {
  const out = [];
  for (const sentence of ctx.sentences) {
    const seen = new Map();
    const words = sentence.words;
    for (let wi = 0; wi < words.length - 1; wi++) {
      const a = ctx.tokens[words[wi]];
      const b = ctx.tokens[words[wi + 1]];
      if (b.i !== a.i + 2 || ctx.tokens[a.i + 1].type !== 'space') continue;
      if (a.lower.length < 3 || b.lower.length < 2) continue;
      if (BIGRAM_STOP.has(a.lower) && BIGRAM_STOP.has(b.lower)) continue;
      const key = `${a.lower} ${b.lower}`;
      if (seen.has(key)) {
        out.push(makeIssue({
          para: ctx.para,
          start: a.start,
          end: b.end,
          category: 'repeat',
          ruleId: 'repeat.bigram',
          before: ctx.text.slice(a.start, b.end),
          after: ctx.text.slice(a.start, b.end),
          confidence: 'check',
          why: `Сочетание «${key}» повторяется в одном предложении — перестройте фразу.`,
          source: SOURCE,
          ref: [],
          metric: 'repeat',
        }));
      } else seen.set(key, wi);
    }
  }
  return out;
}

/** Entry point for check(): only near repeats. */
function check(ctx) {
  return near(ctx);
}

module.exports = { check, near, bigrams, contentLemma, times };
