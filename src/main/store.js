// Persistent JSON store in userData: settings, profiles, recent files, user dictionary.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  checks: { spelling: true, punctuation: true, grammar: true, typography: true, repeats: true },
  yo: 'meaning',
  quotes: 'elochki',
  dash: 'em',
  nbsp: 'prepositions-numbers',
  numbers: true,
  uncertain: 'mark',
  skipQuotes: true,
};

const BUILTIN_PROFILES = [
  { id: 'editorial', name: 'Редакционная норма', note: 'Строго по правилам, ё по смыслу, «ёлочки», длинное тире', builtin: true,
    settings: { ...DEFAULT_SETTINGS } },
  { id: 'fiction', name: 'Художественный текст', note: 'Не трогает авторскую пунктуацию в диалогах и прямой речи', builtin: true,
    settings: { ...DEFAULT_SETTINGS, skipQuotes: true, uncertain: 'skip', checks: { ...DEFAULT_SETTINGS.checks, repeats: false } } },
  { id: 'business', name: 'Деловой документ', note: 'Числа, даты, сокращения, единицы измерения по ГОСТ', builtin: true,
    settings: { ...DEFAULT_SETTINGS, yo: 'never' } },
  { id: 'typos', name: 'Только опечатки', note: 'Быстро: орфография и повторы слов, без пунктуации', builtin: true,
    settings: { ...DEFAULT_SETTINGS, checks: { spelling: true, punctuation: false, grammar: false, typography: false, repeats: true } } },
];

const DEFAULTS = {
  profileId: 'editorial',
  profiles: BUILTIN_PROFILES,
  settings: { ...DEFAULT_SETTINGS },
  settingsDirty: false,
  recent: [],
  userWords: [],
  sharedDictPath: null,
  modules: { kanc: true, dal: true, grammaticalRules: true },
  lastBasesCheck: null,
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'vychitka.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw };
      // builtin profiles always come from code, custom ones from disk
      const custom = (raw.profiles || []).filter(p => !p.builtin);
      this.data.profiles = [...BUILTIN_PROFILES, ...custom];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('store: cannot read, using defaults', e.message);
    }
  }
  get() { return this.data; }
  set(patch) {
    this.data = { ...this.data, ...patch };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.data;
  }
  addRecent(entry) {
    const recent = [entry, ...this.data.recent.filter(r => r.path !== entry.path)].slice(0, 8);
    return this.set({ recent });
  }
}

module.exports = { Store, DEFAULT_SETTINGS, BUILTIN_PROFILES };
