// /api/trending — server-side trending grid for the homepage.
//
// WHY THIS EXISTS
// The homepage used to fetch raw /api/ticketmaster JSON and filter it in the
// browser. Live probe 23 Jul showed that cannot work: TM's relevance,desc
// returns whole attraction blocks in sequence rather than interleaving, so
// diversity is ordering-limited, not size-limited —
//
//   size   All   Music        Sports       Arts & Theatre
//   40     3     9 (1140 KB)  23 (392 KB)  1 (326 KB)
//   100    3     20 (2083 KB) 31 (1022 KB) 1 (814 KB)
//   200    3     44 (4039 KB) 49 (1985 KB) 1 (1627 KB)
//
// "All" is frozen at 3 unique attractions even across 200 rows. The only way
// to get a diverse grid is to query each segment separately and blend — but
// that is ~4 MB, which cannot be shipped to a browser. Doing it here costs
// the user nothing: the function absorbs the payload and returns ~5 KB.
//
// Segment calls run SEQUENTIALLY and each raw payload is slimmed and released
// before the next, to keep peak memory well clear of the Worker limit that
// bit the CSV feeds (Error 1102).

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

// Segments that represent real ticketed events. TM classifies attractions
// (The View from The Shard, Twist Museum, Sea Life) as Miscellaneous /
// Undefined — confirmed against the live payload 23 Jul.
const SEGMENTS = [
  { name: 'Music',          size: 100 },
  { name: 'Sports',         size: 100 },
  { name: 'Arts & Theatre', size: 100 }
];

const EDGE_TTL = 600;              // 10 min, matches /api/ticketmaster
const LAST_GOOD_TTL = 60 * 60 * 24 * 7;

function isRealEvent(e) {
  const c = (e && e.classifications && e.classifications[0]) || null;
  if (!c) return false;
  const genre = (c.genre && c.genre.name) || '';
  return genre !== 'Undefined';
}

// Collapse repeat performances of one production. A West End run puts the
// same show on for months — Harry Potter alone fills 200 rows.
function performanceKey(e) {
  const attr = e && e._embedded && e._embedded.attractions && e._embedded.attractions[0];
  if (attr && attr.id) return 'a:' + attr.id;
  const name = String((e && e.name) || '')
    .toLowerCase()
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\s*(am|pm)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return 'n:' + name;
}

// Keep ONLY what renderEventCards() in events.js reads, in TM's original
// shape, so the renderer needs no changes. ~300 bytes per card.
function slim(e) {
  const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || null;
  const c = (e.classifications && e.classifications[0]) || null;
  const imgs = (e.images || [])
    .filter(i => i.ratio === '16_9' && i.width >= 400)
    .sort((a, b) => a.width - b.width)
    .slice(0, 1)
    .map(i => ({ url: i.url, width: i.width, ratio: i.ratio }));

  const out = {
    id: e.id,
    name: e.name,
    dates: { start: { localDate: e.dates && e.dates.start && e.dates.start.localDate } },
    images: imgs.length ? imgs : (e.images || []).slice(0, 1).map(i => ({ url: i.url, width: i.width, ratio: i.ratio })),
    classifications: c ? [{
      segment: { name: (c.segment && c.segment.name) || '' },
      genre:   { name: (c.genre && c.genre.name) || '' }
    }] : [],
    _embedded: v ? { venues: [{ name: v.name || '', city: { name: (v.city && v.city.name) || '' } }] } : undefined
  };

  const pr = e.priceRanges && e.priceRanges[0];
  if (pr && pr.min != null) out.priceRanges = [{ min: pr.min, currency: pr.currency || 'GBP' }];

  return out;
}

