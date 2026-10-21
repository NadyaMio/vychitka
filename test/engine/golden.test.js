'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ready, doc, describe, engine } = require('./helpers');

const NBSP = ' ';

const SOURCE = [
  'Вчера вечером мы собрались в небольшом кафе на Покровке что бы обсудить план нового проекта. Как и ожидалось, разговор затянулся до поздна: каждый хотел высказатся, но мало кто слушал других.',
  'В конце концов Анна предложила простое решение - разбить задачу на этапы и назначить ответственых. Не смотря на усталость все согласились.',
  'Мы решили что первый этап займёт две недели. В течении этого времени нужно собрать "референсы" и подготовить черновик - без него двигаться дальше бессмысленно.',
  'Отдельно обсудили бюджет. Анна считает что на первый этап хватит 150000 рублей, если не заказывать внешний дизайн.',
];

const FIXED = [
  'Вчера вечером мы собрались в небольшом кафе на Покровке, чтобы обсудить план нового проекта. Как и ожидалось, разговор затянулся допоздна: каждый хотел высказаться, но мало кто слушал других.',
  `В конце концов Анна предложила простое решение${NBSP}— разбить задачу на этапы и назначить ответственных. Несмотря на усталость, все согласились.`,
  `Мы решили, что первый этап займёт две недели. В течение этого времени нужно собрать «референсы» и подготовить черновик${NBSP}— без него двигаться дальше бессмысленно.`,
  `Отдельно обсудили бюджет. Анна считает, что на первый этап хватит 150${NBSP}000 рублей, если не заказывать внешний дизайн.`,
];

const LITERARY = [
  'В рамках данного проекта командой было принято решение осуществить проведение серии встреч с читателями. Данные встречи являются важным инструментом, который позволяет нам получать обратную связь, а также позволяет нам лучше понимать потребности читателей, их интересы и ожидания, что в свою очередь является ключевым фактором для дальнейшего развития проекта.',
  'На каждой встрече мы рассказываем о новых книгах и осуществляем сбор вопросов. Вопросы мы потом разбираем в канале, и это, безусловно, очень помогает.',
  'Иногда встречи затягиваются, потому что вопросов много, а времени мало, и модератору приходится выбирать, на какие вопросы отвечать сразу, а какие отложить до следующего раза, что не всем нравится, хотя другого способа пока никто не предложил.',
];

/** Required corrector issues: [para, category, test(issue)]. */
const REQUIRED = [
  ['P1 punct Покровке, что', 0, (is) => is.category === 'punctuation' && is.before.startsWith('Покровке') && is.after.startsWith('Покровке,')],
  ['P1 spelling что бы → чтобы', 0, (is) => is.category === 'spelling' && is.before === 'что бы' && is.after === 'чтобы'],
  ['P1 spelling до поздна → допоздна', 0, (is) => is.category === 'spelling' && is.before === 'до поздна' && is.after === 'допоздна'],
  ['P1 spelling высказатся → высказаться (sure)', 0, (is) => is.category === 'spelling' && is.before === 'высказатся' && is.after === 'высказаться' && is.confidence === 'sure'],
  ['P2 typography - → —', 1, (is) => is.category === 'typography' && is.before.trim() === '-' && is.after.includes('—')],
  ['P2 spelling ответственых → ответственных (sure, alternatives)', 1, (is) => is.category === 'spelling' && is.before === 'ответственых' && is.after === 'ответственных' && is.confidence === 'sure'
    && is.alternatives.some((a) => a.text === 'ответственным') && is.alternatives.some((a) => a.text === 'ответственные')],
  ['P2 spelling Не смотря → Несмотря', 1, (is) => is.category === 'spelling' && is.before.startsWith('Не смотря') && is.after.startsWith('Несмотря')],
  ['P2 punctuation усталость, все (check)', 1, (is) => is.category === 'punctuation' && is.before === 'усталость все' && is.after === 'усталость, все' && is.confidence === 'check'],
  ['P3 punctuation решили, что (sure)', 2, (is) => is.category === 'punctuation' && is.before === 'решили что' && is.after === 'решили, что' && is.confidence === 'sure'],
  ['P3 grammar В течении → В течение', 2, (is) => is.category === 'grammar' && is.before === 'В течении' && is.after === 'В течение'],
  ['P3 typography "референсы" → «референсы»', 2, (is) => is.category === 'typography' && is.before === '"референсы"' && is.after === '«референсы»'],
  ['P3 typography - → —', 2, (is) => is.category === 'typography' && is.before.trim() === '-' && is.after.includes('—')],
  ['P4 punctuation считает, что', 3, (is) => is.category === 'punctuation' && is.before === 'считает что' && is.after === 'считает, что'],
  ['P4 typography 150000 → 150 000', 3, (is) => is.category === 'typography' && is.before === '150000' && is.after === `150${NBSP}000`],
];

