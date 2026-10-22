#!/usr/bin/env python3
"""
Build the punctuation benchmark from the raw corpora in .cache/eval/raw/
(see fetch.py) → .cache/eval/punct.jsonl, clean.jsonl, stats.json.

What counts as a punctuation case
---------------------------------
A sentence is split into *words* (runs of letters/digits) and the *gaps*
between them. Every gap is reduced to a signature of sign classes:

    ,  ;  :  .  …  !  ?   —  (dash: «—», «–», or «-» with a space around it)
    h  (hyphen: «-»/«–» glued between two words — «кто-то», «5-10»)
    q  (any quotation mark)   (  )   o  (anything else: № % / + …)

Two gaps are *the same* when their class sequences and their spacing match;
glyph differences inside a class («-» vs «—», «"» vs «»», «...» vs «…»)
are ignored. A pair gives one edit per gap whose signature or spacing differs.

Kinds of pairs written to punct.jsonl:

  pure     words identical (case, ё included); only punctuation/spacing differs.
  derived  the corpus pair also fixes words (spelling, case, ё, hyphen …) but
           the words align 1:1. We take the *corrected* words and the
           *original* punctuation, so the engine sees a sentence whose only
           defects are the punctuation ones. `origSrc` keeps the raw source.

Pairs whose word count changes (a word inserted or dropped) are not used as
punctuation cases; hyphen-only edits («кто то» → «кто-то»), changes of «other»
symbols and unpaired brackets (emoticons) count as orthography, not
punctuation. Two kinds of edits are tagged so the evaluator can report them
apart from the headline numbers — the engine does not police either:
  terminal  only a final . ! ? … added/removed at the very end of the text;
  boundary  only . ! ? … inserted mid-text before a word that is already
            capitalised (run-on medical notes split into sentences).

Clean sentences (clean.jsonl) are the *corrected* sides of every pair that
passed the junk filters, deduplicated — including pairs that had no
punctuation edit at all. They measure spurious corrections.

Splits: per source, a seeded shuffle, 70 % dev / 30 % test (`split` field).
Tune on dev, report on test.

Formats
-------
  punct.jsonl  {id, source, domain, kind, split, src, ref, origSrc?, edits:[
                 {start, end, before, after, added, removed, type, pos, terminal, boundary}]}
               (start/end — UTF-16 offsets into src, like the engine's issues)
  clean.jsonl  {id, source, domain, split, text}
  stats.json   counts per source / kind / edit type / rejection reason

Sources: russian_gec (CSV), sage (JSONL), rulec / ru-lang8 (M2, if the files
were dropped into raw/rulec, raw/ru-lang8 — see fetch.py).

Usage
-----
  python3 scripts/eval/build-punct-set.py            # build
  python3 scripts/eval/build-punct-set.py --selftest # unit checks, no data needed
  python3 scripts/eval/build-punct-set.py --sample 20 # print 20 random cases
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import unicodedata
from collections import Counter
from datetime import date, datetime
from difflib import SequenceMatcher

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_RAW = os.path.join(ROOT, ".cache", "eval", "raw")
DEFAULT_OUT = os.path.join(ROOT, ".cache", "eval")
SEED = 20261022
DEV_SHARE = 0.7

MIN_WORDS = 3
MIN_CHARS = 15
MAX_WORDS = 80
MAX_CHARS = 600
MIN_CYR_RATIO = 0.7

# --- character classes (mirror of scripts/eval/eval-punct.js) ------------------------------------

WORD_RE = re.compile(r"[^\W_]+")
QUOTES = set('«»„“”"‟‘’‚‛‹›\'')
DASHES_EM = set("—―")
DASHES_SOFT = set("-‐‑−–")  # hyphen-like: glued → h, spaced → —
PARENS_OPEN = set("([")
PARENS_CLOSE = set(")]")
SIMPLE = {",": ",", ";": ";", ":": ":", "!": "!", "?": "?", "…": "…"}
TERMINAL_CLASSES = set(".!?…")
MARKUP_RE = re.compile(r"[<>{}|\\`~^_#@$]|https?://|www\.")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{2,}")
STRESS_RE = re.compile("[̀́]")
ZERO_WIDTH_RE = re.compile("[​‌‍⁠﻿­]")
WS_RE = re.compile(r"[ \t     ]+")


def normalize_text(text):
    """NFC, no stress marks / zero-width chars, single spaces, stripped."""
    s = unicodedata.normalize("NFC", str(text))
    s = ZERO_WIDTH_RE.sub("", STRESS_RE.sub("", s))
    s = WS_RE.sub(" ", s)
    return s.strip()


def word_key(word):
    return word.lower().replace("ё", "е")


def split_words(text):
    """→ (words, gaps): words are regex matches, gaps are the N+1 strings between them."""
    words = list(WORD_RE.finditer(text))
    gaps = []
    prev = 0
    for m in words:
        gaps.append(text[prev:m.start()])
        prev = m.end()
    gaps.append(text[prev:])
    return words, gaps


def unmatched_parens(text):
    """Indexes of brackets without a partner — emoticons «)))», «(» — treated as «other»."""
    stack = []
    bad = set()
    for i, ch in enumerate(text):
        if ch in PARENS_OPEN:
            stack.append(i)
        elif ch in PARENS_CLOSE:
            if stack:
                stack.pop()
            else:
                bad.add(i)
    bad.update(stack)
    return bad


def gap_classes(gap, has_prev, has_next, offset=0, unmatched=frozenset()):
    """Normalized form of a gap: one char per sign class, whitespace runs → ' '.

    `offset` is the gap's position in the text, `unmatched` the set from
    unmatched_parens(text). Returns (classes_without_spaces, normalized_string).
    """
    out = []
    i = 0
    n = len(gap)
    while i < n:
        ch = gap[i]
        if ch.isspace():
            if not out or out[-1] != " ":
                out.append(" ")
            i += 1
            continue
        if ch == ".":
            j = i
            while j < n and gap[j] == ".":
                j += 1
            out.append("…" if j - i >= 2 else ".")
            i = j
            continue
        if ch in SIMPLE:
            out.append(SIMPLE[ch])
        elif ch in QUOTES:
            out.append("q")
        elif ch in DASHES_EM:
            out.append("—")
        elif ch in DASHES_SOFT:
            left_glued = (i > 0 and not gap[i - 1].isspace()) or (i == 0 and has_prev)
            right_glued = (i + 1 < n and not gap[i + 1].isspace()) or (i + 1 == n and has_next)
            out.append("h" if left_glued and right_glued and has_prev and has_next else "—")
        elif ch in PARENS_OPEN:
            out.append("o" if offset + i in unmatched else "(")
        elif ch in PARENS_CLOSE:
            out.append("o" if offset + i in unmatched else ")")
        else:
            out.append("o")
        i += 1
    norm = "".join(out)
    return norm.replace(" ", ""), norm


def gap_offset(words, k):
    return words[k - 1].end() if k > 0 else 0


def classify_change(src_classes, ref_classes):
    """Multiset difference of two class strings → (added, removed) as sorted strings."""
    a = Counter(ref_classes)
    b = Counter(src_classes)
    added = "".join(sorted((a - b).elements()))
    removed = "".join(sorted((b - a).elements()))
    return added, removed


def is_orthographic(added, removed):
    """Hyphen-only or «other»-symbol changes are not punctuation."""
    changed = set(added) | set(removed)
    return bool(changed) and (changed <= {"h"} or "o" in changed)


def gap_edits(src, ref):
    """Edits between two texts with identical words. Raises ValueError if words differ.

    Each edit: start/end in src, before/after, added/removed classes, type, pos, terminal.
    """
    sw, sg = split_words(src)
    rw, rg = split_words(ref)
    if [m.group() for m in sw] != [m.group() for m in rw]:
        raise ValueError("words differ")
    n = len(sw)
    su, ru = unmatched_parens(src), unmatched_parens(ref)
    edits = []
    for k in range(n + 1):
        if sg[k] == rg[k]:
            continue
        has_prev = k > 0
        has_next = k < n
        sc, sn = gap_classes(sg[k], has_prev, has_next, gap_offset(sw, k), su)
        rc, rn = gap_classes(rg[k], has_prev, has_next, gap_offset(rw, k), ru)
        if sn == rn:
            continue  # glyph-only difference
        added, removed = classify_change(sc, rc)
        if is_orthographic(added, removed):
            continue
        if not added and not removed:
            etype = "space"
        else:
            etype = "".join(sorted(set(added) | set(removed), key=lambda c: ",;:.…!?—hq()o".index(c)))
        pos = "start" if k == 0 else "end" if k == n else "mid"
        changed = set(added) | set(removed)
        terminal = pos == "end" and bool(changed) and changed <= TERMINAL_CLASSES
        # a sentence boundary that was already visible: only . ! ? … inserted before a capitalised word
        boundary = pos == "mid" and not removed and bool(added) and set(added) <= TERMINAL_CLASSES and sw[k].group()[0].isupper()
        start = sw[k - 1].end() if k > 0 else 0
        end = sw[k].start() if k < n else len(src)
        edits.append({
            "start": start, "end": end, "before": sg[k], "after": rg[k],
            "added": added, "removed": removed, "type": etype, "pos": pos, "terminal": terminal, "boundary": boundary,
        })
    return edits


# --- pair → case ------------------------------------------------------------------------------

def junk_reason(text):
    if "\n" in text or "\r" in text:
        return "newline"
    if MARKUP_RE.search(text):
        return "markup"
    if LATIN_WORD_RE.search(text):
        return "latin"
    words = WORD_RE.findall(text)
    if len(words) < MIN_WORDS or len(text) < MIN_CHARS:
        return "too_short"
    if len(words) > MAX_WORDS or len(text) > MAX_CHARS:
        return "too_long"
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "no_letters"
    cyr = sum(1 for c in letters if "Ѐ" <= c <= "ӿ")
    if cyr / len(letters) < MIN_CYR_RATIO:
        return "cyr_ratio"
    return None


def make_case(src_raw, ref_raw):
    """→ (status, payload). status: 'pure' | 'derived' | 'clean_only' | rejection reason.

    For 'pure'/'derived', payload = {src, ref, edits, origSrc?}; for 'clean_only', payload = ref.
    """
    src = normalize_text(src_raw)
    ref = normalize_text(ref_raw)
    reason = junk_reason(ref)
    if reason:
        return reason, None
    if "\n" in src_raw or "\r" in src_raw:
        return "newline", None
    if src == ref:
        return "clean_only", ref
    sw, sg = split_words(src)
    rw, rg = split_words(ref)
    s_words = [m.group() for m in sw]
    r_words = [m.group() for m in rw]
    if s_words == r_words:
        edits = gap_edits(src, ref)
        if not edits:
            return "clean_only", ref
        return "pure", {"src": src, "ref": ref, "edits": edits}
    sm = SequenceMatcher(None, [word_key(w) for w in s_words], [word_key(w) for w in r_words], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("insert", "delete") or (tag == "replace" and i2 - i1 != j2 - j1):
            return "word_struct", ref
    if len(s_words) != len(r_words):
        return "word_struct", ref
    # same word count: rebuild the source with corrected words and original punctuation
    n = len(r_words)
    su, ru = unmatched_parens(src), unmatched_parens(ref)
    parts = []
    for k in range(n + 1):
        has_prev, has_next = k > 0, k < n
        sc, sn = gap_classes(sg[k], has_prev, has_next, gap_offset(sw, k), su)
        rc, rn = gap_classes(rg[k], has_prev, has_next, gap_offset(rw, k), ru)
        keep_src = False
        if sn != rn:
            added, removed = classify_change(sc, rc)
            keep_src = not is_orthographic(added, removed)
        parts.append(sg[k] if keep_src else rg[k])
        if k < n:
            parts.append(r_words[k])
    derived = normalize_text("".join(parts))
    if derived == ref:
        return "clean_only", ref
    try:
        edits = gap_edits(derived, ref)
    except ValueError:
        return "word_struct", ref
    if not edits:
        return "clean_only", ref
    return "derived", {"src": derived, "ref": ref, "edits": edits, "origSrc": src}


# --- readers ----------------------------------------------------------------------------------

def read_russian_gec(raw):
    path = os.path.join(raw, "russian_gec", "russian_gec.csv")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            yield row.get("incorrect", ""), row.get("correct", ""), "gec"


def read_sage(raw):
    base = os.path.join(raw, "sage")
    if not os.path.isdir(base):
        return
    for sub in sorted(os.listdir(base)):
        d = os.path.join(base, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(d, name), encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    domain = row.get("domain") or sub
                    yield row.get("source", ""), row.get("correction", ""), f"{sub}/{domain}" if domain != sub else sub


NO_SPACE_BEFORE = set(",.;:!?…)»”’")
NO_SPACE_AFTER = set("(«“‘")


def detokenize(tokens):
    """Join M2 tokens with Russian spacing conventions; straight quotes alternate open/close."""
    out = ""
    quote_open = False
    for tok in tokens:
        if not tok:
            continue
        if tok == '"':
            if quote_open:
                out += tok
            else:
                out += (" " if out and not out.endswith(" ") and out[-1] not in NO_SPACE_AFTER else "") + tok
            quote_open = not quote_open
            continue
        if not out:
            out = tok
            continue
        if tok[0] in NO_SPACE_BEFORE or out[-1] in NO_SPACE_AFTER or (out[-1] == '"' and quote_open):
            out += tok
        else:
            out += " " + tok
    return out


def parse_m2(text):
    """M2 → (source_tokens, reference_tokens) pairs using the lowest annotator id."""
    blocks = re.split(r"\n\s*\n", text.strip())
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if not lines or not lines[0].startswith("S "):
            continue
        src_tokens = lines[0][2:].split()
        by_annot = {}
        for ln in lines[1:]:
            if not ln.startswith("A "):
                continue
            fields = ln[2:].split("|||")
            if len(fields) < 3:
                continue
            span = fields[0].split()
            if len(span) != 2:
                continue
            start, end = int(span[0]), int(span[1])
            etype = fields[1]
            if etype in ("noop", "Um", "UNK"):
                continue
            corr = fields[2]
            annot = fields[5].strip() if len(fields) > 5 else "0"
            by_annot.setdefault(annot, []).append((start, end, corr))
        if not by_annot:
            yield src_tokens, list(src_tokens)
            continue
        annot = sorted(by_annot, key=lambda a: (len(a), a))[0]
        ref_tokens = list(src_tokens)
        for start, end, corr in sorted(by_annot[annot], key=lambda e: (e[0], e[1]), reverse=True):
            if start < 0 or end > len(src_tokens) or start > end:
                continue
            repl = corr.split() if corr and corr != "-NONE-" else []
            ref_tokens[start:end] = repl
        yield src_tokens, ref_tokens


def read_m2_dir(raw, key, domain):
    d = os.path.join(raw, key)
    if not os.path.isdir(d):
        return
    for name in sorted(os.listdir(d)):
        if not name.lower().endswith(".m2"):
            continue
        with open(os.path.join(d, name), encoding="utf-8") as f:
            for src_tokens, ref_tokens in parse_m2(f.read()):
                yield detokenize(src_tokens), detokenize(ref_tokens), f"{domain}/{name}"


READERS = {
    "russian_gec": read_russian_gec,
    "sage": read_sage,
    "rulec": lambda raw: read_m2_dir(raw, "rulec", "rulec"),
    "ru-lang8": lambda raw: read_m2_dir(raw, "ru-lang8", "ru-lang8"),
}


# --- build ------------------------------------------------------------------------------------

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def assign_splits(items, seed):
    """Per-source seeded shuffle, first 70 % → dev."""
    by_source = {}
    for it in items:
        by_source.setdefault(it["source"], []).append(it)
    out = []
    for source in sorted(by_source):
        group = by_source[source]
        rnd = random.Random(f"{seed}:{source}")
        rnd.shuffle(group)
        cut = int(round(len(group) * DEV_SHARE))
        for i, it in enumerate(group):
            it["split"] = "dev" if i < cut else "test"
            out.append(it)
    return out


def write_jsonl(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def build(raw, out, seed):
    os.makedirs(out, exist_ok=True)
    cases = []
    clean = {}
    rejects = Counter()
    per_source = {}
    seen_pairs = set()
    for source, reader in READERS.items():
        n_rows = 0
        for src_raw, ref_raw, domain in reader(raw) or []:
            n_rows += 1
            status, payload = make_case(src_raw, ref_raw)
            st = per_source.setdefault(source, Counter())
            st["rows"] += 1
            if status in ("pure", "derived"):
                key = (payload["src"], payload["ref"])
                if key in seen_pairs:
                    st["dup"] += 1
                    continue
                seen_pairs.add(key)
                st[status] += 1
                cases.append({
                    "id": f"{source}:{len(cases)}", "source": source, "domain": domain, "kind": status,
                    **payload,
                })
                ref = payload["ref"]
            elif status in ("clean_only", "word_struct"):
                st[status] += 1
                ref = payload
            else:
                st[f"reject:{status}"] += 1
                rejects[status] += 1
                continue
            ck = word_key(ref)
            if ck not in clean:
                clean[ck] = {"id": f"{source}:c{len(clean)}", "source": source, "domain": domain, "text": ref}
        log(f"{source}: {n_rows} rows → {per_source.get(source, Counter())}")
    cases = assign_splits(cases, seed)
    clean_items = assign_splits(list(clean.values()), seed)
    # ids follow the final order so a case can be quoted by id
    for i, it in enumerate(cases):
        it["id"] = f"{it['source']}:{i}"
    write_jsonl(os.path.join(out, "punct.jsonl"), cases)
    write_jsonl(os.path.join(out, "clean.jsonl"), clean_items)
    stats = summarize(cases, clean_items, per_source, rejects, raw)
    with open(os.path.join(out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    return cases, clean_items, stats


def summarize(cases, clean_items, per_source, rejects, raw):
    def count_edits(items):
        c = Counter()
        for it in items:
            for e in it["edits"]:
                c["all"] += 1
                c["terminal" if e["terminal"] else "boundary" if e["boundary"] else "non_terminal"] += 1
        return c

    stats = {
        "built": date.today().isoformat(),
        "seed": SEED,
        "sources_manifest": os.path.join(raw, "sources.json"),
        "cases": {"total": len(cases)},
        "clean": {"total": len(clean_items)},
        "per_source": {k: dict(v) for k, v in per_source.items()},
        "rejects": dict(rejects),
        "edit_types": {},
    }
    for split in ("dev", "test"):
        sub = [it for it in cases if it["split"] == split]
        ec = count_edits(sub)
        stats["cases"][split] = {
            "items": len(sub),
            "pure": sum(1 for it in sub if it["kind"] == "pure"),
            "derived": sum(1 for it in sub if it["kind"] == "derived"),
            "edits": ec["all"], "edits_headline": ec["non_terminal"], "edits_terminal": ec["terminal"], "edits_boundary": ec["boundary"],
            "by_source": dict(Counter(it["source"] for it in sub)),
        }
        stats["clean"][split] = {
            "items": sum(1 for it in clean_items if it["split"] == split),
            "by_source": dict(Counter(it["source"] for it in clean_items if it["split"] == split)),
        }
    types = Counter()
    for it in cases:
        for e in it["edits"]:
            types[("terminal:" if e["terminal"] else "boundary:" if e["boundary"] else "") + e["type"]] += 1
    stats["edit_types"] = dict(types.most_common())
    stats["domains"] = dict(Counter(f"{it['source']}:{it['domain']}" for it in cases).most_common())
    return stats


def print_sample(cases, n, seed):
    rnd = random.Random(seed)
    for it in rnd.sample(cases, min(n, len(cases))):
        print(f"--- {it['id']} [{it['kind']}, {it['domain']}, {it['split']}]")
        print("  src:", it["src"])
        print("  ref:", it["ref"])
        for e in it["edits"]:
            print(f"  edit {e['start']}-{e['end']} {e['type']!r} {e['before']!r} → {e['after']!r}" + (" (terminal)" if e["terminal"] else " (boundary)" if e["boundary"] else ""))


# --- self-test --------------------------------------------------------------------------------

def selftest():
    def edits_of(a, b):
        status, payload = make_case(a, b)
        return status, payload

    st, p = edits_of("Я думаю что он придёт завтра.", "Я думаю, что он придёт завтра.")
    assert st == "pure", st
    assert len(p["edits"]) == 1 and p["edits"][0]["type"] == "," and p["edits"][0]["added"] == ",", p["edits"]
    assert p["src"][p["edits"][0]["start"]:p["edits"][0]["end"]] == " "

    st, p = edits_of("Москва - столица России", "Москва — столица России.")
    assert st == "pure", st
    types = sorted(e["type"] for e in p["edits"])
    assert types == ["."], (types, p["edits"])  # «-» spaced == dash: glyph-only; final period is terminal
    assert p["edits"][0]["terminal"] is True

    st, p = edits_of("кто то пришёл домой поздно", "кто-то пришёл домой поздно")
    assert st == "clean_only", st  # hyphen = orthography

    st, p = edits_of("давольно милый и летом и зимой обогреваемый теплым солнушком",
                     "Довольно милый, и летом, и зимой обогреваемый тёплым солнышком.")
    assert st == "derived", st
    assert p["src"] == "Довольно милый и летом и зимой обогреваемый тёплым солнышком", p["src"]
    assert [e["type"] for e in p["edits"]] == [",", ",", "."], p["edits"]
    assert p["edits"][2]["terminal"] and not p["edits"][0]["terminal"]

    st, p = edits_of("контроль вход был строгим", "контроль на входе был строгим")
    assert st == "word_struct", st

    st, p = edits_of("он сказал \"привет\" и ушёл", "он сказал «привет» и ушёл")
    assert st == "clean_only", st  # quote glyphs are one class

    st, p = edits_of("Пожалуйста выберите чат , чтобы начать", "Пожалуйста, выберите чат, чтобы начать")
    assert st == "pure" and [e["type"] for e in p["edits"]] == [",", "space"], p["edits"]

    st, p = edits_of("Это было в 2010-2012 годах", "Это было в 2010–2012 годах")
    assert st == "clean_only", st  # glued en dash == hyphen class

    st, p = edits_of("Наследственность не отягощена Вредные привычки отрицает",
                     "Наследственность не отягощена. Вредные привычки отрицает.")
    assert st == "pure" and p["edits"][0]["boundary"] and not p["edits"][0]["terminal"], p["edits"]
    assert p["edits"][1]["terminal"] and not p["edits"][1]["boundary"], p["edits"]

    st, p = edits_of("Может это она. Может весь театр", "Может, это она? Может, весь театр")
    assert st == "pure" and [e["type"] for e in p["edits"]] == [",", ".?", ","] and not any(e["boundary"] for e in p["edits"]), p["edits"]

    st, p = edits_of("Результат на лице налицо )", "Результат на лице налицо.")
    assert st == "clean_only", st  # emoticon «)» is not punctuation; the final period alone is dropped with it

    st, p = edits_of("Он пришёл (наконец-то) домой", "Он пришёл, наконец-то, домой")
    assert st == "pure" and [e["type"] for e in p["edits"]] == [",(", ",)"], (st, p)

    assert junk_reason("Hello мир, это test") == "latin"
    assert junk_reason("слово <b>жирное</b> тут") == "markup"
    assert junk_reason("два слова") == "too_short"

    m2 = ("S Я думаю что он придёт .\n"
          "A 2 2|||Пунктуация|||,|||REQUIRED|||-NONE-|||0\n\n"
          "S Он пошол домой , и уснул .\n"
          "A 1 2|||Орфография|||пошёл|||REQUIRED|||-NONE-|||0\n"
          "A 3 4|||Пунктуация||||||REQUIRED|||-NONE-|||0\n")
    pairs = list(parse_m2(m2))
    assert detokenize(pairs[0][0]) == "Я думаю что он придёт." and detokenize(pairs[0][1]) == "Я думаю, что он придёт.", pairs[0]
    assert detokenize(pairs[1][1]) == "Он пошёл домой и уснул.", detokenize(pairs[1][1])
    st, p = make_case(detokenize(pairs[1][0]), detokenize(pairs[1][1]))
    assert st == "derived" and p["src"] == "Он пошёл домой, и уснул." and p["edits"][0]["removed"] == ",", (st, p)
    print("selftest ok")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default=DEFAULT_RAW, help="raw corpora directory (default .cache/eval/raw)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output directory (default .cache/eval)")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--sample", type=int, default=0, help="print N random cases after building")
    ap.add_argument("--selftest", action="store_true", help="run built-in checks and exit")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if not os.path.isdir(args.raw):
        log(f"no raw data at {args.raw} — run scripts/eval/fetch.py first")
        return 1
    cases, clean_items, stats = build(args.raw, args.out, args.seed)
    log(f"cases: {stats['cases']} ")
    log(f"clean: {stats['clean']}")
    log(f"edit types: {stats['edit_types']}")
    log(f"rejects: {stats['rejects']}")
    log(f"written {os.path.join(args.out, 'punct.jsonl')}, clean.jsonl, stats.json")
    if args.sample:
        print_sample(cases, args.sample, args.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
