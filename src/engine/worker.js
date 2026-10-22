'use strict';

/**
 * worker_threads wrapper around the engine.
 *
 * Protocol: parent posts { id, method, args }, worker answers
 * { id, result } or { id, error: { name, message, stack } }.
 *
 * Example (main process):
 *   const w = new Worker(require.resolve('./engine/worker.js'));
 *   w.postMessage({ id: 1, method: 'init', args: [{ basesDir }] });
 */

const { parentPort, isMainThread } = require('node:worker_threads');
const engine = require('./index');

const METHODS = new Set([
  'init', 'setUserWords', 'basesInfo', 'check', 'literary', 'wordInfo', 'compare',
  'rule', 'searchRules', 'manualRule', 'explainSpan', 'applyNbsp', 'applyIssues', 'defaultSettings',
]);

function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

async function handle(msg) {
  const { id, method, args } = msg || {};
  if (!METHODS.has(method)) {
    return { id, error: { name: 'TypeError', message: `Unknown engine method: ${String(method)}` } };
  }
  try {
    const result = await engine[method](...(Array.isArray(args) ? args : []));
    return { id, result: result === undefined ? null : result };
  } catch (err) {
    return { id, error: serializeError(err) };
  }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    handle(msg).then((reply) => parentPort.postMessage(reply));
  });
}

module.exports = { handle, METHODS };
