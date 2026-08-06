// functions/api/duplicate-events.js
// =============================================================================
// CROSS-SOURCE DUPLICATE-EVENT SCAN — read-only diagnostic.
// =============================================================================
//
// WHY THIS EXISTS
// ----------------
// Confirmed real via a live example (Session 16 audit, 31 Jul 2026): the same
// real Metallica show (1 Oct 2026, Sphere) exists as TWO independent
// event_pages rows under different name strings — "Metallica" (source: tm)
// and "Metallica: Life Burns Faster" (source: se365 or similar) — each with
// its own slug, its own /event/{slug} URL, and independently diverging price
// histories. Two different sources captured the same real-world event under
// two different name strings and nothing merges them.
//
// This is NOT the same bug as the "Bruno Mars-style duplicate cards" fix
// shipped 17 Jul 2026 — that dedups what concert.html/theatre.html DISPLAY
// on the client side, at render time, from already-fetched JSON. It does
// nothing to the underlying event_pages rows, so both /event/{slug} URLs
// still exist, both still get indexed by Google as separate pages for one
// real event, and their price data still diverges silently. Confirmed this
// gap is covered by neither H6 (no concept of a tour subtitle) nor
// mergefragments (operates on registry entities, not D1 event rows).
//
// This tool is step one, exactly as scoped in the roadmap: "a scan across
// event_pages grouped by venue+date, looking for near-duplicate names, to
// establish how widespread this is beyond one example." It does NOT merge
// or write anything — read-only, safe to run repeatedly. A merge/dedup tool
// is a deliberately separate follow-up, scoped fresh once this scan shows
// the real shape and scale of the problem.
//
// METHOD
// ------
// 1. Cheap SQL pre-filter: group upcoming event_pages by
//    (category, event_date, venue), keep only groups with 2+ rows. Venue+date
//    is a strong same-real-event signal and a MUCH more selective filter than
//    date alone — plenty of genuinely different real events share a date,
//    far fewer share a date AND a venue.
// 2. For each candidate group, fetch the full rows and compare NAMES using
//    the SAME colon-subtitle-stripping logic as extractPerformerName() in
//    compare.js ("Metallica: Life Burns Faster" -> "Metallica") — reused
//    byte-for-byte in spirit, not copy-pasted verbatim, since this file's
//    needs are simpler (no vs-fixture / festival-prefix branches, which are
//    sports/festival-specific and irrelevant to solo-act tour subtitles).
// 3. Classify each group:
//      'exact'      — base names identical after normalising -> high confidence
//      'substring'  — one base name contains the other        -> medium confidence
//      'different'  — no overlap -> not a duplicate, just same venue+date
//                      coincidentally (e.g. a stadium's football fixture
//                      AND a separate athletics meet, genuinely two events)
//    Only 'exact' and 'substring' groups are returned by default; pass
//    &includeDifferent=1 to see the full same-venue-same-date picture too.
//
// USAGE
// -----
//   /api/duplicate-events?scan=1&trigger=1                     — all categories
//   /api/duplicate-events?scan=1&trigger=1&category=concert    — one category
//   /api/duplicate-events?scan=1&trigger=1&limit=50&offset=0   — pagination
//   /api/duplicate-events?scan=1&trigger=1&includeDifferent=1  — see everything
// =============================================================================

function normaliseBaseName(name) {
  let n = String(name || '').trim();
  // Same intent as extractPerformerName() in compare.js: strip a subtitle
  // after a colon so "Metallica: Life Burns Faster" and "Metallica" compare
  // equal. Simplified on purpose — this tool only needs the solo-act case,
  // not compare.js's vs-fixture / festival-prefix branches, which exist for
  // sports fixtures and festival lineups respectively and don't apply to
  // artist tour subtitles.
  const colonIdx = n.indexOf(':');
  if (colonIdx > 0) n = n.slice(0, colonIdx).trim();
  return n
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(names) {
  const bases = names.map(normaliseBaseName);
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      if (!bases[i] || !bases[j]) continue;
      if (bases[i] === bases[j]) return 'exact';
    }
  }
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      if (!bases[i] || !bases[j]) continue;
      if (bases[i].includes(bases[j]) || bases[j].includes(bases[i])) return 'substring';
    }
  }
  return 'different';
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('scan') !== '1' || url.searchParams.get('trigger') !== '1') {
    return jsonResponse({
      error: 'Pass ?scan=1&trigger=1 to run. Optional: &category=X, &limit=N (default 50), &offset=N, &includeDifferent=1'
    }, 400);
  }

  const db = env.PRICE_DB;
  if (!db) return jsonResponse({ error: 'Missing PRICE_DB' }, 500);

  const category = (url.searchParams.get('category') || '').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const includeDifferent = url.searchParams.get('includeDifferent') === '1';

  try {
    // Step 1: cheap pre-filter — only (category, event_date, venue) groups
    // with 2+ rows are candidates at all. NULL venues are excluded: a
    // missing venue is a weak signal on its own and would otherwise group
    // together every venue-less row for a date, which is noise, not a
    // duplicate candidate.
    let sql = `
      SELECT category, event_date, venue, COUNT(*) AS n
      FROM event_pages
      WHERE event_date >= date('now') AND venue IS NOT NULL AND venue != ''
    `;
    const binds = [];
    if (category) { sql += ' AND category = ?'; binds.push(category); }
    sql += ' GROUP BY category, event_date, venue HAVING COUNT(*) > 1 ORDER BY category, event_date LIMIT ? OFFSET ?';
    binds.push(limit, offset);

    const candidateGroups = await db.prepare(sql).bind(...binds).all();
    const groups = candidateGroups.results || [];

    if (!groups.length) {
      return jsonResponse({
        scan: true, category: category || 'all', limit, offset,
        candidateGroupsChecked: 0, duplicatesFound: 0, done: true,
        message: 'No same-category-date-venue groups with 2+ rows in this page. Either genuinely none left, or increase &offset to keep paging.'
      });
    }

    // Step 2: fetch full rows for each candidate group and classify.
    const results = [];
    let exactCount = 0, substringCount = 0, differentCount = 0;
    for (const g of groups) {
      const rowsRes = await db.prepare(
        'SELECT slug, category, name, event_date, venue, city, price, currency, source, updated_at FROM event_pages WHERE category = ?1 AND event_date = ?2 AND venue = ?3'
      ).bind(g.category, g.event_date, g.venue).all();
      const rows = rowsRes.results || [];
      if (rows.length < 2) continue; // race: could have changed between the two queries

      const verdict = classify(rows.map(r => r.name));
      if (verdict === 'exact') exactCount++;
      else if (verdict === 'substring') substringCount++;
      else differentCount++;

      if (verdict === 'different' && !includeDifferent) continue;

      results.push({
        category: g.category, date: g.event_date, venue: g.venue,
        verdict,
        rows: rows.map(r => ({
          slug: r.slug, name: r.name, city: r.city,
          price: r.price, currency: r.currency,
          source: r.source, updatedAt: r.updated_at
        }))
      });
    }

    return jsonResponse({
      scan: true, category: category || 'all', limit, offset,
      candidateGroupsChecked: groups.length,
      breakdown: { exact: exactCount, substring: substringCount, different: differentCount },
      duplicatesFound: results.length,
      done: groups.length < limit,
      next: groups.length < limit ? null : `?scan=1&trigger=1${category ? '&category=' + category : ''}&limit=${limit}&offset=${offset + limit}`,
      results
    });
  } catch (e) {
    return jsonResponse({ error: 'scan failed: ' + String(e) }, 500);
  }
}
