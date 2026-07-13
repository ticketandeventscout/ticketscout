// ============================================================================
// TicketScout — Price History API
// Runs at /api/price-history
//
//   ?slug=arsenal            — daily get-in price series for an entity
//                              (all its upcoming events combined) + summary
//   ?slug=arsenal&days=90    — longer window (default 30, max 365)
//
// Response shape (built for Chart.js):
//   {
//     slug, summary: { current, weekAgo, low30d, trend },
//     series: [ { day: '2026-07-13', min: 62.0 }, ... ]
//   }
//
// Edge-cached 6h — the data only changes 4x/day at most.
// Requires bindings: GIGSBERG_KV, PRICE_DB
// ============================================================================

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // ── Edge cache ─────────────────────────────────────────────────────────
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

  // ── Summary from KV (written nightly by the rollup) ────────────────────
  let summary = null;
  try { summary = await kv?.get(`price:summary:entity:${slug}`, 'json'); } catch {}

  // ── Series: recent raw samples (last 30d) + older daily rows ──────────
  const sinceUnix = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const sinceISO  = new Date(sinceUnix * 1000).toISOString().split('T')[0];

  let series = [];
  try {
    const { results } = await db.prepare(
      `SELECT day, MIN(min) AS min FROM (
         SELECT date(ps.sampled_at, 'unixepoch') AS day, MIN(ps.min_price_gbp) AS min
         FROM price_samples ps
         JOIN events ev   ON ev.id = ps.event_id
         JOIN entities en ON en.id = ev.entity_id
         WHERE en.slug = ? AND ps.sampled_at >= ?
         GROUP BY day
         UNION ALL
         SELECT pd.day AS day, MIN(pd.min_gbp) AS min
         FROM price_daily pd
         JOIN events ev   ON ev.id = pd.event_id
         JOIN entities en ON en.id = ev.entity_id
         WHERE en.slug = ? AND pd.day >= ?
         GROUP BY pd.day
       )
       GROUP BY day ORDER BY day ASC`
    ).bind(slug, sinceUnix, slug, sinceISO).all();
    series = (results || []).map(r => ({ day: r.day, min: r.min }));
  } catch (err) {
    return json({ error: `Query failed: ${err}` }, 500);
  }

  const resp = json({ slug, days, summary, points: series.length, series }, 200,
                    'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400');
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
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
