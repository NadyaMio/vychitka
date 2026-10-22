'use strict';

/**
 * Checks derived from the punctuation manual (bases/reference/punct-manual.json):
 * the reference layer (manualRule, searchRules, Issue.manualRef) and every new
 * punctuation rule — positive examples, negative examples, confidence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, describe, engine } = require('./helpers');
const worker = require('../../src/engine/worker');

/** Issues of one paragraph filtered by ruleId. */
function run(text, ruleId, settings) {
  const { issues } = engine.check(doc([text]), settings);
  return ruleId ? issues.filter((is) => is.ruleId === ruleId) : issues;
}

/** Assert that `text` yields exactly one issue of `ruleId` with the given before → after. */
function expectFix(text, ruleId, before, after, confidence) {
  const hits = run(text, ruleId);
  const hit = hits.find((is) => is.before === before);
  assert.ok(hit, `expected ${ruleId} «${before}» in «${text}»\n${describe(run(text))}`);
  assert.equal(hit.after, after, `after for «${text}»`);
  if (confidence) assert.equal(hit.confidence, confidence, `confidence for «${text}»`);
  assert.ok(hit.why && hit.why.length > 10, `why for «${text}»`);
  assert.ok(hit.source, `source for «${text}»`);
  assert.ok(Array.isArray(hit.manualRef) && hit.manualRef.length && hit.manualRef.every((id) => engine.manualRule(id)), `manualRef for «${text}»: ${JSON.stringify(hit.manualRef)}`);
  assert.equal(text.slice(hit.start, hit.end), hit.before, `before === slice for «${text}»`);
  return hit;
}

/** Assert that none of the texts produce an issue of `ruleId`. */
function expectClean(texts, ruleId) {
  for (const text of texts) {
    const hits = run(text, ruleId);
    assert.equal(hits.length, 0, `unexpected ${ruleId} in «${text}»:\n${describe(hits)}`);
  }
}

test('manual: manualRule() returns entries with url into the PDF, unknown id → null', async () => {
  await ready();
  const r = engine.manualRule('pm-dash-nouns');
  assert.ok(r);
  assert.equal(r.id, 'pm-dash-nouns');
  assert.equal(r.section, 'Тире между подлежащим и сказуемым');
  assert.ok(r.rule.length > 20 && Array.isArray(r.examples) && r.examples.length >= 1);
  assert.deepEqual(r.ref1956, [164]);
  assert.equal(r.page, 5);
  assert.match(r.url, /^https:\/\/xn--80aakd6ani0ae\.xn--p1ai\/.+\.pdf#page=5$/);
  assert.equal(engine.manualRule('pm-nope'), null);
  assert.equal(engine.manualRule(''), null);
  // every ref1956 of every entry exists in the 1956 rules
  for (const q of ['тире', 'запятая', 'обращение', 'прямая речь', 'цитата', 'двоеточие']) {
    for (const hit of engine.searchRules(q, 40).filter((x) => x.source === 'manual')) {
      const e = engine.manualRule(hit.id);
      for (const n of e.ref1956) assert.ok(engine.rule(n), `${e.id}: § ${n} missing`);
    }
  }
});

test('manual: searchRules() mixes 1956 paragraphs and manual entries, shape of manual hits', async () => {
  await ready();
  const res = engine.searchRules('тире подлежащее сказуемое', 10);
  assert.ok(res.length > 0 && res.length <= 10);
  const manual = res.filter((x) => x.source === 'manual');
  const rules = res.filter((x) => typeof x.n === 'number');
  assert.ok(manual.length >= 1, JSON.stringify(res));
  assert.ok(rules.some((x) => x.n === 164 || x.n === 165), JSON.stringify(res));
  for (const m of manual) {
    assert.equal(m.n, null);
    assert.match(m.id, /^pm-/);
    assert.equal(m.group, 'Пособие по пунктуации');
    assert.match(m.url, /\.pdf#page=\d+$/);
    assert.ok(m.section && m.snippet);
  }
  // existing expectations about the 1956 search still hold with the manual mixed in
  assert.equal(engine.searchRules('буква ё', 3)[0].n, 10);
  assert.ok(engine.searchRules('запятая придаточное главное').slice(0, 3).some((x) => x.n === 140));
  assert.deepEqual(engine.searchRules(''), []);
  const addr = engine.searchRules('обращение', 5);
  assert.equal(addr.length, 5);
  assert.ok(addr.every((x) => x.source === 'manual' || typeof x.n === 'number'));
});

test('manual: worker exposes manualRule; basesInfo lists the manual module', async () => {
  await ready();
  assert.ok(worker.METHODS.has('manualRule'));
  const reply = await worker.handle({ id: 1, method: 'manualRule', args: ['pm-yes-no'] });
  assert.ok(!reply.error && reply.result && reply.result.page === 18);
  const mod = engine.basesInfo().modules.find((m) => m.id === 'punct-manual');
  assert.ok(mod && mod.status === 'builtin' && /81/.test(mod.detail) && mod.toggle === false);
});

module.exports = { run, expectFix, expectClean };
