// Document model shared by every screen.
// doc.paragraphs = [{ kind: 'h'|'p', runs: [{ text, b?, i?, href? }] }]; positions are offsets in the paragraph's plain text.
'use strict';

const Model = (() => {
  const NBSP = ' ';
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const textOf = p => p.runs.map(r => r.text).join('');
  const sameStyle = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i && (a.href || null) === (b.href || null);

  function normalizeRuns(runs) {
    const out = [];
    for (const r of runs) {
      if (!r.text) continue;
      const last = out[out.length - 1];
      if (last && sameStyle(last, r)) last.text += r.text;
      else out.push({ text: r.text, ...(r.b ? { b: true } : {}), ...(r.i ? { i: true } : {}), ...(r.href ? { href: r.href } : {}) });
    }
    return out;
  }

  const clone = doc => JSON.parse(JSON.stringify(doc));

  // ---------- HTML / text → model ----------
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TR', 'PRE', 'SECTION', 'ARTICLE']);
  function fromHtml(html) {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    dom.querySelectorAll('script,style,meta,link,title,noscript').forEach(n => n.remove());
    const paragraphs = [];
    let cur = null;
    let hadFormatting = false;
    const flush = () => {
      if (cur) {
        cur.runs = normalizeRuns(cur.runs.map(r => ({ ...r, text: r.text.replace(/[ \t\r\n]+/g, ' ') })));
        if (cur.runs.length) {
          cur.runs[0].text = cur.runs[0].text.replace(/^ +/, '');
          const l = cur.runs[cur.runs.length - 1];
          l.text = l.text.replace(/ +$/, '');
          cur.runs = normalizeRuns(cur.runs);
        }
        if (cur.runs.length) paragraphs.push(cur);
      }
      cur = null;
    };
    const walk = (node, style) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          if (!c.data.trim() && !cur) continue;
          if (!cur) cur = { kind: 'p', runs: [] };
          cur.runs.push({ text: c.data, ...style });
          continue;
        }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName;
        if (tag === 'BR') { if (cur) cur.runs.push({ text: '\n', ...style }); continue; }
        const st = { ...style };
        const css = (c.getAttribute('style') || '').toLowerCase();
        if (tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(css)) st.b = true;
        if (tag === 'I' || tag === 'EM' || /font-style:\s*italic/.test(css)) st.i = true;
        if (tag === 'A' && c.getAttribute('href') && /^(https?:|mailto:)/.test(c.getAttribute('href'))) st.href = c.getAttribute('href');
        if (/font-weight:\s*(normal|[1-4]00)/.test(css)) delete st.b;
        if (st.b || st.i || st.href) hadFormatting = true;
        if (BLOCK.has(tag)) {
          flush();
          const kind = /^H[1-6]$/.test(tag) ? 'h' : 'p';
          if (tag === 'DIV' && c.querySelector(':scope > p, :scope > div, :scope > h1, :scope > h2, :scope > h3, :scope > ul, :scope > ol, :scope > table')) { walk(c, st); flush(); continue; }
          cur = { kind, runs: [] };
          walk(c, st);
          flush();
        } else {
          walk(c, st);
        }
      }
    };
    walk(dom.body, {});
    flush();
    // trailing "\n" from <br> at paragraph end is noise
    for (const p of paragraphs) { const l = p.runs[p.runs.length - 1]; l.text = l.text.replace(/\n+$/, ''); p.runs = normalizeRuns(p.runs); }
    return { paragraphs: paragraphs.filter(p => p.runs.length), hadFormatting };
  }

  function fromText(text) {
    const t = text.replace(/\r\n?/g, '\n');
    const parts = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
    return { paragraphs: parts.map(s => s.replace(/^\s+|\s+$/g, '')).filter(Boolean).map(s => ({ kind: 'p', runs: [{ text: s }] })), hadFormatting: false };
  }

  // A short first line without a final period reads as a title — show it as the document heading.
  function detectTitle(paragraphs) {
    if (paragraphs.length > 1 && paragraphs[0].kind === 'p') {
      const t = textOf(paragraphs[0]);
      if (t.length <= 90 && !/[.!?…:;,]$/.test(t) && !t.includes('\n')) paragraphs[0].kind = 'h';
    }
    return paragraphs;
  }

  // ---------- editing ----------
  function replaceRange(runs, start, end, text) {
    const total = runs.reduce((s, r) => s + r.text.length, 0);
    // the replacement takes the formatting of the replaced text (or of the character before an insertion point)
    const styleRun = slices(runs, start, Math.max(end, start + 1))[0] || slices(runs, Math.max(0, start - 1), start)[0] || {};
    return normalizeRuns([...slices(runs, 0, start), { ...pick(styleRun), text }, ...slices(runs, end, total)]);
  }
  const pick = r => ({ ...(r.b ? { b: true } : {}), ...(r.i ? { i: true } : {}), ...(r.href ? { href: r.href } : {}) });

  // fixes: [{ para, start, end, after }] — applied right-to-left inside each paragraph.
  function applyFixes(doc, fixes) {
    const next = clone(doc);
    const byPara = new Map();
    for (const f of fixes) { if (!byPara.has(f.para)) byPara.set(f.para, []); byPara.get(f.para).push(f); }
    for (const [pi, list] of byPara) {
      const p = next.paragraphs[pi];
      if (!p) continue;
      list.sort((a, b) => b.start - a.start);
      let lastStart = Infinity;
      for (const f of list) {
        if (f.end > lastStart) continue; // overlapping — skip the later one
        p.runs = replaceRange(p.runs, f.start, f.end, f.after);
        lastStart = f.start;
      }
    }
    return next;
  }

  // Styled slices of [start,end) for rendering/saving.
  function slices(runs, start, end) {
    const out = [];
    let pos = 0;
    for (const r of runs) {
      const rs = pos, re = pos + r.text.length;
      pos = re;
      const s = Math.max(start, rs), e = Math.min(end, re);
      if (e > s) out.push({ ...pick(r), text: r.text.slice(s - rs, e - rs) });
    }
    return out;
  }

  // ---------- rendering ----------
  function runHtml(r) {
    let h = esc(r.text).replace(/\n/g, '<br>');
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.href) h = `<a href="${esc(r.href)}" data-href="${esc(r.href)}">${h}</a>`;
    return h;
  }

  // marks: [{ start, end, cls, key }] sorted, non-overlapping. Zero-width marks are widened to show the spot.
  function paragraphHtml(p, marks = []) {
    const text = textOf(p);
    let html = '';
    let pos = 0;
    for (const m of marks) {
      if (m.start < pos) continue;
      if (m.start > pos) html += slices(p.runs, pos, m.start).map(runHtml).join('');
      const inner = m.end > m.start ? slices(p.runs, m.start, m.end).map(runHtml).join('') : '';
      html += `<span class="m ${m.cls}${m.sel ? ' sel' : ''}" data-k="${esc(m.key)}">${inner || '&#8203;'}</span>`;
      pos = Math.max(pos, m.end);
    }
    if (pos < text.length) html += slices(p.runs, pos, text.length).map(runHtml).join('');
    return html || '<br>';
  }

  // Read a paragraph element of the contenteditable editor back into runs.
  function runsFromElement(el) {
    const runs = [];
    const walk = (node, st) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { const t = c.data.replace(/​/g, ''); if (t) runs.push({ text: t, ...st }); continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') { if (c.nextSibling) runs.push({ text: '\n', ...st }); continue; }
        const s = { ...st };
        if (c.tagName === 'B' || c.tagName === 'STRONG') s.b = true;
        if (c.tagName === 'I' || c.tagName === 'EM') s.i = true;
        if (c.tagName === 'A' && c.dataset.href) s.href = c.dataset.href;
        walk(c, s);
      }
    };
    walk(el, {});
    return normalizeRuns(runs);
  }

  // ---------- diffs for "До / после" and Word tracked changes ----------
  // Segments for one paragraph given fixes: eq / del (before) / ins (after), with formatting.
  function fixSegments(p, fixes) {
    const segs = [];
    const text = textOf(p);
    let pos = 0;
    for (const f of [...fixes].sort((a, b) => a.start - b.start)) {
      if (f.start < pos) continue;
      for (const s of slices(p.runs, pos, f.start)) segs.push({ type: 'eq', ...s });
      for (const s of slices(p.runs, f.start, f.end)) segs.push({ type: 'del', ...s });
      if (f.after) segs.push({ type: 'ins', ...pick(slices(p.runs, f.start, Math.max(f.end, f.start + 1))[0] || {}), text: f.after });
      pos = f.end;
    }
    for (const s of slices(p.runs, pos, text.length)) segs.push({ type: 'eq', ...s });
    return segs;
  }

  // Word-level diff between an original and current paragraph (both with runs) → segments.
  function diffSegments(orig, cur) {
    const a = textOf(orig), b = textOf(cur);
    if (a === b) return slices(cur.runs, 0, b.length).map(s => ({ type: 'eq', ...s }));
    const parts = Diff.diffWordsWithSpace(a, b);
    const segs = [];
    let ia = 0, ib = 0;
    for (const part of parts) {
      const n = part.value.length;
      if (part.added) { for (const s of slices(cur.runs, ib, ib + n)) segs.push({ type: 'ins', ...s }); ib += n; }
      else if (part.removed) { for (const s of slices(orig.runs, ia, ia + n)) segs.push({ type: 'del', ...s }); ia += n; }
      else { for (const s of slices(cur.runs, ib, ib + n)) segs.push({ type: 'eq', ...s }); ia += n; ib += n; }
    }
    return segs;
  }

  // Align original and current documents paragraph-by-paragraph and produce tracked-change paragraphs.
  function trackedParagraphs(orig, cur) {
    const A = orig.paragraphs.map(textOf), B = cur.paragraphs.map(textOf);
    const out = [];
    if (A.length === B.length) {
      cur.paragraphs.forEach((p, i) => out.push({ kind: p.kind, segments: diffSegments(orig.paragraphs[i], p) }));
      return out;
    }
    const ops = Diff.diffArrays(A, B);
    let ia = 0, ib = 0;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      const next = ops[k + 1];
      if (op.removed && next && next.added) {
        // pair removed/added paragraphs by word overlap, keeping order; the rest are whole deletions/insertions
        const rem = orig.paragraphs.slice(ia, ia + op.count), add = cur.paragraphs.slice(ib, ib + next.count);
        let j = 0;
        for (let r = 0; r < rem.length; r++) {
          let match = -1;
          for (let q = j; q < add.length; q++) if (similar(textOf(rem[r]), textOf(add[q])) >= 0.4) { match = q; break; }
          if (match < 0) { out.push({ kind: rem[r].kind, segments: rem[r].runs.map(x => ({ type: 'del', ...x })) }); continue; }
          for (; j < match; j++) out.push({ kind: add[j].kind, segments: add[j].runs.map(x => ({ type: 'ins', ...x })) });
          out.push({ kind: add[match].kind, segments: diffSegments(rem[r], add[match]) });
          j = match + 1;
        }
        for (; j < add.length; j++) out.push({ kind: add[j].kind, segments: add[j].runs.map(x => ({ type: 'ins', ...x })) });
        ia += op.count; ib += next.count; k++;
      } else if (op.removed) {
        for (let j = 0; j < op.count; j++) out.push({ kind: orig.paragraphs[ia + j].kind, segments: orig.paragraphs[ia + j].runs.map(r => ({ type: 'del', ...r })) });
        ia += op.count;
      } else if (op.added) {
        for (let j = 0; j < op.count; j++) out.push({ kind: cur.paragraphs[ib + j].kind, segments: cur.paragraphs[ib + j].runs.map(r => ({ type: 'ins', ...r })) });
        ib += op.count;
      } else {
        for (let j = 0; j < op.count; j++) out.push({ kind: cur.paragraphs[ib + j].kind, segments: diffSegments(orig.paragraphs[ia + j], cur.paragraphs[ib + j]) });
        ia += op.count; ib += op.count;
      }
    }
    return out;
  }

  function similar(a, b) {
    const wa = new Set(a.toLowerCase().split(/[^а-яёa-z0-9]+/).filter(Boolean)), wb = new Set(b.toLowerCase().split(/[^а-яёa-z0-9]+/).filter(Boolean));
    if (!wa.size || !wb.size) return 0;
    let n = 0;
    for (const w of wa) if (wb.has(w)) n++;
    return n / Math.max(wa.size, wb.size);
  }

  function cleanParagraphs(doc) { return doc.paragraphs.map(p => ({ kind: p.kind, segments: p.runs.map(r => ({ type: 'eq', ...r })) })); }

  // Inserted ranges in `cur` relative to `base` (for highlighting manual edits).
  function insertedRanges(baseText, curText) {
    if (baseText === curText) return [];
    const out = [];
    let ib = 0;
    for (const part of Diff.diffWordsWithSpace(baseText, curText)) {
      if (part.added) { if (part.value.trim()) out.push({ start: ib, end: ib + part.value.length }); ib += part.value.length; }
      else if (!part.removed) ib += part.value.length;
    }
    return out;
  }

  function stats(doc) {
    const chars = doc.paragraphs.reduce((s, p) => s + textOf(p).length, 0);
    return { chars, paragraphs: doc.paragraphs.filter(p => p.kind === 'p').length };
  }

  return { NBSP, esc, textOf, normalizeRuns, clone, fromHtml, fromText, detectTitle, replaceRange, applyFixes, slices, paragraphHtml, runsFromElement, fixSegments, diffSegments, trackedParagraphs, cleanParagraphs, insertedRanges, stats };
})();
