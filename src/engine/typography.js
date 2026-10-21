'use strict';

/**
 * Typography: dashes, quotes, digit grouping, double spaces, ellipsis, ё,
 * plus applyNbsp(text) used by export.
 */

const Az = require('az');
const morph = require('./morph');
const { makeIssue, matchCase } = require('./util');

const NBSP = '\u00A0';
const EM = '—';
const EN = '–';
const MAX_QUOTE_SPAN = 80;
const SRC_TYPO = 'Профиль: редакционная норма · типографика';
const NUMBER_LABELS = /(?:№|#|номер|тел\.?|телефон|инн|огрн|кпп|бик|снилс|код|индекс|артикул|заказ|счёт|счет|карта|карты|паспорт|серия|id|isbn|issn|оквэд|окпо|октмо|договор|акт|лицевой|счёту|счету|заказу|пин|pin)\s*:?\s*$/iu;

function dashes(ctx, out) {
  const text = ctx.text;
  let m;
  // paragraph-initial hyphen/en dash (dialogue)
  const lead = /^([ \u00A0]*)([-–]|--)(?=[ \u00A0])/;
  if ((m = lead.exec(text)) !== null) {
    const start = m[1].length;
    out.push(makeIssue({ para: ctx.para, start, end: start + m[2].length, category: 'typography', ruleId: 'typo.dash',
      before: m[2], after: EM, confidence: 'sure', why: 'Реплику диалога начинает длинное тире «—», а не дефис.', ref: [195], source: undefined }));
  }
  // spaced hyphen / en dash / double hyphen between words → nbsp + em dash
  const mid = /([ \u00A0])(--?|–)(?=[ \u00A0])/g;
  while ((m = mid.exec(text)) !== null) {
    if (m.index === 0 && /^[-–]/.test(text.trim())) continue;
    const start = m.index;
    const end = start + m[0].length;
    const after = NBSP + EM;
    out.push(makeIssue({ para: ctx.para, start, end, category: 'typography', ruleId: 'typo.dash',
      before: m[0], after, confidence: 'sure',
      why: 'Между словами ставится длинное тире «—» (перед ним — неразрывный пробел), а не дефис.', ref: [], source: SRC_TYPO }));
  }
  // NB: a plain space before an existing «—» is NOT reported — applyNbsp() handles it on export.
  // digit ranges: 2010-2020 → 2010–2020
  const range = /(?<![\d\-–—.,:/])(\d{1,4})-(\d{1,4})(?![\d\-–—.,:/%])/g;
  while ((m = range.exec(text)) !== null) {
    if (Number(m[1]) >= Number(m[2]) && m[1].length === m[2].length) continue; // not a growing range (phone/codes)
    out.push(makeIssue({ para: ctx.para, start: m.index + m[1].length, end: m.index + m[1].length + 1, category: 'typography', ruleId: 'typo.range-dash',
      before: '-', after: EN, confidence: 'check', why: 'Между числами в значении «от … до» ставится тире (короткое, без пробелов): «2010–2020».', ref: [178] }));
  }
}

function quotes(ctx, out) {
  if (ctx.settings.quotes !== 'elochki') return;
  const text = ctx.text;
  const positions = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === '“' || ch === '”' || ch === '„') positions.push(i);
  }
  if (!positions.length) return;
  const stack = [];
  const pairs = [];
  for (const pos of positions) {
    const ch = text[pos];
    const prev = pos > 0 ? text[pos - 1] : '';
    const next = text[pos + 1] || '';
    let opener;
    if (ch === '“' || ch === '„') opener = true;
    else if (ch === '”') opener = false;
    else {
      const openerCtx = pos === 0 || /[\s(«„—–\-\[]/.test(prev);
      const closerCtx = /[\s.,;:!?)»…\]]/.test(next) || next === '';
      if (openerCtx && !closerCtx) opener = true;
      else if (!openerCtx && closerCtx) opener = false;
      else if (openerCtx && closerCtx) opener = stack.length === 0;
      else opener = stack.length === 0;
      if (/\d/.test(prev) && !openerCtx) continue; // inches: 5"
    }
    if (opener) stack.push(pos);
    else if (stack.length) pairs.push([stack.pop(), pos]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const depthAt = (pos) => {
    let d = 0;
    for (const [s, e] of ctx.quotes) if (s < pos && pos < e && text[s] === '«') d++;
    for (const [s, e] of pairs) if (s < pos && pos < e) d++;
    return d;
  };
  for (const [s, e] of pairs) {
    const depth = depthAt(s);
    const [open, close] = depth === 0 ? ['«', '»'] : ['„', '“'];
    const inner = text.slice(s + 1, e);
    if (e - s <= MAX_QUOTE_SPAN && !/\n/.test(inner)) {
      let fixedInner = inner;
      for (const [s2, e2] of pairs) {
        if (s2 > s && e2 < e) {
          fixedInner = fixedInner.slice(0, s2 - s - 1) + '„' + fixedInner.slice(s2 - s, e2 - s - 1) + '“' + fixedInner.slice(e2 - s);
        }
      }
      out.push(makeIssue({ para: ctx.para, start: s, end: e + 1, category: 'typography', ruleId: 'typo.quotes',
        before: text.slice(s, e + 1), after: open + fixedInner + close, confidence: 'sure',
        why: depth === 0 ? 'В русском тексте используются кавычки-ёлочки «…»; прямые кавычки — машинописные.' : 'Внутри ёлочек используются кавычки-лапки „…“.',
        ref: [], source: SRC_TYPO }));
    } else {
      out.push(makeIssue({ para: ctx.para, start: s, end: s + 1, category: 'typography', ruleId: 'typo.quotes',
        before: text[s], after: open, confidence: 'sure', why: 'Открывающая кавычка: в русском тексте — «ёлочка».', ref: [], source: SRC_TYPO }));
      out.push(makeIssue({ para: ctx.para, start: e, end: e + 1, category: 'typography', ruleId: 'typo.quotes',
        before: text[e], after: close, confidence: 'sure', why: 'Закрывающая кавычка: в русском тексте — «ёлочка».', ref: [], source: SRC_TYPO }));
    }
  }
}

function group(digits) {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += NBSP;
  }
  return out;
}

