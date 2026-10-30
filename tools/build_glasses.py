"""
Build docs/js/glasses-data.js from data/riedel_guide.json.

data/riedel_guide.json holds, per RIEDEL Wine Glass Guide entry (grape or wine style),
the page URL and the RIEDEL glasses the page recommends, as listed on riedel.com.

The glass shape of an entry is the most frequent shape among its recommended glasses;
shapes with at least ALSO_RATIO of its votes are kept as "also" (RIEDEL's collections differ).
Each glass name is split at "/" (e.g. "Riesling / Zinfandel" is one glass, the Riesling
shape); a glass counts once, spread evenly over the shapes in its name. RIEDEL's
"wine friendly" glasses (GRAPE@RIEDEL, glasses for any wine) carry no shape and are ignored.

Usage:
    python3 tools/build_glasses.py            # write docs/js/glasses-data.js
    python3 tools/build_glasses.py --report   # also print the votes per entry
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'riedel_guide.json'
OUT = ROOT / 'docs' / 'js' / 'glasses-data.js'
INDEX_URL = 'https://www.riedel.com/en-int/wine-glass-guide'
# A second shape is shown ("also ...") when it gets at least this share of the leading shape's votes.
ALSO_RATIO = 0.75

# Glasses that fit any wine; they say nothing about the shape.
GENERIC = re.compile(r'grape@riedel|wine friendly|white wine / champagne glass|\bred wine\b|\bwhite wine\b|'
                     r'all-purpose|decanter$', re.I)

# Shape of one part of a glass name. First match wins; order matters.
# Shape labels follow RIEDEL's Veritas names, which pair grapes that share a glass
# ("Riesling / Zinfandel", "Pinot Noir / Nebbiolo"), so unexpected matches stay readable.
SHAPES = [
    (r'oaked chardonnay|montrachet', 'Oaked Chardonnay'),
    (r'chardonnay|viognier|chablis', 'Viognier / Chardonnay'),
    (r'riesling|zinfandel', 'Riesling / Zinfandel'),
    (r'sauvignon blanc|loire|sauvignon', 'Sauvignon Blanc'),
    (r'nebbiolo|barolo|barbaresco|pinot noir|burgundy|bourgogne|\bpinot\b', 'Pinot Noir / Nebbiolo'),
    (r'cabernet|merlot|bordeaux', 'Cabernet / Merlot'),
    (r'syrah|shiraz|hermitage', 'Syrah / Shiraz'),
    (r'sangiovese|chianti|brunello', 'Sangiovese'),
    (r'tempranillo|rioja', 'Tempranillo'),
    (r'grenache|garnacha', 'Grenache'),
    (r'gew[uü]rztraminer', 'Gewürztraminer'),
    (r'veltliner', 'Grüner Veltliner'),
    (r'champagne|prestige cuv|sparkling|cuv[eé]e|sekt|prosecco|cava', 'Champagne Wine Glass'),
    (r'ros[eé]', 'Rosé'),
    (r'sauternes|dessert|sweet wine|ice ?wine|tokaj|beerenauslese', 'Sweet Wine'),
    (r'\bport\b|tawny', 'Port'),
    (r'sherry|copita|spirits', 'Sherry'),
    (r'madeira', 'Madeira'),
]
SHAPES = [(re.compile(p, re.I), name) for p, name in SHAPES]


def clean_title(t: str) -> str:
    t = re.sub(r'^\s*riedel\s+', '', t.strip(), flags=re.I)
    t = re.sub(r'\s*\((?:[^)]*(?:pack|set|colou?r|base|edition)[^)]*)\)\s*$', '', t, flags=re.I)
    return re.sub(r'\s+', ' ', t).strip()


def shapes_of(title: str) -> list[str]:
    if GENERIC.search(title):
        return []
    glass = re.split(r'\s+\+\s+', title)[0]          # "Veritas Riesling / Zinfandel + Mosel Decanter"
    # Sommeliers "Mature Bordeaux / Chablis / Chardonnay" is one white-wine glass.
    if re.search(r'mature bordeaux', glass, re.I) and re.search(r'chablis|chardonnay', glass, re.I):
        return ['Viognier / Chardonnay']
    found: list[str] = []
    for part in glass.split('/'):
        for rx, name in SHAPES:
            if rx.search(part):
                if name not in found:
                    found.append(name)
                break
    return found


def related(entry: str, shape: str) -> bool:
    """Does the shape name a grape or style that also appears in the entry name?"""
    e = entry.lower()
    words = [w for w in re.split(r'[ /]+', shape.lower()) if len(w) > 3 and w not in ('wine', 'glass')]
    return any(w in e for w in words)


def decide(products: list[str], entry: str = '') -> tuple[str | None, Counter]:
    votes: Counter = Counter()
    first_seen: dict[str, int] = {}
    for i, t in enumerate(products):
        s = shapes_of(t)
        for name in s:
            votes[name] += 1 / len(s)
            first_seen.setdefault(name, i)
    if not votes:
        return None, votes
    # Ties: prefer the shape named like the entry, then the shape listed first.
    best = max(votes.items(), key=lambda kv: (round(kv[1], 6), related(entry, kv[0]), -first_seen[kv[0]]))
    return best[0], votes


def main() -> None:
    report = '--report' in sys.argv
    raw = json.loads(SRC.read_text(encoding='utf-8'))
    entries: 'OrderedDict[str, dict]' = OrderedDict()
    problems = []
    for row in sorted(raw['entries'], key=lambda r: r['entry'].lower()):
        products = []
        for t in row.get('products') or []:
            c = clean_title(t)
            if c and c not in products:
                products.append(c)
        shape, votes = decide(products, row['entry'])
        if report:
            v = ', '.join(f'{k} {n:.1f}' for k, n in votes.most_common())
            print(f"{row['entry']:<34} -> {str(shape):<22} [{v}]")
        if not row.get('url') or not shape:
            problems.append(row['entry'])
        also = [k for k, n in votes.most_common() if k != shape and shape and n >= ALSO_RATIO * votes[shape]]
        entries[row['entry']] = {
            'url': row.get('url'),
            'shape': shape,
            'also': also,
            'glasses': [p for p in products if not GENERIC.search(p)],
        }
    data = {
        'source': 'RIEDEL Wine Glass Guide, riedel.com',
        'retrieved': raw.get('retrieved', ''),
        'index_url': INDEX_URL,
        'entries': entries,
    }
    js = ('/* Generated by tools/build_glasses.py from data/riedel_guide.json. Do not edit by hand. */\n'
          'var RIEDEL_GUIDE = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n'
          "if (typeof window !== 'undefined') { window.RIEDEL_GUIDE = RIEDEL_GUIDE; }\n"
          "if (typeof module !== 'undefined' && module.exports) { module.exports = RIEDEL_GUIDE; }\n")
    OUT.write_text(js, encoding='utf-8')
    print(f'{len(entries)} entries, {len(entries) - len(problems)} with a shape -> {OUT.relative_to(ROOT)}')
    if problems:
        print('without page or shape:', ', '.join(problems))


if __name__ == '__main__':
    main()
