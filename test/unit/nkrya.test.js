// НКРЯ: the client is tested against a local server that answers like the documented API (ruscorpora.github.io/public-api).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let calls = 0;
const srv = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  if (auth !== 'Bearer good-token') { res.statusCode = 401; return res.end('{}'); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/auth/check-authenticated/') return res.end('true');
  if (url.pathname === '/api/v1/auth/me/') return res.end(JSON.stringify({ username: 'nadya' }));
  if (url.pathname === '/api/v1/word-portrait/') {
    calls++;
    const q = JSON.parse(url.searchParams.get('query'));
    assert.deepStrictEqual(q.resultType, ['PORTRAIT_FREQUENCY', 'PORTRAIT_CONCORDANCE']);
    return res.end(JSON.stringify({
      possiblePos: ['A'],
      frequencyData: { ipm: 154.191, category: 4 },
      concordanceData: { groups: [{ docs: [{ info: { title: 'Л. Толстой. Война и мир (source/pre1950/x.xml) (1869)' }, snippetGroups: [{ snippets: [{ sequences: [{ words: [
        { text: 'Он' }, { text: 'был' }, { text: q.lemma, displayParams: { hit: true } }, { text: 'человек' }, { text: '.' },
      ] }] }] }] }] }] },
    }));
  }
  res.statusCode = 404; res.end();
});

test('НКРЯ: подключение токена, частотность, примеры, кеш, неверный токен', async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.VYCHITKA_NKRYA_API = `http://127.0.0.1:${srv.address().port}/api/v1`;
  delete require.cache[require.resolve('../../src/main/nkrya')];
  const { Nkrya } = require('../../src/main/nkrya');
  let data = {};
  const store = { get: () => data, set: p => (data = { ...data, ...p }) };
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-')), 'cache.json');
  const nk = new Nkrya({ store, safeStorage: null, cacheFile });
  try {
    assert.strictEqual(nk.status().connected, false);
    await assert.rejects(nk.portrait('ответственный'), /не подключён/);
    await assert.rejects(nk.connect('bad'), /не принял токен/);
    const st = await nk.connect('good-token');
    assert.strictEqual(st.connected, true);
    assert.strictEqual(st.user, 'nadya');
    const p = await nk.portrait('ответственный');
    assert.strictEqual(p.frequency.category, 4);
    assert.match(p.frequency.title, /скорее высокая/);
    assert.strictEqual(p.examples[0].text, 'Он был ответственный человек.');
    assert.deepStrictEqual(p.examples[0].hits, [[7, 20]]);
    assert.strictEqual(p.examples[0].title, 'Л. Толстой. Война и мир (1869)');
    await nk.portrait('Ответственный');
    assert.strictEqual(calls, 1, 'повторный запрос должен взяться из кеша');
    assert.ok(fs.existsSync(cacheFile));
    assert.strictEqual(nk.disconnect().connected, false);
  } finally { srv.close(); }
});

test('НКРЯ: подсчёт запятой между словами в выборке корпуса', () => {
  const { countGap } = require('../../src/main/nkrya');
  const snip = (withComma) => ({ sequences: [{ words: [
    { text: 'и', displayParams: { hit: true } }, { text: ' ' }, { text: 'то', displayParams: { hit: true } }, { text: withComma ? ', ' : ' ' },
    { text: 'и', displayParams: { hit: true } }, { text: ' ' }, { text: 'другое', displayParams: { hit: true } }, { text: '.' },
  ] }] });
  const data = { groups: [{ docs: [{ info: { title: 'Т' }, snippetGroups: [{ snippets: [snip(false), snip(false), snip(true)] }] }] }] };
  const r = countGap(data, 4, 1);
  assert.deepStrictEqual([r.sample, r.comma, r.plain], [3, 1, 2]);
  assert.strictEqual(r.examples.comma.text, 'и то, и другое.');
  assert.strictEqual(r.examples.plain.text, 'и то и другое.');
});
