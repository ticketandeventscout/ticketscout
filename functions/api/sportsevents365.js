// ===========================
// TicketScout — Server-side SportsEvents365 adapter
// Runs as a Cloudflare Pages Function at /api/sportsevents365
//
// SE365 API flow (confirmed from full API docs):
//   1. Look up participant ID from KV cache (built by /api/sportsevents365-cache)
//   2. Call GET /events/participant/{id} with date filters to get upcoming events
//   3. Each event already includes minTicketPrice.price and eventUrl — no extra call needed
//
// Key API facts from docs:
//   - Date format: dd/mm/yyyy (NOT YYYY-MM-DD)
//   - Event response includes: dateOfEvent, timeOfEvent, eventUrl, minTicketPrice{price,currency}
//   - Currency can be requested via ?currency=GBP
//   - Affiliate URL: ticket.sportsevents365.com/event/{id}?affid={affiliateId}
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   SE365_API_KEY                — API key (Secret)
//   SE365_HTTP_USERNAME          — HTTP username (Secret)
//   SE365_HTTP_PASSWORD          — HTTP password (Secret)
//   SPORTSEVENTS365_AFFILIATE_ID — affiliate tracking ID = dvqg90rd8vv1f
//   GIGSBERG_KV                  — KV namespace (shared, already exists)
//   SE365_PROD                   — set to 'true' to use production API
// ===========================

const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';
const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';
const CACHE_KEY       = 'se365:participants:latest';

export async function onRequestGet({ request, env }) {
  const apiKey      = env.SE365_API_KEY;
  const httpUser    = env.SE365_HTTP_USERNAME;
  const httpPass    = env.SE365_HTTP_PASSWORD;
  const affiliateId = env.SPORTSEVENTS365_AFFILIATE_ID;
  const kv          = env.GIGSBERG_KV;
  const isProd      = env.SE365_PROD === 'true';

  if (!apiKey || !httpUser || !httpPass) {
    return jsonResponse({ error: 'SE365 credentials not configured.' }, 500);
  }
  if (!kv) {
    return jsonResponse({ error: 'GIGSBERG_KV binding not configured.' }, 500);
  }

  const baseUrl   = isProd ? PRODUCTION_BASE : SANDBOX_BASE;
  const basicAuth = btoa(`${httpUser}:${httpPass}`);
  const headers   = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept': 'application/json'
  };

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');
  const date     = incoming.searchParams.get('date') || ''; // YYYY-MM-DD from Ticketmaster
  const debug    = incoming.searchParams.get('debug') === '1';

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  try {
    // ── Step 1: Look up participant ID from KV cache ───────────────────────
    const cacheRaw = await kv.get(CACHE_KEY);
    if (!cacheRaw) {
      console.warn('SE365 participant cache is empty — run /api/sportsevents365-cache?trigger=1');
      return jsonResponse({ match: null, reason: 'cache_empty' }, 200);
    }

    const lookup      = JSON.parse(cacheRaw);
    const participant = findParticipant(lookup, q);

    if (debug) {
      // Show lookup result and raw events for debugging
      let eventsData = null;
      if (participant) {
        const evUrl = buildEventsUrl(baseUrl, apiKey, participant.id, date);
        const evResp = await fetch(evUrl, { headers });
        eventsData = await evResp.json();
      }
      return jsonResponse({
        debug: true,
        query: q,
        participantFound: participant || null,
        cacheEntries: Object.keys(lookup).length,
        eventsData
      }, 200);
    }

    if (!participant) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 2: Fetch upcoming events for this participant ─────────────────
    const eventsUrl  = buildEventsUrl(baseUrl, apiKey, participant.id, date);
    const eventsResp = await fetch(eventsUrl, { headers });

    if (!eventsResp.ok) {
      console.error(`SE365 events error: ${eventsResp.status}`);
      return jsonResponse({ match: null }, 200);
    }

    const eventsData = await eventsResp.json();

    // SE365 events endpoint returns an array directly or wrapped in data
    const events = Array.isArray(eventsData)
      ? eventsData
      : (eventsData?.data || eventsData?.events || []);

    if (events.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 3: Pick the best event ────────────────────────────────────────
    // Prefer date match if we have a target date; otherwise return soonest
    const event = findBestEvent(events, date);
    if (!event) {
      return jsonResponse({ match: null }, 200);
    }

    // ── Step 4: Build result — price and URL are in the event object ───────
    // minTicketPrice.price is the lowest available price (already confirmed in docs)
    // eventUrl is the direct SE365 event page
    const price    = event.minTicketPrice?.price || null;
    const currency = event.minTicketPrice?.currency || 'GBP';
    const eventUrl = buildAffiliateUrl(event, affiliateId);

    return jsonResponse({
      match: {
        name:     event.name || '',
        url:      eventUrl,
        price:    price ? Math.round(price) : null,
        currency,
        date:     event.dateOfEvent || '',
        venue:    event.venue?.name || null
      }
    }, 200);

  } catch (err) {
    console.error('SE365 adapter error:', err);
    return jsonResponse({ error: 'Unable to reach SportsEvents365.' }, 502);
  }
}

