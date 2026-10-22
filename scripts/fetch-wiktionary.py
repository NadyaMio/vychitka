#!/usr/bin/env python3
"""
Fetch Russian Wiktionary data for «Вычитка» and build bases/wiktionary/:

  idioms.json     устойчивые сочетания и фразеологизмы («ни свет ни заря», «как по маслу»)
  conj.json       русские союзы («потому что», «хотя», «ежели»)
  intro.json      русские вводные слова («к сожалению», «по-видимому»)
  particles.json  русские частицы (для справки, движок их пока не использует)
  meta.json       counts, categories, licence, retrieval date

Every item: {"t": title, "d": first meaning (≤200 chars, pometa included), "url": page url,
"type"/"role": from {{phrase|тип=…|роль=…}} or the morphology template, "c": category codes}.

Source — only ru.wiktionary.org through the MediaWiki API (CC BY-SA 4.0):
  Категория:Устойчивые сочетания/ru (≈10 565), Категория:Фразеологизмы/ru (≈4 820, subcategory),
  Категория:Русские союзы (177), Категория:Русские вводные слова (123), Категория:Русские частицы (246).

Usage
-----
  python3 scripts/fetch-wiktionary.py                 # download (resumable) + build
  python3 scripts/fetch-wiktionary.py --build         # rebuild from the cached download only
  python3 scripts/fetch-wiktionary.py --merge         # also merge conj/intro into bases/rules/*.json
  python3 scripts/fetch-wiktionary.py --sample 20     # print 20 random cleaned items per set
  python3 scripts/fetch-wiktionary.py --work .cache/wiktionary --out bases/wiktionary --pause 1.5

Politeness (same as fetch-dal.py): User-Agent, maxlag=5, ≥1 s between requests,
429/503/maxlag → Retry-After or exponential back-off 5→300 s, never gives up on its own.

Checkpoints (WORK dir, default .cache/wiktionary/): pages-<set>.jsonl (raw wikitext,
one page per line, appended after every completed batch) and checkpoint.json (continue
tokens per category). An interrupted run continues from the last completed batch.
"""

import argparse
import gzip
import html
import json
import os
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

API = "https://ru.wiktionary.org/w/api.php"
USER_AGENT = "Vychitka/0.3 (https://github.com/NadyaMio/vychitka)"
PAGE_URL = "https://ru.wiktionary.org/wiki/"
LICENSE = "CC BY-SA 4.0 (тексты русского Викисловаря, https://creativecommons.org/licenses/by-sa/4.0/)"
BATCH = 50          # pages per request (API limit when revision content is requested)
MIN_PAUSE = 1.0
BACKOFF_START = 5
BACKOFF_MAX = 300
TIMEOUT = 120
MAX_DEF = 200

# set id → (categories, category code per category)
SETS = [
    ("idioms", [("Устойчивые сочетания/ru", "u"), ("Фразеологизмы/ru", "f")]),
    ("conj", [("Русские союзы", "c")]),
    ("intro", [("Русские вводные слова", "i")]),
    ("particles", [("Русские частицы", "p")]),
]
CATEGORY_URL = "https://ru.wiktionary.org/wiki/Категория:"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_FILE = None


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, file=sys.stderr, flush=True)
    if LOG_FILE:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")


# ---------------------------------------------------------------- HTTP client


