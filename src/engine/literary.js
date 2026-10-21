'use strict';

/**
 * Literary editing (style): clichés and bureaucratese from rules/kanc.json,
 * nominalisations with light verbs, «было принято решение», the «является»
 * copula, intensifiers, long sentences, passive voice, repeats; plus the
 * 0..10 score.
 */

const morph = require('./morph');
const repeats = require('./repeats');
const { buildContext } = require('./context');
const { makeIssue, matchCase, wordRegex, resolveOverlaps, applyIssues } = require('./util');

const SOURCE = 'Профиль: редакционная норма';
const LONG_WORDS = 30;
const LONG_CLAUSES = 3;
const WEIGHTS = { kanc: 0.6, long: 0.8, repeat: 0.4, passive: 0.4, intens: 0.3 };
const SCORE_LENGTH_FLOOR = 2000; // short texts are scored as if 2000 chars long
const METRIC_TITLES = [
  ['kanc', 'Канцелярит и штампы'],
  ['long', 'Длинные предложения'],
  ['repeat', 'Повторы рядом'],
  ['passive', 'Пассив и отглагольные'],
  ['intens', 'Слова-усилители'],
];
const RANK = { style: 2, repeat: 1 };
const BYT_FORMS = new Set(['был', 'была', 'было', 'были', 'будет', 'будут', 'быть', 'будучи']);
const CLAUSE_WORDS = new Set(['что', 'чтобы', 'чтоб', 'если', 'когда', 'где', 'куда', 'откуда', 'будто', 'словно', 'поскольку', 'потому', 'оттого', 'хотя', 'пока', 'ибо', 'дабы', 'ли', 'чем', 'который', 'которая', 'которое', 'которые', 'которого', 'которой', 'которому', 'которую', 'которым', 'которыми', 'которых', 'котором', 'какой', 'какая', 'какое', 'какие', 'каких', 'каким', 'кто', 'почему', 'зачем', 'насколько', 'сколько']);
const PARASITES = new Set(['как бы', 'типа', 'короче', 'по сути', 'в принципе', 'в общем-то', 'собственно', 'собственно говоря', 'так сказать', 'как говорится', 'по факту', 'по большому счёту', 'по большому счету', 'на самом деле', 'по идее', 'честно говоря', 'откровенно говоря']);

let warnedConds = new Set();

/* ---------- helpers ---------- */

function inflectWordTo(word, cas, posFilter) {
  for (const p of morph.dictParses(word)) {
    if (posFilter && !posFilter.includes(p.tag.POS)) continue;
    const f = p.inflect([cas, p.tag.NMbr].filter(Boolean));
    if (f) return String(f.word);
  }
  return null;
}

function shortNeuter(word) {
  for (const p of morph.dictParses(word)) {
    if (p.tag.POS !== 'ADJF') continue;
    const f = p.inflect({ POS: 'ADJS', GNdr: 'neut' });
    if (f) return String(f.word);
  }
  return null;
}

/**
 * Expand an `after` template of a kanc rule. Returns null when an inflection
 * placeholder cannot be resolved.
 */
function expandTemplate(tpl, m, rule) {
  let failed = false;
  let out = tpl.replace(/\{neg\}/g, () => (/^не\s/i.test(m[0]) ? 'не ' : ''));
  out = out.replace(/\{cut:([^}]*)\}/g, (_, s) => {
    const idx = m[0].toLowerCase().indexOf(s.toLowerCase());
    return idx === -1 ? m[0] : m[0].slice(0, idx) + m[0].slice(idx + s.length);
  });
  out = out.replace(/\{map:(\d)\}/g, (_, d) => {
    const key = (m[Number(d)] || '').toLowerCase();
    const v = rule.map && rule.map[key];
    if (v === undefined) failed = true;
    return v || '';
  });
  out = out.replace(/\{(\d):(\w+)\}/g, (_, d, how) => {
    const w = m[Number(d)];
    if (!w) { failed = true; return ''; }
    let r = null;
    if (how === 'short') r = shortNeuter(w);
    else r = inflectWordTo(w, how, ['NOUN', 'ADJF', 'NPRO']);
    if (!r) failed = true;
    return r || '';
  });
  out = out.replace(/\$(\d)/g, (_, d) => m[Number(d)] || '');
  return failed ? null : out;
}

