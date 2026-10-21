// Quick launch: start screen renders, no console errors.
const { _electron: electron } = require('playwright');
const path = require('path');
(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: (() => { const e = { ...process.env, VYCHITKA_NO_UPDATE_CHECK: '1' }; delete e.ELECTRON_RUN_AS_NODE; return e; })() });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  win.on('pageerror', e => errors.push(String(e)));
  await win.setViewportSize({ width: 1440, height: 860 });
  await win.waitForSelector('#pasteArea');
  await win.screenshot({ path: path.join(__dirname, 'out', 'smoke-start.png') });
  console.log('errors:', errors);
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
