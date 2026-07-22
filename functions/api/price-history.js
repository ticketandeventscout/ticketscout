// ============================================================================
// TicketScout — Price History API
// Runs at /api/price-history
//
//   ?slug=arsenal                       — entity scope: daily get-in price
//                                         across ALL upcoming events + KV summary
//   ?slug=arsenal&days=90               — longer window (default 30, max 365)
//   ?slug=arsenal&date=2026-08-09       — EVENT scope: the price series for that
//                                         ONE fixture/show only, with a summary
//                                         computed from that series
//
// Response shape (built for the inline chart on entity + /event/ pages):
//   {
//     slug, days, scope: 'entity' | 'event', eventDate, event: {name,venue,city},
//     summary: { current, weekAgo, low30d, trend },
//     points, series: [ { day: '2026-07-13', min: 62.0 }, ... ]
//   }
//
// Why event scope exists: an entity-wide "from £62" is ambiguous — it is the
// cheapest seat across every upcoming date, not the date the visitor is looking
// at. Event scope lets a page state a price that is unambiguously about the
// fixture on screen.
//
// Edge-cached 6h — the data only changes 4x/day at most.
// Requires bindings: GIGSBERG_KV, PRICE_DB
// ============================================================================

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // ── Edge cache (key includes ?date=, so scopes cache independently) ────
  const cache    = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const kv = env.GIGSBERG_KV;
  const db = env.PRICE_DB;
  if (!db) return json({ error: 'Missing PRICE_DB binding' }, 500);

  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  if (!slug) return json({ error: 'Missing ?slug= parameter' }, 400);

  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10) || 30, 365);

  // Event scope is opt-in via a strict YYYY-MM-DD date. Anything malformed
  // falls back to entity scope rather than erroring — a bad date on a page
  // should degrade to the old behaviour, never blank the chart.
  const rawDate   = (url.searchParams.get('date') || '').trim();
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  const scope     = eventDate ? 'event' : 'entity';

  const sinceUnix = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const sinceISO  = new Date(sinceUnix * 1000).toISOString().split('T')[0];

  // ── Series ─────────────────────────────────────────────────────────────
  // Recent raw samples (price_samples) unioned with older rolled-up daily
  // rows (price_daily), collapsed to one min per day.
  let series = [];
  try {
    const dateClause = eventDate ? 'AND ev.event_date = ?' : '';
    const sql =
      `SELECT day, MIN(min) AS min FROM (
         SELECT date(ps.sampled_at, 'unixepoch') AS day, MIN(ps.min_price_gbp) AS min
         FROM price_samples ps
         JOIN events ev   ON ev.id = ps.event_id
         JOIN entities en ON en.id = ev.entity_id
         WHERE en.slug = ? AND ps.sampled_at >= ? ${dateClause}
         GROUP BY day
         UNION ALL
         SELECT pd.day AS day, MIN(pd.min_gbp) AS min
         FROM price_daily pd
         JOIN events ev   ON ev.id = pd.event_id
         JOIN entities en ON en.id = ev.entity_id
         WHERE en.slug = ? AND pd.day >= ? ${dateClause}
         GROUP BY pd.day
       )
       GROUP BY day ORDER BY day ASC`;

    const binds = eventDate
      ? [slug, sinceUnix, eventDate, slug, sinceISO, eventDate]
      : [slug, sinceUnix, slug, sinceISO];

    const { results } = await db.prepare(sql).bind(...binds).all();
    series = (results || []).map(r => ({ day: r.day, min: r.min }));
  } catch (err) {
    return json({ error: `Query failed: ${err}` }, 500);
  }

  // ── Event metadata (event scope only) ──────────────────────────────────
  // Lets the page label the chart with the actual fixture, so the cited
  // price is visibly anchored to a specific date and venue.
  let event = null;
  if (eventDate) {
    try {
      const row = await db.prepare(
        `SELECT ev.name, ev.venue, ev.city, ev.event_date
           FROM events ev
           JOIN entities en ON en.id = ev.entity_id
          WHERE en.slug = ? AND ev.event_date = ?
          ORDER BY LENGTH(ev.name) DESC
          LIMIT 1`
      ).bind(slug, eventDate).first();
      if (row) event = { name: row.name, venue: row.venue, city: row.city, date: row.event_date };
    } catch { /* metadata is a nicety — never fail the response for it */ }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  // Entity scope reads the nightly KV summary (cheap, already computed).
  // Event scope derives its own from the series — there is no per-event KV
  // key, and computing it here keeps the rollup job unchanged.
  let summary = null;
  if (eventDate) {
    summary = summarise(series);
  } else {
    try { summary = await kv?.get(`price:summary:entity:${slug}`, 'json'); } catch {}
    // Fall back to a series-derived summary if the nightly rollup has not
    // written a key for this entity yet (new entities, or a skipped run).
    if (!summary && series.length) summary = summarise(series);
  }

  const resp = json({
    slug, days, scope, eventDate, event,
    summary, points: series.length, series
  }, 200, 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400');

  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// Derive { current, weekAgo, low30d, trend } from a day-ordered series.
// Same 5% threshold as the nightly rollup so entity and event scope agree
// on what counts as a move.
function summarise(series) {
  if (!series.length) return null;

  const current = series[series.length - 1].min;

  // weekAgo = the sample nearest to 7 days before the latest point, within
  // a +/-2 day tolerance. Sampling gaps are normal; a hard 7-day lookup
  // would silently report "flat" whenever a day was missed.
  const latestDay = new Date(series[series.length - 1].day + 'T00:00:00Z').getTime();
  const targetDay = latestDay - 7 * 86400000;
  let weekAgo = null, bestGap = Infinity;
  for (const p of series) {
    const gap = Math.abs(new Date(p.day + 'T00:00:00Z').getTime() - targetDay);
    if (gap <= 2 * 86400000 && gap < bestGap) { bestGap = gap; weekAgo = p.min; }
  }

  const low30d = series.reduce((m, p) => (p.min < m ? p.min : m), series[0].min);

  let trend = 'flat';
  if (weekAgo != null && weekAgo > 0) {
    const delta = current - weekAgo;
    if (delta >  weekAgo * 0.05) trend = 'up';
    if (delta < -weekAgo * 0.05) trend = 'down';
  }

  return { current, weekAgo, low30d, trend };
}

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl || 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
