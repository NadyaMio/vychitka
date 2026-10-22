#!/usr/bin/env python3
"""
Download the open Russian error-correction corpora used by the punctuation
benchmark into .cache/eval/raw/ (outside the repository; .cache/ is gitignored).

Sources
-------
  russian_gec   dreuxx26/russian_gec (Hugging Face) — CC BY 4.0.
                ~25 k sentence pairs «with errors → corrected», one CSV.
  sage          ai-forever/spellcheck_punctuation_benchmark (Hugging Face) —
                MIT per the dataset card (the loading script says Apache-2.0).
                RUSpellRU, MultidomainGold, MedSpellchecker, GitHubTypoCorpusRu:
                spelling AND punctuation corrected by ≥2 annotators.
  rulec         RULEC-GEC (github.com/arozovskaya/RULEC-GEC) — CC BY-SA 4.0,
                research use; the M2 files are sent by the author after a signed
                user agreement. Nothing to download: drop the files into
                .cache/eval/raw/rulec/ and build-punct-set.py picks them up.
  ru-lang8      RU-Lang8 (github.com/arozovskaya/RU-Lang8) — the repository holds
                no data (README only); same manual drop-in as RULEC.

Usage
-----
  python3 scripts/eval/fetch.py                 # everything that is downloadable
  python3 scripts/eval/fetch.py --only sage     # one source
  python3 scripts/eval/fetch.py --force         # re-download

Idempotent: a file that already exists with a non-zero size is skipped.
Every completed download is recorded in .cache/eval/raw/sources.json
(url, bytes, sha256, license, retrieved date) so the build step and the
report can cite exactly what was used.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUT = os.path.join(ROOT, ".cache", "eval", "raw")
USER_AGENT = "Vychitka-eval/0.1 (https://github.com/NadyaMio/vychitka)"
TIMEOUT = 120
RETRIES = 5
BACKOFF_START = 3

HF = "https://huggingface.co/datasets"
SAGE_BASE = f"{HF}/ai-forever/spellcheck_punctuation_benchmark/resolve/main/data"

SOURCES = {
    "russian_gec": {
        "title": "Russian GEC (dreuxx26/russian_gec)",
        "homepage": f"{HF}/dreuxx26/russian_gec",
        "license": "CC BY 4.0",
        "files": [
            {"url": f"{HF}/dreuxx26/russian_gec/resolve/main/russian_gec_dataset_final%20(1).csv", "name": "russian_gec.csv"},
        ],
    },
    "sage": {
        "title": "Russian Spellcheck Punctuation Benchmark (ai-forever, SAGE)",
        "homepage": f"{HF}/ai-forever/spellcheck_punctuation_benchmark",
        "license": "MIT (dataset card); Apache-2.0 in the loading script",
        "files": [
            {"url": f"{SAGE_BASE}/RUSpellRU/train.json", "name": "RUSpellRU/train.json"},
            {"url": f"{SAGE_BASE}/RUSpellRU/test.json", "name": "RUSpellRU/test.json"},
            {"url": f"{SAGE_BASE}/MultidomainGold/train.json", "name": "MultidomainGold/train.json"},
            {"url": f"{SAGE_BASE}/MultidomainGold/test.json", "name": "MultidomainGold/test.json"},
            {"url": f"{SAGE_BASE}/MedSpellchecker/test.json", "name": "MedSpellchecker/test.json"},
            {"url": f"{SAGE_BASE}/GitHubTypoCorpusRu/test.json", "name": "GitHubTypoCorpusRu/test.json"},
        ],
    },
    "rulec": {
        "title": "RULEC-GEC (Rozovskaya & Roth, 2018)",
        "homepage": "https://github.com/arozovskaya/RULEC-GEC",
        "license": "CC BY-SA 4.0 (research use, signed user agreement required)",
        "manual": "Email the signed «RULEC User Agreement.pdf» to the author, then put "
                  "RULEC-GEC.{train,dev,test}.M2 into this directory.",
        "expect": ["RULEC-GEC.train.M2", "RULEC-GEC.dev.M2", "RULEC-GEC.test.M2"],
    },
    "ru-lang8": {
        "title": "RU-Lang8 (Trinh & Rozovskaya, 2021)",
        "homepage": "https://github.com/arozovskaya/RU-Lang8",
        "license": "not stated in the repository (no data published there); ask the authors",
        "manual": "Obtain the M2 files from the authors and put them into this directory (*.M2 or *.m2).",
        "expect": [],
    },
}


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest(out):
    path = os.path.join(out, "sources.json")
    if not os.path.exists(path):
        return {"files": {}}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_manifest(out, manifest):
    path = os.path.join(out, "sources.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def download(url, dest):
    """Stream url → dest atomically; retries on network errors and 5xx/429."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    backoff = BACKOFF_START
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp, open(tmp, "wb") as f:
                total = 0
                for chunk in iter(lambda: resp.read(1 << 20), b""):
                    f.write(chunk)
                    total += len(chunk)
            if total == 0:
                raise OSError("empty response")
            os.replace(tmp, dest)
            return total
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < RETRIES:
                log(f"HTTP {e.code} for {url}, retry in {backoff} s ({attempt}/{RETRIES})")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < RETRIES:
                log(f"network error {e!r}, retry in {backoff} s ({attempt}/{RETRIES})")
                time.sleep(backoff)
                backoff *= 2
                continue
            raise
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    raise RuntimeError(f"unreachable: {url}")


