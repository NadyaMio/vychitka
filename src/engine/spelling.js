'use strict';

/**
 * Spelling: phrase rules (что бы → чтобы, …) and unknown-word detection with
 * ranked suggestions.
 */

const morph = require('./morph');
const { makeIssue, matchCase, wordRegex } = require('./util');

const SOURCE_DICT = 'Орфографический словарь (OpenCorpora)';
const MIN_WORD_LEN = 2;
const MAX_ALTERNATIVES = 5;

const REF_BY_KIND = {
  nn: [61, 62],
  tsya: [73],
  soft: [72],
  hard: [70],
  vowel: [11],
  double: [68],
  consonant: [49],
};

const IMET_FORMS = new Set(['иметь', 'имей', 'имейте', 'имел', 'имела', 'имели', 'имею', 'имеешь', 'имеет', 'имеем', 'имеете', 'имеют', 'имея', 'имелось', 'имелись']);
const NESMOTRYA_OBJECTS = new Set(['глаза', 'часы', 'него', 'неё', 'нее', 'них', 'меня', 'тебя', 'вас', 'нас', 'экран', 'дорогу', 'лица', 'лицо', 'стороны', 'ноги', 'пол', 'карту', 'телефон', 'собеседника', 'зрителей', 'камеру', 'землю', 'небо', 'окно', 'себя', 'друг', 'людей', 'людям', 'фотографии', 'фото', 'монитор', 'доску', 'бумагу', 'книгу', 'книги', 'страницу', 'текст', 'мир', 'вещи', 'звёзды', 'звезды', 'потолок', 'огонь', 'воду', 'море', 'часов']);
const VMESTO_PREV = new Set(['это', 'то', 'самое', 'другое', 'новое', 'одно', 'любое', 'какое', 'такое', 'первое', 'последнее', 'прибыть', 'прибыл', 'прибыли', 'прибыла', 'приехать', 'приехал', 'приехали', 'приехала', 'попасть', 'попал', 'попали', 'вернуться', 'вернулся', 'вернулись', 'перейти', 'перешёл', 'перешел', 'переехать', 'переехал', 'переехали', 'отправиться', 'отправился', 'отправились']);
const TIME_DATIVE_NOUNS = new Set(['мнению', 'опыту', 'разумению', 'убеждению', 'глубокому', 'скромному', 'личному', 'собственному', 'твёрдому', 'твердому', 'ощущению', 'впечатлению', 'наблюдению', 'представлению', 'желанию', 'выбору', 'вкусу', 'усмотрению', 'хотению', 'примеру', 'образцу', 'совету', 'приказу', 'плану', 'проекту', 'сценарию', 'методу', 'способу', 'адресу', 'месту', 'времени']);
const NE_MERGE_PREV = new Set(['мне', 'ему', 'ей', 'нам', 'вам', 'им', 'тебе', 'всем', 'никому', 'кому', 'людям', 'детям', 'совсем', 'просто', 'больше', 'уже', 'теперь', 'идти', 'бежать', 'спешить', 'деваться', 'жить', 'было', 'будет', 'стало', 'сейчас', 'сегодня', 'торопиться', 'спать', 'сидеть', 'ехать', 'пойти', 'работать', 'жаловаться', 'ждать', 'отступать']);
const TO_PARTICLE_NEXT = new Set(['же', 'самое', 'что', 'есть', 'время', 'место', 'дело', 'ли', 'бишь']);
const PO_ADVERB_DATIVE = new Set(['домашнему', 'хорошему', 'плохому', 'честному', 'настоящему', 'простому', 'своему', 'твоему', 'нашему', 'вашему', 'прежнему', 'новому', 'другому', 'разному', 'старому', 'иному']);

let warnedConds = new Set();

function hasDictPos(word, poses) {
  return morph.dictParses(word).some((p) => poses.includes(p.tag.POS));
}

function hasDictCase(word, cas, poses) {
  return morph.dictParses(word).some((p) => p.tag.CAse === cas && (!poses || poses.includes(p.tag.POS)));
}

