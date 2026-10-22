'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ready, engine, initMs, BASES_DIR } = require('./helpers');
const dal = require('../../src/engine/dal');

const DATA_FILE = path.join(BASES_DIR, 'dal', 'dal.json.gz');
const WIKI_PREFIX = 'https://ru.wikisource.org/wiki/%D0%A2%D0%A1%D0%942/'; // encodeURI('…/wiki/ТСД2/')

test('dal: init stays fast and does not load the dictionary', async () => {
  await ready();
  assert.ok(initMs() <= 1500, `init took ${initMs()} ms`);
  assert.equal(dal.isLoaded(), false, 'dictionary must be loaded lazily, not on init');
  assert.ok(fs.existsSync(DATA_FILE), `missing ${DATA_FILE} — run scripts/fetch-dal.py`);
  const mod = engine.basesInfo().modules.find((m) => m.id === 'dal');
  assert.ok(mod, 'basesInfo has module dal');
  assert.equal(mod.title, 'Толковый словарь Даля');
  assert.equal(mod.status, 'builtin');
  assert.equal(mod.toggle, false);
  assert.match(mod.detail, /^\d[\d\s ]* статей · 2-е издание · по Викитеке \(CC BY-SA\)$/);
  assert.ok(mod.bytes > 1_000_000, `bytes ${mod.bytes}`);
  assert.equal(dal.isLoaded(), false, 'basesInfo must not load the dictionary either');
});

test('dal: normalizeKey maps old orthography and ё to the modern key', () => {
  assert.equal(dal.normalizeKey('Лицо́'), 'лицо');
  assert.equal(dal.normalizeKey('отвѣтъ'), 'ответ');
  assert.equal(dal.normalizeKey('Ѳома'), 'фома');
  assert.equal(dal.normalizeKey('міръ'), 'мир');
  assert.equal(dal.normalizeKey('ёлка'), 'елка');
  assert.equal(dal.normalizeKey('Лихоща́вый?'), 'лихощавый');
  assert.equal(dal.normalizeKey('—умоватый'), 'умоватый');
});

test('dal: wordInfo of a frequent word returns a non-empty article with a Wikisource link', async () => {
  await ready();
  const info = engine.wordInfo('ответственный');
  assert.ok(info.dal, 'wordInfo(...).dal is filled');
  assert.ok(info.dal.word && info.dal.word.length >= 3, `head: ${info.dal.word}`);
  assert.ok(info.dal.text.length > 80, `text too short: ${info.dal.text}`);
  assert.ok(info.dal.text.length <= 1300, `text not shortened: ${info.dal.text.length}`);
  assert.ok(info.dal.url.startsWith(WIKI_PREFIX), info.dal.url);
  assert.equal(dal.isLoaded(), true);
  // old orthography is preserved in the article body
  const full = dal.lookup('отвечать');
  assert.ok(full && /[ѣъі]/.test(full.text), 'article keeps ѣ/ъ/і as printed');
});

test('dal: own articles are found by word, lemma and inflected forms', async () => {
  await ready();
  const lico = engine.wordInfo('лицо').dal;
  assert.ok(lico && /^Лицо/.test(lico.word), JSON.stringify(lico && lico.word));
  const inflected = engine.wordInfo('лицами').dal; // via lemma from Az
  assert.ok(inflected && inflected.url === lico.url, 'inflected form resolves through the lemma');
  const unknown = engine.wordInfo('кбзщрпл').dal;
  assert.equal(unknown, null);
  assert.equal(engine.wordInfo('').dal, null);
});

test('dal: forms with ё and ѣ reach the same article', async () => {
  await ready();
  const a = dal.lookup('лицѣ');
  const b = dal.lookup('лицо');
  assert.ok(a && b && a.url === b.url, 'ѣ-form resolves to the same article');
  const yo = dal.lookup('ёкать');
  assert.ok(yo && /^Ёкать|^Екать/.test(yo.head), JSON.stringify(yo && yo.head));
  const yo2 = dal.lookup('екать');
  assert.ok(yo2 && yo2.url === yo.url);
  const old = dal.lookup('отвѣтственный');
  assert.ok(old && old.url === engine.wordInfo('ответственный').dal.url);
});

test('dal: excerpt cuts at a sentence boundary and adds an ellipsis', () => {
  const sentence = 'Первое предложение словаря. ';
  const long = sentence.repeat(100);
  const cut = dal.excerpt(long, 300);
  assert.ok(cut.length <= 301, `length ${cut.length}`);
  assert.ok(cut.endsWith('.…'), JSON.stringify(cut.slice(-10)));
  assert.equal(dal.excerpt('короткий текст', 300), 'короткий текст');
  const noDots = 'слово '.repeat(100);
  const cut2 = dal.excerpt(noDots, 100);
  assert.ok(cut2.length <= 101 && cut2.endsWith('…') && !cut2.endsWith(' …'));
});

test('dal: wordInfo fields keep their shape when the card has no Dal article', async () => {
  await ready();
  const info = engine.wordInfo('онбординг');
  assert.equal(info.dal, null);
  assert.ok(Array.isArray(info.morph));
});
