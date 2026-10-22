// Национальный корпус русского языка (ruscorpora.ru) через официальный публичный API.
// Данные корпуса не копируются в приложение: по запросу пользователя берутся частотность слова и примеры
// употребления. Нужен личный токен из кабинета НКРЯ (https://ruscorpora.ru/accounts/profile/for-devs);
// он хранится зашифрованным средствами ОС (safeStorage), ответы кешируются на диске на 30 дней.
const fs = require('fs');
const path = require('path');

const API = process.env.VYCHITKA_NKRYA_API || 'https://ruscorpora.ru/api/v1';
const CACHE_DAYS = 30;
const FREQ_TITLES = {
  1: 'очень редкое слово', 2: 'редкое слово', 3: 'частотность скорее низкая',
  4: 'частотность скорее высокая', 5: 'распространённое слово', 6: 'очень распространённое слово',
};

class NkryaError extends Error {}

// Concordance → [{ text, hits: [[start, end]], title }]. Tokens come without guaranteed spacing,
// so words are joined with spaces except before closing punctuation and after opening punctuation.
function parseExamples(data, limit = 3) {
  const out = [];
  for (const g of (data && data.groups) || []) {
    for (const doc of g.docs || []) {
      for (const sg of doc.snippetGroups || []) {
        for (const sn of sg.snippets || []) {
          let text = '';
          const hits = [];
          for (const seq of sn.sequences || []) {
            for (const w of seq.words || []) {
              const t = String(w.text == null ? '' : w.text);
              if (!t) continue;
              const glueLeft = /^[,.;:!?…)\]»”]/.test(t) || /^\s/.test(t) || !text || /[(\[«„“\s]$/.test(text);
              if (!glueLeft) text += ' ';
              const s = text.length;
              text += t;
              if (w.displayParams && w.displayParams.hit) hits.push([s, text.length]);
            }
          }
          text = text.replace(/\s+/g, ' ').trim();
          if (text) out.push({ text, hits, title: (doc.info && doc.info.title || '').replace(/\s*\(source\/[^)]*\)/, '') });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

class Nkrya {
  constructor({ store, safeStorage, cacheFile }) {
    Object.assign(this, { store, safeStorage, cacheFile });
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* no cache yet */ }
  }

  _token() {
    const v = this.store.get().nkrya;
    if (!v || !v.token) return null;
    try {
      return v.encrypted ? this.safeStorage.decryptString(Buffer.from(v.token, 'base64')) : v.token;
    } catch { return null; }
  }

  status() {
    const v = this.store.get().nkrya || {};
    return { connected: !!this._token(), checkedAt: v.checkedAt || null, user: v.user || null };
  }

  async _get(route, token, params) {
    const url = `${API}${route}${params ? '?' + new URLSearchParams(params) : ''}`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Vychitka' }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new NkryaError('Нет связи с НКРЯ. Проверьте интернет — остальная проверка работает без него.');
    }
    if (res.status === 401 || res.status === 403) throw new NkryaError('НКРЯ не принял токен. Создайте новый в личном кабинете ruscorpora.ru и подключите снова.');
    if (res.status === 429) throw new NkryaError('НКРЯ просит подождать: слишком много запросов. Попробуйте через минуту.');
    if (!res.ok) throw new NkryaError(`НКРЯ ответил ошибкой ${res.status}.`);
    return res.json();
  }

  async connect(token) {
    const t = String(token || '').trim();
    if (!t) throw new NkryaError('Вставьте токен из личного кабинета НКРЯ.');
    await this._get('/auth/check-authenticated/', t);
    let me = null;
    try { me = await this._get('/auth/me/', t); } catch { /* the name is only cosmetic */ }
    const enc = this.safeStorage && this.safeStorage.isEncryptionAvailable();
    this.store.set({ nkrya: {
      token: enc ? this.safeStorage.encryptString(t).toString('base64') : t,
      encrypted: !!enc, checkedAt: new Date().toISOString(),
      user: me && (me.username || me.email || me.name) || null,
    } });
    return this.status();
  }

  disconnect() { this.store.set({ nkrya: null }); return this.status(); }

  // Frequency and usage examples for a dictionary form (lemma).
  async portrait(lemma) {
    const key = String(lemma || '').toLowerCase().replace(/ё/g, 'е').trim();
    if (!key) return null;
    const hit = this.cache[key];
    if (hit && Date.now() - hit.at < CACHE_DAYS * 864e5) return hit.data;
    const token = this._token();
    if (!token) throw new NkryaError('НКРЯ не подключён: добавьте токен на экране «Словари и базы».');
    const query = { lemma: String(lemma).trim(), corpus: { type: 'MAIN' }, resultType: ['PORTRAIT_FREQUENCY', 'PORTRAIT_CONCORDANCE'], seed: 20261021 };
    const json = await this._get('/word-portrait/', token, { query: JSON.stringify(query) });
    const f = json.frequencyData || null;
    const data = {
      lemma: String(lemma).trim(),
      pos: json.possiblePos || [],
      frequency: f ? { ipm: f.ipm, category: f.category, title: FREQ_TITLES[f.category] || '' } : null,
      examples: parseExamples(json.concordanceData),
      url: `https://ruscorpora.ru/word/main?req=${encodeURIComponent(String(lemma).trim())}`,
    };
    this.cache[key] = { at: Date.now(), data };
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    } catch { /* cache is optional */ }
    return data;
  }
}

module.exports = { Nkrya, NkryaError, parseExamples, FREQ_TITLES };