/** Named conditions for phrase rules. Return true when the rule applies. */
const CONDS = {
  chtoby(ctx, m) {
    const endPos = m.index + m[0].length;
    if (ctx.text[endPos] === ',') return false;
    let w = ctx.nextWordFrom(endPos);
    if (!w) return false;
    if (w.lower === 'не') w = ctx.nextWordFrom(w.end);
    if (!w) return false;
    if (['ни', 'то', 'там', 'это', 'вы', 'ты', 'мы', 'он', 'она', 'они', 'я', 'оно', 'такое', 'ещё', 'еще', 'вам', 'тебе', 'нам', 'мне', 'ему', 'ей', 'им'].includes(w.lower)) return false;
    const parses = morph.dictParses(w.text);
    if (parses.some((p) => p.tag.POS === 'INFN')) return true;
    if (parses.some((p) => p.tag.POS === 'VERB' && p.tag.TEns === 'past')) return true;
    return false;
  },
  nesmotrya(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w) return true;
    if (NESMOTRYA_OBJECTS.has(w.lower)) return false;
    const w2 = ctx.nextWordFrom(w.end);
    if (w2 && NESMOTRYA_OBJECTS.has(w2.lower) && hasDictPos(w.text, ['ADJF', 'NPRO'])) return false;
    return true;
  },
  nextGen(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !!w && hasDictCase(w.text, 'gent');
  },
  nextIsGen(ctx, m) {
    return CONDS.nextGen(ctx, m);
  },
  nextNotGen(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !w || !hasDictCase(w.text, 'gent', ['NOUN', 'ADJF', 'NPRO']);
  },
  vvidu(ctx, m) {
    const prev = ctx.prevWordBefore(m.index);
    if (prev && IMET_FORMS.has(prev.lower)) return false;
    return CONDS.nextGen(ctx, m);
  },
  vmesto(ctx, m) {
    const prev = ctx.prevWordBefore(m.index);
    if (prev && VMESTO_PREV.has(prev.lower)) return false;
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w || ['где', 'куда', 'откуда', 'которое', 'встречи', 'назначения', 'сбора', 'жительства', 'работы', 'проведения', 'отдыха', 'под'].includes(w.lower)) return false;
    return hasDictCase(w.text, 'gent', ['NOUN', 'NPRO', 'ADJF']);
  },
  pomoemu(ctx, m) {
    const tok = ctx.tokenAt(m.index);
    if (tok === -1 || !ctx.isSentenceStart(tok)) return false;
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w) return true;
    if (TIME_DATIVE_NOUNS.has(w.lower)) return false;
    if (hasDictCase(w.text, 'datv', ['NOUN', 'ADJF'])) return false;
    return true;
  },
  nextNotAdj(ctx, m) {
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !w || !hasDictPos(w.text, ['ADJF', 'PRTF']);
  },
  niMerge(ctx, m) {
    const prev = ctx.prevTokenBefore(m.index);
    if (prev && prev.type === 'word' && ['у', 'с', 'к', 'о', 'от', 'для', 'на', 'в', 'за', 'про', 'при', 'по', 'из'].includes(prev.lower)) return false;
    const after = ctx.text.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/^\s*,/.test(after)) return false;
    const merged = m[0].replace(/\s+/g, '').toLowerCase();
    return morph.dictKnown(merged);
  },
  neMerge(ctx, m) {
    const merged = m[0].replace(/\s+/g, '').toLowerCase();
    if (!morph.dictKnown(merged)) return false;
    const prev = ctx.prevWordBefore(m.index);
    if (prev && NE_MERGE_PREV.has(prev.lower)) return true;
    const w = ctx.nextWordFrom(m.index + m[0].length);
    return !!w && hasDictPos(w.text, ['INFN']);
  },
  toParticle(ctx, m) {
    const endPos = m.index + m[0].length;
    if (/^\s*[,:;—–-]/.test(ctx.text.slice(endPos, endPos + 2))) return false;
    const w = ctx.nextWordFrom(endPos);
    if (w && TO_PARTICLE_NEXT.has(w.lower)) return false;
    const prev = ctx.prevWordBefore(m.index);
    if (prev && ['не', 'а', 'и'].includes(prev.lower) && m[1] && m[1].toLowerCase() === 'что') return false;
    return true;
  },
  poAdverb(ctx, m) {
    const tail = m[1] ? m[1].toLowerCase() : '';
    if (!PO_ADVERB_DATIVE.has(tail)) return true;
    const w = ctx.nextWordFrom(m.index + m[0].length);
    if (!w) return true;
    return !hasDictCase(w.text, 'datv', ['NOUN', 'ADJF', 'NPRO']);
  },
  ordinalIntro(ctx, m) {
    const endPos = m.index + m[0].length;
    const next = ctx.nextTokenFrom(endPos);
    if (!next) return true;
    if (next.type === 'punct') return true;
    if (next.type !== 'word') return false;
    return !hasDictPos(next.text, ['NOUN', 'ADJF', 'NUMR']);
  },
};

