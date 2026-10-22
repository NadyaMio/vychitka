'use strict';

/**
 * Punctuation checks derived from the punctuation manual (reference/punct-manual.json)
 * and the 1956 rules, on top of the conjunction/intro checks in punctuation.js:
 *
 *   dash between subject and predicate (nouns, infinitives, numerals, «это/вот/значит»)
 *   generalizing words before/after a list (colon / dash)
 *   repeated conjunctions (и…и, ни…ни, или…или, то…то) and double ones (как…так и, если…то)
 *   comparative «как» / «нежели»
 *   addresses at the start / end of a sentence
 *   interjections, «да» / «нет», «что ж» at the start of a sentence
 *   direct speech: colon before, comma + dash after the quoted speech
 *   gerunds (sentence-initial and mid-sentence), participial phrases after a noun
 *   «кроме / помимо / включая …» phrases
 *
 * Every issue carries `ref` (1956 paragraphs) and `manualRef` (ids from the manual).
 * Anything that depends on syntax we cannot see is reported with confidence 'check'.
 * Word lists live in bases/rules/punct-extra.json (compileExtra below).
 */

const morph = require('./morph');
const { makeIssue } = require('./util');
const idiomsMod = require('./idioms'); // set phrases (Викисловарь + § 146/§ 150 lists); `idioms` is a local name below

const NBSP = ' ';
const EM = '—';

const PERSONAL = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они']);
const SECOND_PERSON = new Set(['ты', 'вы', 'тебе', 'вам', 'тебя', 'вас', 'тобой', 'вами', 'твой', 'твоя', 'твоё', 'твое', 'твои', 'ваш', 'ваша', 'ваше', 'ваши', 'твоего', 'вашего', 'твоей', 'вашей', 'твоих', 'ваших']);
const POSSESSIVE = new Set(['мой', 'моя', 'моё', 'мое', 'мои', 'твой', 'твоя', 'твоё', 'твое', 'твои', 'наш', 'наша', 'наше', 'наши', 'ваш', 'ваша', 'ваше', 'ваши', 'свой', 'своя', 'своё', 'свое', 'свои', 'его', 'её', 'ее', 'их']);
const VERBLIKE = new Set(['VERB', 'PRTS', 'ADJS', 'PRED', 'GRND']);
const NOMINAL = new Set(['NOUN', 'ADJF', 'NUMR', 'PRTF']);
const RELATIVE = new Set(['что', 'кто', 'где', 'куда', 'откуда', 'когда', 'почему', 'зачем', 'чем', 'кем', 'кого', 'чего', 'какой', 'какая', 'какое', 'какие', 'сколько', 'как', 'чему', 'кому', 'ком', 'чём', 'чем']);
const SUBORDINATORS = new Set(['что', 'кто', 'который', 'которая', 'которое', 'которые', 'которого', 'которую', 'которым', 'которой', 'где', 'когда', 'как', 'почему', 'зачем', 'чей', 'если', 'чтобы', 'пока', 'хотя', 'куда', 'откуда', 'сколько']);
const DASH_BREAKERS = new Set(['не', 'лишь', 'только', 'тоже', 'также', 'уже', 'ещё', 'еще', 'просто', 'именно', 'вовсе', 'отнюдь', 'как', 'будто', 'словно', 'точно', 'что', 'вроде', 'якобы', 'по-прежнему', 'всегда', 'теперь', 'сегодня', 'здесь', 'там', 'тут', 'везде', 'всюду', 'давно', 'сейчас', 'ныне', 'опять', 'снова', 'вновь', 'пока', 'ведь', 'же', 'ли', 'бы', 'и', 'а', 'но', 'или', 'либо', 'да', 'ни', 'даже', 'почти', 'совсем', 'очень', 'весьма', 'слишком', 'довольно', 'скорее', 'вероятно', 'конечно', 'кажется', 'видимо', 'очевидно', 'наверное', 'безусловно', 'разумеется', 'впрочем', 'однако', 'значит', 'это', 'вот']);
const INF_NOUNS = new Set(['задача', 'цель', 'долг', 'главное', 'правило', 'принцип', 'девиз', 'лозунг', 'призвание', 'миссия', 'назначение', 'функция', 'роль', 'суть', 'смысл', 'идея', 'мечта', 'план', 'выход', 'решение', 'секрет', 'искусство', 'работа', 'дело', 'обязанность', 'условие', 'требование', 'совет', 'рецепт', 'способ', 'путь', 'шаг', 'первое', 'второе', 'третье', 'лучшее', 'худшее', 'единственное', 'задачи', 'цели', 'правила', 'принципы', 'обязанности', 'условия', 'требования']);
const MULTIPLY = new Set(['дважды', 'трижды', 'четырежды', 'пятью', 'шестью', 'семью', 'восемью', 'девятью']);
const COORD = new Set(['и', 'а', 'но', 'да', 'или', 'либо', 'ни', 'то', 'же', 'ли', 'не']);
const GENERALIZING_COLON = new Set(['всё', 'везде', 'всюду', 'повсюду', 'отовсюду', 'никто', 'ничто', 'нигде', 'никуда', 'ниоткуда']);
const GENERALIZING_DASH = new Set(['всё', 'ничто', 'никто', 'ничего', 'никого', 'везде', 'всюду', 'нигде', 'никуда', 'отовсюду', 'словом']);
const PARTICLE_INTERJ = new Set(['ах', 'ох', 'эх', 'ух', 'ой', 'ай', 'ну', 'о', 'эй', 'ого', 'ба', 'фу']);
const GENERIC_INTERJ_SKIP = new Set(['и', 'а', 'но', 'да', 'же', 'ли', 'бы', 'б', 'ж', 'вам', 'тебе', 'пожалуйста', 'же', 'ль']);
const TO_PREV_SKIP = new Set(['не', 'а', 'и', 'да', 'ни', 'именно', 'только', 'всё', 'все', 'вовсе', 'лишь', 'за', 'на', 'в', 'во', 'о', 'об', 'при', 'с', 'со', 'про', 'по', 'к', 'ко', 'у', 'от', 'до', 'из', 'под', 'над', 'перед', 'через', 'между', 'что', 'чем', 'как', 'если', 'ли', 'же', 'есть']);
const TO_NEXT_SKIP = new Set(['же', 'есть', 'ли', 'бишь', 'самое', 'и', 'что', 'ж', 'время', 'слово', 'место', 'дело', 'утро', 'лето', 'окно', 'письмо', 'здание', 'море', 'поле', 'имя', 'лицо', 'тело', 'число', 'право', 'чувство', 'мгновение', 'мнение', 'решение', 'значение']);

/* ---------- data ---------- */

function toWordSeqs(list) {
  return (list || []).map((s) => String(s).toLowerCase().split(/\s+/).filter(Boolean)).filter((a) => a.length).sort((a, b) => b.length - a.length);
}

/**
 * Compile bases/rules/punct-extra.json into Sets and word sequences.
 * @param {object} data
 * @returns {object}
 */
function compileExtra(data) {
  const d = data || {};
  const set = (arr) => new Set((arr || []).map((s) => String(s).toLowerCase()));
  const dash = d.dash || {};
  const cmp = d.comparison || {};
  const hom = d.homogeneous || {};
  const addr = d.address || {};
  const intj = d.interjection || {};
  const speech = d.speech || {};
  const ger = d.gerund || {};
  const iso = d.isolatedObject || {};
  const pairs = (list) => (list || []).map(([a, b]) => [String(a).toLowerCase().split(/\s+/), String(b).toLowerCase().split(/\s+/)]);
  return {
    dash: {
      titleNouns: set(dash.titleNouns),
      geoCommon: set(dash.geoCommon),
      compoundHeads: set(dash.compoundHeads),
      phaseVerbs: set(dash.phaseVerbs),
      generalizingAfterSkip: set(dash.generalizingAfterSkip),
    },
    comparison: {
      kakIdioms: toWordSeqs(cmp.kakIdioms),
      kakRoleVerbs: set(cmp.kakRoleVerbs),
      kakNextSkip: set(cmp.kakNextSkip),
      kakPrevSkip: set(cmp.kakPrevSkip),
    },
    homogeneous: { niIdioms: pairs(hom.niIdioms), iIdioms: pairs(hom.iIdioms) },
    address: {
      nouns: set(addr.nouns),
      nounSeqs: toWordSeqs(addr.nouns),
      adjectives: set(addr.adjectives),
      questionWords: set(addr.questionWords),
    },
    interjection: {
      words: set(intj.sentenceStartOnly || intj.words),
      sure: set(intj.sure),
      particleNext: set(intj.particleNext),
      yesNext: set(intj.yesNext),
      yesSkip: set(intj.yesSkip),
      noNext: set(intj.noNext),
      noSkip: set(intj.noSkip),
      chtoZhNext: set(intj.chtoZhNext),
    },
    speech: { verbs: set(speech.verbs), titleVerbs: set(speech.titleVerbs), authorPronouns: set(speech.authorPronouns) },
    gerund: { adverbs: set(ger.adverbs), idioms: toWordSeqs(ger.idioms) },
    isolatedObject: { words: toWordSeqs(iso.words), nextSkip: set(iso.nextSkip) },
  };
}

/* ---------- morphology helpers ---------- */

function parsesOf(tok) {
  return tok && tok.type === 'word' ? morph.dictParses(tok.text) : [];
}

function nounParses(tok) {
  return parsesOf(tok).filter((p) => p.tag.POS === 'NOUN');
}

function hasPos(tok, pos) {
  return parsesOf(tok).some((p) => p.tag.POS === pos);
}

function allPos(tok, set) {
  const ps = parsesOf(tok);
  return ps.length > 0 && ps.every((p) => set.has(p.tag.POS));
}

/** Cases of the noun readings; readings with negligible probability («сила» → gent of «сило», 0.02) are ignored. */
function nounCases(tok) {
  const s = new Set();
  const ps = nounParses(tok);
  for (const p of ps) if (p.tag.CAse && (ps.length === 1 || p.score >= 0.05)) s.add(p.tag.CAse);
  return s;
}

/** Noun with a nominative parse; `strict` also rejects oblique parses (gent/datv/ablt/loct) — accusative ambiguity is allowed. */
function isNomNoun(tok, strict) {
  const cs = nounCases(tok);
  if (!cs.has('nomn')) return false;
  if (!strict) return true;
  return !cs.has('gent') && !cs.has('datv') && !cs.has('ablt') && !cs.has('loct');
}

/** Nominative-only noun (no accusative reading either): a safe sentence subject. */
function isNomOnlyNoun(tok) {
  const cs = nounCases(tok);
  return cs.has('nomn') && cs.size === 1;
}

function isProper(tok) {
  return parsesOf(tok).some((p) => p.tag.Name || p.tag.Surn || p.tag.Patr || p.tag.Geox || p.tag.Orgn);
}

function isPersonName(tok) {
  return !!tok && tok.cap && parsesOf(tok).some((p) => (p.tag.Name || p.tag.Patr || p.tag.Surn) && p.tag.CAse === 'nomn');
}

function isIndeclinable(tok) {
  return nounParses(tok).some((p) => p.tag.Fixd);
}

/** Finite verb / short form / predicative — unambiguous, or the dominant reading. */
function isVerbLike(tok) {
  const ps = parsesOf(tok);
  if (!ps.length) return false;
  const vl = ps.filter((p) => VERBLIKE.has(p.tag.POS));
  if (!vl.length) return false;
  if (vl.length === ps.length) return true;
  return vl.some((p) => p.score >= 0.5);
}

function isFiniteVerb(tok) {
  const ps = parsesOf(tok);
  if (!ps.length) return false;
  const v = ps.filter((p) => p.tag.POS === 'VERB');
  if (!v.length) return false;
  return v.length === ps.length || v.some((p) => p.score >= 0.5);
}

function isInfinitive(tok) {
  const ps = parsesOf(tok);
  if (!ps.length) return false;
  const inf = ps.filter((p) => p.tag.POS === 'INFN');
  if (!inf.length) return false;
  return inf.length === ps.length || inf.some((p) => p.score >= 0.5);
}

