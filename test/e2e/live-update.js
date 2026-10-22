// Live check against the real GitHub repository: an installed older build updates its bases and then itself.
// usage: node test/e2e/live-update.js /path/to/Vychitka.app
const { _electron: electron } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const appPath = process.argv[2];
const exe = path.join(appPath, 'Contents', 'MacOS', 'Vychitka');
const version = () => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')]).toString().trim();

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vlive-'));
  const env = { ...process.env, VYCHITKA_NO_UPDATE_CHECK: '1', VYCHITKA_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('установлена версия', version());
  const app = await electron.launch({ executablePath: exe, env });
  const win = await app.firstWindow();
  await win.waitForSelector('#pasteArea');
  const before = await win.evaluate(() => window.api.info());
  console.log('базы до:', before.bases.version);
  const bc = await win.evaluate(() => window.api.basesCheck());
  console.log('проверка баз:', JSON.stringify({ current: bc.current, remote: bc.remote, newer: bc.newer, compatible: bc.compatible, changedFiles: bc.changedFiles }));
  if (bc.newer && !bc.compatible) {
    console.log('базы требуют более новую версию приложения — не скачиваются, как и задумано');
    const err = await win.evaluate(() => window.api.basesUpdate().then(() => 'скачались (ошибка)', e => e.message));
    console.log('попытка обновить базы:', err.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } else if (bc.newer) {
    const bu = await win.evaluate(() => window.api.basesUpdate());
    console.log('обновление баз:', JSON.stringify({ updated: bu.updated, version: bu.version }));
  }
  const states = [];
  await win.exposeFunction('__upd', s => states.push(s));
  await win.evaluate(() => window.api.onAppUpdate(s => window.__upd(s)));
  await win.evaluate(() => window.api.appUpdateCheck());
  await win.waitForTimeout(1500);
  const avail = states.find(s => s.status === 'available');
  console.log('проверка приложения:', JSON.stringify(states[states.length - 1]));
  if (!avail) { await app.close(); process.exit(1); }
  console.log('устанавливаю', avail.version, '…');
  win.evaluate(() => window.api.appUpdateInstall()).catch(() => {});
  await new Promise(r => app.process().once('exit', r));
  await new Promise(r => setTimeout(r, 4000));
  console.log('версия в бандле после обновления:', version());
  try { execFileSync('pkill', ['-f', exe]); } catch { /* relaunched copy may already be gone */ }
  // the updated build starts with its own bundled bases and finds nothing newer
  const app2 = await electron.launch({ executablePath: exe, env });
  const w2 = await app2.firstWindow();
  await w2.waitForSelector('#pasteArea');
  const i2 = await w2.evaluate(() => window.api.info());
  const b2 = await w2.evaluate(() => window.api.basesCheck());
  const dal = await w2.evaluate(() => window.api.engine('wordInfo', 'лебезить'));
  console.log('после обновления:', JSON.stringify({ version: i2.version, bases: i2.bases.version, newerBases: b2.newer, dal: !!(dal && dal.dal) }));
  await app2.close();
})().catch(e => { console.error(e); process.exit(1); });