test('golden: corrector finds every required issue and at most 2 extra', async () => {
  await ready();
  const { issues, stats } = engine.check(doc(SOURCE));
  const listing = describe(issues);
  for (const [name, para, pred] of REQUIRED) {
    const hit = issues.find((is) => is.para === para && pred(is));
    assert.ok(hit, `missing: ${name}\n${listing}`);
  }
  assert.ok(issues.length <= REQUIRED.length + 2, `too many issues (${issues.length}):\n${listing}`);
  assert.equal(stats.paragraphs, 4);
  assert.ok(stats.words > 80);
  // referenсы is not an error
  assert.ok(!issues.some((is) => is.before === 'референсы'), 'референсы must not be flagged');
  // issues do not overlap and are sorted
  for (let i = 1; i < issues.length; i++) {
    const a = issues[i - 1];
    const b = issues[i];
    assert.ok(a.para < b.para || (a.para === b.para && a.end <= b.start), `overlap: ${a.id} / ${b.id}`);
  }
  // stable ids and before === text.slice
  for (const is of issues) {
    assert.equal(is.id, `${is.ruleId}:${is.para}:${is.start}`);
    assert.equal(SOURCE[is.para].slice(is.start, is.end), is.before);
    assert.ok(['sure', 'check'].includes(is.confidence));
    assert.ok(is.why && is.why.length > 10, `why missing for ${is.id}`);
    assert.ok(is.source, `source missing for ${is.id}`);
  }
});

test('golden: applying all fixes reproduces the reference text', async () => {
  await ready();
  const { issues } = engine.check(doc(SOURCE));
  const fixed = engine.applyIssues(doc(SOURCE), issues);
  assert.deepEqual(fixed.paragraphs.map((p) => p.text), FIXED);
  // the reference text itself is clean
  const again = engine.check(doc(FIXED));
  assert.equal(again.issues.length, 0, describe(again.issues));
});

test('golden: refs point to existing paragraphs of the 1956 rules; «решили, что» → § 140', async () => {
  await ready();
  const { issues } = engine.check(doc(SOURCE));
  for (const is of issues) {
    assert.ok(Array.isArray(is.ref), `ref must be an array in ${is.id}`);
    for (const n of is.ref) assert.ok(engine.rule(n), `ref § ${n} does not exist (${is.id})`);
    if (is.ref.length) assert.match(is.source, /^Правила 1956 · § \d+/, `source format for ${is.id}: ${is.source}`);
  }
  const comma = issues.find((is) => is.before === 'решили что');
  assert.ok(comma);
  assert.deepEqual(comma.ref, [140]);
  assert.equal(comma.source, 'Правила 1956 · § 140 · Главное и придаточное предложения');
  const chtoby = issues.find((is) => is.before === 'что бы');
  assert.ok(chtoby.ref.includes(85));
  const nn = issues.find((is) => is.before === 'ответственых');
  assert.ok(nn.ref.includes(61));
  const tsya = issues.find((is) => is.before === 'высказатся');
  assert.ok(tsya.ref.includes(73));
  const intro = issues.find((is) => is.before === 'усталость все');
  assert.deepEqual(intro.ref, [153]);
  const typo = issues.find((is) => is.before === '150000');
  assert.deepEqual(typo.ref, []);
  const lit = engine.literary(doc(LITERARY));
  for (const is of lit.issues) for (const n of is.ref) assert.ok(engine.rule(n), `literary ref § ${n} missing`);
});