class Client:
    """MediaWiki API client: paced, patient, never raises on 429/503/maxlag."""

    def __init__(self, pause):
        self.pause = max(MIN_PAUSE, float(pause))
        self.last = 0.0
        self.requests = 0

    def _sleep_before(self):
        wait = self.pause - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)

    @staticmethod
    def _retry_after(headers, fallback):
        try:
            v = headers.get("Retry-After") if headers else None
            return max(1, min(BACKOFF_MAX, int(v))) if v else fallback
        except (TypeError, ValueError):
            return fallback

    def get(self, params):
        params = dict(params, format="json", formatversion="2", maxlag="5")
        url = API + "?" + urllib.parse.urlencode(params)
        backoff = BACKOFF_START
        attempt = 0
        while True:
            attempt += 1
            self._sleep_before()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    raw = resp.read()
                    headers = resp.headers
                self.last = time.monotonic()
                self.requests += 1
                if headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                data = json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as e:
                self.last = time.monotonic()
                if e.code in (429, 503) or e.code >= 500:
                    delay = self._retry_after(e.headers, backoff)
                    log(f"HTTP {e.code}, waiting {delay} s (attempt {attempt})")
                    time.sleep(delay)
                    backoff = min(backoff * 2, BACKOFF_MAX)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                self.last = time.monotonic()
                log(f"network error: {e!r}, waiting {backoff} s (attempt {attempt})")
                time.sleep(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
                continue
            err = data.get("error")
            if err:
                code = err.get("code")
                if code in ("maxlag", "ratelimited", "readonly"):
                    delay = self._retry_after(headers, backoff)
                    log(f"API {code}: {err.get('info', '')[:80]} — waiting {delay} s")
                    time.sleep(delay)
                    backoff = min(backoff * 2, BACKOFF_MAX)
                    continue
                raise RuntimeError(f"API error {code}: {err.get('info')}")
            return data


# ------------------------------------------------------------------ download


def load_json(file, default):
    if not os.path.exists(file):
        return default
    with open(file, encoding="utf-8") as f:
        return json.load(f)


def save_json(file, data, indent=None):
    tmp = file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
        if indent:
            f.write("\n")
    os.replace(tmp, file)


def have_pages(pages_file):
    """(category, pageid) pairs already stored in pages_file."""
    seen = set()
    if not os.path.exists(pages_file):
        return seen
    with open(pages_file, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                seen.add((rec["cat"], rec["pageid"]))
            except (ValueError, KeyError):
                continue
    return seen


def download(client, work):
    """All category members with their wikitext → WORK/pages-<set>.jsonl (resumable per category)."""
    ck_file = os.path.join(work, "checkpoint.json")
    ck = load_json(ck_file, {"done": [], "current": None, "continue": None})
    for set_id, cats in SETS:
        pages_file = os.path.join(work, f"pages-{set_id}.jsonl")
        seen = have_pages(pages_file)
        for cat, _code in cats:
            if cat in ck["done"]:
                continue
            base = {
                "action": "query", "generator": "categorymembers", "gcmtitle": "Категория:" + cat,
                "gcmnamespace": 0, "gcmtype": "page", "gcmlimit": BATCH,
                "prop": "revisions", "rvprop": "content|ids", "rvslots": "main",
            }
            cont = ck["continue"] if ck.get("current") == cat and ck.get("continue") else {}
            pending = {}
            got = 0
            log(f"{set_id}: category «{cat}» (cached {sum(1 for c, _ in seen if c == cat)})")
            while True:
                data = client.get({**base, **cont})
                for p in data.get("query", {}).get("pages", []):
                    if p.get("revisions"):
                        pending[p["pageid"]] = p
                if data.get("batchcomplete"):
                    with open(pages_file, "a", encoding="utf-8") as f:
                        for p in pending.values():
                            if (cat, p["pageid"]) in seen:
                                continue
                            rev = p["revisions"][0]
                            rec = {"cat": cat, "title": p["title"], "pageid": p["pageid"], "revid": rev.get("revid"),
                                   "text": rev["slots"]["main"]["content"]}
                            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                            seen.add((cat, p["pageid"]))
                            got += 1
                    pending = {}
                    ck = {"done": ck["done"], "current": cat, "continue": data.get("continue")}
                    save_json(ck_file, ck)
                    if client.requests % 10 == 0:
                        log(f"{set_id}: +{got} pages, requests {client.requests}")
                if "continue" not in data:
                    break
                cont = data["continue"]
            ck = {"done": ck["done"] + [cat], "current": None, "continue": None}
            save_json(ck_file, ck)
            log(f"{set_id}: «{cat}» done, +{got} pages")


# ------------------------------------------------------------ wikitext → text

LANG_HEAD_RE = re.compile(r"^=[^=\n][^\n]*=\s*$", re.M)          # level-1 heading «= {{-ru-}} =»
RU_HEAD_RE = re.compile(r"^=\s*\{\{-ru-\}\}\s*=\s*$", re.M)
HEADING_RE = re.compile(r"^=+[^\n]*=+\s*$", re.M)
MEANING_HEAD_RE = re.compile(r"^={3,5}\s*Значение\s*={3,5}\s*$", re.M)
PHRASE_RE = re.compile(r"\{\{phrase\b(.*?)^\}\}", re.S | re.M)
PHRASE_PARAM_RE = re.compile(r"\|\s*(тип|роль)\s*=\s*([^\n|{}]*)")   # params may share one line: {{phrase|тип=термин|роль=иг
MORPH_TPL_RE = re.compile(r"\{\{(conj|part|adv|intro|prep|interj|pron|predic|adj|noun|verb|num|phrase|onomatop)\b[\s|]", re.I)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
REF_RE = re.compile(r"<ref\b[^>]*/>|<ref\b[^>]*>.*?</ref>|<references\s*/?>", re.S | re.I)
TPL_RE = re.compile(r"\{\{([^{}]*)\}\}", re.S)
LINK_RE = re.compile(r"\[\[([^\[\]]*)\]\]")
EXTLINK_RE = re.compile(r"\[(?:https?|ftp)://[^\s\]]+(?:\s+([^\]]*))?\]")
TAG_RE = re.compile(r"</?[A-Za-z][^<>]*>")
NAMED_PARAM_RE = re.compile(r"^\s*[^=|{}\[\]]{1,40}=", re.S)
STRESS = "́̀"   # combining acute/grave: stress marks only (U+0306/U+0308 belong to й/ё)
CYR_RE = re.compile(r"[а-яёА-ЯЁ]")
LATIN_RE = re.compile(r"[A-Za-z]")
DROP_TEMPLATES = {"пример", "пример2", "примеры", "цитата", "цитаты", "ex", "example", "unfinished", "improve",
                  "семантика", "также-блок", "нужен пример", "нужны примеры", "сноска", "знак", "якорь", "anchor"}
PASS_TEMPLATES = {"выдел", "выделение", "b", "i", "em", "strong", "razr", "разр", "spaced", "s", "nobr", "nowrap", "small", "sup"}


def split_params(inner):
    """Split template body on «|» that are not inside [[…]]."""
    parts, buf, depth = [], [], 0
    i = 0
    while i < len(inner):
        ch = inner[i]
        if inner.startswith("[[", i):
            depth += 1
            buf.append("[[")
            i += 2
            continue
        if inner.startswith("]]", i) and depth:
            depth -= 1
            buf.append("]]")
            i += 2
            continue
        if ch == "|" and not depth:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    return parts


def expand_one(m):
    inner = m.group(1)
    if inner.startswith("#"):
        return ""
    parts = split_params(inner)
    name = parts[0].strip().lower().replace("_", " ")
    pos, named = [], {}
    for p in parts[1:]:
        if NAMED_PARAM_RE.match(p):
            k, v = p.split("=", 1)
            named[k.strip().lower()] = v.strip()
        else:
            pos.append(p.strip())
    first = next((p for p in pos if p), "")
    if name in DROP_TEMPLATES:
        return ""
    if name in PASS_TEMPLATES:
        return first
    if name in ("помета", "помета.", "помета2"):
        return first
    if name in ("t:=", "=", "т:="):
        return "= " + first
    if name == "итп":
        return "и т. п."
    if name == "итд":
        return "и т. д."
    if name in ("-", "--", "—", "тире", "mdash"):
        return " — "
    if name in ("nbsp", " ", "пробел"):
        return " "
    if name == "lang":
        return pos[1] if len(pos) > 1 else first
    if name.startswith("lang-"):
        return first
    if name == "действие":
        return f"действие по значению гл. {first}"
    if name == "свойство":
        return f"свойство по значению прил. {first}"
    if name == "соотн.":
        return f"соотносящийся по значению с сущ. {first}"
    if name in ("ж.", "женск."):
        return f"женск. к {first}"
    if name == "умласк.":
        return f"уменьш.-ласк. к {first}"
    if name.endswith(".") and len(name) <= 14:   # abbreviated pometa: {{разг.|ru}}, {{устар.|ru}}, {{вводн.|ru}}
        return name
    if named.get("текст"):
        return named["текст"]
    return first


def expand_templates(s):
    for _ in range(40):
        s2 = TPL_RE.sub(expand_one, s)
        if s2 == s:
            break
        s = s2
    return s


def replace_link(m):
    inner = m.group(1)
    target, _, label = inner.partition("|")
    low = target.strip().lower()
    if low.startswith(("файл:", "file:", "изображение:", "image:", "категория:", "category:")):
        return ""
    text = label if label else target
    if ":" in target and not label:
        text = target.split(":", 1)[1]
    return text


def trim(s, n=MAX_DEF):
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0].rstrip(" ,;:(—-")
    return cut + "…"


def cut_unclosed(s):
    """A template opened on this line and closed on a later one ({{пример|… spanning lines): drop it from its «{{»."""
    while s.count("{{") > s.count("}}") and "{{" in s:
        s = s[:s.rfind("{{")]
    return s


def clean_meaning(line):
    s = line.lstrip("#").strip()
    s = COMMENT_RE.sub("", s)
    s = REF_RE.sub("", s)
    s = cut_unclosed(s)
    s = expand_templates(s)
    s = s.replace("{", "").replace("}", "")
    s = LINK_RE.sub(replace_link, s)
    s = EXTLINK_RE.sub(lambda m: m.group(1) or "", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = TAG_RE.sub("", s)
    s = html.unescape(s)
    s = re.sub(r"'{2,}", "", s)
    s = s.split("||")[0]                 # «значение || грамматическая справка» — keep the meaning
    s = re.sub(r"\[\d+\]", "", s)        # footnote marks left by {{ссылки}} / <ref>
    s = s.replace("|", " ")
    s = s.replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([,;:.!?)])", r"\1", s)
    s = re.sub(r"\(\s*\)", "", s)
    s = re.sub(r"^[,;:.\s—–-]+", "", s)
    s = re.sub(r"[,;:\s—–-]+$", "", s)
    if s in ("?", "-", "—", "…", "."):
        return ""
    return trim(unicodedata.normalize("NFC", s))


def ru_section(text):
    m = RU_HEAD_RE.search(text)
    if not m:
        return None
    start = m.end()
    m2 = LANG_HEAD_RE.search(text, start)
    return text[start:m2.start() if m2 else len(text)]


def meanings(section):
    """All non-empty cleaned «# …» lines under every «Значение» heading, in order."""
    out = []
    for m in MEANING_HEAD_RE.finditer(section):
        body_start = m.end()
        m2 = HEADING_RE.search(section, body_start)
        body = section[body_start:m2.start() if m2 else len(section)]
        for line in body.split("\n"):
            if not line.startswith("#") or line.startswith(("#:", "#*", "##")):
                continue
            d = clean_meaning(line)
            if d:
                out.append(d)
    return out


def phrase_info(section):
    """(type, role) from the first {{phrase|тип=…|роль=…}}, or (pos, '') from the morphology template."""
    m = PHRASE_RE.search(section)
    if m:
        params = {k: clean_meaning(v) for k, v in PHRASE_PARAM_RE.findall(m.group(1))}
        return params.get("тип", ""), params.get("роль", "")
    m = MORPH_TPL_RE.search(section)
    return (m.group(1).lower() if m else ""), ""


def norm_title(t):
    t = unicodedata.normalize("NFC", t)
    t = "".join(ch for ch in unicodedata.normalize("NFD", t) if ch not in STRESS)
    return unicodedata.normalize("NFC", t).strip()


def page_url(title):
    t = title.replace(" ", "_")
    for ch, enc in (("%", "%25"), ("?", "%3F"), ("#", "%23"), ("&", "%26"), ("+", "%2B")):
        t = t.replace(ch, enc)
    return PAGE_URL + t


# ---------------------------------------------------------------- build


def read_pages(pages_file):
    """pageid → record (categories merged), in first-seen order."""
    pages = {}
    order = []
    bad = 0
    if not os.path.exists(pages_file):
        return [], 0
    with open(pages_file, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                bad += 1
                continue
            pid = rec["pageid"]
            if pid in pages:
                pages[pid]["cats"].add(rec["cat"])
                continue
            rec["cats"] = {rec.pop("cat")}
            pages[pid] = rec
            order.append(pid)
    if bad:
        log(f"warning: {bad} unreadable line(s) in {pages_file} skipped")
    return [pages[p] for p in order], bad


def build_set(set_id, cats, work):
    codes = dict(cats)
    pages, _ = read_pages(os.path.join(work, f"pages-{set_id}.jsonl"))
    items = []
    skipped = {"no-ru": 0, "latin": 0, "no-cyr": 0}
    with_def = 0
    for rec in pages:
        title = norm_title(rec["title"])
        if not CYR_RE.search(title):
            skipped["no-cyr"] += 1
            continue
        if LATIN_RE.search(title):
            skipped["latin"] += 1
            continue
        section = ru_section(rec["text"])
        if section is None:
            skipped["no-ru"] += 1
            continue
        defs = meanings(section)
        typ, role = phrase_info(section)
        item = {"t": title, "d": defs[0] if defs else "", "url": page_url(rec["title"])}
        if typ:
            item["type"] = typ
        if role:
            item["role"] = role
        item["c"] = "".join(sorted(codes[c] for c in rec["cats"] if c in codes))
        if item["d"]:
            with_def += 1
        items.append(item)
    items.sort(key=lambda it: it["t"].lower())
    return items, with_def, skipped, len(pages)


REPEATED_RE = re.compile(r"^(и|ни|то|не то|либо|или|что|хоть)\s+(.+?)\s+\1\s+(.+)$")


def stats_idioms(items):
    rep = sum(1 for it in items if REPEATED_RE.match(it["t"].lower()))
    kak = sum(1 for it in items if re.search(r"(^|\s)как(\s|$)", it["t"].lower()))
    return rep, kak


def build(work, out, sample=0):
    os.makedirs(out, exist_ok=True)
    meta = {
        "title": "Русский Викисловарь: устойчивые сочетания, союзы, вводные слова, частицы",
        "source": "ru.wiktionary.org, MediaWiki API, по категориям",
        "sourceUrl": "https://ru.wiktionary.org/",
        "license": LICENSE,
        "retrieved": date.today().isoformat(),
        "sets": {},
    }
    rnd = random.Random(42)
    for set_id, cats in SETS:
        items, with_def, skipped, npages = build_set(set_id, cats, work)
        data = {
            "title": meta["title"],
            "set": set_id,
            "categories": [{"name": c, "code": code, "url": CATEGORY_URL + c.replace(" ", "_")} for c, code in cats],
            "source": meta["source"],
            "license": LICENSE,
            "retrieved": meta["retrieved"],
            "count": len(items),
            "items": items,
        }
        file = os.path.join(out, f"{set_id}.json")
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with open(file + ".tmp", "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(file + ".tmp", file)
        info = {"file": f"{set_id}.json", "pages": npages, "count": len(items), "withDefinition": with_def,
                "skipped": skipped, "bytes": os.path.getsize(file), "categories": [c for c, _ in cats]}
        if set_id == "idioms":
            rep, kak = stats_idioms(items)
            info["repeatedConj"] = rep
            info["withKak"] = kak
        meta["sets"][set_id] = info
        log(f"{set_id}: {npages} pages → {len(items)} items ({with_def} with definition), skipped {skipped}, "
            f"{info['bytes'] / 1024:.0f} KB" + (f", repeated-conj {info['repeatedConj']}, with «как» {info['withKak']}" if set_id == "idioms" else ""))
        if sample and items:
            print(f"=== {set_id}: {sample} random items")
            for it in rnd.sample(items, min(sample, len(items))):
                print(f"  {it['t']}  [{it.get('type', '')}/{it.get('role', '')}/{it['c']}]  — {it['d']}")
    save_json(os.path.join(out, "meta.json"), meta, indent=2)
    return meta


# ------------------------------------------------------------- merge rules
#
# Only entries that reliably work as a clause-opening conjunction / an introductory word are
# merged; the full Wiktionary lists stay in bases/wiktionary/*.json for reference. The allowlists
# were curated by hand over the 176 conjunctions and 123 introductory words of the 2026-10 dump;
# an item is merged only if it is present in the Wiktionary data AND listed here. Everything new
# gets confidence 'check' and "source": "wiktionary"; an entry with «ё» also gets its «е» twin.

CONJ_SUBORDINATING_ADD = {
    "благодаря тому что": {},
    "благодаря чему": {},
    "в результате чего": {},
    "вследствие чего": {},
    "из-за того что": {},
    # «до тех пор пока» is not merged: the existing «пока» rule already puts the comma before «пока»
    # («до тех пор, пока»), a second entry would offer two commas for one place
    "лишь только": {},
    "потому как": {},
    "прежде нежели": {},
    "словно бы": {},
    "коли": {"skipIfNext": ["бы", "б", "же", "ж"]},
    "коль": {},
    "кабы": {},
    "понеже": {},
    "поелику": {},
    "зане": {},
    "аще": {},
    "яко": {},
    "аки": {},
    "докуда": {"skipIfNext": ["угодно", "бы"]},
}
CONJ_ADVERSATIVE_ADD = {
    "сиречь": {"ref": [154], "why": "Пояснительный союз «сиречь» (то есть) отделяется запятой."},
    "причём": {"ref": [138], "why": "Перед присоединительным союзом «причём» ставится запятая."},
    "притом": {"ref": [138], "why": "Перед присоединительным союзом «притом» ставится запятая."},
}
INTRO_ADD = {
    "в-шестых": {}, "в-седьмых": {}, "в-восьмых": {}, "в-девятых": {}, "в-десятых": {},
    "вероятнее всего": {},
    "иными словами": {},
    "кроме шуток": {},
    "по идее": {"skipIfNextGen": True},
    "имхо": {},
    "бывало": {"skipIfPrev": ["не", "ни", "как", "это", "такое", "такого", "что", "всё", "все", "и"]},
    "вестимо": {},
    "дескать": {},
    "кажись": {},
    "знамо": {"skipIfNext": ["дело"]},
    # «мол» is also a noun (breakwater): «о мол», «длинный мол»
    "мол": {"skipIfPrev": ["о", "об", "на", "за", "у", "к", "под", "над", "через", "возле", "около", "вдоль", "длинный", "каменный", "бетонный", "старый", "новый", "и"]},
    "следственно": {},
    "чаятельно": {},
    "апропо": {},
    "положим": {"skipIfPrev": ["мы", "не", "это", "и"]},
}
MERGE_NOTE = " Записи с \"source\": \"wiktionary\" добавлены из русского Викисловаря (scripts/fetch-wiktionary.py --merge)."


def fmt_item(it):
    """One rule item per line in the style of bases/rules/*.json: { "text": "…", "confidence": "check", … }."""
    return "{ " + ", ".join(f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in it.items()) + " }"


def write_rules_json(file, data, list_keys):
    """Write a rules file keeping the project's hand formatting: scalars and short arrays inline, item lists one per line."""
    lines = ["{"]
    keys = list(data.keys())
    for i, k in enumerate(keys):
        v = data[k]
        comma = "," if i < len(keys) - 1 else ""
        if k in list_keys:
            lines.append(f"  {json.dumps(k, ensure_ascii=False)}: [")
            for j, it in enumerate(v):
                lines.append("    " + fmt_item(it) + ("," if j < len(v) - 1 else ""))
            lines.append(f"  ]{comma}")
        else:
            lines.append(f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}{comma}")
    lines.append("}")
    tmp = file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, file)


def norm_rule_text(t):
    return re.sub(r"\s+", " ", t.lower().replace(",", " ")).strip()


def merge_list(target, have, wiki_titles, allow, base):
    """Append allowed Wiktionary items (and their «е» twins) to `target`; returns the added texts."""
    added = []
    for text, opts in allow.items():
        if text not in wiki_titles:
            log(f"merge: «{text}» is not in the Wiktionary dump — skipped")
            continue
        for variant in dict.fromkeys([text, text.replace("ё", "е")]):
            if variant in have:
                continue
            entry = {"text": variant, **base, **opts, "source": "wiktionary"}
            target.append(entry)
            have.add(variant)
            added.append(variant)
    return added


def merge_rules(out, rules_dir):
    """Add curated Wiktionary conjunctions and introductory words to bases/rules/conj.json and intro.json (no duplicates)."""
    wconj = {norm_rule_text(it["t"]) for it in load_json(os.path.join(out, "conj.json"), {"items": []})["items"]}
    wintro = {norm_rule_text(it["t"]) for it in load_json(os.path.join(out, "intro.json"), {"items": []})["items"]}
    conj_file = os.path.join(rules_dir, "conj.json")
    intro_file = os.path.join(rules_dir, "intro.json")
    conj = load_json(conj_file, None)
    intro = load_json(intro_file, None)
    if conj is None or intro is None:
        raise SystemExit(f"rules not found in {rules_dir}")

    have_conj = {it["text"].lower() for it in conj["subordinating"]} | {it["text"].lower() for it in conj["adversative"]}
    added_sub = merge_list(conj["subordinating"], have_conj, wconj, CONJ_SUBORDINATING_ADD, {"confidence": "check", "needsHead": True})
    added_adv = merge_list(conj["adversative"], have_conj, wconj, CONJ_ADVERSATIVE_ADD, {"confidence": "check"})
    have_intro = {it["text"].lower() for it in intro["items"]}
    added_intro = merge_list(intro["items"], have_intro, wintro, INTRO_ADD, {"confidence": "check"})

    for data in (conj, intro):
        if MERGE_NOTE.strip() not in data.get("_comment", ""):
            data["_comment"] = data.get("_comment", "").rstrip() + MERGE_NOTE
    if added_sub or added_adv:
        write_rules_json(conj_file, conj, ("subordinating", "adversative"))
    if added_intro:
        write_rules_json(intro_file, intro, ("items",))
    log(f"merge: +{len(added_sub)} subordinating, +{len(added_adv)} adversative → {conj_file}: {', '.join(added_sub + added_adv) or '—'}")
    log(f"merge: +{len(added_intro)} intro words → {intro_file}: {', '.join(added_intro) or '—'}")
    return added_sub + added_adv, added_intro


# ------------------------------------------------------------------- main


def main(argv):
    global LOG_FILE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.path.join(ROOT, ".cache", "wiktionary"), help="checkpoint/cache dir")
    ap.add_argument("--out", default=os.path.join(ROOT, "bases", "wiktionary"), help="output dir (bases/wiktionary)")
    ap.add_argument("--rules", default=os.path.join(ROOT, "bases", "rules"), help="bases/rules dir for --merge")
    ap.add_argument("--pause", type=float, default=1.5, help="seconds between requests (≥1)")
    ap.add_argument("--build", action="store_true", help="skip downloading, rebuild from cache")
    ap.add_argument("--merge", action="store_true", help="merge conj/intro into bases/rules/conj.json and intro.json")
    ap.add_argument("--sample", type=int, default=0, help="print N random cleaned items per set after build")
    args = ap.parse_args(argv)
    os.makedirs(args.work, exist_ok=True)
    LOG_FILE = os.path.join(args.work, "fetch.log")
    t0 = time.monotonic()
    if not args.build:
        client = Client(args.pause)
        log(f"download → {args.work} (pause {client.pause} s)")
        download(client, args.work)
        log(f"download finished: {client.requests} requests, {time.monotonic() - t0:.0f} s")
    build(args.work, args.out, sample=args.sample)
    if args.merge:
        merge_rules(args.out, args.rules)
    log(f"done in {time.monotonic() - t0:.0f} s")


if __name__ == "__main__":
    main(sys.argv[1:])
