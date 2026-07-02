// ===========================
// TicketScout — Server-side SportsEvents365 adapter
// Runs as a Cloudflare Pages Function at /api/sportsevents365
//
// SE365 API structure (v2):
//   - No free-text event search exists — events are found via participant ID
//   - Flow: search participants by name → get participant ID → fetch their events
//   - Participants endpoint: GET /participants (paginated, 3739 total in sandbox)
//   - Events endpoint: GET /events/participant/{participantId}
//   - Tickets endpoint: GET /tickets/{eventId}
//
// Auth: Basic Auth header + apiKey query param on every request
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   SE365_API_KEY                — API key (Secret)
//   SE365_HTTP_USERNAME          — HTTP username (Secret)
//   SE365_HTTP_PASSWORD          — HTTP password (Secret)
//   SE365_HTTP_SOURCE            — HTTP source identifier e.g. "TICKETSCOUT" (Secret)
//   SPORTSEVENTS365_AFFILIATE_ID — affiliate tracking ID = dvqg90rd8vv1f
//
// Sandbox:    https://api-v2.sandbox365.com
// Production: https://api-v2.sportsevents365.com
// Set SE365_PROD=true in Cloudflare env vars to switch to production
// ===========================

const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';
const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';

export async function onRequestGet({ request, env }) {
  const apiKey      = env.SE365_API_KEY;
  const httpUser    = env.SE365_HTTP_USERNAME;
  const httpPass    = env.SE365_HTTP_PASSWORD;
  const affiliateId = env.SPORTSEVENTS365_AFFILIATE_ID;
  const isProd      = env.SE365_PROD === 'true';

  if (!apiKey || !httpUser || !httpPass) {
    return jsonResponse({ error: 'SE365 credentials not configured.' }, 500);
  }

  const baseUrl   = isProd ? PRODUCTION_BASE : SANDBOX_BASE;
  const basicAuth = btoa(`${httpUser}:${httpPass}`);

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');
  const date     = incoming.searchParams.get('date') || '';
  const debug    = incoming.searchParams.get('debug') === '1';

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  const headers = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept': 'application/json'
  };

  try {
    // ── Step 1: Search participants across multiple pages ──────────────────
    // SE365 /participants does not filter by name server-side — we must
    // fetch pages and find the best match ourselves. We search up to 5 pages
    // (50 participants) which covers most common team/performer names.
    const participant = await findParticipant(baseUrl, apiKey, headers, q);

    if (debug) {
      // In debug mode, also fetch events for the matched participant if found
      let eventsData = null;
      if (participant) {
        const eventsUrl = new URL(`${baseUrl}/events/participant/${participant.id}`);
        eventsUrl.searchParams.set('apiKey', apiKey);
        const eventsResp = await fetch(eventsUrl.toString(), { headers });
        eventsData = await eventsResp.json();
      }

      return jsonResponse({
        debug: true,
        baseUrl,
        query: q,
        participantFound: participant || null,
        eventsData
      }, 200);
    }

    if (!participant) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 2: Fetch events for the matched participant ───────────────────
    const eventsUrl = new URL(`${baseUrl}/events/participant/${participant.id}`);
    eventsUrl.searchParams.set('apiKey', apiKey);

    const eventsResp = await fetch(eventsUrl.toString(), { headers });

    if (!eventsResp.ok) {
      console.error(`SE365 events error: ${eventsResp.status}`);
      return jsonResponse({ match: null }, 200);
    }

    const eventsData = await eventsResp.json();
    const events     = eventsData?.data || eventsData?.events || [];

    if (events.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 3: Pick the best event (date match preferred, then soonest) ──
    const event = findBestEvent(events, date);
    if (!event) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 4: Fetch tickets for the event to get the lowest price ────────
    const ticketsUrl = new URL(`${baseUrl}/tickets/${event.id}`);
    ticketsUrl.searchParams.set('apiKey', apiKey);

    const ticketsResp = await fetch(ticketsUrl.toString(), { headers });
    let lowestPrice = null;
    let eventUrl    = buildEventUrl(event, affiliateId);

    if (ticketsResp.ok) {
      const ticketsData = await ticketsResp.json();
      lowestPrice = extractLowestPrice(ticketsData);
      // If tickets return a direct URL, prefer that over the participant URL
      const ticketUrl = extractTicketUrl(ticketsData, affiliateId);
      if (ticketUrl) eventUrl = ticketUrl;
    }

    return jsonResponse({
      match: {
        name:     event.name || event.title || '',
        url:      eventUrl,
        price:    lowestPrice ? Math.round(lowestPrice) : null,
        currency: 'GBP',
        date:     getEventDate(event),
        venue:    event.venue?.name || event.venueName || null
      }
    }, 200);

  } catch (err) {
    console.error('SE365 adapter error:', err);
    return jsonResponse({ error: 'Unable to reach SportsEvents365.' }, 502);
  }
}

