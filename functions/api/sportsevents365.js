// ===========================
// TicketScout — Server-side SportsEvents365 adapter
// Runs as a Cloudflare Pages Function at /api/sportsevents365
// VERSION: 20260710-365days — perPage=50, window=365 days for list mode
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
//   - Affiliate URL: ticket.sportsevents365.com/event/{id}?a_aid={affiliateId}
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

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const apiKey      = env.SE365_API_KEY;
  const httpUser    = env.SE365_HTTP_USERNAME;
  const httpPass    = env.SE365_HTTP_PASSWORD;
  const httpSource  = env.SE365_HTTP_SOURCE || '';
  const affiliateId = env.SPORTSEVENTS365_AFFILIATE_ID;
  const kv          = env.GIGSBERG_KV;
  const isProd      = env.SE365_PROD === 'true' || env.SE365_PROD === true;

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
    'Accept': 'application/json',
    ...(httpSource ? { 'Source': httpSource } : {})
  };

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');
  const date     = incoming.searchParams.get('date') || ''; // YYYY-MM-DD from Ticketmaster
  const debug    = incoming.searchParams.get('debug') === '1';
  const mode     = incoming.searchParams.get('mode') || 'single'; // 'list' returns all matches
  // Phase 1.4B: callers that know their page category declare it so served
  // events can be registered for SSR (same pattern as awin-events.js).
  const cat      = (incoming.searchParams.get('cat') || '').trim().toLowerCase();

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
        const evUrl = buildEventsUrl(baseUrl, apiKey, participant.id, date, mode);
        const evResp = await fetch(evUrl, { headers });
        eventsData = await evResp.json();
      }
      // Build the URL that would be used so we can verify date window
      const debugUrl = participant ? buildEventsUrl(baseUrl, apiKey, participant.id, date, mode) : null;
      return jsonResponse({
        debug: true,
        version: '20260710-365days',
        mode,
        debugUrl,
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
    const eventsUrl  = buildEventsUrl(baseUrl, apiKey, participant.id, date, mode);
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

    // ── Step 3: Filter to upcoming, sort by date ──────────────────────────
    const parseEventDate = (e) => {
      const raw = e.dateOfEvent || '';
      if (!raw) return null;
      const [d, m, y] = raw.split('/');
      return (d && m && y) ? new Date(`${y}-${m}-${d}`) : null;
    };
    const now      = new Date();
    const upcoming = events
      .filter(e => { const d = parseEventDate(e); return d && d >= now; })
      .sort((a, b) => (parseEventDate(a) || 0) - (parseEventDate(b) || 0));

    const pool = upcoming.length > 0 ? upcoming : events;
    if (pool.length === 0) return jsonResponse(mode === 'list' ? { matches: [] } : { match: null }, 200);

    // Phase 1.4B: register upcoming SE365 events in the D1 events registry
    // so /event/{slug} pages can server-render them.
    // Category resolution — never guess: (1) the caller's declared cat wins;
    // (2) otherwise participants with eventTypeId 1000 (Football) register
    // as football; (3) anything else (rugby, F1, concerts…) is SKIPPED —
    // SE365 spans many event types and a mis-categorised URL/JSON-LD page
    // is worse than no page. When new category pages start calling this
    // adapter they declare their own cat and coverage grows for free.
    const regCategory =
      (['football', 'concert', 'theatre'].includes(cat) && cat) ||
      (participant.eventTypeId === 1000 ? 'football' : null);
    if (regCategory) tsCaptureThrottled(env, (p) => ctx.waitUntil(p), 'se365:' + regCategory + ':' + participant.id, () => {
      const records = [];
      for (const e of upcoming.slice(0, 50)) {
        const [dd, mm, yyyy] = String(e.dateOfEvent || '').split('/');
        const iso = (dd && mm && yyyy) ? `${yyyy}-${mm}-${dd}` : '';
        const slug = tsEventSlug(regCategory, iso, e.name || '');
        if (!slug) continue;
        records.push({
          slug, category: regCategory, name: e.name, date: iso,
          venue: e.venue?.name || null,
          city: e.city?.name || e.venue?.city?.name || e.location?.city?.name || null,
          price: e.minTicketPrice?.price ? Math.round(e.minTicketPrice.price) : null,
          currency: e.minTicketPrice?.currency || 'GBP',
          tmUrl: null, image: null, source: 'se365'
        });
      }
      return records;
    });

    // ── Step 4: Build result ───────────────────────────────────────────────
    const buildMatch = (event) => ({
      name:     event.name || '',
      url:      buildAffiliateUrl(event, affiliateId),
      price:    event.minTicketPrice?.price ? Math.round(event.minTicketPrice.price) : null,
      currency: event.minTicketPrice?.currency || 'GBP',
      date:     event.dateOfEvent || '',
      time:     event.timeOfEvent || '',
      venue:    event.venue?.name || null,
      // SE365 city: try top-level city first, then venue.city, then location
      city:     event.city?.name || event.venue?.city?.name || event.location?.city?.name || null
    });

    if (mode === 'list') {
      // Return ALL upcoming events (capped at 50 to avoid oversized responses)
      return jsonResponse({ matches: pool.slice(0, 50).map(buildMatch) }, 200);
    }

    // Single mode — return best match (closest to target date, or soonest)
    const event = findBestEvent(pool, date);
    if (!event) return jsonResponse({ match: null }, 200);
    return jsonResponse({ match: buildMatch(event) }, 200);

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

  // 2. Starts-with match (e.g. "real madrid" matches "real madrid cf")
  const startsWith = Object.entries(lookup).find(([k]) => k.startsWith(normQuery));
  if (startsWith) return startsWith[1];

  // 3. Query starts-with participant (e.g. participant "real madrid" within query "real madrid cf")
  const queryStartsWith = Object.entries(lookup).find(([k]) => normQuery.startsWith(k) && k.length > 6);
  if (queryStartsWith) return queryStartsWith[1];

  // 4. Word-boundary contains — ALL significant words in query must appear in participant name
  // Prevents "Real Madrid" matching "Atletico de Madrid" via partial "madrid" match
  // Also handles "Munich" vs "Munchen" via prefix matching (first 4 chars)
  const queryWords = normQuery.split(/\s+/).filter(w => w.length > 2);
  const wordMatch = Object.entries(lookup).find(([k]) => {
    return queryWords.every(w => {
      // Exact word match
      if (k.includes(w)) return true;
      // Prefix match for umlaut variants: "munich" matches "munchen" (muni == munc, no)
      // Use first 5 chars: "munic" vs "munch" — still no
      // Better: if words share first 4 chars they're likely the same city name
      const wPrefix = w.slice(0, 4);
      return k.split(/\s+/).some(kw => kw.startsWith(wPrefix) && wPrefix.length >= 3);
    });
  });
  if (wordMatch) return wordMatch[1];

  // 5. Participant name found within query (e.g. query is "Chelsea vs Arsenal", name is "Chelsea")
  // Require participant name to be longer than 6 chars to avoid "ac" or "fc" false matches
  const within = Object.entries(lookup).find(([k]) => normQuery.includes(k) && k.length > 6);
  if (within) return within[1];

  return null;
}

// ===========================
// Events URL builder
// Converts YYYY-MM-DD from Ticketmaster to dd/mm/yyyy for SE365
// Adds a 30-day window from the event date
// ===========================

function buildEventsUrl(baseUrl, apiKey, participantId, targetDate, mode) {
  const url = new URL(`${baseUrl}/events/participant/${participantId}`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('currency', 'GBP');
  // In list mode fetch up to 50 events; single mode only needs a few
  url.searchParams.set('perPage', mode === 'list' ? '50' : '20');

  if (targetDate) {
    // Single mode with date — tight ±2 day window for exact event matching
    const [year, month, day] = targetDate.split('-');
    if (year && month && day) {
      const from = new Date(targetDate);
      from.setDate(from.getDate() - 2);
      const to = new Date(targetDate);
      to.setDate(to.getDate() + 2);
      url.searchParams.set('dateFrom', formatDate(from));
      url.searchParams.set('dateTo',   formatDate(to));
    }
  } else {
    // No target date — get all upcoming events
    // List mode: full season (365 days); single mode: 90 days
    const from = new Date();
    const to   = new Date();
    to.setDate(to.getDate() + (mode === 'list' ? 365 : 90));
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
// Append affiliate ID as a_aid parameter (confirmed by Nir at SE365)
// ===========================

function buildAffiliateUrl(event, affiliateId) {
  // Prefer the eventUrl from the API response
  const baseUrl = event.eventUrl
    || `https://ticket.sportsevents365.com/event/${event.id}`;

  if (!affiliateId) return baseUrl;

  try {
    const u = new URL(baseUrl);
    u.searchParams.set('a_aid', affiliateId);
    return u.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}a_aid=${affiliateId}`;
  }
}

// ===========================
// Helpers
// ===========================

function normaliseName(str) {
  return (str || '')
    .toLowerCase()
    // Transliterate umlauts so "München" and "Munchen" both normalise to "munchen"
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/é|è|ê/g, 'e').replace(/à|â/g, 'a').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

// Synonym map for team name variations — maps our search term to SE365 participant name words
const TEAM_SYNONYMS = {
  'munich': 'munchen',
  'munchen': 'munchen',
  'marseille': 'marseille',
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}


// ===========================
// Phase 1.4B — event registry capture
// Shared block: identical copies live in ticketmaster.js and the other
// capture files; tsEventSlug also has a client copy in compare.js.
// Slug format is FROZEN v1 — never change without migrating /event/ URLs.
// ===========================

// {category}-{yyyy-mm-dd}-{normalised-name} — MUST MATCH all other copies.
function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}

// Batched D1 upsert. updated_at only bumps when content actually changed —
// the sitemap uses it as lastmod, and fake lastmod trains Google to ignore it.
async function tsRegisterEvents(env, records) {
  const db = env.PRICE_DB;
  if (!db || !records || !records.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) ' +
    'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ' +
    'ON CONFLICT(slug) DO UPDATE SET ' +
    'name=excluded.name, ' +
    'venue=COALESCE(excluded.venue, event_pages.venue), ' +
    'city=COALESCE(excluded.city, event_pages.city), ' +
    'price=COALESCE(excluded.price, event_pages.price), ' +
    'currency=COALESCE(excluded.currency, event_pages.currency), ' +
    'tm_url=COALESCE(excluded.tm_url, event_pages.tm_url), ' +
    'image=COALESCE(excluded.image, event_pages.image), ' +
    'source=excluded.source, ' +
    'updated_at=CASE WHEN event_pages.name IS NOT excluded.name ' +
    'OR event_pages.venue IS NOT COALESCE(excluded.venue, event_pages.venue) ' +
    'OR event_pages.city IS NOT COALESCE(excluded.city, event_pages.city) ' +
    'OR event_pages.price IS NOT COALESCE(excluded.price, event_pages.price) ' +
    'THEN excluded.updated_at ELSE event_pages.updated_at END'
  );
  const seen = new Set();
  const batch = [];
  for (const r of records) {
    if (!r || !r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    batch.push(stmt.bind(
      r.slug, r.category, r.name, r.date,
      r.venue || null, r.city || null,
      r.price || null, r.currency || null,
      r.tmUrl || null, r.image || null,
      r.source || null, now
    ));
    if (batch.length >= 400) break; // per-request safety cap
  }
  if (batch.length) await db.batch(batch);
}

// Cache-API throttle: at most one registry write per markerId per 6h per
// colo. Costs zero KV writes; fail-open and fully fire-and-forget.
function tsCaptureThrottled(env, waitUntil, markerId, buildRecords) {
  try {
    if (!env.PRICE_DB) return;
    const cache = caches.default;
    const marker = new Request('https://ts-internal.ticketscout.co.uk/event-capture/' + encodeURIComponent(markerId));
    waitUntil((async () => {
      if (await cache.match(marker)) return;
      const records = buildRecords();
      if (!records || !records.length) return;
      await tsRegisterEvents(env, records);
      await cache.put(marker, new Response('1', { headers: { 'Cache-Control': 'max-age=21600' } }));
    })().catch(() => {}));
  } catch {}
}
