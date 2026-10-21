'use strict';

/**
 * Grammar: «в течении» → «в течение», «по приезду» → «по приезде»,
 * dative after «согласно/благодаря/вопреки», «оплатить за», «одеть/надеть»,
 * adjective–noun agreement in adjacent pairs.
 */

const morph = require('./morph');
const { makeIssue, matchCase, wordRegex } = require('./util');

const SRC_GOVERN = 'Розенталь · управление';
const SRC_AGREE = 'Розенталь · согласование определений';
const NUMERAL_WORDS = new Set(['два', 'две', 'три', 'четыре', 'оба', 'обе', 'полтора', 'полторы', 'пара', 'пару', 'пары', 'несколько', 'много', 'мало', 'сколько', 'столько', 'немного', 'большинство', 'множество', 'ряд', 'половина', 'треть', 'четверть', 'десяток', 'десятки', 'сотни', 'тысячи', 'миллионы']);
const DATIVE_PREPS = ['согласно', 'благодаря', 'вопреки', 'наперекор'];
const PRONOUN_LIKE = new Set(['его', 'её', 'ее', 'их', 'вас', 'нас', 'тебя', 'меня', 'всех', 'них', 'него', 'неё', 'нее', 'себя', 'этого', 'того', 'чего', 'кого']);

function vTechenii(ctx, out) {
  const g = ctx.rules.grammar;
  const timeLemmas = new Set(g.timeLemmas);
  const dets = new Set(g.timeDeterminers);
  const re = wordRegex('в (течении|продолжении|заключении)');
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    const kind = m[1].toLowerCase();
    const endPos = m.index + m[0].length;
    let fits = false;
    if (kind === 'заключении') {
      const w = ctx.nextWordFrom(endPos);
      if (w) {
        const ps = morph.dictParses(w.text);
        fits = ['хочу', 'хотел', 'хотела', 'хотелось', 'стоит', 'следует', 'можно', 'нужно', 'надо', 'скажу', 'отмечу', 'отметим', 'подчеркну', 'добавлю', 'хотим', 'хочется', 'я', 'мы'].includes(w.lower)
          || ps.some((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN' || p.tag.POS === 'GRND');
      }
    } else {
      let pos = endPos;
      for (let step = 0; step < 4 && !fits; step++) {
        const t = ctx.nextTokenFrom(pos);
        if (!t) break;
        if (t.type === 'num') { fits = true; break; }
        if (t.type !== 'word') break;
        if (timeLemmas.has(morph.lemma(t.text)) || timeLemmas.has(t.lower)) { fits = true; break; }
        if (dets.has(t.lower) || morph.dictParses(t.text).some((p) => ['ADJF', 'NUMR', 'PRTF'].includes(p.tag.POS))) { pos = t.end; continue; }
        break;
      }
    }
    if (!fits) continue;
    const after = matchCase(m[0], 'в ' + (kind === 'течении' ? 'течение' : kind === 'продолжении' ? 'продолжение' : 'заключение'));
    out.push(makeIssue({
      para: ctx.para, start: m.index, end: endPos, category: 'grammar', ruleId: 'gram.v-techenie',
      before: m[0], after, confidence: kind === 'заключении' ? 'check' : 'sure',
      why: kind === 'заключении'
        ? 'В значении «в конце, под конец» пишется «в заключение» (с «е»). «В заключении» — только о тюрьме или о тексте заключения.'
        : `Предлог «${after.toLowerCase()}» (о времени) пишется с «е» на конце. «В течении» — только о реке.`,
      ref: kind === 'заключении' ? [] : [47],
      source: kind === 'заключении' ? SRC_GOVERN : undefined,
    }));
  }
}

function poPrepositional(ctx, out) {
  const map = ctx.rules.grammar.poPrepositional;
  const keys = Object.keys(map).filter((k) => map[k]);
  const re = wordRegex(`по (${keys.join('|')})`);
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    const form = m[1].toLowerCase();
    const prev = ctx.prevWordBefore(m.index);
    if (form === 'окончанию' && prev && ['судить', 'судя', 'определить', 'определять', 'узнать', 'понять', 'видно', 'ударение', 'ударения'].includes(prev.lower)) continue;
    const after = matchCase(m[0], 'по ' + map[form]);
    out.push(makeIssue({
      para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'grammar', ruleId: 'gram.po-prepositional',
      before: m[0], after, confidence: 'sure',
      why: `Предлог «по» в значении «после чего-либо» требует предложного падежа: «${after.toLowerCase()}».`,
      ref: [], source: SRC_GOVERN,
    }));
  }
}

