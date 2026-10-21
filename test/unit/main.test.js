const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { rtfToText, markdownToHtml, plainToHtml, decodeText } = require('../../src/main/files');
const { compareVersions, resolveBasesDir, BasesUpdater } = require('../../src/main/updates');
const { buildDocx } = require('../../src/main/save');

test('RTF: кириллица в cp1251 и \\u-последовательностях', () => {
  const u = n => '\\u' + n + '?';
  const rtf = String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0 Times;}}\f0 \'cf\'f0\'e8\'e2\'e5\'f2, ` + u(1084) + u(1080) + u(1088) + String.raw`!\par Второй}`;
  const t = rtfToText(rtf);
  assert.match(t, /Привет, мир!/);
  assert.match(t, /\n/);
});

test('Markdown: заголовок, жирный, курсив, ссылка', () => {
  const h = markdownToHtml('# Заголовок\n\nТекст **жирный** и *курсив* [ссылка](https://x.ru)');
  assert.match(h, /<h1>Заголовок<\/h1>/);
  assert.match(h, /<b>жирный<\/b>/);
  assert.match(h, /<i>курсив<\/i>/);
  assert.match(h, /<a href="https:\/\/x.ru">ссылка<\/a>/);
});

test('TXT: абзацы и перенос с дефисом сохраняется', () => {
  const h = plainToHtml('Первый абзац.\n\nВнешний дизайн-\nер.');
  assert.strictEqual(h, '<p>Первый абзац.</p><p>Внешний дизайн-<br>ер.</p>');
});

test('кодировки: UTF-8 с BOM и Windows-1251', () => {
  assert.strictEqual(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0xd0, 0xb0])), 'а');
  assert.strictEqual(decodeText(Buffer.from([0xcf, 0xf0, 0xe8])), 'При');
});

test('сравнение версий', () => {
  assert.strictEqual(compareVersions('2026.10.2', '2026.10.1'), 1);
  assert.strictEqual(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.strictEqual(compareVersions('0.9.9', '0.10.0'), -1);
});

function mkBases(dir, version, files) {
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
    list.push({ path: p, size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  const manifest = { version, date: '2026-10-21', ref: `bases-${version}`, files: list };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('выбор каталога баз: скачанные новее встроенных', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  mkBases(path.join(tmp, 'bundled'), '2026.10.1', { 'a.txt': 'a' });
  assert.strictEqual(resolveBasesDir(path.join(tmp, 'bundled'), path.join(tmp, 'user')), path.join(tmp, 'bundled'));
  mkBases(path.join(tmp, 'user'), '2026.11.1', { 'a.txt': 'b' });
  assert.strictEqual(resolveBasesDir(path.join(tmp, 'bundled'), path.join(tmp, 'user')), path.join(tmp, 'user'));
});

async function serve(root) {
  const srv = http.createServer((req, res) => {
    // /main/bases/manifest.json  and  /<ref>/bases/<file>
    const m = req.url.match(/^\/([^/]+)\/bases\/(.+)$/);
    const file = m && path.join(root, m[1] === 'main' ? 'remote' : 'remote', decodeURIComponent(m[2]));
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

test('обновление баз: качаются только изменённые файлы, проверяется sha256', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  mkBases(path.join(tmp, 'bundled'), '2026.10.1', { 'az/words.dawg': 'old-words', 'rules/x.json': '{"a":1}' });
  mkBases(path.join(tmp, 'remote'), '2026.11.1', { 'az/words.dawg': 'new-words', 'rules/x.json': '{"a":1}' });
  const { srv, url } = await serve(tmp);
  try {
    const progress = [];
    const u = new BasesUpdater({ bundledDir: path.join(tmp, 'bundled'), userDir: path.join(tmp, 'user'), appVersion: '0.1.0', rawUrl: url, onProgress: p => progress.push(p) });
    const info = await u.check();
    assert.strictEqual(info.newer, true);
    assert.strictEqual(info.changedFiles, 1);
    const r = await u.update();
    assert.deepStrictEqual(r, { updated: true, version: '2026.11.1' });
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'user', 'az/words.dawg'), 'utf8'), 'new-words');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'user', 'rules/x.json'), 'utf8'), '{"a":1}');
    assert.strictEqual(u.currentDir(), path.join(tmp, 'user'));
    assert.strictEqual((await u.update()).updated, false);
  } finally { srv.close(); }
});

test('обновление баз: повреждённый файл не ломает текущие базы', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  mkBases(path.join(tmp, 'bundled'), '2026.10.1', { 'a.txt': 'old' });
  const m = mkBases(path.join(tmp, 'remote'), '2026.11.1', { 'a.txt': 'new' });
  fs.writeFileSync(path.join(tmp, 'remote', 'a.txt'), 'tampered');
  const { srv, url } = await serve(tmp);
  try {
    const u = new BasesUpdater({ bundledDir: path.join(tmp, 'bundled'), userDir: path.join(tmp, 'user'), appVersion: '0.1.0', rawUrl: url });
    await assert.rejects(u.update(), /контрольная сумма/);
    assert.strictEqual(u.currentDir(), path.join(tmp, 'bundled'));
    assert.ok(m);
  } finally { srv.close(); }
});

test('DOCX с режимом правок содержит w:ins и w:del', async () => {
  const JSZip = require('jszip');
  const buf = await buildDocx([{ kind: 'p', segments: [{ type: 'eq', text: 'Мы решили' }, { type: 'ins', text: ',' }, { type: 'eq', text: ' что ' }, { type: 'del', text: 'до поздна', b: true }, { type: 'ins', text: 'допоздна' }] }], { track: true });
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.match(xml, /<w:ins\b/);
  assert.match(xml, /<w:del\b/);
  assert.match(xml, /w:author="Вычитка"/);
  const clean = await buildDocx([{ kind: 'p', segments: [{ type: 'eq', text: 'текст' }, { type: 'del', text: 'лишнее' }] }], { track: false });
  const cx = await (await JSZip.loadAsync(clean)).file('word/document.xml').async('string');
  assert.ok(!cx.includes('лишнее'));
});
