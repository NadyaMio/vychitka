// End-to-end run through every screen of the real app (Electron + Playwright).
// Produces screenshots in test/e2e/out/ named after the Figma mockups, and checks the key behaviours.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const FIX = path.join(__dirname, 'fixtures');
const PROOF_TEXT = fs.readFileSync(path.join(FIX, 'proof.txt'), 'utf8');
const LIT_TEXT = fs.readFileSync(path.join(FIX, 'literary.txt'), 'utf8');

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vychitka-e2e-'));
  const env = { ...process.env, VYCHITKA_NO_UPDATE_CHECK: '1', VYCHITKA_E2E_DIR: tmp, VYCHITKA_USER_DATA: path.join(tmp, 'userData'),
    VYCHITKA_E2E_OPEN: [path.join(FIX, 'verstka.txt'), path.join(FIX, 'proof.docx')].join(',') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], env });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(String(e)));
  win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize({ width: 1440, height: 900 });
  const shot = n => win.screenshot({ path: path.join(OUT, `${n}.png`) });
  const setClipboard = (text, html) => app.evaluate(({ clipboard, ClipboardItem }, [t, h]) => clipboard.write([new ClipboardItem(h ? { 'text/plain': t, 'text/html': h } : { 'text/plain': t })]), [text, html]);
  const paperText = () => win.$eval('#paper', el => el.innerText.replace(/ /g, ' '));

  await step('01 старт: пустое поле вставки', async () => {
    await win.waitForSelector('#pasteArea');
    await shot('01-start');
  });

  await step('01а вставка из буфера с форматированием', async () => {
    const html = PROOF_TEXT.trim().split('\n\n').map(p => `<p>${p.replace('Покровке', '<b>Покровке</b>')}</p>`).join('');
    await setClipboard(PROOF_TEXT, html);
    await win.click('[data-act=start-paste]');
    await win.waitForSelector('.paste.filled');
    const pill = await win.$('text=Жирный, курсив и ссылки сохранены');
    assert(pill, 'нет отметки о сохранённом форматировании');
    const foot = await win.$eval('#pasteFt', el => el.innerText);
    assert(/5 абзацев/.test(foot), `абзацы склеились при вставке: ${foot}`);
    assert(await win.$('#pasteArea b'), 'жирный не сохранился');
    await shot('01a-pasted');
  });

  await step('02 настройки проверки', async () => {
    await win.click('[data-nav=settings]');
    await win.waitForSelector('text=Что проверять');
    await shot('02-settings');
    await win.click('[data-nav=start]');
    await win.waitForSelector('#pasteArea');
    await setClipboard(PROOF_TEXT);
    await win.click('[data-act=start-paste]');
  });

  await step('03 корректура: список правок', async () => {
    await win.click('[data-act=start-check]');
    await win.waitForSelector('#panel .card', { timeout: 20000 });
    const cards = await win.$$eval('#panel .card .fix', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    const need = ['чтобы', 'допоздна', 'высказаться', 'ответственных', 'Несмотря', 'решили, что', 'течение', '«референсы»'];
    for (const n of need) assert(cards.some(c => c.includes(n)), `нет правки «${n}». Карточки: ${cards.join(' | ')}`);
    await win.click('#panel .card >> nth=3');
    await shot('03-proof');
  });

  await step('04 карточка слова', async () => {
    await win.click('#paper .m.sp >> text=ответственых');
    await win.waitForSelector('.pop', { timeout: 10000 });
    await win.waitForTimeout(300);
    await shot('04-word');
    await win.keyboard.press('Escape');
  });

  await step('принять одну правку меняет текст', async () => {
    const card = await win.$('#panel .card:has(.fix:has-text("высказатся"))');
    await card.click();
    await win.click('#panel .card.on [data-act=accept]');
    await win.waitForFunction(() => document.querySelector('#paper').innerText.includes('высказаться'), null, { timeout: 15000 });
  });

  await step('05 до/после и применение с сохранением DOCX', async () => {
    await win.click('.seg [data-mode=diff]');
    await win.waitForSelector('#paper .ins');
    await win.click('[data-act=apply-selected]');
    await win.waitForSelector('.modal');
    await shot('05-apply');
    await win.click('.modal [data-act=go]');
    await win.waitForSelector('.toast >> text=Сохранено', { timeout: 20000 });
    const docx = fs.readdirSync(tmp).find(f => f.endsWith('.docx'));
    assert(docx, 'файл .docx не сохранён');
    const JSZip = require('jszip');
    const xml = await (await JSZip.loadAsync(fs.readFileSync(path.join(tmp, docx)))).file('word/document.xml').async('string');
    assert(/<w:ins\b/.test(xml) && /<w:del\b/.test(xml), 'в DOCX нет режима правок (w:ins / w:del)');
    assert(fs.readdirSync(tmp).some(f => f.endsWith('.pdf')), 'отчёт корректора PDF не сохранён');
  });

  await step('06 правка прямо в окне', async () => {
    await win.click('.seg [data-mode=proof]');
    await win.waitForSelector('#paper[contenteditable=true]');
    // put the caret after «ответственных» (or the uncorrected form) and type
    await win.evaluate(() => {
      const p = [...document.querySelectorAll('#paper p')].find(x => /ответствен/.test(x.textContent));
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n, last = null;
      while ((n = walker.nextNode())) { const i = n.data.indexOf('ответствен'); if (i >= 0) { last = n; break; } }
      const r = document.createRange(); const idx = last.data.indexOf('ответствен') + last.data.slice(last.data.indexOf('ответствен')).search(/[.\s]/);
      r.setStart(last, idx); r.collapse(true);
      document.querySelector('#paper').focus();
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await win.keyboard.type(' и поставить сроки', { delay: 25 });
    await win.waitForTimeout(150);
    await shot('06-editing-typing');
    await win.waitForSelector('.notice', { timeout: 15000 });
    assert((await paperText()).includes('и поставить сроки'), 'введённый текст пропал после перепроверки');
    await shot('06-edited');
  });

  await step('отмена ⌘Z возвращает текст', async () => {
    await win.click('[data-act=undo]');
    await win.waitForFunction(() => !document.querySelector('#paper').innerText.includes('поставить сроки'), null, { timeout: 10000 });
  });

  await step('07 сверка версий (после корректуры)', async () => {
    await win.click('[data-nav=compare]');
    await win.waitForSelector('[data-act=cmp-pick][data-side=b]');
    await win.click('[data-act=cmp-pick][data-side=b] >> nth=0');
    await win.waitForSelector('#cmpPanel [data-diff]', { timeout: 20000 });
    const types = await win.$$eval('#cmpPanel [data-diff] .pill', els => els.map(e => e.textContent));
    for (const t of ['Потерян абзац', 'Правка не внесена', 'Слетел пробел', 'Изменилось слово']) assert(types.includes(t), `нет расхождения «${t}»: ${types.join(', ')}`);
    await shot('07-compare');
  });

  await step('08 литературная правка', async () => {
    await win.click('[data-nav=start]');
    await win.waitForSelector('#pasteArea');
    await setClipboard(LIT_TEXT);
    await win.click('[data-startmode=lit]');
    await win.click('[data-act=start-paste]');
    await win.click('[data-act=start-check]');
    await win.waitForSelector('#panel [data-litkey]', { timeout: 20000 });
    await win.waitForTimeout(200);
    await shot('08-literary');
    const txt = await win.$eval('#panel', el => el.innerText);
    assert(/Ясность текста/.test(txt), 'нет оценки ясности');
  });

  await step('09 словари и базы, справочник правил', async () => {
    await win.click('[data-nav=dict]');
    await win.waitForSelector('text=Мой словарь');
    await win.fill('#dictInput', 'Покровка');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.wordrow >> text=Покровка');
    await shot('09-dict');
    await win.click('[data-act=rules-browser]');
    await win.fill('#ruleQ', 'однородные');
    await win.waitForSelector('[data-rule-n]', { timeout: 10000 });
    await shot('09-rules');
    await win.keyboard.press('Escape');
  });

  await step('открытие DOCX', async () => {
    await win.click('[data-nav=start]');
    await win.click('[data-startmode=proof]');
    await win.click('#drop [data-act=open]');
    await win.waitForSelector('#panel .card', { timeout: 20000 });
  });

  await step('нет ошибок в консоли', async () => { assert.deepStrictEqual(errors, []); });

  await app.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ platform: process.platform, results }, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} шагов прошли`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
