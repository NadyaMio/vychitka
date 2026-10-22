'use strict';
/* global S, $, show, openFile, startCheck, startPasteFromClipboard, updateStartState, renderModes, runCheck, renderPaper, renderPanel, renderStatus, renderToolbar, renderSide, renderTitle,
   activateIssue, acceptActive, rejectActive, moveActive, st, lst, issueByKey, visibleIssues, litVisible, applyIssues, addUserWord, ignoreKey, refreshDoc, closePop, openSaveModal, undo, redo,
   setSettings, selectProfile, saveProfileDialog, settings, cmpPick, runCompare, renderCompare, renderCompareBody, cmpShow, compareReportHtml, renderDict, dictAdd, basesCheck, basesUpdate, toast, fail, esc, modal, ic, setCaret, hasFix, textOf, Model */

// Sidebar items react on press, not on release: a re-render can never swallow them, and one press = one action.
document.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const t = e.target.closest('#side [data-nav], #side [data-recent]');
  if (!t) return;
  e.preventDefault();
  navigate(t.dataset.nav, t.dataset.recent);
});
function navigate(nav, recent) {
  closePop();
  if (recent) return openFile(recent);
  if (nav === 'proof' || nav === 'lit') {
    if (!S.doc) return show('start');
    const wasLit = S.mode === 'lit';
    show('doc', nav);
    if (nav === 'lit' && !S.lit) runCheck();
    else if (wasLit !== (nav === 'lit')) renderPaper(false);
    return;
  }
  return show(nav);
}

