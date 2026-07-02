// ===========================
// TicketScout — Awin category feed cache Worker
// Runs as a Cloudflare Pages Function at /api/awin-category-cache
//
// Fetches the Awin Entertainment/Tickets category feed (categories 586,
// 588, 590, 592) which covers all approved Awin merchants in one feed.
// Currently includes: Gigsberg UK, Theatre Tickets Direct.
// New approved merchants appear automatically with no code changes needed.
//
// Feed format: standard columnar CSV (73 columns), gzip compressed.
// Awin serves Content-Type: application/gzip without Content-Encoding
// so we manually pipe through DecompressionStream.
//
// Cron: triggered every 6 hours by cron-job.org
//   → https://ticketscout.co.uk/api/awin-category-cache?trigger=1
//
// Required env vars:
//   AWIN_CATEGORY_FEED_URL  — full Awin category feed URL (Secret)
//   GIGSBERG_KV             — KV namespace binding (reused for all Awin data)
// ===========================

const CACHE_KEY    = 'awin:category:latest';
const CACHE_TTL    = 7 * 60 * 60; // 7 hours
const CHUNK_SIZE   = 2000;

// Column indices for the fields we actually use (0-based)
// Derived from the 73-column feed structure
const COL = {
  aw_deep_link:   0,
  product_name:   1,
  merchant_name:  8,
  merchant_id:    9,
  category_name:  10,
  currency:       13,
  display_price:  19,
  search_price:   7,
  store_price:    14,
  in_stock:       44,
  is_for_sale:    48,
  merchant_category: 6,
  description:    5,  // "Event Type: Concert, Venue: London Stadium, Date: 2026-07-03..."
  // Ticket-specific (filled by some merchants)
  primary_artist: 54,
  event_name:     57,
  venue_name:     58,
  event_date:     56,
  event_city:     68,
  event_country:  70,
  min_price:      62,
  max_price:      63,
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return new Response('Add ?trigger=1 to manually run the cache refresh.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Debug mode: ?trigger=1&debug=ftn
  // Returns the first 3 raw rows from Football TicketNet UK
  // so we can inspect their column layout without a full cache refresh
  const debug = url.searchParams.get('debug');
  if (debug === 'ftn') {
    const result = await debugFeedRows(env, 'Football Ticket');
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const result = await refreshCache(env);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ===========================
// Debug helper — fetches the feed and returns the first few raw rows
// from a named merchant so we can inspect their column layout
// Usage: /api/awin-category-cache?trigger=1&debug=ftn
// ===========================

async function debugFeedRows(env, merchantFilter) {
  const feedUrl = env.AWIN_CATEGORY_FEED_URL;
  if (!feedUrl) return { error: 'Missing AWIN_CATEGORY_FEED_URL' };

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return { error: `HTTP ${response.status}` };

    const decompressedStream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const decoder = new TextDecoder();
    const reader = decompressedStream.getReader();

    let buffer = '';
    let headers = null;
    let matchedRows = [];
    let totalLines = 0;
    let isFirstLine = true;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let searchFrom = 0;
      let inQuotes = false;

      for (let ci = 0; ci < buffer.length; ci++) {
        const ch = buffer[ci];
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === '\n' && !inQuotes) {
          const line = buffer.slice(searchFrom, ci).replace(/\r$/, '');
          searchFrom = ci + 1;

          if (isFirstLine) {
            isFirstLine = false;
            headers = parseCsvLine(line);
            continue;
          }

          if (!line.trim()) continue;
          totalLines++;

          const fields = parseCsvLine(line);
          const merchantName = (fields[8] || '').trim();

          if (merchantName.toLowerCase().includes(merchantFilter.toLowerCase())) {
            matchedRows.push({
              fieldCount: fields.length,
              merchantName,
              col0_aw_deep_link:       fields[0],
              col1_product_name:       fields[1],
              col6_merchant_category:  fields[6],
              col7_search_price:       fields[7],
              col13_currency:          fields[13],
              col14_store_price:       fields[14],
              col19_display_price:     fields[19],
              col44_in_stock:          fields[44],
              col48_is_for_sale:       fields[48],
              col54_primary_artist:    fields[54],
              col56_event_date:        fields[56],
              col57_event_name:        fields[57],
              col62_min_price:         fields[62],
              first25Fields:           fields.slice(0, 25)
            });
            if (matchedRows.length >= 3) break outer;
          }
        }
      }
      buffer = buffer.slice(searchFrom);
    }

    reader.releaseLock();

    return {
      totalLinesScanned: totalLines,
      headerCount: headers?.length,
      headers: headers?.slice(0, 25),
      matchedRows
    };

  } catch (err) {
    return { error: String(err) };
  }
}

