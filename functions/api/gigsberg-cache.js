// ===========================
// TicketScout — Server-side Gigsberg UK adapter
// Runs as a Cloudflare Pages Function at /api/gigsberg
//
// This Function is intentionally lightweight — all feed fetching,
// decompression, and CSV parsing happens in the scheduled cache Worker
// (functions/scheduled/gigsberg-cache.js) which runs every 6 hours.
//
// This Function only:
//   1. Reads pre-parsed rows from Cloudflare KV (near-instant)
//   2. Finds the best name match for the requested event
//   3. Returns a normalised result to compare.js
//
// If KV is empty (e.g. before the first scheduled run), the Function
// returns { match: null } gracefully rather than erroring.
//
// Required env:
//   GIGSBERG_KV  — KV namespace binding (configured in wrangler.toml)
//
// Part of the TicketScout source adapter pattern.
// Normalisation into { source, price, currency, url, available }
// is handled in compare.js by the Gigsberg adapter entry.
// ===========================

const CACHE_KEY = 'gigsberg:feed:latest';

export async function onRequestGet({ request, env }) {
  const kv = env.GIGSBERG_KV;

  if (!kv) {
    return jsonResponse({ error: 'GIGSBERG_KV binding is not configured.' }, 500);
  }

  const incoming = new URL(request.url);
  const q = incoming.searchParams.get('q');
  const debug = incoming.searchParams.get('debug') === '1';

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  try {
    // Read the index first to find out how many chunks exist
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });

    if (!index || !index.chunks) {
      console.warn('Gigsberg KV cache is empty — scheduled Worker may not have run yet');
      return jsonResponse({ match: null }, 200);
    }

    // Read all chunks and concatenate into one array
    const allRows = [];
    for (let i = 0; i < index.chunks; i++) {
      const chunk = await kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' });
      if (chunk) allRows.push(...chunk);
    }

    if (debug) {
      const nameMatches = allRows
        .filter(r => (r.product_name || '').toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
        .map(r => ({ name: r.product_name, price: r.display_price, url: r.aw_deep_link }));
      return jsonResponse({
        kvIndexFound: true,
        totalRowsLoaded: allRows.length,
        rowsContainingQuery: nameMatches,
        queryReceived: q
      }, 200);
    }

    if (allRows.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    const match = findBestMatch(allRows, q);
    return jsonResponse({ match: match ? toResult(match) : null }, 200);

  } catch (err) {
    console.error('Gigsberg KV read error:', err);
    return jsonResponse({ error: 'Unable to read Gigsberg cache.' }, 502);
  }
}

// ===========================
// Matching — find the best event name match for a given query.
// Gigsberg's product_name field is the performer name only (e.g. "Metallica"),
// not the full event title — so we score on whether the query *contains*
// the performer name, not just whether names match exactly.
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function findBestMatch(rows, query) {
  const normQuery = normaliseName(query);

  const scored = rows
    .map(row => {
      const normName = normaliseName(row.product_name);
      let score = 0;
      if (normName === normQuery)                                    score = 100;
      else if (normName.startsWith(normQuery))                       score = 60;
      else if (normName.includes(normQuery))                         score = 30;
      else if (normQuery.includes(normName) && normName.length > 5)  score = 20;
      return { row, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Among equal scores, prefer lowest price
      const priceA = parsePrice(a.row.display_price || a.row.search_price || a.row.store_price);
      const priceB = parsePrice(b.row.display_price || b.row.search_price || b.row.store_price);
      if (priceA && !priceB) return -1;
      if (!priceA && priceB) return  1;
      if (priceA && priceB)  return priceA - priceB;
      return 0;
    });

  return scored.length > 0 ? scored[0].row : null;
}

function parsePrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) || num <= 0 ? null : num;
}

function toResult(row) {
  const price = parsePrice(row.display_price || row.search_price || row.store_price);
  return {
    name:     row.product_name,
    url:      row.aw_deep_link,
    price,
    currency: row.currency || 'GBP'
  };
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