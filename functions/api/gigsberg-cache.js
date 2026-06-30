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

    // ── Step 2: Decompress and parse line by line ──────────────────────
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
      skipped,
      elapsedMs: elapsed,
      cachedAt: new Date().toISOString(),
      sampleRow: rows[0] || null  // include first row so we can verify field mapping
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
// The Awin feed for Gigsberg is NOT a standard columnar CSV.
// Each data row has exactly 3 fields:
//   1. aw_deep_link  — affiliate tracking URL
//   2. product_name  — performer name (e.g. "Metallica")
//   3. json_blob     — all other data as a JSON object with double-escaped quotes
//
// Example row:
//   https://www.awin1.com/pclick.php?p=123&a=2960641&m=102707,"Metallica","{""price"":""222.80"",""merchantCategory"":""Concert"",...}"
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

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines that are NOT inside a quoted field
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

          const row = parseGigsbergRow(line);
          if (row) {
            rows.push(row);
          } else {
            skipped++;
          }
        }
      }

      buffer = buffer.slice(searchFrom);
    }

    // Handle any remaining line in buffer
    if (buffer.trim() && !isFirstLine) {
      const row = parseGigsbergRow(buffer.trim());
      if (row) rows.push(row);
    }

  } finally {
    reader.releaseLock();
  }

  console.log(`Stream parse complete: ${rows.length} rows kept, ${skipped} skipped`);
  return { rows, skipped };
}

// Parses a single Gigsberg CSV row in the format:
// <aw_deep_link>,"<product_name>","<json_blob_with_doubled_quotes>"
// Returns a normalised row object or null if the row should be skipped.
function parseGigsbergRow(line) {
  // Split into 3 fields using the CSV parser
  const fields = parseCsvLine(line);
  if (fields.length < 3) return null;

  const awDeepLink   = fields[0].trim();
  const productName  = fields[1].trim();
  const jsonRaw      = fields[2].trim();

  if (!awDeepLink || !productName) return null;

  // The JSON blob uses doubled quotes for escaping (standard CSV quoting),
  // which parseCsvLine already unescapes — so jsonRaw should be valid JSON.
  let data = {};
  try {
    data = JSON.parse(jsonRaw);
  } catch (e) {
    // If JSON parse fails, try to extract just the price via regex as fallback
    const priceMatch = jsonRaw.match(/"price"\s*:\s*"([0-9.]+)"/);
    if (priceMatch) data = { price: priceMatch[1] };
  }

  const price = parsePrice(data.price || data.storePrice || data.rrpPrice);
  if (!price) return null;

  const category = (data.merchantCategory || data.normalisedMerchantCategory || '').toLowerCase();
  const isTicketLike =
    /ticket|event|concert|festival|theatre|theater|sport|gig|show|match|tour|comedy/.test(category)
    || category === ''; // include uncategorised rows — all Gigsberg products are tickets

  if (!isTicketLike) return null;

  // Availability — default to available if fields are missing
  const inStock = data.inStock;
  const forSale = data.isForSale;
  const isAvailable =
    inStock !== false && inStock !== 0 && inStock !== '0' &&
    forSale !== false && forSale !== 0 && forSale !== '0';

  if (!isAvailable) return null;

  return {
    product_name:      productName,
    aw_deep_link:      awDeepLink,
    display_price:     String(price),
    search_price:      String(price),
    store_price:       String(price),
    currency:          data.currency || 'GBP',
    merchant_category: data.merchantCategory || '',
    category_name:     data.networkCategory || '',
    last_updated:      data.validFrom || ''
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