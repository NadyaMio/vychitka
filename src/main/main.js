const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { EngineHost } = require('./engine-host');
const { readDocument, SUPPORTED } = require('./files');
const { writeResult, htmlToPdf } = require('./save');
const { BasesUpdater, AppUpdater } = require('./updates');
const { Nkrya } = require('./nkrya');

const IS_MAC = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..', '..');
nativeTheme.themeSource = 'light';

let win = null;
let store, engine, bases, appUpdater, nkrya;
let pendingOpen = null; // file passed before the window existed (Finder "Open with", argv)

// End-to-end tests run without native dialogs: save dialogs write into VYCHITKA_E2E_DIR,
// open dialogs take the next path from VYCHITKA_E2E_OPEN (comma-separated). Inactive in normal use.
const E2E_DIR = process.env.VYCHITKA_E2E_DIR || null;
const e2eOpenQueue = (process.env.VYCHITKA_E2E_OPEN || '').split(',').filter(Boolean);
const showOpen = (w, o) => E2E_DIR ? Promise.resolve(e2eOpenQueue.length ? { canceled: false, filePaths: [e2eOpenQueue.shift()] } : { canceled: true, filePaths: [] }) : dialog.showOpenDialog(w, o);
const showSave = (w, o) => E2E_DIR ? Promise.resolve({ canceled: false, filePath: path.join(E2E_DIR, path.basename(o.defaultPath || 'file')) }) : dialog.showSaveDialog(w, o);

function bundledBasesDir() { return app.isPackaged ? path.join(process.resourcesPath, 'bases') : path.join(ROOT, 'bases'); }
function userBasesDir() { return path.join(app.getPath('userData'), 'bases'); }
if (process.env.VYCHITKA_USER_DATA) app.setPath('userData', process.env.VYCHITKA_USER_DATA);
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: 'Вычитка',
    backgroundColor: '#f6f3ec',
    show: false,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#eeece8', symbolColor: '#3c3a36', height: 36 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => {
    if (win.__allowClose) return;
    e.preventDefault();
    send('app:before-close');
  });
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (['https:', 'http:', 'mailto:'].includes(u.protocol)) shell.openExternal(url);
  } catch { /* ignore malformed */ }
}

