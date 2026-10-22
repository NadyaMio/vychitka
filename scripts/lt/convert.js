#!/usr/bin/env node
'use strict';

/**
 * Convert LanguageTool Russian pattern rules (grammar.xml, LGPL 2.1+) into
 * bases/rules/lt-punct.json for the «Вычитка» engine (src/engine/ltrules.js).
 *
 *   node scripts/lt/convert.js <path/to/grammar.xml> [--out bases/rules/lt-punct.json] [--dump] [--fresh]
 *
 * Only the categories «Пунктуация» (PUNCTUATION) and, from «Типографика»
 * (TYPOGRAPHY), the rules about punctuation marks that the engine does not
 * already have, are converted. Rules that use features we do not interpret
 * (Java filters, synthesis via postag_replace, regexp_replace in <match>,
 * token references with skip, …) are written to `skipped` with a reason.
 *
 * Calibration results (status.enabled / status.confidence / status.reason) are
 * written by scripts/lt/calibrate.js; this converter keeps them from the
 * existing JSON by rule key unless --fresh is given.
 *
 * No dependencies: the file is parsed by a small XML reader below (the LT
 * grammar file is plain XML with an internal DTD subset of ENTITY declarations).
 */

const fs = require('node:fs');
const path = require('node:path');
const { WHY_BY_GROUP, REF_BY_GROUP, TYPOGRAPHY_INCLUDE, TYPOGRAPHY_SKIP } = require('./notes');
const { javaRegexToJs } = require('../../src/engine/ltrules');

const SOURCE_URL = 'https://raw.githubusercontent.com/languagetool-org/languagetool/master/languagetool-language-modules/ru/src/main/resources/org/languagetool/rules/ru/grammar.xml';

/* ------------------------------------------------------------------ */
/* Minimal XML parser                                                   */
/* ------------------------------------------------------------------ */

const BUILTIN_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Expand character and named entity references.
 * @param {string} s
 * @param {Record<string,string>} entities
 * @param {number} [depth]
 * @returns {string}
 */
function expandEntities(s, entities, depth = 0) {
  if (depth > 8) throw new Error('Entity expansion too deep');
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_][\w.-]*);/g, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (BUILTIN_ENTITIES[name] !== undefined) return BUILTIN_ENTITIES[name];
    if (entities[name] !== undefined) return expandEntities(entities[name], entities, depth + 1);
    throw new Error(`Unknown entity &${name};`);
  });
}

/**
 * Parse an XML document into a tree: { name, attrs, children: Array<node|string> }.
 * Supports prolog, comments, CDATA, DOCTYPE with internal ENTITY declarations.
 * @param {string} src
 * @returns {{ root: object, entities: Record<string,string> }}
 */
