// Smoke test of the packaged app: engine and bases must load from the bundle's resources.
const { _electron: electron } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const exe = process.argv[2];
(async () => {
  const env = { ...process.env, VYCHITKA_NO_UPDATE_CHECK: '1', VYCHITKA_USER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, env });
  const win = await app.firstWindow();
  await win.waitForSelector('#pasteArea');
  const info = await win.evaluate(() => window.api.info());
  await app.evaluate(({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({ 'text/plain': 'Мы решили что первый этап займёт две недели. Каждый хотел высказатся.' })]));
  await win.click('[data-act=start-paste]');
  await win.click('[data-act=start-check]');
  await win.waitForSelector('#panel .card', { timeout: 20000 });
  const n = await win.$$eval('#panel .card', els => els.length);
  console.log(JSON.stringify({ packaged: info.packaged, bases: info.bases && info.bases.version, cards: n }));
  await app.close();
  process.exit(info.packaged && n >= 2 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
