#!/usr/bin/env node
'use strict';

/**
 * Calibrate the converted LanguageTool rules (bases/rules/lt-punct.json):
 * run every rule, in isolation, on its own LanguageTool examples and on the
 * false-positive corpora, then decide `status` per rule:
 *
 *   enabled    — the rule passes all its examples (incorrect → a match that
 *                overlaps the marker; correct → no match) and is not switched
 *                off in LanguageTool itself (default="off" / "temp_off");
 *   confidence — 'sure' only when the rule passes its examples strictly
 *                (exact span, suggestions equal to the corrections), is not
 *                tagged «picky», and gives zero matches on the clean texts
 *                (test/engine/fp-texts.js) and on the correct examples of all
 *                other rules; otherwise 'check'.
 *
 * Rules tagged «picky» in LanguageTool are disabled: LanguageTool itself runs
 * them only in its strict («picky») mode, and on the punctuation benchmark they
 * are the main source of noise (Prep_i: 216 changes on 19 894 clean sentences).
 * They stay in the JSON (status.enabled = false, reason) for a future strict mode.
 *
 *   node scripts/lt/calibrate.js            report only
 *   node scripts/lt/calibrate.js --write    write status back into the JSON
 *   node scripts/lt/calibrate.js --rule KEY show the matches of one rule on its examples
 *   node scripts/lt/calibrate.js --eval run.json
 *                                           also read a JSON produced by
 *                                           `npm run eval:punct -- --json run.json`: a rule
 *                                           group with at least as many false changes as true
 *                                           ones, or ≥ 2 changes on clean sentences, is capped
 *                                           to 'check' (status.eval keeps the numbers)
 */

const fs = require('node:fs');
const path = require('node:path');
const engine = require('../../src/engine');
const ltrules = require('../../src/engine/ltrules');
const { TEXTS } = require('../../test/engine/fp-texts');
const { CONFIDENCE_CAP, HEDGE_RE } = require('./notes');

/** Plain text of an LT message (suggestions and back-references dropped). */
const messageText = (parts) => (parts || []).map((p) => (typeof p === 'string' ? p : '')).join(' ');