def fetch_source(key, src, out, force, manifest):
    dir_ = os.path.join(out, key)
    os.makedirs(dir_, exist_ok=True)
    if "manual" in src:
        present = [n for n in os.listdir(dir_) if n.lower().endswith((".m2", ".sents"))]
        if present:
            log(f"{key}: {len(present)} file(s) present in {dir_}")
        else:
            log(f"{key}: no files — {src['manual']}  ({src['homepage']})")
        manifest["files"][key] = {
            "title": src["title"], "homepage": src["homepage"], "license": src["license"],
            "manual": True, "present": sorted(present), "dir": dir_,
        }
        return
    for item in src["files"]:
        dest = os.path.join(dir_, item["name"])
        rel = f"{key}/{item['name']}"
        if os.path.exists(dest) and os.path.getsize(dest) > 0 and not force:
            log(f"{rel}: cached ({os.path.getsize(dest):,} bytes)")
        else:
            log(f"{rel}: downloading {item['url']}")
            n = download(item["url"], dest)
            log(f"{rel}: {n:,} bytes")
        manifest["files"][rel] = {
            "title": src["title"], "homepage": src["homepage"], "license": src["license"],
            "url": item["url"], "bytes": os.path.getsize(dest), "sha256": sha256_of(dest),
            "retrieved": manifest["files"].get(rel, {}).get("retrieved") if not force and os.path.exists(dest) else None,
        }
        if not manifest["files"][rel]["retrieved"]:
            manifest["files"][rel]["retrieved"] = date.today().isoformat()
        save_manifest(out, manifest)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help="raw data directory (default .cache/eval/raw)")
    ap.add_argument("--only", choices=sorted(SOURCES), action="append", help="fetch only this source (repeatable)")
    ap.add_argument("--force", action="store_true", help="re-download existing files")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    manifest = load_manifest(args.out)
    keys = args.only or list(SOURCES)
    failed = []
    for key in keys:
        try:
            fetch_source(key, SOURCES[key], args.out, args.force, manifest)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, RuntimeError) as e:
            log(f"{key}: FAILED — {e!r}")
            failed.append(key)
    save_manifest(args.out, manifest)
    log(f"manifest: {os.path.join(args.out, 'sources.json')}")
    if failed:
        log(f"failed sources: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
