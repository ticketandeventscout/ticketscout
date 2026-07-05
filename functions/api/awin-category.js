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
  const q     = incoming.searchParams.get('q');
  const debug = incoming.searchParams.get('debug') === '1';
  const date  = incoming.searchParams.get('date') || '';  // YYYY-MM-DD from Ticketmaster
  const venue = incoming.searchParams.get('venue') || '';

  if (!q) return jsonResponse({ error: 'q (event name) is required.' }, 400);

  try {
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });

    if (!index || !index.chunks) {
      return jsonResponse({ match: null }, 200);
    }

    // Load all chunks
    const allRows = [];
    for (let i = 0; i < index.chunks; i++) {
      const chunk = await kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' });
      if (chunk) allRows.push(...chunk);
    }

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

    const matches = findBestMatches(allRows, q, date, venue);
    if (matches.length === 0) return jsonResponse({ matches: [] }, 200);

    return jsonResponse({ matches: matches.map(toResult) }, 200);

  } catch (err) {
    console.error('Awin category KV read error:', err);
    return jsonResponse({ error: 'Unable to read Awin category cache.' }, 502);
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
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
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
function extractDateFromDescription(description) {
  if (!description) return '';
  const match = description.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : '';
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

  // Use date-matched group if we have results; otherwise fall back to all matches
  const pool = dateMatched.length > 0 ? dateMatched : scored;

  // Sort by score desc, then price asc
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.row.price - b.row.price;
  });

  return [pool[0].row];
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
    event_city:    row.event_city || null
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}