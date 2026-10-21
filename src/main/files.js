// Reading documents of every supported format into a neutral payload for the renderer:
// { name, path, ext, html } for formats with inline formatting, or { ..., text } for plain ones.
const fs = require('fs');
const path = require('path');

const SUPPORTED = ['docx', 'rtf', 'odt', 'txt', 'md', 'pdf'];

function decodeText(buf) {
  // UTF-8 with BOM / UTF-16 LE BOM / fallback cp1251 when the bytes are not valid UTF-8
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1251').decode(buf);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal Markdown → HTML: headings, bold, italic, links. Enough to keep the text's look.
function markdownToHtml(md) {
  const blocks = md.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks.map(b => {
    const h = b.match(/^(#{1,6})\s+(.*)$/s);
    const inline = s => escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
    if (h) return `<h1>${inline(h[2].trim())}</h1>`;
    return b.trim() ? `<p>${inline(b.trim().replace(/\n/g, ' '))}</p>` : '';
  }).join('');
}

function plainToHtml(text) {
  const t = text.replace(/\r\n?/g, '\n');
  const parts = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  // a hyphen at a line end is a word break from layout — keep the break visible for the comparison
  return parts.map(p => p.trim()).filter(Boolean).map(p => `<p>${escapeHtml(p).replace(/-\n/g, '-<br>').replace(/\n/g, ' ')}</p>`).join('');
}

// RTF: strip control groups and words, decode \'hh (cp1251 by default) and \uN escapes.
function rtfToText(rtf) {
  let cp = 'windows-1251';
  const m = rtf.match(/\\ansicpg(\d+)/);
  if (m) cp = m[1] === '1252' ? 'windows-1252' : m[1] === '65001' ? 'utf-8' : `windows-${m[1]}`;
  let s = rtf.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*(?=[{\\])/g, '');
  const bytes = [];
  let out = '';
  const flush = () => { if (bytes.length) { out += new TextDecoder(cp).decode(Uint8Array.from(bytes)); bytes.length = 0; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next === "'") { bytes.push(parseInt(s.substr(i + 2, 2), 16)); i += 3; continue; }
      flush();
      if (next === '\\' || next === '{' || next === '}') { out += next; i++; continue; }
      const w = s.slice(i + 1).match(/^([a-zA-Z]+)(-?\d+)? ?/);
      if (w) {
        const word = w[1];
        if (word === 'par' || word === 'line') out += '\n';
        else if (word === 'tab') out += '\t';
        else if (word === 'u') { let n = parseInt(w[2], 10); if (n < 0) n += 65536; out += String.fromCharCode(n); i += w[0].length; if (s[i + 1] === '?') i++; continue; }
        i += w[0].length;
        continue;
      }
      i++;
      continue;
    }
    flush();
    if (c === '{' || c === '}' || c === '\r' || c === '\n') continue;
    out += c;
  }
  flush();
  return out.replace(/\n{3,}/g, '\n\n');
}

async function odtToHtml(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('content.xml').async('string');
  const out = [];
  const re = /<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>|<text:(h|p)\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    const inner = m[2]
      .replace(/<text:s\s+text:c="(\d+)"\s*\/>/g, (_, n) => ' '.repeat(+n))
      .replace(/<text:s\s*\/>/g, ' ')
      .replace(/<text:tab\s*\/>/g, '\t')
      .replace(/<text:line-break\s*\/>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    if (!inner.trim()) continue;
    out.push(m[1] === 'h' ? `<h1>${escapeHtml(inner)}</h1>` : `<p>${escapeHtml(inner)}</p>`);
  }
  return out.join('');
}

// PDF: text layer only. Lines are grouped by y; a vertical gap larger than the usual line step starts a paragraph.
// A trailing hyphen at a line end is kept together with the line break ("дизайн-\nер") so the comparison can see it.
async function pdfToText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const paragraphs = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      let line = lines.find(l => Math.abs(l.y - y) < 2);
      if (!line) { line = { y, parts: [] }; lines.push(line); }
      line.parts.push({ x: it.transform[4], s: it.str });
    }
    lines.sort((a, b) => b.y - a.y);
    const steps = [];
    for (let i = 1; i < lines.length; i++) steps.push(lines[i - 1].y - lines[i].y);
    const step = steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 14;
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].parts.sort((a, b) => a.x - b.x).map(x => x.s).join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const gap = i ? lines[i - 1].y - lines[i].y : 0;
      if (!cur || gap > step * 1.45) { cur = { text }; paragraphs.push(cur); }
      else cur.text += cur.text.endsWith('-') ? '\n' + text : ' ' + text;
    }
  }
  return paragraphs.map(p => p.text).join('\n\n');
}

async function readDocument(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file);
  const base = { name, path: file, ext };
  if (!SUPPORTED.includes(ext)) throw new Error(`Формат .${ext} не поддерживается. Подходят: ${SUPPORTED.map(e => e.toUpperCase()).join(', ')}.`);
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const res = await mammoth.convertToHtml({ path: file });
    return { ...base, html: res.value };
  }
  if (ext === 'odt') return { ...base, html: await odtToHtml(file) };
  if (ext === 'md') return { ...base, html: markdownToHtml(decodeText(fs.readFileSync(file))) };
  if (ext === 'txt') return { ...base, html: plainToHtml(decodeText(fs.readFileSync(file))) };
  if (ext === 'rtf') return { ...base, html: plainToHtml(rtfToText(fs.readFileSync(file, 'latin1'))) };
  if (ext === 'pdf') {
    const text = await pdfToText(file);
    if (!text.trim()) throw new Error('В PDF нет текстового слоя (это скан). Распознайте текст и откройте файл снова.');
    return { ...base, text };
  }
}

module.exports = { readDocument, SUPPORTED, rtfToText, markdownToHtml, plainToHtml, decodeText };
