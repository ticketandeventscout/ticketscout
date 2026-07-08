// ===========================
// TicketScout — Vivid Seats catalog cache
// Runs as a Cloudflare Pages Function at /api/vividseats-cache
//
// Downloads the Vivid Seats bulk feed CSV from Impact FTP,
// parses it, and stores a name→item lookup in KV for fast searching.
//
// Impact FTP feed location (from catalog metadata):
//   /Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz
// Accessed via: https://api.impact.com/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz
// Auth: Basic (AccountSID:AuthToken)
//
// Cron: run weekly via cron-job.org
//   https://ticketscout.co.uk/api/vividseats-cache?trigger=1
//
// KV keys:
//   vs:catalog:index   — JSON array of { name, url, price, currency, date, venue, city }
//   vs:catalog:updated — ISO timestamp of last update
//
// Required env vars:
//   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, GIGSBERG_KV
// ===========================

const KV_INDEX_KEY   = 'vs:catalog:index';
const KV_UPDATED_KEY = 'vs:catalog:updated';
const KV_TTL         = 7 * 24 * 60 * 60; // 7 days
// Feed URL — Impact hosts catalog feeds at a specific authenticated endpoint.
// The catalog metadata returns relative paths like /Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz
// The full authenticated URL uses the mediapartners base with the account SID.
// We build this dynamically using the account SID from env.
const FEED_PATH = '/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    const updated = await env.GIGSBERG_KV?.get(KV_UPDATED_KEY);
    return text([
      'Vivid Seats catalog cache — usage:',
      '  ?trigger=1  — download feed, parse, store in KV',
      '',
      `Last updated: ${updated || 'never'}`,
      'Run ?trigger=1 to refresh.'
    ].join('\n'));
  }

  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;
  const kv         = env.GIGSBERG_KV;

  if (!accountSid || !authToken) return json({ error: 'Missing Impact credentials' }, 500);
  if (!kv)                        return json({ error: 'Missing GIGSBERG_KV'        }, 500);

  const basicAuth = btoa(`${accountSid}:${authToken}`);

  try {
    // Download the gzipped CSV feed
    // Impact feed URLs use the account SID in the path
    const FEED_URL = `https://api.impact.com/Mediapartners/${accountSid}${FEED_PATH}`;
    const FEED_URL_ALT = `https://api.impact.com${FEED_PATH}`;
    let feedResp = await fetch(FEED_URL, {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    // Fallback to path without accountSid if first attempt fails
    if (!feedResp.ok) {
      feedResp = await fetch(FEED_URL_ALT, {
        headers: { 'Authorization': `Basic ${basicAuth}` }
      });
    }

    if (!feedResp.ok) {
      return json({
        error: `Feed download failed: HTTP ${feedResp.status}`,
        triedUrls: [FEED_URL, FEED_URL_ALT]
      }, 500);
    }

    // Decompress and parse CSV
    const ds         = new DecompressionStream('gzip');
    const stream     = feedResp.body.pipeThrough(ds);
    const reader     = stream.getReader();
    const decoder    = new TextDecoder('utf-8');
    let   csvText    = '';
    let   chunk;

    while (!(chunk = await reader.read()).done) {
      csvText += decoder.decode(chunk.value, { stream: true });
      // Stop if we have enough data (prevent OOM on 131k rows)
      if (csvText.length > 50 * 1024 * 1024) break; // 50MB cap
    }

    const lines  = csvText.split('\n');
    const header = parseCSVLine(lines[0]);

    // Find column indexes
    const col = (name) => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
    const iName    = col('name');
    const iUrl     = col('url');
    const iPrice   = col('currentprice') !== -1 ? col('currentprice') : col('price');
    const iCurr    = col('currency');
    const iExpiry  = col('expirationdate');
    const iVenue   = col('text1');
    const iCity    = col('text2');
    const iCat     = col('category');
    const iSubCat  = col('subcategory');

    const today = new Date();
    const index = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 3) continue;

      const name   = (cols[iName]   || '').trim();
      const url    = (cols[iUrl]    || '').trim();
      const expiry = (cols[iExpiry] || '').trim();

      if (!name || !url) continue;

      // Skip expired events
      if (expiry && new Date(expiry) < today) continue;

      index.push({
        n: name,                           // name
        u: url,                            // affiliate url (pre-built)
        p: cols[iPrice]  ? parseFloat(cols[iPrice])  : null,  // price
        c: cols[iCurr]   || 'USD',        // currency
        d: expiry ? expiry.split('T')[0] : '',  // date
        v: cols[iVenue]  || '',            // venue
        t: cols[iCity]   || '',            // city
        g: cols[iCat]    || '',            // category
        s: cols[iSubCat] || '',            // subcategory
      });
    }

    // Store in KV — split into chunks if needed (KV limit 25MB per value)
    // For now store full index as single value; if > 25MB split later
    const indexJson = JSON.stringify(index);
    await kv.put(KV_INDEX_KEY,   indexJson,               { expirationTtl: KV_TTL });
    await kv.put(KV_UPDATED_KEY, new Date().toISOString(), { expirationTtl: KV_TTL });

    return json({
      success:  true,
      total:    index.length,
      sizeMB:   (indexJson.length / 1024 / 1024).toFixed(2),
      sample:   index.slice(0, 3),
      cachedAt: new Date().toISOString()
    }, 200);

  } catch (err) {
    console.error('VS cache error:', err);
    return json({ error: String(err) }, 500);
  }
}

// Minimal CSV line parser (handles quoted fields)
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
      result.push(current);
      current = '';
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