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
const CACHE_TTL        = 7 * 60 * 60;  // 7 hours
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

// Column indices (0-based)
const COL = {
  aw_deep_link:      0,
  product_name:      1,
  aw_image_url:      2,  // product/event image URL
  merchant_name:     8,
  merchant_id:       9,
  category_name:     10,
  currency:          13,
  display_price:     19,
  search_price:      7,
  store_price:       14,
  in_stock:          44,
  is_for_sale:       48,
  merchant_category: 6,
  description:       5,
  primary_artist:    54,
  event_name:        57,
  venue_name:        58,
  event_date:        56,
  event_city:        68,
  event_country:     70,
  min_price:         62,
  max_price:         63,
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return new Response('Add ?trigger=1 to manually run the cache refresh.', {
      status: 200, headers: { 'Content-Type': 'text/plain' }
    });
  }
  const result = await refreshCache(env);
  return new Response(JSON.stringify(result), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
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

    if (rows.length === 0) return { success: false, error: 'Zero rows parsed', skipped };

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

          if (isFirstLine) { isFirstLine = false; continue; }
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
                const genre = awinGenre(row.merchant_category, row.category_name);
                newArtistMap.set(slug, {
                  slug, name: artistName, search: artistName,
                  genre, description: generateArtistDescription(artistName, genre),
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
  if (fields.length < 10) return null;

  const price = parsePrice(
    fields[COL.search_price] || fields[COL.display_price] ||
    fields[COL.store_price]  || fields[COL.min_price]
  );
  if (!price) return null;

  const productName = (fields[COL.product_name] || '').trim();
  const awDeepLink  = (fields[COL.aw_deep_link]  || '').trim();
  if (!productName || !awDeepLink) return null;

  const inStock = fields[COL.in_stock];
  const forSale = fields[COL.is_for_sale];
  if (inStock === '0' || inStock === 'false' || forSale === '0' || forSale === 'false') return null;

  const merchantName = (fields[COL.merchant_name] || '').trim();
  const safeGet = (idx) => (idx < fields.length ? (fields[idx] || '').trim() : '');

  return {
    product_name:      productName,
    aw_deep_link:      awDeepLink,
    image_url:         safeGet(COL.aw_image_url),
    price,
    currency:          safeGet(COL.currency) || 'GBP',
    merchant_name:     merchantName,
    merchant_id:       safeGet(COL.merchant_id),
    category_name:     safeGet(COL.category_name),
    merchant_category: safeGet(COL.merchant_category),
    description:       safeGet(COL.description).slice(0, 300),
    primary_artist:    safeGet(COL.primary_artist),
    event_name:        safeGet(COL.event_name),
    venue_name:        safeGet(COL.venue_name),
    event_date:        safeGet(COL.event_date),
    event_city:        safeGet(COL.event_city),
    event_country:     safeGet(COL.event_country),
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
