// Runs the proofreading engine in a worker thread so long documents never freeze the window.
const { Worker } = require('worker_threads');
const path = require('path');

class EngineHost {
  constructor(getInitArgs) {
    this.getInitArgs = getInitArgs; // () => ({ basesDir, userWords })
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
  }

  start() {
    const workerPath = path.join(__dirname, '..', 'engine', 'worker.js');
    this.worker = new Worker(workerPath);
    this.worker.on('message', msg => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || String(msg.error)), { engineStack: msg.error.stack }));
      else p.resolve(msg.result);
    });
    this.worker.on('error', err => {
      console.error('engine worker crashed:', err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
      this.ready = null;
    });
    this.ready = this._send('init', [this.getInitArgs()]);
    return this.ready;
  }

  _send(method, args) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  async call(method, args = []) {
    if (!this.worker) this.start();
    await this.ready;
    return this._send(method, args);
  }

  // After a bases update: re-init with the new directory (no app restart needed).
  async reload() {
    if (!this.worker) return this.start();
    this.ready = this._send('init', [this.getInitArgs()]);
    return this.ready;
  }
}

module.exports = { EngineHost };
