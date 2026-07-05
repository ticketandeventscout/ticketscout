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
  { slug: 'cabaret',             name: 'Cabaret',                 search: 'Cabaret Musical',        genre: 'West End Musical',  description: 'The smash-hit immersive revival of Cabaret at the Kit Kat Club (Playhouse Theatre) has been one of the most talked-about West End productions in years. Starring in the round with a full cabaret bar and immersive design, this five-star production reimagines the classic Kander and Ebb musical.' }
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

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

  return jsonResponse({
    show: {
      slug:        show.slug,
      name:        show.name,
      genre:       show.genre || 'Theatre',
      description: show.description,
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