// ===========================
// Participant search — pages through results to find best name match
// SE365 does not support server-side name filtering on /participants
// so we fetch pages until we find a match or exhaust the search budget
// ===========================

async function findParticipant(baseUrl, apiKey, headers, query) {
  const normQuery = normaliseName(query);
  const MAX_PAGES = 5; // search up to 50 participants (10 per page)

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`${baseUrl}/participants`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('page', page);

    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) break;

    const data         = await resp.json();
    const participants = data?.data || [];
    if (participants.length === 0) break;

    // Score all participants on this page
    const scored = participants
      .map(p => ({ p, score: scoreParticipant(p, normQuery) }))
      .filter(r => r.score > 0);

    if (scored.length > 0) {
      // Return the best match from this page immediately
      scored.sort((a, b) => b.score - a.score);
      return scored[0].p;
    }

    // If no match this page and there are no more pages, stop
    const lastPage = data?.meta?.last_page || 1;
    if (page >= lastPage) break;
  }

  return null;
}

function scoreParticipant(participant, normQuery) {
  const normName = normaliseName(participant.name || '');
  if (!normName) return 0;

  if (normName === normQuery)                                   return 100;
  if (normName.startsWith(normQuery))                           return 60;
  if (normName.includes(normQuery))                             return 30;
  if (normQuery.includes(normName) && normName.length > 4)      return 20;
  return 0;
}

// ===========================
// Event selection — prefer date match, otherwise return soonest upcoming
// ===========================

function findBestEvent(events, targetDate) {
  if (!events.length) return null;

  // Filter to upcoming events only
  const now = new Date();
  const upcoming = events.filter(e => {
    const d = new Date(getEventDate(e));
    return !isNaN(d.getTime()) && d >= now;
  });

  const pool = upcoming.length > 0 ? upcoming : events;

  // If we have a target date, prefer events within 3 days of it
  if (targetDate) {
    const dateMatched = pool.filter(e => isDateMatch(getEventDate(e), targetDate));
    if (dateMatched.length > 0) return dateMatched[0];
  }

  // Otherwise return the soonest event
  pool.sort((a, b) => new Date(getEventDate(a)) - new Date(getEventDate(b)));
  return pool[0];
}

function isDateMatch(eventDate, targetDate, windowDays = 3) {
  if (!eventDate || !targetDate) return false;
  try {
    const diffDays = Math.abs(new Date(targetDate) - new Date(eventDate)) / (1000 * 60 * 60 * 24);
    return diffDays <= windowDays;
  } catch { return false; }
}

function getEventDate(event) {
  return event.date || event.eventDate || event.startDate || event.dateTime || '';
}

// ===========================
// Ticket price and URL extraction
// ===========================

function extractLowestPrice(ticketsData) {
  const tickets = ticketsData?.data || ticketsData?.tickets || [];
  if (!tickets.length) return null;

  const prices = tickets
    .map(t => parseFloat(t.price || t.priceFrom || t.minPrice || 0))
    .filter(p => p > 0);

  return prices.length > 0 ? Math.min(...prices) : null;
}

function extractTicketUrl(ticketsData, affiliateId) {
  const tickets = ticketsData?.data || ticketsData?.tickets || [];
  if (!tickets.length) return null;

  const url = tickets[0]?.url || tickets[0]?.link || tickets[0]?.buyUrl || null;
  if (!url) return null;

  return appendAffiliateId(url, affiliateId);
}

function buildEventUrl(event, affiliateId) {
  const url = event.url || event.link || event.eventUrl || null;
  if (!url) return null;
  return appendAffiliateId(url, affiliateId);
}

function appendAffiliateId(url, affiliateId) {
  if (!affiliateId || !url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('affid', affiliateId);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}affid=${affiliateId}`;
  }
}

// ===========================
// Helpers
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}