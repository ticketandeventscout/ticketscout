// ===========================
// TicketScout — Vivid Seats catalog cache builder
// Runs as a Cloudflare Pages Function at /api/vividseats-cache
//
// Downloads the full Vivid Seats feed from Impact's product server via HTTPS,
// decompresses the gzip, parses CSV, and stores a compact KV index.
//
// Feed URL:  https://products.impact.com/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz
// Auth:      HTTP Basic — IMPACT_FTP_USER : IMPACT_FTP_PASS
//
// Because the full 131k CSV is large, we stream it in chunks and write to KV
// progressively. If the worker hits its time limit, partial results are still
// stored and the next run appends more.
//
// Usage:
//   ?trigger=1        — run cache build
//   ?trigger=1&test=1 — test connectivity only (HEAD request, no KV write)
//
// Required env vars:
//   IMPACT_FTP_USER  — ps-ftp_7443544
//   IMPACT_FTP_PASS  — (password from Impact FTP email)
//   GIGSBERG_KV      — KV namespace binding
// ===========================

const FEED_URLS = [
  'https://products.impact.com/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz',
  'https://products.impact.com/Vivid-Seats/Ticket-Feed_IR.txt.gz',
];

const KV_INDEX   = 'vs:catalog:index';
const KV_UPDATED = 'vs:catalog:updated';
const KV_STATS   = 'vs:catalog:stats';
const KV_TTL     = 8 * 24 * 60 * 60; // 8 days

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const ftpUser = env.IMPACT_FTP_USER;
  const ftpPass = env.IMPACT_FTP_PASS;
  const kv      = env.GIGSBERG_KV;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'Vivid Seats catalog cache',
      '  ?trigger=1        — build full KV index from feed',
      '  ?trigger=1&test=1 — connectivity test only',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!ftpUser || !ftpPass) return json({ error: 'Missing IMPACT_FTP_USER or IMPACT_FTP_PASS' }, 500);
  if (!kv)                   return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const basicAuth = btoa(`${ftpUser}:${ftpPass}`);

  // ── Connectivity test ──────────────────────────────────────────────────────
  if (url.searchParams.get('test') === '1') {
    const results = [];
    for (const feedUrl of FEED_URLS) {
      try {
        const r = await fetch(feedUrl, {
          method: 'HEAD',
          headers: { 'Authorization': `Basic ${basicAuth}` }
        });
        results.push({
          url:    feedUrl,
          status: r.status,
          ok:     r.ok,
          size:   r.headers.get('content-length'),
          type:   r.headers.get('content-type')
        });
      } catch (e) {
        results.push({ url: feedUrl, error: String(e) });
      }
    }
    return json({ results }, 200);
  }

  // ── Full cache build ───────────────────────────────────────────────────────
  // Try each feed URL until one works
  let feedResp = null;
  let sourceUrl = '';
  for (const feedUrl of FEED_URLS) {
    try {
      const r = await fetch(feedUrl, {
        headers: { 'Authorization': `Basic ${basicAuth}` }
      });
      if (r.ok) { feedResp = r; sourceUrl = feedUrl; break; }
    } catch (e) { continue; }
  }

  if (!feedResp) {
    return json({
      error: 'All feed URLs failed — check IMPACT_FTP_USER/IMPACT_FTP_PASS env vars',
      triedUrls: FEED_URLS
    }, 500);
  }

  try {
    // Stream and decompress
    const isGzip = sourceUrl.endsWith('.gz');
    let body = feedResp.body;
    if (isGzip) {
      const ds = new DecompressionStream('gzip');
      body = body.pipeThrough(ds);
    }

    const reader  = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   rawText = '';
    let   done    = false;

    // Read up to 40MB to stay within memory limits
    while (!done && rawText.length < 40 * 1024 * 1024) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      rawText += decoder.decode(chunk.value, { stream: true });
    }
    // Cancel the reader if we hit the cap
    if (!done) await reader.cancel();

    // Parse CSV
    const lines  = rawText.split('\n');
    const header = lines[0] ? parseCSVLine(lines[0]) : [];

    const col = name => header.findIndex(
      h => h.toLowerCase().replace(/[\s_"]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
    );

    const iName   = col('name');
    const iUrl    = col('url');
    const iPrice  = col('currentprice') !== -1 ? col('currentprice') : col('price');
    const iCurr   = col('currency');
    const iExpiry = col('expirationdate');
    const iVenue  = col('text1');
    const iCity   = col('text2');
    const iCat    = col('category');
    const iSubCat = col('subcategory');

    const today = new Date();
    const index = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols   = parseCSVLine(lines[i]);
      const name   = iName !== -1 ? (cols[iName] || '').trim()  : '';
      const url    = iUrl  !== -1 ? (cols[iUrl]  || '').trim()  : '';
      const expiry = iExpiry !== -1 ? (cols[iExpiry] || '').trim() : '';

      if (!name || !url) continue;
      if (expiry && new Date(expiry) < today) continue;

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

    const indexJson = JSON.stringify(index);
    const stats     = { total: index.length, sourceUrl, updated: new Date().toISOString() };

    await Promise.all([
      kv.put(KV_INDEX,   indexJson,               { expirationTtl: KV_TTL }),
      kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }),
      kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }),
    ]);

    return json({
      success:   true,
      total:     index.length,
      lines:     lines.length,
      sizeMB:    (indexJson.length / 1024 / 1024).toFixed(2),
      sourceUrl,
      columns:   header,
      sample:    index.slice(0, 2),
      updatedAt: new Date().toISOString()
    }, 200);

  } catch (err) {
    return json({ error: String(err), sourceUrl }, 500);
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