function dativeAfterPrep(ctx, out) {
  const re = wordRegex(`(${DATIVE_PREPS.join('|')})`);
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    const prep = m[1].toLowerCase();
    const w1 = ctx.nextWordFrom(m.index + m[0].length);
    if (!w1 || PRONOUN_LIKE.has(w1.lower)) continue;
    if (prep === 'благодаря') {
      const prevTok = ctx.prevTokenBefore(m.index);
      if (prevTok && prevTok.type === 'punct' && prevTok.text === ',') {
        // ", благодаря его" — likely gerund; pronoun objects already skipped
      }
    }
    // optional adjective then noun
    let adj = null;
    let noun = w1;
    let ps = morph.dictParses(noun.text);
    if (ps.length && ps.every((p) => p.tag.POS === 'ADJF' || p.tag.POS === 'PRTF')) {
      adj = noun;
      noun = ctx.nextWordFrom(adj.end);
      if (!noun) continue;
      ps = morph.dictParses(noun.text);
    }
    if (!ps.length || !ps.every((p) => p.tag.POS === 'NOUN')) continue;
    if (noun.cap) continue;
    if (!ps.every((p) => p.tag.CAse === 'gent')) continue; // only genitive readings → wrong case
    const nounParse = ps[0];
    const nounDat = nounParse.inflect(['datv', nounParse.tag.NMbr]);
    if (!nounDat) continue;
    let adjDat = null;
    if (adj) {
      const adjParse = morph.dictParses(adj.text)[0];
      const f = adjParse.inflect(nounDat.tag, ['GNdr', 'NMbr', 'CAse']);
      if (!f) continue;
      adjDat = matchCase(adj.text, String(f.word));
    }
    const start = adj ? adj.start : noun.start;
    const before = ctx.text.slice(start, noun.end);
    const after = (adj ? adjDat + ctx.text.slice(adj.end, noun.start) : '') + matchCase(noun.text, String(nounDat.word));
    if (after === before) continue;
    out.push(makeIssue({
      para: ctx.para, start, end: noun.end, category: 'grammar', ruleId: 'gram.datv-after-prep',
      before, after, confidence: 'check',
      why: `После «${prep}» ставится дательный падеж: «${prep} ${after.toLowerCase()}».`,
      ref: [], source: SRC_GOVERN,
    }));
  }
}

function oplatitZa(ctx, out) {
  const g = ctx.rules.grammar;
  const re = wordRegex(`(${g.oplatitForms.join('|')}) за`);
  const skip = new Set(g.oplatitSkipNext);
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w || skip.has(w.lower)) continue;
    if (/^\d/.test(ctx.text.slice(m.index + m[0].length).trim())) continue;
    out.push(makeIssue({
      para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'grammar', ruleId: 'gram.oplatit',
      before: m[0], after: m[1], confidence: 'sure',
      why: 'Глагол «оплатить» управляет винительным падежом без предлога: «оплатить проезд», но «заплатить за проезд».',
      ref: [], source: SRC_GOVERN,
    }));
  }
}

function odetNadet(ctx, out) {
  const g = ctx.rules.grammar;
  const clothes = new Set(g.clothes);
  const re = wordRegex(`(${g.odetForms.join('|')})`);
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    const w1 = ctx.nextWordFrom(m.index + m[0].length);
    if (!w1) continue;
    let fits = clothes.has(w1.lower);
    if (!fits) {
      const w2 = ctx.nextWordFrom(w1.end);
      fits = !!w2 && clothes.has(w2.lower) && clothes.has(w1.lower) === false && morph.dictParses(w1.text).some((p) => ['ADJF', 'PRTF', 'NPRO', 'NUMR'].includes(p.tag.POS));
      if (fits && !clothes.has(w2.lower)) fits = false;
    }
    if (!fits) continue;
    if (w1.lower === 'на') continue;
    const verb = m[1];
    const after = matchCase(verb, 'над' + verb.toLowerCase().slice(2));
    out.push(makeIssue({
      para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'grammar', ruleId: 'gram.odet-nadet',
      before: verb, after, confidence: 'check',
      why: 'Одежду надевают (на себя), а одевают кого-то: «надеть пальто», но «одеть ребёнка».',
      ref: [], source: SRC_GOVERN,
    }));
  }
}

