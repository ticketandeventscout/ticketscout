// ===========================
// TicketScout — Server-side Ticketmaster proxy
// Runs as a Cloudflare Pages Function at /api/ticketmaster
// Keeps TM_API_KEY out of client-side code.
//
// Set TM_API_KEY in: Cloudflare Pages dashboard →
// your project → Settings → Environment variables
// ===========================

export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  // ── Edge cache: identical queries answered from the Cloudflare colo ──
  // for 10 minutes instead of hitting TM's API (5k calls/day quota).
  // One viral event page = at most ~6 TM calls/colo/hour instead of
  // one call per page view. This is the traffic-surge protection layer.
  const cache    = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const apiKey = env.TM_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Server is missing TM_API_KEY environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const eventId = incoming.searchParams.get('id');
  const attractionSearch = incoming.searchParams.get('attractionSearch');

  let tmUrl;

  if (eventId) {
    // Single event lookup — used by event detail pages
    tmUrl = new URL(`https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json`);
    tmUrl.searchParams.set('apikey', apiKey);
  } else if (attractionSearch) {
    // Attraction search — used to get team/artist images for football/SE365 detail pages
    tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('keyword', attractionSearch);
    tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '3');
  } else {
    // Event search — used for trending/category browsing and per-artist event lists
    tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('countryCode', 'GB');
    tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '12');
    tmUrl.searchParams.set('sort', 'date,asc');

    const page = incoming.searchParams.get('page');
    if (page) tmUrl.searchParams.set('page', page);

    const startDateTime = incoming.searchParams.get('startDateTime');
    const endDateTime   = incoming.searchParams.get('endDateTime');
    // Always default to today at midnight UTC so past events are never returned
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    tmUrl.searchParams.set('startDateTime', startDateTime || nowIso);
    if (endDateTime) tmUrl.searchParams.set('endDateTime', endDateTime);

    const keyword = incoming.searchParams.get('keyword');
    if (keyword) tmUrl.searchParams.set('keyword', keyword);

    const segmentName = incoming.searchParams.get('segmentName');
    if (segmentName) {
      tmUrl.searchParams.set('segmentName', segmentName);
      // Remove GB filter for segment browsing — show global events
      tmUrl.searchParams.delete('countryCode');
    }



    // Setting this guarantees results belong to exactly one artist/attraction
    const attractionId = incoming.searchParams.get('attractionId');
    if (attractionId) {
      tmUrl.searchParams.set('attractionId', attractionId);
      // Remove GB filter for artist searches — fans want ALL global dates
      // (e.g. Metallica at Sphere Las Vegas would be excluded by countryCode=GB)
      tmUrl.searchParams.delete('countryCode');
    }

    // venueId — used by venue pages to load all events at a specific venue
    const venueId = incoming.searchParams.get('venueId');
    if (venueId) {
      tmUrl.searchParams.set('venueId', venueId);
      tmUrl.searchParams.delete('countryCode');
    }
  }

  // ── Last-good fallback (KV) ─────────────────────────────────────────────
  // TM's free quota is 5k calls/day. When it's exhausted (429) or TM is
  // down (5xx), serve the most recent good response for this exact query
  // from KV instead of surfacing the error — the homepage/trending and
  // entity event lists degrade to slightly-stale data instead of blank.
  const kv = env.GIGSBERG_KV;
  const lastGoodKey = 'tm:lastgood:' + incoming.pathname + '?' +
    [...incoming.searchParams].filter(([k]) => k !== 'apikey').sort()
      .map(([k, v]) => k + '=' + v).join('&');

  // Circuit breaker: while the quota flag is set, don't burn calls on
  // guaranteed 429s — go straight to the last-good copy for 10 minutes.
  let quotaExhausted = false;
  try { quotaExhausted = !!(kv && await kv.get('tm:quota:exhausted')); } catch {}

  if (!quotaExhausted) {
    try {
      const tmResponse = await fetch(tmUrl.toString());
      const data = await tmResponse.json();
      const resp = jsonResponse(data, tmResponse.status, tmResponse.ok);
      if (tmResponse.ok) {
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        // Refresh the last-good copy (7-day TTL — long enough to ride out
        // a full quota day, short enough to never serve ancient events)
        if (kv) ctx.waitUntil(kv.put(lastGoodKey, JSON.stringify(data), { expirationTtl: 7 * 24 * 3600 }));
        return resp;
      }
      if (tmResponse.status === 429 && kv) {
        // Set the breaker so subsequent requests skip TM for 10 minutes
        ctx.waitUntil(kv.put('tm:quota:exhausted', new Date().toISOString(), { expirationTtl: 600 }));
      }
      // Non-OK → fall through to last-good
    } catch (err) {
      // Network failure → fall through to last-good
    }
  }

  // Serve the stale copy if we have one
  if (kv) {
    try {
      const stale = await kv.get(lastGoodKey);
      if (stale) {
        return new Response(stale, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            // Cache the stale answer briefly at the edge too — during an
            // outage this keeps function invocations near zero
            'Cache-Control': 'public, max-age=60, s-maxage=300',
            'X-TM-Fallback': 'stale'
          }
        });
      }
    } catch {}
  }

  return jsonResponse({ error: 'Ticketmaster unavailable and no cached copy exists yet.' }, 503);
}

function jsonResponse(body, status, cacheable) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // s-maxage: Cloudflare edge caches for 10 min; SWR serves stale
      // while revalidating in the background. Browsers get 1 min.
      'Cache-Control': cacheable
        ? 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600'
        : 'no-store'
    }
  });
}