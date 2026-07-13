// ============================================================================
// TicketScout — Nightly Price Rollup
// Runs at /api/price-rollup?trigger=1 (cron: daily 03:00)
//
// Four jobs in one pass:
//   1. FX refresh    — fetch USD/EUR→GBP rates (free Frankfurter API) → KV
//   2. Housekeeping  — mark past events, roll >30-day-old samples into
//                      price_daily, delete the rolled raw samples
//   3. Summaries     — per-entity get-in price + 7-day trend → KV
//                      (price:summary:entity:{slug} — what pages will read)
//   4. Retention     — price_daily is kept forever (tiny, and it's the
//                      historical dataset for charts + future content)
//
// Requires bindings: GIGSBERG_KV, PRICE_DB
// ============================================================================

const FX_KEY = 'fx:rates';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv  = env.GIGSBERG_KV;
  const db  = env.PRICE_DB;

  if (url.searchParams.get('trigger') !== '1') {
    return json({ usage: '?trigger=1 — run the nightly rollup (safe to run manually any time)' }, 200);
  }
  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);
  if (!db) return json({ error: 'Missing PRICE_DB binding' }, 500);

  const report = {};
  const todayISO = new Date().toISOString().split('T')[0];
  const cutoff   = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // 30 days ago

  // ── 1. FX refresh ──────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=GBP&to=USD,EUR,CAD,AUD,SGD,CHF');
    if (r.ok) {
      const data = await r.json();
      // Frankfurter gives GBP->X; we need X->GBP, so invert
      const rates = { GBP: 1 };
      for (const [cur, rate] of Object.entries(data.rates || {})) {
        if (rate > 0) rates[cur] = Math.round((1 / rate) * 10000) / 10000;
      }
      await kv.put(FX_KEY, JSON.stringify(rates));
      report.fx = { updated: true, rates };
    } else {
      report.fx = { updated: false, status: r.status };
    }
  } catch (err) { report.fx = { updated: false, error: String(err) }; }

  // ── 2a. Mark past events ───────────────────────────────────────────────
  try {
    const res = await db.prepare(
      `UPDATE events SET status = 'past' WHERE status = 'live' AND event_date < ?`
    ).bind(todayISO).run();
    report.pastMarked = res.meta?.changes ?? 0;
  } catch (err) { report.pastMarked = { error: String(err) }; }

  // ── 2b. Roll >30d samples into price_daily, then delete them ─────────
  try {
    await db.prepare(
      `INSERT INTO price_daily (event_id, day, min_gbp, max_gbp, avg_gbp, best_source)
       SELECT event_id,
              date(sampled_at, 'unixepoch')            AS day,
              MIN(min_price_gbp), MAX(min_price_gbp), ROUND(AVG(min_price_gbp), 2),
              (SELECT source FROM price_samples s2
                WHERE s2.event_id = s1.event_id
                  AND date(s2.sampled_at,'unixepoch') = date(s1.sampled_at,'unixepoch')
                ORDER BY s2.min_price_gbp ASC LIMIT 1)
       FROM price_samples s1
       WHERE sampled_at < ?
       GROUP BY event_id, day
       ON CONFLICT(event_id, day) DO UPDATE SET
         min_gbp = excluded.min_gbp, max_gbp = excluded.max_gbp,
         avg_gbp = excluded.avg_gbp, best_source = excluded.best_source`
    ).bind(cutoff).run();
    const del = await db.prepare(`DELETE FROM price_samples WHERE sampled_at < ?`).bind(cutoff).run();
    report.rolledAndDeleted = del.meta?.changes ?? 0;
  } catch (err) { report.rollup = { error: String(err) }; }

  // ── 3. Per-entity summaries → KV ───────────────────────────────────────
  // Current get-in = cheapest sample in the last 24h across the entity's
  // upcoming events; weekAgo = cheapest 6-8 days ago; trend from the delta.
  let summariesWritten = 0;
  try {
    const now      = Math.floor(Date.now() / 1000);
    const dayAgo   = now - 24 * 3600;
    const weekLo   = now - 8 * 24 * 3600;
    const weekHi   = now - 6 * 24 * 3600;

    const { results } = await db.prepare(
      `SELECT en.slug,
              MIN(CASE WHEN ps.sampled_at >= ? THEN ps.min_price_gbp END)  AS current,
              MIN(CASE WHEN ps.sampled_at BETWEEN ? AND ? THEN ps.min_price_gbp END) AS weekAgo,
              MIN(ps.min_price_gbp)                                        AS low30d,
              COUNT(DISTINCT ev.id)                                        AS upcomingEvents
       FROM entities en
       JOIN events ev  ON ev.entity_id = en.id AND ev.status = 'live'
       JOIN price_samples ps ON ps.event_id = ev.id
       GROUP BY en.slug`
    ).bind(dayAgo, weekLo, weekHi).all();

    for (const row of (results || [])) {
      if (row.current == null) continue;
      let trend = 'flat';
      if (row.weekAgo != null) {
        const delta = row.current - row.weekAgo;
        if (delta >  row.weekAgo * 0.05) trend = 'up';
        if (delta < -row.weekAgo * 0.05) trend = 'down';
      }
      await kv.put(`price:summary:entity:${row.slug}`, JSON.stringify({
        current: row.current,
        weekAgo: row.weekAgo,
        low30d:  row.low30d,
        trend,
        upcomingEvents: row.upcomingEvents,
        updated: new Date().toISOString()
      }), { expirationTtl: 3 * 24 * 3600 }); // summaries ARE caches — 3-day TTL is correct here
      summariesWritten++;
    }
    report.summariesWritten = summariesWritten;
  } catch (err) { report.summaries = { error: String(err) }; }

  // ── Totals for visibility ──────────────────────────────────────────────
  try {
    const c = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM entities)      AS entities,
              (SELECT COUNT(*) FROM events)        AS events,
              (SELECT COUNT(*) FROM price_samples) AS rawSamples,
              (SELECT COUNT(*) FROM price_daily)   AS dailyRows`
    ).first();
    report.totals = c;
  } catch {}

  return json({ message: 'Rollup complete.', ...report }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
