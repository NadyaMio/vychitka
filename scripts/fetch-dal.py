#!/usr/bin/env python3
"""
Fetch the 2nd edition of Dal's «Толковый словарь живого великорусского языка»
from Russian Wikisource and build bases/dal/ (dal.json.gz + meta.json).

Where the text lives on Wikisource
----------------------------------
Article pages «ТСД2/<Слово>» are thin wrappers: they contain only the {{ТСД}}
template, and Модуль:Отексте/ТСД2 transcludes the body from the proofread scan
pages «Страница:Толковый словарь Даля (2-е издание). Том N (год).pdf/M»
(namespace 104). On a scan page every article is a labelled section
<section begin="Слово" />…<section end="Слово" /> whose label is exactly the
«ТСД2/…» page name; an article that continues on the next page has a section
with the same label there. Sections with a trailing «+» are the automatically
modernised copies — we skip them and keep the original orthography (ѣ, і, ъ).

So the loader downloads the 2 810 scan pages of the four volumes (50 per API
request), then the list of existing «ТСД2/…» titles (to build valid links),
and the builder splits pages by section labels, joins multi-page articles,
strips wiki markup and writes the dictionary.

Usage
-----
  python3 scripts/fetch-dal.py                 # download (resumable) + build
  python3 scripts/fetch-dal.py --build         # rebuild from the cached download only
  python3 scripts/fetch-dal.py --sample 20     # also print 20 random cleaned articles
  python3 scripts/fetch-dal.py --work .cache/dal --out bases/dal --pause 1.5

Politeness: User-Agent, maxlag=5, ≥1 s between requests, 429/503/maxlag →
Retry-After or exponential back-off 5→300 s, never gives up on its own.

Checkpoints (WORK dir, default .cache/dal/): pages.jsonl (raw wikitext, one page
per line, appended after every completed batch), titles.txt, checkpoint.json
(continue tokens). An interrupted run continues from the last completed batch.
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

API = "https://ru.wikisource.org/w/api.php"
USER_AGENT = "Vychitka/0.2 (https://github.com/NadyaMio/vychitka)"
PAGE_NS = 104  # «Страница:»
PAGE_PREFIX = "Толковый словарь Даля (2-е издание). Том {vol} ({year}).pdf/"
VOLUMES = [(1, 1880, 723), (2, 1881, 807), (3, 1882, 576), (4, 1882, 704)]
ARTICLE_PREFIX = "ТСД2/"
ARTICLE_URL = "https://ru.wikisource.org/wiki/ТСД2/"
SOURCE_URL = "https://ru.wikisource.org/wiki/Толковый_словарь_Даля"
BATCH = 50
MIN_PAUSE = 1.0
BACKOFF_START = 5
BACKOFF_MAX = 300
TIMEOUT = 120

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


def save_json(file, data):
    tmp = file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, file)


def page_number(title):
    try:
        return int(title.rsplit("/", 1)[1])
    except (IndexError, ValueError):
        return -1


def have_pages(pages_file):
    seen = set()
    if not os.path.exists(pages_file):
        return seen
    with open(pages_file, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                seen.add((rec["vol"], rec["page"]))
            except (ValueError, KeyError):
                continue
    return seen


def download_pages(client, work):
    """Scan pages of all volumes → WORK/pages.jsonl (resumable)."""
    pages_file = os.path.join(work, "pages.jsonl")
    ck_file = os.path.join(work, "checkpoint.json")
    ck = load_json(ck_file, {"done": [], "current": None, "continue": None})
    seen = have_pages(pages_file)
    log(f"pages cached: {len(seen)}; volumes done: {ck['done']}")
    for vol, year, npages in VOLUMES:
        if vol in ck["done"]:
            continue
        base = {
            "action": "query", "generator": "allpages", "gapnamespace": PAGE_NS,
            "gapprefix": PAGE_PREFIX.format(vol=vol, year=year), "gapfilterredir": "nonredirects",
            "gaplimit": BATCH, "prop": "revisions", "rvprop": "content|ids", "rvslots": "main",
        }
        cont = ck["continue"] if ck.get("current") == vol and ck.get("continue") else {}
        pending = {}
        got = 0
        while True:
            data = client.get({**base, **cont})
            for p in data.get("query", {}).get("pages", []):
                if p.get("revisions"):
                    pending[p["pageid"]] = p
            if data.get("batchcomplete"):
                with open(pages_file, "a", encoding="utf-8") as f:
                    for p in pending.values():
                        num = page_number(p["title"])
                        if (vol, num) in seen:
                            continue
                        rev = p["revisions"][0]
                        rec = {"vol": vol, "page": num, "title": p["title"], "pageid": p["pageid"],
                               "revid": rev.get("revid"), "text": rev["slots"]["main"]["content"]}
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                        seen.add((vol, num))
                        got += 1
                pending = {}
                ck = {"done": ck["done"], "current": vol, "continue": data.get("continue")}
                save_json(ck_file, ck)
                log(f"vol {vol}: +{got} pages (total {len(seen)}), requests {client.requests}")
            if "continue" not in data:
                break
            cont = data["continue"]
        ck = {"done": ck["done"] + [vol], "current": None, "continue": None}
        save_json(ck_file, ck)
        log(f"vol {vol} done ({npages} expected)")
    return pages_file


def download_titles(client, work):
    """Existing «ТСД2/…» page names → WORK/titles.txt (resumable)."""
    titles_file = os.path.join(work, "titles.txt")
    ck_file = os.path.join(work, "titles-checkpoint.json")
    ck = load_json(ck_file, {"done": False, "continue": None})
    if ck["done"]:
        return titles_file
    cont = ck["continue"] or {}
    count = 0
    while True:
        data = client.get({"action": "query", "list": "allpages", "apnamespace": 0, "apprefix": ARTICLE_PREFIX,
                           "apfilterredir": "nonredirects", "aplimit": 500, **cont})
        batch = [p["title"] for p in data.get("query", {}).get("allpages", []) if not p["title"].endswith("/ДО")]
        with open(titles_file, "a", encoding="utf-8") as f:
            for t in batch:
                f.write(t[len(ARTICLE_PREFIX):] + "\n")
        count += len(batch)
        if "continue" not in data:
            break
        cont = data["continue"]
        save_json(ck_file, {"done": False, "continue": cont})
        if client.requests % 10 == 0:
            log(f"titles: +{count} (requests {client.requests})")
    save_json(ck_file, {"done": True, "continue": None})
    log(f"titles done: +{count}")
    return titles_file


# ------------------------------------------------------------ wikitext → text

SECTION_RE = re.compile(r'<section\s+(begin|end)\s*=\s*"?([^"/>]+?)"?\s*/>', re.I)
NOINCLUDE_RE = re.compile(r"<noinclude>.*?</noinclude>", re.S | re.I)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
REF_RE = re.compile(r"<ref\b[^>]*/>|<ref\b[^>]*>.*?</ref>|<references\s*/?>", re.S | re.I)
TPL_RE = re.compile(r"\{\{([^{}]*)\}\}", re.S)
LINK_RE = re.compile(r"\[\[([^\[\]]*)\]\]")
EXTLINK_RE = re.compile(r"\[(?:https?|ftp)://[^\s\]]+(?:\s+([^\]]*))?\]")
TAG_RE = re.compile(r"</?[A-Za-z][^<>]*>")
BROKEN_HYPHEN_RE = re.compile(r"\{\{перенос2?\|([^}]*)\}\}", re.I)
BROKEN_SECTION_RE = re.compile(r'<section\s+(?:begin|end)\s*=\s*"[^"<>]*"?\s*/?>?', re.I)
BROKEN_TAG_RE = re.compile(r"</?(?:small|section|span|div|sup|sub|center|poem|br|i|b)(?![A-Za-z])(?:\s[^<>\s]*)?>?")
MAGIC_RE = re.compile(r"__[A-Z]+__")
BOLD_RE = re.compile(r"'''(.+?)'''", re.S)
NAMED_PARAM_RE = re.compile(r"^\s*[^=|{}\[\]]{1,40}=", re.S)
FILE_PREFIXES = ("файл:", "file:", "изображение:", "image:", "категория:", "category:")
COMBINING = "̀́̂"  # stress marks only: U+0306/U+0308 belong to й/ё and must survive NFD
ACUTE = "́"
WORD_RE = re.compile(r"^[A-Za-zА-Яа-яЁёѢѣІіЇїѲѳѴѵЙй́̀-]+$")

TEMPLATE_COUNTS = {}


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
    if ":" in name and name.split(":", 1)[0] in ("defaultsort", "displaytitle"):
        return ""
    TEMPLATE_COUNTS[name] = TEMPLATE_COUNTS.get(name, 0) + 1
    pos, named = [], {}
    for p in parts[1:]:
        if NAMED_PARAM_RE.match(p):
            k, v = p.split("=", 1)
            named[k.strip().lower()] = v.strip()
        else:
            pos.append(p.strip())
    first = next((p for p in pos if p), "")

    if name in ("акут", "акут2", "акут3", "ударение", "udar", "acute", "уд"):
        return ACUTE
    if name in ("гравис", "grave"):
        return "̀"
    if name == "!":
        return "|"
    if name == "и":        # «издан{{и}}е» — і in the old orthography, which we keep
        return "і"
    if name == "ъ":        # «том{{ъ}}» — final ъ in the old orthography
        return "ъ"
    if name == "ко":
        return "К°"
    if name == "дробь":    # {{дробь|1|2}} → 1/2, {{дробь|1|1|2}} → 1 1/2
        if len(pos) >= 3:
            return f"{pos[0]} {pos[1]}/{pos[2]}"
        return "/".join(pos[:2])
    if name.startswith("примечани") or name in ("tq", "свр", "тсд страница словника", "якорь", "indent",
                                              "comment", "rfloat", "anchor", "pagequality"):
        return ""  # Wikisource editors' footnotes, quality/section markers, anchors
    if name in ("nbsp", " ", "пробел"):
        return " "
    if name in ("—", "тире", "mdash", "длинное тире"):
        return "—"
    if name in ("-", "clear", "br", "thin", "hair", "clr"):
        return " "
    if name in ("tsdl", "тсдл"):
        return (pos[1] if len(pos) > 1 and pos[1] else first)
    if name == "lang":
        return pos[1] if len(pos) > 1 else first
    if name.startswith("lang-"):
        return first
    if name == "перенос":
        return (pos[0] if pos else "") + (pos[1] if len(pos) > 1 else "")
    if name == "перенос2":
        if named.get("правильно"):
            return named["правильно"]
        return pos[1] if len(pos) > 1 else first
    if name in ("опечатка", "опечатка2", "ошибка"):
        return pos[1] if len(pos) > 1 and pos[1] else first
    if name in ("sic", "sic2", "sic!", "так в тексте"):
        return first
    if name in ("razr", "razr2", "razs", "разр", "разрядка", "spaced", "рзр", "bs", "bss", "s", "gb", "выступ"):
        return first
    if name in ("reflist", "колонтитул", "тсд", "doc", "right", "left", "tsds", "статья в словнике тсд"):
        return ""
    if named.get("текст"):
        return named["текст"]
    return first


def expand_templates(s):
    for _ in range(60):
        s2 = TPL_RE.sub(expand_one, s)
        if s2 == s:
            break
        s = s2
    return s


def replace_link(m):
    inner = m.group(1)
    target, _, label = inner.partition("|")
    if target.strip().lower().startswith(FILE_PREFIXES):
        return ""
    text = label if label else target
    if ":" in target and not label:
        text = target.split(":", 1)[1]
    return text


def preclean(wt):
    """Markup that must go before anything else; keeps bold markers for heads."""
    s = NOINCLUDE_RE.sub("", wt)
    s = COMMENT_RE.sub("", s)
    s = REF_RE.sub("", s)
    s = SECTION_RE.sub("", s)
    s = s.replace("<includeonly>", "").replace("</includeonly>", "")
    s = expand_templates(s)
    # source defects: «{{перенос2|вы{ба|рахтался}}» (stray brace) — keep the letters, drop the markup
    s = BROKEN_HYPHEN_RE.sub(lambda m: re.sub(r"[{}|]", "", m.group(1)), s)
    s = s.replace("{", "").replace("}", "")
    s = LINK_RE.sub(replace_link, s)
    s = EXTLINK_RE.sub(lambda m: m.group(1) or "", s)
    s = MAGIC_RE.sub("", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = TAG_RE.sub("", s)
    s = BROKEN_SECTION_RE.sub(" ", s)
    s = BROKEN_TAG_RE.sub("", s)  # «<smallикнпс.</small» — tags typed without «>»
    s = html.unescape(s)
    return s


def finish_text(s):
    s = re.sub(r"'{2,}", "", s)
    s = s.replace(" ", " ").replace("#", "")  # «#» is wiki list markup, never dictionary text
    s = re.sub(r"\s*\|\|\s*", " ‖ ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([,;:.!?)])", r"\1", s)
    s = unicodedata.normalize("NFC", s)
    return s


def normalize_key(word):
    """Search key in modern orthography (mirrors src/engine/dal.js normalizeKey)."""
    s = unicodedata.normalize("NFC", str(word)).lower()
    s = "".join(ch for ch in unicodedata.normalize("NFD", s) if ch not in COMBINING)
    s = unicodedata.normalize("NFC", s)
    s = (s.replace("ѣ", "е").replace("ё", "е").replace("і", "и").replace("ї", "и")
          .replace("ѳ", "ф").replace("ѵ", "и").replace("ъ-", "-"))
    s = re.sub(r"[^a-zа-яё-]+", "", s)
    s = s.rstrip("ъ")
    return s.strip("-")


def words_from_run(run):
    """Head words from a bold run: «Лицо́, лицѣ́» → ['Лицо́', 'лицѣ́']; skips «—умоватый»."""
    out = []
    text = finish_text(run)
    for piece in re.split(r"[,;]|\sили\s|\sи\s", text):
        w = piece.strip().strip("?!.:()«»\"' ")
        if not w or w.startswith(("—", "-", "–")):
            continue
        if " " in w:
            continue
        if not WORD_RE.match(w):
            continue
        out.append(w)
    return out


def clean_article(wikitext, label):
    """→ (head, head_words, nested_words, text)."""
    s = preclean(wikitext)
    runs = [m.group(1) for m in BOLD_RE.finditer(s)]
    head = label
    head_words = []
    nested = []
    if runs:
        lead = s.lstrip()
        first = finish_text(runs[0])
        if first and (lead.startswith("'''") or lead[:4].count("'") >= 2):
            head = first.strip(" ,;")
        head_words = words_from_run(runs[0])
        for r in runs[1:]:
            nested.extend(words_from_run(r))
    text = finish_text(s)
    return head, head_words, nested, text


# ---------------------------------------------------------------- build


def iter_sections(page_text):
    """Yield (label, body, closed, anchor) for every <section begin=…/> on the page.

    Sections may nest («Соя» wraps «Соя 1», «Соя 2»). Some umbrella labels have
    no end marker at all — they are anchors for the ТСД2 page, not text: for them
    the body is cut at the first unrelated (or «+») begin marker and anchor=True
    says that other sections start inside.
    """
    marks = [(m.start(), m.end(), m.group(1).lower(), m.group(2).strip()) for m in SECTION_RE.finditer(page_text)]
    for i, (start, end, kind, label) in enumerate(marks):
        if kind != "begin":
            continue
        stop = len(page_text)
        closed = False
        nested = False
        for s2, e2, k2, l2 in marks[i + 1:]:
            if k2 == "end" and l2 == label:
                stop = s2
                closed = True
                break
            if k2 == "begin":
                if l2.startswith(label + " ") and NUMBERED_RE.match(l2):
                    nested = True
                    continue
                if not closed:
                    stop = s2  # unmatched begin: do not swallow the next article or the «+» copies
                    break
        yield label, page_text[end:stop], closed, nested


NUMBERED_RE = re.compile(r"^(.*\S)\s+\d+$")
HYPHEN_START_RE = re.compile(r"^\s*\{\{перенос2\|[^{}]*\}\}", re.I)


def collect_articles(pages_file):
    """Group section bodies into articles keyed by (volume, label).

    Homonyms: a page may carry an umbrella section «Соя» wrapping «Соя 1», «Соя 2».
    A properly closed umbrella is kept as one article and its parts are skipped;
    an umbrella without an end marker is only an anchor — it is dropped and the
    numbered parts become the articles.
    """
    by_vol = {}
    bad = 0
    with open(pages_file, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                bad += 1  # half-written last line while the downloader is still running
                continue
            by_vol.setdefault(rec["vol"], {})[rec["page"]] = rec["text"]
    if bad:
        log(f"warning: {bad} unreadable line(s) in {pages_file} skipped")
    articles = {}
    order = []
    skipped_plus = 0
    anchors = 0
    for vol in sorted(by_vol):
        for page in sorted(by_vol[vol]):
            text = by_vol[vol][page]
            sections = list(iter_sections(text))
            closed_umbrellas = {l for l, _, closed, nested in sections if closed and nested}
            for label, body, closed, nested in sections:
                if label.endswith("+"):
                    skipped_plus += 1
                    continue
                if label.isdigit() or label.lower() == "список" or body.lstrip().startswith("#"):
                    continue  # словник fragments («<section begin="59" /># Безбожие # …»), not articles
                if nested and not closed:
                    anchors += 1
                    continue  # anchor «Волна» without end marker: «Волна 1», «Волна 2» are the articles
                m = NUMBERED_RE.match(label)
                if m and m.group(1) in closed_umbrellas:
                    continue  # «Соя 1» inside a closed umbrella «Соя»
                key = (vol, label)
                if key not in articles:
                    articles[key] = {"vol": vol, "label": label, "chunks": []}
                    order.append(key)
                articles[key]["chunks"].append((page, body))
    log(f"collect: {anchors} anchor sections without end marker dropped")
    return [articles[k] for k in order], sum(len(v) for v in by_vol.values()), skipped_plus


def join_chunks(chunks):
    chunks = sorted(chunks, key=lambda c: c[0])
    parts = []
    for i, (_, body) in enumerate(chunks):
        if i > 0:
            body = HYPHEN_START_RE.sub("", body, count=1)
        parts.append(body.strip())
    return "\n".join(parts), chunks[0][0]


def load_titles(titles_file):
    if not os.path.exists(titles_file):
        return set()
    with open(titles_file, encoding="utf-8") as f:
        return {line.rstrip("\n") for line in f if line.strip()}


_TITLES_NORM = {}


def titles_norm(titles):
    """normalize_key(title) → title, for labels with typos («Обкалять1», «Перемѣнять»)."""
    if not _TITLES_NORM and titles:
        for t in sorted(titles):
            _TITLES_NORM.setdefault(normalize_key(t), t)
    return _TITLES_NORM


def article_url(label, titles):
    """«ТСД2/…» link: the label itself, its base («Соя 1» → «Соя»), its first
    homonym page («Волна» → «Волна 1»), the first word («А, со» → «А»),
    finally a match by normalised key («Обкалять1» → «Обкалять 1»)."""
    if not titles:
        return ARTICLE_URL + label.replace(" ", "_"), False
    plain = re.sub(r"\([^)]*\)", "", label).strip()
    cand = [label, plain]
    m = NUMBERED_RE.match(plain)
    if m:
        cand.append(m.group(1))
    for n in (1, 2):
        cand.append(f"{plain} {n}")
    first_word = re.sub(r"[^\w-]+$", "", plain.split()[0]) if plain.split() else ""
    if first_word:
        cand.append(first_word)
    for c in cand:
        if c in titles:
            return ARTICLE_URL + c.replace(" ", "_"), True
    norm = titles_norm(titles).get(normalize_key(plain))
    if norm:
        return ARTICLE_URL + norm.replace(" ", "_"), True
    return ARTICLE_URL + label.replace(" ", "_"), False


def build(work, out, sample=0, sample_file=None):
    pages_file = os.path.join(work, "pages.jsonl")
    if not os.path.exists(pages_file):
        raise SystemExit(f"no download yet: {pages_file}")
    titles = load_titles(os.path.join(work, "titles.txt"))
    raw, npages, skipped_plus = collect_articles(pages_file)
    log(f"build: {npages} pages, {len(raw)} articles, {skipped_plus} «+» sections skipped, {len(titles)} titles known")
    articles = []
    index = {}
    nested = {}
    missing_url = 0
    empty = 0
    for art in raw:
        wikitext, first_page = join_chunks(art["chunks"])
        head, head_words, nested_words, text = clean_article(wikitext, art["label"])
        if len(text) < 4:
            empty += 1  # letter headers («А.») and empty sections
            continue
        url, ok = article_url(art["label"], titles)
        if not ok:
            missing_url += 1
        idx = len(articles)
        articles.append({"head": head, "text": text, "url": url, "vol": art["vol"], "page": first_page})
        keys = {normalize_key(art["label"])}
        keys.update(normalize_key(w) for w in head_words)
        keys.discard("")
        for k in keys:
            lst = index.setdefault(k, [])
            if idx not in lst:
                lst.append(idx)
        for w in nested_words:
            k = normalize_key(w)
            if not k or k in keys or len(k) < 2:
                continue
            lst = nested.setdefault(k, [])
            if idx not in lst and len(lst) < 12:
                lst.append(idx)
    data = {
        "title": "Толковый словарь живого великорусского языка Владимира Даля",
        "edition": "2-е издание, т. 1–4 (1880–1882)",
        "source": "Русская Викитека, страницы «ТСД2/…» (текст со сканов 2-го издания)",
        "sourceUrl": SOURCE_URL,
        "license": "Текст словаря — общественное достояние; оцифровка и вычитка — участники Викитеки, CC BY-SA 4.0",
        "retrieved": date.today().isoformat(),
        "count": len(articles),
        "articles": articles,
        "index": index,
        "nested": nested,
    }
    os.makedirs(out, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_file = os.path.join(out, "dal.json.gz")
    with open(gz_file + ".tmp", "wb") as f:
        f.write(gzip.compress(payload, compresslevel=9, mtime=0))
    os.replace(gz_file + ".tmp", gz_file)
    meta = {
        "title": data["title"], "edition": data["edition"], "source": data["source"], "sourceUrl": data["sourceUrl"],
        "license": data["license"], "retrieved": data["retrieved"], "count": len(articles),
        "headwords": len(index), "nestedWords": len(nested), "pages": npages,
        "volumes": [{"vol": v, "year": y, "pages": n} for v, y, n in VOLUMES],
        "file": "dal.json.gz", "rawBytes": len(payload), "bytes": os.path.getsize(gz_file),
    }
    save_json(os.path.join(out, "meta.json"), meta)
    text_chars = sum(len(a["text"]) for a in articles)
    log(f"written {gz_file}: {len(articles)} articles, {len(index)} head keys, {len(nested)} nested keys, "
        f"{text_chars/1e6:.1f} M chars, raw {len(payload)/1048576:.1f} MB, gz {meta['bytes']/1048576:.1f} MB; "
        f"empty {empty}, no page for url {missing_url}")
    top = sorted(TEMPLATE_COUNTS.items(), key=lambda kv: -kv[1])[:40]
    log("templates seen: " + ", ".join(f"{k}:{v}" for k, v in top))
    if sample:
        rnd = random.Random(42)
        picks = rnd.sample(articles, min(sample, len(articles)))
        lines = []
        for a in picks:
            lines.append(f"=== {a['head']}  [{a['url']}]  (т. {a['vol']}, с. {a['page']})\n{a['text'][:1500]}\n")
        out_text = "\n".join(lines)
        print(out_text)
        if sample_file:
            with open(sample_file, "w", encoding="utf-8") as f:
                f.write(out_text)
    return meta


# ------------------------------------------------------------------- main


def main(argv):
    global LOG_FILE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.path.join(ROOT, ".cache", "dal"), help="checkpoint/cache dir")
    ap.add_argument("--out", default=os.path.join(ROOT, "bases", "dal"), help="output dir (bases/dal)")
    ap.add_argument("--pause", type=float, default=1.5, help="seconds between requests (≥1)")
    ap.add_argument("--build", action="store_true", help="skip downloading, rebuild from cache")
    ap.add_argument("--no-titles", action="store_true", help="skip the «ТСД2/…» title list (links unverified)")
    ap.add_argument("--sample", type=int, default=0, help="print N random cleaned articles after build")
    args = ap.parse_args(argv)
    os.makedirs(args.work, exist_ok=True)
    LOG_FILE = os.path.join(args.work, "fetch.log")
    t0 = time.monotonic()
    if not args.build:
        client = Client(args.pause)
        log(f"download → {args.work} (pause {client.pause} s)")
        download_pages(client, args.work)
        if not args.no_titles:
            download_titles(client, args.work)
        log(f"download finished: {client.requests} requests, {time.monotonic() - t0:.0f} s")
    build(args.work, args.out, sample=args.sample, sample_file=os.path.join(args.work, "samples.txt"))
    log(f"done in {time.monotonic() - t0:.0f} s")


if __name__ == "__main__":
    main(sys.argv[1:])
