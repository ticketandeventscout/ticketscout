// ===========================
// TicketScout — SportsEvents365 participant cache Worker
// Runs as a Cloudflare Pages Function at /api/sportsevents365-cache
//
// SE365 has no name-based participant search — participants can only be
// browsed by page. This Worker fetches all participants once (374 pages,
// ~3,739 total), builds a name → {id, eventTypeId} lookup map, and
// stores it in KV. The adapter (/api/sportsevents365) then does
// instant name lookups at query time rather than paging through the API.
//
// Trigger manually:
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1
//
// Also add to cron-job.org weekly (participants list changes slowly):
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   SE365_API_KEY        — API key (Secret)
//   SE365_HTTP_USERNAME  — HTTP username (Secret)
//   SE365_HTTP_PASSWORD  — HTTP password (Secret)
//   GIGSBERG_KV          — KV namespace binding (reused — already exists)
//   SE365_PROD           — set to 'true' to use production API
// ===========================

const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';
const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';
const CACHE_KEY       = 'se365:participants:latest';
const CACHE_TTL       = 7 * 24 * 60 * 60; // 7 days

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('trigger') !== '1') {
    return new Response(
      'Add ?trigger=1 to manually run the SE365 participant cache refresh.',
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const result = await refreshCache(env);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function refreshCache(env) {
  const apiKey   = env.SE365_API_KEY;
  const httpUser = env.SE365_HTTP_USERNAME;
  const httpPass = env.SE365_HTTP_PASSWORD;
  const kv       = env.GIGSBERG_KV;
  const isProd   = env.SE365_PROD === 'true';

  if (!apiKey || !httpUser || !httpPass) {
    return { success: false, error: 'Missing SE365 credentials' };
  }
  if (!kv) {
    return { success: false, error: 'Missing GIGSBERG_KV binding' };
  }

  const baseUrl   = isProd ? PRODUCTION_BASE : SANDBOX_BASE;
  const basicAuth = btoa(`${httpUser}:${httpPass}`);
  const headers   = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept': 'application/json'
  };

  console.log('SE365 participant cache refresh started');
  const startTime = Date.now();

  try {
    // Fetch first page to find out total page count
    const firstUrl = new URL(`${baseUrl}/participants`);
    firstUrl.searchParams.set('apiKey', apiKey);
    firstUrl.searchParams.set('perPage', '100'); // max per page to minimise requests
    firstUrl.searchParams.set('page', '1');

    const firstResp = await fetch(firstUrl.toString(), { headers });
    if (!firstResp.ok) {
      return { success: false, error: `HTTP ${firstResp.status} on first page` };
    }

    const firstData = await firstResp.json();
    const lastPage  = firstData?.meta?.last_page || 1;
    const allParticipants = [...(firstData?.data || [])];

    console.log(`SE365: ${lastPage} pages to fetch, first page has ${allParticipants.length} participants`);

    // Fetch remaining pages
    for (let page = 2; page <= lastPage; page++) {
      const pageUrl = new URL(`${baseUrl}/participants`);
      pageUrl.searchParams.set('apiKey', apiKey);
      pageUrl.searchParams.set('perPage', '100');
      pageUrl.searchParams.set('page', String(page));

      const resp = await fetch(pageUrl.toString(), { headers });
      if (!resp.ok) {
        console.warn(`SE365: page ${page} returned ${resp.status}, stopping`);
        break;
      }

      const data = await resp.json();
      const participants = data?.data || [];
      if (participants.length === 0) break;

      allParticipants.push(...participants);

      // Small delay every 10 pages to avoid rate limiting
      if (page % 10 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`SE365: fetched ${allParticipants.length} total participants`);

    if (allParticipants.length === 0) {
      return { success: false, error: 'No participants returned from API' };
    }

    // Build a normalised name → participant lookup map
    // Store both exact name and normalised name for flexible matching
    const lookup = {};
    for (const p of allParticipants) {
      if (!p.id || !p.name) continue;
      const normName = normaliseName(p.name);
      if (normName) {
        lookup[normName] = {
          id:          p.id,
          name:        p.name,
          eventTypeId: p.eventTypeId || null
        };
      }
    }

    const lookupSize = Object.keys(lookup).length;
    console.log(`SE365: built lookup map with ${lookupSize} entries`);

    // Store in KV — single key, JSON object
    await kv.put(CACHE_KEY, JSON.stringify(lookup), { expirationTtl: CACHE_TTL });

    return {
      success:          true,
      totalFetched:     allParticipants.length,
      lookupEntries:    lookupSize,
      elapsedMs:        Date.now() - startTime,
      cachedAt:         new Date().toISOString(),
      sampleEntries:    Object.entries(lookup).slice(0, 3).map(([k, v]) => ({ key: k, ...v }))
    };

  } catch (err) {
    console.error('SE365 participant cache error:', err);
    return { success: false, error: String(err) };
  }
}

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
