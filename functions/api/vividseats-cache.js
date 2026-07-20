// ===========================
// TicketScout — Vivid Seats catalog cache builder
// Runs as a Cloudflare Pages Function at /api/vividseats-cache
//
// Fetches the Vivid Seats feed CSV from GitHub (where it is committed weekly
// by a GitHub Action that downloads it from Impact FTP automatically).
//
// Feed source: public/vividseats-feed.csv.gz in the GitHub repo
// GitHub raw URL: https://raw.githubusercontent.com/[owner]/[repo]/main/public/vividseats-feed.csv.gz
//
// Usage:
//   ?trigger=1        — parse feed and build KV index
//   ?trigger=1&test=1 — test GitHub URL connectivity only
//
// Required env vars (Cloudflare Pages → Settings → Variables):
//   GITHUB_OWNER   — GitHub username/org (already set for discover-pages.js)
//   GITHUB_REPO    — repo name (already set)
//   GIGSBERG_KV    — KV namespace binding (already set)
// ===========================

const FEED_PATH  = 'public/vividseats-feed.csv.gz';
const KV_INDEX   = 'vs:catalog:index';
const KV_UPDATED = 'vs:catalog:updated';
const KV_STATS   = 'vs:catalog:stats';
const KV_TTL     = 8 * 24 * 60 * 60; // 8 days

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const kv    = env.GIGSBERG_KV;
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;

  // ── Diagnostic: search live cached chunks by name (before trigger gate) ──
  // ?find=chelsea  → matches with their category (g) field, to see why a
  // non-football item slipped onto a football page.
  {
    const findTerm = (url.searchParams.get('find') || '').toLowerCase().trim();
    if (findTerm) {
      if (!kv) return json({ error: 'Missing GIGSBERG_KV' }, 500);
      const cntRaw = await kv.get('vs:catalog:chunks');
      if (!cntRaw) return json({ error: 'No catalog — run ?trigger=1 first' }, 200);
      const n = parseInt(cntRaw, 10);
      const raws = await Promise.all(Array.from({ length: n }, (_, i) => kv.get(`vs:catalog:chunk:${i}`)));
      const index = raws.flatMap(r => r ? JSON.parse(r) : []);
      const hits = index.filter(it => (it.n || '').toLowerCase().includes(findTerm));
      const byCat = {};
      hits.forEach(h => { byCat[h.g || '(none)'] = (byCat[h.g || '(none)'] || 0) + 1; });
      return json({
        query: findTerm, total: index.length, matchCount: hits.length,
        categories: byCat,
        sample: hits.slice(0, 25).map(h => ({ name: h.n, category: h.g, date: h.d, venue: h.v, city: h.t }))
      }, 200);
    }
  }

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'Vivid Seats catalog cache',
      '  ?trigger=1        — parse feed from GitHub, build KV index',
      '  ?trigger=1&test=1 — connectivity test only',
      '',
      `Feed URL: https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`,
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!owner || !repo) return json({ error: 'Missing GITHUB_OWNER or GITHUB_REPO env vars' }, 500);
  if (!kv)             return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`;

  // ── Connectivity test ──────────────────────────────────────────────────────
  if (url.searchParams.get('test') === '1') {
    try {
      const r = await fetch(feedUrl, { method: 'HEAD' });
      return json({
        url:    feedUrl,
        status: r.status,
        ok:     r.ok,
        size:   r.headers.get('content-length'),
        type:   r.headers.get('content-type')
      }, 200);
    } catch (e) {
      return json({ url: feedUrl, error: String(e) }, 200);
    }
  }

  // ── Download and parse ─────────────────────────────────────────────────────
  try {
    const feedResp = await fetch(feedUrl);
    if (!feedResp.ok) {
      return json({
        error: `Feed download failed: HTTP ${feedResp.status}`,
        url:   feedUrl,
        hint:  'Make sure public/vividseats-feed.csv.gz exists in the repo'
      }, 500);
    }

    // Decompress gzip stream
    const ds      = new DecompressionStream('gzip');
    const body    = feedResp.body.pipeThrough(ds);
    const reader  = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   rawText = '';

    while (rawText.length < 50 * 1024 * 1024) { // 50MB cap
      const chunk = await reader.read();
      if (chunk.done) break;
      rawText += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    // Parse CSV
    const lines  = rawText.split('\n');
    const header = lines[0] ? parseCSVLine(lines[0]) : [];

    // Normalise header names for flexible matching
    const col = name => header.findIndex(
      h => h.toLowerCase().replace(/[\s_"]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
    );

    // Map actual Vivid Seats CSV columns (flexible — works for both formats)
    const iName   = col('name');
    const iUrl    = col('url');
    // Price: try 'price' first (VS format), fall back to 'currentprice' (Impact standard)
    const iPrice  = col('price') !== -1 ? col('price') : col('currentprice');
    const iCurr   = col('currency');  // may not exist in VS feed (all USD)
    // Date: VS uses PRODUCTION_EXPIRATION_DATE
    const iExpiry = col('productionexpirationdate') !== -1
                      ? col('productionexpirationdate')
                      : col('expirationdate');
    // Venue/city: VS uses VENUE and CITY directly
    const iVenue  = col('venue') !== -1  ? col('venue')  : col('text1');
    const iCity   = col('city')  !== -1  ? col('city')   : col('text2');
    const iCat    = col('category');
    const iSubCat = col('subcategory') !== -1 ? col('subcategory') : -1;

    const today = new Date();
    const index = [];
    const discoverCounts = new Map();   // autodiscovery: performer frequencies

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols   = parseCSVLine(lines[i]);
      const name   = iName !== -1 ? (cols[iName] || '').trim() : '';
      const url    = iUrl  !== -1 ? (cols[iUrl]  || '').trim() : '';
      const expiry = iExpiry !== -1 ? (cols[iExpiry] || '').trim() : '';

      if (!name || !url) continue;
      if (expiry && new Date(expiry) < today) continue;

      discoverCollect(discoverCounts, name, iCat !== -1 ? (cols[iCat] || '') : '');

      index.push({
        n: name,
        u: url,
        p: iPrice  !== -1 && cols[iPrice]  ? parseFloat(cols[iPrice])  : null,
        c: iCurr   !== -1 && cols[iCurr]   ? cols[iCurr]               : 'USD',
        d: expiry  ? expiry.split('T')[0]                               : '',
        v: iVenue  !== -1 ? (cols[iVenue]  || '')                       : '',
        t: iCity   !== -1 ? (cols[iCity]   || '')                       : '',
        g: iCat    !== -1 ? (cols[iCat]    || '')                       : '',
        s: iSubCat !== -1 ? (cols[iSubCat] || '')                       : '',
      });
    }

    // Split index into 20MB chunks to stay under KV's 25MB per-value limit
    const CHUNK_SIZE_MB = 20;
    const chunks = [];
    let   chunk  = [];
    let   chunkBytes = 0;

    for (const item of index) {
      const itemStr = JSON.stringify(item);
      if (chunkBytes + itemStr.length > CHUNK_SIZE_MB * 1024 * 1024 && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(item);
      chunkBytes += itemStr.length;
    }
    if (chunk.length > 0) chunks.push(chunk);

    // Write each chunk to KV
    const puts = chunks.map((ch, i) =>
      kv.put(`vs:catalog:chunk:${i}`, JSON.stringify(ch), { expirationTtl: KV_TTL })
    );
    const stats = {
      total:  index.length,
      chunks: chunks.length,
      feedUrl,
      updated: new Date().toISOString()
    };
    puts.push(kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }));
    puts.push(kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }));
    // Store chunk count so vividseats.js knows how many to read
    puts.push(kv.put('vs:catalog:chunks', String(chunks.length), { expirationTtl: KV_TTL }));
    // Delete old single-key index if present
    puts.push(kv.delete(KV_INDEX).catch(() => {}));

    await Promise.all(puts);

    // Autodiscovery: queue new performers found in this feed refresh
    const discovered = await discoverQueue(kv, discoverCounts, 'vividseats-feed');

    return json({
      success:   true,
      total:     index.length,
      chunks:    chunks.length,
      sizeMB:    (JSON.stringify(index).length / 1024 / 1024).toFixed(2),
      columns:   header.slice(0, 10),
      sample:    index.slice(0, 2),
      updatedAt: new Date().toISOString()
    }, 200);

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

// ── Autodiscovery from feed rows (Awin pattern — zero extra fetches) ──
// Collects performer-name frequencies during the parse, then queues names
// seen on >= MIN_ROWS rows that aren't already known. Sports rows are
// EXCLUDED (US feeds carry NBA/NFL teams that don't belong in /football).
const DISCOVER_PENDING_KEY = 'autodiscover:awin:pending';   // shared queue — discover-pages commits it
const DISCOVER_KNOWN_KEY   = 'autodiscover:artists:known';
const DISCOVER_MIN_ROWS    = 3;    // name must appear on >= 3 rows (real touring act)
const DISCOVER_MAX_PER_RUN = 40;   // keep the pending queue sane

function discoverCollect(counts, name, category) {
  const cat = (category || '').toUpperCase();
  if (cat.includes('SPORT')) return;                       // never queue US sports
  const clean = (name || '').split(' - ')[0].split(' at ')[0].trim();
  if (clean.length < 3 || clean.length > 60) return;
  if (/\d{4}/.test(clean)) return;                         // tour-year strings etc
  if (/ vs\.? /i.test(clean)) return;                      // fixtures, not artists
  if (/tribute|experience of|celebrating/i.test(clean)) return;
  const isTheatre = cat.includes('THEAT');
  const key = clean.toLowerCase();
  const cur = counts.get(key) || { name: clean, rows: 0, theatre: 0 };
  cur.rows++; if (isTheatre) cur.theatre++;
  counts.set(key, cur);
}

async function discoverQueue(kv, counts, sourceLabel) {
  try {
    let known = new Set();
    try { const k = await kv.get(DISCOVER_KNOWN_KEY); if (k) known = new Set(JSON.parse(k)); } catch {}
    let pending = { artists: [], venues: [] };
    try { const p = await kv.get(DISCOVER_PENDING_KEY); if (p) pending = JSON.parse(p); } catch {}
    const pendingSlugs = new Set((pending.artists || []).map(a => a.slug));

    const candidates = [...counts.values()]
      .filter(c => c.rows >= DISCOVER_MIN_ROWS)
      .sort((a, b) => b.rows - a.rows);

    let queued = 0;
    for (const c of candidates) {
      if (queued >= DISCOVER_MAX_PER_RUN) break;
      const slug = toDiscoverSlug(c.name);
      if (!slug || slug.length < 3) continue;
      if (known.has(slug) || pendingSlugs.has(slug)) continue;
      const category = c.theatre > c.rows / 2 ? 'theatre' : 'concert';
      pending.artists = pending.artists || [];
      pending.artists.push({
        slug, name: c.name, search: c.name,
        genre: category === 'theatre' ? 'Theatre' : 'Live Events',
        category, source: sourceLabel,
        description: `Compare ${c.name} ticket prices across verified sellers.`
      });
      pendingSlugs.add(slug); queued++;
    }
    if (queued > 0) {
      pending.updated = new Date().toISOString();
      await kv.put(DISCOVER_PENDING_KEY, JSON.stringify(pending), { expirationTtl: 8 * 60 * 60 });
    }
    return queued;
  } catch { return 0; }
}

function toDiscoverSlug(name) {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
}
