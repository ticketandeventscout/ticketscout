// ===========================
// TicketScout — Awin category feed cache Worker
// Runs as a Cloudflare Pages Function at /api/awin-category-cache
//
// Fetches the Awin Entertainment/Tickets category feed (categories 586,
// 588, 590, 592) which covers all approved Awin merchants in one feed.
// Currently includes: Gigsberg UK, Theatre Tickets Direct, Football TicketNet UK.
// New approved merchants appear automatically with no code changes needed.
//
// Feed format: standard columnar CSV (73 columns), gzip compressed.
// Awin serves Content-Type: application/gzip without Content-Encoding
// so we manually pipe through DecompressionStream.
//
// Cron: triggered every 6 hours by cron-job.org
//   → https://ticketscout.co.uk/api/awin-category-cache?trigger=1
//
// NEW: During the parse loop, artist and venue names are extracted and
// written to KV as a pending discovery queue (autodiscover:awin:pending).
// The discover-pages?phase=commit job then commits those to GitHub.
// This means Awin discovery scales infinitely — no separate cron jobs
// per chunk needed, and no timeout risk from GitHub API calls.
//
// Required env vars:
//   AWIN_CATEGORY_FEED_URL  — full Awin category feed URL (Secret)
//   GIGSBERG_KV             — KV namespace binding
// ===========================

const CACHE_KEY        = 'awin:category:latest';
const PENDING_KEY      = 'autodiscover:awin:pending';
const KNOWN_KEY        = 'autodiscover:artists:known';
const KNOWN_VENUES_KEY = 'autodiscover:venues:known';
const CACHE_TTL        = 30 * 24 * 60 * 60; // 30 days — long TTL prevents 502 on missed cron runs
const PENDING_TTL      = 8 * 60 * 60;  // 8 hours — expires after commit job runs
const CHUNK_SIZE       = 2000;

const TRIBUTE_KEYWORDS = [
  'tribute', 'salute', 'legacy', 'experience', 'revival', 'forever',
  'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs ',
  'greatest hits', 'live band', 'orchestra plays', 'ultimate'
];

const GENERIC_NAMES = new Set([
  'nfl', 'nba', 'nhl', 'mlb', 'mls', 'ufc', 'wwe', 'pga', 'nascar',
  'premier league', 'champions league', 'europa league', 'la liga',
  'serie a', 'bundesliga', 'ligue 1', 'formula 1', 'formula one'
]);

// LEGACY column indices (0-based) — 86-column Awin feed format.
// Used only as a FALLBACK when a header name isn't found. The live map is
// built from the feed's own header row on every refresh (ACTIVE_COL below),
// which makes column re-ordering (the 44→49 in_stock drift) harmless.
const COL = {
  aw_deep_link:        0,
  product_name:        1,
  aw_product_id:       2,
  merchant_product_id: 3,
  merchant_image_url:  4,   // primary merchant image URL
  description:         5,
  merchant_category:   6,
  search_price:        7,
  merchant_name:       8,
  merchant_id:         9,
  category_name:       10,
  aw_image_url:        12,  // Awin image URL
  currency:            13,
  store_price:         14,
  display_price:       19,
  in_stock:            49,  // shifted from 44 in new feed
  is_for_sale:         53,  // shifted from 48 in new feed
  merchant_thumb_url:  59,
  large_image:         60,  // largest available image
  aw_thumb_url:        62,
};

// Live column map — starts as the legacy defaults, overwritten per refresh
// from the feed's actual header row.
let ACTIVE_COL = { ...COL };

function buildColMapFromHeader(headerLine) {
  const names = parseCsvLine(headerLine).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (...aliases) => {
    for (const a of aliases) {
      const i = names.indexOf(a);
      if (i !== -1) return i;
    }
    return -1;
  };
  const mapped = {
    aw_deep_link:        find('awdeeplink', 'deeplink'),
    product_name:        find('productname'),
    aw_product_id:       find('awproductid'),
    merchant_product_id: find('merchantproductid'),
    merchant_image_url:  find('merchantimageurl'),
    description:         find('description', 'productshortdescription'),
    merchant_category:   find('merchantcategory'),
    search_price:        find('searchprice'),
    merchant_name:       find('merchantname'),
    merchant_id:         find('merchantid'),
    category_name:       find('categoryname'),
    aw_image_url:        find('awimageurl'),
    currency:            find('currency'),
    store_price:         find('storeprice'),
    display_price:       find('displayprice'),
    in_stock:            find('instock'),
    is_for_sale:         find('isforsale'),
    merchant_thumb_url:  find('merchantthumburl'),
    large_image:         find('largeimage'),
    aw_thumb_url:        find('awthumburl'),
  };
  // Any name not found in the header falls back to the legacy index
  let fromHeader = 0;
  for (const key of Object.keys(mapped)) {
    if (mapped[key] === -1) mapped[key] = COL[key];
    else fromHeader++;
  }
  return { map: mapped, fromHeader, totalCols: names.length };
}