/** Unambiguous imperative. Az exposes the mood as the boolean grammeme `tag.impr`. */
function isImperative(tok) {
  const ps = parsesOf(tok);
  return ps.length > 0 && ps.every((p) => p.tag.POS === 'VERB' && (p.tag.impr || p.tag.MOOd === 'impr'));
}

/** Present/future verb in 1st or 2nd person (unambiguous reading). */
function isPerson12(tok) {
  const ps = parsesOf(tok);
  const v = ps.filter((p) => p.tag.POS === 'VERB');
  return v.length > 0 && v.every((p) => p.tag.PErs === '1per' || p.tag.PErs === '2per') && v.length >= ps.length - 1;
}

/** Adjective-like word that is not itself a noun (agreeing modifier). */
function isAdjOnly(tok) {
  if (!tok || tok.type !== 'word') return false;
  if (POSSESSIVE.has(tok.lower)) return true;
  const ps = parsesOf(tok);
  return ps.length > 0 && ps.some((p) => p.tag.POS === 'ADJF' || p.tag.POS === 'PRTF') && !ps.some((p) => p.tag.POS === 'NOUN' || VERBLIKE.has(p.tag.POS));
}

/** Unambiguous gerund: every dictionary reading is GRND («красив», «Катя», «молча» are not). */
function isGerund(tok, X) {
  if (!tok || tok.type !== 'word') return false;
  if (X.gerund.adverbs.has(tok.lower)) return false;
  return allPos(tok, new Set(['GRND']));
}

/** Capitalised proper noun with a nominative reading (surnames in -ов also parse as genitive plural of the name). */
function isProperNom(tok) {
  return !!tok && tok.cap && parsesOf(tok).some((p) => (p.tag.Name || p.tag.Surn || p.tag.Geox || p.tag.Orgn) && p.tag.CAse === 'nomn');
}

/** Agreeing modifier before a noun: adjective-only word, or an adjective reading that agrees with the next token. */
function isModifierOf(tok, nextTok) {
  if (!tok) return false;
  if (isAdjOnly(tok)) return true;
  if (isProper(tok)) return false; // «Иванов директор» — a surname, not «Иванов дом»
  return !!nextTok && hasPos(tok, 'ADJF') && nounParses(nextTok).length > 0 && agrees(nextTok, tok, 'ADJF');
}

const NON_NOMINAL = ['PREP', 'CONJ', 'PRCL', 'ADVB', 'NPRO', 'INTJ', 'PRED'];

/** Strict finite verb: no noun reading («соловей» is also an imperative of «соловеть»). */
function isFiniteVerbStrict(tok) {
  return isFiniteVerb(tok) && !nounParses(tok).length && !hasPos(tok, 'ADJF');
}

function isParticiple(tok) {
  return allPos(tok, new Set(['PRTF']));
}

/** Verb-like in the wide sense: finite verb, short form, predicative, gerund or infinitive. */
function isVerbish(tok) {
  return isVerbLike(tok) || isInfinitive(tok);
}

const CASE_BEARING = new Set(['ADJF', 'PRTF', 'NPRO', 'NUMR']);

/** Cases of the nominal readings: noun readings when there are any, otherwise adjective / pronoun / numeral readings. */
function caseSet(tok) {
  const out = new Set();
  const ps = parsesOf(tok);
  const nouns = ps.filter((p) => p.tag.POS === 'NOUN');
  const use = nouns.length ? nouns : ps.filter((p) => CASE_BEARING.has(p.tag.POS));
  for (const p of use) if (p.tag.CAse && (!nouns.length || use.length === 1 || p.score >= 0.05)) out.add(p.tag.CAse);
  return out;
}

/**
 * Could `a` and `b` be two members of one homogeneous row («лёд и огонь», «пришёл и сел», «быстро и легко»)?
 * Both finite verbs, both infinitives, both adverbs, or nominals sharing a case (accusative alone is too
 * ambiguous to count unless it is the only reading of both).
 */
function sameRow(a, b) {
  if (isFiniteVerb(a) && isFiniteVerb(b)) return true;
  if (isInfinitive(a) && isInfinitive(b)) return true;
  if (allPos(a, new Set(['ADVB'])) && allPos(b, new Set(['ADVB']))) return true;
  const ca = caseSet(a);
  const cb = caseSet(b);
  if (!ca.size || !cb.size) return false;
  const shared = [...ca].filter((c) => cb.has(c));
  return shared.some((c) => c !== 'accs') || (shared.length > 0 && ca.size === 1 && cb.size === 1);
}

/** Adverb or particle (every reading): skipped when looking for the head of a row member. */
function isAdverbial(tok) {
  return allPos(tok, new Set(['ADVB', 'PRCL']));
}

/** First word from sentence word index k (adjacent run) that is not an adverb/particle, or null. */
function rowHead(ctx, sentence, k) {
  const words = sentence.words;
  for (let j = k; j < words.length && j < k + 3; j++) {
    const t = ctx.tokens[words[j]];
    if (j > k && !adjacentTokens(ctx, ctx.tokens[words[j - 1]], t)) return null;
    if (!isAdverbial(t)) return t;
  }
  return null;
}

const NI_QUANTITY_NEXT = new Set(['один', 'одна', 'одно', 'одного', 'одной', 'одним', 'одном', 'одни', 'одних', 'разу', 'капли', 'слова', 'шагу', 'грамма', 'секунды', 'минуты', 'копейки', 'малейшего', 'малейшей', 'малейшим']);

/** All lemmas of the dictionary parses with the given POS. */
function lemmasOf(tok, pos) {
  const out = new Set();
  for (const p of parsesOf(tok)) {
    if (pos && p.tag.POS !== pos) continue;
    const n = p.normalize();
    if (n) out.add(String(n.word || n).toLowerCase());
  }
  return out;
}

function lemmaIn(tok, set, pos) {
  for (const l of lemmasOf(tok, pos)) if (set.has(l)) return true;
  return false;
}

/** Noun and modifier agree in case, number and (singular) gender in at least one pair of parses. */
function agrees(nounTok, modTok, modPos) {
  const ns = nounParses(nounTok);
  const ms = parsesOf(modTok).filter((p) => p.tag.POS === modPos);
  for (const n of ns) for (const m of ms) {
    if (!n.tag.CAse || n.tag.CAse !== m.tag.CAse) continue;
    if (n.tag.NMbr !== m.tag.NMbr) continue;
    if (n.tag.NMbr === 'sing' && n.tag.GNdr && m.tag.GNdr && n.tag.GNdr !== m.tag.GNdr) continue;
    return true;
  }
  return false;
}

/* ---------- token helpers ---------- */

/** Only spaces between two tokens (a and b in text order). */
function adjacentTokens(ctx, a, b) {
  if (!a || !b || a.i >= b.i) return false;
  for (let t = a.i + 1; t < b.i; t++) if (ctx.tokens[t].type !== 'space') return false;
  return true;
}

/** Word tokens of a clause starting at sentence word index wi: consecutive words with no punctuation between. */
function clauseFrom(ctx, sentence, wi, max = 40) {
  const out = [];
  const words = sentence.words;
  for (let k = wi; k < words.length && out.length < max; k++) {
    const tok = ctx.tokens[words[k]];
    if (k > wi && !adjacentTokens(ctx, ctx.tokens[words[k - 1]], tok)) break;
    out.push(tok);
  }
  return out;
}

/** Word tokens of the clause ending right before sentence word index wi (walking back while adjacent). */
function clauseBefore(ctx, sentence, wi, max = 12) {
  const out = [];
  const words = sentence.words;
  for (let k = wi - 1; k >= 0 && out.length < max; k--) {
    const tok = ctx.tokens[words[k]];
    if (!adjacentTokens(ctx, tok, ctx.tokens[words[k + 1]])) break;
    out.unshift(tok);
  }
  return out;
}

/** Word tokens of the clause that ends with sentence word index e (inclusive), walking back while adjacent. */
function clauseEndingAt(ctx, sentence, e, max = 12) {
  const words = sentence.words;
  if (e < 0 || e >= words.length) return [];
  const out = [ctx.tokens[words[e]]];
  for (let k = e - 1; k >= 0 && out.length < max; k--) {
    const tok = ctx.tokens[words[k]];
    if (!adjacentTokens(ctx, tok, ctx.tokens[words[k + 1]])) break;
    out.unshift(tok);
  }
  return out;
}

function sentenceEndsWith(ctx, sentence, chars) {
  const last = ctx.tokens[sentence.tokens[sentence.tokens.length - 1]];
  return last.type === 'punct' && chars.includes(last.text);
}

function sentenceHasChar(ctx, sentence, ch) {
  return sentence.tokens.some((i) => ctx.tokens[i].type === 'punct' && ctx.tokens[i].text === ch);
}

function startsSentence(sentence) {
  return sentence.words.length > 0 && sentence.tokens[0] === sentence.words[0];
}

/** Does the word sequence starting at token index k (sentence words) match one of the sequences? Returns the matched length or 0. */
function matchSeq(ctx, sentence, k, seqs) {
  const words = sentence.words;
  for (const seq of seqs) {
    if (k + seq.length > words.length) continue;
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      const tok = ctx.tokens[words[k + j]];
      if (tok.lower !== seq[j]) { ok = false; break; }
      if (j > 0 && !adjacentTokens(ctx, ctx.tokens[words[k + j - 1]], tok)) { ok = false; break; }
    }
    if (ok) return seq.length;
  }
  return 0;
}

/* ---------- issue builders ---------- */

/** Insert `mark` right after `left` (before the gap to `right`). */
function insertAfter(ctx, left, right, mark, o) {
  const gap = ctx.text.slice(left.end, right.start);
  return makeIssue({
    para: ctx.para,
    start: left.start,
    end: right.end,
    category: 'punctuation',
    ruleId: o.ruleId,
    before: ctx.text.slice(left.start, right.end),
    after: left.text + mark + gap + right.text,
    confidence: o.confidence || 'check',
    why: o.why,
    ref: o.ref || [],
    manualRef: o.manualRef || [],
    source: o.source,
    meta: { kind: 'comma-before', conjStart: right.start, ...(o.meta || {}) },
  });
}

const commaAfter = (ctx, left, right, o) => insertAfter(ctx, left, right, ',', o);
const dashAfter = (ctx, left, right, o) => insertAfter(ctx, left, right, NBSP + EM, { ...o, meta: { kind: 'dash', ...(o.meta || {}) } });

/* ---------- 1. dash between subject and predicate ---------- */

function dashNouns(ctx, clause, X) {
  const n = clause.length;
  let i = 0;
  while (i < n - 1 && i < 2 && isModifierOf(clause[i], clause[i + 1])) i++;
  const subj = clause[i];
  if (!subj) return null;
  const subjProper = isProperNom(subj);
  if (!subjProper && !isNomNoun(subj, true)) return null;
  if (!subjProper && parsesOf(subj).some((p) => NON_NOMINAL.includes(p.tag.POS))) return null;
  if (isIndeclinable(subj) || X.dash.titleNouns.has(subj.lower) || X.dash.compoundHeads.has(subj.lower)) return null;
  const j = i + 1;
  if (j >= n) return null;
  if (DASH_BREAKERS.has(clause[j].lower)) return null;
  let k = j;
  while (k < n - 1 && k < j + 2 && isModifierOf(clause[k], clause[k + 1])) k++;
  const pred = clause[k];
  if (!pred || !isNomNoun(pred, true) || pred.lower === subj.lower) return null;
  if (isIndeclinable(pred) || parsesOf(pred).some((p) => NON_NOMINAL.includes(p.tag.POS))) return null; // «перед» (NOUN перёд / PREP)
  if (isProper(pred) || pred.cap) return null; // «город Москва», «Иван Петров», «Яндекс Метрика» — apposition, full name, product name
  if (subjProper && X.dash.geoCommon.has(pred.lower)) return null; // «Москва-река»
  const sure = subjProper && isNomOnlyNoun(pred) && !X.dash.titleNouns.has(pred.lower);
  return {
    left: subj,
    right: clause[j],
    confidence: sure ? 'sure' : 'check',
    ref: [164],
    manualRef: ['pm-dash-nouns'],
    why: sure
      ? `Подлежащее «${subj.text}» и сказуемое «${pred.text}» — существительные в именительном падеже, связки нет: между ними ставится тире.`
      : `Если «${subj.text}» — подлежащее, а «${pred.text}» — сказуемое (оба в именительном падеже), между ними нужно тире. Если это одно сложное слово или приложение, тире не ставится.`,
  };
}

