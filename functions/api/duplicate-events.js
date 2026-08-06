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

  if (url.searchParams.get('merge') === '1' && url.searchParams.get('trigger') === '1') {
    return runMerge(url, env);
  }

  if (url.searchParams.get('scan') !== '1' || url.searchParams.get('trigger') !== '1') {
    return jsonResponse({
      error: 'Pass ?scan=1&trigger=1 to scan (read-only), or ?merge=1&trigger=1 to merge the dominant safe pattern (dry-run by default, &confirm=yes to write). Scan options: &category=X, &limit=N (default 50), &offset=N, &includeDifferent=1'
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

// =============================================================================
// MERGE MODE (added 6 Aug 2026)
// =============================================================================
// Live scan (6 Aug 2026, first 50 candidate groups) found 35 duplicate
// groups, breaking down as: 26 were the SAME shape as the original
// Metallica finding — one TM row (name has a tour subtitle, price NULL,
// since TM's registration is traffic-gated — see ticketmaster.js — and
// very often never gets a live cache-hit to pick up a price) paired with
// one Awin row (clean base name, real price, since Awin's daily bulk sync
// is comprehensive — see awin-category-cache.js). 5 were TM listing
// genuinely different purchasable products as separate "events" (VIP
// packages, multi-day passes) — not really duplicates in the sense that
// matters here, and merging them would destroy a real distinct product.
// 4 were Awin's own feed emitting two near-identical product names for
// what's very likely the same inventory — a feed-parsing question, not a
// cross-source merge.
//
// This mode ONLY touches the first, dominant pattern (74% of what the scan
// found) — deliberately narrow, because it's the one pattern with a
// genuinely low false-positive risk: it's very unlikely two DIFFERENT real
// events share a venue AND a date AND an overlapping artist name AND have
// exactly one of the two sources report a price. Eligibility requires ALL
// of:
//   - exactly 2 rows in the (category, event_date, venue) group
//   - name classifies as 'exact' or 'substring' (same logic as scan mode)
//   - exactly one row has a NULL price, the other a real price
// Groups with 3+ rows, two priced-but-different rows, or two unpriced rows
// are left alone — those need a human judgement call, not an automated
// rule, and are exactly the TM-internal/Awin-internal cases above.
//
// ACTION: the priced row is kept as canonical (a page with no price is
// close to useless to a visitor). Before deleting the loser, any field the
// winner is missing — tm_url especially, since TM is consistently the row
// WITHOUT a price, this is how its Ticketmaster compare-table row survives
// onto the winning page instead of being lost — is copied across via
// COALESCE, the same merge-don't-clobber pattern tsRegisterEvents() already
// uses elsewhere in this codebase. The loser's row is then deleted and a
// redirect is written using the EXACT SAME mechanism discover-pages.js's
// fix-sports-events phase already uses for event_pages redirects —
// 'redirectSlug:event:{loserSlug}' -> 'event/{winnerSlug}' — so
// _slug_.js's existing 301 check (already live, already proven working)
// picks it up with zero additional code anywhere else.
//
// Cursor-paginated the same way as every other write tool this session
// (entity-lifecycle.js, ticketmaster.js's ?sweep=1): confirm=yes runs
// remember how far through the candidate-group list they got, so repeatedly
// hitting the same URL sweeps the whole backlog instead of re-scanning the
// front of the list every time.
async function runMerge(url, env) {
  const db = env.PRICE_DB;
  const kv = env.GIGSBERG_KV;
  if (!db) return jsonResponse({ error: 'Missing PRICE_DB' }, 500);
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const category = (url.searchParams.get('category') || '').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
  const confirm = url.searchParams.get('confirm') === 'yes';
  const dryRun = !confirm;

  const cursorKey = 'dupemerge:cursor:' + (category || 'all');
  let offset = 0;
  try { const c = await kv.get(cursorKey); offset = c ? (parseInt(c, 10) || 0) : 0; } catch {}

  try {
    let sql = `
      SELECT category, event_date, venue, COUNT(*) AS n
      FROM event_pages
      WHERE event_date >= date('now') AND venue IS NOT NULL AND venue != ''
    `;
    const binds = [];
    if (category) { sql += ' AND category = ?'; binds.push(category); }
    sql += ' GROUP BY category, event_date, venue HAVING COUNT(*) = 2 ORDER BY category, event_date LIMIT ? OFFSET ?';
    binds.push(limit, offset);

    const candidateGroups = await db.prepare(sql).bind(...binds).all();
    const groups = candidateGroups.results || [];

    const merges = [];
    const skipped = [];

    for (const g of groups) {
      const rowsRes = await db.prepare(
        'SELECT slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at FROM event_pages WHERE category = ?1 AND event_date = ?2 AND venue = ?3'
      ).bind(g.category, g.event_date, g.venue).all();
      const rows = rowsRes.results || [];
      if (rows.length !== 2) continue; // race since the pre-filter query

      const verdict = classify(rows.map(r => r.name));
      if (verdict === 'different') { skipped.push({ reason: 'name-different', venue: g.venue, date: g.event_date }); continue; }

      const priced = rows.filter(r => r.price != null);
      const unpriced = rows.filter(r => r.price == null);
      if (priced.length !== 1 || unpriced.length !== 1) {
        skipped.push({ reason: 'not-exactly-one-priced', venue: g.venue, date: g.event_date, prices: rows.map(r => r.price) });
        continue;
      }

      const winner = priced[0];
      const loser = unpriced[0];
      merges.push({
        category: g.category, date: g.event_date, venue: g.venue, verdict,
        winnerSlug: winner.slug, winnerName: winner.name, winnerSource: winner.source, price: winner.price, currency: winner.currency,
        loserSlug: loser.slug, loserName: loser.name, loserSource: loser.source,
        fillTmUrl: !winner.tm_url && loser.tm_url ? loser.tm_url : null,
        fillImage: !winner.image && loser.image ? loser.image : null,
        fillCity: !winner.city && loser.city ? loser.city : null,
        fillVenue: !winner.venue && loser.venue ? loser.venue : null,
        willCopyTmUrlFromLoser: !winner.tm_url && !!loser.tm_url,
        willCopyImageFromLoser: !winner.image && !!loser.image,
        willCopyCityFromLoser: !winner.city && !!loser.city,
        willCopyVenueFromLoser: !winner.venue && !!loser.venue
      });
    }

    if (!dryRun && merges.length) {
      const now = new Date().toISOString();
      for (const m of merges) {
        try {
          await db.batch([
            db.prepare(
              'UPDATE event_pages SET ' +
              'tm_url = COALESCE(tm_url, ?1), ' +
              'image = COALESCE(image, ?2), ' +
              'city = COALESCE(city, ?3), ' +
              'venue = COALESCE(venue, ?4), ' +
              'updated_at = ?5 ' +
              'WHERE slug = ?6'
            ).bind(m.fillTmUrl, m.fillImage, m.fillCity, m.fillVenue, now, m.winnerSlug),
            db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(m.loserSlug)
          ]);
          await kv.put(`redirectSlug:event:${m.loserSlug}`, `event/${m.winnerSlug}`);
          m.applied = true;
        } catch (e) {
          m.applied = false;
          m.error = String(e);
        }
      }
    }

    const nextOffset = offset + groups.length;
    const done = groups.length < limit;
    if (!dryRun) {
      try { if (done) await kv.delete(cursorKey); else await kv.put(cursorKey, String(nextOffset)); } catch {}
    }

    return jsonResponse({
      merge: true, category: category || 'all', dryRun, offset, limit,
      candidateGroupsChecked: groups.length,
      eligibleForMerge: merges.length,
      skipped: skipped.length,
      skippedSample: skipped.slice(0, 10),
      done,
      next: done ? null : `?merge=1&trigger=1${category ? '&category=' + category : ''}&limit=${limit}${confirm ? '&confirm=yes' : ''}`,
      merges: dryRun ? merges : merges.map(m => ({ winnerSlug: m.winnerSlug, loserSlug: m.loserSlug, applied: m.applied, error: m.error })),
      message: dryRun
        ? 'Dry run — nothing written. Add &confirm=yes to merge + redirect.'
        : 'Merge complete for this batch.'
    });
  } catch (e) {
    return jsonResponse({ error: 'merge failed: ' + String(e) }, 500);
  }
}