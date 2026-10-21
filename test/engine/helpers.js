'use strict';

const path = require('node:path');
const engine = require('../../src/engine');

const BASES_DIR = path.resolve(__dirname, '..', '..', 'bases');
let initPromise = null;
let initMs = 0;

/** Initialise the engine once per test process; returns the engine. */
async function ready() {
  if (!initPromise) {
    const t = Date.now();
    initPromise = engine.init({ basesDir: BASES_DIR }).then(() => {
      initMs = Date.now() - t;
      return engine;
    });
  }
  return initPromise;
}

function doc(paragraphs) {
  return { paragraphs: paragraphs.map((text) => (typeof text === 'string' ? { text, kind: 'p' } : text)) };
}

/** Find an issue whose before/after satisfy the predicate(s). */
function find(issues, pred) {
  return issues.find(pred) || null;
}

function describe(issues) {
  return issues.map((is) => `P${is.para + 1} [${is.category}/${is.ruleId}/${is.confidence}] ${JSON.stringify(is.before)} -> ${JSON.stringify(is.after)}`).join('\n');
}

module.exports = { ready, doc, find, describe, BASES_DIR, engine, initMs: () => initMs };
