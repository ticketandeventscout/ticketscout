// ===========================
// TicketScout — Vivid Seats catalog cache
// Runs as a Cloudflare Pages Function at /api/vividseats-cache
//
// Builds a searchable KV index from the Vivid Seats catalog via Impact API.
// The bulk CSV feed requires FTP credentials (separate from API credentials).
// Instead we paginate through the catalog Items API using AfterId cursor pagination,
// filtering to UK/IE events and upcoming events to keep the index manageable.
//
// Strategy:
//   - Fetch up to MAX_PAGES pages of 100 items each (capped at 60s worker limit)
//   - Filter to: ExpirationDate in future AND (UK/IE city OR Concert/Sport category)
//   - Store as KV index for fast in-memory search by vividseats.js
//
// Cron: run weekly via cron-job.org
//   https://ticketscout.co.uk/api/vividseats-cache?trigger=1
//
// KV keys:
//   vs:catalog:index   — JSON array of compact event objects
//   vs:catalog:updated — ISO timestamp of last update
//   vs:catalog:stats   — { total_fetched, total_kept, pages, updated }
//
// Required env vars:
//   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, GIGSBERG_KV
// ===========================

const CATALOG_ID  = '7904';
const KV_INDEX    = 'vs:catalog:index';
const KV_UPDATED  = 'vs:catalog:updated';
const KV_STATS    = 'vs:catalog:stats';
const KV_TTL      = 8 * 24 * 60 * 60; // 8 days
const PAGE_SIZE   = 100;
const MAX_PAGES   = 200; // 20,000 items max per run — stays well within 30s worker limit

// UK/IE cities to prioritise (lowercase)
const UK_CITIES = new Set([
  'london','manchester','birmingham','glasgow','edinburgh','liverpool',
  'leeds','newcastle','sheffield','bristol','nottingham','cardiff',
  'belfast','dublin','leicester','southampton','brighton','reading',
  'coventry','hull','stoke','wolverhampton','derby','sunderland',
  'portsmouth','oxford','cambridge','bath','york','exeter'
]);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await env.GIGSBERG_KV?.get(KV_UPDATED).catch(() => null);
    const stats   = await env.GIGSBERG_KV?.get(KV_STATS).catch(() => null);
    return text([
      'Vivid Seats catalog cache — usage:',
      '  ?trigger=1        — build KV index from Impact catalog API',
      '  ?trigger=1&all=1  — include all regions (not just UK/IE)',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Last stats: ${stats}` : ''
    ].join('\n'));
  }

  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;
  const kv         = env.GIGSBERG_KV;
  const allRegions = url.searchParams.get('all') === '1';

  if (!accountSid || !authToken) return json({ error: 'Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN' }, 500);
  if (!kv)                        return json({ error: 'Missing GIGSBERG_KV binding'                     }, 500);

  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };
  const base      = `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/${CATALOG_ID}/Items`;
  const today     = new Date();

  const index    = [];
  let   afterId  = null;
  let   pages    = 0;
  let   fetched  = 0;
  let   kept     = 0;

  while (pages < MAX_PAGES) {
    const reqUrl = new URL(base);
    reqUrl.searchParams.set('PageSize', String(PAGE_SIZE));
    if (afterId) reqUrl.searchParams.set('AfterId', afterId);

    const resp = await fetch(reqUrl.toString(), { headers });
    if (!resp.ok) {
      return json({ error: `Catalog fetch failed: HTTP ${resp.status} on page ${pages + 1}`, kept, fetched }, 500);
    }

    const data  = await resp.json();
    const items = data?.Items || [];
    pages++;
    fetched += items.length;

    if (items.length === 0) break;

    for (const item of items) {
      // Skip expired events
      if (item.ExpirationDate && new Date(item.ExpirationDate) < today) continue;

      const city    = (item.Text2 || '').toLowerCase().trim();
      const addr    = (item.Text3 || '').toLowerCase();
      const cat     = (item.Category || '').toLowerCase();

      // Filter to UK/IE events unless allRegions flag set
      if (!allRegions) {
        const isUK = UK_CITIES.has(city) ||
                     addr.includes('united kingdom') || addr.includes(', uk') ||
                     addr.includes('england') || addr.includes('scotland') ||
                     addr.includes('wales') || addr.includes('ireland');
        if (!isUK) continue;
      }

      const price = item.CurrentPrice ? parseFloat(item.CurrentPrice) : null;
      const date  = item.ExpirationDate ? item.ExpirationDate.split('T')[0] : '';

      index.push({
        n: item.Name          || '',   // event name
        u: item.Url           || '',   // pre-built affiliate URL
        p: price,                      // price (USD)
        c: item.Currency      || 'USD',
        d: date,                       // event date
        v: item.Text1         || '',   // venue name
        t: item.Text2         || '',   // city
        g: item.Category      || '',   // category
        s: item.SubCategory   || '',   // subcategory
      });
      kept++;
    }

    // Get next page cursor from nextpageuri
    const nextUri = data['@nextpageuri'] || '';
    const afterMatch = nextUri.match(/AfterId=([^&]+)/);
    if (!afterMatch || items.length < PAGE_SIZE) break;
    afterId = afterMatch[1];
  }

  // Store in KV
  const indexJson = JSON.stringify(index);
  const statsObj  = { total_fetched: fetched, total_kept: kept, pages, updated: new Date().toISOString() };

  await Promise.all([
    kv.put(KV_INDEX,   indexJson,                   { expirationTtl: KV_TTL }),
    kv.put(KV_UPDATED, new Date().toISOString(),     { expirationTtl: KV_TTL }),
    kv.put(KV_STATS,   JSON.stringify(statsObj),     { expirationTtl: KV_TTL })
  ]);

  return json({
    success:  true,
    kept,
    fetched,
    pages,
    sizeMB:   (indexJson.length / 1024 / 1024).toFixed(2),
    sample:   index.slice(0, 3),
    updatedAt: new Date().toISOString()
  }, 200);
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