const ROOT = path.resolve(__dirname, '..', '..');
const BASES = path.join(ROOT, 'bases');
const FILE = path.join(BASES, 'rules', 'lt-punct.json');

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const sameSet = (a, b) => {
  const x = [...new Set(a.map((s) => s.trim()))].sort();
  const y = [...new Set(b.map((s) => s.trim()))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Evaluate one rule on its own examples (isolated) and through the full pipeline. */
function evaluateRule(r, ctxCache) {
  const res = { incorrect: 0, incorrectStrict: 0, incorrectPipeline: 0, incorrectTotal: 0, correct: 0, correctTotal: 0, failures: [] };
  for (const ex of r.examples) {
    const ctx = ctxCache(ex.text);
    const matches = ltrules.matchContext(ctx, r.key);
    if (ex.incorrect) {
      res.incorrectTotal++;
      const marker = ex.marker ? { start: ex.marker[0], end: ex.marker[1] } : { start: 0, end: ex.text.length };
      const hit = matches.find((m) => overlaps(m, marker));
      if (hit) res.incorrect++;
      else res.failures.push(`✗ no match: «${ex.text}»`);
      const strict = matches.some((m) => m.start === marker.start && m.end === marker.end
        && (ex.corrections.length === 0 || sameSet(m.suggestions, ex.corrections)));
      if (strict) res.incorrectStrict++;
      else if (hit) res.failures.push(`~ span/suggestion differ: «${ex.text}» got [${hit.before}] → ${JSON.stringify(hit.suggestions)}, want [${ex.text.slice(marker.start, marker.end)}] → ${JSON.stringify(ex.corrections)}`);
      const { issues } = engine.check({ paragraphs: [{ text: ex.text, kind: 'p' }] });
      if (issues.some((is) => overlaps(is, marker))) res.incorrectPipeline++;
    } else {
      res.correctTotal++;
      if (!matches.length) res.correct++;
      else res.failures.push(`✗ false alarm: «${ex.text}» → [${matches[0].before}]`);
    }
  }
  return res;
}

function main(argv) {
  const args = argv.slice(2);
  const write = args.includes('--write');
  const only = args.includes('--rule') ? args[args.indexOf('--rule') + 1] : null;
  const verbose = args.includes('--verbose');
  const evalFile = args.includes('--eval') ? args[args.indexOf('--eval') + 1] : null;
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let evalByRule = null; // ruleId → { tp, fp, cleanFp }
  if (evalFile) {
    const ev = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
    evalByRule = new Map();
    for (const [id, v] of Object.entries((ev.all && ev.all.byRule) || {})) evalByRule.set(id, { tp: v.tp || 0, fp: v.fp || 0, cleanFp: 0 });
    for (const [id, n] of Object.entries((ev.all && ev.all.clean && ev.all.clean.byRule) || {})) {
      if (!evalByRule.has(id)) evalByRule.set(id, { tp: 0, fp: 0, cleanFp: 0 });
      evalByRule.get(id).cleanFp = n;
    }
  }

  return engine.init({ basesDir: BASES }).then(() => {
    const compiled = new Map(ltrules.rules().map((r) => [r.key, r]));
    const ctxCacheMap = new Map();
    const ctxCache = (text) => {
      let c = ctxCacheMap.get(text);
      if (!c) { c = ltrules.contextOf(text); ctxCacheMap.set(text, c); }
      return c;
    };

    if (only) {
      const r = data.rules.find((x) => x.key === only || x.id === only);
      if (!r) throw new Error(`rule ${only} not found`);
      for (const ex of r.examples) {
        const ms = ltrules.matchText(ex.text, r.key);
        console.log(`${ex.incorrect ? '✗' : '✓'} ${ex.text}`);
        if (ex.incorrect) console.log(`   want [${ex.text.slice(ex.marker[0], ex.marker[1])}] → ${JSON.stringify(ex.corrections)}`);
        for (const m of ms) console.log(`   got  [${m.before}] → ${JSON.stringify(m.suggestions)}  (${m.start}-${m.end})`);
      }
      return;
    }

    // false-positive corpora: clean texts + the correct examples of every rule
    const fpParas = Object.values(TEXTS).flat();
    const correctParas = [...new Set(data.rules.flatMap((r) => r.examples.filter((e) => !e.incorrect).map((e) => e.text)))];
    const fpCtx = fpParas.map(ctxCache);
    const corrCtx = correctParas.map(ctxCache);

    const totals = { rules: 0, enabled: 0, sure: 0, off: 0, failing: 0, uncompiled: 0, inc: 0, incPass: 0, incStrict: 0, incPipe: 0, cor: 0, corPass: 0 };
    const disabled = [];
    for (const r of data.rules) {
      totals.rules++;
      const c = compiled.get(r.key);
      if (!c) {
        totals.uncompiled++;
        r.status = { enabled: false, confidence: 'check', reason: 'не компилируется интерпретатором (см. предупреждение ltrules при загрузке)' };
        disabled.push(`${r.key}: ${r.status.reason}`);
        continue;
      }
      const ev = evaluateRule(r, ctxCache);
      totals.inc += ev.incorrectTotal; totals.incPass += ev.incorrect; totals.incStrict += ev.incorrectStrict; totals.incPipe += ev.incorrectPipeline;
      totals.cor += ev.correctTotal; totals.corPass += ev.correct;
      const passesLenient = ev.incorrect === ev.incorrectTotal && ev.correct === ev.correctTotal;
      const passesStrict = ev.incorrectStrict === ev.incorrectTotal && ev.correct === ev.correctTotal;
      let fp = 0;
      const fpExamples = [];
      if (passesLenient) {
        for (const ctx of fpCtx) for (const m of ltrules.matchContext(ctx, r.key)) { fp++; if (fpExamples.length < 2) fpExamples.push(m.before); }
        for (const ctx of corrCtx) for (const m of ltrules.matchContext(ctx, r.key)) { fp++; if (fpExamples.length < 2) fpExamples.push(m.before); }
      }
      const picky = Array.isArray(r.ltTags) && r.ltTags.includes('picky');
      const bench = evalByRule && evalByRule.get(`lt.${r.id}`);
      let status;
      if (r.ltDefault && r.ltDefault !== 'on') {
        status = { enabled: false, confidence: 'check', reason: `выключено в самом LanguageTool (default="${r.ltDefault}")` };
        totals.off++;
      } else if (picky) {
        status = { enabled: false, confidence: 'check', reason: 'помечено picky: LanguageTool включает такие правила только в строгом режиме; на стенде они дают основную долю ложных срабатываний' };
        totals.off++;
      } else if (!passesLenient) {
        status = { enabled: false, confidence: 'check', reason: `не проходит собственные примеры: ${ev.failures.filter((f) => f.startsWith('✗')).slice(0, 2).join(' | ')}` };
        totals.failing++;
      } else {
        const why = [];
        if (picky) why.push('помечено picky в LanguageTool');
        if (!passesStrict) why.push('границы или подсказка на примерах отличаются от LanguageTool');
        if (fp > 0) why.push(`${fp} срабатываний на чистых текстах (${fpExamples.map((s) => `«${s}»`).join(', ')})`);
        const cap = CONFIDENCE_CAP[r.key] || CONFIDENCE_CAP[r.id];
        if (cap) why.push(`только подсказка: ${cap}`);
        if (HEDGE_RE.test(messageText(r.message))) why.push('сам LanguageTool формулирует правило с оговоркой («возможно», «обычно», «допустима»)');
        if (bench && ((bench.fp >= 1 && bench.fp >= bench.tp) || bench.cleanFp >= 2)) why.push(`стенд eval: ${bench.tp} верных и ${bench.fp} ложных правок, ${bench.cleanFp} на чистых предложениях`);
        status = { enabled: true, confidence: why.length ? 'check' : 'sure', reason: why.length ? why.join('; ') : 'проходит все примеры, 0 срабатываний на чистых текстах' };
        totals.enabled++;
        if (status.confidence === 'sure') totals.sure++;
      }
      status.examples = { incorrect: [ev.incorrect, ev.incorrectTotal], strict: [ev.incorrectStrict, ev.incorrectTotal], pipeline: [ev.incorrectPipeline, ev.incorrectTotal], correct: [ev.correct, ev.correctTotal] };
      if (passesLenient) status.fp = fp;
      if (bench) status.eval = { tp: bench.tp, fp: bench.fp, cleanFp: bench.cleanFp };
      r.status = status;
      if (!status.enabled) disabled.push(`${r.key}: ${status.reason}`);
      if (verbose && ev.failures.length) console.log(`${r.key}\n  ${ev.failures.join('\n  ')}`);
    }

    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
    console.log(`rules: ${totals.rules}  enabled: ${totals.enabled} (sure ${totals.sure})  disabled: ${totals.off} off in LT, ${totals.failing} failing examples, ${totals.uncompiled} uncompiled`);
    console.log(`incorrect examples: ${totals.incPass}/${totals.inc} matched (${pct(totals.incPass, totals.inc)}), strict ${totals.incStrict}/${totals.inc} (${pct(totals.incStrict, totals.inc)}), full pipeline ${totals.incPipe}/${totals.inc} (${pct(totals.incPipe, totals.inc)})`);
    console.log(`correct examples: ${totals.corPass}/${totals.cor} clean (${pct(totals.corPass, totals.cor)})`);
    console.log(`all examples: ${pct(totals.incPass + totals.corPass, totals.inc + totals.cor)}`);
    if (disabled.length) console.log(`\ndisabled (${disabled.length}):\n  ${disabled.join('\n  ')}`);

    if (write) {
      data.counts = { ...(data.counts || {}), enabled: totals.enabled, sure: totals.sure, disabled: totals.rules - totals.enabled };
      data.calibrated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
      console.log(`\nstatus written → ${path.relative(process.cwd(), FILE)}`);
    }
  });
}

if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
