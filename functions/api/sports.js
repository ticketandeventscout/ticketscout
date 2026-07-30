// ============================================================================
// TicketScout — Sports entity handler
// Runs as a Cloudflare Pages Function at /api/sports
//
// Serves metadata for a non-football sports entity (basketball team, MMA
// fighter, tennis player, ice hockey club...). Football keeps its own handler
// because it has a large curated TEAMS array; sports entities are ALL
// discovery-created, so this is KV-first with no hardcoded list to drift.
//
// KV key: sports:team:{slug}   (written by discover-pages.js commit path)
//
// Response: { slug, name, search, tmSearch, genre, description, found }
// `found` tells the template whether this is a real registered entity or a
// slug-synthesised fallback, so it can decide whether to noindex.
//
// Bindings: GIGSBERG_KV
// ============================================================================

const KV_PREFIX = 'sports:team:';

// Canonical genre map. CASE-INSENSITIVE: keys are lowercase, values are the
// display label shown on the hub chips.
//
// WHY THIS EXISTS: the ?phase=genreaudit repair in discover-pages.js writes
// LOWERCASE genres ('tennis', 'motorsport', 'winter sports') to match
// genreToCategory()'s lowercase convention. The hub previously compared against
// a capitalised Set ('Tennis'), so every re-genred entity failed the check and
// fell through to 'Other' — the counts looked unchanged even though the write
// succeeded (26 Jul). Comparing lowercase-to-lowercase fixes it, and the map
// also carries the newer sports (darts/snooker/horse racing/winter sports/
// esports) the old Set never had.
const GENRE_LABELS = {
  'basketball': 'Basketball', 'mma': 'MMA', 'ice hockey': 'Ice Hockey',
  'rugby': 'Rugby', 'handball': 'Handball', 'american football': 'American Football',
  'baseball': 'Baseball', 'boxing': 'Boxing', 'tennis': 'Tennis',
  'cricket': 'Cricket', 'motorsport': 'Motorsport', 'golf': 'Golf',
  'wrestling': 'Wrestling', 'darts': 'Darts', 'snooker': 'Snooker',
  'horse racing': 'Horse Racing', 'winter sports': 'Winter Sports',
  'esports': 'Esports', 'volleyball': 'Volleyball', 'football': 'Football'
};
// Returns the display label for any-case genre, or null if unrecognised.
function canonicalGenre(g) {
  if (!g) return null;
  return GENRE_LABELS[String(g).toLowerCase().trim()] || null;
}

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();

  // Hub listing: /api/sports?list=1 — powers the /sports index so it isn't a
  // dead end. Reads the sitemap registry (already maintained by
  // discover-pages build-registry) rather than scanning KV, so it costs one
  // read and can never disagree with what's in the sitemap.
  if (url.searchParams.get('list') === '1') {
    return listEntities(env, url);
  }
  if (url.searchParams.get('rebuild_full') === '1' && url.searchParams.get('trigger') === '1') {
    return rebuildFullHub(env, url);
  }

  if (!slug) return json({ error: 'slug is required' }, 400);

  // Deliberately NO football-style suffix stripping here. Football slugs need
  // it because feeds append "-fc"; sports entity names are people and clubs
  // where trimming a trailing token could corrupt the slug ("miami-heat" is
  // fine, but stripping generic suffixes risks collisions across sports).
  const kv = env.GIGSBERG_KV;
  let entity = null;

  if (kv) {
    try {
      const raw = await kv.get(KV_PREFIX + slug);
      if (raw) entity = JSON.parse(raw);
    } catch { /* fall through to synthesis */ }
  }

  if (entity) {
    // Merge Wikidata enrichment (written by /api/enrich-entities) the same way
    // football.js does: the generated Mad Libs prose replaces the generic
    // discovery description, but never overwrites hand-written copy.
    let facts = null;
    try {
      if (kv) {
        const m = await kv.get(`entity:meta:sports:${entity.slug || slug}`);
        if (m) {
          const meta = JSON.parse(m);
          facts = meta.facts || null;
          const generic = !entity.description ||
            /^Compare .{0,80} ticket prices (across|for)/.test(entity.description);
          if (meta.aboutText && generic) entity.description = meta.aboutText;
        }
      }
    } catch { /* enrichment is additive — never fail the page for it */ }

    return json({
      slug:        entity.slug || slug,
      name:        entity.name || toTitleCase(slug.replace(/-/g, ' ')),
      search:      entity.search || entity.name || slug.replace(/-/g, ' '),
      tmSearch:    entity.tmSearch || entity.search || entity.name || '',
      genre:       canonicalGenre(entity.genre) || 'Sport',
      description: entity.description || '',
      facts,
      found:       true
    }, 200);
  }

  // Slug-synthesised fallback. Returned so a page that exists as a static
  // stub still renders something sane if its KV entry has expired, but
  // found:false lets the template mark it noindex rather than publish a
  // thin page we can't vouch for.
  const name = toTitleCase(slug.replace(/-/g, ' '));
  return json({
    slug, name, search: name, tmSearch: name,
    genre: 'Sport',
    description: `Compare ${name} ticket prices across verified sellers on TicketScout.`,
    found: false
  }, 200);
}