document.addEventListener('click', async e => {
  if (e.target.closest('#side [data-nav], #side [data-recent]')) return; // handled on pointerdown
  const t = e.target.closest('[data-nav],[data-recent],[data-act],[data-mode],[data-startmode],[data-filter],[data-key],[data-litkey],[data-check],[data-profile],[data-delprofile],[data-cmpmode],[data-cmpfilter],[data-diff],[data-module],[data-delword]');
  if (popEl && !e.target.closest('.pop') && !e.target.closest('.m')) closePop();
  if (!t) return;
  const d = t.dataset;

  if (d.nav || d.recent) return navigate(d.nav, d.recent);
  if (d.startmode) { S.startMode = d.startmode; return renderModes(); }
  if (d.mode && t.closest('.seg')) {
    S.mode = d.mode; closePop();
    renderSide(); renderToolbar(); renderPaper(false); renderPanel(); renderStatus();
    if (S.mode === 'lit' && !S.lit) runCheck();
    return;
  }
  if (d.filter) { S.filter = d.filter; return renderPanel(); }
  if (d.cmpmode) { if (t.disabled) return; S.cmp.mode = d.cmpmode; S.cmp.active = null; return renderCompare(); }
  if (d.cmpfilter) { S.cmp.filter = d.cmpfilter; return renderCompareBody(); }
  if (d.profile && !e.target.closest('[data-delprofile]')) return selectProfile(d.profile);
  if (d.delprofile) {
    const profiles = S.store.profiles.filter(p => p.id !== d.delprofile);
    S.store = await window.api.store.set({ profiles, profileId: S.store.profileId === d.delprofile ? 'editorial' : S.store.profileId });
    return show('settings');
  }
  if (d.check) return setSettings({}, { checks: { [d.check]: !settings().checks[d.check] } });
  if (d.module) {
    const mods = { ...S.store.modules, [d.module]: S.store.modules[d.module] === false };
    S.store = await window.api.store.set({ modules: mods });
    const id = d.module;
    const map = { spelling: 'spelling', punctuation: 'punctuation', grammar: 'grammar', typography: 'typography', repeats: 'repeats' };
    const key = Object.keys(map).find(k => id.includes(k.slice(0, 5)));
    if (key) await setSettings({}, { checks: { [map[key]]: mods[id] !== false } });
    if (/kanc|style|literary/.test(id)) await setSettings({ literaryEnabled: mods[id] !== false });
    return renderDict();
  }
  if (d.delword) {
    S.store = await window.api.store.set({ userWords: S.store.userWords.filter(w => w !== d.delword) });
    if (S.doc) runCheck();
    return renderDict();
  }
  if (d.diff && !d.act) {
    S.cmp.active = d.diff;
    renderCompareBody();
    return cmpShow();
  }

  // cards in the proof panel
  if (d.key || t.closest('[data-key]')) {
    const card = t.closest('[data-key]');
    const i = issueByKey(card.dataset.key);
    if (!i) return;
    const act = e.target.closest('[data-act]');
    const a = act && act.dataset.act;
    if (a === 'open-rule') return openRule(act.dataset.rule);
    if (a === 'open-manual') return openManualRule(act.dataset.manual);
    if (a === 'toggle') { st(i).selected = !st(i).selected; renderPanel(); renderStatus(); if (S.mode === 'diff') renderPaper(false); return; }
    if (a === 'accept') { S.activeKey = i.key; return acceptActive(); }
    if (a === 'reject') { S.activeKey = i.key; return rejectActive(); }
    if (a === 'use-alt') return applyIssues([{ ...i, chosen: act.dataset.alt }]);
    if (a === 'add-word') return addUserWord(i.before);
    if (a === 'ignore') { S.ignored.add(ignoreKey(i)); toast(`Такие правки («${esc(i.before)}») больше не показываются в этом документе`); return refreshDoc(); }
    if (i.key !== S.activeKey) activateIssue(i.key);
    return;
  }
  if (d.litkey || t.closest('[data-litkey]')) {
    const card = t.closest('[data-litkey]');
    const i = S.lit.issues.find(x => x.key === card.dataset.litkey);
    if (!i) return;
    const act = e.target.closest('[data-act]');
    const a = act && act.dataset.act;
    const s = lst(i);
    const alts = [...(i.after !== i.before ? [{ text: i.after }] : []), ...(i.alternatives || []).filter(x => x.text !== i.after)];
    if (a === 'lit-toggle') { s.selected = !s.selected; return renderPanel(); }
    if (a === 'lit-alt') { s.alt = +act.dataset.alt; s.selected = true; return renderPanel(); }
    if (a === 'lit-accept') { const ch = alts[s.alt] || alts[0]; if (ch) applyIssues([{ ...i, chosen: ch.text }]); return; }
    if (a === 'lit-reject') { s.rejected = true; refreshDoc(); return; }
    if (a === 'lit-manual') {
      const paper = $('#paper'); paper.focus(); setCaret(i.para, i.end);
      const m = paper.querySelector(`.m[data-k="${CSS.escape(i.key)}"]`); if (m) m.scrollIntoView({ block: 'center' });
      return;
    }
    if (i.key !== S.litActive) activateIssue(i.key);
    return;
  }

  const a = d.act;
  switch (a) {
    case 'open': return openFile();
    case 'start-paste': return startPasteFromClipboard();
    case 'start-clear': { $('#pasteArea').innerHTML = ''; S.startHadFormatting = false; S.startFromClipboard = false; updateStartState(); $('#pasteArea').focus(); return; }
    case 'start-check': return startCheck();
    case 'recheck': S.notice = null; S.stale = []; return runCheck();
    case 'save': return S.doc && openSaveModal({ applySelected: false });
    case 'apply-selected': return openSaveModal({ applySelected: true });
    case 'reject-selected': { for (const i of visibleIssues()) if (st(i).selected && i.after !== i.before) st(i).rejected = true; return refreshDoc(); }
    case 'toggle-all': {
      const list = visibleIssues().filter(i => (S.filter === 'all' || i.category === S.filter) && i.after !== i.before);
      const all = list.every(i => st(i).selected);
      for (const i of list) st(i).selected = !all;
      renderPanel(); renderStatus(); if (S.mode === 'diff') renderPaper(false);
      return;
    }
    case 'undo': return undo();
    case 'find': findOpen = true; return renderToolbar();
    case 'find-close': findOpen = false; if (CSS.highlights) CSS.highlights.delete('find'); return renderToolbar();
    case 'lit-apply': {
      const list = litVisible().filter(i => lst(i).selected && hasFix(i)).map(i => {
        const alts = [...(i.after !== i.before ? [{ text: i.after }] : []), ...(i.alternatives || []).filter(x => x.text !== i.after)];
        return { ...i, chosen: (alts[lst(i).alt] || alts[0]).text };
      });
      return applyIssues(list);
    }
    case 'lit-reject-all': { for (const i of litVisible()) lst(i).rejected = true; return refreshDoc(); }
    case 'save-profile': return saveProfileDialog();
    case 'run-check': return S.doc ? (show('doc', S.mode === 'diff' ? 'proof' : S.mode), runCheck()) : show('start');
    case 'toggle-quotes': return setSettings({ skipQuotes: !settings().skipQuotes });
    case 'toggle-lit': return setSettings({ literary: !settings().literary });
    case 'cmp-pick': return cmpPick(d.side);
    case 'cmp-show': return cmpShow();
    case 'cmp-check': { const id = S.cmp.active; if (S.cmp.checked.has(id)) S.cmp.checked.delete(id); else S.cmp.checked.add(id); return renderCompareBody(); }
    case 'cmp-report': try { const p = await window.api.saveReport({ html: compareReportHtml(), suggestedName: 'Отчёт о сверке.pdf' }); if (p) toast('Отчёт о сверке сохранён', { action: 'Показать в папке', onAction: () => window.api.reveal(p) }); } catch (er) { fail(er); } return;
    case 'dict-add': return dictAdd();
    case 'dict-import': { const words = await window.api.dictImport(); if (!words) return; const before = (S.store.userWords || []).length; const all = [...new Set([...(S.store.userWords || []), ...words])].sort((x, y) => x.localeCompare(y, 'ru')); S.store = await window.api.store.set({ userWords: all }); toast(`Добавлено слов: ${all.length - before}`); if (S.doc) runCheck(); return renderDict(); }
    case 'dict-export': { const p = await window.api.dictExport(S.store.userWords || []); if (p) toast('Словарь сохранён', { action: 'Показать в папке', onAction: () => window.api.reveal(p) }); return; }
    case 'dict-shared': { const r = await window.api.dictSharedPick(); if (r) { S.store = await window.api.store.get(); toast(`Общий словарь подключён: ${r.words} слов`); if (S.doc) runCheck(); renderDict(); } return; }
    case 'open-rule': return openRule(d.rule);
    case 'rules-browser': return openRulesBrowser();
    case 'nkrya-connect': return openNkryaModal();
    case 'bases-check': return basesCheck();
    case 'bases-update': return basesUpdate();
    case 'app-update': try { await window.api.appUpdateInstall(); } catch (er) { fail(er, 'Обновление не установилось: '); } return;
  }
});


// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const inEditable = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (popEl && /^[1-3]$/.test(e.key) && !inEditable) { e.preventDefault(); return popEl.pickN(+e.key - 1); }
  if (e.key === 'Escape') { closePop(); return; }
  if (inEditable || S.screen !== 'doc' || S.mode === 'diff' && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (S.mode === 'lit') { const b = document.querySelector('.card.on [data-act=lit-accept]'); if (b) b.click(); } else acceptActive();
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (S.mode === 'lit') { const b = document.querySelector('.card.on [data-act=lit-reject]'); if (b) b.click(); } else rejectActive();
  } else if (e.key === ' ') {
    e.preventDefault();
    const i = issueByKey(S.activeKey); if (i && i.after !== i.before) { st(i).selected = !st(i).selected; renderPanel(); }
  }
});

// ---------- drag & drop files anywhere ----------
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  const p = window.api.pathForFile(f);
  if (S.screen === 'compare') {
    window.api.openPath(p, false).then(payload => {
      const m = payload.html != null ? Model.fromHtml(payload.html) : Model.fromText(payload.text || '');
      const side = S.cmp.a ? 'b' : 'a';
      S.cmp[side] = { name: payload.name, path: payload.path, ext: payload.ext, label: payload.ext === 'pdf' ? 'PDF, текстовый слой' : payload.ext.toUpperCase(), doc: { paragraphs: m.paragraphs } };
      renderCompare(); runCompare();
    }).catch(err => fail(err));
    return;
  }
  openFile(p);
});

