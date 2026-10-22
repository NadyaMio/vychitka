'use strict';

// The gap tokeniser in scripts/eval/eval-punct.js must agree with the one in
// scripts/eval/build-punct-set.py (its --selftest covers the same cases).

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, classifyChange, isOrthographic, changeType, unmatchedParens, Scorer } = require('../../scripts/eval/eval-punct');

function gapNorms(text) {
  return analyze(text).info.map((i) => i.norm);
}

test('eval-punct: words and gaps', () => {
  const a = analyze('Я думаю, что он придёт.');
  assert.deepEqual(a.words.map((w) => w.text), ['Я', 'думаю', 'что', 'он', 'придёт']);
  assert.deepEqual(a.gaps.map((g) => g.text), ['', ' ', ', ', ' ', ' ', '.']);
  assert.deepEqual(a.keys, ['я', 'думаю', 'что', 'он', 'придет']);
  assert.equal(a.gaps[2].start, 7);
  assert.equal(a.gaps[2].end, 9);
});

test('eval-punct: glyphs inside a class are neutral', () => {
  assert.deepEqual(gapNorms('Москва - столица'), gapNorms('Москва — столица'));
  assert.deepEqual(gapNorms('он сказал "привет" и ушёл'), gapNorms('он сказал «привет» и ушёл'));
  assert.deepEqual(gapNorms('ну...'), gapNorms('ну…'));
  assert.deepEqual(gapNorms('в 2010-2012 годах'), gapNorms('в 2010–2012 годах'));
});

test('eval-punct: hyphen vs dash, unmatched brackets', () => {
  assert.equal(analyze('кто-то').info[1].classes, 'h');
  assert.equal(analyze('слово - слово').info[1].classes, '—');
  assert.equal(analyze('перелом- это').info[1].classes, '—');
  assert.equal(analyze('- Привет').info[0].classes, '—');
  assert.deepEqual([...unmatchedParens('налицо ) и (вот) ещё')], [7]);
  assert.equal(analyze('налицо )').info[1].classes, 'o');
  assert.equal(analyze('(вот)').info[0].classes, '(');
});

test('eval-punct: change classification', () => {
  assert.deepEqual(classifyChange('', ','), { added: ',', removed: '' });
  assert.deepEqual(classifyChange(';', ','), { added: ',', removed: ';' });
  assert.equal(changeType(',', ';'), ',;');
  assert.equal(changeType('', ''), 'space');
  assert.equal(isOrthographic('h', ''), true);
  assert.equal(isOrthographic('.', 'o'), true);
  assert.equal(isOrthographic(',', ''), false);
  assert.equal(isOrthographic('', ''), false);
});

test('eval-punct: hit rule', () => {
  const ref = { added: ',', removed: '', refNorm: ', ' };
  assert.equal(Scorer.hit({ added: ',', removed: '', norm: ', ' }, ref), true);
  assert.equal(Scorer.hit({ added: ',', removed: '', norm: ',' }, ref), true); // same sign, spacing differs
  assert.equal(Scorer.hit({ added: '—', removed: '', norm: ' — ' }, ref), false);
  const replace = { added: '—', removed: ',', refNorm: ' — ' };
  assert.equal(Scorer.hit({ added: '—', removed: '', norm: ', — ' }, replace), true); // partial fix counts
  assert.equal(Scorer.hit({ added: '', removed: '', norm: ' ' }, replace), false); // space-only change is not a hit
  const space = { added: '', removed: '', refNorm: ', ' };
  assert.equal(Scorer.hit({ added: '', removed: '', norm: ', ' }, space), true);
});

test('eval-punct: issue → gap changes', () => {
  const scorer = new Scorer({ withTerminal: false });
  const text = 'Я думаю что он придёт';
  const src = analyze(text);
  const changes = scorer.issueChanges(text, src, { start: 2, end: 11, before: 'думаю что', after: 'думаю, что', ruleId: 'punct.comma-before-conj' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].k, 2);
  assert.equal(changes[0].added, ',');
  const neutral = scorer.issueChanges('а - б', analyze('а - б'), { start: 1, end: 4, before: ' - ', after: ' — ', ruleId: 'typo.dash' });
  assert.deepEqual(neutral, []);
  assert.equal(scorer.neutralByRule['typo.dash'], 1);
  const words = scorer.issueChanges('он пошол', analyze('он пошол'), { start: 3, end: 8, before: 'пошол', after: 'пошёл', ruleId: 'spell.unknown' });
  assert.equal(words, null);
  const broken = scorer.issueChanges('он пошол', analyze('он пошол'), { start: 0, end: 2, before: 'xx', after: 'yy', ruleId: 'x' });
  assert.equal(broken, null);
  assert.equal(scorer.broken, 1);
});