function toTitleCase(str) {
  return String(str || '')
    .split(' ')
    .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ');
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ── Hub listing with genres ───────────────────────────────────────────────
// The hub needs a GENRE per entity so visitors can filter — a flat list of
// a thousand names tells them nothing about what's there. Genre lives on the
// individual KV record, so building the list means one read per entity.
// That's fine at today's scale but wouldn't be at a thousand, so the built
// list is cached in KV for 6h and every later request is a single read.
const HUB_INDEX_KEY = 'sports:hub:index';
const HUB_INDEX_TTL = 6 * 60 * 60;
const HUB_BUILD_CAP = 600;          // reads per rebuild — keeps us inside CPU limits

async function listEntities(env, url) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ count: 0, entities: [], genres: [] }, 200);

  const rebuild = url.searchParams.get('rebuild') === '1';

  if (!rebuild) {
    try {
      const cached = await kv.get(HUB_INDEX_KEY, 'json');
      if (cached && Array.isArray(cached.entities)) {
        return json({ ...cached, cached: true }, 200);
      }
    } catch { /* fall through to a rebuild */ }
  }

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections.sports) || {}).sort();
  } catch { /* empty registry — return an empty hub rather than erroring */ }

  const entities = [];
  const genreCounts = new Map();
  for (const s of slugs.slice(0, HUB_BUILD_CAP)) {
    let name = toTitleCase(s.replace(/-/g, ' '));
    let genre = 'Other';
    try {
      const raw = await kv.get(KV_PREFIX + s);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.name) name = rec.name;
        const label = canonicalGenre(rec.genre);
        if (label) genre = label;
      }
    } catch { /* keep the de-slugged fallback */ }
    entities.push({ slug: s, name, genre, url: '/sports/' + s });
    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
  }

  const payload = {
    count: entities.length,
    totalRegistered: slugs.length,
    truncated: slugs.length > HUB_BUILD_CAP,
    genres: [...genreCounts.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)),
    entities,
    builtAt: new Date().toISOString()
  };

  try { await kv.put(HUB_INDEX_KEY, JSON.stringify(payload), { expirationTtl: HUB_INDEX_TTL }); } catch {}
  return json({ ...payload, cached: false }, 200);
}

// ── Full hub rebuild: ?rebuild_full=1&trigger=1&limit=N ──────────────────
// See concert.js's rebuildFullHub for the full rationale — same fix, same
// pattern, ported across (this file predates concert.js's copy, but the
// 600-per-call CPU/subrequest constraint applies identically here: 1,027
// sports entities means everything past position 600 was silently invisible
// on the hub page forever). Accumulates across calls, promotes to the live
// HUB_INDEX_KEY only once the full registry has been walked, so the public
// hub page never serves a partial build and always has SOME data (the
// existing capped listEntities()) until the first full pass completes.
const HUB_BUILDING_KEY = 'sports:hub:building';
const HUB_CURSOR_KEY   = 'sports:hub:cursor';

async function rebuildFullHub(env, url) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'Missing GIGSBERG_KV' }, 500);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '600', 10) || 600, 600);

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections.sports) || {}).sort();
  } catch (e) {
    return json({ error: 'registry read failed: ' + String(e) }, 500);
  }
  if (!slugs.length) return json({ error: 'no sports entities in registry' }, 200);

  let cursor = '';
  try { cursor = (await kv.get(HUB_CURSOR_KEY)) || ''; } catch {}

  let acc = { entities: [], genreCounts: {} };
  if (cursor) {
    try {
      const raw = await kv.get(HUB_BUILDING_KEY, 'json');
      if (raw && Array.isArray(raw.entities)) acc = { entities: raw.entities, genreCounts: raw.genreCounts || {} };
    } catch {}
  }

  // Static snapshot for one full pass (nothing removed mid-build) — a simple
  // position lookup in the sorted array is safe, unlike a mutating D1 table.
  const startIdx = cursor ? slugs.findIndex(s => s > cursor) : 0;
  const batch = startIdx < 0 ? [] : slugs.slice(startIdx, startIdx + limit);

  for (const s of batch) {
    let name = toTitleCase(s.replace(/-/g, ' '));
    let genre = 'Other';
    try {
      const raw = await kv.get(KV_PREFIX + s);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.name) name = rec.name;
        const label = canonicalGenre(rec.genre);
        if (label) genre = label;
      }
    } catch { /* keep the de-slugged fallback */ }
    acc.entities.push({ slug: s, name, genre, url: '/sports/' + s });
    acc.genreCounts[genre] = (acc.genreCounts[genre] || 0) + 1;
  }

  const lastSlug = batch.length ? batch[batch.length - 1] : cursor;
  const done = (startIdx + batch.length) >= slugs.length;

  if (done) {
    const payload = {
      count: acc.entities.length,
      totalRegistered: slugs.length,
      truncated: false,
      genres: Object.entries(acc.genreCounts).map(([genre, count]) => ({ genre, count }))
        .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)),
      entities: acc.entities,
      builtAt: new Date().toISOString()
    };
    try {
      await kv.put(HUB_INDEX_KEY, JSON.stringify(payload), { expirationTtl: HUB_INDEX_TTL });
      await kv.delete(HUB_BUILDING_KEY);
      await kv.delete(HUB_CURSOR_KEY);
    } catch (e) {
      return json({ error: 'promote failed: ' + String(e) }, 500);
    }
    return json({ done: true, totalEntities: acc.entities.length, totalRegistered: slugs.length, promoted: true }, 200);
  }

  try {
    await kv.put(HUB_BUILDING_KEY, JSON.stringify(acc));
    await kv.put(HUB_CURSOR_KEY, lastSlug);
  } catch (e) {
    return json({ error: 'progress save failed: ' + String(e) }, 500);
  }
  return json({
    done: false, processedSoFar: acc.entities.length, totalRegistered: slugs.length,
    next: `?rebuild_full=1&trigger=1&limit=${limit}`
  }, 200);
}