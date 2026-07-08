// ===========================
// TicketScout — Vivid Seats catalog cache
// Runs as a Cloudflare Pages Function at /api/vividseats-cache
//
// Downloads the full Vivid Seats event catalog (131k+ events) from Impact's
// product feed server via HTTPS, parses the gzipped CSV, and stores a
// searchable KV index for vividseats.js to search locally.
//
// Feed access:
//   Host:  https://products.impact.com
//   Path:  /Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz
//   Auth:  HTTP Basic — IMPACT_FTP_USER + IMPACT_FTP_PASS
//
// Cron: weekly via cron-job.org
//   https://ticketscout.co.uk/api/vividseats-cache?trigger=1
//
// KV keys:
//   vs:catalog:index   — JSON array of compact event objects
//   vs:catalog:updated — ISO timestamp
//   vs:catalog:stats   — { total, updated }
//
// Required env vars (Cloudflare Pages → Settings → Variables):
//   IMPACT_FTP_USER  — ps-ftp_7443544
//   IMPACT_FTP_PASS  — (password from Impact FTP email)
//   GIGSBERG_KV      — KV namespace binding
// ===========================

const FEED_BASE  = 'https://products.impact.com';
const FEED_PATH  = '/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz';
const KV_INDEX   = 'vs:catalog:index';
const KV_UPDATED = 'vs:catalog:updated';
const KV_STATS   = 'vs:catalog:stats';
const KV_TTL     = 8 * 24 * 60 * 60; // 8 days

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await env.GIGSBERG_KV?.get(KV_UPDATED).catch(() => null);
    const stats   = await env.GIGSBERG_KV?.get(KV_STATS).catch(() => null);
    return text([
      'Vivid Seats catalog cache — usage:',
      '  ?trigger=1   — download feed CSV, parse, store KV index',
      '  ?test=1      — test feed URL connectivity (HEAD request only)',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Last stats:   ${stats}` : ''
    ].join('\n'));
  }

  const ftpUser = env.IMPACT_FTP_USER;
  const ftpPass = env.IMPACT_FTP_PASS;
  const kv      = env.GIGSBERG_KV;

  if (!ftpUser || !ftpPass) return json({ error: 'Missing IMPACT_FTP_USER or IMPACT_FTP_PASS env vars' }, 500);
  if (!kv)                   return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  // Test mode — just check if the URL is reachable
  if (url.searchParams.get('test') === '1') {
    const basicAuth = btoa(`${ftpUser}:${ftpPass}`);
    const testResp  = await fetch(`${FEED_BASE}${FEED_PATH}`, {
      method:  'HEAD',
      headers: { 'Authorization': `Basic ${basicAuth}` }
    }).catch(e => ({ ok: false, status: 0, error: String(e) }));
    return json({
      url:           `${FEED_BASE}${FEED_PATH}`,
      status:        testResp.status,
      ok:            testResp.ok,
      contentType:   testResp.headers?.get('content-type'),
      contentLength: testResp.headers?.get('content-length'),
    }, 200);
  }

  try {
    const basicAuth = btoa(`${ftpUser}:${ftpPass}`);

    // Download the gzipped CSV feed
    const feedResp = await fetch(`${FEED_BASE}${FEED_PATH}`, {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });

    if (!feedResp.ok) {
      // Try alternative URL patterns
      const alts = [
        `${FEED_BASE}/Vivid-Seats/Ticket-Feed_IR.txt.gz`,
        `https://ftp.impact.com/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz`,
        `https://products.impact.com/${ftpUser}/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz`,
      ];
      let altResp = null;
      let altUrl  = '';
      for (const alt of alts) {
        const r = await fetch(alt, { headers: { 'Authorization': `Basic ${basicAuth}` } });
        if (r.ok) { altResp = r; altUrl = alt; break; }
      }
      if (!altResp) {
        return json({
          error:    `Feed download failed: HTTP ${feedResp.status}`,
          triedUrl: `${FEED_BASE}${FEED_PATH}`,
          alsoTried: alts
        }, 500);
      }
      // Use the working alternate URL
      return await parseFeedAndStore(altResp, kv, altUrl);
    }

    return await parseFeedAndStore(feedResp, kv, `${FEED_BASE}${FEED_PATH}`);

  } catch (err) {
    console.error('VS cache error:', err);
    return json({ error: String(err) }, 500);
  }
}

async function parseFeedAndStore(feedResp, kv, sourceUrl) {
  // Decompress gzip stream
  const ds      = new DecompressionStream('gzip');
  const stream  = feedResp.body.pipeThrough(ds);
  const reader  = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let   csvText = '';
  let   chunk;

  while (!(chunk = await reader.read()).done) {
    csvText += decoder.decode(chunk.value, { stream: true });
    if (csvText.length > 60 * 1024 * 1024) break; // 60MB safety cap
  }

  const lines  = csvText.split('\n');
  const header = parseCSVLine(lines[0]);

  // Find column indexes by header name
  const col = name => header.findIndex(h => h.toLowerCase().replace(/\s/g,'') === name.toLowerCase().replace(/\s/g,''));
  const iName   = col('Name');
  const iUrl    = col('Url');
  const iPrice  = col('CurrentPrice') !== -1 ? col('CurrentPrice') : col('Price');
  const iCurr   = col('Currency');
  const iExpiry = col('ExpirationDate');
  const iVenue  = col('Text1');
  const iCity   = col('Text2');
  const iCat    = col('Category');
  const iSubCat = col('SubCategory');

  const today = new Date();
  const index = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols   = parseCSVLine(lines[i]);
    if (cols.length < 3) continue;

    const name   = (cols[iName]   || '').trim();
    const url    = (cols[iUrl]    || '').trim();
    const expiry = iExpiry !== -1 ? (cols[iExpiry] || '').trim() : '';

    if (!name || !url) continue;
    if (expiry && new Date(expiry) < today) continue; // skip past events

    index.push({
      n: name,
      u: url,
      p: iPrice !== -1 && cols[iPrice] ? parseFloat(cols[iPrice]) : null,
      c: iCurr  !== -1 ? (cols[iCurr] || 'USD') : 'USD',
      d: expiry ? expiry.split('T')[0] : '',
      v: iVenue  !== -1 ? (cols[iVenue]  || '') : '',
      t: iCity   !== -1 ? (cols[iCity]   || '') : '',
      g: iCat    !== -1 ? (cols[iCat]    || '') : '',
      s: iSubCat !== -1 ? (cols[iSubCat] || '') : '',
    });
  }

  const indexJson = JSON.stringify(index);
  const statsObj  = { total: index.length, updated: new Date().toISOString(), sourceUrl };

  await Promise.all([
    kv.put(KV_INDEX,   indexJson,                 { expirationTtl: KV_TTL }),
    kv.put(KV_UPDATED, new Date().toISOString(),   { expirationTtl: KV_TTL }),
    kv.put(KV_STATS,   JSON.stringify(statsObj),   { expirationTtl: KV_TTL })
  ]);

  return new Response(JSON.stringify({
    success:   true,
    total:     index.length,
    sizeMB:    (indexJson.length / 1024 / 1024).toFixed(2),
    sourceUrl,
    sample:    index.slice(0, 3),
    updatedAt: new Date().toISOString()
  }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// Minimal CSV line parser (handles quoted fields with commas inside)
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
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
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}