/** Compute the fragment for deleting [s,e) with tidy spaces/commas. */
function deletion(ctx, s, e) {
  const text = ctx.text;
  const beforeM = /,[  ]*$/.exec(text.slice(0, s));
  if (beforeM && text[e] === ',') return { start: s - beforeM[0].length, end: e + 1, after: '' };
  const tokIdx = ctx.tokenAt(s);
  const atStart = tokIdx !== -1 && ctx.isSentenceStart(tokIdx);
  if (atStart) {
    const m = /^(,?[  ]+)(\p{L}[\p{L}-]*)/u.exec(text.slice(e));
    if (m) return { start: s, end: e + m[0].length, after: m[2][0].toUpperCase() + m[2].slice(1) };
  }
  const ws = /^[  ]+/.exec(text.slice(e));
  if (ws) return { start: s, end: e + ws[0].length, after: '' };
  const pre = /[  ]+$/.exec(text.slice(0, s));
  if (pre) return { start: s - pre[0].length, end: e, after: '' };
  return { start: s, end: e, after: '' };
}

function nounGenParse(tok) {
  const ps = morph.dictParses(tok.text);
  if (!ps.length || !ps.every((p) => p.tag.POS === 'NOUN')) return null;
  return ps.find((p) => p.tag.CAse === 'gent') || null;
}

/**
 * Collect «[adj]* noun» after position `pos` where all words have a parse in
 * case `cas`; returns the phrase inflected to `toCase` or null.
 */
function inflectPhrase(ctx, pos, cas, toCase, maxWords = 4) {
  const words = [];
  let p = pos;
  for (let k = 0; k < maxWords; k++) {
    const t = ctx.nextTokenFrom(p);
    if (!t || t.type !== 'word' || t.cap) break;
    const ps = morph.dictParses(t.text);
    if (!ps.length) break;
    const adj = ps.every((x) => x.tag.POS === 'ADJF' || x.tag.POS === 'PRTF') && ps.some((x) => x.tag.CAse === cas);
    const noun = ps.every((x) => x.tag.POS === 'NOUN') && ps.some((x) => x.tag.CAse === cas);
    if (adj) { words.push({ t, kind: 'adj' }); p = t.end; continue; }
    if (noun) { words.push({ t, kind: 'noun' }); break; }
    break;
  }
  if (!words.length || words[words.length - 1].kind !== 'noun') return null;
  const nounTok = words[words.length - 1].t;
  const nounParse = morph.dictParses(nounTok.text).find((x) => x.tag.CAse === cas);
  const nounNew = nounParse.inflect([toCase, nounParse.tag.NMbr]);
  if (!nounNew) return null;
  const parts = [];
  for (const w of words) {
    if (w.kind === 'noun') { parts.push(matchCase(w.t.text, String(nounNew.word))); break; }
    const ap = morph.dictParses(w.t.text).find((x) => x.tag.CAse === cas) || morph.dictParses(w.t.text)[0];
    const grams = toCase === 'accs' ? ['GNdr', 'NMbr', 'CAse', 'ANim'] : ['GNdr', 'NMbr', 'CAse'];
    let f = ap.inflect(nounNew.tag, grams);
    if (!f && toCase === 'accs') f = ap.inflect(nounNew.tag, ['GNdr', 'NMbr', 'CAse']);
    if (!f) return null;
    parts.push(matchCase(w.t.text, String(f.word)));
  }
  return { text: parts.join(' '), end: nounTok.end, start: words[0].t.start, nounTok, nounNew };
}

/* ---------- rules ---------- */

