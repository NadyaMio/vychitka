#!/usr/bin/env node
'use strict';

/**
 * Punctuation benchmark for the «Вычитка» engine.
 *
 * Reads .cache/eval/punct.jsonl and clean.jsonl (built by build-punct-set.py),
 * runs engine.check() with the default settings and scores only the
 * punctuation part of its output:
 *
 *   recall     share of reference punctuation edits the engine found
 *   precision  share of the engine's punctuation changes that match a reference edit
 *   clean FP   punctuation changes on sentences that need none, per 1 000 sentences
 *
 * Matching works on the gaps between words (same tokenisation as the builder):
 * an engine issue is applied to the sentence, every gap whose sign classes or
 * spacing changed is one «change»; a change hits a reference edit when it lands
 * on the same gap and inserts/removes the same signs (or a subset of them), or
 * produces exactly the reference gap. Glyph-only issues («-» → «—», «"» → «»»)
 * and issues that touch words are not punctuation changes and are ignored.
 * A «near-miss» is a change on a gap the reference also edits, but differently.
 *
 * Out of the headline numbers (reported apart, --with-terminal puts them back):
 * final . ! ? … at the end of the text and sentence boundaries inserted before
 * an already capitalised word — the engine does not police either.
 * Every number is given for confidence 'sure' alone and for 'sure' + 'check'.
 *
 * Usage
 *   node scripts/eval/eval-punct.js [--set dev|test|all] [--limit N] [--json out.json]
 *        [--diff N] [--review N] [--pure] [--source sage|russian_gec|…]
 *        [--domain SUBSTR] [--exclude-domain SUBSTR] [--with-terminal]
 *        [--engine DIR] [--seed N] [--quiet]
 *
 *   --diff N     print N random misses and N random false positives with context
 *   --review N   N random false positives for manual review (default 30; printed
 *                without --json, otherwise stored in the JSON under `review`)
 *   --domain / --exclude-domain   keep / drop items whose domain contains SUBSTR
 *                (e.g. --exclude-domain MedSpellchecker — templated medical records)
 *   --engine DIR another checkout of the project (src/engine + bases) to score with
 *                the same data — e.g. a `git worktree` of the previous release
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, '.cache', 'eval');
const CHUNK = 500;
const DEFAULT_REVIEW = 30;
const DEFAULT_SEED = 20261022;
const CONTEXT_CHARS = 70;
const MODES = ['sure', 'all'];

/* ---------- tokenisation (mirror of build-punct-set.py) ---------- */

const WORD_RE = /[\p{L}\p{N}]+/gu;
const QUOTES = new Set('«»„“”"‟‘’‚‛‹›\'');
const DASHES_EM = new Set('—―');
const DASHES_SOFT = new Set('-‐‑−–');
const PARENS_OPEN = new Set('([');
const PARENS_CLOSE = new Set(')]');
const SIMPLE = { ',': ',', ';': ';', ':': ':', '!': '!', '?': '?', '…': '…' };
const TERMINAL_CLASSES = new Set('.!?…');
const CLASS_ORDER = ',;:.…!?—hq()o';
const SIGN_GROUPS = [',', '—', ':', ';', 'q', '.', '!?', '…', '()', 'h', 'space'];
const SIGN_NAMES = {
  ',': 'запятая', '—': 'тире', ':': 'двоеточие', ';': 'точка с запятой', 'q': 'кавычки', '.': 'точка',
  '!?': 'воскл./вопр.', '…': 'многоточие', '()': 'скобки', 'h': 'дефис', space: 'пробел',
};

const isSpace = (ch) => /\s/u.test(ch);

function wordKey(word) {
  return word.toLowerCase().replace(/ё/g, 'е');
}

function unmatchedParens(text) {
  const stack = [];
  const bad = new Set();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (PARENS_OPEN.has(ch)) stack.push(i);
    else if (PARENS_CLOSE.has(ch)) {
      if (stack.length) stack.pop();
      else bad.add(i);
    }
  }
  for (const i of stack) bad.add(i);
  return bad;
}

