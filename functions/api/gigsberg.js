// ===========================
// TicketScout — Server-side Gigsberg UK adapter
// Runs as a Cloudflare Pages Function at /api/gigsberg
//
// Gigsberg is a secondary ticket marketplace, accessed via an Awin
// product datafeed (gzip-compressed CSV, ~17,400 products across two
// datafeed IDs: 113390 and 114102).
//
// The feed URL embeds the Awin API key, so it must never be exposed
// client-side — this Function is the only place it's used.
//
// Feed is fetched and cached in Cloudflare KV (GIGSBERG_KV) for 6 hours
// to avoid re-downloading ~17k rows on every page load.
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   AWIN_PUBLISHER_ID    — 2960641 (already set, used for reference/logging)
//   GIGSBERG_FEED_URL    — the full Awin datafeed URL (contains the API key)
//
// Optional KV binding:
//   GIGSBERG_KV          — KV namespace binding, enables caching
//
// Part of the TicketScout source adapter pattern.
// Normalisation into { source, price, currency, url, available }
// is handled in compare.js by the Gigsberg adapter entry.
// ===========================

// Column order exactly as configured in the Awin datafeed URL —
// position in this array MUST match the order requested in the feed URL.
const COLUMNS = [
  'aw_deep_link', 'product_name', 'aw_product_id', 'merchant_product_id',
  'merchant_image_url', 'description', 'merchant_category', 'search_price',
  'merchant_name', 'merchant_id', 'category_name', 'category_id',
  'aw_image_url', 'currency', 'store_price', 'delivery_cost',
  'merchant_deep_link', 'language', 'last_updated', 'display_price',
  'data_feed_id', 'brand_name', 'brand_id', 'colour',
  'product_short_description', 'specifications', 'condition',
  'product_model', 'model_number', 'dimensions', 'keywords',
  'promotional_text', 'product_type', 'commission_group',
  'merchant_product_category_path', 'merchant_product_second_category',
  'merchant_product_third_category', 'rrp_price', 'saving',
  'savings_percent', 'base_price', 'base_price_amount', 'base_price_text',
  'product_price_old', 'in_stock', 'stock_quantity', 'valid_from',
  'valid_to', 'is_for_sale', 'web_offer', 'pre_order', 'stock_status',
  'size_stock_status', 'size_stock_amount'
];

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const CACHE_KEY = 'gigsberg:feed:latest';

