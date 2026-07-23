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
    return json({
      slug:        entity.slug || slug,
      name:        entity.name || toTitleCase(slug.replace(/-/g, ' ')),
      search:      entity.search || entity.name || slug.replace(/-/g, ' '),
      tmSearch:    entity.tmSearch || entity.search || entity.name || '',
      genre:       SPORTS_GENRES.has(entity.genre) ? entity.genre : 'Sport',
      description: entity.description || '',
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
