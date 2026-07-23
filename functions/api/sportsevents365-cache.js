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
      if (!isValidName(pName) || isTribute(pName)) continue;
      const slug = toSlug(pName);
      if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;

      const genre = se365Genre(p.eventTypeId);
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

        await kv.put(PENDING_KEY, JSON.stringify({
          artists:   [...existing.artists, ...newArtistList],
          venues:    existing.venues || [],
          updatedAt: new Date().toISOString()
        }), { expirationTtl: PENDING_TTL });

        console.log(`SE365: queued ${newArtistList.length} new artists for commit`);
      }
    }

    return {
      success:         true,
      dryRun,
      totalFetched:    allParticipants.length,
      lookupEntries:   lookupSize,
      newArtistsQueued: newArtistList.length,
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

function isValidName(name) {
  if (!name || name.length < 3) return false;
  const slug = toSlug(name);
  if (/^\d+$/.test(slug)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  return true;
}

function isTribute(name) {
  return TRIBUTE_KEYWORDS.some(kw => (name || '').toLowerCase().includes(kw));
}

// Known SE365 eventTypeIds. Exposed on the function so the ?types=1
// diagnostic can report which live types are still unmapped.
// KNOWN GAP: everything not in here currently falls back to 'Sports', which
// routes non-sport participants (musicians, festivals) to /concert/ pages
// carrying a "professional Sports team or athlete" description. Run
// ?types=1 and extend this table from the real distribution before trusting
// the fallback.
const SE365_TYPE_MAP = {
  1000: 'Football', 1002: 'Basketball', 1005: 'Baseball',
  1014: 'Boxing',   1019: 'Cricket',    1035: 'MMA',
  1001: 'Tennis',   1006: 'Ice Hockey', 1007: 'American Football',
  1008: 'Rugby',    1009: 'Golf',       1010: 'Motorsport'
};

function se365Genre(eventTypeId) {
  return SE365_TYPE_MAP[eventTypeId] || 'Sports';
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
  // 'Sports' is the fallback sentinel, so any other value came from a real
  // eventTypeId mapping and is safe to name.
  if (g && g !== 'sports')
    return `Compare ${name} ticket prices for upcoming ${genre} events across verified sellers on TicketScout. Updated daily.`;
  // Unmapped/fallback genre — say nothing about what the participant IS.
  return `Compare ${name} ticket prices for upcoming events across verified sellers on TicketScout. Updated daily.`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}