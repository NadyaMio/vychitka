'use strict';

/**
 * Interpreter for LanguageTool pattern rules (bases/rules/lt-punct.json,
 * converted from the Russian grammar.xml by scripts/lt/convert.js; LGPL 2.1+,
 * https://languagetool.org) on top of our tokenizer and Az.js morphology.
 *
 * LanguageTool semantics that are reproduced here:
 *   - a sentence is a token array [SENT_START, t1 … tn]; the last token also
 *     carries the SENT_END reading; whitespace is not a token (`spacebefore`);
 *   - a pattern token matches when ANY reading satisfies text/postag and NO
 *     reading satisfies an exception (so «exception negate_pos» means «every
 *     reading must have this POS»); scope="previous"/"next" exceptions look
 *     at the neighbouring token, and a scope="next" exception also stops `skip`;
 *   - `skip` searches forward for the next token without backtracking (the
 *     first position that matches wins), `min`/`max` repeat a token greedily;
 *   - antipatterns immunise the tokens they cover (marker part);
 *   - <unify> compares feature equivalence classes over the tokens' readings.
 *
 * POS tags: every Az parse is rendered as a LanguageTool-style tag string
 * (`NN:Inanim:Masc:Sin:Nom`, `VB:Past:TRANS:PFV:Masc`, `DPT:Real:INTR:IMPFV`…)
 * so that the postag regexps from grammar.xml apply unchanged. The mapping
 * table is `AZ_TO_LT` below and in docs/ENGINE.md.
 *
 * Output: ordinary issues (category 'punctuation', ruleId 'lt.<LT_ID>').
 */

const fs = require('node:fs');
const path = require('node:path');
const morph = require('./morph');
const { makeIssue, loadJson } = require('./util');
const { buildContext } = require('./context');

const MAX_CACHE = 60000;
const ANY_TOKEN = Object.freeze({});

/* ------------------------------------------------------------------ */
/* Az (OpenCorpora) → LanguageTool (AOT) tag mapping                   */
/* ------------------------------------------------------------------ */

/**
 * Grammeme correspondence used by `ltTagsOfParse`. Shapes follow
 * resource/ru/tagset.txt of LanguageTool.
 */
const AZ_TO_LT = Object.freeze({
  pos: {
    NOUN: 'NN', ADJF: 'ADJ', ADJS: 'ADJ:Short', COMP: 'ADJ:Comp', VERB: 'VB', INFN: 'VB:INF', PRTF: 'PT', PRTS: 'PT_Short',
    GRND: 'DPT', NUMR: 'Num | NumC', ADVB: 'ADV', NPRO: 'PNN', PRED: 'PRDC', PREP: 'PREP', CONJ: 'CONJ', PRCL: 'PARTICLE',
    INTJ: 'INTERJECTION', Prnt: 'PARENTHESIS', Abbr: 'ABR', NUMB: 'UNKNOWN', LATN: 'UNKNOWN', ROMN: 'UNKNOWN',
  },
  case: { nomn: 'Nom', gent: 'R', gen1: 'R', gen2: '2R', datv: 'D', accs: 'V', acc2: 'V', ablt: 'T', loct: 'P', loc1: 'P', loc2: '2P', voct: 'Z' },
  gender: { masc: 'Masc', femn: 'Fem', neut: 'Neut' },
  number: { sing: 'Sin', plur: 'PL' },
  person: { '1per': 'P1', '2per': 'P2', '3per': 'P3' },
  tense: { pres: 'Real', past: 'Past', futr: 'Fut', impr: 'IMP', INFN: 'INF' },
  aspect: { perf: 'PFV', impf: 'IMPFV' },
  transitivity: { tran: 'TRANS', intr: 'INTR' },
  voice: { actv: 'DST', pssv: 'STR' },
  animacy: { anim: 'Anim', inan: 'Inanim' },
  other: { Name: 'NN:Name', Patr: 'NN:Patr', Surn: 'NN:Fam', Apro: 'ADJ:MPR', Supr: 'ADJ:Sup', Anum: 'Ord', Impe: 'bezl' },
});

const CASE = AZ_TO_LT.case;
const GENDER = AZ_TO_LT.gender;
const NUMBER = AZ_TO_LT.number;
const PERSON = AZ_TO_LT.person;
const TENSE = AZ_TO_LT.tense;
const ASPECT = AZ_TO_LT.aspect;
const TRANS = AZ_TO_LT.transitivity;
const VOICE = AZ_TO_LT.voice;
const PARSERS = new Set(['Dictionary', 'Abbr', 'HyphenParticle', 'HyphenAdverb', 'HyphenWords']);
/** Parenthetical words that AOT (LanguageTool) also files as conjunctions. */
const CONJ_AND_PARENTHESIS = new Set(['однако', 'значит', 'итак', 'следовательно']);

function genderOrPlural(tag) {
  if (tag.NMbr === 'plur') return 'PL';
  return GENDER[tag.GNdr] || '';
}

/**
 * LanguageTool-style tag strings for one Az tag (usually one, sometimes two:
 * common-gender nouns, abbreviations, parenthetical words).
 * @param {object} tag Az tag
 * @returns {string[]}
 */
