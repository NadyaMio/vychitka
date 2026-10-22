'use strict';

/**
 * Punctuation: commas before subordinate/adversative conjunctions, introductory
 * words, «несмотря на» at sentence start, sentence-initial «Однако,», and
 * mechanical defects (double marks, space before a mark, missing space after).
 */

const morph = require('./morph');
const { makeIssue, matchCase } = require('./util');
const { ABBREVIATIONS } = require('./tokenize');
const punctExtra = require('./punctextra');
const idioms = require('./idioms');
const ltRules = require('./ltrules');

const SRC_ROSENTAL = 'Розенталь · сложноподчинённое предложение';
const KOTORYJ_FORMS = new Set(['который', 'которая', 'которое', 'которые', 'которого', 'которой', 'которому', 'которую', 'которым', 'которыми', 'которых', 'котором']);
const KAKOJ_FORMS = new Set(['какой', 'какая', 'какое', 'какие', 'какого', 'какую', 'каким', 'каких', 'какому', 'каком', 'какими']);
const CHEJ_FORMS = new Set(['чей', 'чья', 'чьё', 'чье', 'чьи', 'чьего', 'чьей', 'чьему', 'чьим', 'чьих', 'чью', 'чьими', 'чьём', 'чьем']);
const RELATIVE_WORDS = new Set(['что', 'кто', 'чем', 'чего', 'чему', 'ком', 'кого', 'кому', 'кем', 'где', 'куда', 'откуда']);
const NESMOTRYA_PRONOUNS = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'все', 'всё', 'это', 'никто', 'ничто', 'каждый', 'многие', 'некоторые', 'кто-то', 'что-то', 'нам', 'мне', 'ему', 'ей', 'им', 'вам', 'тебе']);
const VERB_HEAD_POS = new Set(['VERB', 'INFN', 'GRND', 'PRTS', 'PRED']);
const GEN_KOTORYJ = { 'которого': { nmbr: 'sing', gndr: ['masc', 'neut'] }, 'которой': { nmbr: 'sing', gndr: ['femn'] }, 'которых': { nmbr: 'plur', gndr: null } };
const QUANTIFIERS = new Set(['многие', 'многих', 'один', 'одна', 'одно', 'одной', 'одного', 'одним', 'одну', 'одни', 'одних', 'несколько', 'некоторые', 'некоторых', 'каждый', 'каждая', 'каждое', 'каждого', 'каждую', 'каждой', 'каждому', 'часть', 'части', 'большинство', 'большинства', 'большая', 'половина', 'половину', 'треть', 'четверть', 'никто', 'ничто', 'никого', 'ничего', 'любой', 'любая', 'любое', 'любого', 'любому', 'любую', 'первый', 'первая', 'первое', 'первого', 'первую', 'последний', 'последняя', 'последнее', 'последнего', 'лучший', 'лучшая', 'лучшее', 'худший', 'оба', 'обе', 'обоих', 'обеих', 'все', 'всё', 'всех', 'кто-то', 'что-то', 'кое-кто', 'кое-что', 'остальные', 'остальных', 'прочие', 'иные', 'другие', 'другой', 'другая', 'другое', 'сотни', 'тысячи', 'десятки', 'миллионы', 'множество', 'большинству', 'меньшинство', 'мало', 'много', 'немногие', 'немало', 'единицы', 'ни', 'никакой', 'никакая', 'никакое', 'какой-то', 'какая-то', 'какое-то', 'какие-то']);
const CONJ_START_WORDS = new Set(['но', 'и']);
const PARENTHETICAL_VERBS = new Set(['полагаю', 'думаю', 'считаю', 'надеюсь', 'признаюсь', 'признаться', 'уверен', 'уверена', 'знаю', 'вижу', 'говорю', 'скажу', 'помню', 'повторяю', 'подчеркну', 'замечу', 'заметить', 'сказать', 'отметить', 'добавить', 'напомню', 'напомнить', 'боюсь', 'чувствую', 'слышал', 'слышала', 'понимаю', 'предполагаю', 'подозреваю', 'верю', 'клянусь', 'ручаюсь', 'надеемся', 'думаем', 'полагаем', 'считаем', 'знаем', 'видим', 'помним', 'понимаем']);
const CONJ_START_KEEP = new Set(['да', 'нет', 'увы', 'ах', 'ох', 'эх', 'ой', 'ну', 'впрочем', 'главное', 'правда', 'кстати', 'конечно', 'пожалуйста', 'спасибо', 'извините', 'простите', 'прошу', 'господа', 'друзья', 'ребята', 'коллеги', 'дорогие', 'уважаемые', 'товарищи', 'братья', 'мама', 'папа', 'сынок', 'дочка', 'милый', 'милая', 'дорогой', 'дорогая', 'во-первых', 'во-вторых', 'в-третьих', 'наконец', 'напротив', 'наоборот', 'соответственно', 'следовательно', 'значит', 'стало', 'вообще', 'в', 'с', 'к', 'по', 'на', 'что', 'если', 'когда', 'хотя', 'как', 'чтобы', 'пока', 'раз', 'потом', 'тем', 'всё', 'все', 'ещё', 'еще']);
const KTO_HEADS = new Set(['тот', 'та', 'те', 'тем', 'того', 'тех', 'всем', 'всех', 'всякого', 'всякий', 'всякому', 'каждого', 'каждый', 'каждому', 'любого', 'любой', 'любому', 'никого', 'никто', 'никому', 'первый', 'последний', 'единственный', 'единственным', 'единственного', 'таких', 'такие', 'такой']);
const CHTO_HEADS = new Set(['всё', 'все', 'всего', 'всему', 'всем', 'то', 'того', 'тому', 'том', 'тем']);
const COMPOUND_CONJ_PREPS = new Set(['несмотря', 'невзирая', 'на', 'из-за', 'ввиду', 'вследствие', 'благодаря', 'вопреки', 'в', 'силу', 'связи', 'с', 'независимо', 'от']);
const IDIOM_KNOWS = new Set(['бог', 'чёрт', 'черт', 'кто', 'бес', 'пёс', 'пес', 'шут', 'леший', 'аллах', 'господь']);
const COORD_BEFORE_INTRO = new Set(['а', 'и', 'но', 'да']);
const PARTICLE_BEFORE_INTRO = new Set(['ну', 'уж', 'вот', 'ведь']);
const PERSONAL_NOM = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они']);
const PHRASE_OPENING_INTRO = new Set(['например', 'в частности', 'к примеру', 'главным образом', 'скажем', 'допустим', 'положим']);

