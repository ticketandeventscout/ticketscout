// ===========================
// TicketScout — Concert artist page handler
// Runs as a Cloudflare Pages Function at /api/concert
//
// Called by the concert template (concert.html) on page load.
// Returns artist data + Ticketmaster attraction ID for the requested slug.
//
// Usage: GET /api/concert?slug=coldplay
// Returns: { artist: {...}, attractionId: "K8vZ917..." } or { error: "..." }
// ===========================

// Artist data — inlined here to avoid ES module import issues in Pages Functions
// Keep in sync with concert-data.js at the project root
const ARTISTS = [
  { slug: 'coldplay',            name: 'Coldplay',            search: 'Coldplay',            genre: 'Rock / Pop',                   description: 'Coldplay are one of the best-selling music artists of all time, known for their anthemic rock sound and spectacular live shows. The British band have sold over 100 million records worldwide and are renowned for their colourful, immersive concerts featuring LED wristbands and confetti cannons.' },
  { slug: 'ed-sheeran',         name: 'Ed Sheeran',          search: 'Ed Sheeran',          genre: 'Pop',                          description: 'Ed Sheeran is one of the UK\'s most successful artists, known for his acoustic-driven pop sound and record-breaking world tours. With multiple Grammy Awards and Brit Awards to his name, his live shows are celebrated for their intimate atmosphere despite playing to stadium-sized crowds.' },
  { slug: 'metallica',          name: 'Metallica',           search: 'Metallica',           genre: 'Heavy Metal',                  description: 'Metallica are one of the most influential heavy metal bands in history, having sold over 125 million records worldwide. Their M72 World Tour is one of the highest-grossing tours of all time, featuring a unique in-the-round stage design with no barricade between the band and the audience.' },
  { slug: 'foo-fighters',       name: 'Foo Fighters',        search: 'Foo Fighters',        genre: 'Rock',                         description: 'Foo Fighters are one of the world\'s biggest rock bands, led by Nirvana drummer Dave Grohl. Known for their energetic and marathon live performances, the band have won 12 Grammy Awards and are a fixture at major festivals and arenas worldwide.' },
  { slug: 'bad-bunny',          name: 'Bad Bunny',           search: 'Bad Bunny',           genre: 'Latin Trap / Reggaeton',       description: 'Bad Bunny is a Puerto Rican singer, rapper and songwriter who has become one of the world\'s most streamed artists. His Most Wanted Tour broke multiple box office records and his theatrical, immersive concerts are among the most sought-after live events globally.' },
  { slug: 'the-weeknd',         name: 'The Weeknd',          search: 'The Weeknd',          genre: 'R&B / Pop',                    description: 'The Weeknd is a Canadian singer, songwriter and record producer known for his distinctive sound blending R&B, pop and synth-wave. His After Hours Til Dawn Tour became one of the highest-grossing concert tours of all time.' },
  { slug: 'ariana-grande',      name: 'Ariana Grande',       search: 'Ariana Grande',       genre: 'Pop / R&B',                    description: 'Ariana Grande is one of the world\'s best-selling music artists, known for her powerful vocal range and high-energy pop performances. With multiple chart-topping albums and record-breaking streaming numbers, her live shows are among the most anticipated events in pop music.' },
  { slug: 'bruno-mars',         name: 'Bruno Mars',          search: 'Bruno Mars',          genre: 'Pop / R&B / Funk',             description: 'Bruno Mars is a Grammy Award-winning singer, songwriter and producer known for his dynamic stage presence and genre-spanning sound. His live performances, which blend pop, funk, R&B and soul, are widely considered among the most entertaining in the industry.' },
  { slug: 'taylor-swift',       name: 'Taylor Swift',        search: 'Taylor Swift',        genre: 'Pop / Country',                description: 'Taylor Swift is one of the most celebrated musicians of her generation, known for her songwriting, record-breaking album releases and the phenomenon of the Eras Tour — the highest-grossing concert tour of all time.' },
  { slug: 'doja-cat',           name: 'Doja Cat',            search: 'Doja Cat',            genre: 'Hip-Hop / Pop / R&B',          description: 'Doja Cat is an American rapper, singer and songwriter known for her genre-blending sound and visually creative live performances. Her Scarlet Tour brought an elaborate theatrical production to arenas worldwide.' },
  { slug: 'tame-impala',        name: 'Tame Impala',         search: 'Tame Impala',         genre: 'Psychedelic Rock / Electronic', description: 'Tame Impala is an Australian psychedelic rock project led by Kevin Parker, known for its immersive visual shows and critically acclaimed albums. Their concert productions are celebrated for combining stunning light shows with a hypnotic, textured sound.' },
  { slug: 'my-chemical-romance', name: 'My Chemical Romance', search: 'My Chemical Romance', genre: 'Alternative Rock / Emo',       description: 'My Chemical Romance are an iconic American rock band known for their theatrical performances and devoted global fanbase. Following their 2019 reunion, the band have returned to selling out major venues and festivals worldwide.' },
  { slug: 'wolf-alice',         name: 'Wolf Alice',          search: 'Wolf Alice',          genre: 'Alternative Rock / Indie',     description: 'Wolf Alice are a British rock band and Mercury Prize winners known for their dynamic range — from delicate acoustic moments to full-throttle guitar rock. One of the most critically acclaimed British bands of their generation.' },
  { slug: 'biffy-clyro',        name: 'Biffy Clyro',         search: 'Biffy Clyro',         genre: 'Alternative Rock',             description: 'Biffy Clyro are a Scottish rock band known for their complex song structures, powerful live performances and loyal fanbase. Multiple Brit Award nominees, they regularly headline major UK arenas and festivals.' },
  { slug: 'the-1975',           name: 'The 1975',            search: 'The 1975',            genre: 'Indie Pop / Alternative Rock',  description: 'The 1975 are a British pop-rock band known for their genre-fluid sound and elaborate theatrical live productions. Fronted by Matty Healy, their shows are celebrated as cultural events combining provocative visuals and introspective lyrics.' }
];


