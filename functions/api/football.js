// ===========================
// TicketScout — Football team page handler
// Runs as a Cloudflare Pages Function at /api/football
//
// Called by the football template (football.html) on page load.
// Returns team data + Ticketmaster attraction ID for the requested slug.
//
// Usage: GET /api/football?slug=arsenal
// Returns: { team: {...}, attractionId: "...", tmImage: "..." } or { error: "..." }
// ===========================

// Hardcoded top UK football teams — slug, name, SE365 search term, Ticketmaster search term
const TEAMS = [
  { slug: 'arsenal',           name: 'Arsenal',           search: 'Arsenal',           tmSearch: 'Arsenal FC',           genre: 'Football',        description: 'Arsenal Football Club are one of England\'s most successful clubs, based at the Emirates Stadium in north London. With 13 First Division/Premier League titles and a record 14 FA Cups, the Gunners are one of the most widely supported clubs in the world. Under Mikel Arteta, Arsenal have returned to genuine Premier League title contention.' },
  { slug: 'chelsea',           name: 'Chelsea',           search: 'Chelsea',           tmSearch: 'Chelsea FC',           genre: 'Football',        description: 'Chelsea Football Club, based at Stamford Bridge in west London, are one of England\'s most decorated clubs. With six Premier League titles, multiple Champions League and Europa League wins, Chelsea are a global brand with one of the largest fanbases in world football.' },
  { slug: 'liverpool',         name: 'Liverpool',         search: 'Liverpool',         tmSearch: 'Liverpool FC',         genre: 'Football',        description: 'Liverpool FC are one of England\'s most successful clubs and a genuine giant of European football. 19-time English champions and six-time European Cup/Champions League winners, the Reds play at the legendary Anfield stadium and are known worldwide for their passionate supporters.' },
  { slug: 'manchester-united', name: 'Manchester United', search: 'Manchester United', tmSearch: 'Manchester United',   genre: 'Football',        description: 'Manchester United are England\'s most successful club by league titles, with 20 First Division/Premier League championships. Based at Old Trafford — the Theatre of Dreams — United are one of the most widely supported clubs on the planet with a global fanbase estimated at over 1 billion.' },
  { slug: 'manchester-city',   name: 'Manchester City',   search: 'Manchester City',   tmSearch: 'Manchester City',     genre: 'Football',        description: 'Manchester City are the current dominant force in English football under Pep Guardiola, having won six of the last eight Premier League titles. City became England\'s first treble winners in 2023 and play at the Etihad Stadium, one of the most modern arenas in world football.' },
  { slug: 'tottenham',         name: 'Tottenham Hotspur', search: 'Tottenham',         tmSearch: 'Tottenham Hotspur',   genre: 'Football',        description: 'Tottenham Hotspur are a major north London club based at their stunning new Tottenham Hotspur Stadium. Spurs have a rich history including back-to-back league titles in 1960/61, two UEFA Cup wins, and an FA Cup-winning tradition. The club reached the Champions League final in 2019.' },
  { slug: 'newcastle',         name: 'Newcastle United',  search: 'Newcastle',         tmSearch: 'Newcastle United',    genre: 'Football',        description: 'Newcastle United are a historic north-east club backed by one of the most passionate fanbases in England. Following their 2021 Saudi-led takeover, Newcastle have invested heavily in the squad and are re-establishing themselves among the Premier League\'s top clubs under Eddie Howe.' },
  { slug: 'aston-villa',       name: 'Aston Villa',       search: 'Aston Villa',       tmSearch: 'Aston Villa',         genre: 'Football',        description: 'Aston Villa are one of English football\'s founding clubs and European Cup winners in 1982. Based at Villa Park in Birmingham, the club have returned to contending for European qualification under Unai Emery and are once again established in the upper tier of the Premier League.' },
  { slug: 'west-ham',          name: 'West Ham United',   search: 'West Ham',          tmSearch: 'West Ham United',     genre: 'Football',        description: 'West Ham United, based at the London Stadium, are a proud east London club with a rich history including the \'Academy of Football\' tradition that produced legends like Bobby Moore, Geoff Hurst and Martin Peters. West Ham won the Europa Conference League in 2023.' },
  { slug: 'brighton',          name: 'Brighton & Hove Albion', search: 'Brighton',    tmSearch: 'Brighton & Hove Albion', genre: 'Football',     description: 'Brighton & Hove Albion have become one of the Premier League\'s most admired clubs, renowned for their progressive playing style and data-driven recruitment. The Seagulls play at the Amex Stadium and have established themselves as consistent top-half finishers in the Premier League.' },
  { slug: 'everton',           name: 'Everton',           search: 'Everton',           tmSearch: 'Everton FC',          genre: 'Football',        description: 'Everton are a founding member of the Football League and one of English football\'s most historic clubs. The Toffees are set to move to their stunning new waterfront stadium at Bramley-Moore Dock, which will be one of the finest grounds in the Premier League.' },
  { slug: 'rangers',           name: 'Rangers',           search: 'Rangers',           tmSearch: 'Rangers FC',          genre: 'Football',        description: 'Rangers FC are one of the most successful clubs in world football by domestic titles, with 55 Scottish top-flight championships. Based at Ibrox Stadium in Glasgow, Rangers are one half of the famous Old Firm rivalry and have a passionate global support.' },
  { slug: 'celtic',            name: 'Celtic',            search: 'Celtic',            tmSearch: 'Celtic FC',           genre: 'Football',        description: 'Celtic are Scotland\'s most successful club in European competition and one of the few British clubs to have won the European Cup, lifting the trophy in 1967 as the \'Lisbon Lions\'. Based at Celtic Park in Glasgow, the club has a massive global following.' },
  { slug: 'leeds-united',      name: 'Leeds United',      search: 'Leeds United',      tmSearch: 'Leeds United',        genre: 'Football',        description: 'Leeds United are a passionate Yorkshire club with a proud history including two First Division titles and a European Fairs Cup win. Known for their fervent fanbase and the iconic Elland Road ground, Leeds have strong ambitions to return to the Premier League elite.' },
  { slug: 'wolves',            name: 'Wolverhampton Wanderers', search: 'Wolves',     tmSearch: 'Wolverhampton Wanderers', genre: 'Football',    description: 'Wolverhampton Wanderers, known as Wolves, are a historic Midlands club who have established themselves back in the Premier League following their return under the Fosun ownership group. Playing at Molineux, Wolves have a loyal fanbase and strong European football heritage.' }
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let team = TEAMS.find(t => t.slug === normSlug);

  // If not in hardcoded list, check KV for auto-discovered team data
  if (!team) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`football:team:${normSlug}`);
        if (kvData) {
          team = JSON.parse(kvData);
        }
      } catch {}
    }
  }

  // Fallback — try to construct a basic team from the slug
  if (!team) {
    const name = toTitleCase(normSlug.replace(/-/g, ' '));
    // Try Awin events for sports teams
    try {
      const origin   = new URL(request.url).origin;
      const awinUrl  = `${origin}/api/awin-events?name=${encodeURIComponent(name)}&size=1`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        if (awinData.events && awinData.events.length > 0) {
          team = {
            slug:        normSlug,
            name,
            search:      name,
            tmSearch:    name,
            genre:       'Football',
            description: `Compare ${name} ticket prices across verified sellers. Find the best deals on ${name} match tickets and buy direct from verified sellers.`
          };
        }
      }
    } catch {}

    if (!team) {
      return jsonResponse({ error: 'Team not found' }, 404);
    }
  }

  // Resolve Ticketmaster attraction ID for this team
  const apiKey = env.TM_API_KEY;
  let attractionId = null;
  let tmImage      = null;

  if (apiKey) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', team.tmSearch || team.search);
      tmUrl.searchParams.set('classificationName', 'Sports');
      tmUrl.searchParams.set('size', '10');

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        const normSearch = (team.tmSearch || team.search).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

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
    team: {
      slug:        team.slug,
      name:        team.name,
      genre:       team.genre || 'Football',
      description: team.description,
      search:      team.search
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
