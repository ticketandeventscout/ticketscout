// ===========================
// TicketScout — TicketNetwork catalog cache (Catalog 896)
// Runs as a Cloudflare Pages Function at /api/ticketnetwork-cache
//
// Downloads TicketNetwork Product Catalog (896) from GitHub
// Catalog 896 columns: EventID, Event, Performer, Venue, DateTime,
// PCat, CCat, GCat, City, PriceRange, IMAGEURL, URLLink, RemainingTicketQty
//
// Uses streaming decompression to stay under Cloudflare memory limits
//
// Required env vars: GITHUB_OWNER, GITHUB_REPO, GIGSBERG_KV
// ===========================

const FEED_PATH  = 'public/ticketnetwork-feed-896.csv.gz';
const KV_TTL     = 8 * 24 * 60 * 60;
const CHUNK_MB   = 20;

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const kv    = env.GIGSBERG_KV;
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;

  // ── Diagnostic: search live cached chunks by name (before trigger gate) ──
  // ?find=chelsea  → matches with their category (g) field.
  {
    const findTerm = (url.searchParams.get('find') || '').toLowerCase().trim();
    if (findTerm) {
      if (!kv) return json({ error: 'Missing GIGSBERG_KV' }, 500);
      const cntRaw = await kv.get('tn:catalog:chunks');
      if (!cntRaw) return json({ error: 'No catalog — run ?trigger=1 first' }, 200);
      const n = parseInt(cntRaw, 10);
      const raws = await Promise.all(Array.from({ length: n }, (_, i) => kv.get(`tn:catalog:chunk:${i}`)));
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
    const updated = await kv?.get('tn:catalog:updated').catch(() => null);
    const stats   = await kv?.get('tn:catalog:stats').catch(() => null);
    return text([
      'TicketNetwork catalog cache (896)',
      `  Feed: https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`,
      '  ?trigger=1        — build KV index',
      '  ?trigger=1&test=1 — connectivity test',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!owner || !repo) return json({ error: 'Missing GITHUB_OWNER or GITHUB_REPO' }, 500);
  if (!kv)             return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`;

  if (url.searchParams.get('test') === '1') {
    const r = await fetch(feedUrl, { method: 'HEAD' });
    return json({ url: feedUrl, status: r.status, ok: r.ok, size: r.headers.get('content-length') }, 200);
  }

  const feedResp = await fetch(feedUrl);
  if (!feedResp.ok) return json({ error: `Feed download failed: HTTP ${feedResp.status}` }, 500);

  try {
    // Stream decompress
    const ds      = new DecompressionStream('gzip');
    const stream  = feedResp.body.pipeThrough(ds);
    const reader  = stream.getReader();
    const decoder = new TextDecoder('utf-8');

    let buffer  = '';
    let header  = null;
    let colMap  = null;
    const index = [];
    const discoverCounts = new Map();   // autodiscovery: performer frequencies
    const today = new Date().toISOString().split('T')[0];

    const processLine = (line) => {
      if (!line.trim()) return;
      const cols = parseCSVLine(line);

      if (!header) {
        header = cols;
        // Build column index map
        const col = name => header.findIndex(
          h => h.toLowerCase().replace(/[\s_]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
        );
        colMap = {
          name:   col('event'),
          performer: col('performer'),   // cleaner discovery signal than event name
          url:    col('urllink'),
          date:   col('datetime'),
          venue:  col('venue'),
          city:   col('city'),
          cat:    col('pcat'),
          price:  col('pricerange'),
          image:  col('imageurl'),
          qty:    col('remainingticketqty'),
          tickets: col('ticketsyn'),
        };
        return;
      }

      const { name: iN, url: iU, date: iD, venue: iV, city: iC,
              cat: iG, price: iP, image: iI, qty: iQ, tickets: iT } = colMap;

      const name = (cols[iN] || '').trim();
      const url  = (cols[iU] || '').trim();
      const date = (cols[iD] || '').trim().split('T')[0];

      if (!name || !url) return;
      if (date && date < today) return;
      if (iQ !== -1 && cols[iQ] === '0') return;
      if (iT !== -1 && cols[iT] === 'NoTickets') return;

      let price = null;
      if (iP !== -1 && cols[iP]) {
        const p = parseFloat(cols[iP].replace(/[^\d.]/g, ''));
        if (p > 0) price = p;
      }

      // Autodiscovery: prefer the explicit Performer column over event name
      const performerName = colMap.performer !== -1 ? (cols[colMap.performer] || '').trim() : name;
      discoverCollect(discoverCounts, performerName || name, iG !== -1 ? (cols[iG] || '') : '');

      index.push({
        n: name,
        u: url,
        p: price,
        c: 'USD',
        d: date,
        v: iV !== -1 ? (cols[iV] || '').trim() : '',
        t: iC !== -1 ? (cols[iC] || '').trim() : '',
        g: iG !== -1 ? (cols[iG] || '').trim() : '',
      });
    };

    // Stream read
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      // Process complete lines from buffer
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        processLine(buffer.slice(0, nlIdx));
        buffer = buffer.slice(nlIdx + 1);
      }

      if (done) {
        if (buffer.trim()) processLine(buffer);
        break;
      }
    }

    // Split into 20MB chunks
    const chunks = [];
    let chunk = [], chunkBytes = 0;
    const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;

    for (const item of index) {
      const s = JSON.stringify(item);
      if (chunkBytes + s.length > CHUNK_BYTES && chunk.length > 0) {
        chunks.push(chunk); chunk = []; chunkBytes = 0;
      }
      chunk.push(item); chunkBytes += s.length;
    }
    if (chunk.length > 0) chunks.push(chunk);

    const puts = chunks.map((ch, i) =>
      kv.put(`tn:catalog:chunk:${i}`, JSON.stringify(ch), { expirationTtl: KV_TTL })
    );
    const stats = { total: index.length, chunks: chunks.length, updated: new Date().toISOString() };
    puts.push(kv.put('tn:catalog:chunks',  String(chunks.length),   { expirationTtl: KV_TTL }));
    puts.push(kv.put('tn:catalog:stats',   JSON.stringify(stats),   { expirationTtl: KV_TTL }));
    puts.push(kv.put('tn:catalog:updated', new Date().toISOString(), { expirationTtl: KV_TTL }));
    await Promise.all(puts);

    // Autodiscovery: queue new performers found in this feed refresh
    const discovered = await discoverQueue(kv, discoverCounts, 'ticketnetwork-feed');

    return json({
      success: true,
      total:   index.length,
      chunks:  chunks.length,
      sample:  index.slice(0, 2),
      updatedAt: new Date().toISOString()
    }, 200);

  } catch(err) {
    return json({ error: String(err) }, 500);
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else { current += ch; }
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