function dashInfinitives(ctx, clause, X) {
  const n = clause.length;
  const first = clause[0];
  if (n < 2) return null;
  if (isInfinitive(first)) {
    if (lemmaIn(first, X.dash.phaseVerbs, 'INFN')) return null;
    for (let k = 1; k < n && k <= 4; k++) {
      const t = clause[k];
      if (COORD.has(t.lower) && t.lower !== 'не') return null;
      if (t.lower === 'не') {
        if (clause[k + 1] && isInfinitive(clause[k + 1])) return { left: clause[k - 1], right: t, confidence: 'check', ref: [165], manualRef: ['pm-dash-infinitives'], why: `Оба главных члена — неопределённая форма глагола («${first.text}» … «${clause[k + 1].text}»): между ними ставится тире, отрицание его не отменяет.` };
        return null;
      }
      if (isInfinitive(t)) {
        if (isVerbLike(clause[k - 1])) return null;
        return { left: clause[k - 1], right: t, confidence: 'check', ref: [165], manualRef: ['pm-dash-infinitives'], why: `Подлежащее и сказуемое выражены неопределённой формой глагола («${first.text}» — «${t.text}»): между ними ставится тире.` };
      }
    }
    return null;
  }
  // noun subject + infinitive predicate: «Наша задача закончить проект»
  let i = 0;
  while (i < n - 1 && i < 2 && isAdjOnly(clause[i])) i++;
  const subj = clause[i];
  if (!subj || !INF_NOUNS.has(subj.lower) || !isNomNoun(subj, false)) return null;
  const t = clause[i + 1];
  if (!t) return null;
  if (t.lower === 'не' && clause[i + 2] && isInfinitive(clause[i + 2])) return { left: subj, right: t, confidence: 'check', ref: [165], manualRef: ['pm-dash-infinitives'], why: `Подлежащее «${subj.text}» — существительное, сказуемое — неопределённая форма глагола: между ними ставится тире.` };
  if (!isInfinitive(t)) return null;
  return { left: subj, right: t, confidence: 'check', ref: [165], manualRef: ['pm-dash-infinitives'], why: `Подлежащее «${subj.text}» — существительное, сказуемое «${t.text}» — неопределённая форма глагола: между ними ставится тире.` };
}

function isNumeral(tok) {
  return !!tok && (tok.type === 'num' || parsesOf(tok).some((p) => p.tag.POS === 'NUMR' && (p.tag.CAse === 'nomn' || !p.tag.CAse)));
}

function dashNumerals(ctx, clause) {
  const n = clause.length;
  if (n < 3) return null;
  // «Дважды два четыре», «Пятью пять двадцать пять»
  if (MULTIPLY.has(clause[0].lower) && isNumeral(clause[1]) && clause[1].type === 'word' && isNumeral(clause[2]) && clause[2].type === 'word' && (n === 3 || (n === 4 && isNumeral(clause[3])))) {
    return { left: clause[1], right: clause[2], confidence: 'check', ref: [164], manualRef: ['pm-dash-numerals'], why: 'Подлежащее и сказуемое выражены числительными: между ними ставится тире.' };
  }
  // «Длина маршрута двенадцать километров»
  let i = 0;
  while (i < n - 1 && i < 2 && isAdjOnly(clause[i])) i++;
  const subj = clause[i];
  if (!subj || !isNomNoun(subj, true) || subj.type !== 'word') return null;
  let k = i + 1;
  while (k < n && k <= i + 2 && nounParses(clause[k]).length && nounCases(clause[k]).has('gent') && !isNumeral(clause[k])) k++;
  if (k >= n || !isNumeral(clause[k]) || clause[k].type !== 'word') return null;
  const numStart = k;
  while (k < n && isNumeral(clause[k]) && clause[k].type === 'word') k++;
  const unit = clause[k];
  if (!unit || !nounCases(unit).has('gent') || k !== n - 1) return null;
  return { left: clause[numStart - 1], right: clause[numStart], confidence: 'check', ref: [164], manualRef: ['pm-dash-numerals'], why: `Если «${subj.text}» — подлежащее, а «${clause[numStart].text} ${unit.text}» — сказуемое-числительное, между ними ставится тире.` };
}

function etoDash(ctx, sentence, wi, X) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  const left = clauseBefore(ctx, sentence, wi, 6);
  if (!left.length) return null;
  const prev = left[left.length - 1];
  const first = left[0];
  if (left.some((t) => isVerbLike(t) || PERSONAL.has(t.lower) || RELATIVE.has(t.lower) || t.lower === 'всё' || t.lower === 'все' || t.lower === 'это' || t.lower === 'вот' || t.lower === 'значит')) return null;
  if (!left.every((t) => POSSESSIVE.has(t.lower) || t.lower === 'и' || t.type === 'num' || parsesOf(t).some((p) => NOMINAL.has(p.tag.POS) || p.tag.POS === 'INFN' || p.tag.POS === 'PREP'))) return null;
  const subjectOk = isNomNoun(first, true) || isInfinitive(first) || (isAdjOnly(first) && left.slice(1).some((t) => isNomNoun(t, true)));
  if (!subjectOk) return null;
  const prevOk = isInfinitive(prev) || (nounParses(prev).length > 0 && (nounCases(prev).has('nomn') || nounCases(prev).has('gent')));
  if (!prevOk) return null;
  // the part after «это»
  const right = clauseFrom(ctx, sentence, wi + 1, 8);
  if (!right.length) return null;
  let r = 0;
  if (right[r].lower === 'не') r++;
  if (tok.lower === 'это' && right[r] && right[r].lower === 'есть') r++;
  if (tok.lower === 'это' && right[r] && right[r].lower === 'значит') r++;
  while (r < right.length && r < 3 && isAdjOnly(right[r])) r++;
  const head = right[r];
  if (!head) return null;
  let headOk = isNomNoun(head, false) || isInfinitive(head) || head.type === 'num' || hasPos(head, 'NUMR');
  if (!headOk && tok.lower === 'вот') headOk = RELATIVE.has(head.lower) || (hasPos(head, 'PREP') && right[r + 1] && RELATIVE.has(right[r + 1].lower));
  if (!headOk) return null;
  const relativeClause = tok.lower === 'вот' && RELATIVE.has(head.lower);
  if (!relativeClause && right.slice(r + 1).some(isVerbLike)) return null; // «Мама это письмо получила»
  if (right.slice(0, r).some((t) => t.lower === 'же' || t.lower === 'ли')) return null;
  const headCases = nounCases(head);
  const headSafe = headCases.has('nomn') && !headCases.has('gent') && !headCases.has('datv') && !headCases.has('ablt'); // «сердце» (nomn/accs/loct) is fine
  const sure = tok.lower === 'это' && isNomNoun(prev, true) && left.length <= 3 && headSafe && !isVerbLike(head);
  return {
    left: prev,
    right: tok,
    confidence: sure ? 'sure' : 'check',
    ref: [166],
    manualRef: ['pm-dash-eto-vot'],
    why: `Перед «${tok.text}», присоединяющим сказуемое к подлежащему («${first.text}…»), ставится тире.`,
  };
}

function dashIssues(ctx, sentence, X, out) {
  if (ctx.kind === 'h') return;
  const words = sentence.words;
  if (words.length < 2) return;
  if (sentenceEndsWith(ctx, sentence, ['?'])) return;
  for (let wi = 1; wi < words.length; wi++) {
    const tok = ctx.tokens[words[wi]];
    if (tok.lower !== 'это' && tok.lower !== 'вот' && tok.lower !== 'значит') continue;
    if (ctx.inSkip(tok.start, tok.end)) continue;
    const r = etoDash(ctx, sentence, wi, X);
    if (r) out.push(dashAfter(ctx, r.left, r.right, { ruleId: 'punct.dash-subject', ...r }));
  }
  if (!startsSentence(sentence)) return;
  const clause = clauseFrom(ctx, sentence, 0, 12);
  if (clause.length < 2) return;
  if (ctx.inSkip(clause[0].start, clause[0].end)) return;
  if (clause.some((t) => t.lower === 'это' || t.lower === 'вот' || t.lower === 'значит')) return;
  if (clause.some((t) => t.type !== 'word' && t.type !== 'num')) return;
  if (clause.some((t) => isVerbLike(t) && !POSSESSIVE.has(t.lower))) return;
  const r = dashNouns(ctx, clause, X) || dashInfinitives(ctx, clause, X) || dashNumerals(ctx, clause);
  if (r) out.push(dashAfter(ctx, r.left, r.right, { ruleId: 'punct.dash-subject', ...r }));
}

/* ---------- 2. generalizing words ---------- */

function listItem(ctx, sentence, k) {
  // one item: [PREP] [ADJF]{0,2} NOUN|NPRO|num ; returns index after the item or -1
  const words = sentence.words;
  let i = k;
  if (i >= words.length) return -1;
  let tok = ctx.tokens[words[i]];
  if (hasPos(tok, 'PREP') && !nounParses(tok).length) { i++; tok = ctx.tokens[words[i]]; if (!tok || !adjacentTokens(ctx, ctx.tokens[words[i - 1]], tok)) return -1; }
  let adj = 0;
  while (tok && adj < 2 && isAdjOnly(tok)) { i++; adj++; const nt = ctx.tokens[words[i]]; if (!nt || !adjacentTokens(ctx, tok, nt)) return -1; tok = nt; }
  if (!tok || !(nounParses(tok).length || hasPos(tok, 'NPRO') || tok.type === 'num')) return -1;
  if (isVerbLike(tok)) return -1;
  return i + 1;
}

function generalizingColon(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (!GENERALIZING_COLON.has(tok.lower)) return;
  const next = ctx.nextTokenFrom(tok.end);
  if (!next || next.type !== 'word' || next.si !== tok.si) return;
  const firstTok = next;
  if (tok.lower === 'всё') {
    // «всё это», «всё лето», «всё хорошее» — not a list
    if (parsesOf(firstTok).some((p) => (p.tag.POS === 'ADJF' || p.tag.POS === 'NPRO' || (p.tag.POS === 'NOUN' && p.tag.GNdr === 'neut' && p.tag.NMbr === 'sing')))) return;
    if (!hasPos(firstTok, 'PREP') && !nounParses(firstTok).length) return;
  }
  let items = 0;
  let k = wi + 1;
  for (;;) {
    const after = listItem(ctx, sentence, k);
    if (after === -1) break;
    items++;
    const lastTok = ctx.tokens[words[after - 1]];
    const sep = ctx.nextTokenFrom(lastTok.end);
    if (!sep || sep.si !== tok.si) break;
    if (sep.type === 'punct' && sep.text === ',') {
      const nxt = ctx.nextTokenFrom(sep.end);
      if (!nxt || nxt.type !== 'word') break;
      k = words.indexOf(nxt.i);
      if (k === -1) break;
      continue;
    }
    if (sep.type === 'word' && (sep.lower === 'и' || sep.lower === 'или') && items >= 2) {
      const nxt = ctx.nextTokenFrom(sep.end);
      const kk = nxt && nxt.type === 'word' ? words.indexOf(nxt.i) : -1;
      if (kk !== -1 && listItem(ctx, sentence, kk) !== -1) items++;
    }
    break;
  }
  if (items < 3) return;
  out.push(insertAfter(ctx, tok, firstTok, ':', {
    ruleId: 'punct.general-colon',
    confidence: 'check',
    ref: [159, 160],
    manualRef: ['pm-general-colon'],
    why: `Если «${tok.text}» — обобщающее слово перед перечислением, после него ставится двоеточие.`,
    meta: { kind: 'colon' },
  }));
}

function headNounCases(ctx, group) {
  for (let i = group.length - 1; i >= 0; i--) {
    const cs = nounCases(group[i]);
    if (cs.size) return cs;
    if (hasPos(group[i], 'NPRO')) return new Set(['nomn']);
  }
  return new Set();
}