function parseXml(src) {
  const entities = {};
  let i = 0;
  const n = src.length;
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let textStart = -1;

  const flushText = (end) => {
    if (textStart >= 0 && end > textStart) {
      const raw = src.slice(textStart, end);
      stack[stack.length - 1].children.push(expandEntities(raw, entities));
    }
    textStart = -1;
  };

  while (i < n) {
    if (src[i] !== '<') {
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    flushText(i);
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) throw new Error('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) throw new Error('Unterminated CDATA');
      stack[stack.length - 1].children.push(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) throw new Error('Unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!DOCTYPE', i)) {
      // find the end: either '>' or '[ ... ]>' with the internal subset
      let j = i + 9;
      let depth = 0;
      let inQuote = null;
      let inDecl = false;
      for (; j < n; j++) {
        const ch = src[j];
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
        } else if (src.startsWith('<!--', j)) {
          const end = src.indexOf('-->', j + 4);
          if (end < 0) throw new Error('Unterminated comment in DOCTYPE');
          j = end + 2;
        } else if (!inDecl && src.startsWith('<!', j)) inDecl = true;
        else if (inDecl && (ch === '"' || ch === "'")) inQuote = ch;
        else if (inDecl && ch === '>') inDecl = false;
        else if (!inDecl && ch === '[') depth++;
        else if (!inDecl && ch === ']') depth--;
        else if (!inDecl && ch === '>' && depth === 0) break;
      }
      const subset = src.slice(i, j);
      const entRe = /<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
      let m;
      while ((m = entRe.exec(subset)) !== null) entities[m[1]] = m[2] !== undefined ? m[2] : m[3];
      i = j + 1;
      continue;
    }
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i);
      const name = src.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Mismatched closing tag </${name}> (open: ${top && top.name}) at ${i}`);
      i = end + 1;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(i + 1, j);
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '/' && src[j + 1] === '>') { selfClosing = true; j += 2; break; }
      if (src[j] === '>') { j++; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const aname = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '=') throw new Error(`Attribute ${aname} without value in <${name}> at ${i}`);
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") throw new Error(`Unquoted attribute ${aname} in <${name}> at ${i}`);
      const close = src.indexOf(q, j + 1);
      attrs[aname] = expandEntities(src.slice(j + 1, close), entities);
      j = close + 1;
    }
    const el = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
    i = j;
  }
  flushText(n);
  if (stack.length !== 1) throw new Error(`Unclosed element <${stack[stack.length - 1].name}>`);
  const rootEl = root.children.find((c) => typeof c === 'object');
  return { root: rootEl, entities };
}

const isEl = (c) => typeof c === 'object' && c !== null;
const childEls = (el, name) => el.children.filter((c) => isEl(c) && (!name || c.name === name));
const childEl = (el, name) => el.children.find((c) => isEl(c) && c.name === name) || null;
const textOf = (el) => el.children.map((c) => (isEl(c) ? textOf(c) : c)).join('');

/* ------------------------------------------------------------------ */
/* Rule model                                                           */
/* ------------------------------------------------------------------ */

const yes = (v) => v === 'yes';

/**
 * Token text as LanguageTool reads it: all whitespace removed (multi-line
 * regexps are wrapped in the XML).
 */
function tokenText(el) {
  return el.children.filter((c) => !isEl(c)).join('').replace(/\s+/g, '');
}

function parseException(el, inheritedCs) {
  const a = el.attrs;
  const ex = { text: tokenText(el) };
  if (yes(a.regexp)) ex.regexp = true;
  if (yes(a.negate)) ex.negate = true;
  if (yes(a.inflected)) ex.inflected = true;
  if (a.postag) ex.postag = a.postag;
  if (yes(a.postag_regexp)) ex.postagRegexp = true;
  if (yes(a.negate_pos)) ex.negatePos = true;
  if (a.scope && a.scope !== 'current') ex.scope = a.scope;
  if (a.case_sensitive !== undefined) ex.cs = yes(a.case_sensitive);
  else if (inheritedCs) ex.cs = true;
  if (a.spacebefore) ex.spaceBefore = a.spacebefore;
  if (a.chunk) ex.chunk = a.chunk;
  if (!ex.text) delete ex.text;
  return ex;
}

/**
 * @returns {{ token: object, unsupported: string[] }}
 */
function parseToken(el, inheritedCs) {
  const a = el.attrs;
  const t = { text: tokenText(el) };
  const unsupported = [];
  if (yes(a.regexp)) t.regexp = true;
  if (yes(a.negate)) t.negate = true;
  if (yes(a.inflected)) t.inflected = true;
  if (a.postag) t.postag = a.postag;
  if (yes(a.postag_regexp)) t.postagRegexp = true;
  if (yes(a.negate_pos)) t.negatePos = true;
  if (a.skip !== undefined) t.skip = parseInt(a.skip, 10);
  if (a.min !== undefined) t.min = parseInt(a.min, 10);
  if (a.max !== undefined) t.max = parseInt(a.max, 10);
  if (a.spacebefore) t.spaceBefore = a.spacebefore;
  if (a.chunk) t.chunk = a.chunk;
  if (a.case_sensitive !== undefined) t.cs = yes(a.case_sensitive);
  else if (inheritedCs) t.cs = true;
  const exceptions = childEls(el, 'exception').map((e) => parseException(e, t.cs));
  if (exceptions.length) t.exceptions = exceptions;
  const ref = childEl(el, 'match');
  if (ref) {
    // token reference: this token must repeat another pattern token (0-based `no`)
    t.ref = parseInt(ref.attrs.no, 10);
    const extra = Object.keys(ref.attrs).filter((k) => k !== 'no');
    if (extra.length) unsupported.push(`token reference with ${extra.join(',')}`);
  }
  for (const k of Object.keys(a)) {
    if (!['regexp', 'negate', 'inflected', 'postag', 'postag_regexp', 'negate_pos', 'skip', 'min', 'max', 'spacebefore', 'chunk', 'case_sensitive'].includes(k)) {
      unsupported.push(`token attribute ${k}`);
    }
  }
  if (!t.text) delete t.text;
  return { token: t, unsupported };
}

/**
 * Flatten a <pattern>/<antipattern> body into a token list, recording the
 * marker span and unify blocks.
 */
function parseSequence(el, inheritedCs) {
  const tokens = [];
  const unify = [];
  const unsupported = [];
  let marker = null;
  const walk = (node, inMarker, unifyCtx) => {
    for (const c of node.children) {
      if (!isEl(c)) continue;
      if (c.name === 'token') {
        const { token, unsupported: u } = parseToken(c, inheritedCs);
        unsupported.push(...u);
        if (inMarker) marker = marker ? [marker[0], tokens.length] : [tokens.length, tokens.length];
        if (unifyCtx) unifyCtx.idx.push(tokens.length);
        tokens.push(token);
      } else if (c.name === 'marker') {
        walk(c, true, unifyCtx);
      } else if (c.name === 'unify') {
        const ctx = { features: childEls(c, 'feature').map((f) => f.attrs.id), negate: yes(c.attrs.negate), idx: [] };
        if (childEls(c, 'feature').some((f) => f.attrs.type)) unsupported.push('unify feature type');
        walk(c, inMarker, ctx);
        if (ctx.idx.length) unify.push({ tokens: ctx.idx, features: ctx.features, negate: ctx.negate });
      } else if (c.name === 'unify-ignore') {
        walk(c, inMarker, null); // tokens stay in the pattern but take no part in the unification
      } else if (c.name === 'or') {
        const alts = [];
        for (const t of childEls(c, 'token')) {
          const { token, unsupported: u } = parseToken(t, inheritedCs);
          unsupported.push(...u);
          alts.push(token);
        }
        const group = { or: alts };
        if (alts.some((t) => t.skip || t.min !== undefined || t.max !== undefined)) unsupported.push('or-group with skip/min/max');
        if (inMarker) marker = marker ? [marker[0], tokens.length] : [tokens.length, tokens.length];
        if (unifyCtx) unifyCtx.idx.push(tokens.length);
        tokens.push(group);
      } else if (c.name === 'and') {
        unsupported.push('and-group');
      } else if (c.name === 'feature') {
        // handled in unify
      } else {
        unsupported.push(`element <${c.name}> in pattern`);
      }
    }
  };
  walk(el, false, null);
  return { tokens, marker, unify, unsupported };
}

/**
 * Parse <message> / <suggestion> content into parts:
 *   string | { m: tokenNo (1-based), skipped?: 'all'|'none'|'following', case?: string } | { s: suggestionIndex }
 */
function parseParts(el, suggestions, unsupported, keepEdges = false) {
  const parts = [];
  const pushText = (s) => {
    if (!s) return;
    // \N back-references inside text
    const re = /\\(\d+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      parts.push({ m: parseInt(m[1], 10) });
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push(s.slice(last));
  };
  for (const c of el.children) {
    if (!isEl(c)) {
      pushText(c.replace(/\s*\n\s*/g, ' '));
    } else if (c.name === 'match') {
      const a = c.attrs;
      const part = { m: parseInt(a.no, 10) };
      if (a.include_skipped) part.skipped = a.include_skipped;
      if (a.case_conversion) part.case = a.case_conversion;
      if (a.regexp_match || a.regexp_replace) {
        part.re = [a.regexp_match || '', a.regexp_replace || ''];
        unsupported.push('match regexp_replace');
      }
      for (const k of Object.keys(a)) {
        if (!['no', 'include_skipped', 'case_conversion', 'regexp_match', 'regexp_replace'].includes(k)) unsupported.push(`match attribute ${k}`);
      }
      parts.push(part);
    } else if (c.name === 'suggestion') {
      const sub = parseParts(c, null, unsupported, true); // leading/trailing spaces are part of the replacement
      if (suggestions) {
        suggestions.push(sub);
        parts.push({ s: suggestions.length - 1 });
      } else {
        unsupported.push('nested suggestion');
      }
    } else {
      unsupported.push(`element <${c.name}> in message`);
    }
  }
  // merge adjacent strings, trim ends
  const merged = [];
  for (const p of parts) {
    if (typeof p === 'string' && typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] += p;
    else merged.push(p);
  }
  if (!keepEdges) {
    if (typeof merged[0] === 'string') merged[0] = merged[0].replace(/^\s+/, '');
    if (typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] = merged[merged.length - 1].replace(/\s+$/, '');
  }
  return merged.filter((p) => p !== '');
}

/** Parse an <example>: text, marker char span, corrections. */
function parseExample(el) {
  let text = '';
  let marker = null;
  for (const c of el.children) {
    if (!isEl(c)) text += c;
    else if (c.name === 'marker') {
      const inner = textOf(c);
      marker = [text.length, text.length + inner.length];
      text += inner;
    } else text += textOf(c);
  }
  const ex = { text };
  const a = el.attrs;
  const incorrect = a.correction !== undefined || a.type === 'incorrect';
  if (incorrect) {
    ex.incorrect = true;
    ex.marker = marker;
    ex.corrections = a.correction ? a.correction.split('|') : [];
  }
  return ex;
}

/** Regexps (token text or postag) that the engine's Java→JS translation cannot compile. */
function invalidRegexps(sequences) {
  const bad = [];
  const checkSpec = (s) => {
    if (s.regexp && s.text && !javaRegexToJs(s.text, !!s.cs)) bad.push(s.text);
    if (s.postagRegexp && s.postag && !javaRegexToJs(s.postag, true)) bad.push(s.postag);
    for (const e of s.exceptions || []) checkSpec(e);
  };
  for (const tokens of sequences) for (const t of tokens) (t.or ? t.or : [t]).forEach(checkSpec);
  return bad;
}

/**
 * Convert one <rule> element.
 * @param {object} el
 * @param {object} ctx { group, groupAntipatterns, category, sub }
 */
function convertRule(el, ctx) {
  const a = el.attrs;
  const id = a.id || (ctx.group && ctx.group.id);
  const name = a.name || (ctx.group && ctx.group.name) || '';
  const unsupported = [];
  const patternEl = childEl(el, 'pattern');
  if (!patternEl) return { skipped: { id, name, reason: 'no <pattern> (regexp rule)' } };
  const patternCs = yes(patternEl.attrs.case_sensitive);
  const seq = parseSequence(patternEl, patternCs);
  unsupported.push(...seq.unsupported);
  const antipatterns = [];
  for (const ap of [...(ctx.groupAntipatterns || []), ...childEls(el, 'antipattern')]) {
    const s = parseSequence(ap, yes(ap.attrs.case_sensitive));
    unsupported.push(...s.unsupported.map((u) => `antipattern: ${u}`));
    antipatterns.push({ tokens: s.tokens, marker: s.marker, unify: s.unify });
  }
  if (childEl(el, 'filter')) unsupported.push('Java <filter>');
  if (childEl(el, 'disambig')) unsupported.push('<disambig>');
  for (const bad of invalidRegexps([seq.tokens, ...antipatterns.map((ap) => ap.tokens)])) unsupported.push(`regexp not translatable to JS: /${bad}/`);
  const suggestions = [];
  const messageEl = childEl(el, 'message');
  const message = messageEl ? parseParts(messageEl, suggestions, unsupported) : [];
  for (const s of childEls(el, 'suggestion')) suggestions.push(parseParts(s, null, unsupported, true));
  const shortEl = childEl(el, 'short');
  const urlEl = childEl(el, 'url');
  const examples = childEls(el, 'example').map(parseExample);
  const rule = {
    key: ctx.group ? `${id}[${ctx.sub}]` : id,
    id,
    name,
    category: ctx.category,
    pattern: seq.tokens,
  };
  if (ctx.group) rule.sub = ctx.sub;
  if (seq.marker) rule.marker = seq.marker;
  if (seq.unify.length) rule.unify = seq.unify;
  if (antipatterns.length) rule.antipatterns = antipatterns;
  rule.message = message;
  if (suggestions.length) rule.suggestions = suggestions;
  if (shortEl) rule.short = textOf(shortEl).trim();
  if (urlEl) rule.url = textOf(urlEl).trim();
  const def = a.default || (ctx.group && ctx.group.default);
  if (def && def !== 'on') rule.ltDefault = def;
  const tags = a.tags || (ctx.group && ctx.group.tags);
  if (tags) rule.ltTags = tags.split(/\s+/);
  rule.examples = examples;
  const uniq = [...new Set(unsupported)];
  if (uniq.length) return { skipped: { id, name, key: rule.key, reason: `unsupported: ${uniq.join('; ')}` } };
  return { rule };
}

/* ------------------------------------------------------------------ */
/* Category walk                                                        */
/* ------------------------------------------------------------------ */

function convertCategory(catEl, categoryId, filter) {
  const rules = [];
  const skipped = [];
  const visit = (el, group, groupAntipatterns) => {
    for (const c of childEls(el)) {
      if (c.name === 'rulegroup') {
        const g = { id: c.attrs.id, name: c.attrs.name, default: c.attrs.default, tags: c.attrs.tags };
        const gap = childEls(c, 'antipattern');
        let sub = 0;
        for (const r of childEls(c, 'rule')) {
          sub++;
          const f = filter(g.id, r);
          if (f) { skipped.push({ id: g.id, key: `${g.id}[${sub}]`, name: g.name, reason: f }); continue; }
          const res = convertRule(r, { group: g, groupAntipatterns: gap, category: categoryId, sub });
          if (res.rule) rules.push(res.rule); else skipped.push(res.skipped);
        }
      } else if (c.name === 'rule') {
        const f = filter(c.attrs.id, c);
        if (f) { skipped.push({ id: c.attrs.id, name: c.attrs.name, reason: f }); continue; }
        const res = convertRule(c, { group: null, category: categoryId });
        if (res.rule) rules.push(res.rule); else skipped.push(res.skipped);
      }
    }
  };
  visit(catEl, null, []);
  return { rules, skipped };
}

/* ------------------------------------------------------------------ */
/* Annotation: why / ref / status                                       */
/* ------------------------------------------------------------------ */

function annotate(rule, previous) {
  const why = WHY_BY_GROUP[rule.key] || WHY_BY_GROUP[rule.id];
  if (why) rule.why = why;
  const ref = REF_BY_GROUP[rule.key] || REF_BY_GROUP[rule.id];
  rule.ref = Array.isArray(ref) ? ref.slice() : [];
  const prev = previous && previous.get(rule.key);
  if (prev && prev.status) rule.status = prev.status;
}

/* ------------------------------------------------------------------ */
/* Dump (for review)                                                    */
/* ------------------------------------------------------------------ */

function tokenToString(t) {
  if (t.or) return `(${t.or.map(tokenToString).join(' | ')})`;
  const bits = [];
  if (t.text !== undefined) bits.push(`${t.negate ? '!' : ''}${t.inflected ? '~' : ''}${t.regexp ? '/' : '"'}${t.text}${t.regexp ? '/' : '"'}`);
  if (t.postag) bits.push(`${t.negatePos ? '!' : ''}pos${t.postagRegexp ? '~' : '='}${t.postag}`);
  if (t.skip) bits.push(`skip${t.skip}`);
  if (t.min !== undefined || t.max !== undefined) bits.push(`{${t.min ?? 1},${t.max ?? 1}}`);
  if (t.spaceBefore) bits.push(`sp:${t.spaceBefore}`);
  if (t.chunk) bits.push(`chunk:${t.chunk}`);
  if (t.ref !== undefined) bits.push(`ref:${t.ref}`);
  if (t.cs) bits.push('cs');
  if (t.exceptions) {
    for (const e of t.exceptions) {
      const eb = [];
      if (e.text !== undefined) eb.push(`${e.negate ? '!' : ''}${e.inflected ? '~' : ''}${e.regexp ? '/' : '"'}${e.text}${e.regexp ? '/' : '"'}`);
      if (e.postag) eb.push(`${e.negatePos ? '!' : ''}pos${e.postagRegexp ? '~' : '='}${e.postag}`);
      if (e.spaceBefore) eb.push(`sp:${e.spaceBefore}`);
      bits.push(`exc${e.scope ? `[${e.scope}]` : ''}(${eb.join(' ')})`);
    }
  }
  return `<${bits.join(' ') || 'any'}>`;
}

function partsToString(parts) {
  return parts.map((p) => (typeof p === 'string' ? p : p.m !== undefined ? `\\${p.m}${p.skipped ? `+${p.skipped}` : ''}${p.case ? `^${p.case}` : ''}` : `{S${p.s + 1}}`)).join('');
}

function dumpRule(r) {
  const lines = [];
  lines.push(`=== ${r.key}  «${r.name}»  [${r.category}${r.ltDefault ? ` default=${r.ltDefault}` : ''}${r.ltTags ? ` tags=${r.ltTags}` : ''}]`);
  lines.push(`  pattern: ${r.pattern.map((t, i) => `${i + 1}:${tokenToString(t)}`).join(' ')}${r.marker ? `  marker=${r.marker[0] + 1}..${r.marker[1] + 1}` : ''}`);
  if (r.unify) for (const u of r.unify) lines.push(`  unify${u.negate ? '!' : ''}(${u.features}) tokens ${u.tokens.map((x) => x + 1)}`);
  if (r.antipatterns) for (const ap of r.antipatterns) lines.push(`  anti: ${ap.tokens.map((t, i) => `${i + 1}:${tokenToString(t)}`).join(' ')}${ap.marker ? `  marker=${ap.marker[0] + 1}..${ap.marker[1] + 1}` : ''}`);
  lines.push(`  message: ${partsToString(r.message)}`);
  if (r.suggestions) r.suggestions.forEach((s, i) => lines.push(`  S${i + 1}: ${partsToString(s)}`));
  for (const e of r.examples) {
    if (e.incorrect) lines.push(`  ✗ ${e.text.slice(0, e.marker ? e.marker[0] : 0)}[${e.marker ? e.text.slice(e.marker[0], e.marker[1]) : ''}]${e.text.slice(e.marker ? e.marker[1] : 0)}  → ${JSON.stringify(e.corrections)}`);
    else lines.push(`  ✓ ${e.text}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* main                                                                 */
