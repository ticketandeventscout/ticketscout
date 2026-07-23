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

// Genres this section is allowed to serve. MUST MATCH the sports genres in
// discover-pages.js SE365_QUEUEABLE_GENRES — if a genre isn't here, its pages
// shouldn't have been created and we don't want to serve them.
const SPORTS_GENRES = new Set([
  'Basketball', 'MMA', 'Ice Hockey', 'Rugby', 'Handball', 'American Football',
  'Baseball', 'Boxing', 'Tennis', 'Cricket', 'Motorsport', 'Golf', 'Wrestling'
]);

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
      genre:       SPORTS_GENRES.has(entity.genre) ? entity.genre : 'Sport',
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
        if (SPORTS_GENRES.has(rec.genre)) genre = rec.genre;
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