// ── Feed-ID management ──────────────────────────────────────────────────────
// Feed IDs live in KV (awin:feed:ids). The download URL is rebuilt on every
// refresh by splicing the KV list into the /fid/.../ segment of the base URL
// (AWIN_CATEGORY_FEED_URL secret keeps the apikey + column selection).
// Adding a new advertiser = one URL visit — no code changes ever again:
//   ?trigger=1&feeds=discover          — list every feed available on your Awin account
//   ?trigger=1&feeds=list              — show currently enabled feed IDs
//   ?trigger=1&feeds=add&id=12345      — enable a feed (included from next refresh)
//   ?trigger=1&feeds=remove&id=12345   — disable a feed
const FEED_IDS_KEY = 'awin:feed:ids';

async function getFeedIds(kv, env) {
  try {
    const raw = await kv.get(FEED_IDS_KEY);
    if (raw) { const ids = JSON.parse(raw); if (Array.isArray(ids) && ids.length) return ids; }
  } catch {}
  // First run: seed KV from the /fid/.../ segment of the env URL
  const m = (env.AWIN_CATEGORY_FEED_URL || '').match(/\/fid\/([0-9,]+)\//);
  const seeded = m ? m[1].split(',').filter(Boolean) : [];
  if (seeded.length) { try { await kv.put(FEED_IDS_KEY, JSON.stringify(seeded)); } catch {} }
  return seeded;
}

function buildFeedUrl(baseUrl, ids) {
  return baseUrl.replace(/\/fid\/[0-9,]*\//, `/fid/${ids.join(',')}/`);
}

function extractApiKey(baseUrl) {
  const m = (baseUrl || '').match(/\/apikey\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return new Response(
      'Add ?trigger=1 to manually run the cache refresh.\n' +
      'Add ?trigger=1&debug=1 to inspect raw column positions.\n' +
      'Feed management:\n' +
      '  ?trigger=1&feeds=discover        — list all feeds available on your Awin account\n' +
      '  ?trigger=1&feeds=list            — show enabled feed IDs\n' +
      '  ?trigger=1&feeds=add&id=NNNNN    — enable a feed\n' +
      '  ?trigger=1&feeds=remove&id=NNNNN — disable a feed', {
      status: 200, headers: { 'Content-Type': 'text/plain' }
    });
  }

  // ── Feed management endpoints ────────────────────────────────────────────
  const feedsCmd = url.searchParams.get('feeds');
  if (feedsCmd) {
    const kv = env.GIGSBERG_KV;
    if (!kv) return jsonResp({ error: 'Missing GIGSBERG_KV binding' }, 500);
    const ids = await getFeedIds(kv, env);

    if (feedsCmd === 'list') {
      return jsonResp({
        enabledFeedIds: ids,
        downloadUrlPreview: buildFeedUrl(env.AWIN_CATEGORY_FEED_URL || '', ids)
          .replace(/apikey\/[a-f0-9]+/i, 'apikey/•••'),
        note: 'These feed IDs are spliced into the download URL on every refresh.'
      }, 200);
    }

    if (feedsCmd === 'add' || feedsCmd === 'remove') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!/^\d+$/.test(id)) return jsonResp({ error: 'Provide a numeric feed ID: &id=12345' }, 400);
      let updated;
      if (feedsCmd === 'add') {
        if (ids.includes(id)) return jsonResp({ message: `Feed ${id} is already enabled.`, enabledFeedIds: ids }, 200);
        updated = [...ids, id];
      } else {
        if (!ids.includes(id)) return jsonResp({ message: `Feed ${id} was not enabled.`, enabledFeedIds: ids }, 200);
        updated = ids.filter(x => x !== id);
        if (updated.length === 0) return jsonResp({ error: 'Refusing to remove the last feed ID.' }, 400);
      }
      await kv.put(FEED_IDS_KEY, JSON.stringify(updated));
      return jsonResp({
        message: `Feed ${id} ${feedsCmd === 'add' ? 'enabled' : 'disabled'}. Takes effect on the next cache refresh.`,
        enabledFeedIds: updated,
        nextStep: feedsCmd === 'add' ? 'Run ?trigger=1 now to refresh the cache including the new feed.' : null
      }, 200);
    }

    if (feedsCmd === 'discover') {
      // Awin's feed-list endpoint: every feed your account can access,
      // including advertisers you've just been accepted by (e.g. Eventim).
      const apiKey = extractApiKey(env.AWIN_CATEGORY_FEED_URL);
      if (!apiKey) return jsonResp({ error: 'Could not extract apikey from AWIN_CATEGORY_FEED_URL' }, 500);
      try {
        const listResp = await fetch(`https://productdata.awin.com/datafeed/list/apikey/${apiKey}/`);
        if (!listResp.ok) return jsonResp({ error: `Awin feed list HTTP ${listResp.status}` }, 502);
        const csv = await listResp.text();
        const lines = csv.split('\n').filter(l => l.trim());
        if (lines.length < 2) return jsonResp({ error: 'Feed list came back empty.' }, 502);

        const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const iAdvId   = header.findIndex(h => h.includes('advertiserid'));
        const iAdvName = header.findIndex(h => h.includes('advertisername'));
        const iFeedId  = header.findIndex(h => h === 'feedid' || h.includes('feedid'));
        const iStatus  = header.findIndex(h => h.includes('membership'));
        const iCount   = header.findIndex(h => h.includes('noofproducts') || h.includes('products'));

        const feeds = lines.slice(1).map(l => {
          const f = parseCsvLine(l);
          return {
            advertiserId:   iAdvId   !== -1 ? f[iAdvId]   : '',
            advertiserName: iAdvName !== -1 ? f[iAdvName] : '',
            feedId:         iFeedId  !== -1 ? f[iFeedId]  : '',
            membership:     iStatus  !== -1 ? f[iStatus]  : '',
            products:       iCount   !== -1 ? f[iCount]   : '',
            enabled:        iFeedId  !== -1 && ids.includes(f[iFeedId])
          };
        }).filter(f => f.feedId);

        return jsonResp({
          message: 'All feeds available on your Awin account. To enable one: ?trigger=1&feeds=add&id={feedId}',
          enabledFeedIds: ids,
          feeds
        }, 200);
      } catch (err) {
        return jsonResp({ error: `Feed discovery failed: ${err}` }, 502);
      }
    }

    return jsonResp({ error: `Unknown feeds command '${feedsCmd}' — use discover | list | add | remove` }, 400);
  }

  // Debug mode — fetches first few rows and shows all column values
  // so we can identify which columns hold which data in the current feed
  if (url.searchParams.get('debug') === '1') {
    const feedUrl = env.AWIN_CATEGORY_FEED_URL;
    if (!feedUrl) return new Response(JSON.stringify({ error: 'Missing AWIN_CATEGORY_FEED_URL' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    const response = await fetch(feedUrl);
    if (!response.ok) return new Response(JSON.stringify({ error: `HTTP ${response.status}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    const stream  = response.body.pipeThrough(new DecompressionStream('gzip'));
    const decoder = new TextDecoder();
    const reader  = stream.getReader();

    let buffer = '';
    let headers = null;
    let sampleRows = [];
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
          const fields = parseCsvLine(line);
          // Show first 5 rows with column index → value mapping
          const mapped = {};
          fields.forEach((v, i) => { if (v.trim()) mapped[`col${i}_${headers?.[i] || 'unknown'}`] = v.trim().slice(0, 80); });
          sampleRows.push({ fieldCount: fields.length, columns: mapped });
          if (sampleRows.length >= 3) break outer;
        }
      }
      buffer = buffer.slice(searchFrom);
    }
    reader.releaseLock();

    return new Response(JSON.stringify({ headers: headers?.map((h, i) => `${i}: ${h}`), sampleRows }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const result = await refreshCache(env);
  return new Response(JSON.stringify(result), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

async function refreshCache(env) {
  const baseUrl = env.AWIN_CATEGORY_FEED_URL;
  if (!baseUrl) return { success: false, error: 'Missing AWIN_CATEGORY_FEED_URL' };

  const kv = env.GIGSBERG_KV;
  if (!kv) return { success: false, error: 'Missing GIGSBERG_KV binding' };

  // Build the download URL from the KV feed-ID list (add advertisers via
  // ?trigger=1&feeds=add&id=NNNNN — no code or secret changes needed)
  const feedIds = await getFeedIds(kv, env);
  if (feedIds.length === 0) return { success: false, error: 'No feed IDs configured — run ?trigger=1&feeds=discover' };
  const feedUrl = buildFeedUrl(baseUrl, feedIds);
  console.log(`Awin refresh with ${feedIds.length} feeds: ${feedIds.join(',')}`);

  const startTime = Date.now();
  console.log('Awin category cache refresh started');

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };

    // Load known artists and venues so we only queue genuinely new ones
    let knownArtists = new Set();
    let knownVenues  = new Set();
    try { const k = await kv.get(KNOWN_KEY);        if (k)  knownArtists = new Set(JSON.parse(k)); } catch {}
    try { const k = await kv.get(KNOWN_VENUES_KEY); if (k)  knownVenues  = new Set(JSON.parse(k)); } catch {}

    // Parse the feed stream — discovers artists/venues as rows stream through
    const decompressedStream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const { rows, skipped, merchants, newArtists, newVenues } =
      await parseFeedStream(decompressedStream, knownArtists, knownVenues);

    console.log(`Parsed: ${rows.length} rows, ${skipped} skipped, ${newArtists.length} new artists, ${newVenues.length} new venues`);

    if (rows.length === 0) {
      try { await kv.put('feed:health:awin', JSON.stringify({
        status: 'zero_rows', at: new Date().toISOString(), skipped })); } catch {}
      return { success: false, error: 'Zero rows parsed — old cache preserved', skipped };
    }

    // ── Schema sentinel: sanity-check the first parsed row ────────────────
    const sentinel = rows[0];
    const priceOk    = typeof sentinel.price === 'number' && sentinel.price > 0 && sentinel.price < 100000;
    const merchantOk = typeof sentinel.merchant_name === 'string'
                    && sentinel.merchant_name.length > 1
                    && !/^\d+(\.\d+)?$/.test(sentinel.merchant_name);
    if (!priceOk || !merchantOk) {
      try { await kv.put('feed:health:awin', JSON.stringify({
        status: 'schema_drift', at: new Date().toISOString(),
        sample: { price: sentinel.price, merchant_name: sentinel.merchant_name, name: sentinel.name }
      })); } catch {}
      return {
        success: false,
        error: 'SCHEMA SENTINEL TRIPPED — first row looks wrong (price or merchant misaligned). ' +
               'Refresh aborted, old cache preserved. Run ?trigger=1&debug=1 to inspect columns.',
        sample: { price: sentinel.price, merchant_name: sentinel.merchant_name }
      };
    }
    try { await kv.put('feed:health:awin', JSON.stringify({
      status: 'ok', at: new Date().toISOString(), rows: rows.length })); } catch {}

    // Write event rows to KV in chunks (for comparison block use)
    const chunks = [];
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      chunks.push(rows.slice(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
      await kv.put(`${CACHE_KEY}:chunk:${i}`, JSON.stringify(chunks[i]), { expirationTtl: CACHE_TTL });
    }
    await kv.put(`${CACHE_KEY}:index`, JSON.stringify({
      chunks: chunks.length, totalRows: rows.length, merchants,
      cachedAt: new Date().toISOString()
    }), { expirationTtl: CACHE_TTL });

    // Write newly discovered artists/venues to pending queue for commit job
    if (newArtists.length > 0 || newVenues.length > 0) {
      // Merge with any existing pending items from other sources
      let existingPending = { artists: [], venues: [] };
      try {
        const ep = await kv.get(PENDING_KEY);
        if (ep) existingPending = JSON.parse(ep);
      } catch {}

      const mergedArtists = [...existingPending.artists, ...newArtists];
      const mergedVenues  = [...existingPending.venues,  ...newVenues];

      await kv.put(PENDING_KEY, JSON.stringify({
        artists:   mergedArtists,
        venues:    mergedVenues,
        updatedAt: new Date().toISOString()
      }), { expirationTtl: PENDING_TTL });

      console.log(`Queued ${newArtists.length} new artists and ${newVenues.length} new venues for commit`);
    }

    return {
      success:     true,
      rowsCached:  rows.length,
      chunks:      chunks.length,
      skipped,
      merchants,
      newArtists:  newArtists.length,
      newVenues:   newVenues.length,
      elapsedMs:   Date.now() - startTime,
      cachedAt:    new Date().toISOString(),
      sampleRow:   rows[0] || null
    };

  } catch (err) {
    console.error('Awin category cache error:', err);
    return { success: false, error: String(err) };
  }
}

// ===========================
// Stream parser
// Processes one CSV line at a time — never holds full feed in memory.
// Simultaneously extracts new artist/venue names for page discovery.
// ===========================

async function parseFeedStream(stream, knownArtists, knownVenues) {
  const decoder = new TextDecoder();
  const reader  = stream.getReader();
  const rows    = [];
  const merchantCounts = {};
  const newArtistMap   = new Map(); // slug → artist data
  const newVenueMap    = new Map(); // slug → venue data

  let buffer     = '';
  let isFirstLine = true;
  let skipped    = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let searchFrom = 0;
      let inQuotes   = false;

      for (let ci = 0; ci < buffer.length; ci++) {
        const ch = buffer[ci];
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === '\n' && !inQuotes) {
          const line = buffer.slice(searchFrom, ci).replace(/\r$/, '');
          searchFrom = ci + 1;

          if (isFirstLine) {
            isFirstLine = false;
            // Build the live column map from the feed's own header row
            try {
              const built = buildColMapFromHeader(line);
              ACTIVE_COL = built.map;
              console.log(`Awin header parsed: ${built.fromHeader} columns mapped by name of ${built.totalCols} total`);
            } catch (e) {
              ACTIVE_COL = { ...COL };
              console.error('Header parse failed — using legacy column indices:', e);
            }
            continue;
          }
          if (!line.trim()) continue;

          const row = parseRow(line);
          if (row) {
            rows.push(row);
            merchantCounts[row.merchant_name] = (merchantCounts[row.merchant_name] || 0) + 1;

            // ── Discovery: extract artist name ─────────────────────────────
            const artistName = row.primary_artist || row.product_name || '';
            if (isValidName(artistName) && !isTribute(artistName)) {
              const slug = toSlug(artistName);
              if (slug && !knownArtists.has(slug) && !newArtistMap.has(slug)) {
                const genre    = awinGenre(row.merchant_category, row.category_name);
                const category = genreToCategory(genre);
                newArtistMap.set(slug, {
                  slug, name: artistName, search: artistName,
                  genre, category,
                  description: generateArtistDescription(artistName, genre),
                  image_url: row.image_url || '',
                  source: `awin:${row.merchant_name}`
                });
              }
            }

            // ── Discovery: extract venue name ──────────────────────────────
            const venueName = row.venue_name || '';
            if (venueName && venueName.length > 3) {
              const slug = toSlug(venueName);
              if (slug && !knownVenues.has(slug) && !newVenueMap.has(slug)) {
                newVenueMap.set(slug, {
                  slug, name: venueName,
                  city: row.event_city || '',
                  country: row.event_country || 'GB',
                  venueId: '',
                  description: generateVenueDescription(venueName, row.event_city || '', ''),
                  source: `awin:${row.merchant_name}`
                });
              }
            }
          } else {
            skipped++;
          }
        }
      }
      buffer = buffer.slice(searchFrom);
    }

    if (buffer.trim() && !isFirstLine) {
      const row = parseRow(buffer.trim());
      if (row) { rows.push(row); merchantCounts[row.merchant_name] = (merchantCounts[row.merchant_name] || 0) + 1; }
    }

  } finally {
    reader.releaseLock();
  }

  return {
    rows, skipped,
    merchants:  merchantCounts,
    newArtists: [...newArtistMap.values()],
    newVenues:  [...newVenueMap.values()]
  };
}

// ===========================
// Row parser (unchanged from before)
// ===========================

function parseRow(line) {
  const fields = parseCsvLine(line);
  if (fields.length < 20) return null; // 86-column feed — reject anything too short

  const price = parsePrice(
    fields[ACTIVE_COL.search_price] || fields[ACTIVE_COL.display_price] ||
    fields[ACTIVE_COL.store_price]  || fields[ACTIVE_COL.min_price]
  );
  if (!price) return null;

  const productName = (fields[ACTIVE_COL.product_name] || '').trim();
  const awDeepLink  = (fields[ACTIVE_COL.aw_deep_link]  || '').trim();
  if (!productName || !awDeepLink) return null;

  // Only apply in_stock/is_for_sale check for 86-column feeds (Gigsberg format).
  // Football TicketNet UK uses 60 columns — COL indices 49 and 53 point at
  // unrelated data in their format, causing all their rows to be incorrectly dropped.
  if (fields.length >= 55) {
    const inStock = fields[ACTIVE_COL.in_stock];
    const forSale = fields[ACTIVE_COL.is_for_sale];
    if (inStock === '0' || inStock === 'false' || forSale === '0' || forSale === 'false') return null;
  }

  const merchantName = (fields[ACTIVE_COL.merchant_name] || '').trim();
  const safeGet = (idx) => (idx < fields.length ? (fields[idx] || '').trim() : '');

  return {
    product_name:      productName,
    aw_deep_link:      awDeepLink,
    // Image — prefer large_image, fall back to merchant_image_url, then aw_image_url
    image_url:         safeGet(ACTIVE_COL.large_image) || safeGet(ACTIVE_COL.merchant_image_url) || safeGet(ACTIVE_COL.aw_image_url),
    price,
    currency:          safeGet(ACTIVE_COL.currency) || 'GBP',
    merchant_name:     merchantName,
    merchant_id:       safeGet(ACTIVE_COL.merchant_id),
    category_name:     safeGet(ACTIVE_COL.category_name),
    merchant_category: safeGet(ACTIVE_COL.merchant_category),
    description:       safeGet(ACTIVE_COL.description).slice(0, 300),
    // Ticket-specific fields no longer present in 67-column feed
    // Date/venue extracted from description field by awin-category.js
    primary_artist:    '',
    event_name:        '',
    venue_name:        '',
    event_date:        '',
    event_city:        '',
    event_country:     '',
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
      fields.push(current); current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// ===========================
// Discovery helpers
// ===========================

function toSlug(name) {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function isValidName(name) {
  if (!name || name.length < 3) return false;
  const slug = toSlug(name);
  if (/^\d+$/.test(slug)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  return true;
}

function isTribute(name) {
  const lower = (name || '').toLowerCase();
  return TRIBUTE_KEYWORDS.some(kw => lower.includes(kw));
}

function awinGenre(merchantCategory, categoryName) {
  const cat = ((merchantCategory || '') + ' ' + (categoryName || '')).toLowerCase();
  if (cat.includes('football') || cat.includes('soccer')) return 'Football';
  if (cat.includes('concert') || cat.includes('music'))   return 'Live Music';
  if (cat.includes('theatre') || cat.includes('musical')) return 'Theatre';
  if (cat.includes('comedy'))  return 'Comedy';
  if (cat.includes('sport'))   return 'Sports';
  return 'Live Events';
}

/**
 * Maps a genre string to a page category folder.
 * Must stay in sync with the copy in discover-pages.js.
 */
function genreToCategory(genre) {
  const g = (genre || '').toLowerCase();
  if (g.includes('football') || g.includes('soccer')) return 'football';
  if (g.includes('theatre') || g.includes('musical') || g.includes('opera') || g.includes('ballet')) return 'theatre';
  return 'concert';
}

function generateArtistDescription(name, genre) {
  const g = genre.toLowerCase();
  if (g.includes('theatre') || g.includes('musical')) {
    return `${name} is a celebrated production known for its captivating performances and widespread critical acclaim. Compare ticket prices across verified sellers on TicketScout.`;
  }
  if (g.includes('football')) {
    return `${name} are a professional football club with a passionate global fanbase. Compare ticket prices for upcoming matches across verified sellers on TicketScout.`;
  }
  return `${name} are a renowned ${genre} act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.`;
}

function generateVenueDescription(name, city, country) {
  const location = city || country || 'the UK';
  return `${name} is one of ${location}'s premier live event venues. Compare ticket prices from verified sellers for all upcoming events at ${name} on TicketScout.`;
}

function jsonResp(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
