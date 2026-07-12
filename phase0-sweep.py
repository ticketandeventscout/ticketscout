#!/usr/bin/env python3
"""
TicketScout Phase 0 sweep — run from the REPO ROOT.

    python3 phase0-sweep.py            # report only (no changes)
    python3 phase0-sweep.py --write    # apply fixes

WHAT IT FIXES (--write):
  1. www.ticketscout.co.uk -> ticketscout.co.uk in every .html/.xml/.txt/.js/.md/.json
     (canonical host standardisation — the site serves at the apex; www 301s away)
  2. Bumps the template version string in every stub's fetch('/<tpl>.html?v=...')
     so the patched templates actually propagate past Cloudflare's per-URL cache:
        football.html -> v=20260712d
        concert.html  -> v=20260712a
        theatre.html  -> v=20260712a
        venue.html    -> v=20260712a

WHAT IT ONLY REPORTS (never auto-fixes — these need deliberate regeneration):
  A. Stubs missing <link rel="canonical">            (Hamilton-class drift)
  B. Stubs whose <title> is still "Loading..."
  C. Canonical URL path vs actual file path mismatches
  D. ORPHANS: .html files on disk not referenced by sitemap.xml
  E. GHOSTS:  sitemap URLs with no matching file on disk

Idempotent — safe to run repeatedly. Skips .git/, node_modules/, functions/ is INCLUDED
(functions .js files legitimately contain page URLs).
"""
import os, re, sys, xml.etree.ElementTree as ET

WRITE = '--write' in sys.argv
ROOT = os.getcwd()
SKIP_DIRS = {'.git', 'node_modules', '.wrangler', '__pycache__'}
TEXT_EXT = {'.html', '.xml', '.txt', '.js', '.md', '.json'}

NEW_VERSIONS = {
    'football': '20260712d',
    'concert':  '20260712a',
    'theatre':  '20260712a',
    'venue':    '20260712a',
}
VER_RE = re.compile(r"(fetch\('/(football|concert|theatre|venue)\.html\?v=)([0-9a-z]+)(')")
CANON_RE = re.compile(r'<link\s+rel="canonical"\s+href="https?://(?:www\.)?ticketscout\.co\.uk(/[^"]*)"')

def walk_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in TEXT_EXT:
                yield os.path.join(dirpath, fn)

# ---- load sitemap for orphan/ghost analysis -------------------------------
sitemap_paths = set()
sm_file = os.path.join(ROOT, 'sitemap.xml')
if os.path.exists(sm_file):
    try:
        raw = open(sm_file, encoding='utf-8').read()
        for m in re.finditer(r'<loc>https?://(?:www\.)?ticketscout\.co\.uk(/[^<]*)?</loc>', raw):
            sitemap_paths.add(m.group(1) or '/')
    except Exception as e:
        print(f'!! could not parse sitemap.xml: {e}')

def url_path_for_file(relpath):
    """repo file -> served URL path (Cloudflare Pages clean-URL rules)."""
    p = '/' + relpath.replace(os.sep, '/')
    if p.endswith('/index.html'):
        return p[:-len('index.html')].rstrip('/') or '/'
    if p.endswith('.html'):
        return p[:-5]
    return p

# ---- pass ------------------------------------------------------------------
www_fixed, ver_bumped = [], []
missing_canonical, loading_titles, canon_mismatch = [], [], []
html_files = {}

