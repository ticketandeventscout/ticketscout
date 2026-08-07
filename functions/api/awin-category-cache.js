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

  // ── M4 cleanup: already-indexed junk product pages ──────────────────────
  // The forward-looking filter (isJunkProduct(), see tsBulkSyncAwinEvents
  // above) stops NEW junk from registering, but doesn't touch what's
  // already sitting in event_pages from before the filter existed — the
  // roadmap's own count was six such pages, confirmed live with full Event
  // schema + offers. Same isJunkProduct() check, applied here against
  // EXISTING event_pages.name. Dry-run by default, same convention as
  // every other write tool in this codebase (duplicate-events.js's merge
  // mode, ticketmaster.js's ?sweep=1, etc.) — DELETES rather than a
  // separate noindex flag, since event_pages has no per-row indexability
  // column and a product listing that isn't a real ticketed event
  // shouldn't have a page at all, not just a hidden one.
  // Usage: ?cleanjunk=1&trigger=1                — dry run, reports matches
  //        ?cleanjunk=1&trigger=1&confirm=yes    — deletes them
  if (url.searchParams.get('cleanjunk') === '1' && url.searchParams.get('trigger') === '1') {
    const db = env.PRICE_DB;
    if (!db) return jsonResp({ error: 'Missing PRICE_DB' }, 500);
    const confirm = url.searchParams.get('confirm') === 'yes';
    try {
      const rows = await db.prepare(
        "SELECT slug, category, name, event_date, venue, source FROM event_pages WHERE source LIKE 'awin:%'"
      ).all();
      const matches = (rows.results || []).filter(r => isJunkProduct(r.name));
      if (confirm && matches.length) {
        const stmt = db.prepare('DELETE FROM event_pages WHERE slug = ?1');
        await db.batch(matches.map(m => stmt.bind(m.slug)));
      }
      return jsonResp({
        cleanjunk: true, dryRun: !confirm,
        totalAwinRowsScanned: (rows.results || []).length,
        junkFound: matches.length,
        matches: matches.map(m => ({ slug: m.slug, name: m.name, category: m.category, date: m.event_date, venue: m.venue })),
        message: confirm
          ? `Deleted ${matches.length} junk product page(s).`
          : 'Dry run — nothing deleted. Add &confirm=yes to remove these.'
      }, 200);
    } catch (e) {
      return jsonResp({ error: 'cleanjunk failed: ' + String(e) }, 500);
    }
  }

  // ── Diagnostic: search the LIVE cached chunks by name (before trigger gate
  //    so ?find=arsenal works standalone with no refresh) ───────────────────
  // ?find=arsenal                                   — product_name OR description
  // ?find=arsenal&merchant=Football TicketNet UK    — also filter by merchant
  {
    const findTerm = (url.searchParams.get('find') || '').toLowerCase().trim();
    if (findTerm) {
      const kv = env.GIGSBERG_KV;
      if (!kv) return jsonResp({ error: 'Missing GIGSBERG_KV binding' }, 500);
      const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });
      if (!index?.chunks) return jsonResp({ error: 'No cache index — run ?trigger=1 first' }, 200);
      const merchantFilter = (url.searchParams.get('merchant') || '').toLowerCase().trim();
      const hits = [];
      const merchantTally = {};
      let scanned = 0;
      // Same latency fix as awin-category.js's live read path (6 Aug 2026)
      // — fetch all chunks concurrently instead of one at a time, then scan
      // them in a second pass. This endpoint is manual/debug-only so it was
      // never the reported hot-path latency, but it's the identical bug and
      // trivial to fix for the same reason.
      const fetchedChunks = (await Promise.all(
        Array.from({ length: index.chunks }, (_, i) => kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' }))
      )).filter(Boolean);
      for (const chunk of fetchedChunks) {
        for (const row of chunk) {
          scanned++;
          const pn = (row.product_name || '').toLowerCase();
          const ds = (row.description  || '').toLowerCase();
          const inName = pn.includes(findTerm);
          const inDesc = ds.includes(findTerm);
          if (!inName && !inDesc) continue;
          if (merchantFilter && !(row.merchant_name || '').toLowerCase().includes(merchantFilter)) continue;
          merchantTally[row.merchant_name] = (merchantTally[row.merchant_name] || 0) + 1;
          if (hits.length < 25) hits.push({
            product_name: row.product_name,
            merchant: row.merchant_name,
            matchedIn: inName ? (inDesc ? 'name+desc' : 'name') : 'desc',
            price: row.price,
            category: row.merchant_category || row.category_name,
            descPreview: (row.description || '').slice(0, 120)
          });
        }
      }
      return jsonResp({
        query: findTerm,
        merchantFilter: merchantFilter || null,
        rowsScanned: scanned,
        totalMatches: Object.values(merchantTally).reduce((a, b) => a + b, 0),
        matchesByMerchant: merchantTally,
        sample: hits
      }, 200);
    }
  }

  if (url.searchParams.get('trigger') !== '1') {
    return new Response(
      'Add ?trigger=1 to manually run the cache refresh.\n' +
      'Add ?trigger=1&debug=1 to inspect raw column positions.\n' +
      'Add ?find=NAME to search the live cache by event name (no refresh).\n' +
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

    // ── Phase 1.4B: bulk event registry sync (once per ~20h) ──────────────
    // Registers every dated Awin row in the D1 events registry so
    // /event/{slug} pages and the event sitemap have full Awin coverage
    // without waiting for organic traffic. Gated to once daily (the cron
    // runs 4x/day) to stay well inside D1's 100k row-writes/day free tier.
    try {
      const eventSyncResult = await tsBulkSyncAwinEvents(env, kv, rows);
      if (eventSyncResult) console.log('Awin event registry sync:', JSON.stringify(eventSyncResult));
    } catch (e) {
      console.error('Awin event registry sync failed (non-fatal):', e);
    }

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

// Non-football sports genres get their own section. Before this existed
// every one of them fell through to 'concert' HERE specifically — this copy
// never received the fix that discover-pages.js's genreToCategory() got
// across three passes (24/25/31 Jul 2026), despite the "must stay in sync"
// comment below. Confirmed live 5 Aug 2026: rugby (Rugby World Cup
// semi-final), ice hockey (San Jose Sharks vs Toronto Maple Leafs,
// Nashville Predators vs Vancouver Canucks) and football (Everton vs
// Manchester City) were all being registered as /event/concert-... pages —
// each one ALSO existed correctly under /event/sports-.../football-...
// from a different discovery source (TM), so Google was crawling both.
// Kept as an exact copy of discover-pages.js's set — MUST stay in sync.
const SPORTS_GENRES = new Set([
  'basketball', 'mma', 'ice hockey', 'rugby', 'handball', 'american football',
  'baseball', 'boxing', 'tennis', 'cricket', 'motorsport', 'golf', 'wrestling',
  'darts', 'snooker', 'esports', 'horse racing', 'winter sports', 'volleyball',
  'sports', 'sport'
]);

function awinGenre(merchantCategory, categoryName) {
  const cat = ((merchantCategory || '') + ' ' + (categoryName || '')).toLowerCase();
  if (cat.includes('football') || cat.includes('soccer')) return 'Football';
  // Domestic/international football league & competition names — added
  // 6 Aug 2026 after a live unmatched batch showed EFL Championship/League
  // One, La Liga, Serie A, Bundesliga, Eredivisie, Primeira Liga, Ligue 1
  // and international fixtures (Netherlands vs Germany etc.) all landing in
  // 'Live Events' -> concert, because Awin's own category text names the
  // LEAGUE rather than the word "football"/"soccer" for these merchants.
  if (
    cat.includes('premier league') || cat.includes('championship') ||
    cat.includes('league one') || cat.includes('league two') ||
    cat.includes('efl') || cat.includes('la liga') || cat.includes('laliga') ||
    cat.includes('serie a') || cat.includes('serie b') ||
    cat.includes('bundesliga') || cat.includes('ligue 1') || cat.includes('ligue 2') ||
    cat.includes('eredivisie') || cat.includes('primeira liga') || cat.includes('liga portugal') ||
    cat.includes('uefa') || cat.includes('fifa') || cat.includes('world cup qualif') ||
    cat.includes('nations league') || cat.includes('international friendly')
  ) return 'Football';
  if (cat.includes('concert') || cat.includes('music'))   return 'Live Music';
  if (cat.includes('theatre') || cat.includes('musical')) return 'Theatre';
  if (cat.includes('comedy'))  return 'Comedy';
  if (cat.includes('sport'))   return 'Sports';
  // US pro sports league names — added alongside the football fix above,
  // same gap (league name instead of sport name in Awin's category text).
  if (
    cat.includes('wnba') || cat.includes('nba') || cat.includes('mlb') ||
    cat.includes('nfl') || cat.includes('nhl')
  ) return 'Sports';
  return 'Live Events';
}

/**
 * Maps a genre string to a page category folder.
 * Must stay in sync with the copy in discover-pages.js. (Fixed 5 Aug 2026 —
 * this copy was missing the SPORTS_GENRES check entirely; see comment above.
 * Theatre keyword list also widened to match discover-pages.js's copy, which
 * had picked up comedy/circus/drama/magic/etc. across the same three
 * passes this copy never got.)
 */
function genreToCategory(genre) {
  const g = (genre || '').toLowerCase().trim();
  if (SPORTS_GENRES.has(g)) return 'sports';
  if (g.includes('football') || g.includes('soccer')) return 'football';
  if (
    g.includes('theatre') || g.includes('musical') || g.includes('opera') ||
    g.includes('ballet')   || g.includes('comedy')  || g.includes('circus') ||
    g.includes('drama')    ||
    g.includes('magic')    || g.includes('illusion')|| g.includes('cabaret') ||
    g.includes('variety')  || g.includes('performance art') ||
    g.includes('podcast')  || g.includes('documentary') ||
    g.includes('psychics') || g.includes('mediums') || g.includes('hypnotist') ||
    g.includes('specialty') || g === 'family'
  ) return 'theatre';
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


// ===========================
// Phase 1.4B — bulk Awin event registry sync
// tsEventSlug/tsRegisterEvents are the shared registry block — identical
// copies live in ticketmaster.js / sportsevents365.js / awin-events.js,
// and tsEventSlug has a client copy in compare.js. FROZEN v1 slug format.
// ===========================

const EVENT_SYNC_GATE_KEY = 'event:sync:awin:last';
const EVENT_SYNC_MIN_GAP  = 20 * 60 * 60 * 1000; // 20h — once per day despite 4 daily crons

// M4 fix (6 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): Awin/Gigsberg feeds
// bundle non-ticket add-on products (parking passes, hospitality packages,
// gift cards, membership products) alongside real event tickets in the
// SAME feed structure — tsBulkSyncAwinEvents registered every dated row
// unconditionally, so six of these were confirmed live, indexed with full
// Event schema + offers, e.g. a parking pass presenting itself to Google as
// a ticketed event. Applied against row.product_name specifically (the
// literal Awin catalog SKU name), not free-form prose — this is a much
// safer surface for single-word matches than the EVENT_PATTERNS system
// above, whose own documented discipline warns against bare generic nouns
// precisely because THOSE match against real performer/team names. A
// product catalogue SKU literally titled "Emirates Stadium — Parking Pass"
// or "Arsenal FC Gift Card" doesn't carry that same collision risk.
const JUNK_PRODUCT_PATTERNS = [
  /\bgift[\s-]?card\b/i,
  /\bopen\s+training\b/i,
  /\bpremium\s+experience\b/i,
  /\bhospitality\b/i,
  /\bcamping\b/i,
  /\bparking\b/i,
  /\bmerchandise\b/i,
  /\bmembership\b/i,
];
function isJunkProduct(name) {
  const n = String(name || '');
  return JUNK_PRODUCT_PATTERNS.some(re => re.test(n));
}

async function tsBulkSyncAwinEvents(env, kv, rows) {
  if (!env.PRICE_DB) return { skipped: 'no PRICE_DB binding' };

  // Once-daily gate (1 KV read + 1 KV write per actual sync)
  try {
    const last = await kv.get(EVENT_SYNC_GATE_KEY);
    if (last && (Date.now() - Date.parse(last)) < EVENT_SYNC_MIN_GAP) {
      return { skipped: 'ran within last 20h' };
    }
  } catch {}

  const today = new Date().toISOString().slice(0, 10);

  // Build records: prefer the feed's structured columns (event_date,
  // venue_name, event_city — populated by the football feeds); fall back to
  // parsing the description in BOTH formats awin-events.js supports
  // (Date: yyyy-mm-dd AND Date: dd/mm/yyyy). Rows with no date in any form
  // (e.g. plain-prose theatre blurbs) genuinely can't form a dated page and
  // are skipped — they stay on their entity page instead.
  const extractSyncDate = (row) => {
    const col = (row.event_date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(col)) return col;
    const dmyCol = col.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dmyCol) return `${dmyCol[3]}-${dmyCol[2]}-${dmyCol[1]}`;
    const desc = row.description || '';
    const iso = desc.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
    if (iso) return iso[1];
    const dmy = desc.match(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    return '';
  };
  const bySlug = new Map();
  let junkSkipped = 0;
  for (const row of rows) {
    const desc = row.description || '';
    const date = extractSyncDate(row);
    if (!date || date < today) continue; // dateless/past rows can't have stable pages
    if (isJunkProduct(row.product_name)) { junkSkipped++; continue; } // M4: not a real ticketed event

    const category = genreToCategory(awinGenre(row.merchant_category, row.category_name));
    const slug = tsEventSlug(category, date, normaliseFixtureName(row.product_name));
    if (!slug) continue;

    const venueMatch = desc.match(/Venue:\s*([^,\n]+)/i);
    const rec = {
      slug, category, name: row.product_name, date,
      venue: (row.venue_name || '').trim() || (venueMatch ? venueMatch[1].trim() : null),
      city: (row.event_city || '').trim() || null,
      price: row.price ? Math.round(row.price) : null,
      currency: row.currency || 'GBP',
      tmUrl: null,
      image: row.image_url || null,
      source: 'awin:' + (row.merchant_name || 'awin')
    };
    const existing = bySlug.get(slug);
    if (!existing || (rec.price && (!existing.price || rec.price < existing.price))) {
      bySlug.set(slug, rec);
    }
  }

  const records = [...bySlug.values()];

  // Upsert in batches of 400 (tsRegisterEvents caps per call)
  let written = 0;
  for (let i = 0; i < records.length; i += 400) {
    await tsRegisterEvents(env, records.slice(i, i + 400));
    written += Math.min(400, records.length - i);
  }

  // Prune long-past events so the table and sitemap query stay lean
  let pruned = 0;
  try {
    const res = await env.PRICE_DB
      .prepare("DELETE FROM event_pages WHERE event_date < date('now', '-2 day')")
      .run();
    pruned = res?.meta?.changes || 0;
  } catch {}

  try { await kv.put(EVENT_SYNC_GATE_KEY, new Date().toISOString()); } catch {}

  return { totalRows: rows.length, uniqueEvents: records.length, upserted: written, pruned, junkSkipped };
}

// {category}-{yyyy-mm-dd}-{normalised-name} — MUST MATCH all other copies.
// H6: normalises a fixture/event NAME before it is turned into a slug, so
// that upstream feed variants of the SAME real-world fixture converge on
// the SAME /event/ slug instead of minting separate near-duplicate D1 rows
// and pages. Only affects the STRING PASSED TO tsEventSlug — the `name`
// field stored on the record for DISPLAY is untouched, so titles keep their
// full original wording (e.g. "Pre-Season Friendly: Arsenal vs Chelsea"
// still displays in full; only the slug collapses to the plain fixture).
//
// !! MUST MATCH !! identical copies in ticketmaster.js, sportsevents365.js,
// awin-events.js and awin-category-cache.js.
//
// Addresses three confirmed sources of duplicate /event/ URLs from the
// Session 16 audit (10 clusters / 20 URLs in one 28-day GSC export,
// splitting ~8.7% of event-page impressions across pairs):
//   1. Separator drift: "-v-" vs "-vs-" — TM/SE365/Awin don't agree.
//   2. Club legal-SUFFIX drift: "Celtic" vs "Celtic FC", "Chelsea" vs
//      "Chelsea F.C." (note "F.C." previously produced the token "f-c",
//      not a removal, since tsEventSlug just turns punctuation into hyphens).
//   3. Competition-prefix drift: "Pre-Season Friendly: Arsenal vs Chelsea"
//      vs plain "Arsenal vs Chelsea" for the identical fixture.
// Team ORDER drift (home/away swapped between sources, e.g.
// "liverpool-fc-v-wrexham-afc" vs "wrexham-vs-liverpool") is also handled
// below by sorting the two sides alphabetically for slug purposes only.
//
// DELIBERATELY NOT stripping suffixes as PREFIXES: the original audit
// listed "AC" as a strippable club-suffix token, but AC is the actual
// identity in club names like "AC Milan" or "SC Freiburg" — stripping it
// as a leading token would corrupt those to "Milan"/"Freiburg". Only
// TRAILING legal-form tokens are stripped (safe direction — no top-flight
// club's canonical identity is a trailing "FC"/"SK"/etc token).
//
// The competition-prefix list below is built from the exact duplicate
// clusters the audit found, NOT a speculative pattern guess — expand it
// only after confirming a new prefix in live data (see the H6 task-scope
// doc's Stage A before trusting an expanded list).
function normaliseFixtureName(name) {
  let n = String(name || '');

  // (3) Strip a known competition-prefix lead-in, e.g. "Pre-Season
  // Friendly: Arsenal vs Chelsea" -> "Arsenal vs Chelsea".
  const COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (const p of COMPETITION_PREFIXES) {
    const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  // Numbered prefixes ("Matchday 3: X vs Y", "Round of 16: X vs Y") aren't
  // fixed strings, so handled separately from the list above.
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');

  // (1) Separator drift: normalise every "v"/"vs" variant (with or without
  // a trailing dot, any surrounding spacing) to a single canonical " vs ".
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');

  // (2)+(order) Club legal-suffix drift + home/away order drift. Only
  // applies when the name splits cleanly into two "vs"-joined sides —
  // a no-op for concert/theatre single-act names.
  const stripSuffix = (side) => side
    .replace(/\./g, '')
    .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
    .trim();
  const parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    const sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort((a, b) => a.localeCompare(b));
    n = sides[0] + ' vs ' + sides[1];
  }

  return n.trim();
}

function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}

// Batched D1 upsert. updated_at only bumps when content actually changed —
// the sitemap uses it as lastmod, and fake lastmod trains Google to ignore it.
async function tsRegisterEvents(env, records) {
  const db = env.PRICE_DB;
  if (!db || !records || !records.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) ' +
    'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ' +
    'ON CONFLICT(slug) DO UPDATE SET ' +
    'name=excluded.name, ' +
    'venue=COALESCE(excluded.venue, event_pages.venue), ' +
    'city=COALESCE(excluded.city, event_pages.city), ' +
    'price=COALESCE(excluded.price, event_pages.price), ' +
    'currency=COALESCE(excluded.currency, event_pages.currency), ' +
    'tm_url=COALESCE(excluded.tm_url, event_pages.tm_url), ' +
    'image=COALESCE(excluded.image, event_pages.image), ' +
    'source=excluded.source, ' +
    'updated_at=CASE WHEN event_pages.name IS NOT excluded.name ' +
    'OR event_pages.venue IS NOT COALESCE(excluded.venue, event_pages.venue) ' +
    'OR event_pages.city IS NOT COALESCE(excluded.city, event_pages.city) ' +
    'OR event_pages.price IS NOT COALESCE(excluded.price, event_pages.price) ' +
    'THEN excluded.updated_at ELSE event_pages.updated_at END'
  );
  const seen = new Set();
  const batch = [];
  for (const r of records) {
    if (!r || !r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    batch.push(stmt.bind(
      r.slug, r.category, r.name, r.date,
      r.venue || null, r.city || null,
      r.price || null, r.currency || null,
      r.tmUrl || null, r.image || null,
      r.source || null, now
    ));
    if (batch.length >= 400) break; // per-call safety cap
  }
  if (batch.length) await db.batch(batch);
}