function gapClasses(gap, hasPrev, hasNext, offset, unmatched) {
  const out = [];
  const n = gap.length;
  let i = 0;
  while (i < n) {
    const ch = gap[i];
    if (isSpace(ch)) {
      if (!out.length || out[out.length - 1] !== ' ') out.push(' ');
      i++;
      continue;
    }
    if (ch === '.') {
      let j = i;
      while (j < n && gap[j] === '.') j++;
      out.push(j - i >= 2 ? '…' : '.');
      i = j;
      continue;
    }
    if (SIMPLE[ch]) out.push(SIMPLE[ch]);
    else if (QUOTES.has(ch)) out.push('q');
    else if (DASHES_EM.has(ch)) out.push('—');
    else if (DASHES_SOFT.has(ch)) {
      const leftGlued = (i > 0 && !isSpace(gap[i - 1])) || (i === 0 && hasPrev);
      const rightGlued = (i + 1 < n && !isSpace(gap[i + 1])) || (i + 1 === n && hasNext);
      out.push(leftGlued && rightGlued && hasPrev && hasNext ? 'h' : '—');
    } else if (PARENS_OPEN.has(ch)) out.push(unmatched.has(offset + i) ? 'o' : '(');
    else if (PARENS_CLOSE.has(ch)) out.push(unmatched.has(offset + i) ? 'o' : ')');
    else out.push('o');
    i++;
  }
  const norm = out.join('');
  return { classes: norm.replace(/ /g, ''), norm };
}

/** Words, gaps (N+1) and their class signatures. */
function analyze(text) {
  const words = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) !== null) words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  const gaps = [];
  let prev = 0;
  for (const w of words) {
    gaps.push({ text: text.slice(prev, w.start), start: prev, end: w.start });
    prev = w.end;
  }
  gaps.push({ text: text.slice(prev), start: prev, end: text.length });
  const unmatched = unmatchedParens(text);
  const n = words.length;
  const info = gaps.map((g, k) => gapClasses(g.text, k > 0, k < n, g.start, unmatched));
  return { words, gaps, info, keys: words.map((w) => wordKey(w.text)) };
}

function multisetDiff(a, b) {
  const count = {};
  for (const c of a) count[c] = (count[c] || 0) + 1;
  for (const c of b) count[c] = (count[c] || 0) - 1;
  let out = '';
  for (const c of Object.keys(count).sort()) if (count[c] > 0) out += c.repeat(count[c]);
  return out;
}

function classifyChange(srcClasses, dstClasses) {
  return { added: multisetDiff(dstClasses, srcClasses), removed: multisetDiff(srcClasses, dstClasses) };
}

function isOrthographic(added, removed) {
  const changed = new Set(added + removed);
  if (!changed.size) return false;
  if (changed.has('o')) return true;
  return changed.size === 1 && changed.has('h');
}

function changeType(added, removed) {
  const set = new Set(added + removed);
  if (!set.size) return 'space';
  return [...set].sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b)).join('');
}

function isSubsetMultiset(small, big) {
  return multisetDiff(small, big) === '';
}

/** Sign groups a change type belongs to (',;' → [',', ';'], '(' → ['()']). */
function signGroups(type) {
  if (type === 'space') return ['space'];
  const out = new Set();
  for (const c of type) out.add(c === '(' || c === ')' ? '()' : c === '!' || c === '?' ? '!?' : c);
  return [...out];
}

/* ---------- utilities ---------- */

