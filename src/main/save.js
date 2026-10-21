// Writing results: DOCX (clean or with Word tracked changes), plain text, backups, and the proofreader's PDF report.
const fs = require('fs');
const path = require('path');

// paragraphs: [{ kind: 'h'|'p', segments: [{ type: 'eq'|'ins'|'del', text, b, i, href }] }]
async function buildDocx(paragraphs, { track }) {
  const d = require('docx');
  const date = new Date().toISOString();
  let rev = 1;
  const runsFor = seg => {
    const style = { bold: !!seg.b, italics: !!seg.i };
    const pieces = seg.text.split('\n');
    const out = [];
    pieces.forEach((piece, idx) => {
      const common = { ...style, text: piece, break: idx > 0 ? 1 : undefined };
      if (seg.type === 'ins' && track) out.push(new d.InsertedTextRun({ ...common, id: rev++, author: 'Вычитка', date }));
      else if (seg.type === 'del' && track) out.push(new d.DeletedTextRun({ ...common, id: rev++, author: 'Вычитка', date }));
      else if (seg.type === 'del') { /* clean copy: deletions vanish */ }
      else out.push(new d.TextRun(common));
    });
    if (seg.href && seg.type !== 'del') return [new d.ExternalHyperlink({ link: seg.href, children: out })];
    return out;
  };
  const children = paragraphs.map(p => new d.Paragraph({
    heading: p.kind === 'h' ? d.HeadingLevel.HEADING_1 : undefined,
    children: p.segments.flatMap(runsFor),
  }));
  const doc = new d.Document({
    creator: 'Вычитка',
    features: track ? { trackRevisions: true } : undefined,
    styles: { default: { document: { run: { font: 'PT Serif', size: 24 } } } },
    sections: [{ children }],
  });
  return d.Packer.toBuffer(doc);
}

function toPlainText(paragraphs) {
  return paragraphs.map(p => p.segments.filter(s => s.type !== 'del').map(s => s.text).join('')).join('\n\n') + '\n';
}

function backupFile(file, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const ext = path.extname(file);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(backupRoot, `${path.basename(file, ext)} ${stamp}${ext}`);
  fs.copyFileSync(file, dest);
  return dest;
}

async function writeResult({ paragraphs, mode, target, backupRoot, sourcePath }) {
  const ext = path.extname(target).slice(1).toLowerCase();
  let backup = null;
  if (mode === 'overwrite' && sourcePath && fs.existsSync(sourcePath)) backup = backupFile(sourcePath, backupRoot);
  if (ext === 'docx') {
    const buf = await buildDocx(paragraphs, { track: mode === 'track' });
    fs.writeFileSync(target, buf);
  } else {
    fs.writeFileSync(target, toPlainText(paragraphs), 'utf8');
  }
  return { path: target, backup };
}

// Renders an HTML string to PDF in a hidden window (same engine the app uses, fonts embedded via CSS).
async function htmlToPdf(BrowserWindow, html, target) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const tmp = path.join(require('os').tmpdir(), `vychitka-report-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(target, pdf);
    fs.rmSync(tmp, { force: true });
    return target;
  } finally {
    win.destroy();
  }
}

module.exports = { buildDocx, toPlainText, writeResult, htmlToPdf, backupFile };