// ── Hub listing: /api/concert?list=1 ──────────────────────────────────────
// Ported from sports.js. Reads the sitemap registry rather than scanning KV,
// so it costs one read and can never disagree with the sitemap. The built
// list is cached in KV for 30h (was 6h — extended 31 Jul); a rebuild costs
// one read per entity, capped.
// The cron dispatcher's rebuild-concert-hub job runs once every 24h
// (0 4 * * *). A 6h TTL guaranteed the cache would expire ~18h before the
// next run — most of every day — forcing the capped on-demand path
// (HUB_BUILD_CAP=600) regardless of whether the cron fired correctly. 30h
// covers the full 24h gap plus a margin for one delayed/skipped run.
const HUB_INDEX_KEY = 'concert:hub:index';
const HUB_INDEX_TTL = 30 * 60 * 60;
const HUB_BUILD_CAP = 600;

// Stored genres are freeform composites — 'Rock / Pop', 'Latin Trap /
// Reggaeton', 'Psychedelic Rock / Electronic'. Rendered raw they would make
// dozens of one-entity pills, so they are folded into a small canonical set.
// Order matters: the first match wins, so the more specific terms come first.
const GENRE_RULES = [
  ['Metal',      /metal|hardcore/i],
  ['Latin',      /latin|reggaeton|salsa|bachata/i],
  ['Hip-Hop',    /hip.?hop|rap|grime|trap/i],
  ['R&B / Soul', /r&b|rnb|soul|funk|motown/i],
  ['Country',    /country|americana|bluegrass/i],
  ['Electronic', /electronic|dance|house|techno|edm|drum.?and.?bass|dubstep/i],
  ['Jazz',       /jazz|blues/i],
  ['Classical',  /classical|orchestra|opera|symphony/i],
  ['Folk',       /folk|acoustic|singer.?songwriter/i],
  ['Indie',      /indie|alternative|emo|shoegaze/i],
  ['Rock',       /rock|punk|grunge/i],
  ['Pop',        /pop|k.?pop/i]
];

function canonicalGenre(raw) {
  const s = String(raw || '');
  if (!s.trim()) return 'Other';
  // The stored value lists the PRIMARY genre first — 'Pop / R&B' is a pop
  // act, 'R&B / Pop' is an R&B act. Match the first segment so the data's
  // own ordering wins, rather than the order these rules happen to be in.
  const primary = s.split('/')[0].trim() || s;
  for (const [label, re] of GENRE_RULES) if (re.test(primary)) return label;
  for (const [label, re] of GENRE_RULES) if (re.test(s)) return label;
  return 'Other';
}

