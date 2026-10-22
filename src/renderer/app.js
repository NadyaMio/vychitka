'use strict';
/* global ic, Model, Diff */

// ============================================================ state
const S = {
  info: null, store: null, mod: '⌘', win: false,
  screen: 'start',            // start | doc | settings | compare | dict
  mode: 'proof',              // proof | lit | diff   (inside the document screen)
  startMode: 'proof',
  startHadFormatting: false, startFromClipboard: false,
  doc: null, original: null,  // current document and the one as it was loaded
  baseline: [],               // paragraph texts at the last programmatic change (manual edits are highlighted against it)
  issues: [], issueState: new Map(), ignored: new Set(), activeKey: null, filter: 'all', sort: 'text',
  stale: [], notice: null, checkMs: 0, checking: false,
  lit: null, litState: new Map(), litActive: null,
  applied: [], history: [], future: [], dirty: false, editing: false, editCount: 0,
  cmp: { a: null, b: null, result: null, filter: 'all', checked: new Set(), active: null, mode: 'text' },
  basesInfo: null, basesUpd: null, appUpd: null,
};

const CAT = {
  spelling: { cls: 'sp', title: 'Орфография', color: '#d6453d' },
  punctuation: { cls: 'pn', title: 'Пунктуация', color: '#2f6fde' },
  grammar: { cls: 'gr', title: 'Грамматика', color: '#e08a1e' },
  typography: { cls: 'ty', title: 'Типографика', color: '#1e9e8f' },
  repeat: { cls: 'rp', title: 'Повтор', color: '#e08a1e' },
  style: { cls: 'st', title: 'Стиль', color: '#8b5cf6' },
};
const $ = sel => document.querySelector(sel);
const esc = Model.esc;
const textOf = Model.textOf;

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const fmtNum = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const shown = s => esc(s).replace(/ /g, ' ');
const kbdMod = k => S.win ? `Ctrl+${k}` : `${S.mod}${k}`;

function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' err' : '');
  el.innerHTML = `<span>${msg}</span>${opts.action ? `<a data-toast-act>${opts.action}</a>` : ''}`;
  $('#layer').appendChild(el);
  if (opts.action) el.querySelector('[data-toast-act]').onclick = () => { el.remove(); opts.onAction(); };
  setTimeout(() => el.remove(), opts.ms || (opts.error ? 7000 : 3500));
}
function fail(e, prefix = '') {
  console.error(e);
  const msg = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  toast(prefix + msg, { error: true });
}

// ============================================================ chrome & sidebar
function renderTitle() {
  const name = S.doc ? S.doc.name : null;
  const dirty = S.dirty ? ' — изменено' : '';
  if (S.win) $('#tb').innerHTML = `<div class="title"><div class="logo">В</div>${name ? esc(name) + dirty + ' — Вычитка' : 'Вычитка'}</div>`;
  else $('#tb').innerHTML = `<div class="title">${name && S.screen !== 'start' ? 'Вычитка — ' + esc(name) + dirty : S.screen === 'compare' ? 'Вычитка — Сверка' : S.screen === 'dict' ? 'Вычитка — Словари и базы' : 'Вычитка'}</div>`;
  document.title = name ? `${name} — Вычитка` : 'Вычитка';
}

function paraNo(pi) {
  if (!S.doc) return pi + 1;
  let n = 0;
  for (let k = 0; k <= pi && k < S.doc.paragraphs.length; k++) if (S.doc.paragraphs[k].kind !== 'h') n++;
  return S.doc.paragraphs[pi] && S.doc.paragraphs[pi].kind === 'h' ? 'загол.' : n;
}
function visibleIssues() { return S.issues.filter(i => !st(i).rejected && !S.ignored.has(ignoreKey(i))); }
function st(i) { if (!S.issueState.has(i.key)) S.issueState.set(i.key, { selected: i.after !== i.before && i.confidence === 'sure', rejected: false }); return S.issueState.get(i.key); }
function litVisible() { return S.lit ? S.lit.issues.filter(i => !lst(i).rejected) : []; }
function lst(i) { if (!S.litState.has(i.key)) S.litState.set(i.key, { selected: hasFix(i), rejected: false, alt: 0 }); return S.litState.get(i.key); }
const hasFix = i => i.after !== i.before || (i.alternatives || []).length > 0;
const ignoreKey = i => i.category === 'spelling' ? 'w:' + i.before.toLowerCase() : `${i.ruleId}:${i.before}`;

let lastSideHtml = '';
function renderSide() {
  const nav = (key, icon, label, cnt) => `<div class="nav${(S.screen === key || (key === 'proof' && S.screen === 'doc' && S.mode !== 'lit') || (key === 'lit' && S.screen === 'doc' && S.mode === 'lit')) ? ' on' : ''}" data-nav="${key}">${ic(icon)}<span class="lbl">${label}</span>${cnt != null ? `<span class="cnt">${cnt}</span>` : ''}</div>`;
  const proofCnt = S.doc ? visibleIssues().length : null;
  const litCnt = S.lit ? litVisible().length : null;
  const recent = (S.store.recent || []).slice(0, 3).map(r => `<div class="nav recent" data-recent="${esc(r.path)}" title="${esc(r.path)}">${ic('file', 14)}<span>${esc(r.name)}</span></div>`).join('');
  const b = S.info.bases;
  const basesDate = b && b.date ? new Date(b.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '') : '—';
  let upd = '';
  const u = S.appUpd;
  if (u && ['available', 'downloading', 'ready', 'manual'].includes(u.status)) {
    upd = `<div class="upd"><b>${u.status === 'available' ? `Доступна версия ${esc(u.version)}` : u.status === 'downloading' ? `Загружаю обновление… ${u.percent || 0}%` : u.status === 'ready' ? 'Обновление готово' : 'Обновление загружено'}</b>
      ${u.status === 'manual' ? esc(u.message) : ''}
      ${u.status === 'available' ? `<button class="btn sm pri" data-act="app-update">${ic('download', 13)}Установить</button>` : ''}
      ${u.status === 'ready' && S.win ? `<button class="btn sm pri" data-act="app-update">${ic('refresh', 13)}Перезапустить</button>` : ''}
      ${u.status === 'downloading' ? `<div class="bar" style="width:100%;margin-top:7px"><i style="width:${u.percent || 0}%"></i></div>` : ''}</div>`;
  } else if (S.basesUpd && S.basesUpd.newer && S.screen !== 'dict') {
    upd = `<div class="upd"><b>Доступны новые базы ${esc(S.basesUpd.remote)}</b><button class="btn sm" data-nav="dict">${ic('refresh', 13)}Обновить</button></div>`;
  }
  const html = `<div class="brand"><div class="logo">В</div><div><b>Вычитка</b><small>корректор без ИИ</small></div></div>
    ${nav('start', 'file', 'Документ')}${nav('proof', 'spell', 'Корректура', proofCnt)}${nav('lit', 'feather', 'Литературная правка', litCnt)}${nav('compare', 'compare', 'Сверка версий')}
    <div class="sl">Базы</div>${nav('dict', 'book', 'Словари и базы')}${nav('settings', 'sliders', 'Настройки проверки')}
    ${recent ? `<div class="sl">Недавние</div>${recent}` : ''}
    <div class="sfoot"><div class="row"><span class="dot"></span>Работает без интернета</div><div>Базы от ${basesDate}</div>${upd}</div>`;
  // replacing the DOM between mousedown and mouseup swallows the click — only touch it when something changed
  if (html !== lastSideHtml) { $('#side').innerHTML = html; lastSideHtml = html; }
}

// ============================================================ screens
function show(screen, mode) {
  closePop();
  S.screen = screen;
  if (mode) S.mode = mode;
  renderTitle();
  renderSide();
  ({ start: renderStart, doc: renderDocScreen, settings: renderSettings, compare: renderCompare, dict: renderDict })[screen]();
}

