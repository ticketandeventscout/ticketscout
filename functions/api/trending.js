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
  if (!r.ok) return { ok: false, status: r.status, events: [], names: [] };

  const data = await r.json();
  const raw = (data._embedded && data._embedded.events) || [];

  const seen = new Set();
  const events = [];
  const names = [];
  for (const e of raw) {
    if (!isRealEvent(e)) continue;
    const k = performanceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(slim(e));           // slim immediately; raw is released below
    if (names.length < 8) names.push(e.name);
  }
  return { ok: true, status: r.status, returned: raw.length, events, names };
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
    for (const t of targets) {                 // sequential: bounds peak memory
      const res = await fetchSegment(apiKey, t.name, t.size);
      buckets.push(res.events);
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