const KANC_CONDS = {
  dannyDeterminer(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w) return false;
    const ps = morph.dictParses(w.text);
    return ps.some((p) => ['NOUN', 'ADJF', 'PRTF'].includes(p.tag.POS)) && !ps.some((p) => p.tag.POS === 'VERB');
  },
  nextIsGen(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !!w && morph.dictParses(w.text).some((p) => p.tag.CAse === 'gent');
  },
  nextIsAblt(ctx, m) {
    const w = m[1] ? m[1] : null;
    return !!w && morph.dictParses(w).some((p) => p.tag.CAse === 'ablt' && p.tag.POS === 'NOUN');
  },
  nextIsAccs(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !!w && morph.dictParses(w.text).some((p) => p.tag.CAse === 'accs' || p.tag.CAse === 'nomn');
  },
  notAfterChto(ctx, m) {
    const prev = ctx.prevWordBefore(m.index);
    return !prev || prev.lower !== 'что';
  },
  notComposite() {
    return true;
  },
};

function kancRules(ctx, out) {
  for (const rule of ctx.rules.kancCompiled) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(ctx.text)) !== null) {
      if (rule.cond) {
        const fn = KANC_CONDS[rule.cond];
        if (!fn) {
          if (!warnedConds.has(rule.cond)) {
            warnedConds.add(rule.cond);
            console.warn(`[engine] unknown kanc condition "${rule.cond}" in ${rule.id}`);
          }
        } else if (!fn(ctx, m)) continue;
      }
      let start = m.index;
      let end = start + m[0].length;
      let after;
      if (rule.after === undefined) after = m[0];
      else if (rule.after === '') {
        const d = deletion(ctx, start, end);
        start = d.start; end = d.end; after = d.after;
      } else {
        const expanded = expandTemplate(rule.after, m, rule);
        after = expanded === null ? m[0] : (/^\p{L}/u.test(expanded) ? matchCase(m[0], expanded) : expanded);
      }
      const before = ctx.text.slice(start, end);
      out.push(makeIssue({
        para: ctx.para, start, end, category: 'style', ruleId: rule.id,
        before, after,
        alternatives: (rule.alternatives || []).map((a) => (typeof a === 'string' ? { text: a, note: '' } : a)),
        confidence: rule.confidence || 'check',
        why: rule.why, source: rule.source || SOURCE, ref: rule.ref || [], metric: 'kanc',
      }));
    }
  }
}

/** Light verb + nominalisation («осуществляем сбор вопросов» → «собираем вопросы»). */
function nominalAt(ctx, tok, forceInfinitive) {
  const nv = ctx.rules.nominal;
  const lightParse = morph.dictParses(tok.text).find((p) => p.tag.POS === 'VERB' || p.tag.POS === 'INFN');
  if (!lightParse) return null;
  const lemma = String(lightParse.normalize().word);
  let perfLemma = null;
  if (nv.verbs[lemma] !== undefined) perfLemma = lemma;
  else if (nv.impfToPerf.has(lemma)) perfLemma = nv.impfToPerf.get(lemma);
  if (!perfLemma) return null;
  const aspect = perfLemma === lemma ? 'perf' : 'impf';
  const noun = ctx.nextWordFrom(tok.end);
  if (!noun || noun.cap) return null;
  const nounParses = morph.dictParses(noun.text);
  if (!nounParses.length || !nounParses.some((p) => p.tag.POS === 'NOUN')) return null;
  const nounLemma = String(nounParses.find((p) => p.tag.POS === 'NOUN').normalize().word);
  const pair = nv.pairs.find((p) => p.noun === nounLemma && (p.with ? p.with.includes(perfLemma) : nv.generic.includes(perfLemma)));
  if (!pair) return null;
  const order = aspect === 'perf' ? [pair.perf, pair.impf] : [pair.impf, pair.perf];
  let verbForm = null;
  if (lightParse.tag.POS === 'INFN' || forceInfinitive) {
    verbForm = order.find(Boolean) || null;
  } else {
    for (const cand of order) {
      if (!cand) continue;
      const f = morph.inflectTo(cand, lightParse.tag, ['NMbr', 'PErs', 'TEns', 'MOOd', 'GNdr']);
      if (f) { verbForm = f; break; }
    }
  }
  if (!verbForm) return null;
  const obj = inflectPhrase(ctx, noun.end, 'gent', 'accs');
  const end = obj ? obj.end : noun.end;
  const text = matchCase(tok.text, verbForm) + (obj ? ' ' + obj.text : '');
  return { start: tok.start, end, after: text, noun: noun.text, verb: verbForm, lightLemma: lemma };
}