// toTitleCase() is declared further down this file and hoists, so it is
// deliberately NOT redeclared here — a duplicate top-level declaration is a
// hard build error in an ES module (Wrangler), though node --check accepts it
// in script mode. Always verify functions/ files in module mode.

async function listEntities(env, url) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ count: 0, entities: [], genres: [] }, 200);

  const rebuild = url.searchParams.get('rebuild') === '1';
  if (!rebuild) {
    try {
      const cached = await kv.get(HUB_INDEX_KEY, 'json');
      if (cached && Array.isArray(cached.entities)) {
        return jsonResponse({ ...cached, cached: true }, 200);
      }
    } catch { /* fall through to a rebuild */ }
  }

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections.concert) || {}).sort();
  } catch { /* empty registry — return an empty hub rather than erroring */ }

  const entities = [];
  const genreCounts = new Map();
  // Same timeout-risk fix as rebuildFullHub() below — chunked concurrent
  // KV reads instead of one at a time, for the same reason.
  const capped = slugs.slice(0, HUB_BUILD_CAP);
  const CHUNK_SIZE = 10;
  for (let i = 0; i < capped.length; i += CHUNK_SIZE) {
    const chunk = capped.slice(i, i + CHUNK_SIZE);
    await Promise.all(chunk.map(async (s) => {
      let name = toTitleCase(s.replace(/-/g, ' '));
      let genre = 'Other';
      try {
        const raw = await kv.get('concert:artist:' + s);
        if (raw) {
          const rec = JSON.parse(raw);
          if (rec.name) name = rec.name;
          genre = canonicalGenre(rec.genre);
        }
      } catch { /* keep the de-slugged fallback */ }
      entities.push({ slug: s, name, genre, url: '/concert/' + s });
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    }));
  }

  const payload = {
    count: entities.length,
    totalRegistered: slugs.length,
    truncated: slugs.length > HUB_BUILD_CAP,
    genres: [...genreCounts.entries()].map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)),
    entities,
    builtAt: new Date().toISOString()
  };

  try { await kv.put(HUB_INDEX_KEY, JSON.stringify(payload), { expirationTtl: HUB_INDEX_TTL }); } catch {}
  return jsonResponse({ ...payload, cached: false }, 200);
}

// ── Full hub rebuild: ?rebuild_full=1&trigger=1&limit=N ──────────────────
// The on-demand listEntities() above caps at HUB_BUILD_CAP (600) per call —
// that's a real Cloudflare CPU/subrequest budget limit (one KV read per
// entity within a single request), not a product choice, so raising it
// directly risks a timeout. With 2,597 concert entities, that cap meant
// everything past position 600 (alphabetically) was silently invisible on
// the hub page forever.
//
// This walks the FULL registry across as many small calls as it takes,
// accumulating into a separate "building" KV key, and only PROMOTES the
// result to the live HUB_INDEX_KEY once every entity has been read — so the
// public hub page never serves a partial rebuild mid-flight. Until the first
// full build completes, listEntities() keeps serving its existing capped
// fallback, so the page is never empty while this runs in the background.
const HUB_BUILDING_KEY = 'concert:hub:building';
const HUB_CURSOR_KEY   = 'concert:hub:cursor';

