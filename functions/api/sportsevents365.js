// ===========================
// TicketScout — Server-side SportsEvents365 adapter
// Runs as a Cloudflare Pages Function at /api/sportsevents365
//
// SportsEvents365 is a real-time REST API (no feed caching needed).
// Auth uses two mechanisms on every request:
//   1. Basic Auth header: Base64("username:password")
//   2. apiKey query parameter
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   SE365_API_KEY       — API key (Secret)
//   SE365_HTTP_USERNAME — HTTP username (Secret)
//   SE365_HTTP_PASSWORD — HTTP password (Secret)
//   SE365_HTTP_SOURCE   — HTTP source identifier e.g. "TICKETSCOUT" (Secret)
//   SPORTSEVENTS365_AFFILIATE_ID — affiliate tracking ID = dvqg90rd8vv1f
//
// Sandbox base URL:    https://api-v2.sandbox365.com
// Production base URL: https://api-v2.sportsevents365.com
// Switch SE365_PROD=true in env vars to use production (after agreement signed)
//
// Part of the TicketScout source adapter pattern.
// Normalisation into { source, price, currency, url, available }
// is handled in compare.js by the SE365 adapter entry.
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

  const baseUrl = isProd ? PRODUCTION_BASE : SANDBOX_BASE;

  // Build Basic Auth header: Base64("username:password")
  const basicAuth = btoa(`${httpUser}:${httpPass}`);

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');         // event/team name to search
  const date     = incoming.searchParams.get('date') || ''; // YYYY-MM-DD from Ticketmaster

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  try {
    // ── Step 1: Search for participants (teams/performers) matching the query ──
    // This is more reliable than searching events directly by name, since
    // SE365's participant names are stable while event names include date/venue suffixes.
    const participantUrl = new URL(`${baseUrl}/participants`);
    participantUrl.searchParams.set('apiKey', apiKey);
    participantUrl.searchParams.set('name', q);
    participantUrl.searchParams.set('size', '5');

    const participantResp = await fetch(participantUrl.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    if (!participantResp.ok) {
      console.error(`SE365 participants error: ${participantResp.status}`);
      return jsonResponse({ match: null }, 200);
    }

    const participantData = await participantResp.json();
    const participants    = participantData?.content || participantData?.data || [];

    if (participants.length === 0) {
      // No participant match — fall back to direct event keyword search
      return await searchEventsDirect(baseUrl, apiKey, basicAuth, q, date, affiliateId);
    }

    // Pick the best-matching participant
    const participant = findBestParticipant(participants, q);
    if (!participant) {
      return await searchEventsDirect(baseUrl, apiKey, basicAuth, q, date, affiliateId);
    }

    // ── Step 2: Fetch upcoming events for this participant ──
    const eventsUrl = new URL(`${baseUrl}/events`);
    eventsUrl.searchParams.set('apiKey', apiKey);
    eventsUrl.searchParams.set('participantId', participant.id);
    eventsUrl.searchParams.set('size', '20');
    eventsUrl.searchParams.set('sort', 'date,asc');

    const eventsResp = await fetch(eventsUrl.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    if (!eventsResp.ok) {
      console.error(`SE365 events error: ${eventsResp.status}`);
      return jsonResponse({ match: null }, 200);
    }

    const eventsData = await eventsResp.json();
    const events     = eventsData?.content || eventsData?.data || eventsData?.events || [];

    if (events.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    const match = findBestEvent(events, q, date);
    if (!match) {
      return jsonResponse({ match: null }, 200);
    }

    return jsonResponse({
      match: toResult(match, affiliateId)
    }, 200);

  } catch (err) {
    console.error('SE365 adapter error:', err);
    return jsonResponse({ error: 'Unable to reach SportsEvents365.' }, 502);
  }
}

// ===========================
// Fallback: search events directly by keyword when no participant match
// ===========================

async function searchEventsDirect(baseUrl, apiKey, basicAuth, q, date, affiliateId) {
  try {
    const eventsUrl = new URL(`${baseUrl}/events`);
    eventsUrl.searchParams.set('apiKey', apiKey);
    eventsUrl.searchParams.set('name', q);
    eventsUrl.searchParams.set('size', '10');
    eventsUrl.searchParams.set('sort', 'date,asc');

    const resp = await fetch(eventsUrl.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    if (!resp.ok) return jsonResponse({ match: null }, 200);

    const data   = await resp.json();
    const events = data?.content || data?.data || data?.events || [];

    if (events.length === 0) return jsonResponse({ match: null }, 200);

    const match = findBestEvent(events, q, date);
    if (!match) return jsonResponse({ match: null }, 200);

    return jsonResponse({ match: toResult(match, affiliateId) }, 200);

  } catch {
    return jsonResponse({ match: null }, 200);
  }
}

// ===========================
// Matching helpers
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

// Find the best-matching participant from the SE365 /participants response
function findBestParticipant(participants, query) {
  const normQuery = normaliseName(query);

  const scored = participants
    .map(p => {
      const normName = normaliseName(p.name || p.fullName || '');
      let score = 0;
      if (normName === normQuery)                                   score = 100;
      else if (normName.startsWith(normQuery))                      score = 60;
      else if (normName.includes(normQuery))                        score = 30;
      else if (normQuery.includes(normName) && normName.length > 4) score = 20;
      return { participant: p, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].participant : null;
}

// Find the best-matching event — prefer date match, then name match, then lowest price
function findBestEvent(events, query, targetDate) {
  const normQuery = normaliseName(query);

  const scored = events
    .map(e => {
      const nameStr  = normaliseName(e.name || e.title || e.eventName || '');
      const homeStr  = normaliseName(e.homeTeam?.name || '');
      const awayStr  = normaliseName(e.awayTeam?.name || '');

      let score = 0;

      // Score against event name
      if (nameStr === normQuery)                                    score = Math.max(score, 100);
      else if (nameStr.startsWith(normQuery))                       score = Math.max(score, 60);
      else if (nameStr.includes(normQuery))                         score = Math.max(score, 30);
      else if (normQuery.includes(nameStr) && nameStr.length > 4)  score = Math.max(score, 20);

      // Also score against home/away team names (for sport fixtures)
      if (homeStr.includes(normQuery) || awayStr.includes(normQuery)) {
        score = Math.max(score, 40);
      }

      return { event: e, score };
    })
    .filter(r => r.score > 0);

  if (scored.length === 0) return null;

  // Split into date-matched and fallback groups
  const dateMatched = targetDate
    ? scored.filter(r => isDateMatch(getEventDate(r.event), targetDate))
    : [];

  const pool = dateMatched.length > 0 ? dateMatched : scored;

  // Sort: score desc, then price asc
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const priceA = getLowestPrice(a.event);
    const priceB = getLowestPrice(b.event);
    if (priceA && !priceB) return -1;
    if (!priceA && priceB) return  1;
    if (priceA && priceB)  return priceA - priceB;
    return 0;
  });

  return pool[0].event;
}

// Returns true if the event date is within windowDays of targetDate (YYYY-MM-DD)
function isDateMatch(eventDate, targetDate, windowDays = 3) {
  if (!eventDate || !targetDate) return false;
  try {
    const target = new Date(targetDate);
    const event  = new Date(eventDate);
    if (isNaN(target.getTime()) || isNaN(event.getTime())) return false;
    const diffDays = Math.abs(target - event) / (1000 * 60 * 60 * 24);
    return diffDays <= windowDays;
  } catch {
    return false;
  }
}

// Extract a usable date string from an SE365 event object
// SE365 may use different field names depending on event type
function getEventDate(event) {
  return event.date || event.eventDate || event.startDate || event.dateTime || '';
}

// Extract the lowest available price from an SE365 event object
function getLowestPrice(event) {
  // SE365 may return prices in different shapes — handle the common patterns
  if (event.minPrice)           return parseFloat(event.minPrice);
  if (event.price)              return parseFloat(event.price);
  if (event.priceFrom)          return parseFloat(event.priceFrom);
  if (event.tickets?.minPrice)  return parseFloat(event.tickets.minPrice);
  if (Array.isArray(event.ticketCategories) && event.ticketCategories.length > 0) {
    const prices = event.ticketCategories
      .map(c => parseFloat(c.price || c.minPrice || 0))
      .filter(p => p > 0);
    return prices.length > 0 ? Math.min(...prices) : null;
  }
  return null;
}

// Build the affiliate redirect URL
// SE365 affiliate tracking: append affiliate ID as a query param
function buildAffiliateUrl(event, affiliateId) {
  // SE365 provides a direct event URL; we append the affiliate tracking ID
  const baseEventUrl = event.url || event.eventUrl || event.link || '';

  if (!baseEventUrl) return null;

  try {
    const u = new URL(baseEventUrl);
    if (affiliateId) u.searchParams.set('affid', affiliateId);
    return u.toString();
  } catch {
    // If URL parsing fails, append manually
    if (!baseEventUrl) return null;
    const sep = baseEventUrl.includes('?') ? '&' : '?';
    return affiliateId
      ? `${baseEventUrl}${sep}affid=${affiliateId}`
      : baseEventUrl;
  }
}

// Normalise an SE365 event into the standard TicketScout result shape
function toResult(event, affiliateId) {
  const price = getLowestPrice(event);
  const url   = buildAffiliateUrl(event, affiliateId);

  return {
    name:      event.name || event.title || event.eventName || '',
    url,
    price:     price ? Math.round(price) : null,
    currency:  event.currency || 'GBP',
    date:      getEventDate(event),
    venue:     event.venue?.name || event.venueName || null
  };
}

// ===========================
// Helper
// ===========================

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