function nominalRules(ctx, out) {
  for (const sentence of ctx.sentences) {
    for (const i of sentence.words) {
      const tok = ctx.tokens[i];
      const r = nominalAt(ctx, tok, false);
      if (!r) continue;
      out.push(makeIssue({
        para: ctx.para, start: r.start, end: r.end, category: 'style', ruleId: 'style.nominal',
        before: ctx.text.slice(r.start, r.end), after: r.after, confidence: 'check',
        why: `Отглагольное существительное «${r.noun}» с глаголом «${r.lightLemma}» — канцелярит. Скажите глаголом: «${r.after}».`,
        source: SOURCE, ref: [], metric: 'kanc',
      }));
    }
  }
}

/** «[кем] было принято решение [осуществить проведение X]» → «мы решили провести X». */
function compositeDecision(ctx, out) {
  const re = /(?:(\p{L}+)[  ]+)?(было|была)[  ]+принято[  ]+решение/giu;
  let m;
  while ((m = re.exec(ctx.text)) !== null) {
    let start = m.index;
    let subjectTok = null;
    let subjectParse = null;
    if (m[1]) {
      const t = ctx.tokenAt(m.index);
      const tok = t !== -1 ? ctx.tokens[t] : null;
      const ps = tok ? morph.dictParses(tok.text) : [];
      subjectParse = ps.find((p) => p.tag.POS === 'NOUN' && p.tag.CAse === 'ablt');
      if (subjectParse && !tok.cap) subjectTok = tok;
      else start = m.index + m[1].length + (m[0].length - m[1].length - m[0].trimStart().length) ;
      if (!subjectTok) start = m.index + m[0].indexOf(m[2]);
    }
    const endDecision = m.index + m[0].length;
    let tail = '';
    let end = endDecision;
    const next = ctx.nextWordFrom(endDecision);
    if (next) {
      const nominal = nominalAt(ctx, next, true);
      if (nominal) { tail = nominal.after; end = nominal.end; }
      else if (morph.dictParses(next.text).some((p) => p.tag.POS === 'INFN')) { tail = next.text; end = next.end; }
    }
    const tailStr = tail ? ' ' + tail.toLowerCase() : '';
    const alternatives = [];
    let after;
    if (subjectTok) {
      const nom = subjectParse.inflect(['nomn', subjectParse.tag.NMbr]);
      const verb = morph.inflectGram('решить', ['past', subjectParse.tag.NMbr, ...(subjectParse.tag.NMbr === 'sing' ? [subjectParse.tag.GNdr] : [])].filter(Boolean), ['INFN', 'VERB']);
      after = `мы решили${tailStr}`;
      if (nom && verb) alternatives.push({ text: `${String(nom.word)} ${verb}${tailStr}`, note: 'с подлежащим' });
    } else {
      after = `решили${tailStr}`;
      alternatives.push({ text: `мы решили${tailStr}`, note: '' });
    }
    const before = ctx.text.slice(start, end);
    after = matchCase(before, after);
    out.push(makeIssue({
      para: ctx.para, start, end, category: 'style', ruleId: 'style.passive-decision',
      before, after, alternatives, confidence: 'check',
      why: 'Безличный пассив «было принято решение» прячет того, кто решил. Назовите действующее лицо и замените отглагольные существительные глаголами.',
      source: SOURCE, ref: [], metric: 'kanc',
    }));
  }
}