function compilePhrases(items) {
  return items.map((it) => ({ ...it, re: wordRegex(it.pattern) }));
}

/**
 * Apply a replacement template ($1, $2 …) and restore capitalisation.
 */
function expand(template, m) {
  return template.replace(/\$(\d)/g, (_, d) => m[Number(d)] || '');
}

function phraseIssues(ctx, out, covered) {
  const rules = ctx.rules.phrasesCompiled;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(ctx.text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (covered.some(([s, e]) => start < e && s < end)) continue;
      if (rule.cond) {
        const fn = CONDS[rule.cond];
        if (!fn) {
          if (!warnedConds.has(rule.cond)) {
            warnedConds.add(rule.cond);
            console.warn(`[engine] unknown phrase condition "${rule.cond}" in ${rule.id}`);
          }
        } else if (!fn(ctx, m)) continue;
      }
      let after = matchCase(m[0], expand(rule.after, m));
      if (rule.cond === 'pomoemu') {
        const next = ctx.text[end];
        if (next !== ',') after += ',';
      }
      if (after === m[0]) continue;
      covered.push([start, end]);
      out.push(makeIssue({
        para: ctx.para,
        start,
        end,
        category: 'spelling',
        ruleId: rule.id,
        before: m[0],
        after,
        confidence: rule.confidence || 'check',
        why: rule.why,
        ref: rule.ref || [],
        source: rule.ref && rule.ref.length ? undefined : SOURCE_DICT,
      }));
    }
  }
}

function whyFor(kind, word, after) {
  switch (kind) {
    case 'nn': return after.length > word.length
      ? `Здесь нужны две «н»: «${after}».`
      : `Здесь пишется одна «н»: «${after}».`;
    case 'tsya': return after.length > word.length
      ? `Глагол отвечает на вопрос «что (с)делать?» — пишется «-ться»: «${after}».`
      : `Глагол отвечает на вопрос «что делает?» — пишется «-тся» без мягкого знака: «${after}».`;
    case 'soft': return after.length > word.length
      ? `Пропущен мягкий знак: «${after}».`
      : `Лишний мягкий знак: «${after}».`;
    case 'hard': return `Здесь нужен другой знак: «${after}».`;
    case 'vowel': return `Безударная гласная: правильно «${after}».`;
    case 'double': return `Удвоенная согласная: правильно «${after}».`;
    case 'consonant': return `Правильно «${after}» — проверьте согласную.`;
    case 'transpose': return `Переставлены буквы: «${after}».`;
    default: return `Слова «${word}» нет в словаре. Возможно, имелось в виду «${after}».`;
  }
}

function noteFor(word, pred) {
  const parses = morph.dictParses(word);
  if (!parses.length) return '';
  let best = parses[0];
  if (pred) {
    const hit = parses.find((p) => p.tag.POS === pred.POS && p.tag.NMbr === pred.NMbr && p.tag.CAse === pred.CAse)
      || parses.find((p) => p.tag.POS === pred.POS && p.tag.NMbr === pred.NMbr);
    if (hit) best = hit;
  }
  return morph.describeTag(best.tag);
}