function generalizingDash(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (!GENERALIZING_DASH.has(tok.lower) || wi === 0) return;
  const prev = ctx.prevTokenBefore(tok.start);
  if (!prev || prev.type !== 'word' || prev.si !== tok.si) return;
  const next = ctx.nextTokenFrom(tok.end);
  if (next && next.type === 'word' && X.dash.generalizingAfterSkip.has(next.lower)) return;
  if (tok.lower !== 'словом') {
    if (next && next.si === tok.si && next.type === 'word' && !(isVerbLike(next) || next.lower === 'не' || next.lower === 'это' || isAdjOnly(next) && !hasPos(next, 'NOUN'))) return;
  } else if (!next || next.type !== 'word' || next.si !== tok.si) return;
  // Y group right before tok, then a comma, then X group
  const y = clauseBefore(ctx, sentence, wi, 4);
  if (!y.length || y.length > 4) return;
  const comma = ctx.prevTokenBefore(y[0].start);
  if (!comma || comma.type !== 'punct' || comma.text !== ',' || comma.si !== tok.si) return;
  const xLast = ctx.prevTokenBefore(comma.start);
  if (!xLast || xLast.type !== 'word' || xLast.si !== tok.si) return;
  const x = clauseEndingAt(ctx, sentence, words.indexOf(xLast.i), 4);
  if (!x.length) return;
  const repeated = (x[0].lower === 'ни' && y[0].lower === 'ни') || (x[0].lower === 'и' && y[0].lower === 'и');
  if (!repeated) {
    const cx = headNounCases(ctx, x);
    const cy = headNounCases(ctx, y);
    if (!cx.size || !cy.size || ![...cx].some((c) => cy.has(c))) return;
    if (x.some(isVerbLike) || y.some(isVerbLike)) return;
  }
  const gap = ctx.text.slice(prev.end, tok.start);
  if (tok.lower === 'словом') {
    const gap2 = ctx.text.slice(tok.end, next.start);
    out.push(makeIssue({
      para: ctx.para, start: prev.start, end: next.end, category: 'punctuation', ruleId: 'punct.general-dash',
      before: ctx.text.slice(prev.start, next.end), after: `${prev.text}${NBSP}${EM}${gap}${tok.text},${gap2}${next.text}`,
      confidence: 'check', ref: [167], manualRef: ['pm-general-slovom'],
      why: 'После перечисления перед итоговым «словом» ставится тире, а после него — запятая.', meta: { kind: 'dash' },
    }));
    return;
  }
  out.push(dashAfter(ctx, prev, tok, {
    ruleId: 'punct.general-dash', confidence: 'check', ref: [167], manualRef: ['pm-general-dash'],
    why: `Если «${tok.text}» обобщает перечисленное перед ним, перед обобщающим словом ставится тире.`,
  }));
}

/* ---------- 3. repeated and double conjunctions ---------- */

const REPEATED_UNITS = [['не', 'то'], ['то', 'ли'], ['и'], ['ни'], ['или'], ['либо'], ['то']];

function repeatedConj(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  for (const unit of REPEATED_UNITS) {
    if (matchSeq(ctx, sentence, wi, [unit]) !== unit.length) continue;
    const key = unit.join(' ');
    if (key === 'и' && wi === 0) return;
    if (key === 'то') {
      const prev = wi > 0 ? ctx.tokens[words[wi - 1]] : null;
      if (prev && (TO_PREV_SKIP.has(prev.lower) || hasPos(prev, 'PREP'))) return;
      const nxt = ctx.tokens[words[wi + unit.length]];
      if (!nxt || TO_NEXT_SKIP.has(nxt.lower)) return;
    }
    if (key === 'и') {
      const prev = wi > 0 ? ctx.tokens[words[wi - 1]] : null;
      if (prev && ['т', 'и', 'так', 'да'].includes(prev.lower)) return;
    }
    // the second occurrence: 1..5 words later, no punctuation on the way
    const firstEnd = wi + unit.length;
    let second = -1;
    for (let k = firstEnd; k <= firstEnd + 5 && k < words.length; k++) {
      if (!adjacentTokens(ctx, ctx.tokens[words[k - 1]], ctx.tokens[words[k]])) break;
      if (k > firstEnd && matchSeq(ctx, sentence, k, [unit]) === unit.length) { second = k; break; }
    }
    if (second === -1) return;
    const between = [];
    for (let k = firstEnd; k < second; k++) between.push(ctx.tokens[words[k]]);
    if (!between.length) return;
    const afterTok = ctx.tokens[words[second + unit.length]];
    if (!afterTok || !adjacentTokens(ctx, ctx.tokens[words[second + unit.length - 1]], afterTok)) return;
    if (key === 'и' && (['т', 'так', 'тому', 'потому', 'вот', 'даже', 'только', 'уже', 'ещё', 'еще', 'тогда', 'значит', 'поэтому', 'пр', 'всё', 'все', 'вообще', 'наоборот', 'правда', 'главное'].includes(afterTok.lower))) return;
    if (key === 'ни' && ['один', 'одна', 'одно', 'одного', 'одной', 'разу', 'капли', 'слова', 'шагу', 'за', 'к', 'в', 'на', 'о', 'с', 'у', 'при', 'по', 'от', 'из', 'под'].includes(afterTok.lower) && between.length === 1 && hasPos(between[0], 'PREP')) return;
    // «ни один из них нельзя считать ни полным, ни точным» — the first «ни» belongs to a pronoun phrase, not to the row
    if (key === 'ни' && NI_QUANTITY_NEXT.has(between[0].lower)) return;
    if (key === 'и' || key === 'или' || key === 'либо') {
      // the first conjunction opens a clause, not a row member: «и если …», «и не только …», «и вот …»
      if (hasPos(between[0], 'CONJ') || hasPos(between[0], 'PRCL')) return;
      // the first conjunction joins predicates or clauses while the second joins objects:
      // «интересуется историей и часто посещает музеи и выставки», «результаты оказались рассчитанными и предсказанными».
      // Heads are compared past leading adverbs, so «и опять поднималась, и опять делала» survives.
      const verbInside = between.some((t) => isVerbLike(t) && !hasPos(t, 'GRND'));
      if (verbInside) {
        const leftHead = between.find((t) => !isAdverbial(t)) || between[0];
        const rightHead = rowHead(ctx, sentence, second + unit.length) || afterTok;
        if (!(isVerbish(leftHead) && isVerbish(rightHead))) return;
      }
      // the word before the first conjunction is a member of the same row as the word after it — a single «и» between two
      // members, not «и X, и Y»: «лёд и огонь, коты и собаки», «серые дома и мостовые, угрюмые лица и сумерки».
      // A three-member row «пришёл и сел и начал» (one word between) keeps its comma.
      const prevOfFirst = wi > 0 ? ctx.tokens[words[wi - 1]] : null;
      if (between.length >= 2 && prevOfFirst && prevOfFirst.type === 'word' && adjacentTokens(ctx, prevOfFirst, tok) && sameRow(prevOfFirst, between[0])) return;
      if (isVerbish(afterTok) !== isVerbish(between[0]) && !PERSONAL.has(between[0].lower)) return; // «цедру и сушить»
      // reduplication: «снова и снова», «ждал и ждал»
      if (afterTok.lower === between[between.length - 1].lower) return;
    }
    // idioms: «ни свет ни заря», «и так и сяк»
    const idioms = key === 'ни' ? X.homogeneous.niIdioms : key === 'и' ? X.homogeneous.iIdioms : [];
    const bet = between.map((t) => t.lower).join(' ');
    for (const [a, b] of idioms) {
      if (a.join(' ') !== bet) continue;
      if (matchSeq(ctx, sentence, second + unit.length, [b]) === b.length) return;
    }
    // any other set phrase covering «и X и Y» / «ни X ни Y» / «то X то Y» (Викисловарь, § 146 note): no comma
    if (idiomsMod.isIdiomSpan(ctx.text, tok.start, afterTok.end)) return;
    // «и»: different homogeneous rows («купил хлеб и молоко и пошёл домой», «эллипсы с заливкой и радиусом») — no comma
    if (key === 'и') {
      if (isVerbLike(afterTok) !== isVerbLike(between[0]) && !PERSONAL.has(between[0].lower)) return;
      const c1 = nounCases(between[0]);
      const c2 = nounCases(afterTok);
      if (c1.size && c2.size && ![...c1].some((c) => c2.has(c))) return; // items of one row share the case
      if ((hasPos(afterTok, 'PREP') && !c2.size) || (hasPos(between[0], 'PREP') && !c1.size)) return; // «до и после»
    }
    const prevOfSecond = ctx.tokens[words[second - 1]];
    const secondTok = ctx.tokens[words[second]];
    const label = unit.join(' ');
    out.push(commaAfter(ctx, prevOfSecond, secondTok, {
      ruleId: 'punct.comma-repeated-conj',
      confidence: 'check',
      ref: key === 'и' || key === 'ни' || key === 'или' ? [146, 136] : [146],
      manualRef: key === 'и' ? ['pm-conj-i'] : ['pm-conj-i', 'pm-homog-idioms'],
      why: `Повторяющийся союз «${label}… ${label}»: перед вторым «${label}» ставится запятая (кроме устойчивых сочетаний вроде «ни свет ни заря» и случаев, когда союзы связывают разные ряды однородных членов).`,
      meta: { conj: label },
    }));
    return;
  }
}

function doubleConj(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (tok.lower === 'как') {
    for (let k = wi + 2; k <= wi + 9 && k + 1 < words.length; k++) {
      const t = ctx.tokens[words[k]];
      if (t.si !== tok.si) break;
      if (t.lower !== 'так') continue;
      const i2 = ctx.tokens[words[k + 1]];
      if (i2.lower !== 'и' || !adjacentTokens(ctx, t, i2)) break;
      const prev = ctx.tokens[words[k - 1]];
      if (!adjacentTokens(ctx, prev, t)) break; // comma (or other mark) already there
      const after = ctx.tokens[words[k + 2]];
      if (after && after.lower === 'не') break; // «так и не понял»
      if (prev.lower === 'как') break;
      out.push(commaAfter(ctx, prev, t, {
        ruleId: 'punct.comma-double-conj', confidence: 'sure', ref: [145], manualRef: ['pm-conj-i'],
        why: 'Двойной союз «как …, так и …»: запятая ставится перед второй частью — перед «так и».', meta: { conj: 'как … так и' },
      }));
      break;
    }
    return;
  }
  if (tok.lower === 'если') {
    for (let k = wi + 2; k <= wi + 14 && k < words.length; k++) {
      const t = ctx.tokens[words[k]];
      if (t.si !== tok.si) break;
      if (t.lower === 'если') break;
      if (t.lower !== 'то') continue;
      const prev = ctx.tokens[words[k - 1]];
      if (!adjacentTokens(ctx, prev, t)) break; // comma already before «то»
      if (TO_PREV_SKIP.has(prev.lower) || hasPos(prev, 'PREP')) break;
      const nxt = ctx.tokens[words[k + 1]];
      if (!nxt || !adjacentTokens(ctx, t, nxt)) break;
      if (TO_NEXT_SKIP.has(nxt.lower)) break;
      if (parsesOf(nxt).some((p) => (p.tag.POS === 'NOUN' || p.tag.POS === 'ADJF') && p.tag.GNdr === 'neut' && p.tag.NMbr === 'sing' && (p.tag.CAse === 'nomn' || p.tag.CAse === 'accs'))) break; // «то слово»
      out.push(commaAfter(ctx, prev, t, {
        ruleId: 'punct.comma-double-conj', confidence: 'sure', ref: [140], manualRef: ['pm-conj-junction'],
        why: 'Двойной союз «если …, то …»: перед второй частью «то» ставится запятая.', meta: { conj: 'если … то' },
      }));
      break;
    }
  }
}

/* ---------- 4. comparative «как», «нежели» ---------- */