async function rebuildFullHub(env, url) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '600', 10) || 600, 600);

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections.concert) || {}).sort();
  } catch (e) {
    return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500);
  }
  if (!slugs.length) return jsonResponse({ error: 'no concert entities in registry' }, 200);

  let cursor = '';
  try { cursor = (await kv.get(HUB_CURSOR_KEY)) || ''; } catch {}

  let acc = { entities: [], genreCounts: {} };
  if (cursor) {
    try {
      const raw = await kv.get(HUB_BUILDING_KEY, 'json');
      if (raw && Array.isArray(raw.entities)) acc = { entities: raw.entities, genreCounts: raw.genreCounts || {} };
    } catch {}
  }

  // Keyset resume: this is a static snapshot for one full pass (nothing is
  // deleted mid-build, unlike the D1 reclassify job), so a simple position
  // lookup in the sorted array is safe here.
  const startIdx = cursor ? slugs.findIndex(s => s > cursor) : 0;
  const batch = startIdx < 0 ? [] : slugs.slice(startIdx, startIdx + limit);

  // TIMEOUT FIX (7 Aug 2026): this was a sequential `for` loop — one KV
  // round-trip at a time, awaited in series, for up to 600 entities in a
  // single call. Very likely the actual cause of today's rebuild-concert-hub
  // timeout — 600 sequential reads can comfortably approach the 60s budget
  // on their own even before anything else in the request. Same bug class,
  // same fix as entity-lifecycle.js's timeout fix earlier this session:
  // no ordering dependency between entities, so fetching them concurrently
  // in small chunks is strictly safe and turns 600 sequential round-trips
  // into 60 chunked ones.
  const CHUNK_SIZE = 10;
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    await Promise.all(chunk.map(async (s) => {
      let name = toTitleCase(s.replace(/-/g, ' '));
      let genre = 'Other';
      try {
        const raw = await kv.get('concert:artist:' + s);
        if (raw) {
          const rec = JSON.parse(raw);
          if (rec.name) name = rec.name;
          genre = canonicalGenre(rec.genre);
        }
      } catch { /* keep the de-slugged fallback */ }
      acc.entities.push({ slug: s, name, genre, url: '/concert/' + s });
      acc.genreCounts[genre] = (acc.genreCounts[genre] || 0) + 1;
    }));
  }

  const lastSlug = batch.length ? batch[batch.length - 1] : cursor;
  const done = (startIdx + batch.length) >= slugs.length;

  // FIX (7 Aug 2026): this used to only write HUB_INDEX_KEY (the key the
  // public page actually reads) once `done` was true — an all-or-nothing
  // promotion across what can now be an ~11-day pass (6,507 entities ÷ 600
  // per daily call), up from the 2,597 this system was built around. Any
  // single failed day anywhere in that run (cron timeouts happen — see
  // rebuild-concert-hub's own failure in yesterday's dump) meant NONE of
  // the accumulated progress ever reached the live page, no matter how
  // close to done it got, because it never re-attempts a stalled cursor on
  // its own — it just sits there until the next scheduled call resumes it.
  // Confirmed live: the concert hub was showing exactly 600 entities,
  // ONLY the original capped fallback, despite this having likely run
  // repeatedly in the background for weeks. Now promotes the CURRENT
  // accumulated state on every call — so each day's progress is visible
  // on the live page immediately, growing incrementally toward the full
  // registry instead of being invisible until one perfect uninterrupted
  // pass completes.
  const partialPayload = {
    count: acc.entities.length,
    totalRegistered: slugs.length,
    truncated: !done,
    genres: Object.entries(acc.genreCounts).map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre)),
    entities: acc.entities,
    builtAt: new Date().toISOString()
  };
  try { await kv.put(HUB_INDEX_KEY, JSON.stringify(partialPayload), { expirationTtl: HUB_INDEX_TTL }); } catch {}

  if (done) {
    try {
      await kv.delete(HUB_BUILDING_KEY);
      await kv.delete(HUB_CURSOR_KEY);
    } catch (e) {
      return jsonResponse({ error: 'cleanup failed (hub index already promoted, safe to ignore): ' + String(e) }, 500);
    }
    return jsonResponse({ done: true, totalEntities: acc.entities.length, totalRegistered: slugs.length, promoted: true }, 200);
  }

  try {
    await kv.put(HUB_BUILDING_KEY, JSON.stringify(acc));
    await kv.put(HUB_CURSOR_KEY, lastSlug);
  } catch (e) {
    return jsonResponse({ error: 'progress save failed: ' + String(e) }, 500);
  }
  return jsonResponse({
    done: false, processedSoFar: acc.entities.length, totalRegistered: slugs.length,
    next: `?rebuild_full=1&trigger=1&limit=${limit}`
  }, 200);
}

