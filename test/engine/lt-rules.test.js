'use strict';

/**
 * LanguageTool punctuation rules (bases/rules/lt-punct.json, interpreted by
 * src/engine/ltrules.js): every example that LanguageTool ships with a rule
 * is replayed through the engine.
 *
 *   incorrect example → engine.check() reports an issue of this rule (or one of
 *                       our own rules) on the marked span;
 *   correct example   → the rule stays silent.
 *
 * Rules whose status.enabled is false (calibrated by scripts/lt/calibrate.js)
 * must carry a reason and must not fire; rules with confidence 'sure' must be
 * silent on the clean texts and on the correct examples of every rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ready, doc, describe, engine, BASES_DIR } = require('./helpers');
const ltrules = require('../../src/engine/ltrules');
const { loadJson } = require('../../src/engine/util');
const { TEXTS } = require('./fp-texts');

const DATA = loadJson(path.join(BASES_DIR, 'rules', 'lt-punct.json'));
const RULES = DATA.rules;
const ENABLED = RULES.filter((r) => r.status && r.status.enabled);
const DISABLED = RULES.filter((r) => !r.status || !r.status.enabled);

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const markerOf = (ex) => (ex.marker ? { start: ex.marker[0], end: ex.marker[1] } : { start: 0, end: ex.text.length });
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

test('lt-rules: data file shape, attribution and references', async () => {
  await ready();
  assert.equal(DATA.source.name, 'LanguageTool');
  assert.equal(DATA.source.license, 'LGPL 2.1+');
  assert.match(DATA.source.url, /^https:\/\/languagetool\.org/);
  assert.match(DATA.source.file, /grammar\.xml$/);
  assert.ok(RULES.length >= 200, `only ${RULES.length} rules`);
  assert.ok(ENABLED.length >= 140, `only ${ENABLED.length} enabled rules`);
  assert.ok(Array.isArray(DATA.skipped) && DATA.skipped.every((s) => s.id && s.reason), 'skipped rules need id + reason');
  const keys = new Set();
  for (const r of RULES) {
    assert.ok(r.key && r.id && r.name, `rule without key/id/name: ${JSON.stringify(r).slice(0, 80)}`);
    assert.ok(!keys.has(r.key), `duplicate key ${r.key}`);
    keys.add(r.key);
    assert.ok(Array.isArray(r.pattern) && r.pattern.length > 0, `${r.key}: empty pattern`);
    assert.ok(Array.isArray(r.examples) && r.examples.length > 0, `${r.key}: no examples`);
    assert.ok(r.status && typeof r.status.enabled === 'boolean', `${r.key}: not calibrated (run scripts/lt/calibrate.js --write)`);
    assert.ok(['sure', 'check'].includes(r.status.confidence), `${r.key}: confidence ${r.status.confidence}`);
    assert.ok(typeof r.status.reason === 'string' && r.status.reason.length > 5, `${r.key}: status.reason missing`);
    assert.ok(Array.isArray(r.ref), `${r.key}: ref must be an array`);
    for (const n of r.ref) assert.ok(engine.rule(n), `${r.key}: § ${n} does not exist in the 1956 rules`);
    if (r.status.enabled) assert.ok((r.why && r.why.length > 10) || r.message.length, `${r.key}: no why/message`);
  }
  // the interpreter compiled every rule of the file
  const compiled = new Set(ltrules.rules().map((r) => r.key));
  for (const r of RULES) assert.ok(compiled.has(r.key), `${r.key} did not compile`);
  const info = ltrules.info();
  assert.equal(info.count, RULES.length);
  assert.equal(info.enabled, ENABLED.length);
  const mod = engine.basesInfo().modules.find((m) => m.id === 'punctuation-lt');
  assert.ok(mod && mod.status === 'builtin' && /LanguageTool/.test(mod.detail) && /LGPL/.test(mod.detail), JSON.stringify(mod));
});

test('lt-rules: every enabled rule passes all of its LanguageTool examples through engine.check()', async () => {
  await ready();
  const failures = [];
  let total = 0;
  let passed = 0;
  let byOwnRule = 0;
  let byNative = 0;
  for (const r of ENABLED) {
    const ruleId = `lt.${r.id}`;
    for (const ex of r.examples) {
      total++;
      const { issues } = engine.check(doc([ex.text]));
      if (ex.incorrect) {
        const marker = markerOf(ex);
        const own = issues.find((is) => is.ruleId === ruleId && overlaps(is, marker));
        const native = issues.find((is) => overlaps(is, marker));
        if (own) { passed++; byOwnRule++; }
        else if (native) { passed++; byNative++; }
        else failures.push(`${r.key}: no issue on «${ex.text.slice(marker.start, marker.end)}» in «${ex.text}»\n    ${describe(issues) || '(no issues at all)'}`);
        if (own) {
          assert.equal(ex.text.slice(own.start, own.end), own.before, `${r.key}: before !== slice`);
          assert.equal(own.category, 'punctuation');
          assert.ok(own.why && own.why.length > 10, `${r.key}: why`);
          assert.match(own.source, /LanguageTool|^Правила 1956/, `${r.key}: source ${own.source}`);
          // sub-rules of one group may hit the same span («В любом случае,» matches NO_VVODNOE[2] and [5]); either is fine
          assert.ok(own.meta && own.meta.kind === 'lt' && own.meta.key.startsWith(`${r.id}`), `${r.key}: meta ${JSON.stringify(own.meta)}`);
          assert.ok(['sure', 'check'].includes(own.confidence));
        }
      } else {
        const own = issues.find((is) => is.meta && is.meta.kind === 'lt' && is.meta.key === r.key);
        if (!own) passed++;
        else failures.push(`${r.key}: false alarm «${own.before}» in correct example «${ex.text}»`);
      }
    }
  }
  console.log(`lt-rules: ${ENABLED.length} enabled rules, ${passed}/${total} examples pass (${pct(passed, total)}); incorrect examples caught by the LT rule: ${byOwnRule}, by our own rules: ${byNative}`);
  assert.equal(failures.length, 0, `${failures.length} failing examples:\n  ${failures.join('\n  ')}`);
});

test('lt-rules: disabled rules carry a reason, never fire; overall example pass rate is reported', async () => {
  await ready();
  for (const r of DISABLED) {
    assert.ok(r.status && r.status.reason && r.status.reason.length > 5, `${r.key}: disabled without a reason`);
    for (const ex of r.examples) {
      const { issues } = engine.check(doc([ex.text]));
      assert.ok(!issues.some((is) => is.meta && is.meta.kind === 'lt' && is.meta.key === r.key), `${r.key} is disabled but fired on «${ex.text}»`);
    }
  }
  // isolated pass rate over ALL converted rules (enabled + disabled) — the figure for the report
  let total = 0;
  let passed = 0;
  for (const r of RULES) {
    for (const ex of r.examples) {
      total++;
      const ms = ltrules.matchText(ex.text, r.key);
      if (ex.incorrect) { if (ms.some((m) => overlaps(m, markerOf(ex)))) passed++; }
      else if (!ms.length) passed++;
    }
  }
  console.log(`lt-rules: all ${RULES.length} converted rules (incl. ${DISABLED.length} disabled), isolated: ${passed}/${total} examples (${pct(passed, total)})`);
  assert.ok(passed / total >= 0.95, `isolated pass rate ${pct(passed, total)} below 95%`);
});

test('lt-rules: sure rules are silent on the clean texts and on all correct LT examples', async () => {
  await ready();
  const sure = ENABLED.filter((r) => r.status.confidence === 'sure');
  assert.ok(sure.length >= 60, `only ${sure.length} sure rules`);
  const corpus = [...Object.values(TEXTS).flat(), ...new Set(RULES.flatMap((r) => r.examples.filter((e) => !e.incorrect).map((e) => e.text)))];
  const ctxs = corpus.map((t) => ltrules.contextOf(t));
  const hits = [];
  for (const r of sure) {
    assert.ok(!(r.ltTags || []).includes('picky'), `${r.key}: picky rules cannot be sure`);
    ctxs.forEach((ctx, i) => {
      for (const m of ltrules.matchContext(ctx, r.key)) hits.push(`${r.key} → «${m.before}» in «${corpus[i]}»`);
    });
  }
  assert.equal(hits.length, 0, `sure rules fired on clean text:\n  ${hits.join('\n  ')}`);
  // and the whole engine stays quiet on the clean texts (same bound as false-positives.test.js)
  const { issues } = engine.check(doc(Object.values(TEXTS).flat()));
  assert.ok(issues.filter((is) => is.ruleId.startsWith('lt.')).length === 0, describe(issues));
});

test('lt-rules: our own rules win on overlap; LT issues apply cleanly', async () => {
  await ready();
  // «решили что» is caught by punct.comma-before-conj; CHTO_COMMA must not duplicate it
  const a = engine.check(doc(['Мы решили что первый этап займёт две недели.'])).issues;
  assert.ok(a.some((is) => is.ruleId === 'punct.comma-before-conj' && is.before === 'решили что'), describe(a));
  assert.ok(!a.some((is) => is.ruleId.startsWith('lt.') && is.before.includes('что')), describe(a));
  // applying an LT fix reproduces the LanguageTool correction
  const text = 'Она смеялась радовалась жизни.';
  const b = engine.check(doc([text])).issues;
  const lt = b.find((is) => is.ruleId === 'lt.Verb_comma_Verb');
  assert.ok(lt, describe(b));
  assert.equal(lt.before, 'смеялась радовалась');
  assert.equal(lt.after, 'смеялась, радовалась');
  assert.deepEqual(lt.alternatives.map((x) => x.text), ['смеялась и радовалась']);
  assert.equal(engine.applyIssues(doc([text]), [lt]).paragraphs[0].text, 'Она смеялась, радовалась жизни.');
  assert.deepEqual(lt.ref, [143]);
  assert.match(lt.source, /^Правила 1956 · § 143/);
  // quotes: an LT match strictly inside quotes is suppressed with skipQuotes (default) and kept without it
  const q = '«Она смеялась радовалась жизни», — сказал он.';
  assert.ok(!engine.check(doc([q])).issues.some((is) => is.ruleId === 'lt.Verb_comma_Verb'));
  assert.ok(engine.check(doc([q]), { skipQuotes: false }).issues.some((is) => is.ruleId === 'lt.Verb_comma_Verb'));
  // uncertain: 'skip' keeps only sure LT issues
  for (const is of engine.check(doc([text]), { uncertain: 'skip' }).issues) assert.equal(is.confidence, 'sure');
});