// ===========================
// Participant lookup — searches KV cache by name
// Tries exact match first, then partial matches
// ===========================

function findParticipant(lookup, query) {
  const normQuery = normaliseName(query);
  if (!normQuery) return null;

  // 1. Exact match
  if (lookup[normQuery]) return lookup[normQuery];

  // 2. Starts-with match
  const startsWith = Object.entries(lookup).find(([k]) => k.startsWith(normQuery));
  if (startsWith) return startsWith[1];

  // 3. Contains match (query found within participant name)
  const contains = Object.entries(lookup).find(([k]) => k.includes(normQuery));
  if (contains) return contains[1];

  // 4. Participant name found within query (e.g. query is "Chelsea vs Arsenal", name is "Chelsea")
  const within = Object.entries(lookup).find(([k]) => normQuery.includes(k) && k.length > 4);
  if (within) return within[1];

  return null;
}

// ===========================
// Events URL builder
// Converts YYYY-MM-DD from Ticketmaster to dd/mm/yyyy for SE365
// Adds a 30-day window from the event date
// ===========================

function buildEventsUrl(baseUrl, apiKey, participantId, targetDate) {
  const url = new URL(`${baseUrl}/events/participant/${participantId}`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('currency', 'GBP');
  url.searchParams.set('perPage', '20');

  if (targetDate) {
    // Convert YYYY-MM-DD → dd/mm/yyyy for SE365
    const [year, month, day] = targetDate.split('-');
    if (year && month && day) {
      // Search ±7 days around the target date
      const from = new Date(targetDate);
      from.setDate(from.getDate() - 7);
      const to = new Date(targetDate);
      to.setDate(to.getDate() + 7);

      url.searchParams.set('dateFrom', formatDate(from));
      url.searchParams.set('dateTo',   formatDate(to));
    }
  } else {
    // No target date — get upcoming events (next 90 days)
    const from = new Date();
    const to   = new Date();
    to.setDate(to.getDate() + 90);
    url.searchParams.set('dateFrom', formatDate(from));
    url.searchParams.set('dateTo',   formatDate(to));
  }

  return url.toString();
}

// Format a Date object as dd/mm/yyyy for SE365
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

// ===========================
// Event selection
// ===========================

function findBestEvent(events, targetDate) {
  if (!events.length) return null;

  // Parse SE365 date format dd/mm/yyyy into a comparable Date
  const parseEventDate = (e) => {
    const raw = e.dateOfEvent || '';
    if (!raw) return null;
    const [d, m, y] = raw.split('/');
    if (!d || !m || !y) return null;
    return new Date(`${y}-${m}-${d}`);
  };

  // Filter to upcoming only
  const now = new Date();
  const upcoming = events.filter(e => {
    const d = parseEventDate(e);
    return d && d >= now;
  });

  const pool = upcoming.length > 0 ? upcoming : events;

  // If we have a target date, find closest event to it
  if (targetDate) {
    const target = new Date(targetDate);
    pool.sort((a, b) => {
      const da = parseEventDate(a);
      const db = parseEventDate(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return Math.abs(da - target) - Math.abs(db - target);
    });
  } else {
    // Return soonest event
    pool.sort((a, b) => {
      const da = parseEventDate(a);
      const db = parseEventDate(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  }

  return pool[0];
}

// ===========================
// Affiliate URL builder
// SE365 event URL format: https://ticket.sportsevents365.com/event/{id}
// Append affiliate ID as affid parameter
// ===========================

function buildAffiliateUrl(event, affiliateId) {
  // Prefer the eventUrl from the API response
  const baseUrl = event.eventUrl
    || `https://ticket.sportsevents365.com/event/${event.id}`;

  if (!affiliateId) return baseUrl;

  try {
    const u = new URL(baseUrl);
    u.searchParams.set('affid', affiliateId);
    return u.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}affid=${affiliateId}`;
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