// ---------- menu ----------
window.api.onMenu(id => {
  switch (id) {
    case 'new': return show('start');
    case 'open': return S.screen === 'compare' ? cmpPick(S.cmp.a ? 'b' : 'a') : openFile();
    case 'save': return S.doc && openSaveModal({ applySelected: false });
    case 'undo': return undo();
    case 'redo': return redo();
    case 'find': if (S.screen === 'doc') { findOpen = true; renderToolbar(); } return;
    case 'check': if (S.screen === 'start') return startCheck(); if (S.doc) { if (S.screen !== 'doc') show('doc', 'proof'); return runCheck(); } return;
    case 'apply-selected': if (S.screen === 'doc' && visibleIssues().some(i => st(i).selected)) openSaveModal({ applySelected: true }); return;
    case 'mode-proof': case 'mode-lit': case 'mode-diff': {
      if (!S.doc) return;
      const m = id.slice(5);
      show('doc', m);
      if (m === 'lit' && !S.lit) runCheck();
      return;
    }
    case 'compare': return show('compare');
    case 'check-app-update': return checkAppUpdate(true);
  }
});
window.api.onOpenPath(p => openFile(p));
window.api.onBasesProgress(p => { S.basesProgress = p.phase === 'done' ? null : p; if (S.screen === 'dict') renderDict(); });
window.api.onAppUpdate(s => {
  const prev = S.appUpd;
  S.appUpd = s;
  renderSide();
  if (S.manualUpdateCheck) {
    if (s.status === 'latest') { toast(`Установлена последняя версия ${esc(S.info.version)}`); S.manualUpdateCheck = false; }
    if (s.status === 'dev') { toast(esc(s.message)); S.manualUpdateCheck = false; }
    if (s.status === 'error') { toast('Не удалось проверить обновления: ' + esc(s.message), { error: true }); S.manualUpdateCheck = false; }
    if (s.status === 'available') S.manualUpdateCheck = false;
  }
  if (s.status === 'ready' && (!prev || prev.status !== 'ready') && S.win) toast('Обновление загружено', { action: 'Перезапустить', onAction: () => window.api.appUpdateInstall() });
});
async function checkAppUpdate(manual) {
  S.manualUpdateCheck = manual;
  try { await window.api.appUpdateCheck(); } catch (e) { if (manual) fail(e, 'Не удалось проверить обновления: '); }
}
window.api.onBeforeClose(() => {
  if (!S.dirty) return window.api.closeConfirmed();
  modal(`<div class="mh"><h2>Сохранить изменения?</h2><p>В документе «${esc(S.doc ? S.doc.name : '')}» есть несохранённые правки.</p></div>
    <div class="mf"><button class="btn ghost" data-act="discard" style="margin-right:auto">Не сохранять</button><button class="btn" data-act="cancel">Отмена</button><button class="btn pri" data-act="save">Сохранить…</button></div>`, (ov, close) => {
    ov.querySelector('[data-act=discard]').onclick = () => window.api.closeConfirmed();
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.querySelector('[data-act=save]').onclick = () => { close(); openSaveModal({ applySelected: false }); };
  });
});

// ---------- start ----------
(async function init() {
  S.info = await window.api.info();
  S.store = await window.api.store.get();
  S.win = S.info.platform === 'win32';
  S.nkrya = await window.api.nkryaStatus();
  S.mod = S.win ? 'Ctrl+' : '⌘';
  document.getElementById('app').classList.add(S.win ? 'win' : 'mac');
  show('start');
  // dictionary bases: quiet weekly check, the result shows up in the sidebar
  const last = S.store.lastBasesCheck ? Date.parse(S.store.lastBasesCheck) : 0;
  if (S.info.packaged && Date.now() - last > 7 * 864e5) window.api.basesCheck().then(r => { S.basesUpd = r; renderSide(); }).catch(() => {});
})();