/** «X является важным инструментом» → «X — важный инструмент». */
function copulaRules(ctx, out) {
  for (const sentence of ctx.sentences) {
    for (const i of sentence.words) {
      const tok = ctx.tokens[i];
      let kind = null;
      let endVerb = tok.end;
      if (tok.lower === 'представляет' || tok.lower === 'представляют') {
        const n = ctx.nextWordFrom(tok.end);
        if (!n || n.lower !== 'собой') continue;
        kind = 'soboj';
        endVerb = n.end;
      } else {
        const ps = morph.dictParses(tok.text);
        const vp = ps.find((p) => p.tag.POS === 'VERB' && String(p.normalize().word) === 'являться');
        if (!vp) continue;
        kind = vp.tag.TEns === 'past' ? 'past' : 'pres';
        tok.verbParse = vp;
      }
      const prev = ctx.prevWordBefore(tok.start);
      if (prev && prev.lower === 'не') continue;
      const cas = kind === 'soboj' ? 'accs' : 'ablt';
      const phrase = inflectPhrase(ctx, endVerb, cas, 'nomn');
      if (!phrase) continue;
      let after;
      if (kind === 'past') {
        const t = tok.verbParse.tag;
        const byt = morph.inflectGram('быть', ['past', t.NMbr, ...(t.NMbr === 'sing' ? [t.GNdr] : [])].filter(Boolean), ['INFN', 'VERB']) || 'был';
        after = `${byt} ${ctx.text.slice(phrase.start, phrase.end)}`;
      } else {
        after = `— ${phrase.text}`;
      }
      out.push(makeIssue({
        para: ctx.para, start: tok.start, end: phrase.end, category: 'style', ruleId: 'style.copula',
        before: ctx.text.slice(tok.start, phrase.end), after, confidence: 'check',
        why: kind === 'past'
          ? 'Связка «являлся» — канцелярит: достаточно «был».'
          : `Связка «${kind === 'soboj' ? 'представляет собой' : 'является'}» — канцелярит: замените тире («встречи — важный инструмент») или перестройте фразу.`,
        source: SOURCE, ref: [164], metric: 'kanc',
      }));
    }
  }
}