test('golden: literary editing', async () => {
  await ready();
  const res = engine.literary(doc(LITERARY));
  const listing = describe(res.issues);
  const has = (name, pred) => assert.ok(res.issues.some(pred), `missing: ${name}\n${listing}`);
  has('в рамках данного проекта (kanc)', (is) => is.metric === 'kanc' && /^в рамках данного проекта$/i.test(is.before));
  has('командой было принято решение … с альтернативами', (is) => is.before.startsWith('командой было принято решение осуществить проведение')
    && /^мы решили провести/.test(is.after) && is.alternatives.some((a) => /^команда решила провести/.test(a.text)));
  has('Данные встречи являются (kanc, check)', (is) => is.metric === 'kanc' && is.confidence === 'check' && is.before.startsWith('являются важным инструментом') && is.after.startsWith('— важный инструмент'));
  has('Данные → Эти', (is) => is.before === 'Данные' && is.after === 'Эти');
  has('позволяет нам повтор', (is) => is.category === 'repeat' && is.before === 'позволяет нам');
  has('что в свою очередь является ключевым фактором → что важно', (is) => is.before === 'что в свою очередь является ключевым фактором' && is.after === 'что важно');
  has('осуществляем сбор → собираем', (is) => is.before.startsWith('осуществляем сбор') && is.after.startsWith('собираем'));
  has('безусловно (усилитель)', (is) => is.metric === 'intens' && /безусловно/.test(is.before) && is.after === '');
  has('очень (усилитель)', (is) => is.metric === 'intens' && /^очень\s*$/.test(is.before) && is.after === '');
  has('третий абзац — длинное предложение', (is) => is.para === 2 && is.ruleId === 'style.long');
  assert.ok(res.score >= 4 && res.score <= 7, `score ${res.score} not in 4..7`);
  assert.ok(res.scoreAfter >= res.score, `scoreAfter ${res.scoreAfter} < score ${res.score}`);
  const ids = res.metrics.map((m) => m.id);
  assert.deepEqual(ids, ['kanc', 'long', 'repeat', 'passive', 'intens']);
  for (const m of res.metrics) assert.equal(typeof m.count, 'number');
  assert.ok(res.metrics.find((m) => m.id === 'kanc').count >= 5);
  assert.ok(res.metrics.find((m) => m.id === 'intens').count >= 2);
  assert.ok(res.metrics.find((m) => m.id === 'long').count >= 1);
  for (const is of res.issues) assert.ok(['style', 'repeat'].includes(is.category));
});

test('golden: compare', async () => {
  await ready();
  const A = doc(FIXED);
  const bParas = FIXED.slice();
  bParas.splice(2, 1);
  bParas[1] = bParas[1].replace('ответственных', 'ответственых');
  bParas[2] = bParas[2].replace(`150${NBSP}000`, '150000').replace('дизайн', 'дизайн-\nер');
  const B = doc(bParas);
  const res = engine.compare(A, B, { appliedFixes: [{ before: 'ответственых', after: 'ответственных' }] });
  const types = res.diffs.map((d) => d.type);
  const lost = res.diffs.find((d) => d.type === 'lost');
  assert.ok(lost, `lost missing: ${JSON.stringify(res.diffs)}`);
  assert.equal(lost.aPara, 2);
  assert.equal(lost.bPara, null);
  assert.equal(lost.title, 'Потерян абзац');
  const notApplied = res.diffs.find((d) => d.type === 'notApplied');
  assert.ok(notApplied, `notApplied missing: ${JSON.stringify(res.diffs)}`);
  assert.equal(notApplied.aPara, 1);
  assert.equal(notApplied.bPara, 1);
  assert.equal(bParas[1].slice(notApplied.bRange[0], notApplied.bRange[1]), 'ответственых');
  const space = res.diffs.find((d) => d.type === 'space');
  assert.ok(space, `space missing: ${JSON.stringify(res.diffs)}`);
  assert.equal(bParas[2].slice(space.bRange[0], space.bRange[1]), '150000');
  const changed = res.diffs.find((d) => d.type === 'changed');
  assert.ok(changed, `changed missing: ${JSON.stringify(res.diffs)}`);
  assert.ok(bParas[2].slice(changed.bRange[0], changed.bRange[1]).startsWith('дизайн-'));
  assert.equal(types.length, 4, JSON.stringify(res.diffs, null, 1));
  assert.ok(res.similarity > 60 && res.similarity < 100);
  assert.ok(res.words > 50);
  assert.deepEqual(res.pairs.filter((p) => p.b === null).map((p) => p.a), [2]);
  for (const d of res.diffs) assert.ok(d.id && d.text && d.title);
});
