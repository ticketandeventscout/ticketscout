// ===========================
// TicketScout — TicketNetwork catalog cache
// Runs as a Cloudflare Pages Function at /api/ticketnetwork-cache
//
// Downloads TicketNetwork feed CSV from GitHub (committed from Impact FTP)
// FTP: products.impact.com / ps-ftp_7443544 / [IMPACT_FTP_PASS]
// Feed: /TicketNetwork-Affiliate-Program/Ticketnetwork-Product-Catalog-API_CUSTOM.csv.gz
// GitHub path: public/ticketnetwork-feed.csv.gz
//
// Field mapping (catalog 1872 API format):
//   NAME         → event name
//   URL          → affiliate tracking link (already contains ad ID 267961)
//   LAUNCH_DATE  → event date
//   VENUE        → venue name (in Labels column)
//   CITY         → city (in Gtin column in API, or CITY in CSV)
//   CATEGORY     → SPORTS/THEATRE/CONCERTS
//   PRICE        → from Text1 "$82.50- $82.50" or dedicated PRICE column
//
// Usage:
//   ?trigger=1        — download from GitHub, parse, store KV
//   ?trigger=1&test=1 — connectivity test only
//
// Required env vars: GITHUB_OWNER, GITHUB_REPO, GIGSBERG_KV
// ===========================

const FEED_PATH = 'public/ticketnetwork-feed.csv.gz';
const KV_INDEX  = 'tn:catalog:index';
const KV_CHUNKS = 'tn:catalog:chunks';
const KV_UPDATED = 'tn:catalog:updated';
const KV_STATS  = 'tn:catalog:stats';
const KV_TTL    = 8 * 24 * 60 * 60; // 8 days
const TRACKING  = 'https://ticketnetwork.lusg.net/c/7443544/120057/2322';

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const kv    = env.GIGSBERG_KV;
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'TicketNetwork catalog cache',
      `  Feed: https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`,
      '  ?trigger=1        — download feed, parse, store KV',
      '  ?trigger=1&test=1 — connectivity test only',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!owner || !repo) return json({ error: 'Missing GITHUB_OWNER or GITHUB_REPO' }, 500);
  if (!kv)             return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`;

  // Connectivity test
  if (url.searchParams.get('test') === '1') {
    try {
      const r = await fetch(feedUrl, { method: 'HEAD' });
      return json({ url: feedUrl, status: r.status, ok: r.ok, size: r.headers.get('content-length'), type: r.headers.get('content-type') }, 200);
    } catch(e) {
      return json({ url: feedUrl, error: String(e) }, 200);
    }
  }

  try {
    const feedResp = await fetch(feedUrl);
    if (!feedResp.ok) {
      return json({ error: `Feed download failed: HTTP ${feedResp.status}`, url: feedUrl, hint: 'Commit public/ticketnetwork-feed.csv.gz to the repo first' }, 500);
    }

    // Decompress gzip
    const ds      = new DecompressionStream('gzip');
    const body    = feedResp.body.pipeThrough(ds);
    const reader  = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   rawText = '';

    while (rawText.length < 60 * 1024 * 1024) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rawText += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    const lines  = rawText.split('\n');
    const header = parseCSVLine(lines[0] || '');

    // Flexible column finder
    const col = name => header.findIndex(
      h => h.toLowerCase().replace(/[\s_"]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
    );

    // Try multiple column name formats for the API CSV
    const iName  = col('name')        !== -1 ? col('name')        : col('eventname');
    const iUrl   = col('url')         !== -1 ? col('url')         : col('deeplink');
    const iDate  = col('launchdate')  !== -1 ? col('launchdate')  :
                   col('eventdate')   !== -1 ? col('eventdate')   : col('date');
    const iPrice = col('text1')       !== -1 ? col('text1')       :
                   col('price')       !== -1 ? col('price')       : col('currentprice');
    const iVenue = col('labels')      !== -1 ? col('labels')      :
                   col('venue')       !== -1 ? col('venue')       : col('venuename');
    const iCity  = col('gtin')        !== -1 ? col('gtin')        :
                   col('city')        !== -1 ? col('city')        : col('location');
    const iCat   = col('category');

    console.log('Columns found:', { iName, iUrl, iDate, iPrice, iVenue, iCity, iCat, header: header.slice(0, 15) });

    const today = new Date();
    const index = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols  = parseCSVLine(lines[i]);
      const name  = iName !== -1 ? (cols[iName] || '').trim() : '';
      const rawUrl = iUrl !== -1 ? (cols[iUrl]  || '').trim() : '';
      const date  = iDate !== -1 ? (cols[iDate] || '').trim().split('T')[0] : '';

      if (!name || !rawUrl) continue;
      if (date && new Date(date) < today) continue;

      // URL may already have affiliate tracking, or may need wrapping
      const url = rawUrl.includes('ticketnetwork.lusg.net') || rawUrl.includes('lusg.net')
        ? rawUrl.replace(/&amp;/g, '&')
        : `${TRACKING}?u=${encodeURIComponent(rawUrl)}`;

      // Extract price from Text1 "$82.50- $82.50" or plain price field
      let price = null;
      if (iPrice !== -1 && cols[iPrice]) {
        const m = cols[iPrice].replace(/&amp;/g, '').match(/[\d.]+/);
        if (m) { const p = parseFloat(m[0]); if (p > 0) price = p; }
      }

      index.push({
        n: name,
        u: url,
        p: price,
        c: 'USD',
        d: date,
        v: iVenue !== -1 ? (cols[iVenue] || '').replace(/&amp;/g, '&') : '',
        t: iCity  !== -1 ? (cols[iCity]  || '') : '',
        g: iCat   !== -1 ? (cols[iCat]   || '') : '',
      });
    }

    // Split into 20MB KV chunks
    const CHUNK_BYTES = 20 * 1024 * 1024;
    const chunks = [];
    let chunk = [], chunkBytes = 0;

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
    const stats = { total: index.length, chunks: chunks.length, lines: lines.length, updated: new Date().toISOString() };
    puts.push(kv.put(KV_CHUNKS,  String(chunks.length),   { expirationTtl: KV_TTL }));
    puts.push(kv.put(KV_STATS,   JSON.stringify(stats),   { expirationTtl: KV_TTL }));
    puts.push(kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }));
    // Clear old cursor if any
    puts.push(kv.delete('tn:catalog:cursor').catch(() => {}));
    await Promise.all(puts);

    return json({
      success: true,
      total:   index.length,
      chunks:  chunks.length,
      sizeMB:  (rawText.length / 1024 / 1024).toFixed(2),
      sample:  index.slice(0, 2),
      columns: header.slice(0, 12),
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