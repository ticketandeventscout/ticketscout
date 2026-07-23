// ===========================
// TicketScout — Theatre show page handler
// Runs as a Cloudflare Pages Function at /api/theatre
//
// Called by the theatre template (theatre.html) on page load.
// Returns show data + Ticketmaster attraction ID for the requested slug.
//
// Usage: GET /api/theatre?slug=the-lion-king
// Returns: { show: {...}, attractionId: "...", tmImage: "..." } or { error: "..." }
// ===========================

// Hardcoded priority West End and touring shows
const SHOWS = [
{ slug: 'the-lion-king',       name: 'The Lion King',           search: 'The Lion King',          genre: 'West End Musical',  description: 'The Lion King is one of the longest-running and best-loved West End musicals, having played continuously in London since 1999. Based on the Disney film, the show features spectacular costumes, innovative puppetry and an iconic score by Elton John and Tim Rice. It plays at the Lyceum Theatre in the heart of London\'s West End.' },
  { slug: 'wicked',              name: 'Wicked',                  search: 'Wicked',                 genre: 'West End Musical',  description: 'Wicked tells the untold story of the witches of Oz and has become one of the most successful musicals in Broadway and West End history. With its iconic score including \'Defying Gravity\' and \'Popular\', the show has run continuously in London\'s West End since 2006 and continues to sell out nightly.' },
  { slug: 'hamilton',            name: 'Hamilton',                search: 'Hamilton',               genre: 'West End Musical',  description: 'Hamilton is a groundbreaking musical by Lin-Manuel Miranda that retells the story of American Founding Father Alexander Hamilton through hip-hop, jazz and R&B. Since its London opening in 2017, it has been one of the hottest tickets in the West End, winning multiple Olivier Awards.' },
  { slug: 'phantom-of-the-opera', name: 'The Phantom of the Opera', search: 'Phantom of the Opera', genre: 'West End Musical', description: 'Andrew Lloyd Webber\'s The Phantom of the Opera was the longest-running show in West End history. The iconic musical, featuring the unforgettable \'Music of the Night\' and the spectacular chandelier drop, continues to tour the UK and play to sell-out audiences worldwide.' },
  { slug: 'moulin-rouge',        name: 'Moulin Rouge! The Musical', search: 'Moulin Rouge',         genre: 'West End Musical',  description: 'Moulin Rouge! The Musical is a spectacular celebration of love set in the iconic Paris cabaret, featuring an intoxicating mix of pop hits from across the decades and spectacular staging. The show plays at the Piccadilly Theatre in the West End and has won multiple Olivier and Tony Awards.' },
  { slug: 'back-to-the-future',  name: 'Back to the Future: The Musical', search: 'Back to the Future Musical', genre: 'West End Musical', description: 'Back to the Future: The Musical brings the classic 1985 film to the stage with new songs and innovative theatrical effects including a flying DeLorean. Playing at the Adelphi Theatre in London\'s West End, the show has been a massive hit with audiences of all ages since its world premiere in Manchester.' },
  { slug: 'les-miserables',      name: 'Les Misérables',          search: 'Les Miserables',         genre: 'West End Musical',  description: 'Les Misérables is one of the world\'s most beloved musicals, with its sweeping score featuring classics such as \'I Dreamed a Dream\', \'One Day More\' and \'Bring Him Home\'. The show has been running in London\'s West End since 1985, making it one of the longest-running musicals of all time.' },
  { slug: 'mamma-mia',           name: 'Mamma Mia!',              search: 'Mamma Mia',              genre: 'West End Musical',  description: 'Mamma Mia! features the smash-hit songs of ABBA in a feel-good story of love, friendship and family on a Greek island. The show has been a worldwide phenomenon since its 1999 London premiere and continues to delight audiences across the UK on tour.' },
  { slug: 'operation-mincemeat', name: 'Operation Mincemeat',     search: 'Operation Mincemeat',    genre: 'West End Musical',  description: 'Operation Mincemeat: A New Musical is a critically acclaimed and Olivier Award-winning musical that tells the extraordinary true story of a WWII deception operation. After a sell-out run at the Fortune Theatre, the show has transferred to become one of the West End\'s most talked-about productions.' },
  { slug: '&juliet',             name: '& Juliet',                search: '& Juliet',               genre: 'West End Musical',  description: '& Juliet is an exhilarating musical asking: what if Juliet didn\'t die? Featuring chart-topping pop hits by Max Martin — from Backstreet Boys to Katy Perry to Britney Spears — this joyful and liberating show has been a West End smash hit since its opening at the Shaftesbury Theatre.' },
  { slug: 'chicago',             name: 'Chicago',                 search: 'Chicago Musical',        genre: 'West End Musical',  description: 'Chicago is one of Broadway and the West End\'s longest-running shows, a dazzling celebration of showbiz and razzle-dazzle. The award-winning musical follows Roxie Hart in 1920s Chicago and features iconic numbers including \'All That Jazz\', \'Cell Block Tango\' and \'Razzle Dazzle\'.' },
  { slug: 'standing-at-the-sky-edge', name: 'Standing at the Sky\'s Edge', search: 'Standing at the Sky\'s Edge', genre: 'Musical', description: 'Standing at the Sky\'s Edge is a critically acclaimed, Olivier Award-winning musical featuring the music of Richard Hawley. The story spans three generations of families living in Park Hill flats in Sheffield, weaving together themes of love, loss and regeneration.' },
  { slug: 'guys-and-dolls',      name: 'Guys and Dolls',          search: 'Guys and Dolls',         genre: 'Musical',           description: 'Guys and Dolls is one of the greatest American musicals ever written, set in the colourful world of New York gamblers and showgirls. The Bridge Theatre production starring Daniel Mays and Marisha Wallace has been one of the most acclaimed West End revivals in years.' },
  { slug: 'cabaret',             name: 'Cabaret',                 search: 'Cabaret Musical',        genre: 'West End Musical',  description: 'The smash-hit immersive revival of Cabaret at the Kit Kat Club (Playhouse Theatre) has been one of the most talked-about West End productions in years. Starring in the round with a full cabaret bar and immersive design, this five-star production reimagines the classic Kander and Ebb musical.' },
  { slug: 'absinthe', name: 'Absinthe', search: 'Absinthe', genre: 'Theatre', description: 'Compare Absinthe ticket prices across verified sellers.' },
  { slug: 'atomic-saloon-show', name: 'Atomic Saloon Show', search: 'Atomic Saloon Show', genre: 'Theatre', description: 'Compare Atomic Saloon Show ticket prices across verified sellers.' },
  { slug: 'dear-evan-hansen', name: 'Dear Evan Hansen', search: 'Dear Evan Hansen', genre: 'Theatre', description: 'Compare Dear Evan Hansen ticket prices across verified sellers.' },
  { slug: 'awakening', name: 'Awakening', search: 'Awakening', genre: 'Theatre', description: 'Compare Awakening ticket prices across verified sellers.' },
  { slug: 'fantasy', name: 'Fantasy', search: 'Fantasy', genre: 'Theatre', description: 'Compare Fantasy ticket prices across verified sellers.' },
  { slug: 'discovering-king-tuts-tomb', name: 'Discovering King Tuts Tomb', search: 'Discovering King Tuts Tomb', genre: 'Theatre', description: 'Compare Discovering King Tuts Tomb ticket prices across verified sellers.' },
  { slug: 'fly-linq-zipline', name: 'Fly Linq Zipline', search: 'Fly Linq Zipline', genre: 'Theatre', description: 'Compare Fly Linq Zipline ticket prices across verified sellers.' },
  { slug: 'high-roller-wheel', name: 'High Roller Wheel', search: 'High Roller Wheel', genre: 'Theatre', description: 'Compare High Roller Wheel ticket prices across verified sellers.' },
  { slug: 'eiffel-tower-viewing-deck', name: 'Eiffel Tower Viewing Deck', search: 'Eiffel Tower Viewing Deck', genre: 'Theatre', description: 'Compare Eiffel Tower Viewing Deck ticket prices across verified sellers.' },
  { slug: 'bodies', name: 'Bodies', search: 'Bodies', genre: 'Theatre', description: 'Compare Bodies ticket prices across verified sellers.' },
  { slug: 'elf-the-musical', name: 'Elf The Musical', search: 'Elf The Musical', genre: 'Theatre', description: 'Compare Elf The Musical ticket prices across verified sellers.' },
  { slug: 'much-ado-about-nothing', name: 'Much Ado About Nothing', search: 'Much Ado About Nothing', genre: 'Theatre', description: 'Compare Much Ado About Nothing ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil', name: 'Cirque Du Soleil', search: 'Cirque Du Soleil', genre: 'Theatre', description: 'Compare Cirque Du Soleil ticket prices across verified sellers.' },
  { slug: 'the-nutcracker', name: 'The Nutcracker', search: 'The Nutcracker', genre: 'Theatre', description: 'Compare The Nutcracker ticket prices across verified sellers.' },
  { slug: 'paddington', name: 'Paddington', search: 'Paddington', genre: 'Theatre', description: 'Compare Paddington ticket prices across verified sellers.' },
  { slug: 'the-phantom-of-the-opera', name: 'The Phantom Of The Opera', search: 'The Phantom Of The Opera', genre: 'Theatre', description: 'Compare The Phantom Of The Opera ticket prices across verified sellers.' },
  { slug: 'oh-mary', name: 'Oh Mary', search: 'Oh Mary', genre: 'Theatre', description: 'Compare Oh Mary ticket prices across verified sellers.' },
  { slug: 'the-outsiders', name: 'The Outsiders', search: 'The Outsiders', genre: 'Theatre', description: 'Compare The Outsiders ticket prices across verified sellers.' },
  { slug: 'the-great-gatsby', name: 'The Great Gatsby', search: 'The Great Gatsby', genre: 'Theatre', description: 'Compare The Great Gatsby ticket prices across verified sellers.' },
  { slug: 'frozen', name: 'Frozen', search: 'Frozen', genre: 'Theatre', description: 'Compare Frozen ticket prices across verified sellers.' },
  { slug: 'stranger-things-the-first-shadow', name: 'Stranger Things The First Shadow', search: 'Stranger Things The First Shadow', genre: 'Theatre', description: 'Compare Stranger Things The First Shadow ticket prices across verified sellers.' },
  { slug: 'shin-lim', name: 'Shin Lim', search: 'Shin Lim', genre: 'Theatre', description: 'Compare Shin Lim ticket prices across verified sellers.' },
  { slug: 'sinatra-the-musical', name: 'Sinatra The Musical', search: 'Sinatra The Musical', genre: 'Theatre', description: 'Compare Sinatra The Musical ticket prices across verified sellers.' },
  { slug: 'the-sound-of-music', name: 'The Sound Of Music', search: 'The Sound Of Music', genre: 'Theatre', description: 'Compare The Sound Of Music ticket prices across verified sellers.' },
  { slug: 'paranormal-activity', name: 'Paranormal Activity', search: 'Paranormal Activity', genre: 'Theatre', description: 'Compare Paranormal Activity ticket prices across verified sellers.' },
  { slug: 'the-lost-boys', name: 'The Lost Boys', search: 'The Lost Boys', genre: 'Theatre', description: 'Compare The Lost Boys ticket prices across verified sellers.' },
  { slug: 'mj-live', name: 'Mj Live', search: 'Mj Live', genre: 'Theatre', description: 'Compare Mj Live ticket prices across verified sellers.' },
  { slug: 'the-notebook', name: 'The Notebook', search: 'The Notebook', genre: 'Theatre', description: 'Compare The Notebook ticket prices across verified sellers.' },
  { slug: 'the-mousetrap', name: 'The Mousetrap', search: 'The Mousetrap', genre: 'Theatre', description: 'Compare The Mousetrap ticket prices across verified sellers.' },
  { slug: 'the-devil-wears-prada', name: 'The Devil Wears Prada', search: 'The Devil Wears Prada', genre: 'Theatre', description: 'Compare The Devil Wears Prada ticket prices across verified sellers.' },
  { slug: 'tournament-of-kings', name: 'Tournament Of Kings', search: 'Tournament Of Kings', genre: 'Theatre', description: 'Compare Tournament Of Kings ticket prices across verified sellers.' },
  { slug: 'boop-the-betty-boop-musical', name: 'Boop The Betty Boop Musical', search: 'Boop The Betty Boop Musical', genre: 'Theatre', description: 'Compare Boop The Betty Boop Musical ticket prices across verified sellers.' },
  { slug: 'thunder-from-down-under', name: 'Thunder From Down Under', search: 'Thunder From Down Under', genre: 'Theatre', description: 'Compare Thunder From Down Under ticket prices across verified sellers.' },
  { slug: 'cats-the-jellicle-ball', name: 'Cats The Jellicle Ball', search: 'Cats The Jellicle Ball', genre: 'Theatre', description: 'Compare Cats The Jellicle Ball ticket prices across verified sellers.' },
  { slug: 'rouge', name: 'Rouge', search: 'Rouge', genre: 'Theatre', description: 'Compare Rouge ticket prices across verified sellers.' },
  { slug: 'my-neighbour-totoro', name: 'My Neighbour Totoro', search: 'My Neighbour Totoro', genre: 'Theatre', description: 'Compare My Neighbour Totoro ticket prices across verified sellers.' },
  { slug: 'schmigadoon', name: 'Schmigadoon', search: 'Schmigadoon', genre: 'Theatre', description: 'Compare Schmigadoon ticket prices across verified sellers.' },
  { slug: 'billy-elliot', name: 'Billy Elliot', search: 'Billy Elliot', genre: 'Theatre', description: 'Compare Billy Elliot ticket prices across verified sellers.' },
  { slug: 'wanted', name: 'Wanted', search: 'Wanted', genre: 'Theatre', description: 'Compare Wanted ticket prices across verified sellers.' },
  { slug: 'wow', name: 'Wow', search: 'Wow', genre: 'Theatre', description: 'Compare Wow ticket prices across verified sellers.' },
  { slug: 'water-for-elephants', name: 'Water For Elephants', search: 'Water For Elephants', genre: 'Theatre', description: 'Compare Water For Elephants ticket prices across verified sellers.' },
  { slug: 'popovich-comedy-pet-theater', name: 'Popovich Comedy Pet Theater', search: 'Popovich Comedy Pet Theater', genre: 'Theatre', description: 'Compare Popovich Comedy Pet Theater ticket prices across verified sellers.' }
];


