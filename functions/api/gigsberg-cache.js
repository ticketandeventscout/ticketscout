// ===========================
// TicketScout — Gigsberg feed cache Worker
// Runs on a cron schedule (every 6 hours) via Cloudflare triggers.
//
// This Worker does the heavy lifting that would be too slow for a
// real-time request:
//   1. Fetches the Awin product feed (~1.3MB gzip)
//   2. Decompresses gzip manually (Awin sends Content-Type: application/gzip
//      without Content-Encoding, so auto-decompression doesn't apply)
//   3. Parses the CSV into clean JSON row objects
//   4. Filters to ticket-like rows only to keep KV storage lean
//   5. Writes the result to KV as "gigsberg:feed:latest"
//
// The /api/gigsberg Function then reads from KV on every user request —
// this is near-instant (<1ms) and well within Cloudflare's free plan limits.
//
// Required env vars:
//   GIGSBERG_FEED_URL  — full Awin datafeed URL (set as a Secret)
//   GIGSBERG_KV        — KV namespace binding (set in wrangler.toml)
// ===========================

// Column order exactly as configured in the Awin datafeed URL —
// must stay in sync with functions/api/gigsberg.js
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

const CACHE_KEY = 'gigsberg:feed:latest';
const CACHE_TTL_SECONDS = 7 * 60 * 60; // 7 hours (slightly longer than the 6hr cron interval)

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return new Response('Add ?trigger=1 to manually run the cache refresh.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  const result = await refreshCache(env);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ===========================
// Main cache refresh logic
// ===========================

async function refreshCache(env) {
  const feedUrl = env.GIGSBERG_FEED_URL;
  if (!feedUrl) {
    console.error('GIGSBERG_FEED_URL is not set');
    return { success: false, error: 'Missing GIGSBERG_FEED_URL' };
  }

  const kv = env.GIGSBERG_KV;
  if (!kv) {
    console.error('GIGSBERG_KV binding is not configured');
    return { success: false, error: 'Missing GIGSBERG_KV binding' };
  }

  console.log('Gigsberg cache refresh started');
  const startTime = Date.now();

  try {
    // ── Step 1: Fetch the feed ─────────────────────────────────────────
    const response = await fetch(feedUrl);
    if (!response.ok) {
      console.error(`Feed fetch failed: HTTP ${response.status}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    // ── Step 2: Decompress and process line by line ────────────────────
    // Rather than buffering the entire decompressed text into memory,
    // we read the stream in chunks and process one CSV line at a time.
    // This keeps peak memory usage well under the 128MB Pages Function limit.
    const decompressedStream = response.body.pipeThrough(
      new DecompressionStream('gzip')
    );

    const { rows, skipped } = await parseCsvStream(decompressedStream);
    console.log(`Feed parsed: ${rows.length} ticket rows, ${skipped} skipped`);

    if (rows.length === 0) {
      console.error('Parsed feed produced zero rows — aborting KV write');
      return { success: false, error: 'Zero rows parsed — feed may be malformed', skipped };
    }

    // ── Step 3: Write to KV in chunks ─────────────────────────────────
    // KV has a 25MB value limit. Split into chunks of 2000 rows each
    // to stay well within that limit and reduce per-write memory pressure.
    const CHUNK_SIZE = 2000;
    const chunks = [];
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      chunks.push(rows.slice(i, i + CHUNK_SIZE));
    }

    // Write each chunk separately, then write an index so the reader
    // knows how many chunks to expect
    for (let i = 0; i < chunks.length; i++) {
      await kv.put(
        `${CACHE_KEY}:chunk:${i}`,
        JSON.stringify(chunks[i]),
        { expirationTtl: CACHE_TTL_SECONDS }
      );
    }

    // Write the index last — the reader uses this to know the cache is ready
    await kv.put(
      `${CACHE_KEY}:index`,
      JSON.stringify({ chunks: chunks.length, totalRows: rows.length, cachedAt: new Date().toISOString() }),
      { expirationTtl: CACHE_TTL_SECONDS }
    );

    const elapsed = Date.now() - startTime;
    const result = {
      success: true,
      rowsCached: rows.length,
      chunks: chunks.length,
      elapsedMs: elapsed,
      cachedAt: new Date().toISOString()
    };

    console.log('Gigsberg cache refresh complete:', JSON.stringify(result));
    return result;

  } catch (err) {
    console.error('Gigsberg cache refresh error:', err);
    return { success: false, error: String(err) };
  }
}

// ===========================
// Stream-based CSV parser
// Reads the decompressed stream in text chunks, splits on newlines,
// and emits one parsed row object at a time — never holds the full
// CSV text or all rows in memory simultaneously.
// ===========================

async function parseCsvStream(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const rows = [];

  let buffer = '';
  let isFirstLine = true;
  let skipped = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode this chunk and append to our line buffer
      buffer += decoder.decode(value, { stream: true });

      // Process all complete lines in the buffer, respecting quoted fields
      // that may contain embedded newlines
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
            continue;
          }

          if (!line.trim()) continue;

          const fields = parseCsvLine(line);
          if (fields.length < COLUMNS.length - 5) { skipped++; continue; }

          const row = {};
          COLUMNS.forEach((col, i) => { row[col] = fields[i] ?? ''; });

          const category = [
            row.merchant_category,
            row.category_name,
            row.merchant_product_category_path
          ].join(' ').toLowerCase();

          const isTicketLike =
            /ticket|event|concert|festival|theatre|theater|sport|gig|show|match|tour|comedy/.test(category);

          const inStock = row.in_stock?.toLowerCase();
          const forSale = row.is_for_sale?.toLowerCase();
          const isAvailable =
            inStock !== 'false' && inStock !== '0' &&
            forSale !== 'false' && forSale !== '0';

          const price = parsePrice(row.display_price || row.search_price || row.store_price);

          if (isTicketLike && isAvailable && price !== null) {
            rows.push({
              product_name:      row.product_name,
              aw_deep_link:      row.aw_deep_link,
              display_price:     row.display_price,
              search_price:      row.search_price,
              store_price:       row.store_price,
              currency:          row.currency,
              merchant_category: row.merchant_category,
              category_name:     row.category_name,
              last_updated:      row.last_updated
            });
          }
        }
      }

      // Keep only the unprocessed remainder in the buffer
      buffer = buffer.slice(searchFrom);
    }

    // Process any remaining partial line in the buffer
    if (buffer.trim() && !isFirstLine) {
      const fields = parseCsvLine(buffer.trim());
      if (fields.length >= COLUMNS.length - 5) {
        const row = {};
        COLUMNS.forEach((col, i) => { row[col] = fields[i] ?? ''; });
        const price = parsePrice(row.display_price || row.search_price || row.store_price);
        if (price !== null) {
          rows.push({
            product_name:  row.product_name,
            aw_deep_link:  row.aw_deep_link,
            display_price: row.display_price,
            search_price:  row.search_price,
            store_price:   row.store_price,
            currency:      row.currency,
            merchant_category: row.merchant_category,
            category_name: row.category_name,
            last_updated:  row.last_updated
          });
        }
      }
    }

  } finally {
    reader.releaseLock();
  }

  console.log(`Stream parse complete: ${rows.length} rows kept, ${skipped} skipped`);
  return { rows, skipped };
}

// ===========================
// CSV parsing
// Handles quoted fields containing embedded commas and newlines.
// Only keeps rows that look like ticket/event listings.
// ===========================

function parseCsv(text) {
  const lines = splitCsvLines(text);
  if (lines.length < 2) return [];

  // Skip header row (line 0) — we rely on the known COLUMNS order
  const dataLines = lines.slice(1);
  const rows = [];
  let skipped = 0;

  for (const line of dataLines) {
    if (!line.trim()) continue;

    const fields = parseCsvLine(line);

    // Tolerate small mismatches in field count (trailing empty fields
    // are common in Awin feeds)
    if (fields.length < COLUMNS.length - 5) {
      skipped++;
      continue;
    }

    const row = {};
    COLUMNS.forEach((col, i) => { row[col] = fields[i] ?? ''; });

    // Pre-filter to ticket/event-like rows only
    const category = [
      row.merchant_category,
      row.category_name,
      row.merchant_product_category_path
    ].join(' ').toLowerCase();

    const isTicketLike =
      /ticket|event|concert|festival|theatre|theater|sport|gig|show|match|tour|comedy/.test(category);

    // Keep only in-stock, for-sale rows
    const inStock = row.in_stock?.toLowerCase();
    const forSale = row.is_for_sale?.toLowerCase();
    const isAvailable =
      inStock !== 'false' && inStock !== '0' &&
      forSale !== 'false' && forSale !== '0';

    // Only keep rows with a usable price
    const hasPrice = parsePrice(
      row.display_price || row.search_price || row.store_price
    ) !== null;

    if (isTicketLike && isAvailable && hasPrice) {
      // Store only the fields the /api/gigsberg Function actually needs
      // to keep KV storage and read times minimal
      rows.push({
        product_name:     row.product_name,
        aw_deep_link:     row.aw_deep_link,
        display_price:    row.display_price,
        search_price:     row.search_price,
        store_price:      row.store_price,
        currency:         row.currency,
        merchant_category: row.merchant_category,
        category_name:    row.category_name,
        last_updated:     row.last_updated
      });
    }
  }

  console.log(`CSV parse complete: ${rows.length} rows kept, ${skipped} skipped`);
  return rows;
}

function parsePrice(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) || num <= 0 ? null : num;
}

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
        i++;
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