/** Noun whose only readings are nominative (a safe subject): «масса», «банкир». */
function isNomOnlyNoun(tok) {
  const nouns = morph.dictParses(tok.text).filter((p) => p.tag.POS === 'NOUN');
  if (!nouns.length) return false;
  return nouns.every((p) => p.tag.CAse === 'nomn');
}

/** Noun, adjective, numeral, capitalised name or number — a word that can head a nominal phrase («например романы», «в частности России»). */
function isNominalHead(tok) {
  if (tok.type === 'num') return true;
  if (tok.type !== 'word') return false;
  if (tok.cap) return true;
  const ps = morph.dictParses(tok.text);
  return ps.length > 0 && ps.some((p) => ['NOUN', 'ADJF', 'PRTF', 'NUMR'].includes(p.tag.POS)) && !ps.some((p) => ['NPRO', 'VERB', 'INFN', 'ADVB', 'PRED', 'CONJ', 'PRCL', 'PREP'].includes(p.tag.POS));
}

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

/** Does the sentence end with a question mark (possibly followed by «!» or a closing quote)? */
function isQuestion(ctx, sentence) {
  const toks = sentence.tokens;
  for (let k = toks.length - 1; k >= 0 && k >= toks.length - 3; k--) {
    const t = ctx.tokens[toks[k]];
    if (t.type !== 'punct') return false;
    if (t.text === '?') return true;
  }
  return false;
}

