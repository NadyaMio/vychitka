#!/usr/bin/env node
'use strict';

/**
 * Rebuild bases/manifest.json: sha256 + size of every file under bases/
 * (except manifest.json itself) and the list of modules.
 *
 *   node scripts/build-bases-manifest.js [version] [--bases <dir>]
 *
 * Version: explicit argument (e.g. 2026.10.1) or the current manifest version
 * with the last (patch) component incremented; if there is no manifest yet —
 * YYYY.M.1 from today's date.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODULES = [
  { id: 'spelling-opencorpora', title: 'Орфографический словарь (OpenCorpora)', dir: 'az', license: 'CC BY-SA 4.0 (данные) · MIT (Az.js)' },
  { id: 'spelling-freq', title: 'Частотный список (FrequencyWords)', dir: 'freq', license: 'CC BY-SA 4.0' },
  { id: 'spelling-extra', title: 'Дополнительный словарь', dir: 'extra', license: 'проект «Вычитка»' },
  { id: 'rules', title: 'Правила проверки (данные)', dir: 'rules', license: 'проект «Вычитка»' },
  { id: 'rules1956', title: 'Правила орфографии и пунктуации (1956)', dir: 'reference', license: 'официальный нормативный документ · публикация therules.ru' },
  { id: 'dal', title: 'Толковый словарь Даля (2-е издание)', dir: 'dal', license: 'текст — общественное достояние · оцифровка Викитеки — CC BY-SA 4.0' },
];

function parseArgs(argv) {
  const out = { version: null, basesDir: path.resolve(__dirname, '..', 'bases') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bases') out.basesDir = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/build-bases-manifest.js [version] [--bases <dir>]');
      process.exit(0);
    } else if (!out.version) out.version = a;
  }
  return out;
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile() && name !== 'manifest.json' && !name.startsWith('.')) {
      out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, sha256: sha256(full) });
    }
  }
  return out;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function bumpVersion(prev) {
  const now = new Date();
  if (!prev || !/^\d+\.\d+\.\d+$/.test(prev)) return `${now.getFullYear()}.${now.getMonth() + 1}.1`;
  const parts = prev.split('.').map(Number);
  parts[2] += 1;
  return parts.join('.');
}

function validateJson(basesDir, files) {
  for (const f of files) {
    if (!f.path.endsWith('.json')) continue;
    try {
      JSON.parse(fs.readFileSync(path.join(basesDir, f.path), 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON: ${f.path}: ${err.message}`);
    }
  }
}

function build({ version, basesDir }) {
  if (!fs.existsSync(basesDir)) throw new Error(`bases dir not found: ${basesDir}`);
  const manifestFile = path.join(basesDir, 'manifest.json');
  let prev = null;
  if (fs.existsSync(manifestFile)) {
    try { prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { prev = null; }
  }
  const files = walk(basesDir, basesDir, []);
  validateJson(basesDir, files);
  const finalVersion = version || bumpVersion(prev && prev.version);
  if (!/^\d+\.\d+\.\d+$/.test(finalVersion)) throw new Error(`version must look like 2026.10.1, got "${finalVersion}"`);
  const modules = MODULES.map((m) => {
    const own = files.filter((f) => f.path.startsWith(m.dir + '/'));
    return { id: m.id, title: m.title, dir: m.dir, license: m.license, files: own.length, bytes: own.reduce((n, f) => n + f.size, 0), version: finalVersion, status: own.length ? 'builtin' : 'missing' };
  });
  const manifest = {
    version: finalVersion,
    date: new Date().toISOString().slice(0, 10),
    files,
    modules,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  try {
    const m = build(parseArgs(process.argv.slice(2)));
    console.log(`manifest.json: version ${m.version}, ${m.files.length} files, ${(m.totalBytes / 1048576).toFixed(1)} MB`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, walk, sha256, bumpVersion };