function buildMenu() {
  const cmd = (id) => () => send('menu', id);
  const template = [
    ...(IS_MAC ? [{ label: 'Вычитка', submenu: [
      { label: 'О программе «Вычитка»', role: 'about' },
      { label: 'Проверить обновления приложения…', click: cmd('check-app-update') },
      { type: 'separator' },
      { label: 'Скрыть «Вычитку»', role: 'hide' }, { label: 'Скрыть остальные', role: 'hideOthers' }, { type: 'separator' },
      { label: 'Завершить «Вычитку»', role: 'quit' },
    ] }] : []),
    { label: 'Файл', submenu: [
      { label: 'Новая проверка', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
      { label: 'Открыть файл…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
      { label: 'Сохранить…', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { type: 'separator' },
      ...(IS_MAC ? [{ label: 'Закрыть окно', role: 'close' }] : [{ label: 'Проверить обновления приложения…', click: cmd('check-app-update') }, { label: 'Выход', role: 'quit' }]),
    ] },
    { label: 'Правка', submenu: [
      { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
      { label: 'Повторить', accelerator: IS_MAC ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: cmd('redo') },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut' }, { label: 'Копировать', role: 'copy' }, { label: 'Вставить', role: 'paste' },
      { label: 'Выделить всё', role: 'selectAll' },
      { type: 'separator' },
      { label: 'Найти', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
    ] },
    { label: 'Проверка', submenu: [
      { label: 'Проверить', accelerator: 'CmdOrCtrl+R', click: cmd('check') },
      { label: 'Применить выбранные', accelerator: 'CmdOrCtrl+Shift+Enter', click: cmd('apply-selected') },
      { type: 'separator' },
      { label: 'Корректура', accelerator: 'CmdOrCtrl+1', click: cmd('mode-proof') },
      { label: 'Литературная правка', accelerator: 'CmdOrCtrl+2', click: cmd('mode-lit') },
      { label: 'До / после', accelerator: 'CmdOrCtrl+3', click: cmd('mode-diff') },
      { label: 'Сверка версий', accelerator: 'CmdOrCtrl+4', click: cmd('compare') },
    ] },
    { label: 'Вид', submenu: [
      { label: 'Увеличить', role: 'zoomIn' }, { label: 'Уменьшить', role: 'zoomOut' }, { label: 'Исходный размер', role: 'resetZoom' },
      { type: 'separator' }, { label: 'Полноэкранный режим', role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ label: 'Инструменты разработчика', role: 'toggleDevTools' }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform, version: app.getVersion(), packaged: app.isPackaged,
    fontsDir: path.join(ROOT, 'src', 'renderer', 'fonts'), formats: SUPPORTED,
    bases: bases.current(), documentsDir: app.getPath('documents'),
  }));
  ipcMain.handle('store:get', () => store.get());
  ipcMain.handle('store:set', async (_e, patch) => {
    const before = store.get().userWords;
    const data = store.set(patch);
    if (patch.userWords && JSON.stringify(before) !== JSON.stringify(patch.userWords)) await engine.call('setUserWords', [allUserWords()]);
    return data;
  });
  ipcMain.handle('engine', async (_e, method, args) => {
    const allowed = ['check', 'literary', 'wordInfo', 'compare', 'basesInfo', 'applyNbsp', 'rule', 'searchRules', 'manualRule'];
    if (!allowed.includes(method)) throw new Error(`unknown engine method ${method}`);
    return engine.call(method, args);
  });
  ipcMain.handle('file:open-dialog', async (_e, opts = {}) => {
    const res = await showOpen(win, {
      title: opts.title || 'Открыть текст',
      properties: ['openFile'],
      filters: [{ name: 'Тексты', extensions: opts.extensions || SUPPORTED }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return openPath(res.filePaths[0], opts.remember !== false);
  });
  ipcMain.handle('file:open-path', (_e, file, remember = true) => openPath(file, remember));
  ipcMain.handle('clipboard:read', async () => {
    // Electron 45+: asynchronous W3C-style clipboard (ClipboardItem with MIME types)
    let html = '', text = '';
    for (const item of await clipboard.read()) {
      if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
    }
    if (!text) text = await clipboard.readText();
    return { html, text };
  });
  ipcMain.handle('clipboard:write', async (_e, text) => { await clipboard.writeText(text); return true; });
  ipcMain.handle('file:save', async (_e, req) => {
    // req: { paragraphs, mode: 'track'|'clean'|'overwrite', sourcePath, suggestedName, report: { html, name } | null }
    let target = req.target;
    if (req.mode === 'overwrite') target = req.sourcePath;
    if (!target) {
      const res = await showSave(win, {
        title: 'Сохранить проверенный текст',
        defaultPath: path.join(req.sourcePath ? path.dirname(req.sourcePath) : app.getPath('documents'), req.suggestedName),
        filters: [{ name: 'Документ Word', extensions: ['docx'] }, { name: 'Текст', extensions: ['txt', 'md'] }],
      });
      if (res.canceled) return null;
      target = res.filePath;
    }
    const backupRoot = path.join(app.getPath('documents'), 'Вычитка', 'Резерв');
    const result = await writeResult({ paragraphs: req.paragraphs, mode: req.mode, target, backupRoot, sourcePath: req.sourcePath });
    if (req.report) {
      const reportPath = path.join(path.dirname(target), `${path.basename(target, path.extname(target))} — отчёт корректора.pdf`);
      result.report = await htmlToPdf(BrowserWindow, req.report.html, reportPath);
    }
    store.addRecent({ path: target, name: path.basename(target), date: new Date().toISOString() });
    return result;
  });
  ipcMain.handle('report:save', async (_e, { html, suggestedName }) => {
    const res = await showSave(win, { title: 'Сохранить отчёт', defaultPath: path.join(app.getPath('documents'), suggestedName), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (res.canceled) return null;
    return htmlToPdf(BrowserWindow, html, res.filePath);
  });
  ipcMain.handle('dict:import', async () => {
    const res = await showOpen(win, { title: 'Импорт словаря', properties: ['openFile'], filters: [{ name: 'Список слов', extensions: ['txt', 'dic', 'csv'] }] });
    if (res.canceled) return null;
    return parseWordList(fs.readFileSync(res.filePaths[0], 'utf8'));
  });
  ipcMain.handle('dict:export', async (_e, words) => {
    const res = await showSave(win, { title: 'Экспорт словаря', defaultPath: 'Мой словарь.dic', filters: [{ name: 'Словарь', extensions: ['dic', 'txt'] }] });
    if (res.canceled) return null;
    fs.writeFileSync(res.filePath, `${words.length}\n${words.join('\n')}\n`, 'utf8');
    return res.filePath;
  });
  ipcMain.handle('dict:shared-pick', async () => {
    const res = await showOpen(win, { title: 'Общий словарь редакции', message: 'Выберите файл словаря в общей папке (Dropbox, Яндекс Диск, сетевой диск)', properties: ['openFile', 'promptToCreate'], filters: [{ name: 'Словарь', extensions: ['dic', 'txt'] }] });
    if (res.canceled) return null;
    const file = res.filePaths[0];
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    store.set({ sharedDictPath: file });
    await engine.call('setUserWords', [allUserWords()]);
    return { path: file, words: readShared().length };
  });
  ipcMain.handle('shell:open', (_e, url) => openExternalSafe(url));
  ipcMain.handle('shell:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('bases:check', async () => { const r = await bases.check(); delete r.remoteManifest; store.set({ lastBasesCheck: new Date().toISOString() }); return r; });
  ipcMain.handle('bases:update', async () => {
    const r = await bases.update();
    if (r.updated) await engine.reload();
    return { ...r, bases: bases.current() };
  });
  ipcMain.handle('nkrya:status', () => nkrya.status());
  ipcMain.handle('nkrya:connect', (_e, token) => nkrya.connect(token));
  ipcMain.handle('nkrya:disconnect', () => nkrya.disconnect());
  ipcMain.handle('nkrya:portrait', (_e, lemma) => nkrya.portrait(lemma));
  ipcMain.handle('appupdate:check', () => appUpdater.check());
  ipcMain.handle('appupdate:install', () => appUpdater.install());
  ipcMain.handle('app:close-confirmed', () => { win.__allowClose = true; win.close(); });
}

function parseWordList(text) {
  return [...new Set(text.split(/[\r\n,;]+/).map(w => w.replace(/\/.*$/, '').trim()).filter(w => w && !/^\d+$/.test(w)))];
}
function readShared() {
  const p = store.get().sharedDictPath;
  if (!p) return [];
  try { return parseWordList(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function allUserWords() { return [...new Set([...store.get().userWords, ...readShared()])]; }

async function openPath(file, remember) {
  const doc = await readDocument(file);
  if (remember) store.addRecent({ path: file, name: path.basename(file), date: new Date().toISOString() });
  return doc;
}

app.on('open-file', (e, file) => { e.preventDefault(); if (win) send('open-path', file); else pendingOpen = file; });

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  bases = new BasesUpdater({ bundledDir: bundledBasesDir(), userDir: userBasesDir(), appVersion: app.getVersion(), onProgress: p => send('bases:progress', p) });
  engine = new EngineHost(() => ({ basesDir: bases.currentDir(), userWords: allUserWords() }));
  engine.start().catch(e => console.error('engine init failed', e));
  nkrya = new Nkrya({ store, safeStorage, cacheFile: path.join(app.getPath('userData'), 'nkrya-cache.json') });
  appUpdater = new AppUpdater({ app, shell, platform: process.platform, onEvent: s => send('appupdate:state', s) });
  registerIpc();
  buildMenu();
  createWindow();
  const argFile = process.argv.slice(1).find(a => SUPPORTED.some(ext => a.toLowerCase().endsWith('.' + ext)) && fs.existsSync(a));
  win.webContents.once('did-finish-load', () => {
    const f = pendingOpen || argFile;
    if (f) send('open-path', f);
    // quiet background check a few seconds after start; failures (offline) are ignored
    if (app.isPackaged && !process.env.VYCHITKA_NO_UPDATE_CHECK) setTimeout(() => appUpdater.check().catch(() => {}), 4000);
  });
});

app.on('window-all-closed', () => app.quit());