function kakIssue(ctx, sentence, wi, X, conj, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (tok.lower === 'нежели') {
    const prev = ctx.prevTokenBefore(tok.start);
    if (!prev || prev.type !== 'word' || prev.si !== tok.si || wi === 0) return;
    if (conj.stops.has(prev.lower)) return;
    out.push(commaAfter(ctx, prev, tok, {
      ruleId: 'punct.comma-comparative', confidence: 'sure', ref: [150], manualRef: ['pm-compare-budto'],
      why: 'Сравнительный оборот с союзом «нежели» выделяется запятыми.', meta: { conj: 'нежели' },
    }));
    return;
  }
  if (tok.lower !== 'как' || wi === 0) return;
  const prev = ctx.prevTokenBefore(tok.start);
  if (!prev || prev.type !== 'word' || prev.si !== tok.si) return;
  if (X.comparison.kakPrevSkip.has(prev.lower) || conj.stops.has(prev.lower)) return;
  const next = ctx.nextWordFrom(tok.end);
  if (!next || next.si !== tok.si) return;
  if (X.comparison.kakNextSkip.has(next.lower)) return;
  // «как и …» — comparison with «как и»; idioms after it («как и обещал») are not flagged
  const afterKak = next.lower === 'и' ? wi + 2 : wi + 1;
  if (matchSeq(ctx, sentence, afterKak, X.comparison.kakIdioms)) return;
  // «как» inside a set phrase of 3+ words («как по маслу», «белый как снег») — a stable comparison, § 150 (Викисловарь)
  if (idiomsMod.isIdiomSpan(ctx.text, tok.start, tok.end, 3)) return;
  if (next.lower === 'и' && (!ctx.tokens[words[afterKak]] || !adjacentTokens(ctx, next, ctx.tokens[words[afterKak]]))) return;
  // «в качестве»: a verb of naming/using within 3 words before; a short participle («опубликован как артефакт»);
  // an object pronoun («выполняет их как команды»); an instrumental object after «как» («пользуются как справочником»)
  const before = clauseBefore(ctx, sentence, wi, 4);
  if (before.some((t) => lemmaIn(t, X.comparison.kakRoleVerbs) || X.comparison.kakRoleVerbs.has(t.lower))) return;
  if (allPos(prev, new Set(['PRTS'])) || hasPos(prev, 'PRTS') && !nounParses(prev).length) return;
  if (['его', 'её', 'ее', 'их', 'меня', 'тебя', 'нас', 'вас', 'себя', 'это', 'этого', 'всё', 'все'].includes(prev.lower)) return;
  const nextCases = nounCases(next);
  if (nextCases.size && !nextCases.has('nomn') && (nextCases.has('ablt') || nextCases.has('accs')) && !nextCases.has('gent')) return;
  // predicate: «Площадь как каток» — no verb at all in the left part (not for «как и», which is always a comparison)
  if (next.lower !== 'и' && !before.some((t) => isVerbLike(t) || isInfinitive(t) || hasPos(t, 'GRND') || hasPos(t, 'PRTF')) && before.length === wi && wi <= 4 && !before.some((t) => hasPos(t, 'PREP'))) return;
  const headTok = next.lower === 'и' ? ctx.tokens[words[afterKak]] : next;
  if (!headTok) return;
  const headNominal = nounParses(headTok).length || hasPos(headTok, 'NPRO') || isAdjOnly(headTok) || hasPos(headTok, 'PREP') || headTok.type === 'num' || hasPos(headTok, 'NUMR');
  const headVerb = isFiniteVerbStrict(headTok);
  if (!headNominal && !headVerb) return;
  // «как …, так и …» is the double conjunction (punct.comma-double-conj puts the comma before «так и»)
  for (let k = wi + 2; k <= wi + 9 && k + 1 < words.length; k++) {
    const t = ctx.tokens[words[k]];
    if (t.si !== tok.si) break;
    if (t.lower === 'так' && ctx.tokens[words[k + 1]].lower === 'и') return;
  }
  // subordinate clause: «как» + (noun/pronoun) + verb, or «как» + verb; «как и …» is always a comparison.
  // The clause ends at a coordinating conjunction («сидели как сычи, а потом начали» — «начали» is not inside it).
  let rest = clauseFrom(ctx, sentence, afterKak, 6);
  const coordAt = rest.findIndex((t, i) => i > 0 && COORD.has(t.lower) && t.lower !== 'не');
  if (coordAt > 0) rest = rest.slice(0, coordAt);
  const subordinate = next.lower !== 'и' && (headVerb || rest.slice(1).some(isFiniteVerbStrict));
  if (subordinate && !isVerbLike(prev) && !nounParses(prev).length && !hasPos(prev, 'ADVB') && !hasPos(prev, 'NPRO')) return;
  if (!subordinate && (prev.lower === 'такой' || prev.lower === 'так')) return;
  // «видел, как он ушёл», «понять, как это работает»: a verb before «как» and a clause after it is the most reliable «как» (§ 140),
  // but on the eval stand it is still only 4 of 5 — so every «как» stays `check`; the kind is kept in meta for the stand
  const prevVerb = isVerbLike(prev) || isInfinitive(prev) || hasPos(prev, 'GRND');
  const subVerb = subordinate && prevVerb && !KAK_CLAUSE_IDIOM_NEXT.has(next.lower) && !(headVerb && rest.length === 1);
  const kakKind = subordinate ? (subVerb ? 'sub-verb' : 'sub-other') : next.lower === 'и' ? 'kak-i' : 'cmp';
  const why = subordinate
    ? `После «${prev.text}» союз «как» начинает придаточное предложение — перед ним нужна запятая (если это не цельное выражение вроде «как хочешь»).`
    : next.lower === 'и'
      ? 'Оборот с «как и» — сравнительный, он выделяется запятыми с обеих сторон.'
      : `Если «как ${headTok.text}…» — сравнение, оборот выделяется запятыми. Запятая не нужна, если «как» значит «в качестве», входит в устойчивое сочетание или обозначает образ действия.`;
  out.push(commaAfter(ctx, prev, tok, {
    ruleId: 'punct.comma-comparative', confidence: 'check',
    ref: subordinate ? [140] : [150],
    manualRef: subordinate ? ['pm-spp-comma', 'pm-spp-idioms'] : ['pm-compare-kak-yes', 'pm-compare-kak-no'],
    why, meta: { conj: `как:${kakKind}` },
  }));
}

const KAK_CLAUSE_IDIOM_NEXT = new Set(['бы', 'б', 'раз', 'минимум', 'максимум', 'можно', 'нельзя', 'надо', 'нужно', 'следует', 'положено', 'полагается', 'получится', 'получается', 'хочешь', 'хочет', 'хотите', 'хотят', 'знаешь', 'знает', 'знаете', 'угодно', 'попало', 'обычно', 'всегда', 'никогда', 'когда', 'если', 'только', 'будто', 'словно', 'есть', 'было', 'будет', 'вдруг', 'ни', 'не', 'же', 'ж', 'говорится', 'говорят', 'известно', 'правило', 'правильно', 'видно', 'видите', 'видишь', 'понимаешь', 'понимаете', 'думаешь', 'думаете', 'считаешь', 'считаете', 'кажется', 'оказалось', 'выяснилось', 'принято', 'заведено', 'положено', 'обещал', 'обещала', 'договаривались', 'планировалось', 'ожидалось', 'ожидали', 'сказано', 'написано', 'должно', 'следовало', 'умеешь', 'умеет', 'умею', 'могу', 'можешь', 'может', 'сумею', 'сумеет', 'сумеешь', 'хочу', 'прежде', 'раньше', 'ранее', 'сейчас', 'теперь', 'тогда', 'всё', 'все', 'это', 'так', 'там', 'тут', 'здесь', 'никто', 'ничто', 'никак', 'нигде', 'никуда', 'что', 'кто', 'чем', 'чтобы', 'ли', 'пить', 'дышать']);

/* ---------- 5. addresses ---------- */

function addressGroupAtStart(ctx, sentence, X) {
  const words = sentence.words;
  const t0 = ctx.tokens[words[0]];
  const group = [];
  let i = 0;
  if (X.address.adjectives.has(t0.lower) && words.length > 2) { group.push(t0); i = 1; }
  let tok = ctx.tokens[words[i]];
  if (!tok || (i > 0 && !adjacentTokens(ctx, group[0], tok))) return null;
  const nounLen = matchSeq(ctx, sentence, i, X.address.nounSeqs);
  if (nounLen) {
    for (let j = 0; j < nounLen; j++) group.push(ctx.tokens[words[i + j]]);
    i += nounLen;
  } else if (isPersonName(tok) && !(group.length && !agrees(tok, group[0], 'ADJF'))) {
    group.push(tok);
    i++;
    while (i < words.length) {
      const nt = ctx.tokens[words[i]];
      if (!nt.cap || !adjacentTokens(ctx, group[group.length - 1], nt)) break;
      if (!parsesOf(nt).some((p) => (p.tag.Patr || p.tag.Surn) && p.tag.CAse === 'nomn')) break;
      group.push(nt);
      i++;
    }
  } else return null;
  return { group, nextIndex: i };
}

function addressStart(ctx, sentence, X, out) {
  if (!startsSentence(sentence) || sentence.words.length < 2) return;
  const g = addressGroupAtStart(ctx, sentence, X);
  if (!g) return;
  const words = sentence.words;
  const last = g.group[g.group.length - 1];
  const next = ctx.tokens[words[g.nextIndex]];
  if (!next || !adjacentTokens(ctx, last, next)) return;
  if (['и', 'а', 'да', 'или', 'с', 'со'].includes(next.lower)) return;
  const question = sentenceEndsWith(ctx, sentence, ['?']);
  let trigger = null;
  if (isImperative(next) || (next.lower === 'не' && isImperative(ctx.tokens[words[g.nextIndex + 1]] || null))) trigger = 'imperative';
  else if (SECOND_PERSON.has(next.lower)) trigger = 'pronoun';
  else if (isPerson12(next)) trigger = 'person';
  else if (question && X.address.questionWords.has(next.lower)) trigger = 'question';
  else if (['пожалуйста', 'спасибо', 'привет', 'здравствуй', 'здравствуйте', 'прощай', 'прощайте', 'извини', 'извините', 'прости', 'простите', 'добрый', 'доброе', 'добро', 'поздравляю', 'поздравляем', 'благодарю', 'приветствую'].includes(next.lower)) trigger = 'etiquette';
  if (!trigger) return;
  const sure = trigger === 'imperative' && (g.group.length > 1 || isPersonName(last) || X.address.nouns.has(last.lower));
  out.push(commaAfter(ctx, last, next, {
    ruleId: 'punct.address', confidence: sure ? 'sure' : 'check', ref: [156], manualRef: ['pm-address-start'],
    why: `«${g.group.map((t) => t.text).join(' ')}» в начале предложения — обращение, оно отделяется запятой (или восклицательным знаком).`,
  }));
}

function addressEnd(ctx, sentence, X, out) {
  const words = sentence.words;
  if (words.length < 3) return;
  const last = ctx.tokens[words[words.length - 1]];
  const afterLast = ctx.nextTokenFrom(last.end);
  if (afterLast && afterLast.si === last.si && afterLast.type !== 'punct') return;
  if (!(isPersonName(last) && isNomOnlyNoun(last)) && !X.address.nouns.has(last.lower)) return;
  if (X.address.adjectives.has(last.lower)) return;
  const prev = ctx.prevTokenBefore(last.start);
  if (!prev || prev.type !== 'word' || prev.si !== last.si) return;
  if (COORD.has(prev.lower) || hasPos(prev, 'PREP') || X.address.adjectives.has(prev.lower)) return;
  if (isAdjOnly(prev) && agrees(last, prev, 'ADJF')) return;
  const toks = words.map((i) => ctx.tokens[i]);
  const hasImpr = toks.some((t) => isImperative(t));
  const hasYou = toks.some((t) => SECOND_PERSON.has(t.lower));
  const has2per = toks.some((t) => parsesOf(t).some((p) => p.tag.POS === 'VERB' && p.tag.PErs === '2per'));
  const etiquette = ['спасибо', 'привет', 'пока', 'здравствуй', 'здравствуйте', 'прощай', 'прощайте', 'извини', 'извините', 'прости', 'простите', 'поздравляю', 'благодарю', 'удачи', 'доброе', 'добрый', 'спокойной', 'приятного', 'счастливо'].includes(toks[0].lower);
  if (!hasImpr && !hasYou && !has2per && !etiquette) return;
  if (isFiniteVerb(prev)) {
    const p12 = isPerson12(prev);
    const hasSub = toks.some((t) => SUBORDINATORS.has(t.lower)) || sentenceHasChar(ctx, sentence, ',');
    if (!p12 && !hasImpr && !(hasYou && !hasSub)) return;
  }
  out.push(commaAfter(ctx, prev, last, {
    ruleId: 'punct.address', confidence: 'check', ref: [156], manualRef: ['pm-address-end'],
    why: `Если «${last.text}» в конце предложения — обращение, перед ним ставится запятая.`,
  }));
}