// ------------------------------------------------------------ start
function renderStart() {
  $('#main').innerHTML = `<div class="start">
    <div><h1>Новая проверка</h1><p class="lead" id="startLead"></p></div>
    <div style="display:flex;gap:16px;height:400px;flex:none">
      <div class="paste" id="paste">
        <div class="hd">${ic('clip', 14)}Текст<span class="sp1"></span><span style="font-weight:500;color:var(--muted4)">редактируемое поле</span></div>
        <div class="area"><div class="ed-area" id="pasteArea" contenteditable="true" spellcheck="false"></div>
          <div class="ph-text" id="phText"><span style="display:inline-block;width:2px;height:22px;background:var(--navy);margin-right:4px;vertical-align:-4px"></span>Вставьте текст сюда или начните печатать…</div>
          <div class="ph-hint" id="phHint"><div class="ico-box" style="width:52px;height:52px;border-radius:14px">${ic('clip', 24)}</div>
            <b>Скопируйте текст откуда угодно и нажмите ${S.win ? 'Ctrl+V' : '⌘V'}</b>
            <span style="font-size:13px">Из Word, Google Docs, письма, браузера или мессенджера — любой длины</span></div></div>
        <div class="ft" id="pasteFt"></div>
      </div>
      <div class="drop" id="drop"><div class="ico-box" style="width:44px;height:44px">${ic('upload', 20)}</div>
        <b style="font-size:15px">Или перетащите файл</b>
        <span style="font-size:12.5px;color:#7d786d;line-height:1.5">DOCX, RTF, ODT, TXT, MD, PDF с текстом. Форматирование и сноски сохраняются</span>
        <button class="btn" data-act="open" style="margin-top:4px">${ic('file', 14)}Открыть файл… <span class="k">${kbdMod('O')}</span></button></div>
    </div>
    <div><div class="label" style="margin-bottom:10px">Что сделать с текстом</div><div style="display:flex;gap:12px" id="modes"></div></div>
  </div><div class="status"><span>${S.doc ? `Открыт документ: ${esc(S.doc.name)}` : 'Готово к работе'}</span><span class="r">Профиль: ${esc(profileName())}</span></div>`;
  renderModes();
  const area = $('#pasteArea');
  area.addEventListener('paste', e => { e.preventDefault(); insertIntoStart(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain')); });
  area.addEventListener('input', updateStartState);
  area.addEventListener('drop', e => { if (e.dataTransfer.files.length) return; e.preventDefault(); insertIntoStart(e.dataTransfer.getData('text/html'), e.dataTransfer.getData('text/plain')); });
  updateStartState();
  setTimeout(() => area.focus(), 0);
}
function renderModes() {
  const modes = [['proof', 'spell', 'Корректура', 'Орфография, пунктуация, грамматика, типографика. Правки списком с объяснениями.'],
    ['compare', 'compare', 'Сверка версий', 'Сравнить исправленный текст с вёрсткой или новой версией: что потерялось, что добавилось.'],
    ['lit', 'feather', 'Литературная правка', 'Канцелярит, штампы, повторы, длинные предложения, пассив. Подсказки, а не переписывание.']];
  $('#modes').innerHTML = modes.map(([k, i, t, d]) => `<div class="modecard${S.startMode === k ? ' on' : ''}" data-startmode="${k}">
    <div style="display:flex;align-items:center;gap:10px"><div class="mi">${ic(i, 17)}</div><b style="font-size:14.5px">${t}</b><span class="sp1"></span><div class="rad${S.startMode === k ? ' on' : ''}"></div></div>
    <div style="font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:10px">${d}</div></div>`).join('');
}
function startModel() {
  const area = $('#pasteArea');
  if (!area) return { paragraphs: [] };
  return Model.fromHtml(area.innerHTML);
}
function updateStartState() {
  const area = $('#pasteArea');
  const m = startModel();
  const st2 = Model.stats(m);
  const filled = st2.chars > 0;
  $('#paste').classList.toggle('filled', filled);
  $('#phText').style.display = area.textContent.length ? 'none' : '';
  $('#phHint').style.display = filled ? 'none' : '';
  $('#startLead').textContent = filled ? 'Текст вставлен. Его можно поправить прямо здесь перед проверкой.' : 'Вставьте текст или откройте файл — от абзаца до книги.';
  const paras = m.paragraphs.length;
  $('#pasteFt').innerHTML = filled
    ? `<span style="font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0"><b style="color:var(--ink)">${fmtNum(st2.chars)} ${plural(st2.chars, ['знак', 'знака', 'знаков'])}</b> · ${paras} ${plural(paras, ['абзац', 'абзаца', 'абзацев'])}${S.startFromClipboard ? ' · вставлено из буфера' : ''}</span>
       ${S.startHadFormatting ? `<span class="pill g" style="margin-left:10px">${ic('check', 11, 'currentColor', 3)}Жирный, курсив и ссылки сохранены</span>` : ''}
       <span class="sp1"></span><button class="btn ghost" data-act="start-clear">${ic('x', 14)}Очистить</button><button class="btn pri" data-act="start-check">${ic('spell', 14)}Проверить <span class="k" style="opacity:.7">${kbdMod('R')}</span></button>`
    : `<span style="font-size:12.5px;color:var(--muted3)">0 знаков</span><span class="sp1"></span>
       <button class="btn" data-act="start-paste">${ic('clip', 14)}Вставить из буфера <span class="k">${kbdMod('V')}</span></button><button class="btn pri" disabled>${ic('spell', 14)}Проверить</button>`;
}
function modelToHtml(paragraphs) {
  return paragraphs.map(p => { const inner = p.runs.map(r => { let h = esc(r.text).replace(/\n/g, '<br>'); if (r.b) h = `<b>${h}</b>`; if (r.i) h = `<i>${h}</i>`; if (r.href) h = `<a href="${esc(r.href)}">${h}</a>`; return h; }).join(''); return p.kind === 'h' ? `<h1>${inner}</h1>` : `<p>${inner}</p>`; }).join('');
}
function insertIntoStart(html, text) {
  const m = Model.fromClipboard(html, text);
  if (!m.paragraphs.length) return;
  S.startHadFormatting = S.startHadFormatting || m.hadFormatting;
  S.startFromClipboard = true;
  const area = $('#pasteArea');
  area.focus();
  if (!area.textContent.trim()) area.innerHTML = '';
  document.execCommand('insertHTML', false, modelToHtml(m.paragraphs));
  updateStartState();
}
async function startPasteFromClipboard() {
  const c = await window.api.readClipboard();
  if (!c.text && !c.html) return toast('Буфер обмена пуст — скопируйте текст и попробуйте ещё раз.');
  const area = $('#pasteArea');
  area.focus();
  const sel = getSelection();
  sel.selectAllChildren(area); sel.collapseToEnd();
  insertIntoStart(c.html, c.text);
}
function startCheck() {
  const m = startModel();
  if (!Model.stats(m).chars) return;
  Model.detectTitle(m.paragraphs);
  loadDoc({ name: 'Текст из буфера', path: null, ext: null, source: 'paste', paragraphs: m.paragraphs }, S.startMode);
}

// ------------------------------------------------------------ documents in / out
function payloadToDoc(p) {
  const m = p.html != null ? Model.fromHtml(p.html) : Model.fromText(p.text || '');
  if (p.ext !== 'docx' && p.ext !== 'odt' && p.ext !== 'md') Model.detectTitle(m.paragraphs);
  return { name: p.name, path: p.path, ext: p.ext, source: 'file', paragraphs: m.paragraphs };
}
async function openFile(path) {
  try {
    const p = path ? await window.api.openPath(path) : await window.api.openDialog();
    if (!p) return;
    const doc = payloadToDoc(p);
    if (!doc.paragraphs.length) return toast('В файле нет текста.', { error: true });
    S.store = await window.api.store.get();
    loadDoc(doc, S.screen === 'start' ? S.startMode : 'proof');
  } catch (e) { fail(e, 'Не удалось открыть файл. '); }
}
function loadDoc(doc, mode = 'proof') {
  S.doc = doc;
  S.original = Model.clone(doc);
  S.baseline = doc.paragraphs.map(textOf);
  S.issues = []; S.issueState = new Map(); S.ignored = new Set(); S.activeKey = null; S.filter = 'all';
  S.lit = null; S.litState = new Map(); S.litActive = null;
  S.applied = []; S.history = []; S.future = []; S.dirty = false; S.stale = []; S.notice = null; S.editCount = 0;
  if (mode === 'compare') {
    S.cmp = { a: { name: doc.name, label: 'исправленный текст', doc: Model.clone(doc), ext: doc.ext }, b: null, result: null, filter: 'all', checked: new Set(), active: null, mode: 'text' };
    return show('compare');
  }
  show('doc', mode === 'lit' ? 'lit' : 'proof');
  runCheck();
}
const engineDoc = doc => ({ paragraphs: doc.paragraphs.map(p => ({ kind: p.kind, text: textOf(p) })) });

function pushHistory() {
  S.history.push({ doc: Model.clone(S.doc), applied: [...S.applied], baseline: [...S.baseline] });
  if (S.history.length > 200) S.history.shift();
  S.future = [];
}
function undo() {
  if (S.screen === 'start' || document.activeElement && document.activeElement.tagName === 'INPUT') return document.execCommand('undo');
  if (!S.history.length) return;
  S.future.push({ doc: Model.clone(S.doc), applied: [...S.applied], baseline: [...S.baseline] });
  const h = S.history.pop();
  Object.assign(S, { doc: h.doc, applied: h.applied, baseline: h.baseline, dirty: true, editing: false });
  rerunAfterChange();
}
function redo() {
  if (S.screen === 'start') return document.execCommand('redo');
  if (!S.future.length) return;
  S.history.push({ doc: Model.clone(S.doc), applied: [...S.applied], baseline: [...S.baseline] });
  const h = S.future.pop();
  Object.assign(S, { doc: h.doc, applied: h.applied, baseline: h.baseline, dirty: true });
  rerunAfterChange();
}
function rerunAfterChange() { renderTitle(); if (S.screen === 'doc') { renderPaper(false); runCheck(); } }

// ============================================================ checking
const settings = () => S.store.settings;
function profileName() { const p = S.store.profiles.find(x => x.id === S.store.profileId); return p ? p.name : 'Свой профиль'; }

function keyIssues(list) {
  const seen = new Map();
  for (const i of list) {
    const base = `${i.ruleId}|${i.para}|${i.before}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    i.key = `${base}|${n}`;
  }
  return list;
}
function clientFilter(list) {
  const s = settings();
  return list.filter(i => {
    if (s.uncertain === 'skip' && i.confidence === 'check') return false;
    if (s.quotes === 'keep' && /quote/.test(i.ruleId)) return false;
    if (s.dash === 'keep' && /dash/.test(i.ruleId)) return false;
    if (!s.numbers && /number|digit/.test(i.ruleId)) return false;
    return true;
  });
}

let checkSeq = 0;
async function runCheck({ fromEdit = false } = {}) {
  if (!S.doc) return;
  const seq = ++checkSeq;
  S.checking = true;
  renderToolbar();
  const before = S.issues;
  try {
    const t0 = performance.now();
    const res = await window.api.engine('check', engineDoc(S.doc), settings());
    if (seq !== checkSeq) return;
    S.checkMs = performance.now() - t0;
    S.issues = keyIssues(clientFilter(res.issues));
    if (fromEdit) computeStale(before);
    if (S.mode === 'lit' || (S.store.settings.literary && S.lit == null) || S.lit) await runLiterary(seq);
  } catch (e) { fail(e, 'Ошибка проверки: '); }
  S.checking = false;
  S.editing = false;
  hideTip();
  if (seq !== checkSeq) return;
  if (!S.activeKey || !S.issues.some(i => i.key === S.activeKey)) S.activeKey = (visibleIssues()[0] || {}).key || null;
  if (S.screen === 'doc') { renderPaper(true); renderPanel(); renderToolbar(); renderStatus(); }
  renderSide();
}
async function runLiterary(seq) {
  const res = await window.api.engine('literary', engineDoc(S.doc), settings());
  if (seq !== checkSeq) return;
  res.issues = keyIssues(res.issues);
  S.lit = res;
  if (!S.litActive || !res.issues.some(i => i.key === S.litActive)) S.litActive = (litVisible()[0] || {}).key || null;
}

// After a manual edit: which earlier suggestions became irrelevant because the user fixed the text by hand.
function computeStale(before) {
  const now = new Set(S.issues.map(i => i.key));
  const changed = new Set();
  S.doc.paragraphs.forEach((p, i) => { if (textOf(p) !== S.baseline[i]) changed.add(i); });
  const gone = before.filter(i => !now.has(i.key) && changed.has(i.para) && !st(i).rejected && !textOf(S.doc.paragraphs[i.para] || { runs: [] }).includes(i.before));
  const fresh = S.issues.filter(i => changed.has(i.para) && !before.some(b => b.key === i.key));
  S.stale = [...S.stale.filter(s => !gone.some(g => g.key === s.key)), ...gone];
  if (changed.size) {
    const paras = [...changed].map(paraNo);
    const which = paras.length === 1 ? `абзац ${paras[0]}` : `абзацы ${paras.join(', ')}`;
    const goneTxt = gone.length ? ` ${gone.length === 1 ? 'Правка' : 'Правки'} ${gone.map(g => `«${shown(g.before)}»`).join(', ')} ${gone.length === 1 ? 'снята' : 'сняты'} — вы ${gone.length === 1 ? 'исправили слово' : 'исправили это'} сами.` : '';
    const freshTxt = fresh.length ? ` Новых ошибок: ${fresh.length}.` : ' Новых ошибок нет.';
    S.notice = `<b>Вы поправили ${which}.</b> ${paras.length === 1 ? 'Он перепроверен' : 'Они перепроверены'}:${goneTxt}${freshTxt}`;
  }
}

// ============================================================ document screen
function renderDocScreen() {
  $('#main').innerHTML = `<div class="toolbar" id="toolbar"></div>
    <div class="work"><div class="docwrap" id="docwrap"><div class="paper" id="paper" spellcheck="false"></div></div><div class="panel" id="panel"></div></div>
    <div class="status" id="status"></div>`;
  bindPaper();
  renderToolbar(); renderPaper(false); renderPanel(); renderStatus();
}

let findOpen = false;
function renderToolbar() {
  const tb = $('#toolbar');
  if (!tb || !S.doc) return;
  const stats = Model.stats(S.doc);
  const sub = S.editing || S.dirty && S.editCount ? 'Изменено вручную · не сохранено'
    : S.checking ? 'Проверяю…'
    : S.mode === 'lit' ? `${fmtNum(stats.chars)} ${plural(stats.chars, ['знак', 'знака', 'знаков'])} · литературная правка`
    : `${fmtNum(stats.chars)} ${plural(stats.chars, ['знак', 'знака', 'знаков'])} · проверено за ${(Math.max(S.checkMs, 100) / 1000).toFixed(1).replace('.', ',')} с`;
  const segBtn = (m, i, t) => `<button class="${S.mode === m ? 'on' : ''}" data-mode="${m}">${ic(i, 14)}${t}</button>`;
  tb.innerHTML = `<div class="docname"><b title="${esc(S.doc.path || S.doc.name)}">${esc(S.doc.name)}</b><small>${sub}</small></div>
    <div class="seg">${segBtn('proof', 'spell', 'Корректура')}${segBtn('lit', 'feather', 'Литературная правка')}${segBtn('diff', 'eye', 'До / после')}</div>
    <span class="sp1"></span>
    ${findOpen ? `<div class="findbar">${ic('search', 14, 'var(--muted3)')}<input id="findInput" placeholder="Найти в тексте"><small id="findCount"></small><button data-act="find-close">${ic('x', 13)}</button></div>`
      : `<button class="btn ghost icon" data-act="find" title="Найти (${kbdMod('F')})">${ic('search', 16)}</button>`}
    <button class="btn ghost icon" data-act="undo" title="Отменить (${kbdMod('Z')})"${S.history.length ? '' : ' style="opacity:.45"'}>${ic('undo', 16)}</button>
    <button class="btn" data-act="recheck">${ic('refresh', 14)}Проверить снова</button>
    <button class="btn" data-act="save">${ic('download', 14)}Сохранить…</button>`;
  if (findOpen) { const inp = $('#findInput'); inp.value = S.findText || ''; inp.focus(); inp.oninput = () => { S.findText = inp.value; runFind(); }; inp.onkeydown = e => { if (e.key === 'Enter') runFind(true); if (e.key === 'Escape') { findOpen = false; CSS.highlights && CSS.highlights.delete('find'); renderToolbar(); } }; runFind(); }
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const legend = `<div class="legend">${['spelling', 'punctuation', 'grammar', 'typography', 'style'].map(c => `<span><i style="background:${CAT[c].color}"></i>${CAT[c].title}</span>`).join('')}</div>`;
  const keys = S.win ? '↑↓ — по правкам · Enter — принять · Backspace — отклонить' : '↑↓ — по правкам · ↵ — принять · ⌫ — отклонить';
  if (S.editing || S.editCount && S.mode === 'proof' && S.notice) {
    el.innerHTML = `<span style="display:flex;align-items:center;gap:6px">${ic('feather', 13)}Ручная правка: ${S.editCount} ${plural(S.editCount, ['изменение', 'изменения', 'изменений'])} · ${kbdMod('Z')} — отменить</span><span class="r">Текст редактируется как в обычном редакторе: печатайте, вставляйте, удаляйте</span>`;
  } else if (S.mode === 'diff') {
    const sel = visibleIssues().filter(i => st(i).selected && i.after !== i.before).length;
    el.innerHTML = `<span style="display:flex;gap:14px"><span><span class="ins">зелёным</span> — будет добавлено</span><span><span class="del">красным</span> — будет удалено</span></span><span class="r">${sel} из ${visibleIssues().length} выбрано</span>`;
  } else if (S.mode === 'lit') {
    el.innerHTML = `<span>Подсказки по шаблонам, без переписывания текста</span><span class="r">${S.lit ? `Ясность после правок: ~${String(S.lit.scoreAfter).replace('.', ',')}` : ''}</span>`;
  } else {
    el.innerHTML = `${legend}<span class="r">${keys}</span>`;
  }
}

// ---------- paper (the editable text) ----------
function marksFor(pi) {
  const marks = [];
  if (S.mode === 'lit' && S.lit) {
    for (const i of litVisible()) if (i.para === pi) marks.push({ start: i.start, end: i.end, cls: (i.ruleId === 'style.long' ? 'st block' : CAT[i.category] ? CAT[i.category].cls : 'st'), key: i.key, sel: i.key === S.litActive && i.ruleId !== 'style.long' });
  } else {
    const text = textOf(S.doc.paragraphs[pi]);
    for (const i of visibleIssues()) if (i.para === pi) {
      let { start, end } = i;
      if ((i.category === 'punctuation' || i.category === 'typography') && i.after !== i.before) {
        // highlight only what changes (the spot for a missing comma), like in the mockups
        let a = 0;
        while (a < i.before.length && a < i.after.length && i.before[a] === i.after[a]) a++;
        let b = 0;
        while (b < i.before.length - a && b < i.after.length - a && i.before[i.before.length - 1 - b] === i.after[i.after.length - 1 - b]) b++;
        start = i.start + a; end = i.end - b;
        if (end <= start) { if (/\s/.test(text[start] || '')) end = start + 1; else if (start > i.start && /\s/.test(text[start - 1] || '')) { start -= 1; end = start + 1; } else { start = i.start; end = i.end; } }
      }
      marks.push({ start, end, cls: CAT[i.category] ? CAT[i.category].cls : 'st', key: i.key, sel: i.key === S.activeKey });
    }
  }
  // manual insertions since the last programmatic change
  const cur = textOf(S.doc.paragraphs[pi]);
  if (S.baseline[pi] != null && cur !== S.baseline[pi]) for (const r of Model.insertedRanges(S.baseline[pi], cur)) marks.push({ ...r, cls: 'ed', key: 'ed' });
  marks.sort((a, b) => a.start - b.start || (a.cls === 'ed') - (b.cls === 'ed'));
  const out = [];
  let end = -1;
  for (const m of marks) { if (m.start < end) continue; out.push(m); end = Math.max(m.end, m.start === m.end ? m.start + 0.5 : m.end); }
  return out;
}

function renderPaper(keepCaret) {
  const paper = $('#paper');
  if (!paper || !S.doc) return;
  const caret = keepCaret && document.activeElement === paper ? caretPos() : null;
  if (S.mode === 'diff') {
    paper.contentEditable = 'false';
    paper.classList.remove('editing');
    const sel = visibleIssues().filter(i => st(i).selected && i.after !== i.before);
    paper.innerHTML = S.doc.paragraphs.map((p, pi) => {
      const segs = Model.fixSegments(p, sel.filter(i => i.para === pi));
      const inner = segs.map(s => { const h = esc(s.text).replace(/\n/g, '<br>'); return s.type === 'eq' ? h : `<span class="${s.type}">${h}</span>`; }).join('') || '<br>';
      return p.kind === 'h' ? `<h1>${inner}</h1>` : `<p>${inner}</p>`;
    }).join('');
    return;
  }
  paper.contentEditable = 'true';
  paper.innerHTML = S.doc.paragraphs.map((p, pi) => { const inner = Model.paragraphHtml(p, marksFor(pi)); return p.kind === 'h' ? `<h1 data-p="${pi}">${inner}</h1>` : `<p data-p="${pi}">${inner}</p>`; }).join('') || '<p data-p="0"><br></p>';
  paper.classList.toggle('editing', S.doc.paragraphs.some((p, i) => textOf(p) !== S.baseline[i]) || S.editing);
  if (caret) setCaret(caret.pi, caret.off);
}

function paraEls() { return [...$('#paper').children]; }
function textLen(node) { return (node.nodeType === 3 ? node.data : node.textContent).replace(/​/g, '').length; }
function caretPos() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const paper = $('#paper');
  let el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  while (el && el.parentElement !== paper) el = el.parentElement;
  if (!el) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return { pi: paraEls().indexOf(el), off: pre.toString().replace(/​/g, '').length };
}
function setCaret(pi, off) {
  const el = paraEls()[Math.min(pi, paraEls().length - 1)];
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, left = off, last = null;
  while ((n = walker.nextNode())) {
    last = n;
    const len = textLen(n);
    if (left <= len) {
      let idx = 0, cnt = 0;
      while (idx < n.data.length && cnt < left) { if (n.data[idx] !== '​') cnt++; idx++; }
      const r = document.createRange(); r.setStart(n, idx); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return;
    }
    left -= len;
  }
  const r = document.createRange();
  if (last) r.setStart(last, last.data.length); else r.setStart(el, 0);
  r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

function readPaper() {
  const paras = paraEls().map(el => ({ kind: el.tagName === 'H1' ? 'h' : 'p', runs: Model.runsFromElement(el) }));
  return paras.length ? paras : [{ kind: 'p', runs: [] }];
}

let editTimer = null;
function onManualEdit() {
  if (!S.editing) { pushHistory(); S.history[S.history.length - 1].doc = Model.clone(S.preEditDoc || S.doc); }
  S.editing = true;
  S.dirty = true;
  S.doc.paragraphs = readPaper();
  if (S.baseline.length !== S.doc.paragraphs.length) S.baseline = S.doc.paragraphs.map((p, i) => (S.baseline[i] != null ? S.baseline[i] : ''));
  renderTitle(); renderToolbar(); renderStatus();
  $('#paper').classList.add('editing');
  showTip();
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { S.editCount++; S.preEditDoc = null; runCheck({ fromEdit: true }); }, 900);
}

function bindPaper() {
  const paper = $('#paper');
  paper.addEventListener('focus', () => { if (!S.editing) S.preEditDoc = Model.clone(S.doc); });
  paper.addEventListener('beforeinput', e => {
    if (S.mode === 'diff') return e.preventDefault();
    const t = e.inputType;
    if (t === 'historyUndo') { e.preventDefault(); return undo(); }
    if (t === 'historyRedo') { e.preventDefault(); return redo(); }
    if (t === 'insertParagraph' || t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertLineBreak') {
      e.preventDefault();
      const sel = getSelection();
      if (!sel.isCollapsed) { document.execCommand('delete'); }
      S.doc.paragraphs = readPaper();
      const c = caretPos() || { pi: S.doc.paragraphs.length - 1, off: textOf(S.doc.paragraphs[S.doc.paragraphs.length - 1]).length };
      if (!S.editing) { S.preEditDoc = S.preEditDoc || Model.clone(S.doc); }
      if (t === 'insertLineBreak') { insertTextAt(c, '\n'); return; }
      if (t === 'insertParagraph') {
        const p = S.doc.paragraphs[c.pi];
        const total = textOf(p).length;
        const left = { kind: p.kind, runs: Model.slices(p.runs, 0, c.off) };
        const right = { kind: 'p', runs: Model.slices(p.runs, c.off, total) };
        S.doc.paragraphs.splice(c.pi, 1, left, right);
        S.baseline.splice(c.pi + 1, 0, S.baseline[c.pi] != null ? '' : null);
        S.baseline[c.pi] = S.baseline[c.pi] != null ? S.baseline[c.pi].slice(0, c.off) : null;
        S.baseline[c.pi + 1] = '';
        renderPaper(false); setCaret(c.pi + 1, 0); onManualEdit();
        return;
      }
      const dt = e.dataTransfer;
      const html = dt && dt.getData('text/html'), text = dt && dt.getData('text/plain');
      const m = Model.fromClipboard(html, text);
      if (!m.paragraphs.length) return;
      if (m.paragraphs.length === 1) { insertTextAt(c, textOf(m.paragraphs[0])); return; }
      const p = S.doc.paragraphs[c.pi];
      const total = textOf(p).length;
      const head = { kind: p.kind, runs: Model.normalizeRuns([...Model.slices(p.runs, 0, c.off), ...m.paragraphs[0].runs]) };
      const lastIns = m.paragraphs[m.paragraphs.length - 1];
      const tailOff = textOf(lastIns).length;
      const tail = { kind: 'p', runs: Model.normalizeRuns([...lastIns.runs, ...Model.slices(p.runs, c.off, total)]) };
      const mid = m.paragraphs.slice(1, -1).map(x => ({ kind: 'p', runs: x.runs }));
      S.doc.paragraphs.splice(c.pi, 1, head, ...mid, tail);
      S.baseline.splice(c.pi + 1, 0, ...mid.map(() => ''), '');
      renderPaper(false); setCaret(c.pi + mid.length + 1, tailOff); onManualEdit();
    }
  });
  paper.addEventListener('input', () => onManualEdit());
  paper.addEventListener('click', e => {
    const a = e.target.closest('a[data-href]');
    if (a && (e.metaKey || e.ctrlKey)) { window.api.openExternal(a.dataset.href); return; }
    const m = e.target.closest('.m[data-k]');
    if (!m || m.dataset.k === 'ed') return closePop();
    activateIssue(m.dataset.k, { fromText: true, anchor: m });
  });
  paper.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closePop(); paper.blur(); }
  });
}
function insertTextAt(c, text) {
  const p = S.doc.paragraphs[c.pi];
  p.runs = Model.replaceRange(p.runs, c.off, c.off, text);
  renderPaper(false); setCaret(c.pi, c.off + text.length); onManualEdit();
}

let tipEl = null;
function showTip() {
  if (S.mode === 'diff') return;
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.top && !rect.left)) return;
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.innerHTML = `${ic('feather', 13, '#fff')}<span>Правка вручную · проверка обновится, когда закончите печатать</span>`; $('#layer').appendChild(tipEl); }
  tipEl.style.left = Math.max(240, rect.left - 120) + 'px';
  tipEl.style.top = Math.max(50, rect.top - 46) + 'px';
}
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

// ---------- find ----------
function runFind(next) {
  if (!CSS.highlights) return;
  const q = (S.findText || '').trim().toLowerCase();
  CSS.highlights.delete('find');
  const cnt = $('#findCount');
  if (!q) { if (cnt) cnt.textContent = ''; return; }
  const ranges = [];
  const walker = document.createTreeWalker($('#paper'), NodeFilter.SHOW_TEXT);
  let n;
  const nodes = [];
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const t = node.data.toLowerCase().replace(/ /g, ' ');
    let i = t.indexOf(q);
    while (i >= 0) { const r = new Range(); r.setStart(node, i); r.setEnd(node, i + q.length); ranges.push(r); i = t.indexOf(q, i + q.length); }
  }
  CSS.highlights.set('find', new Highlight(...ranges));
  if (cnt) cnt.textContent = ranges.length ? `${(S.findIdx || 0) % ranges.length + 1} из ${ranges.length}` : 'нет';
  if (next && ranges.length) {
    S.findIdx = ((S.findIdx || 0) + 1) % ranges.length;
    const r = ranges[S.findIdx];
    r.startContainer.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    cnt.textContent = `${S.findIdx + 1} из ${ranges.length}`;
  }
}

// ---------- the corrections panel ----------
function tagFor(i) {
  if (i.category !== 'style') return CAT[i.category] ? CAT[i.category].title : 'Стиль';
  const r = i.ruleId || '';
  if (/long/.test(r)) return 'Длинное предложение';
  if (/passive/.test(r)) return 'Пассив';
  if (/intens|filler|parasite/.test(r)) return 'Слово-усилитель';
  if (/stamp|cliche/.test(r)) return 'Штамп';
  return 'Канцелярит';
}
function fixLine(i, altText) {
  const after = altText != null ? altText : i.after;
  if (i.after === i.before && !(i.alternatives || []).length && altText == null) return `<div class="fix${i.before.length > 40 ? ' long' : ''}"><span style="font-family:'PT Serif',serif">${shown(i.before.length > 120 ? i.before.slice(0, 117) + '…' : i.before)}</span></div>`;
  const long = i.before.length + after.length > 44;
  return `<div class="fix${long ? ' long' : ''}"><s>${shown(i.before) || '&nbsp;'}</s>${long ? '<br>' : ''}<span class="ar">→</span><b>${after === '' ? '<span style="color:var(--muted3);font-weight:500;font-family:Inter;font-size:12.5px">убрать</span>' : shown(after)}</b></div>`;
}
function confHtml(i, lit) {
  return i.confidence === 'check' ? `<span class="conf chk">${ic('info', 12)}Проверьте</span>` : `<span class="conf">${ic('check', 12, 'currentColor', 3)}${lit ? 'Шаблон' : 'Уверенно'}</span>`;
}
function cardHtml(i) {
  const s = st(i);
  const active = i.key === S.activeKey;
  const fixable = i.after !== i.before;
  return `<div class="card${active ? ' on' : ''}" data-key="${esc(i.key)}">
    <div class="cb${fixable ? (s.selected ? ' on' : '') : ' hidden'}" data-act="toggle">${s.selected && fixable ? ic('check', 12, '#fff', 3) : ''}</div>
    <div class="cbody"><div class="ctop"><span class="tag ${CAT[i.category] ? CAT[i.category].cls : 'st'}">${tagFor(i)}</span>${confHtml(i)}<span class="loc">Абз. ${paraNo(i.para)}</span></div>
      ${fixLine(i)}
      ${active || i.confidence === 'check' ? `<div class="why">${esc(i.why || '')}</div>` : ''}
      ${active && i.source ? `<div class="src">${ic('book', 12)}${(i.ref || []).length ? `<a data-act="open-rule" data-rule="${i.ref[0]}" style="color:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer">${esc(i.source)}</a>` : (i.manualRef || []).length ? `<a data-act="open-manual" data-manual="${esc(i.manualRef[0])}" style="color:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer">${esc(i.source)}</a>` : esc(i.source)}</div>` : ''}
      ${active && i.category === 'spelling' && (i.alternatives || []).length ? `<div class="src">Ещё: ${i.alternatives.slice(0, 3).map(a => `<a data-act="use-alt" data-alt="${esc(a.text)}" style="color:var(--navy);font-weight:600;cursor:pointer">${shown(a.text)}</a>`).join(', ')}</div>` : ''}
      ${active && i.category === 'punctuation' && i.after !== i.before ? corpusPunctHtml(i) : ''}
      ${active ? `<div class="acts">${fixable ? `<button class="btn sm ok" data-act="accept">${ic('check', 13, 'currentColor', 2.5)}Принять <span class="k">↵</span></button>` : ''}
        <button class="btn sm" data-act="reject">Отклонить</button>
        ${i.category === 'spelling' ? `<button class="btn sm ghost" data-act="add-word">В мой словарь</button>` : `<button class="btn sm ghost" data-act="ignore">Пропускать везде</button>`}</div>` : ''}
    </div></div>`;
}
// «Как пишут в корпусе»: share of the variant with a comma in a НКРЯ sample of the same word sequence.
function punctWordsGap(i) {
  let p = 0;
  while (p < i.before.length && p < i.after.length && i.before[p] === i.after[p]) p++;
  const words = i.before.split(/[\s\u00a0]+/).map(w => w.replace(/[^а-яёА-ЯЁa-zA-Z0-9-]/g, '')).filter(Boolean);
  const left = i.before.slice(0, p).split(/[\s\u00a0]+/).filter(w => w.replace(/[^а-яёА-ЯЁa-zA-Z0-9-]/g, '')).length;
  return { words, gap: Math.max(0, Math.min(words.length - 2, left - 1)) };
}
S.corpusPunct = new Map();
function corpusPunctHtml(i) {
  if (!(S.nkrya && S.nkrya.connected)) return '';
  const st2 = S.corpusPunct.get(i.key);
  if (!st2) return `<div class="src"><a data-act="corpus-punct" style="color:var(--navy);font-weight:600;cursor:pointer">${ic('search', 12)} Как пишут в корпусе</a></div>`;
  if (st2.loading) return `<div class="src">${ic('spinner', 12)} Ищу в Национальном корпусе…</div>`;
  if (st2.error) return `<div class="src" style="color:var(--red-ink)">${esc(st2.error)}</div>`;
  const d = st2.data;
  if (!d.sample) return `<div class="src">В корпусе такого сочетания не нашлось.</div>`;
  const pc = Math.round(d.comma / d.sample * 100);
  const ex = d.examples[i.after.includes(',') && !i.before.includes(',') ? 'comma' : 'plain'];
  return `<div class="notice" style="margin-top:8px;display:block;background:#f4f1ea;border-color:#e2ddd2;color:var(--ink2)">
    <b>Национальный корпус:</b> «${esc(d.phrase)}» — ${fmtNum(d.occurrences)} ${plural(d.occurrences, ['вхождение', 'вхождения', 'вхождений'])}. В выборке из ${d.sample}: с запятой ${pc}%, без запятой ${100 - pc}%.
    ${ex ? `<div style="font-family:'PT Serif',serif;font-size:13px;margin-top:6px;color:var(--muted)">${esc(ex.text)}</div>` : ''}
    <div style="font-size:11px;color:var(--muted3);margin-top:4px">Показывает, как пишут в изданных текстах; решение — по правилу.</div></div>`;
}
async function loadCorpusPunct(i) {
  const { words, gap } = punctWordsGap(i);
  S.corpusPunct.set(i.key, { loading: true }); renderPanel();
  try { S.corpusPunct.set(i.key, { data: await window.api.nkryaPunct(words, gap) }); }
  catch (e) { S.corpusPunct.set(i.key, { error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
  renderPanel();
}

function staleCard(i) {
  return `<div class="card off"><div class="cb"></div><div class="cbody"><div class="ctop"><span class="pill n" style="padding:2px 7px;font-size:11px">Неактуально</span><span class="loc">Абз. ${paraNo(i.para)}</span></div>
    <div class="fix"><s>${shown(i.before)}</s><span class="ar">→</span><b>${shown(i.after)}</b></div><div class="why">Исправлено вручную — правка больше не нужна.</div></div></div>`;
}
function sortIssues(list) {
  const order = { spelling: 0, grammar: 1, punctuation: 2, typography: 3, repeat: 4, style: 5 };
  const l = [...list];
  if (S.sort === 'type') l.sort((a, b) => order[a.category] - order[b.category] || a.para - b.para || a.start - b.start);
  else if (S.sort === 'conf') l.sort((a, b) => (a.confidence === 'check') - (b.confidence === 'check') || a.para - b.para || a.start - b.start);
  else l.sort((a, b) => a.para - b.para || a.start - b.start);
  return l;
}

function renderPanel() {
  const panel = $('#panel');
  if (!panel) return;
  if (S.mode === 'lit') return renderLitPanel(panel);
  const vis = visibleIssues();
  const list = sortIssues(S.filter === 'all' ? vis : vis.filter(i => i.category === S.filter));
  const selCount = vis.filter(i => st(i).selected && i.after !== i.before).length;
  const fixableInList = list.filter(i => i.after !== i.before);
  const allSel = fixableInList.length && fixableInList.every(i => st(i).selected);
  const someSel = fixableInList.some(i => st(i).selected);
  const counts = {};
  for (const i of vis) counts[i.category] = (counts[i.category] || 0) + 1;
  const chips = [`<span class="chip${S.filter === 'all' ? ' on' : ''}" data-filter="all">Все · ${vis.length}</span>`,
    ...['spelling', 'punctuation', 'grammar', 'typography', 'repeat'].filter(c => counts[c]).map(c => `<span class="chip${S.filter === c ? ' on' : ''}" data-filter="${c}"><i style="background:${CAT[c].color}"></i>${CAT[c].title} · ${counts[c]}</span>`)].join('');
  const body = S.checking && !S.issues.length ? `<div class="empty">${ic('spinner', 20)}<br>Проверяю текст…</div>`
    : !vis.length && !S.stale.length ? `<div class="empty"><b>Ошибок не найдено</b>Текст проверен по словарям и правилам профиля «${esc(profileName())}».</div>`
    : list.map(cardHtml).join('') + S.stale.map(staleCard).join('');
  const html = `<div class="ph"><h3>Исправления <small>${vis.length} ${plural(vis.length, ['найдено', 'найдено', 'найдено'])} · ${selCount} ${plural(selCount, ['выбрано', 'выбрано', 'выбрано'])}</small></h3>
      ${S.notice ? `<div class="notice">${ic('info', 16, '#a9790c')}<div>${S.notice}</div></div>` : `<div class="chips">${chips}</div>`}</div>
    <div class="selbar"><div class="cb ${allSel ? 'on' : someSel ? 'part' : ''}" data-act="toggle-all">${allSel ? ic('check', 12, '#fff', 3) : ''}</div><span data-act="toggle-all">Выбрать все</span><span class="sp1"></span>
      <span style="display:flex;align-items:center;gap:6px">Сначала: <select id="sortSel"><option value="text"${S.sort === 'text' ? ' selected' : ''}>по тексту</option><option value="type"${S.sort === 'type' ? ' selected' : ''}>по типу</option><option value="conf"${S.sort === 'conf' ? ' selected' : ''}>уверенные</option></select>${ic('down', 14)}</span></div>
    <div class="list" id="list">${body}</div>
    <div class="pf"><button class="btn" data-act="reject-selected"${selCount ? '' : ' disabled'}>${ic('x', 14)}Отклонить</button><span class="sp1"></span>
      <button class="btn pri" data-act="apply-selected"${selCount ? '' : ' disabled'}>${ic('check', 14, 'currentColor', 2.5)}Применить выбранные · ${selCount}</button></div>`;
  if (panel.dataset.html === html) return;
  panel.dataset.html = html;
  panel.innerHTML = html;
  $('#sortSel').onchange = e => { S.sort = e.target.value; renderPanel(); };
  const act = panel.querySelector('.card.on');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function renderLitPanel(panel) {
  if (!S.lit) { panel.dataset.html = ''; panel.innerHTML = `<div class="empty">${ic('spinner', 20)}<br>Анализирую стиль…</div>`; return; }
  const L = S.lit;
  const vis = litVisible();
  const color = L.score < 5 ? '#d6453d' : L.score < 7.5 ? '#e08a1e' : '#2e7d57';
  const max = Math.max(1, ...L.metrics.map(m => m.count));
  const metrics = L.metrics.map(m => `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line3);font-size:13px"><span>${esc(m.title)}</span><span class="sp1"></span>
      <div class="bar"><i style="width:${Math.round((m.count / max) * 100)}%;background:${m.id === 'repeat' ? '#e08a1e' : '#8b5cf6'}"></i></div><b style="margin-left:10px;width:18px;text-align:right">${m.count}</b></div>`).join('');
  const sel = vis.filter(i => lst(i).selected && hasFix(i)).length;
  const cards = vis.map(i => {
    const s = lst(i);
    const active = i.key === S.litActive;
    const alts = [...(i.after !== i.before ? [{ text: i.after, note: '' }] : []), ...(i.alternatives || []).filter(a => a.text !== i.after)];
    return `<div class="card${active ? ' on' : ''}" data-litkey="${esc(i.key)}">
      <div class="cb${hasFix(i) ? (s.selected ? ' on' : '') : ''}" data-act="lit-toggle">${s.selected && hasFix(i) ? ic('check', 12, '#fff', 3) : ''}</div>
      <div class="cbody"><div class="ctop"><span class="tag ${CAT[i.category] ? CAT[i.category].cls : 'st'}">${tagFor(i)}</span>${confHtml(i, true)}<span class="loc">Абз. ${paraNo(i.para)}</span></div>
      ${active && alts.length > 1 ? `<div class="fix long"><s>${shown(i.before)}</s></div><div style="font-size:12px;color:#7d786d;margin:8px 0 6px">Выберите вариант:</div>
          <div class="alts">${alts.map((a, k) => `<div class="alt${s.alt === k ? ' on' : ''}" data-act="lit-alt" data-alt="${k}"><div class="rad${s.alt === k ? ' on' : ''}" style="width:16px;height:16px${s.alt === k ? ';border-width:5px' : ''}"></div><span>${a.text === '' ? 'убрать' : shown(a.text)}</span></div>`).join('')}</div>`
        : fixLine(i, alts[s.alt] ? alts[s.alt].text : undefined)}
      ${active || !hasFix(i) ? `<div class="why">${esc(i.why || '')}</div>` : ''}
      ${active ? `<div class="acts">${hasFix(i) ? `<button class="btn sm ok" data-act="lit-accept">${ic('check', 13, 'currentColor', 2.5)}Принять</button>` : ''}<button class="btn sm" data-act="lit-reject">Отклонить</button><button class="btn sm ghost" data-act="lit-manual">Править вручную</button></div>` : ''}
      </div></div>`;
  }).join('');
  const html = `<div class="ph"><div style="display:flex;align-items:center;gap:14px"><div style="width:58px;height:58px;border-radius:29px;border:5px solid ${color};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;flex:none">${String(L.score).replace('.', ',')}</div>
      <div><b style="font-size:15px">Ясность текста</b><div style="font-size:12px;color:#7d786d;line-height:1.45;margin-top:2px">из 10 · считается по стоп-словам, длине предложений и повторам</div></div></div>
      <div style="margin-top:8px">${metrics}</div></div>
    <div class="list">${cards || `<div class="empty"><b>Стилистических замечаний нет</b>Текст читается легко.</div>`}</div>
    <div class="pf"><button class="btn" data-act="lit-reject-all"${vis.length ? '' : ' disabled'}>Отклонить все</button><span class="sp1"></span><button class="btn pri" data-act="lit-apply"${sel ? '' : ' disabled'}>${ic('check', 14, 'currentColor', 2.5)}Применить выбранные · ${sel}</button></div>`;
  if (panel.dataset.html === html) return;
  panel.dataset.html = html;
  panel.innerHTML = html;
  const act = panel.querySelector('.card.on');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

// ---------- actions on corrections ----------
function issueByKey(k) { return S.issues.find(i => i.key === k); }
function activateIssue(key, { fromText = false, anchor = null } = {}) {
  if (S.mode === 'lit') {
    S.litActive = key;
    renderLitPanel($('#panel'));
    document.querySelectorAll('#paper .m.sel').forEach(e => e.classList.remove('sel'));
    document.querySelectorAll(`#paper .m[data-k="${CSS.escape(key)}"]:not(.block)`).forEach(e => e.classList.add('sel'));
    return;
  }
  S.activeKey = key;
  renderPanel();
  document.querySelectorAll('#paper .m.sel').forEach(e => e.classList.remove('sel'));
  const mark = anchor || document.querySelector(`#paper .m[data-k="${CSS.escape(key)}"]`);
  if (mark) { mark.classList.add('sel'); if (!fromText) mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  const i = issueByKey(key);
  if (fromText && i && i.category === 'spelling' && mark) openWordPop(i, mark); else closePop();
}

function applyIssues(list, { record = true } = {}) {
  if (!list.length) return;
  pushHistory();
  // accepted fixes are not manual edits: paragraphs without hand edits get a new highlight baseline
  const untouched = new Set(S.doc.paragraphs.map((p, idx) => (textOf(p) === S.baseline[idx] ? idx : -1)));
  S.doc = Model.applyFixes(S.doc, list.map(i => ({ para: i.para, start: i.start, end: i.end, after: i.chosen != null ? i.chosen : i.after })));
  if (record) S.applied.push(...list.map(i => ({ category: i.category, ruleId: i.ruleId, para: i.para, before: i.before, after: i.chosen != null ? i.chosen : i.after, why: i.why, source: i.source, tag: tagFor(i) })));
  S.doc.paragraphs.forEach((p, idx) => { if (untouched.has(idx)) S.baseline[idx] = textOf(p); });
  S.dirty = true;
  renderTitle();
  renderPaper(false);
  runCheck();
}
function acceptActive() {
  const i = issueByKey(S.activeKey);
  if (!i || i.after === i.before) return;
  const next = nextKeyAfter(i.key);
  applyIssues([i]);
  S.activeKey = next;
}
function rejectActive() {
  const i = issueByKey(S.activeKey);
  if (!i) return;
  const next = nextKeyAfter(i.key);
  st(i).rejected = true;
  S.activeKey = next;
  refreshDoc();
}
function nextKeyAfter(key) {
  const l = sortIssues(visibleIssues().filter(i => S.filter === 'all' || i.category === S.filter));
  const idx = l.findIndex(i => i.key === key);
  return (l[idx + 1] || l[idx - 1] || {}).key || null;
}
function refreshDoc() { renderPaper(true); renderPanel(); renderStatus(); renderSide(); }
function moveActive(d) {
  if (S.mode === 'lit') {
    const l = litVisible(); const idx = l.findIndex(i => i.key === S.litActive);
    const n = l[Math.max(0, Math.min(l.length - 1, idx + d))]; if (n) activateIssue(n.key); return;
  }
  const l = sortIssues(visibleIssues().filter(i => S.filter === 'all' || i.category === S.filter));
  const idx = l.findIndex(i => i.key === S.activeKey);
  const n = l[Math.max(0, Math.min(l.length - 1, idx + d))];
  if (n) activateIssue(n.key);
}

async function addUserWord(word) {
  const w = word.trim();
  if (!w) return;
  const words = [...new Set([...(S.store.userWords || []), w])].sort((a, b) => a.localeCompare(b, 'ru'));
  S.store = await window.api.store.set({ userWords: words });
  toast(`«${esc(w)}» добавлено в «Мой словарь»`);
  if (S.doc) runCheck();
}

// ---------- word popover (spelling) ----------
// The article text repeats the headword; show it once (comparison ignores stress marks and old letters).
function dalBody(d) {
  const norm = t => t.normalize('NFD').replace(/[\u0300\u0301]/g, '').normalize('NFC').toLowerCase().replace(/ѣ/g, 'е').replace(/[іѵ]/g, 'и').replace(/ъ(?=[\s,.;:]|$)/g, '');
  const text = d.text || '', head = (d.word || '').trim();
  if (!head) return text;
  const words = head.split(/\s+/).length;
  const lead = text.split(/\s+/).slice(0, words).join(' ');
  return norm(lead).replace(/[,.;:]+$/, '') === norm(head).replace(/[,.;:]+$/, '') ? text.split(/\s+/).slice(words).join(' ') : text;
}
let popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
async function openWordPop(issue, anchor) {
  closePop();
  let info;
  try { info = await window.api.engine('wordInfo', issue.before, { para: issue.para, start: issue.start, end: issue.end, doc: engineDoc(S.doc) }); } catch (e) { info = null; }
  if (S.activeKey !== issue.key) return;
  // engine's ranked suggestions first, then the card's alternatives; no duplicates, at most three
  const sugg = [];
  for (const x of [...((info && info.suggestions) || []), { word: issue.after, note: issue.note || '', fits: true }, ...(issue.alternatives || []).map(a => ({ word: a.text, note: a.note, fits: false }))]) {
    if (x.word && x.word !== issue.before && !sugg.some(y => y.word === x.word)) sugg.push(x);
  }
  const r = anchor.getBoundingClientRect();
  popEl = document.createElement('div');
  popEl.className = 'pop';
  popEl.dataset.key = issue.key;
  let tab = 'orth';
  let corpus = null; // { loading } | { data } | { error }
  const lemma = (info && info.lemma) || (sugg[0] && sugg[0].word) || issue.after;
  const loadCorpus = async () => {
    if (corpus) return;
    if (!(S.nkrya && S.nkrya.connected)) { corpus = { off: true }; return draw(); }
    corpus = { loading: true }; draw();
    try {
      // the corpus wants a dictionary form: for a misspelled word take the lemma of the best suggestion
      let lem = lemma;
      if (!(info && info.known && info.lemma) && sugg[0]) { try { const i2 = await window.api.engine('wordInfo', sugg[0].word); if (i2 && i2.lemma) lem = i2.lemma; } catch { /* keep the form */ } }
      corpus = { data: await window.api.nkryaPortrait(lem) };
    } catch (e) { corpus = { error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }; }
    if (popEl) draw();
  };
  const corpusHtml = () => {
    if (!corpus || corpus.loading) return `<span style="color:var(--muted2)">${ic('spinner', 13)} Спрашиваю Национальный корпус…</span>`;
    if (corpus.off) return `<span style="color:var(--muted2)">Национальный корпус не подключён.</span> <a data-popact="nkrya-connect" style="color:var(--navy);font-weight:600;cursor:pointer">Подключить</a>`;
    if (corpus.error) return `<span style="color:var(--red-ink)">${esc(corpus.error)}</span>`;
    const d = corpus.data;
    const f = d.frequency;
    const ex = d.examples.map(x => { let h = '', pos = 0; for (const [a, b] of x.hits) { h += esc(x.text.slice(pos, a)) + '<b>' + esc(x.text.slice(a, b)) + '</b>'; pos = b; } h += esc(x.text.slice(pos)); return `<div style="font-family:'PT Serif',serif;font-size:13px;line-height:1.5;padding:4px 0 4px 10px;border-left:2px solid var(--line);margin-top:6px">${h}${x.title ? `<div style="font-family:Inter;font-size:10.5px;color:var(--muted3)">${esc(x.title.slice(0, 90))}</div>` : ''}</div>`; }).join('');
    return `${f ? `<b style="font-family:'PT Serif',serif;font-size:14px">${esc(d.lemma)}</b> — ${String(Math.round(f.ipm * 10) / 10).replace('.', ',')} на миллион словоупотреблений · ${esc(f.title)}` : `<b>${esc(d.lemma)}</b> — в основном корпусе не найдено`}
      ${ex || ''}<div style="margin-top:6px"><a data-popact="nkrya-open" style="color:var(--navy);font-weight:600;cursor:pointer">Открыть в НКРЯ</a></div>`;
  };
  const tabHtml = () => {
    if (tab === 'corpus') return corpusHtml();
    if (tab === 'morph') return info && info.morph && info.morph.length ? info.morph.slice(0, 10).map(m => `<div style="display:flex;gap:8px"><b style="font-family:'PT Serif',serif;font-size:13.5px;min-width:120px">${esc(m.form)}</b><span style="color:var(--muted2)">${esc(m.tags)}</span></div>`).join('') : '<span style="color:var(--muted2)">Морфологических данных нет.</span>';
    if (tab === 'dal') return info && info.dal ? `${info.dal.approx ? '<div style="font-size:11.5px;color:var(--muted3);margin-bottom:4px">Отдельной статьи нет — ближайшее гнездо слов у Даля</div>' : ''}<div style="max-height:180px;overflow:auto;user-select:text"><b style="font-family:'PT Serif',serif;font-size:14px">${esc(info.dal.word || '')}</b> ${esc(dalBody(info.dal))}</div>${info.dal.url ? `<div style="margin-top:6px"><a data-popact="dal-open" style="color:var(--navy);font-weight:600;cursor:pointer">Открыть на Викитеке</a></div>` : ''}` : '<span style="color:var(--muted2)">В словаре Даля такого слова нет.</span>';
    return info && (info.forms || info.rule) ? `${info.forms ? `<b style="font-family:'PT Serif',serif;font-size:14px">${esc(info.forms)}</b><br>` : ''}${info.rule ? `<span style="color:var(--muted2)">Правило: ${esc(info.rule)}</span>` : ''}` : `<span style="color:var(--muted2)">${esc(issue.why || '')}</span>`;
  };
  const draw = () => {
    popEl.innerHTML = `<div style="padding:14px 16px 10px;border-bottom:1px solid var(--line3)"><div style="display:flex;align-items:center;gap:8px"><span class="tag sp">Орфография</span>${confHtml(issue)}</div>
      <div style="font-family:'PT Serif',serif;font-size:20px;margin-top:6px"><s style="color:var(--red-ink)">${shown(issue.before)}</s></div>
      <div style="font-size:12px;color:var(--muted3);margin-top:2px">${info && info.known ? 'Слово есть в словаре, но здесь, вероятно, ошибка' : 'Нет в словаре'} · похожие слова с учётом падежа в предложении</div></div>
      <div style="padding:6px 8px">${sugg.slice(0, 3).map((s, k) => `<div class="sug${k === 0 ? ' on' : ''}" data-pick="${esc(s.word)}"><span class="w">${shown(s.word)}</span><small>${esc(s.note || '')}${s.fits && s.note ? ' — подходит' : ''}</small><span class="sp1"></span><span class="kbd">${k + 1}</span></div>`).join('')}</div>
      <div style="margin:0 12px;padding:12px;background:var(--bg);border-radius:10px;font-size:12.5px;line-height:1.55;color:var(--ink2)">
        <div style="display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap">${[['orth', 'Орфографический'], ['dal', 'Толковый (Даль)'], ['morph', 'Морфология'], ['corpus', 'Корпус']].map(([k, t]) => `<span class="chip${tab === k ? ' on' : ''}" data-tab="${k}" style="height:22px;font-size:10.5px;padding:0 7px">${t}</span>`).join('')}</div>${tabHtml()}</div>
      <div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ok" data-pick="${esc(sugg[0] ? sugg[0].word : issue.after)}">${ic('check', 13, 'currentColor', 2.5)}Заменить</button>
        <button class="btn sm" data-popact="addword">${ic('plus', 13)}В мой словарь</button><button class="btn sm ghost" data-popact="ignore">Игнорировать</button><span class="sp1"></span>
        <button class="btn sm ghost" data-popact="gramota">${ic('ext', 13)}Грамота.ру</button></div>`;
  };
  draw();
  $('#layer').appendChild(popEl);
  const h = popEl.offsetHeight;
  popEl.style.left = Math.min(window.innerWidth - 400, Math.max(240, r.left - 40)) + 'px';
  popEl.style.top = (r.bottom + h + 12 < window.innerHeight ? r.bottom + 8 : Math.max(50, r.top - h - 8)) + 'px';
  popEl.addEventListener('click', e => {
    // the popover redraws itself on tab switch; keep the click from reaching the document handler, which would see
    // a detached target and treat it as a click outside
    e.stopPropagation();
    const t = e.target.closest('[data-tab],[data-pick],[data-popact]');
    if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; draw(); if (tab === 'corpus') loadCorpus(); return; }
    if (t.dataset.popact === 'nkrya-open') { window.api.openExternal(corpus.data.url); return; }
    if (t.dataset.popact === 'dal-open') { window.api.openExternal(info.dal.url); return; }
    if (t.dataset.pick != null) { closePop(); applyIssues([{ ...issue, chosen: t.dataset.pick }]); return; }
    const a = t.dataset.popact;
    closePop();
    if (a === 'addword') addUserWord(issue.before);
    if (a === 'ignore') { st(issue).rejected = true; refreshDoc(); }
    if (a === 'nkrya-connect') openNkryaModal();
    if (a === 'gramota') window.api.openExternal(`https://gramota.ru/poisk?query=${encodeURIComponent(issue.before)}&mode=slovari`);
  });
  popEl.pickN = n => { const s = sugg[n]; if (s) { closePop(); applyIssues([{ ...issue, chosen: s.word }]); } };
}