function agreementPairs(ctx, out) {
  const { tokens } = ctx;
  for (let i = 0; i < tokens.length - 2; i++) {
    const adj = tokens[i];
    if (adj.type !== 'word' || adj.allCaps) continue;
    const sp = tokens[i + 1];
    if (sp.type !== 'space' || sp.text.length > 1) continue;
    const noun = tokens[i + 2];
    if (noun.type !== 'word' || noun.cap || noun.allCaps) continue;
    if (adj.cap && !ctx.isSentenceStart(i)) continue;
    if (ctx.inSkip(adj.start, noun.end)) continue;
    const prevTok = ctx.prevTokenBefore(adj.start);
    if (prevTok && (prevTok.type === 'num' || NUMERAL_WORDS.has(prevTok.lower) || morph.dictParses(prevTok.text).some((p) => p.tag.POS === 'NUMR'))) continue;
    const aps = morph.dictParses(adj.text);
    if (!aps.length || !aps.every((p) => (p.tag.POS === 'ADJF' || p.tag.POS === 'PRTF') && !p.tag.Apro && !p.tag.Anum)) continue;
    const nps = morph.dictParses(noun.text);
    if (!nps.length || !nps.every((p) => p.tag.POS === 'NOUN' && !p.tag.Name && !p.tag.Surn && !p.tag.Patr && !p.tag.Geox && !p.tag.Abbr)) continue;
    const agrees = aps.some((a) => nps.some((n) => {
      if (a.tag.NMbr !== n.tag.NMbr) return false;
      if (a.tag.CAse !== n.tag.CAse) return false;
      if (a.tag.CAse === 'accs' && a.tag.ANim && n.tag.ANim && a.tag.ANim !== n.tag.ANim) return false;
      if (a.tag.NMbr === 'sing' && a.tag.GNdr && n.tag.GNdr && a.tag.GNdr !== n.tag.GNdr) return false;
      return true;
    }));
    if (agrees) continue;
    // Unambiguous number mismatch or gender mismatch only (case-only mismatches are too noisy)
    const nNum = new Set(nps.map((p) => p.tag.NMbr));
    const aNum = new Set(aps.map((p) => p.tag.NMbr));
    const numberClash = nNum.size === 1 && aNum.size === 1 && [...nNum][0] !== [...aNum][0];
    const nGen = new Set(nps.map((p) => p.tag.GNdr).filter(Boolean));
    const aGen = new Set(aps.map((p) => p.tag.GNdr).filter(Boolean));
    const genderClash = [...nNum][0] === 'sing' && nGen.size === 1 && aGen.size >= 1 && !aGen.has([...nGen][0]) && aps.every((p) => p.tag.NMbr === 'sing');
    if (!numberClash && !genderClash) continue;
    const target = nps[0];
    const grams = target.tag.CAse === 'accs' ? ['GNdr', 'NMbr', 'CAse', 'ANim'] : ['GNdr', 'NMbr', 'CAse'];
    let f = aps[0].inflect(target.tag, grams);
    if (!f && target.tag.CAse === 'accs') f = aps[0].inflect(target.tag, ['GNdr', 'NMbr', 'CAse']);
    if (!f) continue;
    const after = matchCase(adj.text, String(f.word));
    if (after.toLowerCase() === adj.lower) continue;
    out.push(makeIssue({
      para: ctx.para, start: adj.start, end: adj.end, category: 'grammar', ruleId: 'gram.agreement',
      before: adj.text, after, confidence: 'check',
      alternatives: [],
      why: `Определение не согласовано с существительным «${noun.text}» в ${numberClash ? 'числе' : 'роде'}: «${after} ${noun.text}».`,
      ref: [], source: SRC_AGREE,
    }));
  }
}

/**
 * Run grammar checks for one paragraph.
 * @param {object} ctx
 * @returns {object[]}
 */
function check(ctx) {
  const out = [];
  vTechenii(ctx, out);
  poPrepositional(ctx, out);
  dativeAfterPrep(ctx, out);
  oplatitZa(ctx, out);
  odetNadet(ctx, out);
  agreementPairs(ctx, out);
  return out;
}

module.exports = { check };