const HARDCODED_THEATRE_SLUGS = [
  'a-christmas-carol', 'little-shop-of-horrors', 'maybe-happy-ending', 'buena-vista-social-club',
  'blue-man-group', 'magic-mike-live', 'jabbawockeez', 'dolly',
  'all-motown', 'all-shook-up', 'candlelight', 'death-becomes-her',
  'comedy-cellar', 'beetlejuice', 'evita', 'hells-kitchen',
  'matilda', 'daniel', 'juliet', 'annie',
  'mat-franco', 'hairspray', 'disney-on-ice', 'cirque-du-soleil-ka',
  'cirque-du-soleil-mystere', 'galileo', 'cirque-du-soleil-auana', 'garden-brothers-nuclear-circus',
  'christmas-spectacular-starring-the-radio-city-rockettes', 'eddie-griffin', 'grand-shanghai-circus', 'cirque-du-soleil-mad-apple',
  'cats', 'beauty-and-the-beast', 'chippendales', 'laugh-factory',
  'big-black-comedy-show', 'cirque-du-soleil-o', 'aladdin', 'jamie-allans-amaze',
  'adam-london-laughternoon', 'metropolitan-opera', 'cirque-du-soleil-drawn-to-life', 'just-in-time',
  'mean-girls', 'drunk-pirates', 'blueys-big-play', 'joseph-and-the-amazing-technicolor-dreamcoat',
  'la-comedy-club', 'a-beautiful-noise', 'boop-the-musical', 'menopause-the-musical',
  'le-grand-cirque', 'cirque-du-soleil-michael-jackson-one', 'heathers', 'legends-in-concert',
  'cirque-du-soleil-luzia', 'delirious-comedy-club', 'circus-vazquez', 'joshua',
  'an-r-rated-magic-show', 'los-angeles-philharmonic', 'chicago-architecture-center-river-cruise', 'beautiful',
  'how-the-grinch-stole-christmas', 'carrot-top', 'anastasia', 'david-goldrake',
  'the-wizard-of-oz', 'garden-bros-nuclear-circus', 'second-city-mainstage-revue', 'piano-man',
  'radio-city-christmas-spectacular', 'shanghai-circus', 'the-empire-strips-back', 'piff-the-magic-dragon',
  'venardos-circus', 'rupauls-drag-race',
];

// ── SHADOW CHECK (read-only) ─────────────────────────────────────────────
// The ARTISTS array is consulted BEFORE KV (see the handler ~line 272), so
// these 78 hardcoded 'Live Events' entries SHADOW any KV record of the same
// slug. Most are theatre shows seeded before discovery existed. Before
// deleting the block we must know, per slug, whether removing it would:
//   (a) hand over to a real KV record  -> SAFE, page keeps working
//   (b) leave nothing                   -> page 404s (orphan)
//   (c) leave a registry entry with no server -> sitemap points at a 404
// This classifies all 78 against KV + registry so the deletion is evidence-led.
// Usage: /api/concert?shadowcheck=1
async function shadowCheck(env) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'no KV binding' }, 500);

  let registrySet = new Set();
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    registrySet = new Set(Object.keys((reg && reg.sections && reg.sections.concert) || {}));
  } catch {}

  const safeToDelete = [], wouldOrphan = [], inRegistryOnly = [];
  for (const slug of HARDCODED_THEATRE_SLUGS) {
    let kvExists = false;
    try { kvExists = !!(await kv.get('concert:artist:' + slug)); } catch {}
    const inReg = registrySet.has(slug);
    const row = { slug, kvExists, inRegistry: inReg };
    if (kvExists) safeToDelete.push(row);           // KV takes over -> safe
    else if (inReg) inRegistryOnly.push(row);       // registry points here, no KV -> needs a KV backfill first
    else wouldOrphan.push(row);                     // nothing anywhere -> deleting 404s a live page
  }

  // Added 16 Aug 2026 — the ARTISTS array (15 genuine music artists:
  // Coldplay, Nickelback, Ed Sheeran, Metallica...) is a completely
  // SEPARATE list from HARDCODED_THEATRE_SLUGS above, and this diagnostic
  // never covered it. Confirmed live this session: Coldplay and Nickelback
  // are served via the raw CSR template with no baked-in content or meta
  // tags at all, unlike a discovered/registered entity (e.g. Arsenal under
  // football) which gets a fully server-rendered static stub. That strongly
  // suggested these 15 — plausibly among the highest-traffic, most
  // deliberately-curated pages on the whole site — were never added to
  // sitemap:registry at all, so the regenerate sweep has no way to ever
  // pick them up. Same three-way check, same underlying question (does a
  // KV record exist, is it in the registry), but the framing here is about
  // indexing quality and static-stub eligibility, not "safe to delete" —
  // these are meant to be permanent, not phased out like the theatre list.
  const artistsRegistered = [], artistsMissingFromRegistry = [];
  for (const a of ARTISTS) {
    const slug = a.slug;
    let kvExists = false;
    try { kvExists = !!(await kv.get('concert:artist:' + slug)); } catch {}
    const inReg = registrySet.has(slug);
    const row = { slug, name: a.name, kvExists, inRegistry: inReg };
    if (inReg) artistsRegistered.push(row);
    else artistsMissingFromRegistry.push(row);
  }

  return jsonResponse({
    check: 'hardcoded-theatre-shadow',
    readOnly: true,
    total: HARDCODED_THEATRE_SLUGS.length,
    safeToDeleteCount: safeToDelete.length,
    wouldOrphanCount: wouldOrphan.length,
    inRegistryOnlyCount: inRegistryOnly.length,
    safeToDelete,
    wouldOrphan,
    inRegistryOnly,
    guidance: 'Delete ONLY safeToDelete slugs from the ARTISTS array. wouldOrphan need a KV record created first (or keep the hardcoded entry). inRegistryOnly need the registry entry removed too, or a KV backfill.',

    musicArtistsCheck: {
      total: ARTISTS.length,
      inRegistryCount: artistsRegistered.length,
      missingFromRegistryCount: artistsMissingFromRegistry.length,
      inRegistry: artistsRegistered,
      missingFromRegistry: artistsMissingFromRegistry,
      guidance: 'missingFromRegistry entries are invisible to the regenerate-pages sweep — they can never get a static stub, baked meta tags, or the found/noindex protection those pages have, regardless of how much real traffic they get. Adding them to sitemap:registry (and confirming a concert:artist:{slug} KV record exists so found:true resolves correctly) is what would let them be picked up by the next sweep.'
    }
  }, 200);
}