function intensifierRules(ctx, out) {
  for (const item of ctx.rules.intensCompiled) {
    item.re.lastIndex = 0;
    let m;
    while ((m = item.re.exec(ctx.text)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      const tokIdx = ctx.tokenAt(s);
      if (tokIdx === -1) continue;
      const atStart = ctx.isSentenceStart(tokIdx);
      if (item.startOnly && !atStart) continue;
      const prev = ctx.prevWordBefore(s);
      const nextTok = ctx.nextTokenFrom(e);
      const nextWord = nextTok && nextTok.type === 'word' ? nextTok : null;
      if (item.skipIfPrev && prev && item.skipIfPrev.includes(prev.lower)) continue;
      if (item.skipIfNext && nextWord && item.skipIfNext.includes(nextWord.lower)) continue;
      if (item.skipIfNextPunct && (!nextTok || nextTok.type === 'punct')) continue;
      if (item.skipIfNextPos && nextWord && morph.dictParses(nextWord.text).some((p) => item.skipIfNextPos.includes(p.tag.POS))) continue;
      if (nextWord && (nextWord.lower === 'же' || nextWord.lower === 'ли') && !item.text.endsWith('же')) continue;
      const d = deletion(ctx, s, e);
      const parasite = PARASITES.has(item.text);
      out.push(makeIssue({
        para: ctx.para, start: d.start, end: d.end, category: 'style', ruleId: 'style.intensifier',
        before: ctx.text.slice(d.start, d.end), after: d.after, confidence: 'check',
        why: parasite
          ? `«${item.text}» — слово-паразит, его можно убрать без потери смысла.`
          : `Усилитель «${item.text}» не добавляет смысла — уберите или замените точным словом.`,
        source: SOURCE, ref: [], metric: 'intens', meta: { word: item.text },
      }));
    }
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function longSentences(ctx, out) {
  if (ctx.kind === 'h') return;
  for (const sentence of ctx.sentences) {
    const n = sentence.words.length;
    let clauses = 0;
    for (let wi = 1; wi < sentence.words.length; wi++) {
      const tok = ctx.tokens[sentence.words[wi]];
      if (!CLAUSE_WORDS.has(tok.lower)) continue;
      const prevTok = ctx.prevTokenBefore(tok.start);
      if (prevTok && prevTok.type === 'word' && (prevTok.lower === 'потому' || prevTok.lower === 'так' || prevTok.lower === 'оттого')) continue;
      clauses++;
    }
    if (n <= LONG_WORDS && clauses <= LONG_CLAUSES) continue;
    const text = ctx.text.slice(sentence.start, sentence.end);
    out.push(makeIssue({
      para: ctx.para, start: sentence.start, end: sentence.end, category: 'style', ruleId: 'style.long',
      before: text, after: text, confidence: 'check',
      why: `${n} ${plural(n, 'слово', 'слова', 'слов')}, ${clauses} ${plural(clauses, 'придаточное', 'придаточных', 'придаточных')} — разделите на 2–3 предложения.`,
      source: SOURCE, ref: [], metric: 'long', meta: { words: n, clauses },
    }));
  }
}

function passiveRules(ctx, out) {
  const reflexive = ctx.rules.passiveSet;
  for (const sentence of ctx.sentences) {
    for (const i of sentence.words) {
      const tok = ctx.tokens[i];
      const ps = morph.dictParses(tok.text);
      if (!ps.length) continue;
      if (ps.some((p) => p.tag.POS === 'PRTS')) {
        const prev = ctx.prevWordBefore(tok.start);
        const next = ctx.nextWordFrom(tok.end);
        const aux = prev && BYT_FORMS.has(prev.lower) ? prev : next && BYT_FORMS.has(next.lower) ? next : null;
        if (!aux) continue;
        const start = Math.min(aux.start, tok.start);
        const end = Math.max(aux.end, tok.end);
        const text = ctx.text.slice(start, end);
        out.push(makeIssue({
          para: ctx.para, start, end, category: 'style', ruleId: 'style.passive',
          before: text, after: text, confidence: 'check',
          why: `Страдательный залог «${text}» — назовите, кто действует: «мы ${tok.lower.endsWith('о') ? 'сделали' : 'сделали'}…», и используйте глагол.`,
          source: SOURCE, ref: [], metric: 'passive',
        }));
        continue;
      }
      const vp = ps.find((p) => (p.tag.POS === 'VERB' || p.tag.POS === 'INFN') && reflexive.has(String(p.normalize().word)));
      if (!vp) continue;
      out.push(makeIssue({
        para: ctx.para, start: tok.start, end: tok.end, category: 'style', ruleId: 'style.passive-sya',
        before: tok.text, after: tok.text, confidence: 'check',
        why: `Глагол «${tok.text}» здесь — страдательный залог («работа проводится»). Скажите, кто действует: «мы проводим работу».`,
        source: SOURCE, ref: [], metric: 'passive',
      }));
    }
  }
}

/* ---------- scoring ---------- */

function score(issues, chars) {
  let raw = 0;
  for (const is of issues) raw += WEIGHTS[is.metric] || 0;
  const per1000 = raw * 1000 / Math.max(chars, SCORE_LENGTH_FLOOR);
  const s = Math.max(0, Math.min(10, 10 - per1000));
  return Math.round(s * 10) / 10;
}

/**
 * Analyse a document for style.
 * @param {{paragraphs: Array<{text:string, kind?:string}>}} doc
 * @param {object} settings merged settings
 * @param {object} env { rules }
 * @param {{ recomputing?: boolean }} [opts]
 * @returns {{ score:number, scoreAfter:number, metrics:object[], issues:object[] }}
 */
function analyze(doc, settings, env, opts = {}) {
  let all = [];
  let chars = 0;
  doc.paragraphs.forEach((p, para) => {
    const text = p.text || '';
    chars += text.length;
    if (!text.trim()) return;
    const ctx = buildContext(text, para, settings, env);
    ctx.kind = p.kind;
    const out = [];
    kancRules(ctx, out);
    compositeDecision(ctx, out);
    nominalRules(ctx, out);
    copulaRules(ctx, out);
    intensifierRules(ctx, out);
    longSentences(ctx, out);
    passiveRules(ctx, out);
    out.push(...repeats.near(ctx), ...repeats.bigrams(ctx));
    all.push(...out);
  });
  const issues = resolveOverlaps(all, RANK, (is) => is.ruleId === 'style.long');
  const metrics = METRIC_TITLES.map(([id, title]) => ({ id, title, count: issues.filter((is) => is.metric === id).length }));
  const sc = score(issues, chars);
  let scoreAfter = sc;
  if (!opts.recomputing) {
    const fixed = applyIssues(doc, issues);
    scoreAfter = analyze(fixed, settings, env, { recomputing: true }).score;
  }
  return { score: sc, scoreAfter, metrics, issues };
}

module.exports = { analyze, deletion, expandTemplate, WEIGHTS, SCORE_LENGTH_FLOOR };
