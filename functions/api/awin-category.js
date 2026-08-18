// ===========================
// TicketScout — Awin category feed adapter
// Runs as a Cloudflare Pages Function at /api/awin-category
//
// Reads pre-parsed rows from Cloudflare KV (populated by
// /api/awin-category-cache every 6 hours) and finds the best
// matching event for a given query.
//
// Covers all approved Awin ticket merchants in one adapter:
// currently Gigsberg UK + Theatre Tickets Direct, with more
// appearing automatically as new Awin programmes are approved.
//
// Required env:
//   GIGSBERG_KV — KV namespace binding (shared with gigsberg adapter)
// ===========================

const CACHE_KEY = 'awin:category:latest';

export async function onRequestGet({ request, env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV binding.' }, 500);

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');
  const debug    = incoming.searchParams.get('debug') === '1';
  const date     = incoming.searchParams.get('date') || '';  // YYYY-MM-DD from Ticketmaster
  const venue    = incoming.searchParams.get('venue') || '';
  const merchant = incoming.searchParams.get('merchant') || '';  // e.g. 'Eventim PL' — restrict to one merchant

  if (!q) return jsonResponse({ error: 'q (event name) is required.' }, 400);

  try {
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });

    if (!index || !index.chunks) {
      return jsonResponse({ match: null }, 200);
    }

    // LATENCY FIX (6 Aug 2026): this used to be a sequential `for` loop —
    // one KV round-trip at a time, awaited in series. Flagged in the audit
    // as the single slowest API call across four separate tests, with an
    // apparently ESCALATING pattern (1,722ms → 2,136ms → 3,242ms → 3,497ms)
    // rather than one-off noise. The escalation is explained exactly by
    // CHUNK_SIZE=2000 in awin-category-cache.js: as more Awin merchants get
    // approved over time (this file's own header notes "more appearing
    // automatically as new Awin programmes are approved"), the feed grows,
    // chunk COUNT grows, and every new chunk added a full extra round-trip
    // in series — on EVERY live request, since this is the hot compare-
    // table path, not a cached/background job. Same bug class, same fix
    // shape as entity-lifecycle.js's earlier timeout fix this session:
    // there's no ordering dependency between chunks (they're just
    // concatenated), so fetching them concurrently via Promise.all is
    // strictly safe and turns N sequential round-trips into 1.
    const allRows = (await Promise.all(
      Array.from({ length: index.chunks }, (_, i) => kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' }))
    )).filter(Boolean).flat();

    if (debug) {
      const nameMatches = allRows
        .filter(r => {
          const name = (r.product_name || '').toLowerCase();
          const artist = (r.primary_artist || '').toLowerCase();
          const event = (r.event_name || '').toLowerCase();
          const ql = q.toLowerCase();
          return name.includes(ql) || artist.includes(ql) || event.includes(ql);
        })
        .slice(0, 5)
        .map(r => ({
          product_name: r.product_name,
          primary_artist: r.primary_artist,
          event_name: r.event_name,
          event_date: r.event_date,
          extracted_date: extractDateFromDescription(r.description),
          price: r.price,
          merchant: r.merchant_name,
          url: r.aw_deep_link
        }));

      return jsonResponse({
        totalRowsLoaded: allRows.length,
        kvIndex: index,
        rowsMatchingQuery: nameMatches,
        queryReceived: q,
        dateFilter: date,
        venueFilter: venue
      }, 200);
    }

    // Optional merchant restriction (dedicated adapters e.g. Eventim PL)
    const pool = merchant
      ? allRows.filter(r => (r.merchant_name || '').toLowerCase() === merchant.toLowerCase())
      : allRows;
    const matches = findBestMatches(pool, q, date, venue);
    if (matches.length === 0) return jsonResponse({ matches: [] }, 200);

    return jsonResponse({ matches: matches.map(toResult) }, 200);

  } catch (err) {
    // Graceful degradation — return empty matches instead of 502
    // Prevents Gigsberg 502 errors breaking the compare table
    // Cache will repopulate on next scheduled refresh
    console.error('Awin category KV read error:', err);
    return jsonResponse({ matches: [], warning: 'Cache temporarily unavailable' }, 200);
  }
}

// ===========================
// Matching — finds the best price for a specific event
//
// Strategy:
//   1. Score all rows by name match (primary_artist / event_name / product_name)
//   2. If a target date is provided, prefer rows whose event_date is within
//      3 days of the target (handles date format differences and timezone edge
//      cases). Rows with no date are kept as fallback only.
//   3. Among date-matched rows, return the lowest price.
//   4. If no date-matched rows exist, fall back to lowest price across all
//      name-matched rows (better than no result).
// ===========================