// ── Hub listing: /api/theatre?list=1 ──────────────────────────────────────
// Ported from sports.js. Also powers the Theatre pill on the home page:
// Ticketmaster's Arts & Theatre segment returns a single production at any
// page size (measured 23 Jul — 1 unique attraction from 100 rows, because a
// West End run fills every slot), so the registry is the only usable source.
const HUB_INDEX_KEY = 'theatre:hub:index';
const HUB_INDEX_TTL = 6 * 60 * 60;
const HUB_BUILD_CAP = 600;

// Stored theatre genres are already clean ('West End Musical', 'Musical',
// 'Play', 'Opera'), so unlike concerts they need only an allow-list.
const THEATRE_GENRES = new Set([
  'West End Musical', 'Musical', 'Play', 'Opera', 'Ballet',
  'Dance', 'Comedy', 'Pantomime', 'Circus'
]);

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
    slugs = Object.keys((reg && reg.sections && reg.sections.theatre) || {}).sort();
  } catch { /* empty registry — return an empty hub rather than erroring */ }

  const entities = [];
  const genreCounts = new Map();
  for (const s of slugs.slice(0, HUB_BUILD_CAP)) {
    let name = toTitleCase(s.replace(/-/g, ' '));
    let genre = 'Other';
    try {
      const raw = await kv.get('theatre:show:' + s);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec.name) name = rec.name;
        if (THEATRE_GENRES.has(rec.genre)) genre = rec.genre;
      }
    } catch { /* keep the de-slugged fallback */ }
    entities.push({ slug: s, name, genre, url: '/theatre/' + s });
    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
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

  if (url.searchParams.get('inspect') === '1') return inspectRecords(env, 'theatre', 'theatre:show:');
  if (url.searchParams.get('list') === '1') return listEntities(env, url);

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let show = SHOWS.find(s => s.slug === normSlug);

  // If not in hardcoded list, check KV for auto-discovered show data
  if (!show) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`theatre:show:${normSlug}`);
        if (kvData) {
          show = JSON.parse(kvData);
        }
      } catch {}
    }
  }

  // Fallback — check Awin events (Theatre Tickets Direct is in Awin feed)
  if (!show) {
    const name = normSlug.replace(/-/g, ' ');
    try {
      const origin   = new URL(request.url).origin;
      const awinUrl  = `${origin}/api/awin-events?name=${encodeURIComponent(name)}&size=1`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        if (awinData.events && awinData.events.length > 0) {
          const ev          = awinData.events[0];
          const displayName = toTitleCase(name);
          const rawDesc     = (ev.description || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim();
          show = {
            slug:        normSlug,
            name:        displayName,
            search:      displayName,
            genre:       ev.category || 'Theatre',
            description: rawDesc.slice(0, 300) || `Compare ${displayName} ticket prices across verified sellers.`
          };
        }
      }
    } catch {}

    // Slug-based fallback — if Awin has nothing but the slug contains a hyphen,
    // it is likely a valid auto-discovered show whose KV data has expired.
    // Synthesise from the slug so TM lookup and the page still work.
    // Single-word slugs with no data anywhere are likely misspellings — still 404.
    if (!show) {
      if (normSlug.includes('-')) {
        const displayName = toTitleCase(normSlug.replace(/-/g, ' '));
        show = {
          slug:        normSlug,
          name:        displayName,
          search:      displayName,
          genre:       'Theatre',
          description: `Compare ${displayName} ticket prices across verified sellers on TicketScout.`
        };
      } else {
        return jsonResponse({ error: 'Show not found' }, 404);
      }
    }
  }

  // Resolve Ticketmaster attraction ID
  const apiKey = env.TM_API_KEY;
  let attractionId = null;
  let tmImage      = null;

  if (apiKey) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', show.search);
      tmUrl.searchParams.set('classificationName', 'Arts & Theatre');
      tmUrl.searchParams.set('size', '10');

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        const normSearch = show.search.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        const scored = attractions.map(a => {
          const normName = (a.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          let score = 0;
          if (normName === normSearch)             score = 100;
          else if (normName.startsWith(normSearch)) score = 50;
          else if (normName.includes(normSearch))   score = 20;
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
      const m = await ekv.get(`entity:meta:theatre:${show.slug}`);
      if (m) {
        const meta = JSON.parse(m);
        enrichFacts = meta.facts || null;
        const generic = !show.description || /^Compare .{0,80} ticket prices across verified sellers/.test(show.description);
        if (meta.aboutText && generic) show.description = meta.aboutText;
      }
    }
  } catch {}

  return jsonResponse({
    show: {
      slug:        show.slug,
      name:        show.name,
      genre:       show.genre || 'Theatre',
      description: show.description,
      facts:       enrichFacts,
      search:      show.search
    },
    attractionId,
    tmImage
  }, 200);
}

function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
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