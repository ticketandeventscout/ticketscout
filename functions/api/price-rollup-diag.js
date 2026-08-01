// ============================================================================
// TicketScout — Price Rollup Diagnostic (read-only, safe, standalone)
// Runs at /api/price-rollup-diag?trigger=1
//
// price-rollup has 524'd (Cloudflare's own platform timeout, not a caller
// impatience issue — confirmed 1 Aug via a direct browser call that ran
// 2.1 minutes before the edge itself gave up). The suspected cause is the
// correlated-subquery INSERT...SELECT in its "roll >30d samples" step,
// likely made worse by 9 days of that step failing to run — meaning the
// 30-day pruning DELETE in the same try/catch has also not run for 9 days,
// so price_samples has been growing unpruned rather than staying at a
// steady ~30-day window.
//
// This file does NOT touch price-rollup.js and NOT run the expensive
// query. It only counts rows, so it should return fast even if the table
// is large, and tells us how big the actual backlog is before designing
// the real fix (almost certainly converting the rollup step to the same
// cursor-batched pattern used everywhere else in this codebase — sitemap,
// entity-lifecycle, rebuildFullHub — rather than one unbounded query).
//
// Requires binding: PRICE_DB
// Safe to delete once the real fix is designed and shipped.
// ============================================================================

export async function onRequestGet({ request, env }) {
  const db = env.PRICE_DB;
  if (!db) return json({ error: 'Missing PRICE_DB binding' }, 500);

  const report = {};
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // 30 days ago, same as price-rollup.js

  try {
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM price_samples`).first();
    report.price_samples_total = c?.n ?? null;
  } catch (err) { report.price_samples_total = { error: String(err) }; }

  try {
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM price_samples WHERE sampled_at < ?`)
      .bind(cutoff).first();
    report.price_samples_older_than_30d = c?.n ?? null;
    report.note = 'This is the backlog price-rollup.js is trying to roll up + delete each run. ' +
      'If this number keeps growing day over day, the rollup step has not completed successfully.';
  } catch (err) { report.price_samples_older_than_30d = { error: String(err) }; }

  try {
    const c = await db.prepare(
      `SELECT MIN(sampled_at) AS oldest, MAX(sampled_at) AS newest FROM price_samples`
    ).first();
    report.oldestSample = c?.oldest ? new Date(c.oldest * 1000).toISOString() : null;
    report.newestSample = c?.newest ? new Date(c.newest * 1000).toISOString() : null;
    if (c?.oldest) {
      report.oldestSampleAgeDays = Math.round((Date.now() / 1000 - c.oldest) / 86400);
    }
  } catch (err) { report.sampleAgeRange = { error: String(err) }; }

  // Distinct event_ids with samples older than cutoff — this is the actual
  // GROUP BY cardinality the correlated subquery has to re-scan for, once
  // per group. A high number here (tens of thousands+) would explain a
  // 2+ minute runtime on its own, independent of any backlog growth.
  try {
    const c = await db.prepare(
      `SELECT COUNT(DISTINCT event_id) AS n FROM price_samples WHERE sampled_at < ?`
    ).bind(cutoff).first();
    report.distinctEventsInBacklog = c?.n ?? null;
  } catch (err) { report.distinctEventsInBacklog = { error: String(err) }; }

  try {
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM price_daily`).first();
    report.price_daily_total = c?.n ?? null;
  } catch (err) { report.price_daily_total = { error: String(err) }; }

  try {
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM events WHERE status = 'live'`).first();
    report.liveEvents = c?.n ?? null;
  } catch (err) { report.liveEvents = { error: String(err) }; }

  try {
    const c = await db.prepare(`SELECT COUNT(*) AS n FROM events`).first();
    report.totalEvents = c?.n ?? null;
  } catch (err) { report.totalEvents = { error: String(err) }; }

  // Step-timing checkpoints written by the instrumented price-rollup.js —
  // present only after a run of that file, self-clear after 1h (matches the
  // checkpoint's own expirationTtl). Read them all so a single call here
  // shows exactly how far the last run got and how long each step took,
  // even if the run itself eventually 524'd before returning anything.
  const steps = [
    'step1_fx', 'step2a_markPast', 'step2b_rollupDelete',
    'step3b_summariesWriteLoopDone', 'step5_merchantScores', 'step6_totals_COMPLETE'
  ];
  report.checkpoints = {};
  for (const s of steps) {
    try {
      const v = await env.GIGSBERG_KV?.get(`debug:price-rollup:${s}`);
      report.checkpoints[s] = v ? JSON.parse(v) : null;
    } catch { report.checkpoints[s] = { error: 'read failed' }; }
  }
  // step3a's key includes the row count in its name, so it can't be looked
  // up by a fixed key — list-scan the prefix instead.
  try {
    const list = await env.GIGSBERG_KV?.list({ prefix: 'debug:price-rollup:step3a_summariesQuery_rows' });
    for (const k of (list?.keys || [])) {
      const v = await env.GIGSBERG_KV.get(k.name);
      report.checkpoints.step3a_summariesQuery = v ? JSON.parse(v) : null;
    }
  } catch { /* nicety only */ }

  return json({ message: 'Read-only diagnostic — no writes performed.', ...report }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
