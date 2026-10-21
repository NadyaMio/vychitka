// The renderer's document model runs in the browser; here it is loaded into a VM context with the same globals.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { Diff: require('diff') };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/model.js'), 'utf8') + '\nthis.Model = Model;', ctx);
const M = ctx.Model;
const p = (...runs) => ({ kind: 'p', runs });

test('replaceRange сохраняет форматирование заменяемого фрагмента', () => {
  const runs = [{ text: 'кафе на ' }, { text: 'Покровке', b: true }, { text: ' что бы' }];
  const out = M.replaceRange(runs, 8, 16, 'Покровке,');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [{ text: 'кафе на ' }, { text: 'Покровке,', b: true }, { text: ' что бы' }]);
});

test('applyFixes применяет несколько правок справа налево', () => {
  const doc = { paragraphs: [p({ text: 'Мы решили что до поздна' })] };
  const out = M.applyFixes(doc, [{ para: 0, start: 3, end: 13, after: 'решили, что' }, { para: 0, start: 14, end: 23, after: 'допоздна' }]);
  assert.strictEqual(M.textOf(out.paragraphs[0]), 'Мы решили, что допоздна');
  assert.strictEqual(M.textOf(doc.paragraphs[0]), 'Мы решили что до поздна', 'исходный документ не меняется');
});

test('пересекающиеся правки: вторая пропускается', () => {
  const doc = { paragraphs: [p({ text: 'абвгд' })] };
  const out = M.applyFixes(doc, [{ para: 0, start: 0, end: 3, after: 'X' }, { para: 0, start: 2, end: 5, after: 'Y' }]);
  assert.strictEqual(M.textOf(out.paragraphs[0]), 'абY');
});

test('fixSegments: удаление и вставка с сохранением жирного', () => {
  const segs = M.fixSegments(p({ text: 'хотел ' }, { text: 'высказатся', b: true }), [{ start: 6, end: 16, after: 'высказаться' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(segs)), [{ type: 'eq', text: 'хотел ' }, { type: 'del', b: true, text: 'высказатся' }, { type: 'ins', b: true, text: 'высказаться' }]);
});

test('trackedParagraphs: удалённый абзац и правка внутри абзаца', () => {
  const orig = { paragraphs: [p({ text: 'Один.' }), p({ text: 'Два три.' }), p({ text: 'Четыре.' })] };
  const cur = { paragraphs: [p({ text: 'Один.' }), p({ text: 'Четыре!' })] };
  const tr = JSON.parse(JSON.stringify(M.trackedParagraphs(orig, cur)));
  assert.strictEqual(tr.length, 3);
  assert.ok(tr.some(x => x.segments.every(s => s.type === 'del') && x.segments.map(s => s.text).join('') === 'Два три.'));
  const last = tr[tr.length - 1].segments;
  assert.ok(last.some(s => s.type === 'ins' && s.text.includes('Четыре!')) || last.some(s => s.type === 'ins'));
});

test('insertedRanges находит ручную вставку', () => {
  const r = JSON.parse(JSON.stringify(M.insertedRanges('назначить ответственных.', 'назначить ответственных и поставить сроки.')));
  assert.strictEqual(r.length, 1);
  assert.strictEqual('назначить ответственных и поставить сроки.'.slice(r[0].start, r[0].end).trim(), 'и поставить сроки');
});

test('paragraphHtml экранирует HTML и расставляет пометки', () => {
  const h = M.paragraphHtml(p({ text: '<script>x</script> что бы' }), [{ start: 19, end: 25, cls: 'sp', key: 'k' }]);
  assert.ok(!h.includes('<script>'));
  assert.match(h, /<span class="m sp" data-k="k">что бы<\/span>/);
});