function predicted(word) {
  for (const p of morph.parse(word)) {
    if (p.parser !== 'Dictionary') return { POS: p.tag.POS, NMbr: p.tag.NMbr, CAse: p.tag.CAse };
  }
  return null;
}

/**
 * Build the spelling issue for an unknown word token.
 * @returns {object|null}
 */
function unknownWordIssue(ctx, tok) {
  const word = tok.text;
  const cands = morph.candidates(word);
  if (!cands.length) {
    return makeIssue({
      para: ctx.para,
      start: tok.start,
      end: tok.end,
      category: 'spelling',
      ruleId: 'spell.unknown-nosugg',
      before: word,
      after: word,
      confidence: 'check',
      why: 'Слова нет в словаре. Проверьте написание или добавьте в «Мой словарь».',
      source: SOURCE_DICT,
      ref: [],
    });
  }
  const best = cands[0];
  const pred = predicted(word);
  const sure = morph.SURE_KINDS.has(best.kind) || cands.length === 1;
  const alternatives = [];
  const seen = new Set([best.word.toLowerCase()]);
  const push = (w, note) => {
    const key = w.toLowerCase();
    if (seen.has(key) || alternatives.length >= MAX_ALTERNATIVES) return;
    seen.add(key);
    alternatives.push({ text: w, note });
  };
  const forms = morph.closeForms(word, best.word, 2);
  if (pred) {
    forms.sort((a, b) => a.distance - b.distance || Number(b.tag.NMbr === pred.NMbr) - Number(a.tag.NMbr === pred.NMbr));
  }
  for (const c of cands.slice(1, 3)) push(c.word, noteFor(c.word, pred));
  for (const f of forms) push(f.word, morph.describeTag(f.tag));
  for (const c of cands.slice(3)) push(c.word, noteFor(c.word, pred));
  return makeIssue({
    para: ctx.para,
    start: tok.start,
    end: tok.end,
    category: 'spelling',
    ruleId: 'spell.unknown',
    before: word,
    after: best.word,
    note: noteFor(best.word, pred),
    alternatives,
    confidence: sure ? 'sure' : 'check',
    why: whyFor(best.kind, word, best.word),
    ref: REF_BY_KIND[best.kind] || [],
    source: REF_BY_KIND[best.kind] ? undefined : SOURCE_DICT,
    meta: { kind: best.kind },
  });
}

/**
 * Should this token be checked against the dictionary at all?
 */
function isCheckable(ctx, tok, i) {
  if (tok.type !== 'word') return false;
  if (tok.text.length < MIN_WORD_LEN) return false;
  if (tok.allCaps) return false;
  if (tok.cap && !ctx.isSentenceStart(i)) return false; // proper noun
  if (tok.text.includes('-')) {
    const parts = tok.text.split('-');
    if (parts.some((p) => p.length === 1)) return false; // "т-щ", "с-но"
  }
  const prev = ctx.prevIndex(i);
  // hyphenated line-break remnants or abbreviations with a period before
  if (prev >= 0 && ctx.tokens[prev].type === 'punct' && ctx.tokens[prev].text === '.' && ctx.tokens[prev].end === tok.start) return false;
  return true;
}

/**
 * Run spelling checks for one paragraph.
 * @param {object} ctx paragraph context
 * @returns {object[]} issues
 */
function check(ctx) {
  const out = [];
  const covered = [];
  phraseIssues(ctx, out, covered);
  const { tokens } = ctx;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!isCheckable(ctx, tok, i)) continue;
    if (covered.some(([s, e]) => tok.start < e && s < tok.end)) continue;
    if (morph.isKnown(tok.text)) continue;
    if (tok.cap && morph.isKnown(tok.lower)) continue;
    const issue = unknownWordIssue(ctx, tok);
    if (issue) out.push(issue);
  }
  return out;
}

module.exports = { check, compilePhrases, CONDS, SOURCE_DICT };
