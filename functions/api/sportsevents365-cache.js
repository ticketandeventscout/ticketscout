// ===========================
// TicketScout — SportsEvents365 participant cache Worker
// Runs as a Cloudflare Pages Function at /api/sportsevents365-cache
//
// SE365 has no name-based participant search — all participants must be
// fetched by page. This Worker fetches all pages and builds a
// name → {id, eventTypeId} lookup map stored in KV.
// The SE365 adapter (/api/sportsevents365) uses this for instant lookups.
//
// CHUNKED FETCHING — avoids 30s Cloudflare timeout:
// Rather than fetching all 374 pages in one request, use the &pages= param
// to process a range of pages at a time.
//
// Cron schedule on cron-job.org (staggered, 5 mins apart):
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1&pages=1-75
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1&pages=76-150
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1&pages=151-225
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1&pages=226-300
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1&pages=301-374
//
// Each chunk fetches ~75 pages (~750 participants) and merges into the
// shared KV cache key rather than overwriting it, so all chunks combine
// into one complete lookup map.
//
// Required env vars (all Secrets):
//   SE365_API_KEY        — API key
//   SE365_HTTP_USERNAME  — HTTP username
//   SE365_HTTP_PASSWORD  — HTTP password
//   GIGSBERG_KV          — KV namespace binding
//   SE365_PROD           — set to 'true' to use production API
// ===========================

const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';
const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';
const CACHE_KEY       = 'se365:participants:latest';
const CACHE_TTL       = 7 * 24 * 60 * 60; // 7 days

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('trigger') !== '1') {
    return text([
      'SE365 participant cache — usage:',
      '  ?trigger=1                     — fetch ALL pages (may timeout)',
      '  ?trigger=1&pages=1-75          — fetch pages 1-75 only (recommended)',
      '  ?trigger=1&pages=76-150        — fetch pages 76-150 only',
      '  ?trigger=1&reset=1&pages=1-75  — clear cache before first chunk',
      '',
      'Recommended cron schedule (5 chunks × 5 mins apart):',
      '  ?trigger=1&reset=1&pages=1-75',
      '  ?trigger=1&pages=76-150',
      '  ?trigger=1&pages=151-225',
      '  ?trigger=1&pages=226-300',
      '  ?trigger=1&pages=301-374',
    ].join('\n'));
  }

  const result = await refreshCache(env, url);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function refreshCache(env, url) {
  const apiKey   = env.SE365_API_KEY;
  const httpUser = env.SE365_HTTP_USERNAME;
  const httpPass = env.SE365_HTTP_PASSWORD;
  const kv       = env.GIGSBERG_KV;
  const isProd   = env.SE365_PROD === 'true';

  if (!apiKey || !httpUser || !httpPass) return { success: false, error: 'Missing SE365 credentials' };
  if (!kv)                               return { success: false, error: 'Missing GIGSBERG_KV binding' };

  const baseUrl   = isProd ? PRODUCTION_BASE : SANDBOX_BASE;
  const basicAuth = btoa(`${httpUser}:${httpPass}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };

  // Parse page range — supports:
  //   "1-75"   → pages 1 to 75
  //   "301-end" → pages 301 to whatever the API reports as last_page
  //   (empty)  → all pages
  const pagesParam = url.searchParams.get('pages') || '';
  const resetCache = url.searchParams.get('reset') === '1';

  let fromPage    = 1;
  let toPageParam = null; // null = fetch all; 'end' = fetch to last_page

  if (pagesParam) {
    const match = pagesParam.match(/^(\d+)-(\d+|end)$/i);
    if (match) {
      fromPage    = parseInt(match[1]);
      toPageParam = match[2].toLowerCase() === 'end' ? 'end' : parseInt(match[2]);
    }
  }

  const startTime = Date.now();
  console.log(`SE365 cache refresh: pages ${fromPage}–${toPage || 'all'}, reset=${resetCache}`);

  try {
    // Load existing cache to merge into (unless reset requested)
    let existingLookup = {};
    if (!resetCache) {
      try {
        const existing = await kv.get(CACHE_KEY);
        if (existing) existingLookup = JSON.parse(existing);
      } catch {}
    }

    // Fetch first page to get total page count
    const firstUrl  = buildPageUrl(baseUrl, apiKey, fromPage);
    const firstResp = await fetch(firstUrl, { headers });
    if (!firstResp.ok) return { success: false, error: `HTTP ${firstResp.status} on page ${fromPage}` };

    const firstData  = await firstResp.json();
    const totalPages = firstData?.meta?.last_page || 1;

    // Resolve toPage — 'end' means go to whatever last_page the API reports
    // This ensures new pages are always picked up automatically as SE365 grows
    const maxPage = toPageParam === null  ? totalPages
                  : toPageParam === 'end' ? totalPages
                  : Math.min(toPageParam, totalPages);

    const participants = [...(firstData?.data || [])];

    // Fetch remaining pages in this range
    for (let page = fromPage + 1; page <= maxPage; page++) {
      const pageUrl  = buildPageUrl(baseUrl, apiKey, page);
      const resp     = await fetch(pageUrl, { headers });
      if (!resp.ok) { console.warn(`SE365: page ${page} returned ${resp.status}, stopping`); break; }

      const data = await resp.json();
      const rows = data?.data || [];
      if (rows.length === 0) break;
      participants.push(...rows);

      // Small delay every 20 pages to avoid rate limiting
      if ((page - fromPage) % 20 === 0) await sleep(150);
    }

    console.log(`SE365: fetched ${participants.length} participants (pages ${fromPage}–${maxPage})`);

    // Build lookup entries from this batch
    const batchLookup = {};
    for (const p of participants) {
      if (!p.id || !p.name) continue;
      const normName = normaliseName(p.name);
      if (normName) {
        batchLookup[normName] = {
          id:          p.id,
          name:        p.name,
          eventTypeId: p.eventTypeId || null
        };
      }
    }

    // Merge with existing lookup
    const mergedLookup = { ...existingLookup, ...batchLookup };
    const totalEntries = Object.keys(mergedLookup).length;

    // Save merged lookup to KV
    await kv.put(CACHE_KEY, JSON.stringify(mergedLookup), { expirationTtl: CACHE_TTL });

    return {
      success:        true,
      pagesRange:     `${fromPage}–${maxPage} of ${totalPages}`,
      participantsFetched: participants.length,
      newEntries:     Object.keys(batchLookup).length,
      totalEntries,
      resetCache,
      elapsedMs:      Date.now() - startTime,
      cachedAt:       new Date().toISOString(),
      sampleEntries:  Object.entries(batchLookup).slice(0, 3).map(([k, v]) => ({ key: k, ...v }))
    };

  } catch (err) {
    console.error('SE365 participant cache error:', err);
    return { success: false, error: String(err) };
  }
}

function buildPageUrl(baseUrl, apiKey, page) {
  const u = new URL(`${baseUrl}/participants`);
  u.searchParams.set('apiKey', apiKey);
  u.searchParams.set('perPage', '50'); // conservative per-page size to stay fast
  u.searchParams.set('page', String(page));
  return u.toString();
}

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}