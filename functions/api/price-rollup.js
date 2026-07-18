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

  // ── 5. Merchant trust scores (Phase 6.3) ───────────────────────────────
  // 30-day window over merchant_daily → trust score per merchant → KV.
  // Formula per roadmap:
  //   reliability = 1 - min(1, api_errors/requests × 8)        (requests = site-wide '_site' row)
  //   integrity   = 1 - min(1, (drift + implausible×2)/listings × 12)
  //   performance = Laplace-smoothed CR vs site median: ((conv+1)/(clicks+20)) / site_rate
  //   trust = clamp(0.35·rel + 0.35·int + 0.20·min(perf,1.5)/1.5 + 0.10·complaint + manual, 0, 1)
  // Cold-start honesty: conversions are near-empty for months → score runs on
  // reliability+integrity and grows teeth as clicks accumulate. Badges require
  // trust ≥ 0.8 AND ≥ 60 days of accumulated data (no day-one badges).
  try {
    const windowStart = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await db.prepare(
      `SELECT merchant_id,
              SUM(clicks) AS clicks, SUM(conversions) AS conversions,
              SUM(api_errors) AS api_errors, SUM(price_drift_events) AS drift,
              SUM(implausible_listings) AS implausible, SUM(complaints) AS complaints,
              SUM(requests) AS requests,
              MIN(day) AS firstDay, COUNT(*) AS daysWithData
         FROM merchant_daily WHERE day >= ?
        GROUP BY merchant_id`
    ).bind(windowStart).all();
    const daily = rows.results || [];

    const merchants = await db.prepare(`SELECT id, manual_adjust FROM merchants`).all();
    const manualById = Object.fromEntries((merchants.results || []).map(m => [m.id, m.manual_adjust || 0]));

    const site = daily.find(r => r.merchant_id === '_site') || {};
    const siteRequests = site.requests || 0;

    // Site-wide conversion rate for the performance denominator
    let totClicks = 0, totConv = 0;
    for (const r of daily) { if (r.merchant_id !== '_site') { totClicks += r.clicks || 0; totConv += r.conversions || 0; } }
    const siteRate = (totConv + 1) / (totClicks + 20);

    // Tenure: earliest day EVER (not just window) for the 60-day badge rule
    const tenureRows = await db.prepare(
      `SELECT merchant_id, MIN(day) AS firstEver FROM merchant_daily GROUP BY merchant_id`
    ).all();
    const firstEverById = Object.fromEntries((tenureRows.results || []).map(r => [r.merchant_id, r.firstEver]));

    const scores = {}, badges = [], flags = [];
    for (const r of daily) {
      const id = r.merchant_id;
      if (id === '_site') continue;

      const errors = r.api_errors || 0;
      // Reliability: errors vs site-wide adapter attempts. With no request
      // data yet, don't invent a denominator — treat as neutral (1.0).
      const reliability = siteRequests > 0 ? 1 - Math.min(1, (errors / siteRequests) * 8) : 1;

      // Integrity: drift + implausible vs clicks as the exposure proxy
      // (listings_sampled isn't tracked client-side; clicks is the honest
      // stand-in until the 1.4B server render counts rendered listings)
      const exposure = Math.max(r.clicks || 0, 25);
      const integrity = 1 - Math.min(1, (((r.drift || 0) + (r.implausible || 0) * 2) / exposure) * 12);

      const performance = ((r.conversions || 0) + 1) / ((r.clicks || 0) + 20) / siteRate;
      const complaintFactor = 1 - Math.min(1, (r.complaints || 0) / 5);
      const manual = Math.max(-0.2, Math.min(0.2, manualById[id] || 0));

      const trust = Math.max(0, Math.min(1,
        0.35 * reliability + 0.35 * integrity +
        0.20 * Math.min(performance, 1.5) / 1.5 +
        0.10 * complaintFactor + manual
      ));
      scores[id] = Math.round(trust * 100) / 100;

      const tenureDays = firstEverById[id]
        ? Math.floor((Date.now() - Date.parse(firstEverById[id])) / 86400000) : 0;
      if (trust >= 0.8 && tenureDays >= 60) badges.push(id);
      if (trust < 0.4) flags.push(id);
    }

    await kv.put('merchant:scores', JSON.stringify({
      scores, badges, flags, siteRequests,
      window: `${windowStart}..${todayISO}`,
      computed: new Date().toISOString()
    }));
    // Per-merchant keys for render-time single reads (future F1 value sort)
    for (const [id, s] of Object.entries(scores)) {
      await kv.put(`merchant:score:${id}`, String(s));
    }
    report.merchantScores = { computed: Object.keys(scores).length, badges, flags };
  } catch (err) { report.merchantScores = { error: String(err) }; }

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
