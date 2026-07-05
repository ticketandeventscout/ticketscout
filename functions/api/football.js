// ===========================
// TicketScout — Football team page handler
// Runs as a Cloudflare Pages Function at /api/football
// ===========================

const TEAMS = [
  { slug: 'arsenal',              name: 'Arsenal',                 search: 'Arsenal',               tmSearch: 'Arsenal FC',              genre: 'Football', description: 'Arsenal Football Club are one of England\'s most successful clubs, based at the Emirates Stadium in north London. With 13 First Division/Premier League titles and a record 14 FA Cups, the Gunners are one of the most widely supported clubs in the world. Under Mikel Arteta, Arsenal have returned to genuine Premier League title contention.' },
  { slug: 'chelsea',              name: 'Chelsea',                 search: 'Chelsea',               tmSearch: 'Chelsea FC',              genre: 'Football', description: 'Chelsea Football Club, based at Stamford Bridge in west London, are one of England\'s most decorated clubs. With six Premier League titles, multiple Champions League and Europa League wins, Chelsea are a global brand with one of the largest fanbases in world football.' },
  { slug: 'liverpool',            name: 'Liverpool',               search: 'Liverpool',             tmSearch: 'Liverpool FC',            genre: 'Football', description: 'Liverpool FC are one of England\'s most successful clubs and a genuine giant of European football. 19-time English champions and six-time European Cup/Champions League winners, the Reds play at the legendary Anfield stadium and are known worldwide for their passionate supporters.' },
  { slug: 'manchester-united',    name: 'Manchester United',       search: 'Manchester United',     tmSearch: 'Manchester United',       genre: 'Football', description: 'Manchester United are England\'s most successful club by league titles, with 20 First Division/Premier League championships. Based at Old Trafford, United are one of the most widely supported clubs on the planet with a global fanbase estimated at over 1 billion.' },
  { slug: 'manchester-city',      name: 'Manchester City',         search: 'Manchester City',       tmSearch: 'Manchester City',         genre: 'Football', description: 'Manchester City are the current dominant force in English football under Pep Guardiola, having won six of the last eight Premier League titles. City became England\'s first treble winners in 2023 and play at the Etihad Stadium.' },
  { slug: 'tottenham',            name: 'Tottenham Hotspur',       search: 'Tottenham',             tmSearch: 'Tottenham Hotspur',       genre: 'Football', description: 'Tottenham Hotspur are a major north London club based at their stunning new Tottenham Hotspur Stadium. Spurs have a rich history including back-to-back league titles in 1960/61 and reached the Champions League final in 2019.' },
  { slug: 'newcastle',            name: 'Newcastle United',        search: 'Newcastle',             tmSearch: 'Newcastle United',        genre: 'Football', description: 'Newcastle United are a historic north-east club backed by one of the most passionate fanbases in England. Following their 2021 Saudi-led takeover, Newcastle have invested heavily in the squad and are re-establishing themselves among the Premier League\'s top clubs under Eddie Howe.' },
  { slug: 'aston-villa',          name: 'Aston Villa',             search: 'Aston Villa',           tmSearch: 'Aston Villa',             genre: 'Football', description: 'Aston Villa are one of English football\'s founding clubs and European Cup winners in 1982. Based at Villa Park in Birmingham, the club have returned to contending for European qualification under Unai Emery.' },
  { slug: 'west-ham',             name: 'West Ham United',         search: 'West Ham',              tmSearch: 'West Ham United',         genre: 'Football', description: 'West Ham United, based at the London Stadium, are a proud east London club. They produced legends like Bobby Moore, Geoff Hurst and Martin Peters, and won the Europa Conference League in 2023.' },
  { slug: 'brighton',             name: 'Brighton & Hove Albion',  search: 'Brighton',              tmSearch: 'Brighton & Hove Albion',  genre: 'Football', description: 'Brighton & Hove Albion have become one of the Premier League\'s most admired clubs, renowned for their progressive playing style and data-driven recruitment. The Seagulls play at the Amex Stadium.' },
  { slug: 'everton',              name: 'Everton',                 search: 'Everton',               tmSearch: 'Everton FC',              genre: 'Football', description: 'Everton are a founding member of the Football League and one of English football\'s most historic clubs. The Toffees are set to move to their new waterfront stadium at Bramley-Moore Dock.' },
  { slug: 'rangers',              name: 'Rangers',                 search: 'Rangers',               tmSearch: 'Rangers FC',              genre: 'Football', description: 'Rangers FC are one of the most successful clubs in world football by domestic titles, with 55 Scottish top-flight championships. Based at Ibrox Stadium in Glasgow, Rangers are one half of the famous Old Firm rivalry.' },
  { slug: 'celtic',               name: 'Celtic',                  search: 'Celtic',                tmSearch: 'Celtic FC',               genre: 'Football', description: 'Celtic are Scotland\'s most successful club in European competition and one of the few British clubs to have won the European Cup, lifting the trophy in 1967. Based at Celtic Park in Glasgow, the club has a massive global following.' },
  { slug: 'leeds-united',         name: 'Leeds United',            search: 'Leeds United',          tmSearch: 'Leeds United',            genre: 'Football', description: 'Leeds United are a passionate Yorkshire club with a proud history including two First Division titles and a European Fairs Cup win. Known for their fervent fanbase and the iconic Elland Road ground.' },
  { slug: 'wolves',               name: 'Wolverhampton Wanderers', search: 'Wolves',                tmSearch: 'Wolverhampton Wanderers', genre: 'Football', description: 'Wolverhampton Wanderers, known as Wolves, are a historic Midlands club who have established themselves back in the Premier League. Playing at Molineux, Wolves have a loyal fanbase and strong European football heritage.' },
  { slug: 'fulham',               name: 'Fulham',                  search: 'Fulham',                tmSearch: 'Fulham FC',               genre: 'Football', description: 'Fulham FC are a west London club based at the iconic Craven Cottage on the banks of the Thames. Having established themselves back in the Premier League, Fulham are known for their community spirit and one of English football\'s most picturesque grounds.' },
  { slug: 'brentford',            name: 'Brentford',               search: 'Brentford',             tmSearch: 'Brentford FC',            genre: 'Football', description: 'Brentford FC are a west London club who have established themselves in the Premier League following their 2021 promotion. Playing at the modern Gtech Community Stadium, Brentford are known for their innovative data-driven approach under Thomas Frank.' },
  { slug: 'bournemouth',          name: 'Bournemouth',             search: 'Bournemouth',           tmSearch: 'AFC Bournemouth',         genre: 'Football', description: 'AFC Bournemouth are a south coast club who have become established Premier League regulars. Playing at the Vitality Stadium, the Cherries have punched above their weight and continue to attract top-level talent.' },
  { slug: 'crystal-palace',       name: 'Crystal Palace',          search: 'Crystal Palace',        tmSearch: 'Crystal Palace',          genre: 'Football', description: 'Crystal Palace are a south London club with a passionate fanbase and one of the Premier League\'s most atmospheric grounds in Selhurst Park. Known for their eagle mascot and vibrant supporter culture.' },
  { slug: 'nottingham-forest',    name: 'Nottingham Forest',       search: 'Nottingham Forest',     tmSearch: 'Nottingham Forest',       genre: 'Football', description: 'Nottingham Forest are one of English football\'s most storied clubs, having won the European Cup back-to-back in 1979 and 1980. Having returned to the Premier League, Forest are competing at the highest level at the City Ground.' },
  { slug: 'leicester-city',       name: 'Leicester City',          search: 'Leicester City',        tmSearch: 'Leicester City',          genre: 'Football', description: 'Leicester City are famous for their extraordinary Premier League title win in 2015-16, widely regarded as one of the greatest sporting upsets of all time. The Foxes play at the King Power Stadium.' },
  { slug: 'southampton',          name: 'Southampton',             search: 'Southampton',           tmSearch: 'Southampton FC',          genre: 'Football', description: 'Southampton FC, known as the Saints, are a historic south coast club famed for their youth academy which produced legends including Alan Shearer and Gareth Bale. Southampton play at St Mary\'s Stadium.' },
  { slug: 'ipswich',              name: 'Ipswich Town',            search: 'Ipswich',               tmSearch: 'Ipswich Town',            genre: 'Football', description: 'Ipswich Town are a Suffolk club with a proud history including a First Division title in 1962 and UEFA Cup win in 1981. After years away, Ipswich have returned to the Premier League under Kieran McKenna.' },
  { slug: 'watford',              name: 'Watford',                 search: 'Watford',               tmSearch: 'Watford FC',              genre: 'Football', description: 'Watford FC are a Hertfordshire club with a rich history. The Hornets yo-yo between the Premier League and Championship and play at Vicarage Road, one of the most distinctive grounds in English football.' },
  { slug: 'stoke-city',           name: 'Stoke City',              search: 'Stoke City',            tmSearch: 'Stoke City',              genre: 'Football', description: 'Stoke City are a proud Midlands club and one of the 12 founding members of the Football League. The Potters play at the bet365 Stadium and have a loyal Potteries fanbase with ambitions to return to the top flight.' },
  { slug: 'sheffield-united',     name: 'Sheffield United',        search: 'Sheffield United',      tmSearch: 'Sheffield United',        genre: 'Football', description: 'Sheffield United are a Yorkshire club competing in the Championship with ambitions to return to the Premier League. The Blades play at the historic Bramall Lane, one of the world\'s oldest major football stadiums still in use.' },
  { slug: 'sheffield-wednesday',  name: 'Sheffield Wednesday',     search: 'Sheffield Wednesday',   tmSearch: 'Sheffield Wednesday',     genre: 'Football', description: 'Sheffield Wednesday are a historic Yorkshire club and one of England\'s oldest professional football clubs. The Owls play at Hillsborough and have a passionate fanbase with strong ambitions to return to the Premier League.' },
  { slug: 'sunderland',           name: 'Sunderland',              search: 'Sunderland',            tmSearch: 'Sunderland AFC',          genre: 'Football', description: 'Sunderland AFC are a north-east club with a passionate fanbase and storied history. Sunderland have attracted renewed attention following the Netflix documentary series and play at the Stadium of Light.' },
  { slug: 'middlesbrough',        name: 'Middlesbrough',           search: 'Middlesbrough',         tmSearch: 'Middlesbrough FC',        genre: 'Football', description: 'Middlesbrough FC are a north-east club competing in the Championship. Boro won the League Cup in 2004 and reached the UEFA Cup final in 2006, and they continue to push for a return to the top flight at the Riverside Stadium.' },
  { slug: 'hearts',               name: 'Heart of Midlothian',     search: 'Hearts',                tmSearch: 'Heart of Midlothian',     genre: 'Football', description: 'Heart of Midlothian, known as Hearts, are one of Scotland\'s most successful clubs based in Edinburgh. Hearts play at Tynecastle Park and are one half of the Edinburgh derby rivalry with Hibernian.' },
  { slug: 'hibernian',            name: 'Hibernian',               search: 'Hibernian',             tmSearch: 'Hibernian FC',            genre: 'Football', description: 'Hibernian FC, known as Hibs, are an Edinburgh club with a rich history and a famous European pedigree. They were the first British club to play in European competition. Hibs play at Easter Road and are fierce Edinburgh derby rivals with Hearts.' }
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  // Normalise slug — strip common suffixes that TM/search appends
  // e.g. 'chelsea-fc' → 'chelsea', 'manchester-united-fc' → 'manchester-united'
  let normSlug = slug.toLowerCase()
    .replace(/-f-c$/, '')        // trailing -f-c
    .replace(/-fc$/, '')         // trailing -fc  
    .replace(/-afc$/, '')        // trailing -afc (AFC Bournemouth etc)
    .replace(/-football-club$/, '') // trailing -football-club
    .replace(/-soccer$/, '');    // trailing -soccer
  normSlug = normSlug.replace(/-+$/, ''); // clean trailing dashes

  let team = TEAMS.find(t => t.slug === normSlug)
           || TEAMS.find(t => t.slug === slug.toLowerCase()); // fallback to raw slug

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

  // Fallback — try Awin events for this team name (metadata only, not events)
  if (!team) {
    const name = toTitleCase(normSlug.replace(/-/g, ' '));
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

    // Synthesise from slug for any unknown football club — club names are
    // often single words (Fulham, Everton) and KV may have expired.
    // TM lookup will still find them by reconstructed name.
    if (!team) {
      const displayName = toTitleCase(normSlug.replace(/-/g, ' '));
      team = {
        slug:        normSlug,
        name:        displayName,
        search:      displayName,
        tmSearch:    displayName,
        genre:       'Football',
        description: `Compare ${displayName} ticket prices across verified sellers on TicketScout.`
      };
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
          if (normName === normSearch)              score = 100;
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