async function inspectRecords(env, section, prefix) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'no KV binding' }, 500);

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections[section]) || {}).sort();
  } catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }

  // Sample from the start, middle and end — the first entries alphabetically
  // are the oddest (numeric-prefixed imports), so they are not representative.
  const picks = [slugs[0], slugs[Math.floor(slugs.length / 2)], slugs[slugs.length - 1]]
    .filter(Boolean);

  const out = [];
  for (const s of picks) {
    const row = { slug: s, entityKey: prefix + s, metaKey: 'entity:meta:' + section + ':' + s };
    try {
      const raw = await kv.get(prefix + s);
      row.entityExists = !!raw;
      if (raw) {
        row.entityRaw = raw.slice(0, 600);
        try {
          const rec = JSON.parse(raw);
          row.entityFields = Object.keys(rec);
          row.entityGenre = rec.genre === undefined ? '<<MISSING>>' : rec.genre;
        } catch { row.entityFields = '<<not JSON>>'; }
      }
    } catch (e) { row.entityError = String(e); }

    try {
      const m = await kv.get('entity:meta:' + section + ':' + s);
      row.metaExists = !!m;
      if (m) {
        row.metaRaw = m.slice(0, 600);
        try {
          const meta = JSON.parse(m);
          row.metaFields = Object.keys(meta);
          row.metaGenre = meta.genre === undefined ? '<<MISSING>>' : meta.genre;
        } catch { row.metaFields = '<<not JSON>>'; }
      }
    } catch (e) { row.metaError = String(e); }

    out.push(row);
  }

  return jsonResponse({
    section, prefix, totalRegistered: slugs.length, sampled: picks, records: out
  }, 200);
}

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  // Hub listing powers /concert so the section is browsable and internally
  // linked rather than a dead end Google reads as a thin page.
  if (url.searchParams.get('inspect') === '1') return inspectRecords(env, 'concert', 'concert:artist:');
  if (url.searchParams.get('shadowcheck') === '1') return shadowCheck(env);
  if (url.searchParams.get('list') === '1') return listEntities(env, url);
  if (url.searchParams.get('rebuild_full') === '1' && url.searchParams.get('trigger') === '1') {
    return rebuildFullHub(env, url);
  }

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let artist = ARTISTS.find(a => a.slug === normSlug);

  // FOUND tracking added 16 Aug 2026 — mirrors sports.js's already-proven
  // `found` field exactly, so the template can noindex a fabricated page the
  // same way sports.html already does. Hardcoded ARTISTS entries and a
  // genuine KV registration (the discovery pipeline's own output) are
  // treated as verified; the Awin fallback below and the final slug-
  // synthesis tier are NOT — same reasoning as today's aboutText gate on
  // facts.wikidataId: a bare name-similarity match isn't the same thing as
  // a confirmed real entity, and this session already found Awin fallback
  // matches accepting things they shouldn't (the sports-in-concert
  // incident this exact file's own SPORTS_CATEGORY_KEYWORDS filter below
  // was built to catch).
  let verifiedMatch = !!artist;

  // If not in the hardcoded list, check KV for auto-discovered artist data
  if (!artist) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`concert:artist:${normSlug}`);
        if (kvData) {
          artist = JSON.parse(kvData);
          verifiedMatch = true;
        }
      } catch {}
    }
  }

  // Fallback — check Awin for any unknown slug
  if (!artist) {
    const name = normSlug.replace(/-/g, ' ');
    try {
      const origin  = new URL(request.url).origin;
      // Switched from /api/awin-events to /api/awin-category: the older
      // adapter matched on product_name + free-text description, and a
      // venue literally named after an artist (Avicii Arena) could satisfy
      // a description-text match even when the actual performer was someone
      // else entirely (The Neighbourhood, A$AP Rocky...) playing AT that
      // venue. awin-category.js scores ONLY primary_artist/event_name/
      // product_name — venue text is never part of the match at all, so
      // this venue-named-after-an-artist case can't false-positive here.
      // No date param: this is a broad "tell me about this artist" lookup,
      // not a specific dated event, so we want any/all matching rows.
      const awinUrl  = `${origin}/api/awin-category?q=${encodeURIComponent(name)}`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        const allMatches = awinData.matches || [];
        // FIX (16 Aug 2026, live incident via GSC coverage export): awin-
        // category.js is a pure name/price matcher shared across every
        // category (football/theatre/sports/concert each query it with
        // their own text) — it deliberately does NOT filter by category
        // itself, since doing so there would break the other callers'
        // legitimate use of the same adapter. But this caller never checked
        // the category it DOES return (toResult()'s `category` field, read
        // right below into `genre`) before accepting a match. Confirmed
        // live: minor-league baseball (Chattanooga Lookouts, Kansas City
        // Monarchs, Sussex County Miners, Tulsa Drillers, Visalia Rawhide),
        // an AHL hockey team (Abbotsford Canucks), an NCAA team (Ball State
        // Cardinals), and a Polish handball cup final all got matched and
        // rendered as fabricated "concert" pages, with the real "Sports"/
        // "Baseball" category flowing straight into `genre` below —
        // self-documenting the miscategorisation without anything ever
        // reading it. Conservative on purpose: only rejects a match whose
        // category POSITIVELY names a sport; a missing/unclear category is
        // never treated as disqualifying, so this can't suppress a real
        // concert match just for lacking clean Awin metadata.
        const matches = allMatches.filter(m => !looksLikeSportsCategory(m.category));
        if (matches.length > 0) {
          const ev          = matches[0];
          const displayName = toTitleCase(name);
          const rawDesc     = (ev.description || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim();
          artist = {
            slug:        normSlug,
            name:        displayName,
            search:      displayName,
            genre:       ev.category || 'Live Events',
            description: rawDesc.slice(0, 300) || `Compare ${displayName} ticket prices across verified sellers.`
          };
        }
      }
    } catch {}

    // Slug-based fallback — synthesise from slug for any slug value.
    // If a request reaches /api/concert?slug=X it means concert/X.html exists as a
    // deployed stub page. A 404 here is never correct — the page would break.
    // TM attraction lookup below will find an image if one exists; if not, the page
    // still renders correctly with a gradient placeholder.
    if (!artist) {
      const displayName = toTitleCase(normSlug.replace(/-/g, ' '));
      artist = {
        slug:        normSlug,
        name:        displayName,
        search:      displayName,
        genre:       'Live Music',
        description: 'Compare ' + displayName + ' ticket prices across verified sellers on TicketScout.'
      };
    }
  }

  // Resolve Ticketmaster attraction ID for this artist
  const apiKey = env.TM_API_KEY;
  let attractionId = null;
  let tmImage = null;

  if (apiKey) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', artist.search);
      tmUrl.searchParams.set('size', '10');

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        const TRIBUTE_KEYWORDS = ['tribute', 'salute', 'legacy', 'experience', 'revival',
          'forever', 'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs '];

        const normSearch = artist.search.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        const scored = attractions.map(a => {
          const normName = (a.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          let score = 0;
          if (normName === normSearch)             score = 100;
          else if (normName.startsWith(normSearch)) score = 50;
          else if (normName.includes(normSearch))   score = 20;

          const isTribute = TRIBUTE_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw));
          if (isTribute) score -= 60;

          return { attraction: a, score };
        }).sort((a, b) => b.score - a.score);

        const best = scored[0].attraction;
        attractionId = best.id;
        const images = best.images || [];
        const sixteenNine = images
          .filter(img => img.ratio === '16_9' && img.width > 500)
          .sort((a, b) => (b.width || 0) - (a.width || 0));
        tmImage = sixteenNine[0]?.url || images.find(img => img.width > 500)?.url || images[0]?.url || null;
      }
    } catch (err) {
      console.error('TM attraction lookup error:', err);
    }
  }


  // ── Phase 4.3E — enriched About copy for auto-created pages ─────────────
  // entity:meta:{category}:{slug} is written by /api/enrich-entities and
  // carries CC0 facts + a seeded, entity-unique "About" paragraph. It only
  // REPLACES generic fallback descriptions ("Compare X ticket prices…");
  // hand-curated descriptions in the static array are always kept.
  let enrichFacts = null;
  try {
    const ekv = env.GIGSBERG_KV;
    if (ekv) {
      const m = await ekv.get(`entity:meta:concert:${artist.slug}`);
      if (m) {
        const meta = JSON.parse(m);
        enrichFacts = meta.facts || null;
        const generic = !artist.description || /^Compare .{0,80} ticket prices across verified sellers/.test(artist.description);
        if (meta.aboutText && generic) artist.description = meta.aboutText;
      }
    }
  } catch {}

  return jsonResponse({
    artist: {
      slug:        artist.slug,
      name:        artist.name,
      genre:       artist.genre,
      description: artist.description,
      facts:       enrichFacts
    },
    attractionId,
    tmImage,
    found: verifiedMatch
  }, 200);
}