async function fetchSegment(apiKey, segment, size) {
  const url = new URL(TM_BASE);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('countryCode', 'GB');
  url.searchParams.set('size', String(size));
  url.searchParams.set('sort', 'relevance,desc');
  url.searchParams.set('startDateTime', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  if (segment) url.searchParams.set('segmentName', segment);

  const r = await fetch(url.toString());
  if (!r.ok) return { ok: false, status: r.status, events: [], names: [], registryRecords: [] };

  const data = await r.json();
  const raw = (data._embedded && data._embedded.events) || [];

  const seen = new Set();
  const events = [];
  const names = [];
  const registryRecords = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const e of raw) {
    if (!isRealEvent(e)) continue;
    const k = performanceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(slim(e));           // slim immediately; raw is released below
    if (names.length < 8) names.push(e.name);

    // FIX (6 Aug 2026): trending.js fetches TM directly and never registered
    // anything into event_pages — every /event/{slug} link on the homepage's
    // own trending grid was structurally unregisterable regardless of
    // traffic, since the one hook that writes event_pages (tsCaptureThrottled
    // in ticketmaster.js) only fires on the /api/ticketmaster PROXY path,
    // which this file bypasses entirely. Confirmed live via GSC: featured
    // homepage fixtures (Arsenal vs Como) still noindexed with zero D1 row.
    // Built from the RAW event, not the slimmed card — slim() drops e.url
    // (needed for tmUrl) to keep card payloads small.
    const category = tsTmCategory(e);
    const date = (e.dates && e.dates.start && e.dates.start.localDate) || '';
    if (category && date && date >= today) {
      const slug = tsEventSlug(category, date, normaliseFixtureName(e.name));
      if (slug) {
        const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
        // LCP FIX (6 Aug 2026): matches the fix in ticketmaster.js's
        // tsExtractTmRecords — this line was copied from there when the
        // registration hook above was added, which means it carried the
        // exact bug that caused the 2.7MB/16.4s LCP problem (first 16:9
        // image over 300px, not the smallest adequate one; TM's array can
        // list multi-megapixel hero-banner variants ahead of reasonably
        // sized ones). Fixed the same way here for consistency.
        const candidates16x9 = (e.images || []).filter(im => im && im.ratio === '16_9' && im.url && im.width);
        const img = candidates16x9.length
          ? (candidates16x9.slice().sort((a, b) => a.width - b.width).find(im => im.width >= 700)
             || candidates16x9.slice().sort((a, b) => a.width - b.width).pop())
          : (e.images || [])[0];
        registryRecords.push({
          slug, category, name: e.name, date,
          venue: (venue && venue.name) || null,
          city: (venue && venue.city && venue.city.name) || null,
          price: (e.priceRanges && e.priceRanges[0] && e.priceRanges[0].min) ? Math.round(e.priceRanges[0].min) : null,
          currency: (e.priceRanges && e.priceRanges[0] && e.priceRanges[0].currency) || 'GBP',
          tmUrl: e.url || null,
          image: (img && img.url) || null,
          source: 'tm'
        });
      }
    }
  }
  return { ok: true, status: r.status, returned: raw.length, events, names, registryRecords };
}

// Round-robin across segments so the grid is a genuine mix rather than
// whichever segment happened to return most.
function blend(buckets, limit) {
  const out = [];
  let i = 0;
  while (out.length < limit) {
    let added = false;
    for (const b of buckets) {
      if (b[i]) { out.push(b[i]); added = true; if (out.length >= limit) break; }
    }
    if (!added) break;
    i++;
  }
  return out;
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + EDGE_TTL
    }, extraHeaders || {})
  });
}

// ===========================
// Phase 1.4B — event registry capture
// Byte-identical copies live in ticketmaster.js, sportsevents365.js,
// awin-events.js and awin-category-cache.js. !! MUST MATCH !! all of them —
// see the extended comment on normaliseFixtureName() in ticketmaster.js for
// why (duplicate /event/ URL prevention across sources).
// ===========================

// TM segment → TicketScout category. Unknown segments are skipped.
function tsTmCategory(event) {
  const seg   = event && event.classifications && event.classifications[0] && event.classifications[0].segment && event.classifications[0].segment.name || '';
  const genre = event && event.classifications && event.classifications[0] && event.classifications[0].genre && event.classifications[0].genre.name || '';
  if (seg === 'Sports') return (genre === 'Soccer') ? 'football' : 'sports';
  if (seg === 'Music') return 'concert';
  if (seg === 'Arts & Theatre') return 'theatre';
  return null;
}

function normaliseFixtureName(name) {
  let n = String(name || '');
  const COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (const p of COMPETITION_PREFIXES) {
    const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');
  const stripSuffix = (side) => side
    .replace(/\./g, '')
    .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
    .trim();
  const parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    const sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort((a, b) => a.localeCompare(b));
    n = sides[0] + ' vs ' + sides[1];
  }
  return n.trim();
}

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

