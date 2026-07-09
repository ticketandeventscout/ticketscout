// ===========================
// TicketScout — Ticombo catalog cache builder
// Runs as a Cloudflare Pages Function at /api/ticombo-cache
//
// Downloads Ticombo event feeds from Partnerize (feeds.performancehorizon.com)
// for each available campaign region, merges them into a single KV index.
//
// Feed URLs follow the pattern:
//   https://feeds.performancehorizon.com/ticketandeventscoutpartnerize/{campaignId}/{hash}
//
// Available feeds (from Partnerize Creative Overview):
//   Europe:    1011l6399 — hash provided by user
//   Germany:   1011l6400 — hash provided by user
//   Singapore: 1101l6348 — hash provided by user
//   Spain:     1100l6336 — hash provided by user
//   UK:        1100l6335 — hash provided by user
//
// Feed format: CSV similar to Vivid Seats — columns TBD from first download
//
// KV keys:
//   ticombo:catalog:index   — JSON array of compact event objects
//   ticombo:catalog:updated — ISO timestamp
//   ticombo:catalog:stats   — { total, updated, campaigns }
//
// Required env vars:
//   GIGSBERG_KV — KV namespace binding
//   (No auth needed — feed URLs are pre-authenticated via hash)
//
// Usage:
//   ?trigger=1        — download all feeds, build KV index
//   ?trigger=1&test=1 — test feed URL connectivity (HEAD requests only)
// ===========================

// Feed URLs confirmed from Partnerize Creative Overview dashboard
// Note: all 5 feeds share the same hash (a1f3f49c2e6d13ca6d33d24088acc238)
// US, APAC, LATAM, Mexico have no feeds available
const HASH = 'a1f3f49c2e6d13ca6d33d24088acc238';
const FEED_BASE = 'https://feeds.performancehorizon.com/ticketandeventscoutpartnerize';

const FEEDS = [
  { id: '1100l6335', region: 'UK',        camref: '1100l5P9x2', url: `${FEED_BASE}/1100l6335/${HASH}` },
  { id: '1011l6399', region: 'Europe',    camref: '1100l5P9wQ', url: `${FEED_BASE}/1011l6399/${HASH}` },
  { id: '1011l6400', region: 'Germany',   camref: '1100l5P9wR', url: `${FEED_BASE}/1011l6400/${HASH}` },
  { id: '1100l6336', region: 'Spain',     camref: '1100l5P9wT', url: `${FEED_BASE}/1100l6336/${HASH}` },
  { id: '1101l6348', region: 'Singapore', camref: '1100l5P9wS', url: `${FEED_BASE}/1101l6348/${HASH}` },
];

