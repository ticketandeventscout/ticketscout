// ===========================
// TicketScout — SportsEvents365 participant cache Worker
// Runs as a Cloudflare Pages Function at /api/sportsevents365-cache
//
// Fetches all SE365 participants and builds a name → {id, eventTypeId}
// lookup map stored in KV for instant name lookups by the adapter.
//
// SAME PATTERN AS AWIN CACHE:
// During the fetch, newly discovered participants (sports teams/athletes)
// are written to the autodiscover:awin:pending KV queue.
// The discover-pages?phase=commit job then deploys them as pages.
// This means zero extra cron jobs — discovery piggybacks on the cache refresh.
//
// NOTE: Cloudflare continues running this function in the background even
// if cron-job.org marks it as timed out (30s response limit). The cache
// will be fully built even if the HTTP response times out. This is expected
// behaviour and not an error.
//
// Cron: ONE weekly job on cron-job.org is all that's needed:
//   https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1
//
// Required env vars (all Secrets):
//   SE365_API_KEY        — API key
//   SE365_HTTP_USERNAME  — HTTP username
//   SE365_HTTP_PASSWORD  — HTTP password
//   GIGSBERG_KV          — KV namespace binding
//   SE365_PROD           — set to 'true' to use production API
// ===========================

const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';
const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';
const CACHE_KEY       = 'se365:participants:latest';
const PENDING_KEY     = 'autodiscover:awin:pending';
const KNOWN_KEY       = 'autodiscover:artists:known';
const CACHE_TTL       = 7 * 24 * 60 * 60; // 7 days
const PENDING_TTL     = 8 * 60 * 60;       // 8 hours

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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // Diagnostic: report the REAL eventTypeId distribution before we map it.
  // Sits above the trigger gate so it works standalone, same convention as
  // the ?find= endpoints in the merchant caches. Writes nothing.
  if (url.searchParams.get('types') === '1') {
    const result = await inspectTypes(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (url.searchParams.get('trigger') !== '1') {
    return text([
      'SE365 participant cache — usage:',
      '  ?trigger=1         — fetch all pages, build cache, queue new pages for discovery',
      '  ?trigger=1&dry=1   — dry run, shows what would be queued without writing',
      '  ?types=1           — DIAGNOSTIC: eventTypeId distribution + samples (writes nothing)',
      '',
      'One weekly cron job is all that is needed:',
      '  https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1',
      '',
      'NOTE: Cloudflare continues running in background even if cron-job.org',
      'times out. The cache will be fully built regardless.',
    ].join('\n'));
  }

  const dryRun = url.searchParams.get('dry') === '1';
  const result = await refreshCache(env, dryRun);

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── DIAGNOSTIC: what eventTypeIds does SE365 actually return? ──────────────
// The genre map covers 12 sport IDs and everything else falls through to
// 'Sports', which is how a musician ended up tagged as a sports participant
// and routed to /concert/. Rather than guess at SE365's taxonomy, this
// reports the real distribution so the map can be built from evidence.
//
// Reads the EXISTING KV participant cache rather than refetching the API.
// The cache already stores eventTypeId for every entry, so this costs one KV
// read, no HTTP, and no page loop. The first version refetched all ~80 pages
// and accumulated every participant in memory, which tripped Cloudflare's
// resource limit (Error 1102) — the same accumulate-instead-of-stream trap as
// the large CSV feeds. Read-only: no writes, no queueing.
async function inspectTypes(env) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return { success: false, error: 'GIGSBERG_KV binding not configured.' };

  let lookup;
  try {
    lookup = await kv.get(CACHE_KEY, 'json');
  } catch (err) {
    return { success: false, error: `KV read failed: ${err}` };
  }
  if (!lookup) {
    return {
      success: false,
      error: 'Participant cache is empty.',
      fix: 'Run /api/sportsevents365-cache?trigger=1 first, then retry ?types=1.'
    };
  }

  // Count by type, keeping a few real names per type so the mapping choice is
  // obvious ("is 1043 tennis players or music acts?"). Iterating the KV object
  // holds one small aggregate map, not the participant list.
  const byType = new Map();
  let total = 0, missingType = 0;
  for (const key of Object.keys(lookup)) {
    const p = lookup[key];
    if (!p) continue;
    total++;
    const t = (p.eventTypeId ?? null);
    if (t === null) missingType++;
    const k = String(t);
    if (!byType.has(k)) byType.set(k, { eventTypeId: t, count: 0, samples: [] });
    const rec = byType.get(k);
    rec.count++;
    if (rec.samples.length < 5) rec.samples.push(String(p.name || '').trim());
  }

  const types = [...byType.values()]
    .sort((a, b) => b.count - a.count)
    .map(r => ({
      ...r,
      mappedGenre: SE365_TYPE_MAP[r.eventTypeId] || null,
      status: SE365_TYPE_MAP[r.eventTypeId]
        ? 'mapped'
        : 'UNMAPPED -> currently falls back to "Sports" and routes to /concert/'
    }));

  const unmapped = types.filter(t => !t.mappedGenre);
  return {
    success: true,
    source: 'KV participant cache (' + CACHE_KEY + ')',
    totalParticipants: total,
    distinctTypes: types.length,
    missingType,
    unmappedTypeCount: unmapped.length,
    unmappedParticipantCount: unmapped.reduce((n, t) => n + t.count, 0),
    types,
    note: 'Read-only. Counts are of deduplicated cache entries, so slightly ' +
          'below the raw fetched total — fine for a distribution.'
  };
}

async function refreshCache(env, dryRun) {
  const apiKey   = env.SE365_API_KEY;
  const httpUser = env.SE365_HTTP_USERNAME;
  const httpPass = env.SE365_HTTP_PASSWORD;
  const httpSource = env.SE365_HTTP_SOURCE || '';
  const kv       = env.GIGSBERG_KV;
  const isProd   = env.SE365_PROD === 'true' || env.SE365_PROD === true;

  if (!apiKey || !httpUser || !httpPass) return { success: false, error: 'Missing SE365 credentials' };
  if (!kv)                               return { success: false, error: 'Missing GIGSBERG_KV binding' };

  const baseUrl   = isProd ? PRODUCTION_BASE : SANDBOX_BASE;
  const basicAuth = btoa(`${httpUser}:${httpPass}`);
  const headers   = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept': 'application/json',
    ...(httpSource ? { 'Source': httpSource } : {})
  };

  const startTime = Date.now();
  console.log('SE365 participant cache refresh started');

  try {
    // Load known artists to avoid re-queuing already-created pages
    let knownArtists = new Set();
    try {
      const k = await kv.get(KNOWN_KEY);
      if (k) knownArtists = new Set(JSON.parse(k));
    } catch {}

    // Fetch first page to get total page count
    const firstUrl  = buildPageUrl(baseUrl, apiKey, 1);
    const firstResp = await fetch(firstUrl, { headers });
    if (!firstResp.ok) return { success: false, error: `HTTP ${firstResp.status} on page 1` };

    const firstData  = await firstResp.json();
    const totalPages = firstData?.meta?.last_page || 1;
    const allParticipants = [...(firstData?.data || [])];

    console.log(`SE365: ${totalPages} total pages to fetch`);

    // Fetch remaining pages
    for (let page = 2; page <= totalPages; page++) {
      const pageUrl  = buildPageUrl(baseUrl, apiKey, page);
      const resp     = await fetch(pageUrl, { headers });
      if (!resp.ok) {
        console.warn(`SE365: page ${page} returned ${resp.status}, stopping`);
        break;
      }
      const data = await resp.json();
      const rows = data?.data || [];
      if (rows.length === 0) break;
      allParticipants.push(...rows);

      // Small delay every 20 pages to avoid rate limiting
      if (page % 20 === 0) await sleep(150);
    }

    console.log(`SE365: fetched ${allParticipants.length} total participants`);

    // Build lookup map AND discover new artists simultaneously
    const lookup     = {};
    const newArtists = new Map(); // slug → artist data
    let skipInvalidName = 0, skipUnmappedType = 0, skipNonQueueable = 0;
    let queueStats = null;

    for (const p of allParticipants) {
      if (!p.id || !p.name) continue;

      // SE365 returns names with leading/trailing whitespace (" Jamie XX").
      // toSlug() trims, so slugs looked fine while the stored NAME kept the
      // space and flowed into page titles, meta descriptions and JSON-LD.
      // Normalise once here so every downstream copy is clean.
      const pName = String(p.name).replace(/\s+/g, ' ').trim();
      if (!pName) continue;

      // Build lookup entry
      const normName = normaliseName(pName);
      if (normName) {
        lookup[normName] = {
          id:          p.id,
          name:        pName,
          eventTypeId: p.eventTypeId || null
        };
      }

      // Discovery — queue new participants as pages
      if (!isValidName(pName) || isTribute(pName)) { skipInvalidName++; continue; }

      // Fail CLOSED. An unmapped eventTypeId used to become 'Sports' and get
      // a /concert/ page; now it gets no page at all. Better a missing page
      // than a wrong one — the wrong ones are what GSC has been flagging.
      const genre = se365Genre(p.eventTypeId);
      if (!genre) { skipUnmappedType++; continue; }
      if (!SE365_QUEUEABLE_GENRES.has(genre)) { skipNonQueueable++; continue; }

      const slug = toSlug(pName);
      if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;

      newArtists.set(slug, {
        slug, name: pName, search: pName,
        genre, description: generateDescription(pName, genre),
        source: 'sportsevents365'
      });
    }

    const lookupSize   = Object.keys(lookup).length;
    const newArtistList = [...newArtists.values()];

    if (!dryRun) {
      // Save participant lookup to KV
      await kv.put(CACHE_KEY, JSON.stringify(lookup), { expirationTtl: CACHE_TTL });

      // Merge new artists into pending queue
      if (newArtistList.length > 0) {
        let existing = { artists: [], venues: [] };
        try {
          const ep = await kv.get(PENDING_KEY);
          if (ep) existing = JSON.parse(ep);
        } catch {}

        const stamp   = new Date().toISOString();
        const merged  = mergePendingQueue(existing.artists, newArtistList, 'slug');
        const built   = buildPendingBody(merged, existing.venues || [], stamp);
        await kv.put(PENDING_KEY, built.body, { expirationTtl: PENDING_TTL });
        queueStats = {
          incoming: newArtistList.length,
          existing: (existing.artists || []).length,
          afterDedup: built.artists.length,
          trimmedForSize: built.trimmed,
          bytes: built.body.length
        };

        console.log(`SE365: queue now ${built.artists.length} artists (${newArtistList.length} incoming)`);
      }
    }

    return {
      success:         true,
      dryRun,
      totalFetched:    allParticipants.length,
      lookupEntries:   lookupSize,
      newArtistsQueued: newArtistList.length,
      skipped: {
        invalidOrTributeName: skipInvalidName,
        unmappedEventType:    skipUnmappedType,
        genreHasNoPageType:   skipNonQueueable
      },
      queueableGenres: [...SE365_QUEUEABLE_GENRES],
      queue: queueStats,
      sampleNewArtists: newArtistList.slice(0, 5).map(a => ({ slug: a.slug, name: a.name, genre: a.genre })),
      elapsedMs:       Date.now() - startTime,
      cachedAt:        new Date().toISOString()
    };

  } catch (err) {
    console.error('SE365 participant cache error:', err);
    return { success: false, error: String(err) };
  }
}

