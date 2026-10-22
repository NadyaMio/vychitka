'use strict';

/**
 * Word card: part of speech, lemma, grammar tags, suggestions for unknown
 * words, the spelling rule involved, a short forms summary and a morphology
 * table.
 */

const morph = require('./morph');
const dal = require('./dal');

const MAX_SUGGESTIONS = 5;
const DAL_EXCERPT = 1200;

const RULE_BY_KIND = {
  nn: 'В прилагательных с суффиксами -енн-, -онн- и в страдательных причастиях прошедшего времени пишутся две «н».',
  tsya: 'Если глагол отвечает на вопрос «что (с)делать?», пишется «-ться»; если «что (с)делает?» — «-тся».',
  soft: 'Мягкий знак обозначает мягкость согласной или разделяет согласную и гласную: «семья», «пить».',
  hard: 'Твёрдый знак пишется после приставки на согласную перед е, ё, ю, я: «подъезд», «объём».',
  vowel: 'Безударную гласную проверяют формой слова, где она под ударением: «собака» — словарное слово.',
  double: 'Удвоенные согласные в заимствованных словах проверяют по орфографическому словарю.',
  consonant: 'Сомнительную согласную проверяют формой слова, где после неё стоит гласная: «дуб — дубы».',
};

function describeForm(f) {
  return morph.describeTag(f.tag);
}

