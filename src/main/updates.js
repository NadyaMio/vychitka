// Two update channels, both from the public GitHub repository:
// 1. Dictionary bases — bases/manifest.json on `main` names a version and a git tag; files are fetched from that tag,
//    verified by sha256 and swapped in atomically. The app keeps working on the old bases if anything fails.
// 2. The app itself — Windows: electron-updater (NSIS, latest.yml in the release).
//    macOS: the build is not notarized, so Squirrel.Mac cannot be used; we download the release .dmg,
//    copy the .app over the current bundle and relaunch. If the bundle is not writable, the .dmg is opened instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = 'NadyaMio/vychitka';
const RAW = `https://raw.githubusercontent.com/${REPO}`;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Vychitka', Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function download(url, dest, onBytes) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Vychitka' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    onBytes && onBytes(value.length);
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
}

// Pick the newest valid bases directory: the one bundled with the app or the downloaded one in userData.
function resolveBasesDir(bundledDir, userDir) {
  const b = readManifest(bundledDir);
  const u = readManifest(userDir);
  if (u && (!b || compareVersions(u.version, b.version) > 0)) return userDir;
  return bundledDir;
}

class BasesUpdater {
  constructor({ bundledDir, userDir, appVersion, onProgress, rawUrl = RAW }) {
    Object.assign(this, { bundledDir, userDir, appVersion, onProgress, rawUrl });
  }
  currentDir() { return resolveBasesDir(this.bundledDir, this.userDir); }
  current() { return readManifest(this.currentDir()); }

  async check() {
    const remote = await fetchJson(`${this.rawUrl}/main/bases/manifest.json`);
    const cur = this.current();
    const newer = !cur || compareVersions(remote.version, cur.version) > 0;
    const compatible = !remote.minApp || compareVersions(this.appVersion, remote.minApp) >= 0;
    const changed = remote.files.filter(f => !cur || !cur.files.find(c => c.path === f.path && c.sha256 === f.sha256));
    return {
      current: cur && cur.version, remote: remote.version, date: remote.date, newer, compatible,
      changedFiles: changed.length, bytes: changed.reduce((s, f) => s + (f.size || 0), 0), remoteManifest: remote,
    };
  }

  async update() {
    const info = await this.check();
    if (!info.newer) return { updated: false, version: info.current };
    if (!info.compatible) throw new Error(`Для баз ${info.remote} нужна версия приложения ${info.remoteManifest.minApp} или новее. Сначала обновите приложение.`);
    const remote = info.remoteManifest;
    const ref = remote.ref || `bases-${remote.version}`;
    const curDir = this.currentDir();
    const cur = readManifest(curDir);
    const tmp = this.userDir + '.download';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    let done = 0;
    const total = info.bytes || 1;
    for (const f of remote.files) {
      const dest = path.join(tmp, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const same = cur && cur.files.find(c => c.path === f.path && c.sha256 === f.sha256);
      if (same && fs.existsSync(path.join(curDir, f.path))) {
        fs.copyFileSync(path.join(curDir, f.path), dest);
      } else {
        await download(`${this.rawUrl}/${ref}/bases/${f.path}`, dest, n => { done += n; this.onProgress && this.onProgress({ phase: 'download', done, total }); });
      }
      if (sha256(dest) !== f.sha256) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`Файл ${f.path} пришёл повреждённым (не совпала контрольная сумма). Базы не изменены.`);
      }
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(remote, null, 2));
    const old = this.userDir + '.old';
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(this.userDir)) fs.renameSync(this.userDir, old);
    fs.renameSync(tmp, this.userDir);
    fs.rmSync(old, { recursive: true, force: true });
    this.onProgress && this.onProgress({ phase: 'done', done: total, total });
    return { updated: true, version: remote.version };
  }
}

class AppUpdater {
  constructor({ app, shell, platform, onEvent }) {
    Object.assign(this, { app, shell, platform, onEvent });
    this.state = { status: 'idle' };
    if (platform === 'win32') {
      const { autoUpdater } = require('electron-updater');
      this.au = autoUpdater;
      autoUpdater.autoDownload = false;
      autoUpdater.on('update-available', i => this._set({ status: 'available', version: i.version }));
      autoUpdater.on('update-not-available', () => this._set({ status: 'latest' }));
      autoUpdater.on('download-progress', p => this._set({ status: 'downloading', percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', i => this._set({ status: 'ready', version: i.version }));
      autoUpdater.on('error', e => this._set({ status: 'error', message: e.message }));
    }
  }
  _set(s) { this.state = { ...this.state, ...s }; this.onEvent(this.state); }

  async check() {
    if (!this.app.isPackaged) return this._set({ status: 'dev', message: 'Обновления работают только в собранном приложении.' });
    this._set({ status: 'checking' });
    if (this.au) { await this.au.checkForUpdates(); return this.state; }
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const version = rel.tag_name.replace(/^v/, '');
    if (compareVersions(version, this.app.getVersion()) <= 0) return this._set({ status: 'latest' });
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = rel.assets.find(a => a.name.endsWith(`-mac-${arch}.dmg`)) || rel.assets.find(a => a.name.endsWith('.dmg'));
    if (!asset) return this._set({ status: 'latest' });
    this.macAsset = asset;
    return this._set({ status: 'available', version, notes: rel.body || '' });
  }

  async install() {
    if (this.au) {
      if (this.state.status === 'ready') return this.au.quitAndInstall(false, true);
      await this.au.downloadUpdate();
      return;
    }
    const asset = this.macAsset;
    if (!asset) throw new Error('Сначала проверьте обновления.');
    const dmg = path.join(this.app.getPath('temp'), asset.name);
    let done = 0;
    await download(asset.browser_download_url, dmg, n => { done += n; this._set({ status: 'downloading', percent: Math.round((done / asset.size) * 100) }); });
    const bundle = path.resolve(this.app.getPath('exe'), '..', '..', '..');
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      const mount = await this._attach(dmg);
      const appName = fs.readdirSync(mount).find(n => n.endsWith('.app'));
      if (!appName) throw new Error('В образе нет приложения');
      await run('ditto', [path.join(mount, appName), bundle + '.new']);
      await run('hdiutil', ['detach', mount, '-quiet']);
      fs.rmSync(bundle + '.old', { recursive: true, force: true });
      fs.renameSync(bundle, bundle + '.old');
      fs.renameSync(bundle + '.new', bundle);
      fs.rmSync(bundle + '.old', { recursive: true, force: true });
      this._set({ status: 'ready' });
      this.app.relaunch();
      this.app.exit(0);
    } catch (e) {
      // No write access (e.g. a managed /Applications): hand the image to the user.
      this._set({ status: 'manual', message: 'Откройте образ и перетащите «Вычитку» в «Программы».' });
      await this.shell.openPath(dmg);
    }
  }

  async _attach(dmg) {
    const out = await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-plist']);
    const mounts = [...out.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(m => m[1]);
    if (!mounts.length) throw new Error('Не удалось смонтировать образ');
    return mounts[0];
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
}

module.exports = { BasesUpdater, AppUpdater, resolveBasesDir, compareVersions, readManifest };