/** Word with a verb-like reading (finite verb, infinitive, gerund, short participle, predicative). */
function isVerbHead(tok) {
  return !!tok && tok.type === 'word' && morph.dictParses(tok.text).some((p) => VERB_HEAD_POS.has(p.tag.POS));
}

/** Is there a verb-like word among the words before sentence word index wi, inside the same clause (no punctuation on the way)? */
function clauseHasVerb(ctx, sentence, wi) {
  const words = sentence.words;
  for (let k = wi - 1; k >= 0; k--) {
    const tok = ctx.tokens[words[k]];
    if (!adjacent(ctx, sentence, k, 2)) return isVerbHead(tok);
    if (isVerbHead(tok)) return true;
  }
  return false;
}

function hasNounReading(tok) {
  if (!tok || tok.type !== 'word') return false;
  const dict = morph.dictParses(tok.text);
  if (dict.length) return dict.some((p) => p.tag.POS === 'NOUN');
  return morph.parse(tok.text).some((p) => p.tag.POS === 'NOUN'); // unknown word («сексуализация»): the suffix predictor
}

/** Does any noun reading agree with the genitive form of «который» in number and gender? */
function nounAgreesWithGen(tok, gen) {
  return morph.dictParses(tok.text).some((p) => p.tag.POS === 'NOUN' && p.tag.NMbr === gen.nmbr && (!gen.gndr || gen.gndr.includes(p.tag.GNdr)));
}

function isPrepLike(tok, conj) {
  return !!tok && tok.type === 'word' && (conj.prepositions.has(tok.lower) || tok.lower === 'несмотря' || tok.lower === 'невзирая' || morph.dictParses(tok.text).some((p) => p.tag.POS === 'PREP'));
}

function isQuantifier(tok) {
  return !!tok && (tok.type === 'num' || (tok.type === 'word' && (QUANTIFIERS.has(tok.lower) || morph.dictParses(tok.text).some((p) => p.tag.POS === 'NUMR'))));
}