const KV_INDEX   = 'ticombo:catalog:index';
const KV_UPDATED = 'ticombo:catalog:updated';
const KV_STATS   = 'ticombo:catalog:stats';
const KV_TTL     = 8 * 24 * 60 * 60; // 8 days

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv  = env.GIGSBERG_KV;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'Ticombo catalog cache',
      `  Configured feeds: ${FEEDS.length}`,
      '  ?trigger=1        — download all feeds, build KV index',
      '  ?trigger=1&test=1 — connectivity test only',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  if (FEEDS.length === 0) {
    return json({ error: 'No feed URLs configured. Add feed URLs to the FEEDS array in ticombo-cache.js' }, 500);
  }

  // Connectivity test
  if (url.searchParams.get('test') === '1') {
    const apiKey  = env.PARTNERIZE_API_KEY;
    const userKey = env.PARTNERIZE_USER_KEY;
    const basicAuth = (apiKey && userKey) ? btoa(`${userKey}:${apiKey}`) : null;

    const results = [];
    for (const feed of FEEDS) {
      // Try 4 auth approaches for each feed
      const attempts = [
        { label: 'no auth',      headers: {} },
        { label: 'basic auth',   headers: basicAuth ? { 'Authorization': `Basic ${basicAuth}` } : null },
        { label: 'api key param', url: feed.url + '?api_key=' + (apiKey||'') },
      ].filter(a => a.headers !== null);

      for (const attempt of attempts) {
        try {
          const fetchUrl = attempt.url || feed.url;
          const r = await fetch(fetchUrl, { method: 'HEAD', headers: attempt.headers || {} });
          results.push({
            region: feed.region,
            attempt: attempt.label,
            status: r.status,
            ok: r.ok,
            size: r.headers.get('content-length'),
            type: r.headers.get('content-type')
          });
          if (r.ok) break; // stop trying if one works
        } catch(e) {
          results.push({ region: feed.region, attempt: attempt.label, error: String(e) });
        }
      }
    }
    return json({ feedTests: results }, 200);
  }

  // Download and parse all feeds
  const today    = new Date();
  const allItems = [];
  const feedStats = [];

  for (const feed of FEEDS) {
    try {
      const resp = await fetch(feed.url);
      if (!resp.ok) {
        feedStats.push({ region: feed.region, error: `HTTP ${resp.status}` });
        continue;
      }

      // Buffer the entire response body once as ArrayBuffer, then decode.
      // Cannot use resp.body twice — buffer first, then decide how to decompress.
      const buffer = await resp.arrayBuffer();
      let text = '';
      const contentEncoding = resp.headers.get('content-encoding') || '';
      const contentType     = resp.headers.get('content-type')     || '';
      const looksGzipped    = contentEncoding.includes('gzip')
                           || contentType.includes('octet-stream')
                           || contentType.includes('gzip');
      try {
        if (looksGzipped) {
          const ds     = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(new Uint8Array(buffer));
          writer.close();
          const dec = new TextDecoder('utf-8');
          let chunk;
          while (!(chunk = await reader.read()).done) {
            text += dec.decode(chunk.value, { stream: true });
            if (text.length > 30 * 1024 * 1024) break; // 30MB cap per feed
          }
        } else {
          text = new TextDecoder('utf-8').decode(buffer);
        }
      } catch {
        // Decompression failed — try decoding as plain text
        text = new TextDecoder('utf-8').decode(buffer);
      }

      const lines  = text.split('\n');
      const header = parseCSVLine(lines[0] || '');

      const col = name => header.findIndex(
        h => h.toLowerCase().replace(/[\s_"]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
      );

      // Try multiple column name formats
      const iName   = col('name')   !== -1 ? col('name')   : col('eventname');
      const iUrl    = col('url')    !== -1 ? col('url')     : col('deeplink');
      const iPrice  = col('price')  !== -1 ? col('price')   : col('minprice');
      const iCurr   = col('currency');
      const iDate   = col('date')   !== -1 ? col('date')    : col('eventdate');
      const iVenue  = col('venue')  !== -1 ? col('venue')   : col('venuename');
      const iCity   = col('city')   !== -1 ? col('city')    : col('location');
      const iCat    = col('category');

      let kept = 0;
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols  = parseCSVLine(lines[i]);
        const name  = iName !== -1 ? (cols[iName] || '').trim() : '';
        const url   = iUrl  !== -1 ? (cols[iUrl]  || '').trim() : '';
        const date  = iDate !== -1 ? (cols[iDate]  || '').trim() : '';

        if (!name || !url) continue;
        if (date && new Date(date) < today) continue; // skip past events

        // Build affiliate deep-link using the region's camref
        const destUrl    = url.startsWith('http') ? url : `https://www.ticombo.com${url}`;
        const affiliateUrl = `https://ticombo.prf.hn/click/camref:${feed.camref}/destination:${encodeURIComponent(destUrl)}`;

        allItems.push({
          n: name,
          u: affiliateUrl,
          p: iPrice !== -1 && cols[iPrice] ? parseFloat(cols[iPrice]) : null,
          c: iCurr  !== -1 && cols[iCurr]  ? cols[iCurr] : 'EUR',
          d: date ? date.split('T')[0] : '',
          v: iVenue !== -1 ? (cols[iVenue] || '') : '',
          t: iCity  !== -1 ? (cols[iCity]  || '') : '',
          g: iCat   !== -1 ? (cols[iCat]   || '') : '',
          r: feed.region
        });
        kept++;
      }

      feedStats.push({ region: feed.region, lines: lines.length - 1, kept, columns: header.slice(0, 12) });

    } catch(err) {
      feedStats.push({ region: feed.region, error: String(err) });
    }
  }

  // Deduplicate by name+date
  const seen   = new Set();
  const unique = allItems.filter(item => {
    const key = `${item.n}|${item.d}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const indexJson = JSON.stringify(unique);
  const stats     = { total: unique.length, feeds: feedStats, updated: new Date().toISOString() };

  await Promise.all([
    kv.put(KV_INDEX,   indexJson,               { expirationTtl: KV_TTL }),
    kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }),
    kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }),
  ]);

  return json({ success: true, total: unique.length, sizeMB: (indexJson.length/1024/1024).toFixed(2), feedStats }, 200);
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