function buildPageUrl(baseUrl, apiKey, page) {
  const u = new URL(`${baseUrl}/participants`);
  u.searchParams.set('apiKey', apiKey);
  u.searchParams.set('perPage', '50');
  u.searchParams.set('page', String(page));
  return u.toString();
}

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

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

// Names that are not entities at all. Every pattern below matches something
// the live feed actually returned — tournament bracket slots and event
// titles were being queued as if they were performers or clubs.
const PLACEHOLDER_PATTERNS = [
  /^[a-z]\d{1,2}$/i,                                              // A1, B5, C2 — bracket slots
  /\bqualifier\b/i,                                               // "African qualifier"
  /\b(?:winner|loser|runner[- ]up)\s+of\b/i,                      // "Winner of Semi-final 1"
  /^(?:america|asia|africa|europe|oceania|pacific)[\s\/]+[\w\s\/]*\d{1,2}$/i, // "America 1", "Asia / Pacific 1"
  /\bat\b.+\b(?:19|20)\d{2}$/i,                                   // "X and Y at the Jazz Open Modena 2026"
  /-test$/i                                                       // "eliki-swimming-test"
];

function isValidName(name) {
  if (!name || name.length < 3) return false;
  const slug = toSlug(name);
  if (/^\d+$/.test(slug)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  if (PLACEHOLDER_PATTERNS.some(re => re.test(name.trim()))) return false;
  return true;
}

function isTribute(name) {
  return TRIBUTE_KEYWORDS.some(kw => (name || '').toLowerCase().includes(kw));
}

// SE365 eventTypeId → genre. EVERY entry below is verified against real
// participant names returned by ?types=1 on 23 Jul 2026 — nothing here is
// inferred from the ID number or from SE365 documentation.
//
// Two entries in the previous table were WRONG and had been mislabelling
// ~204 participants:
//   1006 was 'Ice Hockey' but returns Arizona Cardinals, Baltimore Ravens,
//        Alabama Crimson Tide  -> American Football
//   1010 was 'Motorsport' but returns Anaheim Ducks, Adler Mannheim,
//        Admiral Vladivostok   -> Ice Hockey
// Actual motorsport is 1003 (IndyCar, NASCAR, United States Grand Prix).
//
// Three IDs from the old table (1007, 1008, 1009) do not appear in live data
// at all. Given 1006/1010 were swapped, unobserved IDs can't be trusted
// either, so they are deliberately NOT carried over — an unmapped ID is now
// skipped rather than mislabelled.
const SE365_TYPE_MAP = {
  1000: 'Football',           // 1597 — Namibia, 1. FC Slovacko, 1899 Hoffenheim
  1023: 'Concert',            //  909 — Jamie XX, Lewis Capaldi, 30 Seconds To Mars
  1002: 'Basketball',         //  294 — KK Borac, Adelaide 36ers
  1035: 'MMA',                //  134 — Yair Rodríguez, Alex Perez
  1010: 'Ice Hockey',         //  129 — Anaheim Ducks, Adler Mannheim (was 'Motorsport')
  1020: 'Rugby',              //  110 — All Blacks, ASM Clermont Auvergne
  1012: 'Handball',           //   76 — Aalborg Handbold
  1006: 'American Football',  //   75 — Arizona Cardinals, Baltimore Ravens (was 'Ice Hockey')
  1005: 'Baseball',           //   64 — Arizona Diamondbacks, Atlanta Braves
  1014: 'Boxing',             //   51 — Terence Crawford, Amir Khan
  1060: 'MMA',                //   31 — Alex Pereira, Arman Tsarukyan, Caio Borralho
  1001: 'Tennis',             //   24 — Alexander Zverev, Andy Murray
  1019: 'Cricket',            //   22 — Derbyshire County, Glamorgan County
  1003: 'Motorsport',         //    3 — IndyCar Series, NASCAR, United States Grand Prix
  1026: 'MMA',                //    2 — Gustafsson, Manuwa
  1028: 'Golf',               //    1 — Ryder Cup
  1032: 'Wrestling',          //    1 — Sumo Wrestling
  1033: 'Wrestling'           //    1 — WWE Mexico Live Tour
};

// STILL UNIDENTIFIED — samples are too ambiguous to map honestly, so these
// are left out and their participants are not queued:
//   1043 (40)  Afghanistan, Anderlecht, Angola, Armenia, Barca — mixed clubs
//              and countries; possibly futsal, not established
//   1024 (36)  Arkas IZMIR (volleyball) but otherwise country names only
//   1029 (14)  A2, A3, B2, B3, C2 — tournament slot placeholders, not entities
//   1056 (4)   Argentina, France, Serbia, South Sudan — sport not determinable
//   1011 (1)   "eliki-swimming-test" — SE365 test record
//   null (17)  no eventTypeId at all; mixed music acts and football clubs

// Genres we can give a correctly-categorised page.
//
// !! MUST MATCH the identical Set in functions/api/discover-pages.js !!
// These two files each run their own SE365 discovery pass. When only one was
// updated to include the sports genres, ?trigger=1 silently skipped 1,211
// participants while the other path would have queued them. The trigger
// response reports `queueableGenres` specifically so this drift is visible
// in a dry run instead of being discovered weeks later.
//
// /sports/{slug} now exists, so mapped sports genres route there rather than
// being dumped on /concert/. A null genre (unmapped eventTypeId) is still
// skipped entirely.
const SE365_QUEUEABLE_GENRES = new Set([
  'Football', 'Concert',
  'Basketball', 'MMA', 'Ice Hockey', 'Rugby', 'Handball', 'American Football',
  'Baseball', 'Boxing', 'Tennis', 'Cricket', 'Motorsport', 'Golf', 'Wrestling'
]);

// Returns null for unmapped types. Callers MUST treat null as "don't queue" —
// the old behaviour returned 'Sports' for anything unknown, which is how 909
// music acts became "professional Sports team or athlete" on /concert/ pages.
function se365Genre(eventTypeId) {
  return SE365_TYPE_MAP[eventTypeId] || null;
}
se365Genre.MAP = SE365_TYPE_MAP;

// Copy must only assert what we actually know: the name, and that we compare
// prices for it. The previous version stated facts we had not verified —
// "X are a professional Boxing team or athlete", "a passionate global
// fanbase" — which was published at scale on indexable pages, and read as
// nonsense whenever the genre fallback had guessed wrong (a musician tagged
// 'Sports'). Only the Football branch keeps a factual claim, because that
// genre comes from an explicitly mapped eventTypeId (1000) rather than the
// fallback, so we know it really is a club.
function generateDescription(name, genre) {
  const g = String(genre || '').toLowerCase();
  if (g === 'football')
    return `${name} fixtures listed with live pricing. Compare ${name} ticket prices across verified sellers on TicketScout.`;
  if (g === 'concert')
    return `Compare ${name} ticket prices for upcoming live shows across verified sellers on TicketScout. Updated daily.`;
  if (g)
    return `Compare ${name} ticket prices for upcoming ${genre} events across verified sellers on TicketScout. Updated daily.`;
  // No genre = unmapped type. These aren't queued, so this is a safety net.
  return `Compare ${name} ticket prices for upcoming events across verified sellers on TicketScout. Updated daily.`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

// ── Pending-queue merge (dedup + size guard) ─────────────────────────────
// The queue is a SINGLE KV value with a hard 25 MiB ceiling. The previous
// merge appended unconditionally AND refreshed the 8h TTL on every write, so
// the same slugs re-queued on every cron run and the value never expired —
// it grew to ~101,000 records (25.68 MiB) and started failing with
// "KV PUT failed: 413". 3,000 real records is only ~0.8 MiB; the entire
// overflow was duplicates.
//
// Dedup by slug, newest wins. The cap and byte guard are belt-and-braces so
// a future change can never reintroduce an unbounded write.
const QUEUE_MAX_ITEMS = 20000;
const QUEUE_MAX_BYTES = 24 * 1024 * 1024;   // headroom under the 25 MiB limit

function mergePendingQueue(existingItems, newItems, keyField) {
  const key = keyField || 'slug';
  const bySlug = new Map();
  for (const it of (existingItems || [])) {
    if (it && it[key]) bySlug.set(it[key], it);
  }
  for (const it of (newItems || [])) {
    if (it && it[key]) bySlug.set(it[key], it);   // newest wins
  }
  let merged = [...bySlug.values()];
  if (merged.length > QUEUE_MAX_ITEMS) merged = merged.slice(-QUEUE_MAX_ITEMS);
  return merged;
}

// Serialise and, if still oversized, trim from the oldest end until it fits.
// Returns { body, artists, venues, trimmed } so callers can report honestly
// instead of throwing a 413 that hides what happened.
function buildPendingBody(artists, venues, stamp) {
  let a = artists, v = venues, trimmed = 0;
  let body = JSON.stringify({ artists: a, venues: v, updatedAt: stamp });
  while (body.length > QUEUE_MAX_BYTES && a.length > 100) {
    const drop = Math.max(100, Math.floor(a.length * 0.1));
    a = a.slice(drop);
    trimmed += drop;
    body = JSON.stringify({ artists: a, venues: v, updatedAt: stamp });
  }
  return { body, artists: a, venues: v, trimmed };
}