async function refreshCache(env) {
  const feedUrl = env.AWIN_CATEGORY_FEED_URL;
  if (!feedUrl) return { success: false, error: 'Missing AWIN_CATEGORY_FEED_URL' };

  const kv = env.GIGSBERG_KV;
  if (!kv) return { success: false, error: 'Missing GIGSBERG_KV binding' };

  const startTime = Date.now();
  console.log('Awin category cache refresh started');

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };

    // Awin serves gzip without Content-Encoding — must decompress manually
    const decompressedStream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const { rows, skipped, merchants } = await parseFeedStream(decompressedStream);

    console.log(`Parsed: ${rows.length} rows kept, ${skipped} skipped, merchants: ${JSON.stringify(merchants)}`);

    if (rows.length === 0) {
      return { success: false, error: 'Zero rows parsed', skipped };
    }

    // Write in chunks to stay within KV 25MB value limit
    const chunks = [];
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      chunks.push(rows.slice(i, i + CHUNK_SIZE));
    }

    for (let i = 0; i < chunks.length; i++) {
      await kv.put(`${CACHE_KEY}:chunk:${i}`, JSON.stringify(chunks[i]), {
        expirationTtl: CACHE_TTL
      });
    }

    await kv.put(`${CACHE_KEY}:index`, JSON.stringify({
      chunks: chunks.length,
      totalRows: rows.length,
      merchants,
      cachedAt: new Date().toISOString()
    }), { expirationTtl: CACHE_TTL });

    return {
      success: true,
      rowsCached: rows.length,
      chunks: chunks.length,
      skipped,
      merchants,
      elapsedMs: Date.now() - startTime,
      cachedAt: new Date().toISOString(),
      sampleRow: rows[0] || null
    };

  } catch (err) {
    console.error('Awin category cache error:', err);
    return { success: false, error: String(err) };
  }
}

// ===========================
// Stream parser — processes one CSV line at a time
// Never holds the full feed in memory
// ===========================

async function parseFeedStream(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const rows = [];
  const merchantCounts = {};

  let buffer = '';
  let isFirstLine = true;
  let skipped = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let searchFrom = 0;
      let inQuotes = false;

      for (let ci = 0; ci < buffer.length; ci++) {
        const ch = buffer[ci];
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === '\n' && !inQuotes) {
          const line = buffer.slice(searchFrom, ci).replace(/\r$/, '');
          searchFrom = ci + 1;

          if (isFirstLine) { isFirstLine = false; continue; }
          if (!line.trim()) continue;

          const row = parseRow(line);
          if (row) {
            rows.push(row);
            merchantCounts[row.merchant_name] = (merchantCounts[row.merchant_name] || 0) + 1;
          } else {
            skipped++;
          }
        }
      }

      buffer = buffer.slice(searchFrom);
    }

    // Handle any remaining line
    if (buffer.trim() && !isFirstLine) {
      const row = parseRow(buffer.trim());
      if (row) {
        rows.push(row);
        merchantCounts[row.merchant_name] = (merchantCounts[row.merchant_name] || 0) + 1;
      }
    }

  } finally {
    reader.releaseLock();
  }

  console.log(`Stream parse complete: ${rows.length} rows kept, ${skipped} skipped`);
  return { rows, skipped, merchants: merchantCounts };
}

// Parses one CSV line into a normalised row object.
// Returns null if the row should be skipped.
function parseRow(line) {
  const fields = parseCsvLine(line);
  if (fields.length < 20) return null; // too few fields to be valid

  const price = parsePrice(
    fields[COL.search_price] ||
    fields[COL.display_price] ||
    fields[COL.store_price] ||
    fields[COL.min_price]
  );
  if (!price) return null;

  const productName = (fields[COL.product_name] || '').trim();
  const awDeepLink  = (fields[COL.aw_deep_link]  || '').trim();
  if (!productName || !awDeepLink) return null;

  // Availability checks
  const inStock = fields[COL.in_stock];
  const forSale = fields[COL.is_for_sale];
  if (inStock === '0' || inStock === 'false' || forSale === '0' || forSale === 'false') return null;

  const merchantName = (fields[COL.merchant_name] || '').trim();

  return {
    product_name:      productName,
    aw_deep_link:      awDeepLink,
    price:             price,
    currency:          fields[COL.currency] || 'GBP',
    merchant_name:     merchantName,
    merchant_id:       fields[COL.merchant_id] || '',
    category_name:     fields[COL.category_name] || '',
    merchant_category: fields[COL.merchant_category] || '',
    description:       (fields[COL.description] || '').slice(0, 300), // capped to keep KV lean
    // Ticket-specific fields (populated by some merchants)
    primary_artist:  (fields[COL.primary_artist] || '').trim(),
    event_name:      (fields[COL.event_name]     || '').trim(),
    venue_name:      (fields[COL.venue_name]     || '').trim(),
    event_date:      (fields[COL.event_date]     || '').trim(),
    event_city:      (fields[COL.event_city]     || '').trim(),
    event_country:   (fields[COL.event_country]  || '').trim(),
  };
}

function parsePrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) || num <= 0 ? null : num;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
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