export async function onRequestGet({ request, env }) {
  const feedUrl = env.GIGSBERG_FEED_URL;

  if (!feedUrl) {
    return jsonResponse({ error: 'Server is missing GIGSBERG_FEED_URL.' }, 500);
  }

  const incoming = new URL(request.url);
  const q = incoming.searchParams.get('q');
  const debug = incoming.searchParams.get('debug') === '1';

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  try {
    const rows = await fetchFeed(feedUrl, env);
    if (!rows) {
      return jsonResponse({ error: 'Feed unavailable.' }, 502);
    }

    if (debug) {
      // Surface internal state so we can see exactly what the parser
      // produced without digging through Cloudflare logs
      const sample = rows.slice(0, 5).map(r => ({
        product_name: r.product_name,
        merchant_category: r.merchant_category,
        category_name: r.category_name,
        display_price: r.display_price,
        search_price: r.search_price
      }));
      const nameMatches = rows.filter(r =>
        (r.product_name || '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, 5).map(r => r.product_name);

      return jsonResponse({
        totalRowsParsed: rows.length,
        sampleRows: sample,
        rowsContainingQuery: nameMatches,
        queryReceived: q
      }, 200);
    }

    const match = findBestMatch(rows, q);

    if (!match) {
      return jsonResponse({ match: null }, 200);
    }

    return jsonResponse({ match: toResult(match) }, 200);
  } catch (err) {
    console.error('Gigsberg feed error:', err);
    return jsonResponse({ error: 'Unable to fetch Gigsberg feed.' }, 502);
  }
}

// ===========================
// Feed fetching — KV cache first, falls back to direct fetch + decompress
// ===========================

async function fetchFeed(feedUrl, env) {
  // Try KV cache first (stores parsed JSON rows, not raw CSV, to skip
  // re-parsing 17k rows on every request within the cache window)
  if (env.GIGSBERG_KV) {
    try {
      const cached = await env.GIGSBERG_KV.get(CACHE_KEY, { type: 'json' });
      if (cached) return cached;
    } catch (e) {
      console.warn('KV read failed, falling back to direct fetch:', e);
    }
  }

  // Fetch fresh — gzip is decompressed automatically by the Fetch API
  // since Awin serves it with Content-Encoding: gzip
  const response = await fetch(feedUrl);
  if (!response.ok) return null;

  const csvText = await response.text();
  const rows = parseCsv(csvText);

  if (env.GIGSBERG_KV && rows.length) {
    try {
      await env.GIGSBERG_KV.put(CACHE_KEY, JSON.stringify(rows), {
        expirationTtl: CACHE_TTL_SECONDS
      });
    } catch (e) {
      console.warn('KV write failed:', e);
    }
  }

  return rows;
}

// ===========================
// CSV parsing — handles quoted fields containing commas, matches
// columns by position per the COLUMNS array above
// ===========================

function parseCsv(text) {
  const lines = splitCsvLines(text);
  if (lines.length === 0) return [];

  // First line is the header row from Awin — skip it, we trust our
  // own COLUMNS order rather than re-parsing the header, since Awin's
  // header should match exactly what we requested in the feed URL
  const dataLines = lines.slice(1);

  const rows = [];
  let skippedCount = 0;

  for (const line of dataLines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);

    // Be tolerant of small column count mismatches (trailing empty fields
    // are common in Awin feeds) rather than dropping the row outright —
    // pad short rows, truncate long ones
    if (fields.length < COLUMNS.length - 5) {
      skippedCount++;
      continue; // genuinely malformed, skip
    }

    const row = {};
    COLUMNS.forEach((col, i) => { row[col] = fields[i] ?? ''; });

    // Only keep rows that look like tickets/events (cheap pre-filter to
    // keep the in-memory/cached row count down)
    const category = `${row.merchant_category} ${row.category_name} ${row.merchant_product_category_path}`.toLowerCase();
    const nameCheck = (row.product_name || '').toLowerCase();
    const isTicketLike =
      /ticket|event|concert|festival|theatre|theater|sport|gig|show|match|tour|comedy/.test(category) ||
      /ticket|event|concert|festival|theatre|theater|gig|show|tour/.test(nameCheck);

    if (isTicketLike) rows.push(row);
  }

  console.log(`Gigsberg feed parsed: ${rows.length} rows kept, ${skippedCount} malformed rows skipped`);

  return rows;
}

// Splits raw CSV text into lines, respecting quoted fields that may
// contain literal newlines (rare but possible in description fields)
function splitCsvLines(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (char !== '\r') {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  return lines;
}

// Parses a single CSV line into fields, handling quoted commas
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);

  return fields;
}

// ===========================
// Matching — find the best event name match for a given query
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
      if (normName === normQuery)              score = 100;
      else if (normName.startsWith(normQuery)) score = 60;
      else if (normName.includes(normQuery))   score = 30;
      else if (normQuery.includes(normName) && normName.length > 5) score = 20;
      return { row, score };
    })
    .filter(r => r.score > 0)
    .filter(r => {
      // Only consider rows that are actually for sale / in stock
      const inStock = r.row.in_stock?.toLowerCase();
      const forSale = r.row.is_for_sale?.toLowerCase();
      return inStock !== 'false' && inStock !== '0' && forSale !== 'false' && forSale !== '0';
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priceA = parsePrice(a.row.display_price || a.row.search_price || a.row.store_price);
      const priceB = parsePrice(b.row.display_price || b.row.search_price || b.row.store_price);
      if (priceA && !priceB) return -1;
      if (!priceA && priceB) return 1;
      if (priceA && priceB) return priceA - priceB;
      return 0;
    });

  return scored.length > 0 ? scored[0].row : null;
}

function parsePrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// Converts a matched feed row into the response shape sent to the client.
// Final normalisation into { source, price, currency, url, available }
// happens in compare.js, matching the pattern used by other adapters.
function toResult(row) {
  // Prefer the deep link that already includes affiliate tracking
  const url = row.aw_deep_link || row.merchant_deep_link;
  const price = parsePrice(row.display_price || row.search_price || row.store_price);

  return {
    name: row.product_name,
    url,
    price,
    currency: row.currency || 'GBP',
    category: row.category_name || row.merchant_category || null,
    lastUpdated: row.last_updated || null
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