function parseArgs(argv) {
  const args = { set: 'dev', limit: 0, json: null, diff: 0, review: DEFAULT_REVIEW, pure: false, source: null, domain: null, excludeDomain: null, withTerminal: false, seed: DEFAULT_SEED, quiet: false, engine: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--set') args.set = next();
    else if (a === '--engine') args.engine = path.resolve(next());
    else if (a === '--domain') args.domain = next();
    else if (a === '--exclude-domain') args.excludeDomain = next();
    else if (a === '--limit') args.limit = parseInt(next(), 10);
    else if (a === '--json') args.json = next();
    else if (a === '--diff') args.diff = parseInt(next(), 10);
    else if (a === '--review') args.review = parseInt(next(), 10);
    else if (a === '--pure') args.pure = true;
    else if (a === '--source') args.source = next();
    else if (a === '--with-terminal') args.withTerminal = true;
    else if (a === '--seed') args.seed = parseInt(next(), 10);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['dev', 'test', 'all'].includes(args.set)) throw new Error(`--set must be dev|test|all, got ${args.set}`);
  for (const k of ['limit', 'diff', 'review', 'seed']) if (!Number.isFinite(args[k]) || args[k] < 0) throw new Error(`--${k} must be a non-negative integer`);
  if (!fs.existsSync(path.join(args.engine, 'src', 'engine')) || !fs.existsSync(path.join(args.engine, 'bases'))) throw new Error(`--engine: ${args.engine} has no src/engine or bases`);
  return args;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found — run scripts/eval/fetch.py and scripts/eval/build-punct-set.py first`);
  const out = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`${file}:${i + 1}: bad JSON (${e.message})`); }
  });
  return out;
}

/** Deterministic PRNG (mulberry32) so samples are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(arr, n, rand) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function pct(a, b) {
  return b ? `${(100 * a / b).toFixed(1)}%` : '—';
}

function window(text, start, end, before, after) {
  const a = Math.max(0, start - CONTEXT_CHARS);
  const b = Math.min(text.length, end + CONTEXT_CHARS);
  return `${a > 0 ? '…' : ''}${text.slice(a, start)}⟦${before}→${after}⟧${text.slice(end, b)}${b < text.length ? '…' : ''}`;
}

function gitVersion(dir) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src/engine', 'bases'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha} + незакоммиченные правки движка/баз` : sha;
  } catch { return 'n/a'; }
}

/* ---------- scoring ---------- */

function newBucket() {
  return { refTotal: 0, refHit: 0, changes: 0, tp: 0, fp: 0, near: 0 };
}

function bump(map, key, field, by = 1) {
  if (!map[key]) map[key] = newBucket();
  map[key][field] += by;
}

class Scorer {
  constructor(opts) {
    this.opts = opts;
    this.modes = { sure: Scorer.newMode(), all: Scorer.newMode() };
    this.outside = { terminal: { ref: 0, sure: 0, all: 0 }, boundary: { ref: 0, sure: 0, all: 0 } };
    this.neutralByRule = {};
    this.wordChangeByRule = {};
    this.broken = 0;
    this.unmapped = 0;
    this.misses = [];
    this.fps = [];
    this.nextWord = {}; // missing commas: word after the gap → {total, hit, hitSure}
    this.clean = { sentences: 0, fp: { sure: 0, all: 0 }, byRule: { sure: {}, all: {} }, byType: { sure: {}, all: {} }, bySource: {} };
  }

  static newMode() {
    return { total: newBucket(), byType: {}, byRule: {}, bySource: {}, byKind: {}, fpType: {} };
  }

  /** Reference edits of a case → gap-indexed map. */
  refMap(item, src, ref) {
    const map = new Map();
    for (const e of item.edits) {
      const k = src.gaps.findIndex((g) => g.start === e.start && g.end === e.end);
      if (k < 0) { this.unmapped++; continue; }
      map.set(k, { ...e, k, refNorm: ref.info[k] ? ref.info[k].norm : null });
    }
    return map;
  }

  /** Gap changes produced by one engine issue; null if it is not a punctuation change. */
  issueChanges(text, src, issue) {
    if (text.slice(issue.start, issue.end) !== issue.before) { this.broken++; return null; }
    if (issue.after === issue.before) return [];
    const text2 = text.slice(0, issue.start) + issue.after + text.slice(issue.end);
    const b = analyze(text2);
    if (b.keys.length !== src.keys.length || b.keys.some((k, i) => k !== src.keys[i])) {
      this.wordChangeByRule[issue.ruleId] = (this.wordChangeByRule[issue.ruleId] || 0) + 1;
      return null;
    }
    const n = src.gaps.length;
    const changes = [];
    for (let k = 0; k < n; k++) {
      if (src.info[k].norm === b.info[k].norm) continue;
      const { added, removed } = classifyChange(src.info[k].classes, b.info[k].classes);
      if (isOrthographic(added, removed)) continue;
      const classes = new Set(added + removed);
      const terminal = k === n - 1 && classes.size > 0 && [...classes].every((c) => TERMINAL_CLASSES.has(c));
      changes.push({ k, added, removed, norm: b.info[k].norm, type: changeType(added, removed), terminal });
    }
    if (!changes.length) this.neutralByRule[issue.ruleId] = (this.neutralByRule[issue.ruleId] || 0) + 1;
    return changes;
  }

