// Batch price lookup for entity hub page schema enrichment (23 Aug 2026,
// follow-up to R1 — REVISED). The first version of this endpoint queried
// event_pages.price, which turned out to be the wrong source: that column
// is itself just a cached copy of Ticketmaster's own priceRanges (see
// ticketmaster.js's tsExtractTmRecords), so it has exactly the same "often
// empty" problem this endpoint exists to work around. Confirmed live:
// Metallica's Sphere Las Vegas listings have no price in either place.
//
// The REAL per-event price data — the same numbers the compare table and
// 30-day price-history chart already show — lives in price_samples,
// joined through events/entities, populated by price-sampler.js /
// sportsevents365.js from the actual affiliate marketplace feeds. This
// queries that instead.
//
// Matching key: entities.slug + events.event_date + a slugified venue name
// — the exact same event_key scheme price-sampler.js builds
// (`${entitySlug}|${date}|${toKeySlug(venue)}`), so this always finds the
// same row the chart and compare table already agree on. toKeySlug() below
// is copied verbatim from price-sampler.js — MUST stay in sync with it.
//
// GET /api/event-prices?events=<url-encoded JSON array>
//   Each item: { e: entitySlug, d: 'YYYY-MM-DD', v: venueName, u: eventUrl }
//   (u is just echoed back as the response's key, so the caller can match
//   a result straight back to the schema node it came from — no need to
//   recompute the event_key client-side.)
// Returns: { [u]: { price, currency: 'GBP' } } — only for keys that matched
// a real, recent (<=30 day) price sample. price_samples.min_price_gbp is
// already FX-converted at write time, so currency is always GBP here.
export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);

  const empty = () => new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120, s-maxage=300' }
  });

  let items;
  try {
    items = JSON.parse(url.searchParams.get('events') || '[]');
  } catch {
    return empty();
  }
  if (!Array.isArray(items) || !items.length) return empty();

  const valid = items
    .filter(it => it && typeof it.e === 'string' && typeof it.d === 'string' &&
                  typeof it.v === 'string' && typeof it.u === 'string' &&
                  /^\d{4}-\d{2}-\d{2}$/.test(it.d))
    .slice(0, 20); // generous headroom over the 5 events any hub page lists
  if (!valid.length) return empty();

  if (!env.PRICE_DB) return empty();

  const eventKeys = valid.map(it => `${it.e}|${it.d}|${toKeySlug(it.v)}`);
  const keyToUrl = new Map();
  valid.forEach((it, i) => keyToUrl.set(eventKeys[i], it.u));

  const out = {};
  try {
    const placeholders = eventKeys.map((_, i) => `?${i + 1}`).join(',');
    const sinceUnix = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // same 30-day window the price-history chart uses
    const { results } = await env.PRICE_DB.prepare(
      `SELECT ev.event_key, MIN(ps.min_price_gbp) AS price
         FROM price_samples ps
         JOIN events ev ON ev.id = ps.event_id
        WHERE ev.event_key IN (${placeholders}) AND ps.sampled_at >= ?${eventKeys.length + 1}
        GROUP BY ev.event_key`
    ).bind(...eventKeys, sinceUnix).all();

    for (const row of results || []) {
      if (row.price == null) continue;
      const u = keyToUrl.get(row.event_key);
      if (!u) continue;
      out[u] = { price: Math.round(row.price), currency: 'GBP' };
    }
  } catch (e) {
    console.error('event-prices lookup failed:', e);
    return empty();
  }

  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120, s-maxage=300' }
  });
}

// Copied verbatim from price-sampler.js — MUST stay in sync with it, since
// this is how event_key is actually built when samples are written.
function toKeySlug(s) {
  return (s || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
}
