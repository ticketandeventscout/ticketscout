// ===========================
// TicketScout — Server-side Ticketmaster Attractions proxy
// Runs as a Cloudflare Pages Function at /api/attractions
//
// Used to resolve a free-text search (e.g. "Coldplay") into one or
// more specific attraction records (artists/teams/shows) BEFORE
// fetching events — this is what lets us guarantee a single artist
// per event query later, instead of loose keyword matching.
//
// Scoring + filtering applied here (server-side) so the client
// receives a clean, ranked list rather than raw TM results:
//   1. Exact name match   → score 100  (will auto-skip picker on client)
//   2. Starts-with match  → score 50
//   3. Tribute/cover act  → score penalised by -30 (pushed to bottom)
//   4. Everything else    → score 0 (ranked by TM's own order)
//
// We fetch up to 20 candidates from TM so there's enough room to
// filter and still return a useful set after scoring.
// ===========================

// Keywords that strongly suggest a tribute/cover act
const TRIBUTE_KEYWORDS = [
  'tribute', 'salute', 'legacy', 'experience', 'revival',
  'forever', 'reunion', 'story of', 'performed by', 'feat.',
  'vs.', ' vs '
];

function normaliseName(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function isTribute(name, query) {
  const lower = name.toLowerCase();
  const normQuery = normaliseName(query);
  const normName = normaliseName(name);

  // If the name contains the query AND a tribute keyword, it's a tribute act
  if (normName.includes(normQuery)) {
    return TRIBUTE_KEYWORDS.some(kw => lower.includes(kw));
  }
  return false;
}

function scoreAttraction(attraction, query) {
  const normQuery = normaliseName(query);
  const normName = normaliseName(attraction.name);

  let score = 0;

  if (normName === normQuery) {
    score = 100;
  } else if (normName.startsWith(normQuery)) {
    score = 50;
  } else if (normName.includes(normQuery)) {
    score = 20;
  }

  if (isTribute(attraction.name, query)) {
    score -= 30;
  }

  return score;
}

export async function onRequestGet({ request, env }) {
  const apiKey = env.TM_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Server is missing TM_API_KEY environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const keyword = incoming.searchParams.get('keyword');

  if (!keyword) {
    return jsonResponse({ error: 'A keyword is required.' }, 400);
  }

  // Fetch more candidates than we'll return so scoring has room to work
  const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
  tmUrl.searchParams.set('apikey', apiKey);
  tmUrl.searchParams.set('keyword', keyword);
  tmUrl.searchParams.set('size', '20');

  try {
    const tmResponse = await fetch(tmUrl.toString());
    const data = await tmResponse.json();

    const raw = data._embedded?.attractions || [];

    if (raw.length === 0) {
      // Return empty so the client falls through to keyword event search
      return jsonResponse({ _embedded: { attractions: [] } }, 200);
    }

    // Score and sort
    const scored = raw
      .map(a => ({ ...a, _score: scoreAttraction(a, keyword) }))
      .sort((a, b) => b._score - a._score);

    // Check for a clear exact-match winner (score 100, and at least 10 points
    // ahead of the next result) — flag it so the client can auto-navigate
    const top = scored[0];
    const second = scored[1];
    const hasExactMatch =
      top._score === 100 &&
      (!second || top._score - second._score >= 10);

    // Strip the internal _score field before sending to the client,
    // but add a _tributeAct flag for the ones the client should label
    const attractions = scored.slice(0, 10).map(a => ({
      ...a,
      _score: undefined,
      _tributeAct: isTribute(a.name, keyword)
    }));

    return jsonResponse(
      {
        _embedded: { attractions },
        _meta: { hasExactMatch, exactMatchId: hasExactMatch ? top.id : null }
      },
      200
    );
  } catch (err) {
    return jsonResponse({ error: 'Unable to reach Ticketmaster.' }, 502);
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