function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}

// Added 16 Aug 2026 alongside the Awin-fallback fix above. Deliberately a
// broad EXCLUSION list, not a narrow allowlist of "music" terms — Awin's
// real category taxonomy across its merchants isn't something we have full
// visibility into, so requiring a positive music match would risk rejecting
// genuine concerts whose category text just doesn't say anything recognised
// as "music". Rejecting only on a clear sports signal is the safer
// direction: worst case a stray sports row slips through unnoticed (same
// as before this fix), never a real concert wrongly discarded.
// CAVEAT: built from what this incident's examples needed (minor-league
// baseball, AHL hockey, NCAA, a Polish handball final) — not verified
// against Awin's full live category taxonomy. Run
// /api/awin-category?q=<a known sports match>&debug=1 to see the real
// category string for a specific row if this list needs extending.
const SPORTS_CATEGORY_KEYWORDS = [
  'sport', 'football', 'soccer', 'baseball', 'basketball', 'hockey',
  'rugby', 'cricket', 'tennis', 'golf', 'boxing', 'mma', 'wrestling',
  'motorsport', 'motor racing', 'nascar', 'formula 1', 'athletics',
  'darts', 'snooker', 'handball', 'volleyball', 'lacrosse', 'ncaa'
];
function looksLikeSportsCategory(category) {
  if (!category) return false; // unknown/missing — never disqualifying on its own
  const c = String(category).toLowerCase();
  return SPORTS_CATEGORY_KEYWORDS.some(kw => c.includes(kw));
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}