for path in walk_files():
    rel = os.path.relpath(path, ROOT)
    try:
        text = open(path, encoding='utf-8').read()
    except (UnicodeDecodeError, PermissionError):
        continue
    orig = text

    # Fix 1: apex host
    if 'www.ticketscout.co.uk' in text:
        text = text.replace('www.ticketscout.co.uk', 'ticketscout.co.uk')
        www_fixed.append(rel)

    # Fix 2: version bumps (stubs only — templates themselves contain no fetch line)
    def bump(m):
        tpl = m.group(2)
        return m.group(1) + NEW_VERSIONS[tpl] + m.group(4)
    text2, n = VER_RE.subn(bump, text)
    if n and text2 != text:
        ver_bumped.append((rel, n))
        text = text2

    if WRITE and text != orig:
        open(path, 'w', encoding='utf-8').write(text)

    # ---- audits (report-only), .html stubs beneath category dirs + root ----
    if rel.endswith('.html'):
        html_files[rel] = True
        base = os.path.basename(rel)
        if base in ('index.html',):
            continue
        is_template = base in ('football.html', 'concert.html', 'theatre.html', 'venue.html')
        if not is_template:
            if 'rel="canonical"' not in text:
                missing_canonical.append(rel)
            tm = re.search(r'<title>([^<]*)</title>', text)
            if tm and 'loading' in tm.group(1).lower():
                loading_titles.append(rel)
            cm = CANON_RE.search(text)
            if cm:
                canon_path = cm.group(1).rstrip('/')
                actual = url_path_for_file(rel).rstrip('/')
                if canon_path != actual:
                    canon_mismatch.append((rel, canon_path, actual))

# ---- orphans & ghosts -------------------------------------------------------
served = {url_path_for_file(rel): rel for rel in html_files}
orphans = sorted(rel for p, rel in served.items()
                 if p not in sitemap_paths
                 and os.path.basename(rel) not in
                 ('football.html','concert.html','theatre.html','venue.html','index.html','football-index.html','404.html'))
ghosts = sorted(p for p in sitemap_paths if p.rstrip('/') not in {s.rstrip('/') for s in served} and p != '/')

# ---- report -----------------------------------------------------------------
mode = 'WRITE MODE — changes applied' if WRITE else 'DRY RUN — nothing changed (add --write to apply)'
print(f'\n================ PHASE 0 SWEEP ({mode}) ================\n')
print(f'[FIX 1] apex-host replacements:  {len(www_fixed)} files')
print(f'[FIX 2] version bumps applied:   {len(ver_bumped)} stubs -> ' +
      ', '.join(f"{k}={v}" for k, v in NEW_VERSIONS.items()))
print(f'\n[AUDIT A] stubs missing canonical:      {len(missing_canonical)}')
for f in missing_canonical[:15]: print(f'    {f}')
if len(missing_canonical) > 15: print(f'    ... and {len(missing_canonical)-15} more')
print(f'\n[AUDIT B] stubs with "Loading" titles:  {len(loading_titles)}')
for f in loading_titles[:15]: print(f'    {f}')
if len(loading_titles) > 15: print(f'    ... and {len(loading_titles)-15} more')
print(f'\n[AUDIT C] canonical/path mismatches:    {len(canon_mismatch)}')
for f, c, a in canon_mismatch[:15]: print(f'    {f}: canonical says {c}, file serves {a}')
print(f'\n[AUDIT D] ORPHANS (on disk, not in sitemap): {len(orphans)}')
for f in orphans[:20]: print(f'    {f}')
if len(orphans) > 20: print(f'    ... and {len(orphans)-20} more')
print(f'\n[AUDIT E] GHOSTS (in sitemap, no file):      {len(ghosts)}')
for p in ghosts[:20]: print(f'    {p}')
print('\nNEXT STEPS: fix orphans/no-canonical stubs by regeneration (Audit A+B+D lists '
      'are your regeneration worklist) — do NOT hand-edit 200+ files. '
      'Ghosts (E) mean sitemap entries that 404: remove or create.\n')
# Machine-readable dump for the regeneration script
import json
with open('phase0-audit.json', 'w') as f:
    json.dump({'missing_canonical': missing_canonical, 'loading_titles': loading_titles,
               'canon_mismatch': canon_mismatch, 'orphans': orphans, 'ghosts': ghosts}, f, indent=2)
print('Full lists written to phase0-audit.json')