// Batched D1 upsert — identical logic/shape to ticketmaster.js's copy,
// including the legacy-schema fallback for pre-migration deploys.
async function tsRegisterEvents(env, records) {
  const db = env.PRICE_DB;
  if (!db || !records || !records.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at, created_at) ' +
    'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ' +
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
      r.source || null, now, now
    ));
    if (batch.length >= 400) break;
  }
  if (!batch.length) return;
  try {
    await db.batch(batch);
  } catch (e) {
    console.error('trending.js tsRegisterEvents: 13-col insert failed, falling back to legacy schema:', e);
    const legacyStmt = db.prepare(
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
    const legacySeen = new Set();
    const legacyBatch = [];
    for (const r of records) {
      if (!r || !r.slug || legacySeen.has(r.slug)) continue;
      legacySeen.add(r.slug);
      legacyBatch.push(legacyStmt.bind(
        r.slug, r.category, r.name, r.date,
        r.venue || null, r.city || null,
        r.price || null, r.currency || null,
        r.tmUrl || null, r.image || null,
        r.source || null, now
      ));
      if (legacyBatch.length >= 400) break;
    }
    if (legacyBatch.length) await db.batch(legacyBatch);
  }
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const incoming = new URL(request.url);
  const wantSegment = incoming.searchParams.get('segment') || '';
  const debug = incoming.searchParams.get('debug') === '1';
  const limit = Math.min(parseInt(incoming.searchParams.get('limit') || '12', 10) || 12, 24);

  const cacheKey = new Request(incoming.toString(), request);
  const cache = caches.default;

  if (!debug) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const apiKey = env.TM_API_KEY;
  if (!apiKey) return json({ error: 'Server is missing TM_API_KEY.' }, 500);

  const kv = env.GIGSBERG_KV || null;
  // Key is deliberately built from only the params that change the result,
  // so a stray param can never make the key unique and defeat the fallback.
  const lastGoodKey = 'trending:lastgood:' + (wantSegment || 'all') + ':' + limit;

  const targets = wantSegment
    ? SEGMENTS.filter(s => s.name.toLowerCase() === wantSegment.toLowerCase())
    : SEGMENTS;

  if (!targets.length) return json({ error: 'Unknown segment: ' + wantSegment }, 400);

  try {
    const buckets = [];
    const diag = [];
    const allRegistryRecords = [];
    for (const t of targets) {                 // sequential: bounds peak memory
      const res = await fetchSegment(apiKey, t.name, t.size);
      buckets.push(res.events);
      if (res.registryRecords && res.registryRecords.length) allRegistryRecords.push(...res.registryRecords);
      diag.push({
        segment: t.name, size: t.size, httpStatus: res.status,
        returned: res.returned || 0, unique: res.events.length,
        topAttractions: res.names
      });
    }

    const events = blend(buckets, limit);

    if (debug) {
      return json({
        checkedAt: new Date().toISOString(),
        segments: diag,
        blendedCount: events.length,
        approxBytes: JSON.stringify(events).length
      }, 200, { 'Cache-Control': 'no-store' });
    }

    if (!events.length) throw new Error('No events after filter and dedup');

    // FIX (6 Aug 2026): register every event this request actually saw into
    // event_pages, not just the ones that made the blended grid — a fixture
    // can appear in the raw segment pull without being one of the `limit`
    // cards returned, and it's just as real either way. Fire-and-forget,
    // gated on PRICE_DB existing; this endpoint's own edge cache (10 min TTL)
    // already throttles how often a fresh TM fetch (and therefore a write)
    // happens, so no extra throttle marker is needed here unlike
    // ticketmaster.js/sportsevents365.js, which get hit far more directly.
    // Only fires on the real (non-debug) path, since debug bypasses the
    // cache and could otherwise trigger repeated writes while testing.
    if (env.PRICE_DB && allRegistryRecords.length) {
      ctx.waitUntil(tsRegisterEvents(env, allRegistryRecords).catch(() => {}));
    }

    const payload = { _embedded: { events } };
    const body = JSON.stringify(payload);

    if (kv) {
      ctx.waitUntil(
        kv.put(lastGoodKey, body, { expirationTtl: LAST_GOOD_TTL })
          .catch(() => {})            // D1/KV writes in waitUntil fail silently
      );
    }

    const resp = json(payload, 200);
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;

  } catch (err) {
    if (kv) {
      const stale = await kv.get(lastGoodKey);
      if (stale) {
        return new Response(stale, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
            'X-Trending-Fallback': 'kv-last-good'
          }
        });
      }
    }
    return json({ error: 'Trending unavailable: ' + String(err && err.message || err) }, 503);
  }
}