function ltTagsOfTag(tag, lemmaHint = '') {
  const pos = tag.POS;
  const out = [];
  const num = NUMBER[tag.NMbr] || '';
  const cas = CASE[tag.CAse] || '';
  const asp = ASPECT[tag.ASpc] || 'IMPFV';
  const trn = TRANS[tag.TRns] || 'TRANS';
  switch (pos) {
    case 'NOUN': {
      if (tag.Surn) out.push(`NN:Fam:${num}:${cas}`);
      else {
        const kind = tag.Name ? 'Name' : tag.Patr ? 'Patr' : tag.ANim === 'anim' ? 'Anim' : 'Inanim';
        const genders = tag['Ms-f'] ? ['Masc', 'Fem'] : [GENDER[tag.GNdr] || ''];
        for (const g of genders) out.push(cas ? `NN:${kind}:${g}:${num}:${cas}` : `NN:${kind}:${g}`);
      }
      if (tag.Abbr) out.push(`ABR:${tag.NMbr === 'plur' ? 'PL' : GENDER[tag.GNdr] || ''}`);
      break;
    }
    case 'ADJF': {
      const gp = genderOrPlural(tag);
      if (tag.Anum) out.push(`Ord:${gp}:${cas}`);
      else out.push(`ADJ:${tag.Apro ? 'MPR' : tag.Supr ? 'Sup' : 'Posit'}:${gp}:${cas}`);
      // AOT also files «все / всё / всем …» as a noun-pronoun (PNN) next to the adjective-pronoun «весь»
      if (tag.Apro && lemmaHint === 'весь') out.push(`PNN:${num}:${cas}`);
      break;
    }
    case 'ADJS': out.push(`ADJ:Short:${genderOrPlural(tag)}`); break;
    case 'COMP': out.push('ADJ:Comp'); break;
    case 'VERB': {
      const bezl = tag.Impe ? ':bezl' : '';
      if (tag.MOod === 'impr') {
        out.push(`VB:IMP${bezl}:${trn}:${asp}:${num}:${tag.INvl === 'incl' ? 'P1' : 'P2'}`);
      } else if (tag.TEns === 'past') {
        out.push(tag.Impe ? `VB:Past${bezl}:${trn}:${asp}` : `VB:Past:${trn}:${asp}:${genderOrPlural(tag)}`);
      } else {
        const t = TENSE[tag.TEns] || 'Real';
        out.push(tag.Impe ? `VB:${t}${bezl}:${trn}:${asp}` : `VB:${t}:${trn}:${asp}:${num}:${PERSON[tag.PErs] || 'P3'}`);
      }
      break;
    }
    case 'INFN': out.push(`VB:INF${tag.Impe ? ':bezl' : ''}:${trn}:${asp}`); break;
    case 'PRTF': out.push(`PT:${TENSE[tag.TEns] || 'Past'}:${trn}:${asp}:${VOICE[tag.VOic] || 'DST'}:${genderOrPlural(tag)}:${cas}`); break;
    case 'PRTS': out.push(`PT_Short:${TENSE[tag.TEns] || 'Past'}:${trn}:${asp}:${VOICE[tag.VOic] || 'STR'}:${genderOrPlural(tag)}`); break;
    case 'GRND': out.push(`DPT:${TENSE[tag.TEns] || 'Past'}:${trn}:${asp}`); break;
    case 'NUMR': out.push(tag.GNdr ? `Num:${GENDER[tag.GNdr]}:${cas}` : `NumC:${cas}`); break;
    case 'NPRO': out.push(`PNN:${num}:${cas}${tag.PErs ? `:${PERSON[tag.PErs]}` : ''}`); break;
    case 'ADVB': out.push('ADV'); break;
    case 'PRED': out.push('PRDC'); break;
    case 'PREP': out.push('PREP'); break;
    // OpenCorpora files parenthetical words («кажется», «известно», «по-видимому») as CONJ,Prnt; AOT tags them PARENTHESIS only
    case 'CONJ': if (!tag.Prnt || CONJ_AND_PARENTHESIS.has(lemmaHint)) out.push('CONJ'); break;
    case 'PRCL': out.push('PARTICLE'); break;
    case 'INTJ': out.push('INTERJECTION'); break;
    default: break; // NUMB, LATN, ROMN, PNCT, UNKN → no tag
  }
  if (tag.Prnt) out.push('PARENTHESIS');
  return out;
}

/* ------------------------------------------------------------------ */
/* Module state                                                         */
/* ------------------------------------------------------------------ */

const state = {
  rules: [],          // compiled, enabled rules
  all: [],            // compiled rules including disabled (for calibration)
  byKey: new Map(),
  parenthetical: new Set(),
  needChunks: false,
  readingsCache: new Map(),
  info: { loaded: false, file: null, count: 0, enabled: 0, sure: 0, groups: 0 },
};

/**
 * Readings of a word token: [{ tag: string|null, lemma: string }].
 * @param {string} text token text as written
 * @returns {Array<{tag: string|null, lemma: string}>}
 */