/* ------------------------------------------------------------------ */

function main(argv) {
  const args = argv.slice(2);
  const input = args.find((x) => !x.startsWith('--'));
  if (!input) {
    console.error('usage: node scripts/lt/convert.js <grammar.xml> [--out file] [--dump] [--fresh]');
    process.exit(2);
  }
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : path.resolve(__dirname, '..', '..', 'bases', 'rules', 'lt-punct.json');
  const dump = args.includes('--dump');
  const fresh = args.includes('--fresh');

  const src = fs.readFileSync(input, 'utf8');
  const { root } = parseXml(src);
  if (!root || root.name !== 'rules') throw new Error('Root element <rules> not found');
  const categories = childEls(root, 'category');
  const punct = categories.find((c) => c.attrs.id === 'PUNCTUATION');
  const typo = categories.find((c) => c.attrs.id === 'TYPOGRAPHY');
  if (!punct) throw new Error('Category PUNCTUATION not found');

  const noFilter = () => null;
  const typoFilter = (id) => {
    if (TYPOGRAPHY_INCLUDE.includes(id)) return null;
    return TYPOGRAPHY_SKIP[id] || 'typography rule outside the scope (not about commas/dashes/colons)';
  };
  const p = convertCategory(punct, 'PUNCTUATION', noFilter);
  const t = typo ? convertCategory(typo, 'TYPOGRAPHY', typoFilter) : { rules: [], skipped: [] };
  const rules = [...p.rules, ...t.rules];
  const skipped = [...p.skipped, ...t.skipped];

  let previous = null;
  if (!fresh && fs.existsSync(out)) {
    try {
      const old = JSON.parse(fs.readFileSync(out, 'utf8'));
      previous = new Map((old.rules || []).map((r) => [r.key, r]));
    } catch (err) {
      console.warn(`Cannot reuse calibration from ${out}: ${err.message}`);
    }
  }
  for (const r of rules) annotate(r, previous);

  if (dump) {
    console.log(rules.map(dumpRule).join('\n\n'));
    console.log('\n=== skipped ===');
    for (const s of skipped) console.log(`${s.key || s.id}: ${s.reason}`);
    return;
  }

  const examples = rules.reduce((n, r) => n + r.examples.length, 0);
  const groups = new Set(rules.map((r) => r.id));
  const data = {
    _comment: 'Правила пунктуации LanguageTool (русский модуль), сконвертированные scripts/lt/convert.js из grammar.xml. Интерпретатор — src/engine/ltrules.js; калибровка (status) — scripts/lt/calibrate.js. Не редактировать вручную: правки — в notes.js и повторная конвертация.',
    source: {
      name: 'LanguageTool',
      url: 'https://languagetool.org',
      file: SOURCE_URL,
      license: 'LGPL 2.1+',
      copyright: 'Russian grammar rules © 2008–2023 Yakov Reztsov and LanguageTool contributors',
      converted: new Date().toISOString().slice(0, 10),
    },
    counts: { rules: rules.length, groups: groups.size, examples, skipped: skipped.length },
    rules,
    skipped,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  console.log(`${rules.length} rules in ${groups.size} groups, ${examples} examples, ${skipped.length} skipped → ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) main(process.argv);

module.exports = { parseXml, convertCategory, dumpRule };
