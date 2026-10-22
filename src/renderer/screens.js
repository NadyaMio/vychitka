'use strict';
/* global S, $, esc, ic, Model, textOf, plural, fmtNum, shown, toast, fail, show, renderSide, renderTitle, profileName, settings, visibleIssues, st, runCheck, applyIssues, kbdMod, CAT, tagFor, closePop */

// ============================================================ modal helper
function modal(html, bind) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal">${html}</div>`;
  $('#layer').appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  bind(ov, close);
  const f = ov.querySelector('input[type=text]') || ov.querySelector('.btn.pri');
  if (f) f.focus();
  return close;
}

// ============================================================ apply & save (mockup 05)
const SAVE_EXT_OVERWRITE = ['docx', 'txt', 'md'];
function baseName() { return S.doc.name.replace(/\.[^.]+$/, ''); }

function openSaveModal({ applySelected }) {
  const sel = applySelected ? visibleIssues().filter(i => st(i).selected && i.after !== i.before) : [];
  const notSelected = applySelected ? visibleIssues().filter(i => i.after !== i.before).length - sel.length : 0;
  const canOverwrite = S.doc.source === 'file' && SAVE_EXT_OVERWRITE.includes(S.doc.ext);
  const fromPaste = S.doc.source === 'paste';
  let mode = 'track';
  let report = true;
  const n = sel.length;
  const title = applySelected ? `Применить ${n} ${plural(n, ['исправление', 'исправления', 'исправлений'])}` : 'Сохранить текст';
  const lead = applySelected
    ? `${notSelected ? `${notSelected} ${plural(notSelected, ['правка не выбрана и останется', 'правки не выбраны и останутся', 'правок не выбраны и останутся'])} в списке. ` : ''}Отменить можно в любой момент: ${kbdMod('Z')}.`
    : `Принято правок за сеанс: ${S.applied.length}. Ручных правок: ${S.editCount}.`;
  const opt = (id, t, d, disabled) => `<div class="opt${mode === id ? ' on' : ''}${disabled ? ' disabled' : ''}" data-mode="${id}"><div class="rad${mode === id ? ' on' : ''}"></div><div><b>${t}</b><small>${d}</small></div></div>`;
  const draw = ov => {
    ov.querySelector('.mb').innerHTML = `
      ${opt('track', 'Сохранить копию с режимом правок', `${esc(baseName())} (вычитка).docx — правки видны в Word как рецензирование, автор: «Вычитка»`)}
      ${opt('clean', 'Сохранить копию начисто', 'Исправленный текст без пометок, оригинал не меняется')}
      ${fromPaste ? opt('clipboard', 'Скопировать исправленный текст', 'Текст вставлен из буфера — положим исправленный обратно в буфер обмена')
        : opt('overwrite', 'Перезаписать исходный файл', canOverwrite ? 'Резервная копия сохранится в папке «Вычитка/Резерв»' : `Для .${esc(S.doc.ext || '')} нельзя: сохраните копию в DOCX`, !canOverwrite)}
      <div style="display:flex;align-items:center;gap:10px;font-size:13px;padding:4px 2px;cursor:default" data-act="report"><div class="cb${report ? ' on' : ''}">${report ? ic('check', 12, '#fff', 3) : ''}</div>Сохранить отчёт корректора (PDF): что исправлено и по каким правилам</div>`;
  };
  modal(`<div class="mh"><h2>${title}</h2><p>${lead}</p></div><div class="mb"></div>
    <div class="mf">${applySelected ? '<button class="btn ghost" data-act="only-apply" style="margin-right:auto">Только применить в окне</button>' : ''}<button class="btn" data-act="cancel">Отмена</button><button class="btn pri" data-act="go">${ic('check', 14, 'currentColor', 2.5)}${applySelected ? 'Применить и сохранить' : 'Сохранить'}</button></div>`,
  (ov, close) => {
    draw(ov);
    ov.addEventListener('click', async e => {
      const t = e.target.closest('[data-mode],[data-act]');
      if (!t) return;
      if (t.dataset.mode) { mode = t.dataset.mode; draw(ov); return; }
      const a = t.dataset.act;
      if (a === 'report') { report = !report; draw(ov); return; }
      if (a === 'cancel') return close();
      if (a === 'only-apply') { close(); applyIssues(sel); return; }
      if (a === 'go') {
        close();
        if (applySelected && sel.length) applyIssues(sel);
        await saveDocument(mode, report);
      }
    });
  });
}

async function saveDocument(mode, withReport) {
  try {
    const doc = await finalDoc();
    if (mode === 'clipboard') {
      await window.api.writeClipboard(doc.paragraphs.map(textOf).join('\n\n'));
      toast('Исправленный текст скопирован в буфер обмена');
      if (withReport) await window.api.saveReport({ html: reportHtml(), suggestedName: 'Отчёт корректора.pdf' });
      S.dirty = false; renderTitle();
      return;
    }
    const paragraphs = mode === 'track' ? Model.trackedParagraphs(S.original, doc) : Model.cleanParagraphs(doc);
    const res = await window.api.save({
      paragraphs, mode: mode === 'overwrite' ? 'overwrite' : mode,
      sourcePath: S.doc.path, suggestedName: `${baseName()} (вычитка).docx`,
      report: withReport ? { html: reportHtml() } : null,
    });
    if (!res) return;
    S.dirty = false;
    S.store = await window.api.store.get();
    renderTitle(); renderSide();
    toast(`Сохранено: ${esc(res.path.split(/[\\/]/).pop())}${res.report ? ' и отчёт корректора' : ''}`, { action: 'Показать в папке', onAction: () => window.api.reveal(res.path) });
  } catch (e) { fail(e, 'Не удалось сохранить. '); }
}

