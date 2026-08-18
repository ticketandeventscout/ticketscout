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

  // Venue disambiguation — added 16 Aug 2026, live incident (Les Miserables,
  // 25 Aug 2026). Event scope was previously keyed on slug+date ONLY. Two
  // real failure modes confirmed live via ?debug=1 on that exact date:
  //   * KEY SPLIT — the SAME real London show stored under two venue
  //     spellings ("Sondheim Theatre - London" vs "Sondheim Theatre"),
  //     each with its own event row and its own price samples.
  //   * a GENUINELY DIFFERENT production (a Tuacahn Amphitheatre, Utah
  //     outdoor run) sharing this entity's slug and coincidentally landing
  //     on the same date, with its own real, unrelated price samples.
  // Both rows contributed to one blended chart: the metadata SELECT's only
  // tiebreaker (ORDER BY LENGTH(ev.name) DESC) couldn't discriminate three
  // rows with an identical name, and the series query had no per-row filter
  // at all — so the caption showed the wrong venue AND the "30-day low"
  // was a real price, just from an unrelated show on another continent.
  // Normalised, substring-tolerant matching (rather than exact equality)
  // is deliberate: it's what correctly unifies the two Sondheim spellings
  // into one merged result while still excluding Tuacahn, confirmed
  // against the real event_key values from that incident (see test suite).
  const venueParam = (url.searchParams.get('venue') || '').trim();
  function normVenue(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Event scope is opt-in via a strict YYYY-MM-DD date. Anything malformed
  // falls back to entity scope rather than erroring — a bad date on a page
  // should degrade to the old behaviour, never blank the chart.
  const eventDate = eventDateOf(url);
  const scope     = eventDate ? 'event' : 'entity';

  // Resolve which specific event row(s) — plural, for a merged spelling
  // split — the venue param actually refers to. null = no restriction,
  // meaning either no venue was supplied (old callers: theatre.html etc.
  // never send one) or nothing matched — degrading to the pre-fix
  // unfiltered behaviour rather than risking an empty chart on a spelling
  // this heuristic doesn't recognise.
  let matchedEventIds = null;
  let venueMatchNote = venueParam ? 'no_match_degraded_to_unfiltered' : 'no_venue_param';
  if (eventDate && venueParam) {
    try {
      const { results: candidates } = await db.prepare(
        `SELECT ev.id, ev.venue FROM events ev JOIN entities en ON en.id = ev.entity_id
          WHERE en.slug = ? AND ev.event_date = ?`
      ).bind(slug, eventDate).all();
      const wantNorm = normVenue(venueParam);
      if (wantNorm && candidates && candidates.length) {
        const matches = candidates.filter(c => {
          const cNorm = normVenue(c.venue);
          return cNorm && (cNorm === wantNorm || cNorm.includes(wantNorm) || wantNorm.includes(cNorm));
        });
        if (matches.length) {
          matchedEventIds = matches.map(c => c.id);
          venueMatchNote = matches.length > 1 ? 'merged_spelling_variants' : 'single_match';
        }
      }
    } catch { /* venue matching is a refinement — never fail the whole response for it */ }
  }
  const idClause = (matchedEventIds && matchedEventIds.length)
    ? ` AND ev.id IN (${matchedEventIds.map(() => '?').join(',')})`
    : '';
  const idBinds = matchedEventIds || [];

  // ── DIAGNOSTIC: ?debug=1 ───────────────────────────────────────────────
  // Answers "why doesn't the chart agree with the compare table?" by showing
  // every event row we hold for this entity and which sources have actually
  // sampled each one. Two failure modes it exposes directly:
  //   * KEY SPLIT — the same real event stored twice under different venue
  //     spellings ("sphere" vs "sphere-las-vegas"), so the chart reads one
  //     bucket while the cheapest seller sits in the other.
  //   * SOURCE GAP — an event sampled only by, say, TicketNetwork, so its
  //     "cheapest" never reflects the Vivid Seats listing shown live.
  // Read-only.
  if (url.searchParams.get('debug') === '1') {
    try {
      const dbgDate    = eventDateOf(url);
      const dateFilter = dbgDate ? 'AND ev.event_date = ?2' : '';
      const evBinds    = dbgDate ? [slug, dbgDate] : [slug];
      const evRows = await db.prepare(
        `SELECT ev.id, ev.event_key, ev.name, ev.venue, ev.city, ev.event_date, ev.status
           FROM events ev JOIN entities en ON en.id = ev.entity_id
          WHERE en.slug = ?1 ${dateFilter}
          ORDER BY ev.event_date ASC LIMIT 200`
      ).bind(...evBinds).all();

      const srcRows = await db.prepare(
        `SELECT ps.event_id, ps.source, COUNT(*) AS n,
                MIN(ps.min_price_gbp) AS lo, MAX(ps.min_price_gbp) AS hi,
                MAX(ps.sampled_at) AS last_sampled
           FROM price_samples ps
           JOIN events ev   ON ev.id = ps.event_id
           JOIN entities en ON en.id = ev.entity_id
          WHERE en.slug = ?1 ${dateFilter}
          GROUP BY ps.event_id, ps.source`
      ).bind(...evBinds).all();

      const bySrc = new Map();
      for (const r of (srcRows.results || [])) {
        if (!bySrc.has(r.event_id)) bySrc.set(r.event_id, []);
        bySrc.get(r.event_id).push({
          source: r.source, samples: r.n, min: r.lo, max: r.hi,
          lastSampled: r.last_sampled ? new Date(r.last_sampled * 1000).toISOString() : null
        });
      }

      const events = (evRows.results || []).map(e => ({
        ...e, sources: bySrc.get(e.id) || []
      }));

      // Same date, more than one row = a key split.
      const byDate = new Map();
      for (const e of events) {
        if (!byDate.has(e.event_date)) byDate.set(e.event_date, []);
        byDate.get(e.event_date).push(e.event_key);
      }
      const splits = [...byDate.entries()]
        .filter(([, keys]) => keys.length > 1)
        .map(([date, keys]) => ({ date, keys }));

      return json({
        slug, debug: true,
        eventsFound: events.length,
        suspectedKeySplits: splits,
        distinctSources: [...new Set((srcRows.results || []).map(r => r.source))],
        events
      }, 200);
    } catch (err) {
      return json({ error: `Debug query failed: ${err}` }, 500);
    }
  }

  // Event scope/eventDate already resolved above (needed earlier for venue
  // matching). sinceUnix/sinceISO still computed here — unaffected by the
  // venue-matching addition.
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
         WHERE en.slug = ? AND ps.sampled_at >= ? ${dateClause}${idClause}
         GROUP BY day
         UNION ALL
         SELECT pd.day AS day, MIN(pd.min_gbp) AS min
         FROM price_daily pd
         JOIN events ev   ON ev.id = pd.event_id
         JOIN entities en ON en.id = ev.entity_id
         WHERE en.slug = ? AND pd.day >= ? ${dateClause}${idClause}
         GROUP BY pd.day
       )
       GROUP BY day ORDER BY day ASC`;

    // Built programmatically (not hand-listed) so idBinds — empty when no
    // venue match, one id for a single match, several for a merged
    // spelling-variant group — lines up correctly with idClause regardless
    // of which case applies, in both UNION halves.
    const firstBinds  = [slug, sinceUnix, ...(eventDate ? [eventDate] : []), ...idBinds];
    const secondBinds = [slug, sinceISO,  ...(eventDate ? [eventDate] : []), ...idBinds];
    const binds = [...firstBinds, ...secondBinds];

    const { results } = await db.prepare(sql).bind(...binds).all();
    series = (results || []).map(r => ({ day: r.day, min: r.min }));
  } catch (err) {
    return json({ error: `Query failed: ${err}` }, 500);
  }

  // ── Event metadata (event scope only) ──────────────────────────────────
  // Lets the page label the chart with the actual fixture, so the cited
  // price is visibly anchored to a specific date and venue.
  //
  // idClause here (when set) is what actually fixes the caption bug: with
  // three same-named rows sharing a date, ORDER BY LENGTH(ev.name) DESC
  // alone can't break the tie (confirmed live: it landed on an unrelated
  // production purely because of row order). Restricting to the venue-
  // matched id(s) removes the ambiguity outright rather than relying on a
  // better tiebreaker guess.
  let event = null;
  if (eventDate) {
    try {
      const row = await db.prepare(
        `SELECT ev.name, ev.venue, ev.city, ev.event_date
           FROM events ev
           JOIN entities en ON en.id = ev.entity_id
          WHERE en.slug = ? AND ev.event_date = ?${idClause}
          ORDER BY LENGTH(ev.name) DESC
          LIMIT 1`
      ).bind(slug, eventDate, ...idBinds).first();
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
    // venueMatch: added 16 Aug 2026 alongside the venue-matching fix above.
    // Lets a caller (or a manual check) confirm what actually happened
    // without a separate ?debug=1 round trip: 'no_venue_param' means the
    // caller didn't send one (old behaviour, unaffected); 'single_match' /
    // 'merged_spelling_variants' mean it worked; 'no_match_degraded_to_
    // unfiltered' means a venue WAS sent but nothing matched, so this
    // response silently fell back to the pre-fix blended behaviour —
    // worth investigating if seen live, not necessarily a new bug.
    venueMatch: venueMatchNote,
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

// Strict YYYY-MM-DD or null. Shared by the debug branch and event scope so
// both agree on what counts as a usable date.
function eventDateOf(url) {
  const raw = (url.searchParams.get('date') || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
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