function numbers(ctx, out) {
  if (!ctx.settings.numbers) return;
  const text = ctx.text;
  const re = /(?<![\d.,:/\-–+№#])(\d{5,9})(?![\d:/\-–]|\.\d)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1];
    if (num[0] === '0') continue;
    const prefix = text.slice(Math.max(0, m.index - 12), m.index);
    if (NUMBER_LABELS.test(prefix)) continue;
    if (/[\u00A0 ]\d{3}$/.test(prefix)) continue; // already part of a grouped number
    const after = text.slice(m.index + num.length, m.index + num.length + 6);
    if (/^[\u00A0 ]\d{3}(?!\d)/.test(after)) continue;
    if (/^\s*(?:г\.|год|года|году|годы|гг\.)/.test(after) && num.length === 5) continue;
    out.push(makeIssue({ para: ctx.para, start: m.index, end: m.index + num.length, category: 'typography', ruleId: 'typo.number-group',
      before: num, after: group(num), confidence: 'sure',
      why: 'Числа от 10 000 разбиваются на группы по три цифры неразрывным пробелом: «150 000».', ref: [], source: SRC_TYPO }));
  }
}

function spacesAndEllipsis(ctx, out) {
  const text = ctx.text;
  let m;
  const dbl = /[ ]{2,}/g;
  while ((m = dbl.exec(text)) !== null) {
    if (m.index === 0) continue;
    out.push(makeIssue({ para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'typography', ruleId: 'typo.double-space',
      before: m[0], after: ' ', confidence: 'sure', why: 'Двойной пробел.', ref: [], source: SRC_TYPO }));
  }
  const ell = /\.{3,}/g;
  while ((m = ell.exec(text)) !== null) {
    out.push(makeIssue({ para: ctx.para, start: m.index, end: m.index + m[0].length, category: 'typography', ruleId: 'typo.ellipsis',
      before: m[0], after: '…', confidence: 'sure', why: 'Многоточие — один знак «…», а не три точки.', ref: [185], source: undefined }));
  }
}

function yo(ctx, out) {
  const mode = ctx.settings.yo;
  if (!mode || mode === 'off') return;
  const yoRules = ctx.rules.yo || { meaning: [], neverTouch: [] };
  const never = new Set(yoRules.neverTouch || []);
  const user = morph.state.user;
  const extra = morph.state.extra;
  if (mode === 'never') {
    for (const tok of ctx.tokens) {
      if (tok.type !== 'word' || !/[ёЁ]/.test(tok.text)) continue;
      if (user.has(tok.lower)) continue;
      const after = tok.text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
      out.push(makeIssue({ para: ctx.para, start: tok.start, end: tok.end, category: 'typography', ruleId: 'typo.yo-never',
        before: tok.text, after, confidence: 'sure', why: 'По настройке профиля буква «ё» заменяется на «е».', ref: [10] }));
    }
    return;
  }
  if (mode === 'always') {
    for (const tok of ctx.tokens) {
      if (tok.type !== 'word' || tok.allCaps || !/[еЕ]/.test(tok.text) || /[ёЁ]/.test(tok.text) || tok.text.length < 2) continue;
      if (never.has(tok.lower) || user.has(tok.lower) || extra.has(tok.lower)) continue;
      const strict = Az.Morph(tok.text, { parsers: ['Dictionary'], replacements: {}, stutter: 0 });
      if (strict.length) continue; // the е-form exists on its own
      const withYo = Az.Morph(tok.text, { parsers: ['Dictionary'], stutter: 0 });
      const hit = withYo.find((p) => /ё/.test(String(p.word)));
      if (!hit) continue;
      const after = matchCase(tok.text, String(hit.word));
      if (after === tok.text) continue;
      out.push(makeIssue({ para: ctx.para, start: tok.start, end: tok.end, category: 'typography', ruleId: 'typo.yo',
        before: tok.text, after, confidence: 'sure', why: `В словаре это слово пишется через «ё»: «${after}».`, ref: [10] }));
    }
    return;
  }
  // 'meaning'
  const map = new Map((yoRules.meaning || []).map((it) => [it.e, it]));
  for (const tok of ctx.tokens) {
    if (tok.type !== 'word' || tok.allCaps) continue;
    const it = map.get(tok.lower);
    if (!it || user.has(tok.lower)) continue;
    out.push(makeIssue({ para: ctx.para, start: tok.start, end: tok.end, category: 'typography', ruleId: 'typo.yo-meaning',
      before: tok.text, after: matchCase(tok.text, it.yo), confidence: 'check',
      why: `Буква «ё» здесь различает смысл: ${it.note}. Если имеется в виду второе значение, поставьте «ё».`, ref: [10] }));
  }
}

/**
 * Run typography checks for one paragraph.
 * @param {object} ctx
 * @returns {object[]}
 */
function check(ctx) {
  const out = [];
  if (ctx.settings.dash === 'em') dashes(ctx, out);
  quotes(ctx, out);
  numbers(ctx, out);
  spacesAndEllipsis(ctx, out);
  yo(ctx, out);
  return out;
}

const SHORT_WORDS = '(?:в|во|к|ко|с|со|у|о|об|на|по|за|из|от|до|не|ни|и|а|но|же|ли|бы|то|да|уж|ну|ль|б|ж|иль)';
const UNITS = '(?:г|кг|мг|т|м|км|см|мм|дм|га|л|мл|с|сек|мин|ч|ч\\.|руб|руб\\.|р\\.|коп|коп\\.|тыс|тыс\\.|млн|млрд|шт|шт\\.|%|°C|°|лет|год|года|году|годы|гг\\.|века|в\\.|чел|чел\\.|экз|экз\\.|стр\\.|с\\.)';

/**
 * Insert non-breaking spaces: after short prepositions/conjunctions, before
 * particles, before em dashes, between a number and its unit/noun, in
 * initials and common abbreviations.
 * @param {string} text
 * @returns {string}
 */
function applyNbsp(text) {
  if (typeof text !== 'string' || !text) return text || '';
  let t = text;
  t = t.replace(new RegExp(`(^|[\\s(«„"'\\u00A0—–-])(${SHORT_WORDS}) (?=\\S)`, 'giu'), (m, pre, w) => `${pre}${w}${NBSP}`);
  t = t.replace(/ (же|ли|бы|б|ж|ль)(?=[\s.,;:!?…)»]|$)/giu, (m, w) => `${NBSP}${w}`);
  t = t.replace(/ —/g, `${NBSP}—`);
  t = t.replace(/^(—|–|-) /gm, `$1${NBSP}`);
  t = t.replace(new RegExp(`(\\d) (${UNITS})(?![\\p{L}])`, 'giu'), (m, d, u) => `${d}${NBSP}${u}`);
  t = t.replace(/(\d) (?=\d{3}(?!\d))/g, `$1${NBSP}`);
  t = t.replace(/(\d) (?=[а-яё])/giu, (m, d) => `${d}${NBSP}`);
  t = t.replace(/(№|§) (?=\d)/g, `$1${NBSP}`);
  t = t.replace(/(?<![\p{L}\p{N}])([А-ЯЁ])\. (?=[А-ЯЁ][а-яё.])/gu, `$1.${NBSP}`);
  t = t.replace(/(?<![\p{L}\p{N}])(т)\. (?=(?:е|д|п|к|н|о)\.)/giu, `$1.${NBSP}`);
  t = t.replace(/(?<![\p{L}\p{N}])и (?=т\.)/giu, `и${NBSP}`);
  // «г. Москва», «д. 5», «ул. Ленина» — but not the tail of «т. д.» / «т. е.» before a new sentence
  t = t.replace(/(?<![\p{L}\p{N}])(?<!т\.[  ])(г|ул|им|д|стр|кв|пос|с|р)\. (?=[А-ЯЁ\d])/gu, `$1.${NBSP}`);
  return t;
}

module.exports = { check, applyNbsp, NBSP };