// Non-breaking spaces after short words are set on export, as the profile says.
async function finalDoc() {
  const doc = Model.clone(S.doc);
  doc.paragraphs = doc.paragraphs.filter(p => textOf(p).trim());
  if (settings().nbsp === 'none') return doc;
  for (const p of doc.paragraphs) {
    for (const r of p.runs) {
      try { r.text = await window.api.engine('applyNbsp', r.text, settings()); } catch { /* engine without nbsp support: keep text */ }
    }
  }
  return doc;
}

function reportHtml() {
  const f = S.info.fontsDir.replace(/\\/g, '/');
  const date = new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const by = {};
  for (const a of S.applied) by[a.tag] = (by[a.tag] || 0) + 1;
  const rows = S.applied.map((a, k) => `<tr><td>${k + 1}</td><td>${esc(a.tag)}</td><td><s>${shown(a.before)}</s> → <b>${shown(a.after) || '<i>убрано</i>'}</b><div class="w">${esc(a.why || '')}</div><div class="s">${esc(a.source || '')}</div></td><td>${a.para + 1}</td></tr>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
    @font-face{font-family:'PT Serif';font-weight:400;src:url('file://${f}/PTSerif-Regular.ttf')}@font-face{font-family:'PT Serif';font-weight:700;src:url('file://${f}/PTSerif-Bold.ttf')}@font-face{font-family:Inter;font-weight:100 900;src:url('file://${f}/Inter.ttf')}
    body{font-family:Inter,sans-serif;color:#1d1c1a;font-size:11pt;margin:0}h1{font-family:'PT Serif',serif;font-size:22pt;margin:0 0 4pt}.meta{color:#6f6a60;font-size:9.5pt;margin-bottom:14pt}
    .sum{display:flex;gap:8pt;flex-wrap:wrap;margin-bottom:14pt}.sum span{background:#efebe3;border-radius:10pt;padding:3pt 9pt;font-size:9pt;font-weight:600}
    table{border-collapse:collapse;width:100%}th{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#8a857a;text-align:left;border-bottom:1px solid #ddd7ca;padding:5pt}
    td{border-bottom:1px solid #eee9df;padding:6pt 5pt;vertical-align:top;font-size:10pt}td s{color:#b03a33}td b{color:#1d6b45}td:nth-child(3){font-family:'PT Serif',serif;font-size:11pt}
    .w{font-family:Inter,sans-serif;font-size:9pt;color:#4a473f;margin-top:2pt}.s{font-family:Inter,sans-serif;font-size:8pt;color:#8a857a}</style></head><body>
    <h1>Отчёт корректора</h1><div class="meta">${esc(S.doc.name)} · ${date} · профиль «${esc(profileName())}» · база ${esc((S.info.bases && S.info.bases.version) || '')} · «Вычитка» ${esc(S.info.version)}</div>
    <div class="sum"><span>Принято правок: ${S.applied.length}</span>${Object.entries(by).map(([k, v]) => `<span>${esc(k)}: ${v}</span>`).join('')}<span>Ручных правок: ${S.editCount}</span></div>
    ${S.applied.length ? `<table><tr><th>№</th><th>Тип</th><th>Исправление</th><th>Абз.</th></tr>${rows}</table>` : '<p>Исправления не применялись.</p>'}</body></html>`;
}

// ============================================================ settings (mockup 02)
function renderSettings() {
  const s = settings();
  const profiles = S.store.profiles;
  const chk = (key, label, note) => `<div class="chkrow" data-check="${key}"><div class="cb${s.checks[key] ? ' on' : ''}">${s.checks[key] ? ic('check', 12, '#fff', 3) : ''}</div><div><b>${label}</b><small>${note}</small></div></div>`;
  const litChk = `<div class="chkrow" data-act="toggle-lit"><div class="cb${s.literary ? ' on' : ''}">${s.literary ? ic('check', 12, '#fff', 3) : ''}</div><div><b>Литературная правка</b><small>${s.literary ? 'Запускается вместе с корректурой' : 'Запускается отдельно — вкладка «Литературная правка»'}</small></div></div>`;
  const sel = (key, label, opts) => `<div class="selrow"><span>${label}</span><span class="sp1"></span><div class="selwrap"><select data-norm="${key}">${opts.map(([v, t]) => `<option value="${v}"${String(s[key]) === String(v) ? ' selected' : ''}>${t}</option>`).join('')}</select>${ic('down', 14)}</div></div>`;
  const chars = S.doc ? Model.stats(S.doc).chars : 0;
  $('#main').innerHTML = `<div class="toolbar"><div class="docname"><b>Настройка проверки</b><small>${S.doc ? `${esc(S.doc.name)} · ${fmtNum(chars)} ${plural(chars, ['знак', 'знака', 'знаков'])} · ${S.doc.paragraphs.length} ${plural(S.doc.paragraphs.length, ['абзац', 'абзаца', 'абзацев'])}` : 'Нормы применяются ко всем новым проверкам'}</small></div><span class="sp1"></span>
      <button class="btn ghost" data-act="save-profile">Сохранить как профиль</button><button class="btn pri" data-act="run-check">${ic('spell', 14)}Запустить проверку <span class="k" style="opacity:.7">${kbdMod('R')}</span></button></div>
    <div style="flex:1;display:flex;gap:28px;padding:28px 36px;overflow:auto">
      <div style="width:300px;flex:none;display:flex;flex-direction:column;gap:8px">
        <div class="label" style="margin-bottom:4px">Профиль</div>
        ${profiles.map(p => `<div class="opt${S.store.profileId === p.id ? ' on' : ''}" data-profile="${esc(p.id)}"><div class="rad${S.store.profileId === p.id ? ' on' : ''}"></div><div style="flex:1"><b>${esc(p.name)}</b><small>${esc(p.note || '')}</small></div>${p.builtin ? '' : `<button data-delprofile="${esc(p.id)}" title="Удалить профиль" style="color:var(--muted4)">${ic('x', 14)}</button>`}</div>`).join('')}
        <button class="btn ghost" data-act="save-profile" style="justify-content:flex-start">${ic('plus', 14)}Новый профиль</button></div>
      <div class="card-box" style="flex:1;padding:18px 24px;display:flex;gap:40px;align-self:flex-start">
        <div style="flex:1"><div class="label" style="margin-bottom:4px">Что проверять</div>
          ${chk('spelling', 'Орфография', 'Словарь + поиск похожих слов, имена и термины из «Моего словаря»')}
          ${chk('punctuation', 'Пунктуация', 'Союзы, вводные слова, обороты, однородные члены, обращения')}
          ${chk('grammar', 'Грамматика и согласование', 'Падежи, род и число, управление предлогов')}
          ${chk('typography', 'Типографика', 'Кавычки, тире, неразрывные пробелы, лишние пробелы')}
          ${chk('repeats', 'Повторы слов рядом', 'Одно слово чаще 2 раз в пределах 3 предложений')}
          ${litChk}</div>
        <div style="flex:1"><div class="label" style="margin-bottom:4px">Нормы</div>
          ${sel('yo', 'Буква ё', [['meaning', 'Где важно для смысла'], ['always', 'Ставить везде'], ['never', 'Заменять на е']])}
          ${sel('quotes', 'Кавычки', [['elochki', '«Ёлочки», внутри „лапки“'], ['keep', 'Не менять']])}
          ${sel('dash', 'Тире', [['em', 'Длинное — с пробелами'], ['keep', 'Не менять']])}
          ${sel('nbsp', 'Неразрывный пробел', [['prepositions-numbers', 'После предлогов и в числах'], ['numbers', 'Только в числах'], ['none', 'Не ставить']])}
          ${sel('numbers', 'Числа', [['true', '150 000 — пробел в разрядах'], ['false', 'Не менять']])}
          ${sel('uncertain', 'Спорные случаи', [['mark', 'Помечать «Проверьте»'], ['skip', 'Не показывать']])}
          <div style="display:flex;align-items:center;padding:12px 0;font-size:13.5px;gap:10px;cursor:default" data-act="toggle-quotes"><div class="tog${s.skipQuotes ? ' on' : ''}"></div>Пропускать цитаты и прямую речь</div></div>
      </div></div>
    <div class="status"><span>${S.store.settingsDirty ? 'Профиль изменён · не сохранено' : `Профиль: ${esc(profileName())}`}</span><span class="r">Оценка времени: ${chars < 30000 ? 'меньше секунды' : `около ${Math.ceil(chars / 12000)} с`}</span></div>`;
  $('#main').querySelectorAll('select[data-norm]').forEach(el => el.onchange = () => {
    const v = el.value === 'true' ? true : el.value === 'false' ? false : el.value;
    setSettings({ [el.dataset.norm]: v });
  });
}
async function setSettings(patch, { checks } = {}) {
  const s = { ...settings(), ...patch, checks: { ...settings().checks, ...(checks || {}) } };
  S.store = await window.api.store.set({ settings: s, settingsDirty: true });
  renderSettings();
}
async function selectProfile(id) {
  const p = S.store.profiles.find(x => x.id === id);
  if (!p) return;
  S.store = await window.api.store.set({ profileId: id, settings: JSON.parse(JSON.stringify(p.settings)), settingsDirty: false });
  renderSettings();
}
function saveProfileDialog() {
  modal(`<div class="mh"><h2>Сохранить профиль</h2><p>Текущие настройки проверки сохранятся под этим названием.</p></div>
    <div class="mb"><input type="text" id="profName" placeholder="Например: «Журнал, без ё»"></div>
    <div class="mf"><button class="btn" data-act="cancel">Отмена</button><button class="btn pri" data-act="ok">Сохранить</button></div>`, (ov, close) => {
    const go = async () => {
      const name = ov.querySelector('#profName').value.trim();
      if (!name) return;
      const id = 'p' + Date.now();
      const profiles = [...S.store.profiles, { id, name, note: 'Свой профиль', settings: JSON.parse(JSON.stringify(settings())) }];
      S.store = await window.api.store.set({ profiles, profileId: id, settingsDirty: false });
      close(); renderSettings(); toast(`Профиль «${esc(name)}» сохранён`);
    };
    ov.querySelector('[data-act=ok]').onclick = go;
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.querySelector('#profName').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}

// ============================================================ compare (mockup 07)
const DIFF_TYPES = {
  lost: { pill: 'r', title: 'Потерян абзац', group: 'loss' }, changed: { pill: 'r', title: 'Изменилось слово', group: 'loss' },
  added: { pill: 'n', title: 'Добавлен абзац', group: 'loss' }, notApplied: { pill: 'y', title: 'Правка не внесена', group: 'miss' },
  space: { pill: 'y', title: 'Слетел пробел', group: 'miss' }, format: { pill: 'n', title: 'Только оформление', group: 'format' },
};
function renderCompare() {
  const c = S.cmp;
  if (!c.a && S.doc) c.a = { name: S.doc.name.replace(/(\.[^.]+)?$/, ' (вычитка)$1'), label: 'после корректуры', doc: Model.clone(S.doc), ext: S.doc.ext };
  const chip = (side) => {
    const f = c[side];
    return `<button class="btn filechip" data-act="cmp-pick" data-side="${side}" title="${f ? esc(f.path || f.name) : ''}">${ic('file', 14)}<span>${f ? esc(f.name) : side === 'a' ? 'Исходник…' : 'Вёрстка или новая версия…'}</span></button>`;
  };
  const formatOk = c.a && c.b && !['pdf', 'txt', 'rtf'].includes(c.a.ext) && !['pdf', 'txt', 'rtf'].includes(c.b.ext);
  $('#main').innerHTML = `<div class="toolbar"><div class="docname"><b>Сверка</b><small>текст ↔ вёрстка</small></div>
      ${chip('a')}<span style="color:var(--muted4)">${ic('compare', 16)}</span>${chip('b')}<span class="sp1"></span>
      <div class="seg"><button class="${c.mode === 'text' ? 'on' : ''}" data-cmpmode="text">Текст</button><button class="${c.mode === 'format' ? 'on' : ''}" data-cmpmode="format"${formatOk ? '' : ' disabled title="Оформление сравнивается только для DOCX, ODT и MD"'}>Оформление</button></div>
      <button class="btn" data-act="cmp-report"${c.result ? '' : ' disabled'}>${ic('download', 14)}Отчёт о сверке</button></div>
    <div class="work"><div style="flex:1;display:flex;gap:14px;padding:20px;background:var(--work);min-width:0" id="cmpCols"></div><div class="panel" id="cmpPanel"></div></div>
    <div class="status" id="cmpStatus"></div>`;
  renderCompareBody();
}
async function runCompare() {
  const c = S.cmp;
  if (!c.a || !c.b) return;
  try {
    const ed = d => ({ paragraphs: d.paragraphs.map(p => ({ kind: p.kind, text: textOf(p) })) });
    const res = await window.api.engine('compare', ed(c.a.doc), ed(c.b.doc), { appliedFixes: S.applied });
    res.diffs = res.diffs.map((d, k) => ({ ...d, id: d.id || 'd' + k }));
    c.result = res;
    c.formatDiffs = formatDiffs(res.pairs);
    c.active = (res.diffs[0] || {}).id || null;
    c.checked = new Set();
  } catch (e) { fail(e, 'Сверка не удалась: '); }
  renderCompare();
}
function formatDiffs(pairs) {
  const c = S.cmp;
  const sig = p => p.runs.filter(r => r.b || r.i).map(r => `${r.b ? 'b' : ''}${r.i ? 'i' : ''}:${r.text.trim()}`).join('|') + '#' + p.kind;
  const out = [];
  for (const pr of pairs) {
    if (pr.a == null || pr.b == null) continue;
    const pa = c.a.doc.paragraphs[pr.a], pb = c.b.doc.paragraphs[pr.b];
    if (!pa || !pb) continue;
    if (textOf(pa).replace(/\s+/g, ' ') === textOf(pb).replace(/\s+/g, ' ') && sig(pa) !== sig(pb)) {
      out.push({ id: 'f' + pr.a, type: 'format', aPara: pr.a, bPara: pr.b, aRange: null, bRange: null, title: 'Только оформление', text: `Абзац ${pr.b + 1}: другое выделение (жирный, курсив или заголовок) — на текст не влияет.` });
    }
  }
  return out;
}
function cmpDiffs() {
  const c = S.cmp;
  if (!c.result) return [];
  return c.mode === 'format' ? c.formatDiffs : c.result.diffs;
}
function renderCompareBody() {
  const c = S.cmp;
  const cols = $('#cmpCols');
  if (!c.a || !c.b || !c.result) {
    cols.innerHTML = `<div class="empty" style="background:var(--paper);border:1px solid var(--line2);border-radius:10px;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center">
      <div class="ico-box" style="width:52px;height:52px;margin-bottom:12px">${ic('compare', 24)}</div>
      <b>${!c.a ? 'Выберите исходный текст' : 'Выберите вёрстку или новую версию'}</b>
      Сверка покажет потерянные абзацы, невнесённые правки, слетевшие пробелы и изменённые слова.<br>Подойдут DOCX, PDF с текстом, ODT, RTF, TXT, MD.
      <div style="display:flex;gap:8px;margin-top:14px">${!c.a ? `<button class="btn pri" data-act="cmp-pick" data-side="a">${ic('file', 14)}Открыть исходник…</button>` : ''}<button class="btn${c.a ? ' pri' : ''}" data-act="cmp-pick" data-side="b">${ic('file', 14)}Открыть вёрстку…</button></div></div>`;
    $('#cmpPanel').innerHTML = `<div class="ph"><h3>Расхождения</h3></div><div class="empty">Здесь появится список расхождений.</div>`;
    $('#cmpStatus').innerHTML = '<span>Сверка идёт по словам, переносы и колонтитулы игнорируются</span>';
    return;
  }
  const diffs = cmpDiffs();
  const active = diffs.find(d => d.id === c.active);
  const marksA = new Map(), marksB = new Map();
  for (const d of diffs) {
    if (d.type === 'lost' || d.type === 'added' || d.type === 'format') continue; // whole paragraphs are shown by background, not underline
    const cls = d.type === 'changed' ? 'gr' : 'pn';
    if (d.aRange && d.aPara != null) (marksA.get(d.aPara) || marksA.set(d.aPara, []).get(d.aPara)).push({ start: d.aRange[0], end: d.aRange[1], cls, key: d.id, sel: d.id === c.active });
    if (d.bRange && d.bPara != null) (marksB.get(d.bPara) || marksB.set(d.bPara, []).get(d.bPara)).push({ start: d.bRange[0], end: d.bRange[1], cls, key: d.id, sel: d.id === c.active });
  }
  const lostA = new Set(diffs.filter(d => d.type === 'lost').map(d => d.aPara));
  const para = (doc, idx, marks, extraCls) => {
    const p = doc.paragraphs[idx];
    const ms = (marks.get(idx) || []).sort((x, y) => x.start - y.start);
    const hl = active && ((active.aPara === idx && doc === c.a.doc) || (active.bPara === idx && doc === c.b.doc)) && !active.aRange && !active.bRange;
    return `<p class="${extraCls || ''}${hl ? ' hl' : ''}" data-cp="${idx}"><span class="num">${idx + 1}</span>${Model.paragraphHtml(p, ms)}</p>`;
  };
  let colA = '', colB = '';
  for (const pr of c.result.pairs) {
    if (pr.a != null) colA += para(c.a.doc, pr.a, marksA, lostA.has(pr.a) ? 'lost' : '');
    if (pr.b != null) colB += para(c.b.doc, pr.b, marksB, '');
    if (pr.a != null && pr.b == null) colB += `<div class="missing">Абзац ${pr.a + 1} отсутствует в вёрстке</div>`;
    if (pr.a == null && pr.b != null) colA += `<div class="missing" style="border-color:var(--muted4);color:var(--muted)">Абзаца ${pr.b + 1} нет в исходнике</div>`;
  }
  cols.innerHTML = `<div class="col"><div class="chd">${ic('file', 15, '#7d786d')}<b>Исходник</b><span>${esc(c.a.label || c.a.ext || '')}</span></div><div class="cbody2" id="colA">${colA}</div></div>
    <div class="col"><div class="chd">${ic('file', 15, '#7d786d')}<b>Вёрстка</b><span>${esc(c.b.label || '')}</span></div><div class="cbody2" id="colB">${colB}</div></div>`;
  const groups = { loss: 0, miss: 0, format: c.formatDiffs.length };
  for (const d of c.result.diffs) if (DIFF_TYPES[d.type]) groups[DIFF_TYPES[d.type].group]++;
  const shownList = c.mode === 'format' ? diffs : diffs.filter(d => c.filter === 'all' || DIFF_TYPES[d.type].group === c.filter);
  const card = d => {
    const T = DIFF_TYPES[d.type] || { pill: 'n', title: d.title };
    const on = d.id === c.active;
    const loc = d.bPara != null ? d.bPara + 1 : d.aPara + 1;
    return `<div class="card${on ? ' on' : ''}${c.checked.has(d.id) ? ' off' : ''}" data-diff="${esc(d.id)}" style="flex-direction:column;gap:6px"><div class="ctop" style="margin:0"><span class="pill ${T.pill}">${esc(T.title || d.title)}</span>${c.checked.has(d.id) ? `<span class="conf">${ic('check', 12, 'currentColor', 3)}Проверено</span>` : ''}<span class="loc">Абз. ${loc}</span></div>
      <div class="why" style="margin:0">${esc(d.text || '')}</div>
      ${on ? `<div class="acts" style="margin-top:4px"><button class="btn sm" data-act="cmp-show">Показать в обоих</button><button class="btn sm ghost" data-act="cmp-check">${c.checked.has(d.id) ? 'Снять отметку' : 'Отметить как проверенное'}</button></div>` : ''}</div>`;
  };
  $('#cmpPanel').innerHTML = `<div class="ph"><h3>Расхождения <small>${diffs.length} найдено · ${[...c.checked].filter(id => diffs.some(d => d.id === id)).length} проверено</small></h3>
      ${c.mode === 'format' ? '' : `<div class="chips"><span class="chip${c.filter === 'all' ? ' on' : ''}" data-cmpfilter="all">Все · ${c.result.diffs.length}</span><span class="chip${c.filter === 'loss' ? ' on' : ''}" data-cmpfilter="loss">Потери · ${groups.loss}</span><span class="chip${c.filter === 'miss' ? ' on' : ''}" data-cmpfilter="miss">Не внесено · ${groups.miss}</span><span class="chip" data-cmpmode="format">Оформление · ${groups.format}</span></div>`}</div>
    <div class="list">${shownList.map(card).join('') || `<div class="empty"><b>Расхождений нет</b>Тексты совпадают по словам.</div>`}</div>
    <div class="pf"><span style="font-size:12px;color:var(--muted2)">Сверка идёт по словам, переносы и колонтитулы игнорируются</span></div>`;
  const nA = c.a.doc.paragraphs.length;
  $('#cmpStatus').innerHTML = `<span>Сравнено ${nA} ${plural(nA, ['абзац', 'абзаца', 'абзацев'])}, ${fmtNum(c.result.words || 0)} ${plural(c.result.words || 0, ['слово', 'слова', 'слов'])}</span><span class="r">Совпадение ${c.result.similarity}%</span>`;
}
async function cmpPick(side) {
  try {
    const p = await window.api.openDialog({ title: side === 'a' ? 'Исходный текст' : 'Вёрстка или новая версия', remember: false });
    if (!p) return;
    const m = p.html != null ? Model.fromHtml(p.html) : Model.fromText(p.text || '');
    S.cmp[side] = { name: p.name, path: p.path, ext: p.ext, label: p.ext === 'pdf' ? 'PDF, текстовый слой' : p.ext.toUpperCase(), doc: { paragraphs: m.paragraphs } };
    S.cmp.result = null;
    renderCompare();
    runCompare();
  } catch (e) { fail(e, 'Не удалось открыть файл. '); }
}
function cmpShow() {
  const d = cmpDiffs().find(x => x.id === S.cmp.active);
  if (!d) return;
  for (const [col, idx] of [['#colA', d.aPara], ['#colB', d.bPara]]) {
    if (idx == null) continue;
    const el = document.querySelector(`${col} [data-cp="${idx}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
function compareReportHtml() {
  const c = S.cmp;
  const f = S.info.fontsDir.replace(/\\/g, '/');
  const rows = cmpDiffs().map((d, k) => `<tr><td>${k + 1}</td><td>${esc((DIFF_TYPES[d.type] || {}).title || d.title || '')}</td><td>${esc(d.text || '')}</td><td>${c.checked.has(d.id) ? 'да' : ''}</td></tr>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>@font-face{font-family:Inter;font-weight:100 900;src:url('file://${f}/Inter.ttf')}@font-face{font-family:'PT Serif';font-weight:700;src:url('file://${f}/PTSerif-Bold.ttf')}
    body{font-family:Inter,sans-serif;font-size:10.5pt;color:#1d1c1a}h1{font-family:'PT Serif',serif;font-size:22pt;margin:0 0 4pt}.meta{color:#6f6a60;font-size:9.5pt;margin-bottom:14pt}
    table{border-collapse:collapse;width:100%}th{font-size:8pt;text-transform:uppercase;color:#8a857a;text-align:left;border-bottom:1px solid #ddd7ca;padding:5pt}td{border-bottom:1px solid #eee9df;padding:6pt 5pt;vertical-align:top}</style></head>
    <body><h1>Отчёт о сверке</h1><div class="meta">${esc(c.a.name)} ↔ ${esc(c.b.name)} · ${new Date().toLocaleString('ru-RU')} · совпадение ${c.result.similarity}%</div>
    <table><tr><th>№</th><th>Расхождение</th><th>Описание</th><th>Проверено</th></tr>${rows || '<tr><td colspan=4>Расхождений нет</td></tr>'}</table></body></html>`;
}

// ============================================================ dictionaries & bases (mockup 09)
async function renderDict() {
  try { S.basesInfo = await window.api.engine('basesInfo'); } catch (e) { S.basesInfo = null; }
  const info = S.basesInfo || { modules: [], version: '—' };
  const words = S.store.userWords || [];
  const q = (S.dictQuery || '').trim().toLowerCase();
  const list = words.filter(w => !q || w.toLowerCase().includes(q));
  const mods = info.modules || [];
  const pillFor = m => m.status === 'builtin' || m.status === 'on' ? ['g', 'Встроен'] : m.status === 'license' ? ['y', 'Нужна лицензия'] : m.status === 'link' ? ['n', 'Ссылкой'] : m.status === 'missing' ? ['y', 'Не подключено'] : ['g', m.statusTitle || 'Встроен'];
  const modOn = m => S.store.modules[m.id] !== false;
  const toggleable = m => m.toggle !== false && (m.status === 'builtin' || m.status === 'on');
  const upd = S.basesUpd;
  const updBox = upd && upd.newer ? `<div class="notice" style="margin:0 0 14px;align-items:center">${ic('download', 16, '#a9790c')}<div style="flex:1"><b>Доступны базы ${esc(upd.remote)}</b>${upd.date ? ` от ${new Date(upd.date).toLocaleDateString('ru-RU')}` : ''} · ${upd.changedFiles} ${plural(upd.changedFiles, ['файл', 'файла', 'файлов'])}, ${(upd.bytes / 1048576).toFixed(1).replace('.', ',')} МБ${upd.compatible ? '' : ' · нужна новая версия приложения'}
      ${S.basesProgress ? `<div class="bar" style="width:100%;margin-top:8px"><i style="width:${Math.round(S.basesProgress.done / S.basesProgress.total * 100)}%"></i></div>` : ''}</div>
      ${upd.compatible && !S.basesProgress ? `<button class="btn sm pri" data-act="bases-update">${ic('refresh', 13)}Обновить</button>` : ''}</div>` : '';
  const totalMb = mods.reduce((s, m) => s + (m.bytes || 0), 0) / 1048576;
  $('#main').innerHTML = `<div class="toolbar"><div class="docname"><b>Словари и базы</b><small>${totalMb ? `${Math.round(totalMb)} МБ на диске · ` : ''}всё работает без интернета · версия баз ${esc(info.version || '—')}</small></div><span class="sp1"></span>
      <button class="btn ghost" data-act="rules-browser">${ic('book', 14)}Справочник правил</button><button class="btn" data-act="dict-import">${ic('upload', 14)}Импорт словаря…</button><button class="btn pri" data-act="bases-check">${ic(S.basesChecking ? 'spinner' : 'refresh', 14)}${S.basesChecking ? 'Проверяю…' : 'Проверить обновления'}</button></div>
    <div class="work"><div style="flex:1;padding:20px 28px;overflow:auto">${updBox}
      <div class="card-box" style="padding:4px 8px;border-radius:12px"><table><tr><th>База</th><th>Версия</th><th>Статус</th><th>Вкл.</th></tr>
      ${mods.map(m => {
        if (/nkr|corpus|ruscorp/i.test(m.id)) {
          const on = S.nkrya && S.nkrya.connected;
          return `<tr><td><b>Национальный корпус русского языка (НКРЯ)</b><small>${on ? 'Частотность и примеры употребления во вкладке «Корпус» карточки слова · через API ruscorpora.ru' : 'Частотность и примеры употребления · нужен личный токен НКРЯ и интернет'}</small></td><td style="color:var(--muted2)">API v1</td>
            <td><span class="pill ${on ? 'g' : 'y'}">${on ? 'Подключён' : 'Нужен токен'}</span></td><td><button class="btn sm${on ? ' ghost' : ''}" data-act="nkrya-connect">${on ? 'Настроить' : 'Подключить'}</button></td></tr>`;
        }
        const [pc, pt] = pillFor(m); return `<tr><td><b>${esc(m.title)}</b><small>${esc(m.detail || '')}</small></td><td style="color:var(--muted2)">${esc(m.version || '—')}</td><td><span class="pill ${pc}">${esc(pt)}</span></td>
        <td><div class="tog${toggleable(m) ? (modOn(m) ? ' on' : '') : (m.status === 'link' || m.status === 'builtin' || m.status === 'on') ? ' on disabled' : ' disabled'}" data-module="${esc(m.id)}"></div></td></tr>`; }).join('')}</table></div>
      <div style="margin-top:14px;font-size:12.5px;color:#7d786d;line-height:1.5;display:flex;gap:8px">${ic('info', 15)}<span>Обновления баз приходят с GitHub отдельно от приложения — без отправки ваших текстов. Защищённые словари не скачиваются с сайтов: подключаются только по лицензии.</span></div></div>
      <div class="panel"><div class="ph"><h3>Мой словарь <small>${words.length} ${plural(words.length, ['слово', 'слова', 'слов'])}</small></h3>
        <div style="font-size:12px;color:#7d786d;margin-top:6px;line-height:1.45">Имена, термины, названия — их приложение не будет считать ошибками.</div>
        <div class="mydict" style="display:flex;gap:8px;margin-top:12px;position:relative"><span style="position:absolute;left:11px;top:10px;color:var(--muted4)">${ic('search', 14)}</span><input id="dictInput" placeholder="Найти или добавить слово" value="${esc(S.dictQuery || '')}"></div>
        ${q && !words.some(w => w.toLowerCase() === q) ? `<button class="btn sm" data-act="dict-add" style="margin-top:8px">${ic('plus', 13)}Добавить «${esc(S.dictQuery.trim())}»</button>` : ''}</div>
        <div class="list" style="gap:0;padding:4px 18px">${list.map(w => `<div class="wordrow"><span>${esc(w)}</span><span class="sp1"></span><button data-delword="${esc(w)}" title="Удалить">${ic('x', 13)}</button></div>`).join('') || `<div class="empty">${q ? 'Не найдено — нажмите Enter, чтобы добавить.' : 'Пока пусто. Добавляйте слова из карточки ошибки или здесь.'}</div>`}</div>
        <div class="pf"><button class="btn sm" data-act="dict-export">Экспорт .dic</button><button class="btn sm" data-act="dict-import">Импорт списка</button><span class="sp1"></span><button class="btn sm ghost" data-act="dict-shared" title="${esc(S.store.sharedDictPath || 'Общий файл словаря в облачной папке')}">${S.store.sharedDictPath ? ic('check', 13) : ''}Общий словарь редакции</button></div></div></div>
    <div class="status"><span>${mods.length} ${plural(mods.length, ['база', 'базы', 'баз'])} · ${mods.filter(m => toggleable(m) && modOn(m)).length} включено</span><span class="r">Последняя проверка обновлений: ${S.store.lastBasesCheck ? new Date(S.store.lastBasesCheck).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'ещё не было'}</span></div>`;
  const inp = $('#dictInput');
  inp.oninput = () => { S.dictQuery = inp.value; const pos = inp.selectionStart; renderDict().then(() => { const i2 = $('#dictInput'); i2.focus(); i2.setSelectionRange(pos, pos); }); };
  inp.onkeydown = e => { if (e.key === 'Enter' && inp.value.trim()) dictAdd(); };
}
async function dictAdd() {
  const w = (S.dictQuery || '').trim();
  if (!w) return;
  S.dictQuery = '';
  await addUserWordQuiet(w);
  renderDict();
}
async function addUserWordQuiet(w) {
  const words = [...new Set([...(S.store.userWords || []), w])].sort((a, b) => a.localeCompare(b, 'ru'));
  S.store = await window.api.store.set({ userWords: words });
}
async function basesCheck() {
  S.basesChecking = true; renderDict();
  try {
    S.basesUpd = await window.api.basesCheck();
    S.store = await window.api.store.get();
    if (!S.basesUpd.newer) toast(`У вас последние базы (${esc(S.basesUpd.current)})`);
  } catch (e) { fail(e, 'Не удалось проверить обновления баз: '); }
  S.basesChecking = false;
  renderDict(); renderSide();
}
async function basesUpdate() {
  S.basesProgress = { done: 0, total: 1 };
  renderDict();
  try {
    const r = await window.api.basesUpdate();
    S.basesProgress = null;
    S.basesUpd = null;
    S.info = await window.api.info();
    toast(`Базы обновлены до ${esc(r.version)}`);
    if (S.doc) runCheck();
  } catch (e) { S.basesProgress = null; fail(e); }
  renderDict(); renderSide();
}

// ============================================================ rules reference (Правила 1956, therules.ru)
function ruleHtml(p) {
  return p.parts.map(x => x.t === 'ex' ? `<div style="font-family:'PT Serif',serif;font-style:italic;font-size:14px;color:var(--ink2);padding:2px 0 2px 12px;border-left:2px solid var(--line)">${esc(x.text)}</div>`
    : x.t === 'item' ? `<div style="padding-left:12px">• ${esc(x.text)}</div>` : `<div style="font-size:13.5px;line-height:1.55;margin-top:6px">${esc(x.text)}</div>`).join('');
}
async function openRule(n) {
  let p;
  try { p = await window.api.engine('rule', +n); } catch (e) { return fail(e); }
  if (!p) return toast(`Параграф § ${n} не найден в базе правил`, { error: true });
  modal(`<div class="mh"><div class="label">${esc(p.group || '')}${p.subgroup ? ' · ' + esc(p.subgroup) : ''}</div><h2 style="margin-top:6px">§ ${p.n}. ${esc(p.section)}</h2></div>
    <div class="mb" style="max-height:56vh;overflow:auto;user-select:text;gap:6px">${ruleHtml(p)}</div>
    <div class="mf"><span style="font-size:11.5px;color:var(--muted3);margin-right:auto;align-self:center">Правила орфографии и пунктуации, 1956</span><button class="btn ghost" data-act="ext">${ic('ext', 14)}therules.ru</button><button class="btn pri" data-act="close">Понятно</button></div>`, (ov, close) => {
    ov.querySelector('.modal').style.width = '640px';
    ov.querySelector('[data-act=close]').onclick = close;
    ov.querySelector('[data-act=ext]').onclick = () => window.api.openExternal(p.url);
  });
}
function openRulesBrowser() {
  modal(`<div class="mh"><h2>Справочник правил</h2><p>Правила русской орфографии и пунктуации (1956) и пособие по пунктуации — по ним работает проверка. Поиск по тексту правил и примерам.</p></div>
    <div class="mb"><input type="text" id="ruleQ" placeholder="Например: однородные члены, -тся, вводные слова, тире"><div id="ruleRes" style="max-height:48vh;overflow:auto;display:flex;flex-direction:column;gap:2px"></div></div>
    <div class="mf"><button class="btn" data-act="close">Закрыть</button></div>`, (ov, close) => {
    ov.querySelector('.modal').style.width = '680px';
    ov.querySelector('[data-act=close]').onclick = close;
    const q = ov.querySelector('#ruleQ'), res = ov.querySelector('#ruleRes');
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      const list = q.value.trim() ? await window.api.engine('searchRules', q.value.trim(), 30) : [];
      if (my !== seq) return;
      res.innerHTML = list.map(r => `<div class="nav" ${r.n == null ? `data-manual-id="${esc(r.id)}"` : `data-rule-n="${r.n}"`} style="white-space:normal;align-items:flex-start;flex-direction:column;gap:2px"><b style="font-size:13px">${r.n == null ? `<span class="pill n" style="padding:1px 6px;font-size:10.5px;margin-right:4px">Пособие</span>` : `§ ${r.n}. `}${esc(r.section)}</b><span style="font-size:12px;color:var(--muted2);line-height:1.45">${esc(r.snippet || '')}</span></div>`).join('')
        || (q.value.trim() ? '<div class="empty">Ничего не найдено</div>' : '');
    };
    q.oninput = run;
    res.onclick = e => { const it = e.target.closest('[data-rule-n],[data-manual-id]'); if (!it) return; close(); if (it.dataset.manualId) openManualRule(it.dataset.manualId); else openRule(it.dataset.ruleN); };
  });
}

// ============================================================ НКРЯ: подключение токена
function openNkryaModal() {
  const st0 = S.nkrya || {};
  modal(`<div class="mh"><h2>Национальный корпус русского языка</h2><p>Корпус подключается по официальному API: приложение спрашивает частотность слова и примеры употребления, когда вы открываете вкладку «Корпус» в карточке слова. Ваши тексты в корпус не отправляются — только отдельные слова.</p></div>
    <div class="mb">
      <div style="font-size:13px;line-height:1.55">1. Войдите на <a data-act="nk-site" style="color:var(--navy);font-weight:600;cursor:pointer">ruscorpora.ru</a> (регистрация бесплатная).<br>2. В личном кабинете на вкладке «API» создайте токен — можно сделать его бессрочным.<br>3. Вставьте токен сюда.</div>
      <input type="text" id="nkToken" placeholder="${st0.connected ? 'Токен сохранён — вставьте новый, чтобы заменить' : 'Токен НКРЯ'}" autocomplete="off" spellcheck="false">
      <div id="nkMsg" style="font-size:12.5px;min-height:18px;color:var(--muted2)">${st0.connected ? `${ic('check', 12, 'var(--green)', 3)} Подключено${st0.checkedAt ? ' · проверено ' + new Date(st0.checkedAt).toLocaleDateString('ru-RU') : ''}. Токен хранится в зашифрованном виде.` : ''}</div>
    </div>
    <div class="mf">${st0.connected ? '<button class="btn ghost" data-act="nk-off" style="margin-right:auto">Отключить</button>' : ''}<button class="btn" data-act="nk-cancel">Закрыть</button><button class="btn pri" data-act="nk-go">${ic('check', 14, 'currentColor', 2.5)}Проверить и подключить</button></div>`, (ov, close) => {
    const msg = ov.querySelector('#nkMsg');
    ov.querySelector('[data-act=nk-site]').onclick = () => window.api.openExternal('https://ruscorpora.ru/accounts/profile/for-devs');
    ov.querySelector('[data-act=nk-cancel]').onclick = close;
    const off = ov.querySelector('[data-act=nk-off]');
    if (off) off.onclick = async () => { S.nkrya = await window.api.nkryaDisconnect(); close(); toast('НКРЯ отключён'); if (S.screen === 'dict') renderDict(); };
    const go = async () => {
      const t = ov.querySelector('#nkToken').value.trim();
      if (!t) { msg.textContent = 'Вставьте токен.'; return; }
      msg.innerHTML = `${ic('spinner', 12)} Проверяю токен…`;
      try {
        S.nkrya = await window.api.nkryaConnect(t);
        close(); toast('Национальный корпус подключён');
        if (S.screen === 'dict') renderDict();
      } catch (e) { msg.style.color = 'var(--red-ink)'; msg.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    };
    ov.querySelector('[data-act=nk-go]').onclick = go;
    ov.querySelector('#nkToken').onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}

async function openManualRule(id) {
  let r;
  try { r = await window.api.engine('manualRule', id); } catch (e) { return fail(e); }
  if (!r) return toast('Правило не найдено в базе', { error: true });
  const exs = (r.examples || []).map(x => `<div style="font-family:'PT Serif',serif;font-style:italic;font-size:14px;color:var(--ink2);padding:2px 0 2px 12px;border-left:2px solid var(--line)">${esc(typeof x === 'string' ? x : x.text || '')}</div>`).join('');
  const refs = (r.ref1956 || []).map(n => `<a data-ref="${n}" style="color:var(--navy);font-weight:600;cursor:pointer">§ ${n}</a>`).join(', ');
  modal(`<div class="mh"><div class="label">Пособие по пунктуации</div><h2 style="margin-top:6px">${esc(r.section || r.title || '')}</h2></div>
    <div class="mb" style="max-height:56vh;overflow:auto;user-select:text;gap:8px"><div style="font-size:13.5px;line-height:1.55">${esc(r.rule || r.text || '')}</div>${exs}
      ${refs ? `<div style="font-size:12.5px;color:var(--muted2)">Правила 1956: ${refs}</div>` : ''}</div>
    <div class="mf"><span style="font-size:11.5px;color:var(--muted3);margin-right:auto;align-self:center;max-width:300px">Пересказ «Вычитки» по пособию Е. П. Чечулиной «Пунктуация. Таблицы» (2020)</span><button class="btn ghost" data-act="pdf">${ic('ext', 14)}Пособие (PDF)</button><button class="btn pri" data-act="close">Понятно</button></div>`, (ov, close) => {
    ov.querySelector('.modal').style.width = '640px';
    ov.querySelector('[data-act=close]').onclick = close;
    ov.querySelector('[data-act=pdf]').onclick = () => window.api.openExternal(r.url);
    ov.querySelectorAll('[data-ref]').forEach(a => { a.onclick = () => { close(); openRule(a.dataset.ref); }; });
  });
}
