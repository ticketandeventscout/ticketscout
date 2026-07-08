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
      const name   = iName !== -1 ? (cols[iName] || '').trim() : '';
      const url    = iUrl  !== -1 ? (cols[iUrl]  || '').trim() : '';
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
    const stats     = { total: index.length, feedUrl, updated: new Date().toISOString() };

    await Promise.all([
      kv.put(KV_INDEX,   indexJson,               { expirationTtl: KV_TTL }),
      kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }),
      kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }),
    ]);

    return json({
      success:   true,
      total:     index.length,
      sizeMB:    (indexJson.length / 1024 / 1024).toFixed(2),
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