/* ---------- 6. interjections, «да»/«нет», «что ж» ---------- */

function interjections(ctx, sentence, X, out) {
  const words = sentence.words;
  if (words.length < 2) return;
  const t0 = ctx.tokens[words[0]];
  if (ctx.inSkip(t0.start, t0.end)) return;
  const first = sentence.tokens[0];
  const lead = ctx.tokens[first];
  if (first !== words[0] && !(lead.type === 'punct' && ['—', '–', '-', '«', '"', '„'].includes(lead.text) && sentence.tokens.indexOf(words[0]) <= 2)) return;
  const next = ctx.tokens[words[1]];
  if (!adjacentTokens(ctx, t0, next)) return;
  const I = X.interjection;
  if (I.words.has(t0.lower)) {
    if (t0.lower === 'ну' || t0.lower === 'о') return;
    if (GENERIC_INTERJ_SKIP.has(next.lower)) return;
    if (PARTICLE_INTERJ.has(t0.lower) && I.particleNext.has(next.lower)) return;
    if (t0.lower === 'здравствуй' || t0.lower === 'здравствуйте') {
      if (!(X.address.adjectives.has(next.lower) || X.address.nouns.has(next.lower) || isPersonName(next))) return;
    }
    if (nounParses(t0).length && !I.sure.has(t0.lower) && !['ах', 'ох', 'эх', 'ой', 'ай', 'ух', 'увы', 'боже', 'господи', 'ужас', 'кошмар', 'батюшки', 'матушки', 'чёрт', 'черт', 'блин'].includes(t0.lower)) return;
    out.push(commaAfter(ctx, t0, next, {
      ruleId: 'punct.interjection', confidence: I.sure.has(t0.lower) ? 'sure' : 'check', ref: [157], manualRef: ['pm-interj-comma', 'pm-interj-particles'],
      why: `Междометие «${t0.text}» в начале предложения отделяется запятой (при сильном чувстве — восклицательным знаком). Если это усилительная частица («ах ты», «ох уж»), запятая не нужна.`,
    }));
    return;
  }
  if (t0.lower === 'да') {
    if (I.yesSkip.has(next.lower)) return;
    if (!I.yesNext.has(next.lower) && !isPerson12(next)) return;
    out.push(commaAfter(ctx, t0, next, {
      ruleId: 'punct.yes-no', confidence: 'check', ref: [158], manualRef: ['pm-yes-no'],
      why: 'Если «да» здесь — слово-утверждение (ответ), после него ставится запятая или восклицательный знак; союз или частица «да» запятой не отделяется.',
    }));
    return;
  }
  if (t0.lower === 'нет') {
    if (I.noSkip.has(next.lower)) return;
    if (nounCases(next).has('gent') && !PERSONAL.has(next.lower)) return;
    if (!I.noNext.has(next.lower) && !isPerson12(next)) return;
    out.push(commaAfter(ctx, t0, next, {
      ruleId: 'punct.yes-no', confidence: 'check', ref: [158], manualRef: ['pm-yes-no'],
      why: 'Если «нет» здесь — слово-отрицание (ответ), после него ставится запятая или восклицательный знак; сказуемое «нет» («нет времени») запятой не отделяется.',
    }));
    return;
  }
  if (t0.lower === 'что' && (next.lower === 'ж' || next.lower === 'же') && words.length >= 3) {
    const third = ctx.tokens[words[2]];
    if (!adjacentTokens(ctx, next, third)) return;
    if (!I.chtoZhNext.has(third.lower) && !isPerson12(third)) return;
    if (sentenceEndsWith(ctx, sentence, ['?'])) return;
    out.push(commaAfter(ctx, next, third, {
      ruleId: 'punct.yes-no', confidence: 'check', ref: [158], manualRef: ['pm-chto-zh'],
      why: `«Что ${next.text}» в значении согласия или вывода отделяется запятой; в вопросе («что же ты наделал») запятая не нужна.`,
    }));
  }
}

/* ---------- 7. direct speech ---------- */

function speechVerbTok(tok, X) {
  if (!tok || tok.type !== 'word') return false;
  const lemmas = lemmasOf(tok, 'VERB');
  if (!lemmas.size) return false;
  for (const l of lemmas) if (X.speech.titleVerbs.has(l) && !X.speech.verbs.has(l)) return false;
  for (const l of lemmas) if (X.speech.verbs.has(l)) return true;
  return false;
}

function directSpeech(ctx, X, out) {
  const text = ctx.text;
  const spans = ctx.quotes;
  if (!spans.length) return;
  for (const [s, e] of spans) {
    if (spans.some(([s2, e2]) => s2 < s && e <= e2)) continue; // nested quotes are titles
    const openCh = text[s];
    const closeCh = text[e - 1];
    const inner = text.slice(s + 1, e - 1).trim();
    if (!inner) continue;
    const innerWords = inner.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const innerCapital = /^[А-ЯЁ]/.test(inner);
    const innerEndsExcl = /[!?…]$/.test(inner) || /\.\.\.$/.test(inner);
    const strong = innerCapital && (innerWords >= 2 || innerEndsExcl);
    // (1) author words before the speech: «Он сказал «Пора идти»» → colon
    const prev = ctx.prevTokenBefore(s);
    if (prev && innerCapital) {
      const wordBefore = prev.type === 'word' ? prev : (prev.type === 'punct' && prev.text === ',' ? ctx.prevTokenBefore(prev.start) : null);
      if (wordBefore && wordBefore.type === 'word' && wordBefore.end <= s) {
        let verbTok = null;
        let t = wordBefore;
        for (let d = 0; d < 3 && t && t.type === 'word'; d++) {
          if (speechVerbTok(t, X)) { verbTok = t; break; }
          const pt = ctx.prevTokenBefore(t.start);
          if (!pt || pt.type !== 'word') break;
          t = pt;
        }
        if (verbTok && !(verbTok === wordBefore && hasPos(verbTok, 'INFN') && !isFiniteVerb(verbTok))) {
          const start = prev.start;
          const before = text.slice(start, s + 1);
          const after = prev.type === 'word' ? `${prev.text}:${text.slice(prev.end, s)}${openCh}` : `:${text.slice(prev.end, s)}${openCh}`;
          // narrative speech is past tense; present tense («сервер отвечает «Ошибка»») is often not speech at all
          const pastTense = parsesOf(verbTok).some((p) => p.tag.POS === 'VERB' && p.tag.TEns === 'past');
          if (after !== before) {
            out.push(makeIssue({
              para: ctx.para, start, end: s + 1, category: 'punctuation', ruleId: 'punct.speech-colon', before, after,
              confidence: strong && pastTense ? 'sure' : 'check', ref: [163, 196], manualRef: ['pm-speech-author-before'],
              why: 'Слова автора стоят перед прямой речью: после них ставится двоеточие, а прямая речь берётся в кавычки и начинается с прописной буквы.',
              meta: { kind: 'colon' },
            }));
          }
        }
      }
    }
    // (2) author words after the speech: «Пора идти» сказал он → «Пора идти», — сказал он
    const m = /^([  ]*)(,?)([  ]*)([—–-]?)([  ]*)/.exec(text.slice(e));
    const nextTok = ctx.nextTokenFrom(e + m[0].length);
    if (!nextTok || nextTok.type !== 'word' || nextTok.start !== e + m[0].length) continue;
    let author = speechVerbTok(nextTok, X) && (isFiniteVerb(nextTok) || hasPos(nextTok, 'VERB'));
    if (!author && (X.speech.authorPronouns.has(nextTok.lower) || isPersonName(nextTok))) {
      const n2 = ctx.nextWordFrom(nextTok.end);
      author = !!n2 && speechVerbTok(n2, X) && hasPos(n2, 'VERB');
    }
    if (!author) continue;
    if (!innerCapital && !innerEndsExcl) continue;
    if (innerWords === 1 && !innerEndsExcl) {
      // a single quoted noun («файл «Презентации» отвечает 403») is a title, not speech; «Да», «Иди» are speech
      const w = inner.replace(/[^\p{L}\p{N}-]/gu, '');
      if (w && morph.dictParses(w).some((p) => p.tag.POS === 'NOUN')) continue;
    }
    const wantComma = !innerEndsExcl;
    let start = e - 1;
    let after;
    const spaceBefore = m[4] ? (m[3] || m[1] || NBSP) : NBSP;
    const spaceAfter = m[4] ? (m[5] || ' ') : ' ';
    if (inner.endsWith(',') || inner.endsWith('.')) {
      start = e - 2; // the mark inside the quotes moves out (comma) or disappears (period)
      after = `${closeCh},${spaceBefore}${EM}${spaceAfter}`;
    } else {
      after = `${closeCh}${wantComma ? ',' : ''}${spaceBefore}${EM}${spaceAfter}`;
    }
    const before = text.slice(start, nextTok.start);
    if (before === after) continue;
    if (before.replace(/[  ]+/g, ' ') === after.replace(/[  ]+/g, ' ')) continue; // only the kind of space differs
    out.push(makeIssue({
      para: ctx.para, start, end: nextTok.start, category: 'punctuation', ruleId: 'punct.speech-after', before, after,
      confidence: strong ? 'sure' : 'check', ref: [196, 199], manualRef: ['pm-speech-author-after'],
      why: wantComma
        ? 'Слова автора идут после прямой речи: после закрывающей кавычки ставятся запятая и тире («…», — сказал он).'
        : 'После прямой речи с вопросительным или восклицательным знаком внутри кавычек ставится только тире, без запятой («…?» — спросил он).',
      meta: { kind: 'speech-after' },
    }));
  }
}

/* ---------- 8. gerunds and participles ---------- */

function gerundBoundary(ctx, sentence, fromWi, maxWords) {
  const words = sentence.words;
  for (let k = fromWi; k < words.length && k < fromWi + maxWords; k++) {
    const tok = ctx.tokens[words[k]];
    if (!adjacentTokens(ctx, ctx.tokens[words[k - 1]], tok)) return { kind: 'punct', k };
    if (PERSONAL.has(tok.lower)) return { kind: 'pronoun', k };
    if (isFiniteVerb(tok) && !hasPos(tok, 'GRND')) return { kind: 'verb', k };
    if (isNomOnlyNoun(tok) && !hasPos(tok, 'GRND')) return { kind: 'noun', k };
    if (COORD.has(tok.lower) && tok.lower !== 'не') return { kind: 'conj', k };
  }
  return null;
}

function gerundStart(ctx, sentence, X, out) {
  if (!startsSentence(sentence)) return;
  const words = sentence.words;
  if (words.length < 3) return;
  let gi = 0;
  let t0 = ctx.tokens[words[0]];
  if (t0.lower === 'не') { gi = 1; t0 = ctx.tokens[words[1]]; if (X.gerund.adverbs.has(`не ${t0.lower}`) || X.gerund.adverbs.has(t0.lower)) return; }
  if (!isGerund(t0, X) || ctx.inSkip(t0.start, t0.end)) return;
  if (matchSeq(ctx, sentence, gi, X.gerund.idioms)) return;
  const b = gerundBoundary(ctx, sentence, gi + 1, 9);
  if (!b || b.kind === 'punct' || b.kind === 'conj') return;
  const prev = ctx.tokens[words[b.k - 1]];
  const bt = ctx.tokens[words[b.k]];
  out.push(commaAfter(ctx, prev, bt, {
    ruleId: 'punct.gerund', confidence: b.kind === 'pronoun' ? 'sure' : 'check', ref: [153], manualRef: ['pm-isolated-adverbial-gerund'],
    why: `Деепричастный оборот «${ctx.text.slice(ctx.tokens[words[0]].start, prev.end)}» в начале предложения отделяется запятой.`,
  }));
}