  static hit(change, refEdit) {
    if (refEdit.refNorm !== null && change.norm === refEdit.refNorm) return true;
    if (!change.added.length && !change.removed.length) return false;
    return isSubsetMultiset(change.added, refEdit.added) && isSubsetMultiset(change.removed, refEdit.removed);
  }

  outsideKind(refEdit) {
    if (this.opts.withTerminal) return null;
    if (refEdit.terminal) return 'terminal';
    if (refEdit.boundary) return 'boundary';
    return null;
  }

  scoreCase(item, issues) {
    const src = analyze(item.src);
    const ref = analyze(item.ref);
    const refEdits = this.refMap(item, src, ref);
    const counted = new Map();
    for (const e of refEdits.values()) {
      const kind = this.outsideKind(e);
      if (kind) this.outside[kind].ref++;
      else counted.set(e.k, e);
    }
    const hitBy = { sure: new Set(), all: new Set() };
    const outsideHit = { sure: new Set(), all: new Set() };
    const changesAll = [];
    for (const issue of issues) {
      const changes = this.issueChanges(item.src, src, issue);
      if (!changes) continue;
      for (const ch of changes) changesAll.push({ ...ch, issue });
    }
    for (const ch of changesAll) {
      const refEdit = refEdits.get(ch.k);
      const modes = ch.issue.confidence === 'sure' ? MODES : ['all'];
      if (refEdit && this.outsideKind(refEdit)) {
        if (Scorer.hit(ch, refEdit)) for (const m of modes) outsideHit[m].add(ch.k);
        continue;
      }
      if (ch.terminal && !this.opts.withTerminal && !refEdit) continue; // the engine touched only the final mark
      const isHit = refEdit ? Scorer.hit(ch, refEdit) : false;
      for (const m of modes) {
        const mode = this.modes[m];
        const field = isHit ? 'tp' : 'fp';
        for (const [map, key] of [[mode.byRule, ch.issue.ruleId], [mode.bySource, item.source], [mode.byKind, item.kind]]) {
          bump(map, key, 'changes');
          bump(map, key, field);
          if (!isHit && refEdit) bump(map, key, 'near');
        }
        mode.total.changes++;
        mode.total[field]++;
        if (!isHit) {
          bump(mode.fpType, ch.type, 'fp');
          if (refEdit) { mode.total.near++; bump(mode.fpType, ch.type, 'near'); }
        }
        if (isHit) hitBy[m].add(ch.k);
      }
      if (!isHit) {
        this.fps.push({
          id: item.id, source: item.source, kind: item.kind, ruleId: ch.issue.ruleId, confidence: ch.issue.confidence,
          type: ch.type, nearMiss: !!refEdit, refGap: refEdit ? refEdit.after : src.gaps[ch.k].text,
          context: window(item.src, ch.issue.start, ch.issue.end, ch.issue.before, ch.issue.after), ref: item.ref,
        });
      }
    }
    for (const m of MODES) {
      const mode = this.modes[m];
      for (const e of counted.values()) {
        const hit = hitBy[m].has(e.k);
        for (const [map, key] of [[mode.byType, e.type], [mode.bySource, item.source], [mode.byKind, item.kind]]) {
          bump(map, key, 'refTotal');
          if (hit) bump(map, key, 'refHit');
        }
        mode.total.refTotal++;
        if (hit) mode.total.refHit++;
      }
      for (const k of outsideHit[m]) this.outside[this.outsideKind(refEdits.get(k))][m]++;
    }
    for (const e of counted.values()) {
      if (e.type === ',' && e.added === ',' && e.k < src.words.length) {
        const w = src.keys[e.k];
        if (!this.nextWord[w]) this.nextWord[w] = { total: 0, hit: 0, hitSure: 0 };
        this.nextWord[w].total++;
        if (hitBy.all.has(e.k)) this.nextWord[w].hit++;
        if (hitBy.sure.has(e.k)) this.nextWord[w].hitSure++;
      }
      if (!hitBy.all.has(e.k)) {
        this.misses.push({
          id: item.id, source: item.source, kind: item.kind, type: e.type, pos: e.pos,
          nextWord: e.k < src.words.length ? src.words[e.k].text : '', prevWord: e.k > 0 ? src.words[e.k - 1].text : '',
          context: window(item.src, e.start, e.end, e.before, e.after), ref: item.ref,
        });
      }
    }
  }