function subordinatingIssue(ctx, sentence, wi, conj) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (tok.cap) return null; // «спрашиваю Что это», «Закон Латта Если …» — a new sentence or direct speech without quotes
  for (const entry of conj.subordinating) {
    if (!matchEntry(ctx, sentence, wi, entry)) continue;
    const lastTok = ctx.tokens[words[wi + entry.words.length - 1]];
    const next = ctx.nextTokenFrom(lastTok.end);
    const nextWord = next && next.type === 'word' ? next : null;
    if (entry.skipIfNext && nextWord && entry.skipIfNext.includes(nextWord.lower)) return null;
    if (entry.skipIfLast && (!next || next.type === 'punct')) return null;
    if (entry.skipIfNextComp && nextWord && morph.dictParses(nextWord.text).some((p) => p.tag.POS === 'COMP')) return null; // «куда лучше»
    if (entry.nextVerb) {
      let w = nextWord;
      if (w && w.lower === 'не') w = ctx.nextWordFrom(w.end);
      if (!w || !morph.dictParses(w.text).some((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN')) return null;
    }
    if (entry.needsClauseVerb && !clauseHasVerb(ctx, sentence, wi)) return null; // «заявлять их пока не буду» — an adverb, no main clause yet

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
    const question = !!entry.question && isQuestion(ctx, sentence);
    let shifted = false;
    let prepText = '';
    const relative = entry.formSet || RELATIVE_WORDS.has(entry.text);
    if (entry.shiftPrep && relative && conj.prepositions.has(prevTok.lower)) {
      const beforePrep = ctx.prevTokenBefore(prevTok.start);
      if (!beforePrep || beforePrep.type !== 'word' || beforePrep.si !== tok.si) return null;
      if (!entry.formSet && !['что', 'чем', 'кто'].includes(entry.text)) return null;
      const anchor = prevTok;
      if (entry.formSet) {
        // «специалисты, многие из которых…», «башенки, на одной из которых…», «девять мячей, три из которых…»: the clause starts at the quantifier
        if (isQuantifier(beforePrep)) {
          const beforeQ = ctx.prevTokenBefore(beforePrep.start);
          if (!beforeQ || beforeQ.type !== 'word' || beforeQ.si !== tok.si || conj.stops.has(beforeQ.lower)) return null; // comma or sentence start already delimits the clause
          const phrase = ctx.text.slice(beforePrep.start, tok.end);
          return commaIssue(ctx, beforeQ, beforePrep, 'punct.comma-before-conj', 'check', `Придаточное начинается с «${phrase}» — запятая ставится перед «${beforePrep.text}».`, refFor(entry), undefined, { conj: entry.text });
        }
        // «…, сведения о которых…», «…, в обмен на которые…»: a comma before the noun (or its preposition) already opens the clause
        if (hasNounReading(beforePrep)) {
          const beforeNoun = ctx.prevTokenBefore(beforePrep.start);
          if (beforeNoun && beforeNoun.si === tok.si && beforeNoun.type === 'punct') return null;
          if (beforeNoun && beforeNoun.si === tok.si && isPrepLike(beforeNoun, conj)) {
            const b2 = ctx.prevTokenBefore(beforeNoun.start);
            if (b2 && b2.si === tok.si && b2.type === 'punct') return null;
          }
        }
      }
      shifted = true;
      prepText = prevTok.text;
      prevTok = beforePrep;
      if (conj.stops.has(prevTok.lower)) return null;
      if (entry.skipIfPrev && entry.skipIfPrev.includes(prevTok.lower)) return null;
      if (question && !isVerbHead(prevTok)) return null; // «Ты с какого района?», «с тебя про что взяли?»
      const confidence = isHead(ctx, prevTok, conj.headPos) ? entry.confidence : 'check';
      return commaIssue(ctx, prevTok, anchor, 'punct.comma-before-conj', confidence, whyFor(entry, true, prepText), refFor(entry), undefined, { conj: entry.text });
    }
    // «те, кто», «всем, кто», «всё, что», «то, что» — a demonstrative or «всё» heads the clause (§ 140); such heads are otherwise stop-words
    const demonstrativeHead = (entry.text === 'кто' && KTO_HEADS.has(prevTok.lower)) || (entry.text === 'что' && CHTO_HEADS.has(prevTok.lower));
    if (conj.stops.has(prevTok.lower) && !demonstrativeHead) return null;
    if (prevTok.lower === 'то' || prevTok.lower === 'того') {
      const beforeTo = ctx.prevTokenBefore(prevTok.start);
      if (beforeTo && beforeTo.type === 'word' && ['не', 'и', 'а', 'да'].includes(beforeTo.lower)) return null;
      if (prevTok.lower === 'то' && entry.text !== 'что' && !entry.formSet) return null; // «если …, то какое мне дело» — «то» of «если … то»
      // «Несмотря на то что…», «Из-за того что…», «Ввиду того что…» at the start of a sentence (or after a comma / «и»): the compound
      // causal conjunction is not split there (§ 142). «За то, что…», «от того, что…» are not compound conjunctions and keep the comma.
      if (entry.text === 'что' && beforeTo && beforeTo.type === 'word' && beforeTo.si === tok.si && COMPOUND_CONJ_PREPS.has(beforeTo.lower)) {
        let b2 = ctx.prevTokenBefore(beforeTo.start);
        if (b2 && b2.type === 'word' && b2.si === tok.si && COMPOUND_CONJ_PREPS.has(b2.lower)) b2 = ctx.prevTokenBefore(b2.start); // «несмотря на»
        if (!b2 || b2.si !== tok.si || b2.type === 'punct' || ['и', 'а', 'но'].includes(b2.lower)) return null;
      }
    }
    if (entry.skipIfPrev && entry.skipIfPrev.includes(prevTok.lower)) return null;
    if (conj.prepositions.has(prevTok.lower) && !entry.formSet) return null; // «о чём», «за что» – pronoun after preposition
    if (question && !isVerbHead(prevTok) && !demonstrativeHead) return null; // «Это кто?», «Ты чем занимаешься?», «Тогда зачем?» — a question word, not a clause
    if (prevTok.lower === 'знает' || prevTok.lower === 'весть') {
      const b = ctx.prevTokenBefore(prevTok.start);
      if (b && b.type === 'word' && IDIOM_KNOWS.has(b.lower)) return null; // «бог знает сколько», «чёрт знает что»
    }
    if (entry.formSet) {
      // «…, реализовать которые невозможно»: the clause starts at the infinitive right after the comma
      if (morph.dictParses(prevTok.text).some((p) => p.tag.POS === 'INFN')) {
        const b = ctx.prevTokenBefore(prevTok.start);
        if (b && b.type === 'punct') return null;
      }
      // genitive «которого / которой / которых» after a noun: «размер которой», «в результате которого» — the noun belongs to the
      // relative clause («…, размер которой упал»), so the comma goes before the noun (and its preposition), not before «которой»
      const gen = GEN_KOTORYJ[tok.lower];
      if (gen && hasNounReading(prevTok)) {
        let start = prevTok;
        const b = ctx.prevTokenBefore(prevTok.start);
        if (b && b.type === 'word' && b.si === tok.si && conj.prepositions.has(b.lower)) start = b;
        const beforeStart = ctx.prevTokenBefore(start.start);
        if (!beforeStart || beforeStart.si !== tok.si || beforeStart.type !== 'word') return null; // a comma (or the sentence start) already delimits the clause
        // no verb between the previous mark and «которого» («…, главный тренер которого …», «…, желаемой тенденцией развития которого …»):
        // the whole segment is the beginning of the relative clause, the mark before it already does the job
        if (!clauseHasVerb(ctx, sentence, wi)) return null;
        const phrase = ctx.text.slice(start.start, tok.end);
        const shiftWhy = `Придаточное начинается с «${phrase}» — запятая ставится перед «${start.text}», а не перед «${tok.text}».`;
        if (!nounAgreesWithGen(prevTok, gen)) {
          // the noun cannot be the antecedent («президентом которой», «частях которого») — the possessive reading is certain
          if (conj.stops.has(beforeStart.lower)) return null;
          const confidence = isHead(ctx, beforeStart, conj.headPos) ? entry.confidence : 'check';
          return commaIssue(ctx, beforeStart, start, 'punct.comma-before-conj', confidence, shiftWhy, refFor(entry), undefined, { conj: entry.text });
        }
        // the noun agrees with «который»: antecedent («человека, которого») or possessive («вождей, имён которых»). Two nouns in a row
        // («вождей имён которых», «топик автором которого») point to the possessive reading — the first is the antecedent
        if (hasNounReading(beforeStart) && !isVerbHead(beforeStart) && !isQuantifier(beforeStart) && !conj.stops.has(beforeStart.lower)) {
          return commaIssue(ctx, beforeStart, start, 'punct.comma-before-conj', 'check', shiftWhy, refFor(entry), undefined, { conj: entry.text });
        }
        return commaIssue(ctx, prevTok, tok, 'punct.comma-before-conj', 'check', `Перед «${tok.text}» начинается придаточное — нужна запятая. Если «${prevTok.text}» входит в придаточное («…, ${prevTok.text} ${tok.text}…»), запятая ставится перед ним.`, refFor(entry), undefined, { conj: entry.text });
      }
    }
    let confidence = entry.confidence || 'check';
    if (entry.needsHead && !isHead(ctx, prevTok, conj.headPos)) confidence = 'check';
    if (demonstrativeHead) confidence = 'sure';
    else if (entry.sureAfterVerb && isVerbHead(prevTok)) confidence = 'sure'; // «знаю, кто», «скажи, когда», «понял, почему», «ты знаешь, кто пришёл?»
    return commaIssue(ctx, prevTok, tok, 'punct.comma-before-conj', confidence, whyFor(entry, false), refFor(entry), undefined, { conj: entry.text });
  }
  return null;
}

function adversativeIssue(ctx, sentence, wi, conj) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (tok.cap) return null; // «ушёл А я остался» — a new sentence without a period, not a clause boundary we can mark
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
    const ref = entry.ref || (entry.text === 'а' ? [137, 144] : entry.text === 'то есть' ? [154] : [138, 144]);
    const why = entry.why || (entry.text === 'однако'
      ? 'Если «однако» здесь значит «но», перед ним нужна запятая; если это вводное «впрочем» — выделите с двух сторон.'
      : entry.text === 'то есть'
        ? 'Пояснительный союз «то есть» отделяется запятой.'
        : `Перед противительным союзом «${entry.text}» ставится запятая.`);
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
    if (!atStart && tok.cap) return null; // «Слово Например излечивает…» — a quoted/mentioned word, not an intro word
    const lastTok = ctx.tokens[words[wi + entry.words.length - 1]];
    const prevTok = ctx.prevTokenBefore(tok.start);
    const prevWord = prevTok && prevTok.type === 'word' && prevTok.si === tok.si ? prevTok : null;
    const nextTok = ctx.nextTokenFrom(lastTok.end);
    const nextWord = nextTok && nextTok.type === 'word' && nextTok.si === tok.si ? nextTok : null;
    if (entry.strict && !(ctx.settings && ctx.settings.strict)) return null; // noisy entries live in the strict mode only
    if (entry.skipIfPrev && prevWord && entry.skipIfPrev.includes(prevWord.lower)) return null;
    if (entry.skipIfNext && nextWord && entry.skipIfNext.includes(nextWord.lower)) return null;
    if (nextWord && (nextWord.lower === 'ли' || nextWord.lower === 'бы')) return null;
    // «Жить значит бороться» — «значит» links subject and predicate (dash, see punctextra), not an intro word
    if (entry.text === 'значит' && ((prevWord && punctExtra.isInfinitive(prevWord)) || (nextWord && punctExtra.isInfinitive(nextWord)))) return null;
    if (entry.skipIfNextGen && nextWord && morph.dictParses(nextWord.text).some((p) => p.tag.CAse === 'gent' && ['NOUN', 'ADJF', 'NPRO'].includes(p.tag.POS))) return null;
    if (entry.skipIfNextCase && nextWord && morph.dictParses(nextWord.text).some((p) => entry.skipIfNextCase.includes(p.tag.CAse) && ['NOUN', 'ADJF', 'NPRO'].includes(p.tag.POS))) return null;
    if (entry.skipIfNextPos && nextWord && morph.dictParses(nextWord.text).some((p) => entry.skipIfNextPos.includes(p.tag.POS))) return null;
    if (entry.skipIfPrevPos && prevWord && morph.dictParses(prevWord.text).some((p) => entry.skipIfPrevPos.includes(p.tag.POS))) return null;
    // a subject right before the word: «масса кажется устойчивой», «банкир может быть отстранён» — a predicate, not an intro word
    if (entry.skipIfPrevNom && prevWord && (PERSONAL_NOM.has(prevWord.lower) || isNomOnlyNoun(prevWord))) return null;
    // mid-sentence «возможно использование», «может быть кирпич» — a predicate with its subject after it
    if (entry.skipIfNextNom && !atStart && prevWord && nextWord && !nextWord.cap && morph.dictParses(nextWord.text).some((p) => p.tag.CAse === 'nomn' && ['NOUN', 'ADJF', 'PRTF'].includes(p.tag.POS)) && !morph.dictParses(nextWord.text).some((p) => p.tag.POS === 'NPRO')) return null;
    let needBefore = !atStart && prevTok && prevTok.type !== 'punct' && prevTok.si === tok.si;
    if (needBefore && prevWord && (COORD_BEFORE_INTRO.has(prevWord.lower) || PARTICLE_BEFORE_INTRO.has(prevWord.lower))) needBefore = false; // «и, конечно» / «ну конечно» — no comma after the conjunction or particle
    let needAfter = nextTok && nextTok.type !== 'punct' && nextTok.si === tok.si;
    // «например», «в частности» opening an isolated clarifying phrase («книги, например романы») are not separated from it (§ 155, Розенталь § 25 п. 4)
    if (needAfter && !atStart && PHRASE_OPENING_INTRO.has(entry.text) && nextWord && isNominalHead(nextWord) && (!prevWord || prevWord.type === 'word' && morph.dictParses(prevWord.text).some((p) => p.tag.POS === 'NOUN'))) needAfter = false;
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

/**
 * «Но, я могу…», «И, представляете…» — a comma right after a sentence-initial conjunction is only correct before an
 * intro word, gerund phrase, address or interjection; otherwise it is stray (§ 155: the intro word is separated,
 * not the conjunction). Only «но» and «и»: «Да, …» is the answer word, «А, …» an interjection.
 */
function conjStart(ctx, sentence, intro) {
  if (sentence.words.length < 3) return null;
  const tok = ctx.tokens[sentence.words[0]];
  if (!CONJ_START_WORDS.has(tok.lower) || sentence.tokens[0] !== sentence.words[0]) return null;
  const comma = ctx.nextTokenFrom(tok.end);
  if (!comma || comma.type !== 'punct' || comma.text !== ',' || comma.start !== tok.end) return null;
  const next = ctx.nextTokenFrom(comma.end);
  if (!next || next.type !== 'word' || next.si !== tok.si || next.i !== sentence.words[1]) return null;
  if (next.cap || CONJ_START_KEEP.has(next.lower)) return null; // name (address), «да/нет», interjection
  if (intro.some((entry) => matchEntry(ctx, sentence, 1, entry))) return null; // «Но, конечно, …», «И, по-моему, …»
  const parses = morph.dictParses(next.text);
  if (!parses.length || parses.some((p) => p.tag.POS === 'GRND' || p.tag.POS === 'INTJ' || p.tag.Prnt)) return null; // «И, подумав, …»
  const after = ctx.nextTokenFrom(next.end);
  if (after && after.type === 'punct' && after.si === tok.si) return null; // «Но, увы, …» — a one-word parenthesis we do not know
  // «И, я полагаю, …», «И, надо признаться, …» — a parenthetical clause (§ 155) rather than a stray comma
  if (after && after.type === 'word' && (PERSONAL_NOM.has(next.lower) || next.lower === 'надо' || next.lower === 'нужно' || next.lower === 'стоит') && PARENTHETICAL_VERBS.has(after.lower)) return null;
  return makeIssue({
    para: ctx.para,
    start: tok.start,
    end: next.end,
    category: 'punctuation',
    ruleId: 'punct.conj-start',
    before: ctx.text.slice(tok.start, next.end),
    after: tok.text + ctx.text.slice(comma.end, next.end),
    confidence: 'check',
    why: `После союза «${tok.text}» в начале предложения запятая не ставится: она нужна только перед вводным словом, обращением или деепричастным оборотом («${tok.text}, конечно, …»).`,
    ref: [155],
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
    const cs = conjStart(ctx, sentence, intro);
    if (cs) out.push(cs);
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
  punctExtra.check(ctx, out);
  idioms.check(ctx, out); // «и то, и другое» — stray comma inside a cohesive pair (§ 146, note; Викисловарь)
  mechanical(ctx, out);
  ltRules.check(ctx, out); // LanguageTool rules (bases/rules/lt-punct.json) run last: matches overlapping our issues are dropped
  for (const issue of out) if (!issue.source && !issue.ref.length && !issue.manualRef) issue.source = SRC_ROSENTAL;
  return out;
}

module.exports = { check, compileIntro, compileConj, compileExtra: punctExtra.compileExtra, matchCase };
