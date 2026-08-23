// Batch price lookup for entity hub page schema enrichment (23 Aug 2026,
// follow-up to R1). TM's own priceRanges field is frequently empty even
// for real, on-sale events — confirmed live: Metallica's Sphere Las Vegas
// listings return no TM price at all, while the /event/ page for the same
// listing shows a real compare-table price and 30-day price history,
// sourced from event_pages (populated by the affiliate proxies, not TM).
// Without this, concert.html/football.html/theatre.html's per-event Offer
// (R1) silently goes missing on exactly the events TM under-serves, even
// though real pricing is sitting one table away.
//
// GET /api/event-prices?slugs=slug1,slug2,slug3  (max 20 per request —
// generous headroom over the 5 events any hub page actually lists)
// Returns: { [slug]: { price, currency } } — omits any slug with no row,
// no price, or a stale one. Same 7-day freshness gate _slug_.js already
// uses for the /event/ page's own inline Offer, so a hub page and its
// event page never disagree about whether a given price is trustworthy.
export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const slugsParam = url.searchParams.get('slugs') || '';
  const slugs = slugsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);

  const empty = () => new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120, s-maxage=300' }
  });

  if (!slugs.length || !env.PRICE_DB) return empty();

  const out = {};
  try {
    const placeholders = slugs.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await env.PRICE_DB
      .prepare(`SELECT slug, price, currency, updated_at FROM event_pages WHERE slug IN (${placeholders})`)
      .bind(...slugs)
      .all();
    const now = Date.now();
    for (const row of results || []) {
      if (!row.price || !row.updated_at) continue;
      const ageMs = now - Date.parse(row.updated_at);
      if (!isFinite(ageMs) || ageMs >= 7 * 24 * 3600 * 1000) continue; // same staleness rule as _slug_.js
      out[row.slug] = { price: Math.round(Number(row.price)), currency: row.currency || 'GBP' };
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