  scoreClean(item, issues) {
    const src = analyze(item.text);
    const c = this.clean;
    c.sentences++;
    if (!c.bySource[item.source]) c.bySource[item.source] = { sentences: 0, sure: 0, all: 0 };
    c.bySource[item.source].sentences++;
    for (const issue of issues) {
      const changes = this.issueChanges(item.text, src, issue);
      if (!changes) continue;
      for (const ch of changes) {
        if (ch.terminal && !this.opts.withTerminal) continue;
        const modes = issue.confidence === 'sure' ? MODES : ['all'];
        for (const m of modes) {
          c.fp[m]++;
          c.bySource[item.source][m]++;
          c.byRule[m][issue.ruleId] = (c.byRule[m][issue.ruleId] || 0) + 1;
          c.byType[m][ch.type] = (c.byType[m][ch.type] || 0) + 1;
        }
        this.fps.push({
          id: item.id, source: item.source, kind: 'clean', ruleId: issue.ruleId, confidence: issue.confidence, type: ch.type,
          nearMiss: false, refGap: src.gaps[ch.k].text, context: window(item.text, issue.start, issue.end, issue.before, issue.after), ref: null,
        });
      }
    }
  }

  /** Aggregate per-type buckets into sign groups (an edit «,;» counts under «,» and «;»). */
  bySign() {
    const out = {};
    for (const g of SIGN_GROUPS) out[g] = { refTotal: 0, hitSure: 0, hitAll: 0, fpSure: 0, fpAll: 0, cleanSure: 0, cleanAll: 0 };
    const add = (map, type, fn) => { for (const g of signGroups(type)) if (out[g]) fn(out[g], map[type]); };
    for (const type of Object.keys(this.modes.all.byType)) {
      add(this.modes.all.byType, type, (o, b) => { o.refTotal += b.refTotal; o.hitAll += b.refHit; });
      if (this.modes.sure.byType[type]) add(this.modes.sure.byType, type, (o, b) => { o.hitSure += b.refHit; });
    }
    for (const type of Object.keys(this.modes.all.fpType)) add(this.modes.all.fpType, type, (o, b) => { o.fpAll += b.fp; });
    for (const type of Object.keys(this.modes.sure.fpType)) add(this.modes.sure.fpType, type, (o, b) => { o.fpSure += b.fp; });
    for (const type of Object.keys(this.clean.byType.all)) add(this.clean.byType.all, type, (o, n) => { o.cleanAll += n; });
    for (const type of Object.keys(this.clean.byType.sure)) add(this.clean.byType.sure, type, (o, n) => { o.cleanSure += n; });
    return out;
  }
}

/* ---------- running ---------- */

function runEngine(engine, texts, onIssues) {
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const res = engine.check({ paragraphs: slice.map((text) => ({ kind: 'p', text })) });
    const byPara = slice.map(() => []);
    for (const issue of res.issues) byPara[issue.para].push(issue);
    byPara.forEach((issues, j) => onIssues(i + j, issues));
  }
}