function gerundMid(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (!isGerund(tok, X)) return;
  const prev = ctx.tokens[words[wi - 1]];
  if (!adjacentTokens(ctx, prev, tok)) return; // comma or other mark already before
  if (prev.lower === 'не') return; // «не спеша» and similar are handled by the adverb list; other «не + gerund» need the comma before «не» — skip for safety
  if (COORD.has(prev.lower) || DASH_BREAKERS.has(prev.lower) || hasPos(prev, 'GRND') || hasPos(prev, 'PREP')) return;
  if (prev.allCaps || prev.type !== 'word' || isNumeral(prev) || tok.text.length < 4) return; // «ТРИ пуша» — an unknown noun form parsed as a gerund
  if (matchSeq(ctx, sentence, wi, X.gerund.idioms)) return;
  if (ctx.inSkip(tok.start, tok.end)) return;
  const b = gerundBoundary(ctx, sentence, wi + 1, 8);
  const why = `Деепричастный оборот («${tok.text}…») выделяется запятыми с обеих сторон.`;
  if (b && b.kind === 'verb' && b.k - wi <= 5) {
    const close = ctx.tokens[words[b.k]];
    const closePrev = ctx.tokens[words[b.k - 1]];
    const gap1 = ctx.text.slice(prev.end, tok.start);
    const middle = ctx.text.slice(tok.start, closePrev.end);
    const gap2 = ctx.text.slice(closePrev.end, close.start);
    out.push(makeIssue({
      para: ctx.para, start: prev.start, end: close.end, category: 'punctuation', ruleId: 'punct.gerund',
      before: ctx.text.slice(prev.start, close.end), after: `${prev.text},${gap1}${middle},${gap2}${close.text}`,
      confidence: 'check', ref: [153], manualRef: ['pm-isolated-adverbial-gerund'], why, meta: { kind: 'wrap' },
    }));
    return;
  }
  if (b && (b.kind === 'pronoun' || b.kind === 'noun')) return; // the gerund belongs to a following clause we cannot delimit
  out.push(commaAfter(ctx, prev, tok, { ruleId: 'punct.gerund', confidence: 'check', ref: [153], manualRef: ['pm-isolated-adverbial-gerund'], why }));
}

function participleAfterNoun(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (!isParticiple(tok)) return;
  const prev = ctx.tokens[words[wi - 1]];
  if (!adjacentTokens(ctx, prev, tok)) return;
  if (!nounParses(prev).length || !agrees(prev, tok, 'PRTF')) return;
  if (ctx.inSkip(tok.start, tok.end)) return;
  const next = ctx.tokens[words[wi + 1]];
  if (!next || !adjacentTokens(ctx, tok, next)) return; // single participle without dependents, or already delimited
  if (nounParses(next).length && agrees(next, tok, 'PRTF')) return; // «у дома стоящего человека» — modifies the next noun
  if (isVerbLike(next) || COORD.has(next.lower)) return;
  const b = gerundBoundary(ctx, sentence, wi + 1, 8);
  const why = `Причастный оборот «${tok.text}…» стоит после определяемого слова «${prev.text}» — он выделяется запятыми с обеих сторон.`;
  if (b && b.kind === 'verb' && b.k - wi <= 6) {
    const close = ctx.tokens[words[b.k]];
    const closePrev = ctx.tokens[words[b.k - 1]];
    const gap1 = ctx.text.slice(prev.end, tok.start);
    const middle = ctx.text.slice(tok.start, closePrev.end);
    const gap2 = ctx.text.slice(closePrev.end, close.start);
    out.push(makeIssue({
      para: ctx.para, start: prev.start, end: close.end, category: 'punctuation', ruleId: 'punct.participle',
      before: ctx.text.slice(prev.start, close.end), after: `${prev.text},${gap1}${middle},${gap2}${close.text}`,
      confidence: 'check', ref: [151], manualRef: ['pm-isolated-def-after-noun'], why, meta: { kind: 'wrap' },
    }));
    return;
  }
  if (b && (b.kind === 'pronoun' || b.kind === 'noun')) return;
  out.push(commaAfter(ctx, prev, tok, { ruleId: 'punct.participle', confidence: 'check', ref: [151], manualRef: ['pm-isolated-def-after-noun'], why }));
}

/* ---------- 9. «кроме», «помимо», «включая» … ---------- */

function isolatedObject(ctx, sentence, wi, X, out) {
  const words = sentence.words;
  const len = matchSeq(ctx, sentence, wi, X.isolatedObject.words);
  if (!len) return;
  const tok = ctx.tokens[words[wi]];
  const last = ctx.tokens[words[wi + len - 1]];
  const prev = ctx.tokens[words[wi - 1]];
  if (!adjacentTokens(ctx, prev, tok)) return;
  if (COORD.has(prev.lower) || ['как', 'что', 'чем'].includes(prev.lower)) return;
  const next = ctx.tokens[words[wi + len]];
  if (!next || !adjacentTokens(ctx, last, next)) return;
  if (X.isolatedObject.nextSkip.has(next.lower)) return;
  if (ctx.inSkip(tok.start, tok.end)) return;
  const phrase = ctx.text.slice(tok.start, last.end);
  out.push(commaAfter(ctx, prev, tok, {
    ruleId: 'punct.isolated-object', confidence: 'check', ref: [154], manualRef: ['pm-isolated-object'],
    why: `Оборот с «${phrase}» (значение включения или исключения) обычно выделяется запятыми с обеих сторон.`,
  }));
}

/* ---------- 10. compound sentence: «…, и он …» ---------- */

const CLAUSE_OPENERS = new Set(['что', 'кто', 'который', 'которая', 'которое', 'которые', 'которого', 'которую', 'которым', 'которой', 'которых', 'где', 'когда', 'как', 'почему', 'зачем', 'чей', 'если', 'чтобы', 'чтоб', 'пока', 'хотя', 'куда', 'откуда', 'сколько', 'пусть', 'пускай', 'будто', 'словно', 'ибо', 'поскольку', 'едва', 'лишь', 'чем', 'какой', 'какая', 'какое', 'какие', 'кем', 'кого', 'кому', 'чего', 'чему', 'чём', 'ли', 'раз', 'коли', 'ежели', 'дабы']);
const AND_SKIP_AFTER = new Set(['потом', 'затем', 'тогда', 'тут', 'там', 'вот', 'вдруг', 'сразу', 'уже', 'ещё', 'еще', 'даже', 'только', 'всё', 'все', 'снова', 'опять', 'теперь', 'сейчас', 'здесь', 'тоже', 'также', 'поэтому', 'потому', 'значит', 'наконец', 'вообще', 'главное', 'правда', 'конечно', 'вроде', 'как-то', 'однажды', 'скоро', 'вскоре', 'вечером', 'утром', 'ночью', 'днём', 'днем', 'завтра', 'вчера', 'сегодня', 'иногда', 'часто', 'редко', 'всегда', 'никогда', 'обычно', 'внезапно', 'неожиданно', 'немедленно', 'быстро', 'медленно', 'тихо', 'громко', 'весело', 'грустно', 'хорошо', 'плохо', 'совсем', 'почти', 'просто', 'именно', 'пусть', 'пускай']);
const PRED_SKIP = new Set(['не', 'уже', 'ещё', 'еще', 'тоже', 'также', 'сразу', 'потом', 'затем', 'тогда', 'снова', 'опять', 'всё', 'все', 'очень', 'совсем', 'почти', 'просто', 'даже', 'только', 'вдруг', 'тут', 'там', 'уж', 'же', 'ли', 'бы', 'б', 'сам', 'сама', 'сами', 'само', 'вот', 'так', 'как-то', 'быстро', 'тихо', 'внезапно', 'долго', 'немного', 'много', 'мало', 'лишь', 'тоже', 'конечно', 'наверное', 'кажется', 'вообще', 'никак', 'никогда', 'всегда', 'часто', 'иногда', 'обычно', 'редко', 'наконец', 'спокойно', 'медленно', 'громко', 'молча', 'сейчас', 'теперь', 'сегодня', 'завтра', 'вчера',
  'мне', 'тебе', 'ему', 'ей', 'нам', 'вам', 'им', 'меня', 'тебя', 'его', 'её', 'ее', 'нас', 'вас', 'их', 'себе', 'себя', 'мной', 'тобой', 'ним', 'ней', 'ними', 'нему', 'нею', 'всем', 'всех', 'это', 'этого', 'этому', 'этим', 'того', 'тому', 'тем', 'туда', 'сюда', 'оттуда', 'домой', 'здесь', 'дома',
  'давно', 'постоянно', 'впервые', 'наверняка', 'действительно', 'вместе', 'сначала', 'потихоньку', 'тихонько', 'прямо', 'ещё', 'еле', 'едва', 'почему-то', 'зачем-то', 'как-то', 'куда-то', 'где-то', 'точно', 'явно', 'честно', 'искренне', 'серьёзно', 'серьезно', 'вроде', 'типа', 'реально', 'буквально', 'окончательно', 'полностью', 'слегка', 'чуть', 'резко', 'сильно', 'ужасно', 'страшно', 'жутко', 'дико']);

/** Word and number tokens of the segment ending right before token `tok`, back to the previous punctuation mark (nearest first reversed to text order). */
function segmentBefore(ctx, tok, max) {
  const out = [];
  for (let i = tok.i - 1; i >= 0 && out.length <= max; i--) {
    const t = ctx.tokens[i];
    if (t.type === 'space') continue;
    if (t.si !== tok.si || t.type === 'punct') break;
    out.unshift(t);
  }
  return out;
}
const PRONOUN_AGREE = { 'я': { per: '1per', nmbr: 'sing' }, 'ты': { per: '2per', nmbr: 'sing' }, 'он': { per: '3per', nmbr: 'sing', gndr: 'masc' }, 'она': { per: '3per', nmbr: 'sing', gndr: 'femn' }, 'оно': { per: '3per', nmbr: 'sing', gndr: 'neut' }, 'мы': { per: '1per', nmbr: 'plur' }, 'вы': { per: '2per', nmbr: 'plur' }, 'они': { per: '3per', nmbr: 'plur' } };

/** Finite verb (or short predicate) at sentence word index k that agrees with the subject features; returns the token or null. */
function agreeingPredicate(ctx, sentence, k, feat) {
  const words = sentence.words;
  let seen = 0;
  for (let j = k; j < words.length && seen < 5; j++, seen++) {
    const t = ctx.tokens[words[j]];
    if (j > k && !adjacentTokens(ctx, ctx.tokens[words[j - 1]], t)) return null;
    if (PRED_SKIP.has(t.lower)) continue;
    const ps = parsesOf(t);
    if (!ps.length) return null;
    // adverbs, particles, object pronouns, predicative modifiers («я один», «он сам») and infinitives before the finite verb
    // («я даже лезть не буду», «они периодически задумывались») are stepped over
    if (isAdverbial(t) || (hasPos(t, 'NPRO') && !PERSONAL.has(t.lower)) || isAdjOnly(t) || hasPos(t, 'NUMR') || ps.every((p) => p.tag.POS === 'INFN')) continue;
    const verbs = ps.filter((p) => p.tag.POS === 'VERB');
    if (verbs.length && (verbs.length === ps.length || verbs.some((p) => p.score >= 0.5))) {
      const ok = verbs.some((p) => {
        if (p.tag.impr || p.tag.MOOd === 'impr') return false;
        if (feat.nmbr && p.tag.NMbr && p.tag.NMbr !== feat.nmbr) return false;
        if (p.tag.TEns === 'past') return !(feat.gndr && p.tag.NMbr === 'sing' && p.tag.GNdr && p.tag.GNdr !== feat.gndr);
        if (feat.per && p.tag.PErs && p.tag.PErs !== feat.per) return false;
        return true;
      });
      return ok ? { tok: t, kind: 'verb' } : null;
    }
    if (ps.every((p) => ['ADJS', 'PRTS', 'PRED'].includes(p.tag.POS))) return { tok: t, kind: 'short' }; // «и он рад», «и всё было решено»
    return null;
  }
  return null;
}