function normaliseName(str) {
  // Punctuation → space (not deleted), then collapse. Deleting hyphens made
  // "JAY-Z" → "jayz" which never matched the feed's "Jay Z" → "jay z", so
  // every hyphenated act (Jay-Z, Wham!, AC/DC…) silently missed. Both sides
  // now normalise to the same spaced form.
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreRow(row, query) {
  const normQuery = normaliseName(query);

  const candidates = [
    row.primary_artist,
    row.event_name,
    row.product_name
  ].map(normaliseName).filter(Boolean);

  let best = 0;
  for (const name of candidates) {
    let score = 0;
    if (name === normQuery)                                   score = 100;
    else if (name.startsWith(normQuery))                      score = 60;
    else if (name.includes(normQuery))                        score = 30;
    else if (normQuery.includes(name) && name.length > 5)     score = 20;
    if (score > best) best = score;
  }
  return best;
}

// Returns true if rowDate (string, any format) is within `windowDays` of targetDate (YYYY-MM-DD)
function isDateMatch(rowDate, targetDate, windowDays = 3) {
  if (!rowDate || !targetDate) return false;
  try {
    const target = new Date(targetDate);
    const row    = new Date(rowDate);
    if (isNaN(target.getTime()) || isNaN(row.getTime())) return false;
    const diffMs   = Math.abs(target.getTime() - row.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= windowDays;
  } catch {
    return false;
  }
}

// Extracts a date string from Gigsberg's description field
// Format: "Event Type: Concert, Venue: London Stadium, Date: 2026-07-03, Time: 19:00:00"
//
// FIX (16 Aug 2026): previously only recognised yyyy-mm-dd. awin-category-
// cache.js's own extractSyncDate() (a different function, used for the
// event_pages D1 sync) documents BOTH "Date: yyyy-mm-dd AND Date: dd/mm/
// yyyy" as real formats this feed uses — this function never handled the
// second one. This wasn't a latent edge case: parseFeedRow() in that same
// file hardcodes event_date: '' for every row reaching THIS adapter's KV
// chunks (comment: "Date/venue extracted from description field by awin-
// category.js"), so getRowDate() below falls through to this function for
// every single row, no exceptions. A dd/mm/yyyy row silently returned '',
// which made isDateMatch() reject it outright regardless of whether the
// actual date was correct — live, not hypothetical, for any row in that
// format.
function extractDateFromDescription(description) {
  if (!description) return '';
  const iso = description.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
  if (iso) return iso[1];
  const dmy = description.match(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return '';
}

// Returns the best date available for a row — prefers event_date, falls back to description
function getRowDate(row) {
  return row.event_date || extractDateFromDescription(row.description) || '';
}

function findBestMatches(rows, query, targetDate, venueName) {
  // Score all rows by name
  const scored = rows
    .map(row => ({ row, score: scoreRow(row, query) }))
    .filter(r => r.score > 0);

  if (scored.length === 0) return [];

  // Split into date-matched and fallback groups
  const dateMatched = targetDate
    ? scored.filter(r => isDateMatch(getRowDate(r.row), targetDate))
    : [];

  // Only use date-matched results when a target date is provided
  // If no date match found, return empty rather than showing wrong-date events
  // This prevents past/wrong-date events appearing in compare table
  if (targetDate && dateMatched.length === 0) return [];
  const pool = dateMatched.length > 0 ? dateMatched : scored;

  // FIX (16 Aug 2026): venueName was accepted as a parameter and passed in
  // from onRequestGet, but never referenced anywhere in this function —
  // dead code. Checked every current caller (concert.js, discover-pages.js,
  // entity-lifecycle.js): none currently send &venue=, so this wasn't
  // causing an observed live symptom the way the date-format gap above
  // was — but it's the exact same class of risk this session already
  // confirmed real elsewhere (price-history.js's Les Miserables incident:
  // name+date alone isn't always enough to identify one specific real
  // event when productions/fixtures can share both). Same normalise-and-
  // substring-match approach as that fix, for consistency. Deliberately a
  // SORT-priority boost, not a filter: when venueName is falsy (every
  // caller today), this block never runs and sort output is byte-for-byte
  // identical to before. When a caller does supply one, venue-matching
  // rows are preferred but a non-match still falls through to the
  // pre-existing score/price ordering rather than being excluded outright —
  // same degrade-gracefully philosophy as that earlier fix.
  const wantVenueNorm = venueName ? normaliseVenue(venueName) : '';

  // Sort by score desc, then price asc
  pool.sort((a, b) => {
    if (wantVenueNorm) {
      const aMatch = venueRowMatches(a.row.venue_name, wantVenueNorm);
      const bMatch = venueRowMatches(b.row.venue_name, wantVenueNorm);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
    }
    if (b.score !== a.score) return b.score - a.score;
    return a.row.price - b.row.price;
  });

  // Best match PER MERCHANT — so Gigsberg, Eventim PL and Football TicketNet
  // can each appear as separate priced rows in the compare table instead of
  // one merchant's match hiding all the others.
  const byMerchant = new Map();
  for (const r of pool) {
    const m = r.row.merchant_name || 'Awin';
    if (!byMerchant.has(m)) byMerchant.set(m, r.row);
  }
  return [...byMerchant.values()].slice(0, 4);
}

function normaliseVenue(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function venueRowMatches(rowVenue, wantVenueNorm) {
  const rowNorm = normaliseVenue(rowVenue);
  if (!rowNorm) return false; // row has no venue data — can't confirm a match either way
  return rowNorm === wantVenueNorm || rowNorm.includes(wantVenueNorm) || wantVenueNorm.includes(rowNorm);
}

function toResult(row) {
  return {
    name:          row.product_name,
    url:           row.aw_deep_link,
    price:         row.price,
    currency:      row.currency || 'GBP',
    merchant_name: row.merchant_name,
    event_name:    row.event_name || null,
    venue_name:    row.venue_name || null,
    event_city:    row.event_city || null,
    // Added for callers needing descriptive text (e.g. concert.js's "About
    // the artist" fallback card) — additive fields, existing callers that
    // only read the properties above are unaffected.
    description:   row.description || null,
    category:      row.merchant_category || row.category_name || null
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}