function filterSet(items, args, withKind) {
  let out = items.filter((it) => args.set === 'all' || it.split === args.set);
  if (args.source) out = out.filter((it) => it.source === args.source);
  if (args.domain) out = out.filter((it) => (it.domain || '').includes(args.domain));
  if (args.excludeDomain) out = out.filter((it) => !(it.domain || '').includes(args.excludeDomain));
  if (withKind && args.pure) out = out.filter((it) => it.kind === 'pure');
  if (args.limit && args.limit < out.length) {
    // every k-th item, so a quick run still covers all sources (the files are grouped by source)
    const stride = Math.floor(out.length / args.limit);
    out = out.filter((_, i) => i % stride === 0).slice(0, args.limit);
  }
  return out;
}

function summarizeMode(mode) {
  const t = mode.total;
  const recall = t.refTotal ? t.refHit / t.refTotal : 0;
  const precision = t.changes ? t.tp / t.changes : 0;
  const f05 = precision + recall ? (1.25 * precision * recall) / (0.25 * precision + recall) : 0;
  return { ...t, recall, precision, f05 };
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function report(scorer, meta, args) {
  const out = [];
  const p = (s = '') => out.push(s);
  const o = scorer.outside;
  const clean = scorer.clean;
  const scope = [args.pure ? 'pure' : '', args.source ? `источник ${args.source}` : '', args.domain ? `домен ~${args.domain}` : '', args.excludeDomain ? `без домена ~${args.excludeDomain}` : ''].filter(Boolean).join(', ');
  p(`Пунктуация: набор ${meta.set}${scope ? ` (${scope})` : ''} — ${meta.cases} предложений, ${meta.refEdits} эталонных правок в зачёте` +
    (o.terminal.ref + o.boundary.ref ? ` (+${o.terminal.ref} конечных знаков, +${o.boundary.ref} границ предложений — вне зачёта)` : '') + `; чистых предложений: ${clean.sentences}`);
  p(`Движок: вычитка ${meta.version} · базы ${meta.bases} · git ${meta.git} · ${meta.ms} мс`);
  p();
  p(table(MODES.map((m) => {
    const s = summarizeMode(scorer.modes[m]);
    return [m === 'sure' ? 'sure' : 'sure+check', `${s.refHit}/${s.refTotal}`, pct(s.refHit, s.refTotal), `${s.tp}/${s.changes}`, pct(s.tp, s.changes),
      `${s.fp} (near-miss ${s.near})`, (100 * s.f05).toFixed(1), `${clean.fp[m]} (${clean.sentences ? (1000 * clean.fp[m] / clean.sentences).toFixed(1) : '—'}/1000)`];
  }), ['режим', 'найдено', 'recall', 'совпало', 'precision', 'лишних', 'F0.5', 'лишние на чистых']));
  if (o.terminal.ref || o.boundary.ref) {
    p(`Вне зачёта (не задача движка): конечные . ! ? … — ${o.terminal.ref} правок, найдено ${o.terminal.sure} / ${o.terminal.all}; ` +
      `границы предложений перед заглавной — ${o.boundary.ref} правок, найдено ${o.boundary.sure} / ${o.boundary.all}`);
  }
  p();
  p('По знаку (правка засчитывается каждому знаку, который она меняет): recall и лишние — sure / sure+check');
  const signs = scorer.bySign();
  p(table(SIGN_GROUPS.filter((g) => signs[g].refTotal || signs[g].fpAll || signs[g].cleanAll).map((g) => {
    const s = signs[g];
    return [g, SIGN_NAMES[g], s.refTotal, `${pct(s.hitSure, s.refTotal)} / ${pct(s.hitAll, s.refTotal)}`, `${s.fpSure} / ${s.fpAll}`, `${s.cleanSure} / ${s.cleanAll}`];
  }), ['знак', '', 'правок', 'recall', 'лишних на парах', 'лишних на чистых']));
  p();
  p('По правилам движка — sure+check, в скобках sure:');
  const rules = Object.entries(scorer.modes.all.byRule).sort((a, b) => b[1].changes - a[1].changes);
  p(table(rules.map(([r, b]) => {
    const s = scorer.modes.sure.byRule[r] || newBucket();
    return [r, `${b.changes} (${s.changes})`, `${b.tp} (${s.tp})`, `${b.fp} (${s.fp})`, `${b.near} (${s.near})`, `${pct(b.tp, b.changes)} (${pct(s.tp, s.changes)})`,
      `${clean.byRule.all[r] || 0} (${clean.byRule.sure[r] || 0})`];
  }), ['правило', 'изменений', 'совпало', 'лишних', 'из них near-miss', 'precision', 'лишних на чистых']));
  const cleanOnly = Object.entries(clean.byRule.all).filter(([r]) => !scorer.modes.all.byRule[r]).sort((a, b) => b[1] - a[1]);
  if (cleanOnly.length) p(`Правила, сработавшие только на чистых: ${cleanOnly.map(([r, n]) => `${r} ${n}`).join(', ')}`);
  p();
  p('По источнику и виду пары (sure / sure+check):');
  const groups = [...Object.entries(scorer.modes.all.bySource).map(([k, b]) => ['источник', k, b]), ...Object.entries(scorer.modes.all.byKind).map(([k, b]) => ['вид', k, b])];
  p(table(groups.map(([what, k, b]) => {
    const s = (what === 'источник' ? scorer.modes.sure.bySource : scorer.modes.sure.byKind)[k] || newBucket();
    const c = what === 'источник' ? clean.bySource[k] : null;
    return [what, k, b.refTotal, `${pct(s.refHit, s.refTotal)} / ${pct(b.refHit, b.refTotal)}`, `${pct(s.tp, s.changes)} / ${pct(b.tp, b.changes)}`,
      c ? `${c.sentences} предл.: ${c.sure} / ${c.all} (${(1000 * c.all / c.sentences).toFixed(1)}/1000)` : ''];
  }), ['', '', 'правок', 'recall', 'precision', 'чистые: лишних']));
  p();
  const nw = Object.entries(scorer.nextWord).sort((a, b) => b[1].total - a[1].total).slice(0, 25);
  if (nw.length) {
    p('Пропущенная запятая — по слову после пробела (топ-25): правок / найдено sure / найдено sure+check');
    p(table(nw.map(([w, b]) => [w, b.total, `${b.hitSure} (${pct(b.hitSure, b.total)})`, `${b.hit} (${pct(b.hit, b.total)})`]), ['слово', 'правок', 'sure', 'all']));
    p();
  }
  const neutral = Object.entries(scorer.neutralByRule).sort((a, b) => b[1] - a[1]);
  if (neutral.length) p(`Нейтральные issue (только глиф: - → —, "" → «», ... → …): ${neutral.map(([r, n]) => `${r} ${n}`).join(', ')}`);
  const wc = Object.entries(scorer.wordChangeByRule).filter(([r]) => r.startsWith('punct.')).sort((a, b) => b[1] - a[1]);
  if (wc.length) p(`Пунктуационные правила, менявшие слова (не учтены): ${wc.map(([r, n]) => `${r} ${n}`).join(', ')}`);
  if (scorer.broken || scorer.unmapped) p(`ВНИМАНИЕ: issue с before ≠ тексту: ${scorer.broken}; эталонных правок вне пробелов: ${scorer.unmapped}`);
  return out.join('\n');
}

function printDiff(scorer, args, rand) {
  const out = [];
  const pairFps = scorer.fps.filter((f) => f.kind !== 'clean');
  const cleanFps = scorer.fps.filter((f) => f.kind === 'clean');
  out.push(`\n=== Промахи (${Math.min(args.diff, scorer.misses.length)} из ${scorer.misses.length}) ===`);
  for (const m of sample(scorer.misses, args.diff, rand)) out.push(`[${m.id} ${m.kind} ${m.type} ${m.pos}] ${m.context}`);
  out.push(`\n=== Лишние на парах (${Math.min(args.diff, pairFps.length)} из ${pairFps.length}) ===`);
  for (const f of sample(pairFps, args.diff, rand)) out.push(`[${f.id} ${f.ruleId}/${f.confidence}${f.nearMiss ? ' near-miss' : ''}] ${f.context}\n    эталон: ${f.ref}`);
  out.push(`\n=== Лишние на чистых (${Math.min(args.diff, cleanFps.length)} из ${cleanFps.length}) ===`);
  for (const f of sample(cleanFps, args.diff, rand)) out.push(`[${f.id} ${f.ruleId}/${f.confidence}] ${f.context}`);
  return out.join('\n');
}

function reviewList(scorer, n, rand) {
  return sample(scorer.fps, n, rand).map((f) => ({ ...f, verdict: '' }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = require(path.join(args.engine, 'src', 'engine'));
  const t0 = Date.now();
  await engine.init({ basesDir: path.join(args.engine, 'bases') });
  const cases = filterSet(readJsonl(path.join(EVAL_DIR, 'punct.jsonl')), args, true);
  const clean = filterSet(readJsonl(path.join(EVAL_DIR, 'clean.jsonl')), args, false);
  if (!cases.length) throw new Error('no cases selected — check --set/--source/--pure');
  const scorer = new Scorer({ withTerminal: args.withTerminal });
  const t1 = Date.now();
  runEngine(engine, cases.map((c) => c.src), (i, issues) => scorer.scoreCase(cases[i], issues));
  runEngine(engine, clean.map((c) => c.text), (i, issues) => scorer.scoreClean(clean[i], issues));
  const ms = Date.now() - t1;
  const info = engine.basesInfo();
  const pkg = JSON.parse(fs.readFileSync(path.join(args.engine, 'package.json'), 'utf8'));
  const meta = {
    set: args.set, cases: cases.length, cleanSentences: clean.length,
    refEdits: scorer.modes.all.total.refTotal, outside: scorer.outside,
    version: pkg.version, bases: info.version, git: gitVersion(args.engine), engineDir: args.engine, ms, initMs: t1 - t0, date: new Date().toISOString(), args,
  };
  const text = report(scorer, meta, args);
  if (!args.quiet) console.log(text);
  if (args.diff) console.log(printDiff(scorer, args, rng(args.seed)));
  const review = reviewList(scorer, args.review, rng(args.seed + 1));
  if (args.json) {
    const modeData = (m) => ({
      ...summarizeMode(scorer.modes[m]), byType: scorer.modes[m].byType, byRule: scorer.modes[m].byRule, bySource: scorer.modes[m].bySource,
      byKind: scorer.modes[m].byKind, fpType: scorer.modes[m].fpType, clean: { sentences: scorer.clean.sentences, fp: scorer.clean.fp[m], byRule: scorer.clean.byRule[m], byType: scorer.clean.byType[m] },
    });
    const data = {
      meta,
      sure: modeData('sure'),
      all: modeData('all'),
      bySign: scorer.bySign(),
      outside: scorer.outside,
      cleanBySource: scorer.clean.bySource,
      nextWord: scorer.nextWord,
      neutralByRule: scorer.neutralByRule,
      wordChangeByRule: scorer.wordChangeByRule,
      diagnostics: { broken: scorer.broken, unmapped: scorer.unmapped, misses: scorer.misses.length, falsePositives: scorer.fps.length },
      samples: { misses: sample(scorer.misses, Math.max(args.diff, 50), rng(args.seed + 2)), falsePositives: sample(scorer.fps, Math.max(args.diff, 50), rng(args.seed + 3)) },
      review,
      report: text,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(data, null, 1));
    if (!args.quiet) console.log(`\nJSON: ${path.resolve(args.json)}`);
  } else if (!args.quiet && args.review) {
    console.log(`\n=== ${review.length} случайных «лишних» для ручной оценки (пары и чистые) ===`);
    for (const f of review) console.log(`[${f.id} ${f.ruleId}/${f.confidence}${f.nearMiss ? ' near-miss' : ''}] ${f.context}${f.ref ? `\n    эталон: ${f.ref}` : ''}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`eval-punct: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { analyze, gapClasses, classifyChange, isOrthographic, changeType, signGroups, unmatchedParens, Scorer };