const INDEF_SUBJECTS = {
  'никто': { nmbr: 'sing', gndr: 'masc', per: '3per' }, 'ничто': { nmbr: 'sing', gndr: 'neut', per: '3per' }, 'кто-то': { nmbr: 'sing', gndr: 'masc', per: '3per' },
  'что-то': { nmbr: 'sing', gndr: 'neut', per: '3per' }, 'кто-нибудь': { nmbr: 'sing', gndr: 'masc', per: '3per' }, 'кое-кто': { nmbr: 'sing', gndr: 'masc', per: '3per' },
  'все': { nmbr: 'plur', per: '3per' }, 'всё': { nmbr: 'sing', gndr: 'neut', per: '3per' }, 'каждый': { nmbr: 'sing', gndr: 'masc', per: '3per' },
  'многие': { nmbr: 'plur', per: '3per' }, 'некоторые': { nmbr: 'plur', per: '3per' }, 'остальные': { nmbr: 'plur', per: '3per' },
};

/** Subject right after «и» at sentence word index k: personal pronoun, «это», indefinite pronoun, nominative-only noun (with one modifier) or a capitalised name. */
function subjectAt(ctx, sentence, k) {
  const words = sentence.words;
  const t = ctx.tokens[words[k]];
  if (!t) return null;
  if (PERSONAL.has(t.lower)) return { end: k, feat: PRONOUN_AGREE[t.lower], kind: 'pronoun' };
  if (t.lower === 'это') return { end: k, feat: { nmbr: 'sing', gndr: 'neut', per: '3per' }, kind: 'eto' };
  if (INDEF_SUBJECTS[t.lower]) return { end: k, feat: INDEF_SUBJECTS[t.lower], kind: 'indef' };
  if (t.type !== 'word' || hasPos(t, 'PREP') || hasPos(t, 'CONJ') || hasPos(t, 'PRCL')) return null;
  let i = k;
  let head = t;
  const next = ctx.tokens[words[k + 1]];
  if (next && adjacentTokens(ctx, t, next) && isAdjOnly(t) && nounParses(next).length && agrees(next, t, 'ADJF')) { i = k + 1; head = next; }
  if (isProperNom(head) || (isNomOnlyNoun(head) && !hasPos(head, 'ADVB') && !isVerbLike(head))) {
    const feat = { per: '3per' };
    const ns = nounParses(head).filter((p) => p.tag.CAse === 'nomn');
    if (ns.length) { feat.nmbr = ns[0].tag.NMbr; if (ns[0].tag.NMbr === 'sing') feat.gndr = ns[0].tag.GNdr; }
    return { end: i, feat, kind: 'noun' };
  }
  return null;
}

/** Number and (singular) gender of a subject token (personal pronoun or noun), or null. */
function subjectFeat(tok) {
  if (PRONOUN_AGREE[tok.lower]) return PRONOUN_AGREE[tok.lower];
  const ns = nounParses(tok).filter((p) => p.tag.CAse === 'nomn');
  return ns.length ? { nmbr: ns[0].tag.NMbr, gndr: ns[0].tag.NMbr === 'sing' ? ns[0].tag.GNdr : undefined } : null;
}

/**
 * «и начнётся революция»: finite verb at word index k, then (after up to two modifiers) a nominative-only noun that agrees with it.
 * A transitive verb that agrees with `leftFeat` (the subject of the left part) is taken as a homogeneous predicate
 * («студенты читают лекции и делают задания»); an intransitive one followed by a nominative-only noun has its own subject.
 */
function invertedClause(ctx, sentence, k, leftFeat) {
  const words = sentence.words;
  const v = ctx.tokens[words[k]];
  if (!v || !leftFeat || !isFiniteVerbStrict(v) || isImperative(v)) return null;
  const vp = parsesOf(v).filter((p) => p.tag.POS === 'VERB');
  if (!vp.length || vp.some((p) => p.tag.PErs === '1per' || p.tag.PErs === '2per')) return null;
  const agreesLeft = vp.some((p) => (!p.tag.NMbr || p.tag.NMbr === leftFeat.nmbr) && !(p.tag.TEns === 'past' && p.tag.NMbr === 'sing' && p.tag.GNdr && leftFeat.gndr && p.tag.GNdr !== leftFeat.gndr));
  const intransitive = vp.every((p) => p.tag.TRns === 'intr');
  if (agreesLeft && !intransitive) return null;
  for (let j = k + 1; j <= k + 3 && j < words.length; j++) {
    const t = ctx.tokens[words[j]];
    if (!adjacentTokens(ctx, ctx.tokens[words[j - 1]], t)) return null;
    if (isAdjOnly(t)) continue;
    if (!isNomOnlyNoun(t) || hasPos(t, 'ADVB') || isVerbLike(t)) return null;
    const ns = nounParses(t).filter((p) => p.tag.CAse === 'nomn');
    const ok = vp.some((p) => (!p.tag.NMbr || p.tag.NMbr === ns[0].tag.NMbr) && !(p.tag.TEns === 'past' && p.tag.NMbr === 'sing' && p.tag.GNdr && ns[0].tag.GNdr && p.tag.GNdr !== ns[0].tag.GNdr));
    return ok ? { subj: { end: j, feat: {}, kind: 'noun' }, pred: { tok: v, kind: 'verb' } } : null;
  }
  return null;
}

/**
 * «Поговорила с директором и он обещал позвонить» → «директором, и он обещал»: «и» joins two clauses with their own
 * subjects — a compound sentence (§ 137). Left part: a clause with a finite verb that is not a subordinate clause
 * sharing its conjunction with the right part («когда он пришёл и мы сели»). Right part: subject + agreeing predicate.
 * Questions and exclamations are skipped (§ 137 note: «Кто ты и что тебе нужно?»).
 */
function compoundAnd(ctx, sentence, wi, out) {
  const words = sentence.words;
  const tok = ctx.tokens[words[wi]];
  if (tok.lower !== 'и' || tok.cap) return;
  const prev = ctx.prevTokenBefore(tok.start);
  if (!prev || prev.si !== tok.si || (prev.type !== 'word' && prev.type !== 'num')) return; // a mark already stands before «и»
  if (COORD.has(prev.lower) || prev.lower === 'как' || prev.lower === 'так' || prev.lower === 'также' || prev.lower === 'тоже') return;
  if (sentenceEndsWith(ctx, sentence, ['?', '!'])) return;
  // left clause: back to the previous mark (numbers count as words: «мне было 16 и я…»); must contain a finite verb and must not open with a subordinator
  const left = segmentBefore(ctx, tok, 30);
  if (!left.length || left.length > 30) return;
  const leftStart = left[0];
  if (CLAUSE_OPENERS.has(leftStart.lower) || leftStart.lower === 'и' || leftStart.lower === 'ни') return;
  if (left.some((t) => CLAUSE_OPENERS.has(t.lower) && t !== leftStart && ['кто', 'что', 'который', 'которые', 'которая', 'которое', 'где', 'когда', 'если', 'чтобы', 'пока', 'хотя', 'как'].includes(t.lower))) return; // a subordinate clause without its comma inside the left part — too unclear
  const leftVerb = left.find((t) => isFiniteVerb(t) && !hasPos(t, 'GRND')); // an imperative counts too: «положите смартфон в коробку, и ваша девушка не сможет…»
  if (!leftVerb) return;
  if (left.some((t) => t.lower === 'и' || t.lower === 'ни') && !PERSONAL.has(left[0].lower)) return; // «и X и Y» rows / repeated conjunctions — leave to the repeated-conjunction rule
  // right clause: [adverb] subject + predicate
  let k = wi + 1;
  let first = ctx.tokens[words[k]];
  if (!first || !adjacentTokens(ctx, tok, first)) return;
  let adverbBefore = false;
  if (AND_SKIP_AFTER.has(first.lower)) { adverbBefore = true; k++; first = ctx.tokens[words[k]]; if (!first || !adjacentTokens(ctx, ctx.tokens[words[k - 1]], first)) return; }
  // «и вот в выходные я откопал», «и через час мы уехали» — one short prepositional phrase before the subject
  if (hasPos(first, 'PREP') && !nounParses(first).some((p) => p.score >= 0.05)) { // «в» also has zero-score noun readings
    for (let j = k + 1; j <= k + 3 && j < words.length; j++) {
      const t = ctx.tokens[words[j]];
      if (!adjacentTokens(ctx, ctx.tokens[words[j - 1]], t)) return;
      if (PERSONAL.has(t.lower) || INDEF_SUBJECTS[t.lower] || t.lower === 'это') { adverbBefore = true; k = j; first = t; break; }
      if (!(nounParses(t).length || isAdjOnly(t) || t.type === 'num')) return;
    }
    if (first !== ctx.tokens[words[k]]) return;
    if (!adverbBefore || k === wi + 1) return;
  }
  let subj = subjectAt(ctx, sentence, k);
  let pred = subj ? agreeingPredicate(ctx, sentence, subj.end + 1, subj.feat) : null;
  if (!subj && !adverbBefore) {
    // inversion: «и начнётся революция», «и наступила тишина», «и разгорится новая история» — finite verb, then a nominative-only noun.
    // Only when the left part has its own subject that does not agree with that verb: «веками бьются и трудятся люди»,
    // «студенты читают лекции и делают задания» are homogeneous predicates sharing one subject
    const leftSubj = left.find((t) => PERSONAL.has(t.lower) || isProperNom(t) || (isNomOnlyNoun(t) && !isVerbLike(t)));
    const inv = leftSubj ? invertedClause(ctx, sentence, k, subjectFeat(leftSubj)) : null;
    if (inv) { subj = inv.subj; pred = inv.pred; }
  }
  if (!subj || !pred) return;
  if (subj.kind === 'eto' && pred.kind !== 'verb' && !['было', 'будет', 'стало', 'значит', 'есть'].includes(pred.tok.lower)) return;
  // the same pronoun as the left subject right before the verb («он встал и он же сел») is fine, but «и» + object pronoun is not a subject — handled by PERSONAL (nominative forms only)
  const sure = subj.kind === 'pronoun' && !adverbBefore && pred.kind === 'verb' && subj.end + 1 < words.length && pred.tok.i === ctx.tokens[words[subj.end + 1]].i
    && left.length >= 2 && (PERSONAL.has(leftStart.lower) || left.some((t) => isNomOnlyNoun(t) || isProperNom(t)) || isFiniteVerb(leftStart));
  out.push(commaAfter(ctx, prev, tok, {
    ruleId: 'punct.comma-compound-and',
    confidence: sure ? 'sure' : 'check',
    ref: [137],
    manualRef: ['pm-ssp-comma', 'pm-ssp-no-comma'],
    why: `«И» соединяет два предложения со своими подлежащими («…${ctx.text.slice(tok.start, pred.tok.end)}…»): между частями сложносочинённого предложения ставится запятая. Запятая не нужна, если у частей есть общий второстепенный член («Вчера шёл дождь и дул ветер») или это однородные сказуемые.`,
    meta: { conj: 'и' },
  }));
}

/* ---------- entry point ---------- */

/**
 * Run the manual-derived checks for one paragraph; issues are appended to `out`.
 * @param {object} ctx paragraph context (context.js); needs ctx.rules.punctExtra and ctx.rules.conjCompiled
 * @param {object[]} out
 */
function check(ctx, out) {
  const X = ctx.rules.punctExtra;
  if (!X) return;
  const conj = ctx.rules.conjCompiled;
  for (const sentence of ctx.sentences) {
    if (!sentence.words.length) continue;
    dashIssues(ctx, sentence, X, out);
    addressStart(ctx, sentence, X, out);
    addressEnd(ctx, sentence, X, out);
    interjections(ctx, sentence, X, out);
    gerundStart(ctx, sentence, X, out);
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const tok = ctx.tokens[sentence.words[wi]];
      if (ctx.inSkip(tok.start, tok.end)) continue;
      generalizingColon(ctx, sentence, wi, X, out);
      repeatedConj(ctx, sentence, wi, X, out);
      doubleConj(ctx, sentence, wi, X, out);
      if (wi === 0) continue;
      generalizingDash(ctx, sentence, wi, X, out);
      compoundAnd(ctx, sentence, wi, out);
      kakIssue(ctx, sentence, wi, X, conj, out);
      gerundMid(ctx, sentence, wi, X, out);
      participleAfterNoun(ctx, sentence, wi, X, out);
      isolatedObject(ctx, sentence, wi, X, out);
    }
  }
  directSpeech(ctx, X, out);
}

module.exports = { check, compileExtra, isInfinitive };