/** All forms of the lexeme (first dictionary parse), deduplicated by word+tags. */
function lexemeForms(parse) {
  const forms = [];
  if (typeof parse.formCnt !== 'number') return forms;
  const seen = new Set();
  for (let i = 0; i < parse.formCnt; i++) {
    const f = parse.inflect(i);
    if (!f) continue;
    const key = `${f.word}|${f.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push(f);
  }
  return forms;
}

function pick(forms, pred) {
  const f = forms.find(pred);
  return f ? String(f.word) : null;
}

function summarizeForms(lemma, pos, forms) {
  const has = (f, ...g) => g.every((x) => f.tag[x]);
  if (pos === 'NOUN') {
    const gent = pick(forms, (f) => has(f, 'sing', 'gent'));
    const plurN = pick(forms, (f) => has(f, 'plur', 'nomn'));
    const plurG = pick(forms, (f) => has(f, 'plur', 'gent'));
    const parts = [lemma];
    if (gent) parts.push(`род. п. ${gent}`);
    if (plurN || plurG) parts.push(`мн. ч. ${[plurN, plurG].filter(Boolean).join(', ')}`);
    return parts.join('; ');
  }
  if (pos === 'ADJF' || pos === 'ADJS' || pos === 'COMP') {
    const femn = pick(forms, (f) => f.tag.POS === 'ADJF' && has(f, 'femn', 'nomn'));
    const neut = pick(forms, (f) => f.tag.POS === 'ADJF' && has(f, 'neut', 'nomn'));
    const shorts = forms.filter((f) => f.tag.POS === 'ADJS').map((f) => String(f.word));
    const uniqShorts = [...new Set(shorts)].slice(0, 4);
    const parts = [lemma];
    if (femn || neut) parts.push([femn, neut].filter(Boolean).join(', '));
    if (uniqShorts.length) parts.push(`кр. ф. ${uniqShorts.join(', ')}`);
    return parts.join('; ');
  }
  if (pos === 'VERB' || pos === 'INFN' || pos === 'PRTF' || pos === 'PRTS' || pos === 'GRND') {
    const p1 = pick(forms, (f) => f.tag.POS === 'VERB' && has(f, '1per', 'sing') && f.tag.TEns !== 'past');
    const p3 = pick(forms, (f) => f.tag.POS === 'VERB' && has(f, '3per', 'sing') && f.tag.TEns !== 'past');
    const p3p = pick(forms, (f) => f.tag.POS === 'VERB' && has(f, '3per', 'plur') && f.tag.TEns !== 'past');
    const pastM = pick(forms, (f) => f.tag.POS === 'VERB' && has(f, 'past', 'masc'));
    const pastF = pick(forms, (f) => f.tag.POS === 'VERB' && has(f, 'past', 'femn'));
    const parts = [lemma];
    const pres = [p1, p3, p3p].filter(Boolean);
    if (pres.length) parts.push(pres.join(', '));
    const past = [pastM, pastF].filter(Boolean);
    if (past.length) parts.push(`прош. ${past.join(', ')}`);
    return parts.join('; ');
  }
  return lemma;
}

function morphTable(pos, forms) {
  const has = (f, ...g) => g.every((x) => f.tag[x]);
  let picks = [];
  if (pos === 'NOUN') {
    for (const cas of ['nomn', 'gent', 'datv', 'accs', 'ablt', 'loct']) picks.push(forms.find((f) => has(f, 'sing', cas)));
    for (const cas of ['nomn', 'gent', 'datv', 'accs', 'ablt', 'loct']) picks.push(forms.find((f) => has(f, 'plur', cas)));
  } else if (pos === 'ADJF' || pos === 'ADJS' || pos === 'COMP') {
    for (const g of ['masc', 'femn', 'neut']) picks.push(forms.find((f) => f.tag.POS === 'ADJF' && has(f, g, 'nomn')));
    picks.push(forms.find((f) => f.tag.POS === 'ADJF' && has(f, 'plur', 'nomn')));
    for (const cas of ['gent', 'datv', 'ablt', 'loct']) picks.push(forms.find((f) => f.tag.POS === 'ADJF' && has(f, 'masc', cas)));
    for (const g of ['masc', 'femn', 'neut', 'plur']) picks.push(forms.find((f) => f.tag.POS === 'ADJS' && f.tag[g]));
    picks.push(forms.find((f) => f.tag.POS === 'COMP'));
  } else if (pos === 'VERB' || pos === 'INFN' || pos === 'PRTF' || pos === 'PRTS' || pos === 'GRND') {
    picks.push(forms.find((f) => f.tag.POS === 'INFN'));
    for (const p of ['1per', '2per', '3per']) picks.push(forms.find((f) => f.tag.POS === 'VERB' && has(f, p, 'sing') && f.tag.TEns !== 'past'));
    for (const p of ['1per', '3per']) picks.push(forms.find((f) => f.tag.POS === 'VERB' && has(f, p, 'plur') && f.tag.TEns !== 'past'));
    for (const g of ['masc', 'femn', 'neut', 'plur']) picks.push(forms.find((f) => f.tag.POS === 'VERB' && has(f, 'past', g)));
    picks.push(forms.find((f) => f.tag.POS === 'VERB' && has(f, 'impr', 'sing')));
    picks.push(forms.find((f) => f.tag.POS === 'GRND'));
  }
  picks = picks.filter(Boolean);
  if (!picks.length) picks = forms.slice(0, 12);
  const seen = new Set();
  const out = [];
  for (const f of picks) {
    const row = { form: String(f.word), tags: describeForm(f) };
    const key = row.form + '|' + row.tags;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}

function predictedFor(word) {
  for (const p of morph.parse(word)) {
    if (p.parser !== 'Dictionary') return { POS: p.tag.POS, NMbr: p.tag.NMbr, CAse: p.tag.CAse };
  }
  return null;
}

/**
 * Dal's article for the card: { word: head, text (≈1200 chars, cut at a sentence), url,
 * approx? } or null; `approx: true` marks the nearest nest found by prefix rather than an
 * exact headword. The dictionary is loaded lazily on the first call.
 */
function dalCard(word, lemma) {
  const hit = dal.lookup(word, lemma);
  if (!hit) return null;
  const card = { word: hit.head, text: dal.excerpt(hit.text, DAL_EXCERPT), url: hit.url };
  if (hit.approx) card.approx = true;
  return card;
}

/**
 * Build the word card.
 * @param {string} word
 * @param {{ para?:number, start?:number, end?:number, doc?:object }} [opts]
 * @returns {object}
 */
function wordInfo(word, opts = {}) {
  const clean = String(word || '').trim();
  const base = { word: clean, known: false, lemma: null, posTitle: 'слово', tags: '', suggestions: [], rule: null, forms: null, morph: [], dal: null };
  if (!clean) return base;
  const known = morph.isKnown(clean);
  const dict = morph.dictParses(clean);
  const parses = dict.length ? dict : morph.parse(clean);
  const best = parses[0] || null;
  const pos = best ? best.tag.POS : null;
  let lemma = null;
  if (best) {
    const n = best.normalize();
    lemma = n && n.word ? String(n.word) : clean.toLowerCase();
  }
  const info = {
    ...base,
    known,
    lemma,
    posTitle: best ? morph.posTitle(best.tag) : 'слово',
    tags: best ? morph.describeTag(best.tag) : '',
  };
  if (best && dict.length) {
    const forms = lexemeForms(best);
    if (forms.length) {
      info.forms = summarizeForms(lemma, pos, forms);
      info.morph = morphTable(pos, forms);
    } else {
      info.forms = lemma;
      info.morph = [{ form: clean, tags: info.tags }];
    }
  } else if (best) {
    info.morph = [{ form: clean, tags: info.tags + (info.tags ? ' ' : '') + '(предположительно)' }];
  }
  if (!known && !dict.length) {
    const pred = predictedFor(clean);
    const cands = morph.candidates(clean).slice(0, MAX_SUGGESTIONS);
    info.suggestions = cands.map((c, idx) => {
      const ps = morph.dictParses(c.word);
      let note = ps.length ? morph.describeTag(ps[0].tag) : '';
      let fits = idx === 0;
      if (pred && ps.length) {
        const hit = ps.find((p) => p.tag.POS === pred.POS && p.tag.NMbr === pred.NMbr && p.tag.CAse === pred.CAse);
        if (hit) { note = morph.describeTag(hit.tag); fits = true; }
        else if (idx > 0) fits = false;
      }
      return { word: c.word, note, fits };
    });
    if (cands.length) {
      const bestCand = cands[0];
      info.rule = RULE_BY_KIND[bestCand.kind] || null;
      const cps = morph.dictParses(bestCand.word);
      if (cps.length) {
        const cf = lexemeForms(cps[0]);
        const n = cps[0].normalize();
        const candLemma = n && n.word ? String(n.word) : bestCand.word;
        info.forms = summarizeForms(candLemma, cps[0].tag.POS, cf);
        info.morph = morphTable(cps[0].tag.POS, cf);
        if (!info.lemma) info.lemma = null;
      }
    }
  }
  info.dal = dalCard(clean, lemma);
  return info;
}

module.exports = { wordInfo };
