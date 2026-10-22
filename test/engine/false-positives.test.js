'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, describe, engine } = require('./helpers');

const { TEXTS } = require('./fp-texts'); // shared with scripts/lt/calibrate.js

for (const [name, paras] of Object.entries(TEXTS)) {
  test(`no false positives: ${name}`, async () => {
    await ready();
    const { issues } = engine.check(doc(paras));
    assert.ok(issues.length <= 1, `${issues.length} issues in clean text:\n${describe(issues)}`);
  });
}

test('no false positives: all four texts together give at most 1 issue', async () => {
  await ready();
  const all = Object.values(TEXTS).flat();
  const { issues } = engine.check(doc(all));
  assert.ok(issues.length <= 1, `${issues.length} issues:\n${describe(issues)}`);
});

test('literary: clean texts score high and produce few style signals', async () => {
  await ready();
  const all = Object.values(TEXTS).flat();
  const res = engine.literary(doc(all));
  assert.ok(res.score >= 8, `score ${res.score}`);
  const kanc = res.metrics.find((m) => m.id === 'kanc').count;
  assert.ok(kanc <= 2, `kanc ${kanc}:\n${describe(res.issues)}`);
});

test('proper nouns, abbreviations, latin and numbers are not spelling errors', async () => {
  await ready();
  const { issues } = engine.check(doc([
    'Мы встретились с Ксенией Ромашкиной из компании ЮНЕСКО в офисе на Покровке, обсудили API и релиз 2.0.',
    'Ибрагимов прислал PDF-файл и ссылку на GitHub, а также 3D-модель для печати.',
  ]));
  assert.equal(issues.filter((is) => is.category === 'spelling').length, 0, describe(issues));
});