function readingsOf(text) {
  const hit = state.readingsCache.get(text);
  if (hit) return hit;
  const lower = text.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const p of morph.parse(text)) {
    if (!PARSERS.has(p.parser) || p.typosCnt || p.stutterCnt) continue;
    if (text.length < 2 && (p.parser === 'Abbr' || p.tag.Abbr)) continue; // «и» → «исполняющий», «в» → «век»: single letters are not abbreviations in running text
    const n = p.normalize();
    const lemma = String((n && n.word) || lower).toLowerCase();
    for (const tag of ltTagsOfTag(p.tag, lemma)) {
      const k = `${tag}\u0001${lemma}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // PARENTHESIS is «soft»: it satisfies positive postag tests but does not make a word ambiguous for negate_pos exceptions
      out.push(tag === 'PARENTHESIS' ? { tag, lemma, soft: true } : { tag, lemma });
    }
  }
  if (state.parenthetical.has(lower) && !out.some((r) => r.tag === 'PARENTHESIS')) out.push({ tag: 'PARENTHESIS', lemma: lower, soft: true });
  if (!out.some((r) => !r.soft)) out.unshift({ tag: null, lemma: lower });
  if (state.readingsCache.size >= MAX_CACHE) state.readingsCache.clear();
  state.readingsCache.set(text, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Regexps: Java → JavaScript                                           */
/* ------------------------------------------------------------------ */

const ASCII_PUNCT = '!-\\/:-@\\[-`{-~';

/**
 * Translate a LanguageTool (Java) regexp into a JavaScript RegExp that must
 * match the whole token. Returns null when the expression cannot be compiled.
 * @param {string} src
 * @param {boolean} caseSensitive
 * @returns {RegExp|null}
 */
function javaRegexToJs(src, caseSensitive) {
  let s = src
    .replace(/\[\\p\{Punct\}\]/g, `[${ASCII_PUNCT}]`)
    .replace(/\\p\{Punct\}/g, `[${ASCII_PUNCT}]`)
    .replace(/\\p\{Digit\}/g, '\\d')
    .replace(/\\p\{Alpha\}/g, '\\p{L}')
    .replace(/\\p\{Lower\}/g, '\\p{Ll}')
    .replace(/\\p\{Upper\}/g, '\\p{Lu}');
  const flags = caseSensitive ? '' : 'i';
  for (const f of [flags + 'u', flags]) {
    try {
      return new RegExp(`^(?:${s})$`, f);
    } catch {
      // try the next flag set
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Compilation                                                          */
/* ------------------------------------------------------------------ */

/** Compile one token / exception spec. Throws on an invalid regexp. */
function compileSpec(t, where) {
  const spec = {
    hasText: typeof t.text === 'string' && t.text.length > 0,
    text: t.text || '',
    textLower: (t.text || '').toLowerCase(),
    re: null,
    negate: !!t.negate,
    inflected: !!t.inflected,
    cs: !!t.cs,
    hasPos: !!t.postag,
    postag: t.postag || '',
    posRe: null,
    posUnknown: false,
    negatePos: !!t.negatePos,
    spaceBefore: t.spaceBefore || null,
    chunk: t.chunk || null,
    ref: typeof t.ref === 'number' ? t.ref : -1,
    skip: typeof t.skip === 'number' ? t.skip : 0,
    min: typeof t.min === 'number' ? t.min : 1,
    max: typeof t.max === 'number' ? t.max : 1,
    excCur: [],
    excPrev: [],
    excNext: [],
    hasNext: false,
    scope: t.scope || 'current',
  };
  if (spec.hasText && t.regexp) {
    spec.re = javaRegexToJs(t.text, spec.cs);
    if (!spec.re) throw new Error(`${where}: invalid regexp /${t.text}/`);
  }
  if (spec.hasPos) {
    if (t.postagRegexp) {
      spec.posRe = javaRegexToJs(t.postag, true);
      if (!spec.posRe) throw new Error(`${where}: invalid postag regexp /${t.postag}/`);
      spec.posUnknown = spec.posRe.test('UNKNOWN');
    } else {
      spec.posUnknown = t.postag === 'UNKNOWN';
    }
  }
  if (spec.chunk) state.needChunks = true;
  for (const ex of t.exceptions || []) {
    const e = compileSpec(ex, where);
    if (e.scope === 'next') spec.excNext.push(e);
    else if (e.scope === 'previous') spec.excPrev.push(e);
    else spec.excCur.push(e);
  }
  spec.hasNext = spec.excNext.length > 0;
  return spec;
}

function compileElement(t, where) {
  if (t.or) {
    const alts = t.or.map((a) => compileSpec(a, where));
    return { or: alts, skip: 0, min: 1, max: 1, hasNext: alts.some((a) => a.hasNext), excNext: alts.flatMap((a) => a.excNext) };
  }
  return compileSpec(t, where);
}

/** Literal words a token can match (for the sentence prefilter), or null when unbounded. */
function literalsOf(spec) {
  if (spec.or) {
    const all = [];
    for (const a of spec.or) {
      const l = literalsOf(a);
      if (!l) return null;
      all.push(...l);
    }
    return all;
  }
  if (!spec.hasText || spec.negate || spec.inflected || spec.min === 0) return null;
  if (!spec.re) return [spec.textLower];
  if (/^[\p{L}\p{M}\d|–—-]+$/u.test(spec.text)) return spec.textLower.split('|').filter(Boolean);
  return null;
}

function compileSequence(seq, where) {
  const tokens = seq.tokens.map((t, i) => compileElement(t, `${where} token ${i + 1}`));
  return { tokens, marker: seq.marker || null, unify: seq.unify || [] };
}

/**
 * Compile a rule from the JSON. Returns { rule } or { error }.
 */
function compileRule(r) {
  try {
    const pattern = compileSequence({ tokens: r.pattern, marker: r.marker, unify: r.unify }, r.key);
    const antipatterns = (r.antipatterns || []).map((ap, i) => compileSequence(ap, `${r.key} antipattern ${i + 1}`));
    let anchor = null;
    for (const el of pattern.tokens) {
      const l = literalsOf(el);
      if (l && l.length && (!anchor || l.length < anchor.length)) anchor = l;
    }
    const status = r.status || {};
    return {
      rule: {
        key: r.key,
        id: r.id,
        name: r.title || r.name,
        ruleId: `lt.${r.id}`,
        pattern,
        antipatterns,
        message: r.message || [],
        suggestions: r.suggestions || [],
        why: r.why || null,
        ref: Array.isArray(r.ref) ? r.ref : [],
        anchor: anchor ? new Set(anchor) : null,
        enabled: status.enabled !== false,
        confidence: status.confidence === 'sure' ? 'sure' : 'check',
        picky: Array.isArray(r.ltTags) && r.ltTags.includes('picky'),
      },
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Load bases/rules/lt-punct.json (and intro.json for the PARENTHESIS tag).
 * Missing file → the checker is a no-op.
 * @param {string} rulesDir bases/rules
 * @returns {{ loaded: boolean, count: number, enabled: number, errors: string[] }}
 */
function load(rulesDir) {
  state.rules = [];
  state.all = [];
  state.byKey = new Map();
  state.parenthetical = new Set();
  state.needChunks = false;
  state.readingsCache.clear();
  const errors = [];
  const file = path.join(rulesDir, 'lt-punct.json');
  state.info = { loaded: false, file, count: 0, enabled: 0, sure: 0, groups: 0, license: '' };
  if (!fs.existsSync(file)) return { loaded: false, count: 0, enabled: 0, errors };
  const introFile = path.join(rulesDir, 'intro.json');
  if (fs.existsSync(introFile)) {
    for (const it of loadJson(introFile).items || []) {
      const w = String(it.text || '').toLowerCase();
      if (w && !w.includes(' ')) state.parenthetical.add(w);
    }
  }
  const data = loadJson(file);
  for (const r of data.rules || []) {
    const res = compileRule(r);
    if (res.error) {
      errors.push(res.error);
      continue;
    }
    state.all.push(res.rule);
    state.byKey.set(res.rule.key, res.rule);
    if (res.rule.enabled) state.rules.push(res.rule);
  }
  state.info = {
    loaded: true,
    file,
    count: state.all.length,
    enabled: state.rules.length,
    sure: state.rules.filter((r) => r.confidence === 'sure').length,
    groups: new Set(state.all.map((r) => r.id)).size,
    license: (data.source && data.source.license) || 'LGPL 2.1+',
    converted: (data.source && data.source.converted) || '',
  };
  if (errors.length) console.warn(`ltrules: ${errors.length} rule(s) could not be compiled: ${errors.slice(0, 3).join('; ')}`);
  return { loaded: true, count: state.all.length, enabled: state.rules.length, errors };
}

/** Summary for basesInfo(). */
function info() {
  return { ...state.info };
}

/* ------------------------------------------------------------------ */
/* Sentence → LanguageTool token array                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the LT token array of a sentence: SENT_START + non-space tokens.
 * @param {object} ctx paragraph context
 * @param {object} sentence
 * @param {boolean} last last sentence of the paragraph
 */
function buildSequence(ctx, sentence, last) {
  const toks = ctx.tokens;
  const seq = [];
  const first = toks[sentence.tokens[0]];
  seq.push({ text: '', lower: '', start: first.start, end: first.start, spaceBefore: false, readings: [{ tag: 'SENT_START', lemma: '' }], chunks: null, i: -1 });
  for (const ti of sentence.tokens) {
    const t = toks[ti];
    if (t.type === 'space') continue;
    const prev = ti > 0 ? toks[ti - 1] : null;
    const readings = t.type === 'word' ? readingsOf(t.text) : [{ tag: null, lemma: t.lower }];
    seq.push({ text: t.text, lower: t.lower, start: t.start, end: t.end, spaceBefore: !!prev && prev.type === 'space', readings, chunks: null, i: ti });
  }
  if (seq.length > 1) {
    const lastTok = seq[seq.length - 1];
    const extra = [{ tag: 'SENT_END', lemma: lastTok.lower }];
    if (last) extra.push({ tag: 'PARA_END', lemma: lastTok.lower });
    lastTok.readings = lastTok.readings.concat(extra);
  }
  if (state.needChunks) addChunks(seq);
  return seq;
}

/* ---- a small imitation of LanguageTool's RussianChunker (ADJP / VP) ---- */

const RE_PT = /^PT:/;
const RE_VB = /^VB:/;
const RE_NN = /^NN:/;
const RE_NN_OBL = /^NN:[^:]*:[^:]*:[^:]*:(R|D|T|P|2R|2P)$/;
const RE_NN_OBL_V = /^NN:[^:]*:[^:]*:[^:]*:(R|D|T|P|V|2R|2P)$/;
const RE_NN_NOMV = /^NN:[^:]*:[^:]*:[^:]*:(Nom|V)$/;
const RE_ADJ_OBL_V = /^ADJ:[^:]*:[^:]*:(R|D|T|P|V)$/;
const RE_PNN = /^PNN:/;
const RE_PNN_NOM = /^PNN:[^:]*:Nom/;

function hasTag(tok, re) {
  return tok.readings.some((r) => r.tag && re.test(r.tag));
}
function onlyTag(tok, yes, no) {
  return hasTag(tok, yes) && !hasTag(tok, no);
}

function addChunks(seq) {
  const n = seq.length;
  for (let i = 1; i < n; i++) seq[i].chunks = new Set();
  const add = (i, tag) => { if (i >= 1 && i < n) seq[i].chunks.add(tag); };
  for (let i = 1; i < n; i++) {
    const t = seq[i];
    // VP: runs of verbs (that are not nouns), optionally preceded by «не»
    if (hasTag(t, RE_VB) && !hasTag(t, RE_NN) && !(i > 1 && hasTag(seq[i - 1], RE_VB) && !hasTag(seq[i - 1], RE_NN))) {
      add(i, 'B-VP');
      let j = i + 1;
      while (j < n && hasTag(seq[j], RE_VB) && !hasTag(seq[j], RE_NN)) add(j++, 'I-VP');
      if (i > 1 && seq[i - 1].lower === 'не') add(i - 1, 'B-VP');
    }
    // ADJP: participle + its dependents
    if (hasTag(t, RE_PT)) {
      add(i, 'B-ADJP');
      const a = seq[i + 1];
      const b = seq[i + 2];
      const c = seq[i + 3];
      let len = 0;
      if (a && hasTag(a, /^PREP$/) && b && hasTag(b, RE_ADJ_OBL_V) && c && hasTag(c, RE_NN_OBL_V)) len = 3;
      else if (a && hasTag(a, /^PREP$/) && b && hasTag(b, RE_NN_OBL_V)) len = 2;
      else if (a && onlyTag(a, RE_NN, RE_NN_NOMV) && b && onlyTag(b, RE_NN_NOMV, RE_NN_OBL)) len = 2;
      else if (a && hasTag(a, RE_PNN) && !hasTag(a, RE_PNN_NOM) && b && onlyTag(b, RE_NN_NOMV, RE_NN_OBL)) len = 2;
      else if (a && hasTag(a, RE_NN_OBL)) len = 1;
      else if (a && hasTag(a, /^ADV$/)) len = 1;
      else if (a && hasTag(a, /^ADJ:/)) len = 1;
      for (let k = 1; k <= len; k++) add(i + k, 'I-ADJP');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Matching                                                             */
/* ------------------------------------------------------------------ */

function readingMatches(spec, tok, r) {
  let ok = true;
  if (spec.hasText) {
    let subject;
    if (spec.inflected) subject = r.lemma;
    else subject = spec.cs ? tok.text : tok.lower;
    if (spec.re) ok = spec.re.test(subject);
    else ok = subject === (spec.cs ? spec.text : spec.textLower);
    if (spec.negate) ok = !ok;
    if (!ok) return false;
  } else if (spec.negate) {
    return false;
  }
  if (spec.hasPos) {
    let pm;
    // LanguageTool: a reading with no tag, SENT_END or PARA_END counts as «no tag» (matches postag UNKNOWN)
    const noTag = r.tag === null || r.tag === 'SENT_END' || r.tag === 'PARA_END';
    if (spec.posUnknown && noTag) pm = true;
    else if (r.tag === null) pm = false;
    else if (spec.posRe) pm = spec.posRe.test(r.tag);
    else pm = r.tag === spec.postag;
    if (spec.negatePos) pm = !pm;
    if (!pm) return false;
  }
  return true;
}

/** Exception test: any reading matches (soft readings are ignored by negate_pos exceptions). */
function anyReadingMatches(spec, tok) {
  if (spec.spaceBefore && (spec.spaceBefore === 'yes') !== tok.spaceBefore) return false;
  if (spec.chunk && !(tok.chunks && tok.chunks.has(spec.chunk))) return false;
  for (const r of tok.readings) {
    if (r.soft && spec.negatePos) continue;
    if (readingMatches(spec, tok, r)) return true;
  }
  return false;
}

function specMatches(spec, seq, m, pos, startIdx) {
  const tok = seq[m];
  if (spec.spaceBefore && (spec.spaceBefore === 'yes') !== tok.spaceBefore) return false;
  if (spec.chunk && !(tok.chunks && tok.chunks.has(spec.chunk))) return false;
  if (spec.ref >= 0) {
    const refPos = pos[spec.ref] && pos[spec.ref].to >= pos[spec.ref].from ? pos[spec.ref].from : startIdx + spec.ref;
    const refTok = seq[refPos];
    if (!refTok || refTok.lower !== tok.lower) return false;
    if (!spec.hasText && !spec.hasPos && !spec.excCur.length && !spec.excPrev.length) return true;
  }
  let ok = false;
  for (const r of tok.readings) {
    if (readingMatches(spec, tok, r)) { ok = true; break; }
  }
  if (!ok) return false;
  for (const ex of spec.excCur) {
    if (anyReadingMatches(ex, tok)) return false;
  }
  if (spec.excPrev.length && m > 0) {
    const pt = seq[m - 1];
    for (const ex of spec.excPrev) if (anyReadingMatches(ex, pt)) return false;
  }
  return true;
}

function elementMatches(el, seq, m, pos, startIdx) {
  if (el.or) {
    for (const a of el.or) if (specMatches(a, seq, m, pos, startIdx)) return true;
    return false;
  }
  return specMatches(el, seq, m, pos, startIdx);
}

function nextExceptionHits(el, seq, m) {
  const tok = seq[m];
  for (const ex of el.excNext) if (anyReadingMatches(ex, tok)) return true;
  return false;
}

/**
 * Match a compiled token sequence at `startIdx`.
 * @returns {Array<{from:number,to:number}>|null} per-element spans (to < from for an optional element that matched nothing)
 */
function matchSequence(compiled, seq, startIdx, immune) {
  const els = compiled.tokens;
  const n = els.length;
  const pos = new Array(n);
  let p = startIdx;
  let prev = null;
  for (let k = 0; k < n; k++) {
    const el = els[k];
    const skip = prev ? prev.skip : 0;
    const maxPos = skip < 0 ? seq.length - 1 : Math.min(seq.length - 1, p + skip);
    let found = -1;
    for (let m = p; m <= maxPos; m++) {
      if (prev && prev.hasNext && nextExceptionHits(prev, seq, m)) return null;
      if (immune && immune.has(m)) continue;
      if (elementMatches(el, seq, m, pos, startIdx)) { found = m; break; }
    }
    if (found < 0) {
      if (el.min === 0) { pos[k] = { from: p, to: p - 1 }; continue; }
      return null;
    }
    let to = found;
    const max = el.max < 0 ? Infinity : el.max;
    let remaining = 0;
    for (let j = k + 1; j < n; j++) if (els[j].min !== 0) remaining++;
    while (to - found + 1 < max && to + 1 < seq.length - remaining && !(immune && immune.has(to + 1)) && elementMatches(el, seq, to + 1, pos, startIdx)) to++;
    pos[k] = { from: found, to };
    p = to + 1;
    prev = el;
  }
  if (prev && prev.hasNext && p < seq.length && nextExceptionHits(prev, seq, p)) return null;
  return pos;
}

/* ---- unification ---- */

const UNIFICATION = (() => {
  const re = (s) => new RegExp(`^(?:${s})$`);
  const NN_G = 'NN:.*:(Masc|Fem|Neut)';
  return {
    number: { Sin: re(`.*:Sin(:.*)*|((ADJ|Ord|PT:(Past|Real):.*|PT_Short:Real|VB:Past):.*:(Masc|Fem|Neut)(:.*)*)|${NN_G}`), PL: re(`.*:PL(:.*)*|${NN_G}`) },
    case: {
      Nom: re(`.*:Nom(:.*)*|${NN_G}`), R: re(`.*:R(:.*)*|${NN_G}|.*:2R(:.*)*`), D: re(`.*:D(:.*)*|${NN_G}`),
      V: re(`.*:V(:.*)*|${NN_G}`), T: re(`.*:T(:.*)*|${NN_G}`), P: re(`.*:P(:.*)*|${NN_G}|.*:2P(:.*)*`),
    },
    gender: { Masc: re('.*:Masc(:.*)*'), Fem: re('.*:Fem(:.*)*'), Neut: re('.*:Neut(:.*)*'), Plural: re(`.*:PL(:.*)*|${NN_G}`) },
    animacy: { Anim: re('.*:(Anim|Inanimanim|Name|Patr|Fam)(:.*)*'), Inanim: re('.*:(Inanim|Inanimanim)(:.*)*') },
    person: { P1: re('.*:P1'), P2: re('.*:P2'), P3: re('.*:P3') },
    tense: { INF: re('.*:INF(:.*)*'), IMP: re('.*:IMP(:.*)*'), Fut: re('.*:Fut(:.*)*'), Past: re('.*:Past(:.*)*'), Real: re('.*:Real(:.*)*') },
    transitivity: { TRANS: re('.*:TRANS(:.*)*'), INTR: re('.*:INTR(:.*)*') },
    aspect: { PFV: re('.*:(PFV|2PFV)(:.*)*'), IMPFV: re('.*:(IMPFV|2PFV)(:.*)*') },
  };
})();

function mainReadingMatches(el, tok, r) {
  if (el.or) return el.or.some((a) => readingMatches(a, tok, r));
  return readingMatches(el, tok, r);
}

function unifyOk(block, compiled, seq, pos) {
  for (const feature of block.features) {
    const table = UNIFICATION[feature];
    if (!table) return false;
    let inter = null;
    for (const idx of block.tokens) {
      const span = pos[idx];
      if (!span || span.to < span.from) continue;
      const tok = seq[span.from];
      const el = compiled.tokens[idx];
      const types = new Set();
      for (const r of tok.readings) {
        if (!r.tag || r.soft || !mainReadingMatches(el, tok, r)) continue;
        for (const [type, re] of Object.entries(table)) if (re.test(r.tag)) types.add(type);
      }
      inter = inter === null ? types : new Set([...inter].filter((x) => types.has(x)));
      if (!inter.size) return false;
    }
  }
  return true;
}

function unificationHolds(compiled, seq, pos) {
  for (const block of compiled.unify) {
    const ok = unifyOk(block, compiled, seq, pos);
    if (block.negate ? ok : !ok) return false;
  }
  return true;
}

/* ---- antipatterns ---- */

function spanOf(compiled, pos) {
  const n = pos.length;
  let a = compiled.marker ? compiled.marker[0] : 0;
  let b = compiled.marker ? compiled.marker[1] : n - 1;
  while (a <= b && pos[a].to < pos[a].from) a++;
  while (b >= a && pos[b].to < pos[b].from) b--;
  if (a > b) return null;
  return [pos[a].from, pos[b].to];
}

function immuneTokens(rule, seq) {
  if (!rule.antipatterns.length) return null;
  const immune = new Set();
  for (const ap of rule.antipatterns) {
    for (let s = 0; s < seq.length; s++) {
      const pos = matchSequence(ap, seq, s, null);
      if (!pos || !unificationHolds(ap, seq, pos)) continue;
      const span = spanOf(ap, pos);
      if (!span) continue;
      for (let i = span[0]; i <= span[1]; i++) immune.add(i);
    }
  }
  return immune.size ? immune : null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function applyCase(s, mode) {
  if (!s) return s;
  switch (mode) {
    case 'startupper': return s[0].toUpperCase() + s.slice(1);
    case 'startlower': return s[0].toLowerCase() + s.slice(1);
    case 'allupper': return s.toUpperCase();
    case 'alllower': return s.toLowerCase();
    default: return s;
  }
}

function nonEmptyAfter(pos, idx) {
  for (let j = idx + 1; j < pos.length; j++) if (pos[j] && pos[j].to >= pos[j].from) return j;
  return -1;
}

function renderParts(parts, compiled, seq, pos, text) {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') { out += part; continue; }
    if (part.m === undefined) continue;
    const idx = part.m - 1;
    const span = pos[idx];
    if (!span || span.to < span.from) continue;
    let from = span.from;
    let to = span.to;
    if (part.skipped === 'all') {
      const next = nonEmptyAfter(pos, idx);
      if (next >= 0 && pos[next].from - 1 > to) to = pos[next].from - 1;
    } else if (part.skipped === 'following') {
      if (to + 1 < seq.length) to = to + 1;
    }
    let s = text.slice(seq[from].start, seq[to].end);
    if (part.case) s = applyCase(s, part.case);
    out += s;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Checking                                                             */
/* ------------------------------------------------------------------ */

function sentenceWords(seq) {
  const set = new Set();
  for (let i = 1; i < seq.length; i++) set.add(seq[i].lower);
  return set;
}

function anchored(rule, words) {
  if (!rule.anchor) return true;
  for (const w of rule.anchor) if (words.has(w)) return true;
  return false;
}

/**
 * Run one rule over a sentence.
 * @returns {Array<{start:number,end:number,before:string,after:string,alternatives:string[],message:string}>}
 */
function runRule(rule, seq, text) {
  const out = [];
  const immune = immuneTokens(rule, seq);
  const compiled = rule.pattern;
  for (let s = 0; s < seq.length; s++) {
    const pos = matchSequence(compiled, seq, s, immune);
    if (!pos || !unificationHolds(compiled, seq, pos)) continue;
    const span = spanOf(compiled, pos);
    if (!span) continue;
    let start = seq[span[0]].start;
    const end = seq[span[1]].end;
    if (end <= start) continue;
    let suggestions = rule.suggestions.map((sg) => renderParts(sg, compiled, seq, pos, text));
    // LanguageTool: a suggestion that starts with a comma replaces the whitespace before the match as well
    if (span[0] > 0 && suggestions.some((sg) => sg.startsWith(','))) start = Math.min(start, seq[span[0] - 1].end);
    const before = text.slice(start, end);
    // LanguageTool keeps the capital letter of a sentence-initial match
    if (span[0] === 1 && /^\p{Lu}/u.test(before)) suggestions = suggestions.map((sg) => (/^\p{Ll}/u.test(sg) ? sg[0].toUpperCase() + sg.slice(1) : sg));
    const message = renderParts(rule.message.map((p) => (p.s !== undefined ? `«${suggestions[p.s].trim()}»` : p)), compiled, seq, pos, text);
    out.push({ start, end, before, after: suggestions.length ? suggestions[0] : before, alternatives: suggestions.slice(1), message, suggestions });
  }
  return out;
}

function strictlyInside(spans, start, end) {
  for (const [s, e] of spans) if (start > s && end < e) return true;
  return false;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Run the enabled LanguageTool rules over a paragraph context and append the
 * resulting issues to `out`. Matches that overlap an issue already in `out`
 * (our own rules) are dropped: the native rules take priority.
 * @param {object} ctx paragraph context (context.js)
 * @param {object[]} out issues of this paragraph collected so far (mutated)
 * @param {{ rules?: object[] }} [opts] rule subset (calibration)
 * @returns {object[]} the issues that were appended
 */
function check(ctx, out, opts) {
  const rules = (opts && opts.rules) || state.rules;
  if (!rules.length || !ctx.sentences.length) return [];
  const text = ctx.text;
  const hideSpans = ctx.settings && ctx.settings.skipQuotes ? (ctx.quotes || []).concat(ctx.speech || []) : [];
  const found = [];
  ctx.sentences.forEach((sentence, si) => {
    if (!sentence.tokens.length) return;
    const seq = buildSequence(ctx, sentence, si === ctx.sentences.length - 1);
    if (seq.length < 2) return;
    const words = sentenceWords(seq);
    for (const rule of rules) {
      if (!anchored(rule, words)) continue;
      for (const m of runRule(rule, seq, text)) found.push({ rule, m });
    }
  });
  if (!found.length) return [];
  // overlapping LT matches: a sure rule beats a check one, a match with a suggestion beats a bare signal, then the longer span
  const rank = (f) => (f.rule.confidence === 'sure' ? 0 : 2) + (f.m.after !== f.m.before ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || (b.m.end - b.m.start) - (a.m.end - a.m.start) || a.m.start - b.m.start);
  const added = [];
  for (const { rule, m } of found) {
    if (hideSpans.length && strictlyInside(hideSpans, m.start, m.end)) continue;
    if (out.some((is) => overlaps(is, m)) || added.some((is) => overlaps(is, m))) continue;
    const issue = makeIssue({
      para: ctx.para,
      start: m.start,
      end: m.end,
      category: 'punctuation',
      ruleId: rule.ruleId,
      before: m.before,
      after: m.after,
      alternatives: m.alternatives.filter((t) => t !== m.after).map((t) => ({ text: t })),
      confidence: rule.confidence,
      why: rule.why || m.message || rule.name,
      ref: rule.ref,
      source: `LanguageTool · ${rule.name}`,
      meta: { kind: 'lt', key: rule.key },
    });
    added.push(issue);
  }
  out.push(...added);
  return added;
}

/**
 * Matches of one rule (by key) in a plain text, ignoring the enabled flag and
 * our own rules. Used by scripts/lt/calibrate.js and the tests.
 * @param {string} text
 * @param {string} key rule key («VVODNOE_SLOVO[1]»)
 * @param {object} [settings] engine settings (skipQuotes …); default: no quote skipping
 * @returns {Array<{start:number,end:number,before:string,after:string,alternatives:string[],suggestions:string[],message:string}>}
 */
function matchText(text, key, settings) {
  return matchContext(buildContext(text, 0, { skipQuotes: false, ...(settings || {}) }, { rules: {} }), key);
}

const SEQ_CACHE = new WeakMap();

/**
 * Same as matchText() for a prebuilt paragraph context (sequences are cached
 * on the context, so one context can be checked against many rules cheaply).
 * @param {object} ctx
 * @param {string} key
 */
function matchContext(ctx, key) {
  const rule = state.byKey.get(key);
  if (!rule) throw new Error(`ltrules: unknown rule key ${key}`);
  let seqs = SEQ_CACHE.get(ctx);
  if (!seqs) {
    seqs = [];
    ctx.sentences.forEach((sentence, si) => {
      if (!sentence.tokens.length) return;
      const seq = buildSequence(ctx, sentence, si === ctx.sentences.length - 1);
      if (seq.length >= 2) seqs.push(seq);
    });
    SEQ_CACHE.set(ctx, seqs);
  }
  const res = [];
  for (const seq of seqs) res.push(...runRule(rule, seq, ctx.text));
  return res;
}

/** Paragraph context for matchContext() (no quote skipping). */
function contextOf(text) {
  return buildContext(text, 0, { skipQuotes: false }, { rules: {} });
}

/** Compiled rules (all, including disabled) — for calibration and tests. */
function rules() {
  return state.all.slice();
}

module.exports = { load, info, check, matchText, matchContext, contextOf, rules, javaRegexToJs, ltTagsOfTag, readingsOf, AZ_TO_LT };
