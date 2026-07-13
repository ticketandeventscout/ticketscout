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
  { slug: 'a-christmas-carol', name: 'A Christmas Carol', search: 'A Christmas Carol', genre: 'Live Events', description: 'Compare A Christmas Carol ticket prices across verified sellers.' },
  { slug: 'little-shop-of-horrors', name: 'Little Shop of Horrors', search: 'Little Shop of Horrors', genre: 'Live Events', description: 'Compare Little Shop of Horrors ticket prices across verified sellers.' },
  { slug: 'maybe-happy-ending', name: 'Maybe Happy Ending', search: 'Maybe Happy Ending', genre: 'Live Events', description: 'Compare Maybe Happy Ending ticket prices across verified sellers.' },
  { slug: 'buena-vista-social-club', name: 'Buena Vista Social Club', search: 'Buena Vista Social Club', genre: 'Live Events', description: 'Compare Buena Vista Social Club ticket prices across verified sellers.' },
  { slug: 'blue-man-group', name: 'Blue Man Group', search: 'Blue Man Group', genre: 'Live Events', description: 'Compare Blue Man Group ticket prices across verified sellers.' },
  { slug: 'magic-mike-live', name: 'Magic Mike Live', search: 'Magic Mike Live', genre: 'Live Events', description: 'Compare Magic Mike Live ticket prices across verified sellers.' },
  { slug: 'jabbawockeez', name: 'Jabbawockeez', search: 'Jabbawockeez', genre: 'Live Events', description: 'Compare Jabbawockeez ticket prices across verified sellers.' },
  { slug: 'dolly', name: 'Dolly', search: 'Dolly', genre: 'Live Events', description: 'Compare Dolly ticket prices across verified sellers.' },
  { slug: 'all-motown', name: 'All Motown', search: 'All Motown', genre: 'Live Events', description: 'Compare All Motown ticket prices across verified sellers.' },
  { slug: 'all-shook-up', name: 'All Shook Up', search: 'All Shook Up', genre: 'Live Events', description: 'Compare All Shook Up ticket prices across verified sellers.' },
  { slug: 'candlelight', name: 'Candlelight', search: 'Candlelight', genre: 'Live Events', description: 'Compare Candlelight ticket prices across verified sellers.' },
  { slug: 'death-becomes-her', name: 'Death Becomes Her', search: 'Death Becomes Her', genre: 'Live Events', description: 'Compare Death Becomes Her ticket prices across verified sellers.' },
  { slug: 'comedy-cellar', name: 'Comedy Cellar', search: 'Comedy Cellar', genre: 'Live Events', description: 'Compare Comedy Cellar ticket prices across verified sellers.' },
  { slug: 'beetlejuice', name: 'BeetleJuice', search: 'BeetleJuice', genre: 'Live Events', description: 'Compare BeetleJuice ticket prices across verified sellers.' },
  { slug: 'evita', name: 'Evita', search: 'Evita', genre: 'Live Events', description: 'Compare Evita ticket prices across verified sellers.' },
  { slug: 'hells-kitchen', name: 'Hells Kitchen', search: 'Hells Kitchen', genre: 'Live Events', description: 'Compare Hells Kitchen ticket prices across verified sellers.' },
  { slug: 'matilda', name: 'Matilda', search: 'Matilda', genre: 'Live Events', description: 'Compare Matilda ticket prices across verified sellers.' },
  { slug: 'daniel', name: 'Daniel', search: 'Daniel', genre: 'Live Events', description: 'Compare Daniel ticket prices across verified sellers.' },
  { slug: 'juliet', name: '& Juliet', search: '& Juliet', genre: 'Live Events', description: 'Compare & Juliet ticket prices across verified sellers.' },
  { slug: 'annie', name: 'Annie', search: 'Annie', genre: 'Live Events', description: 'Compare Annie ticket prices across verified sellers.' },
  { slug: 'mat-franco', name: 'Mat Franco', search: 'Mat Franco', genre: 'Live Events', description: 'Compare Mat Franco ticket prices across verified sellers.' },
  { slug: 'hairspray', name: 'Hairspray', search: 'Hairspray', genre: 'Live Events', description: 'Compare Hairspray ticket prices across verified sellers.' },
  { slug: 'disney-on-ice', name: 'Disney On Ice', search: 'Disney On Ice', genre: 'Live Events', description: 'Compare Disney On Ice ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-ka', name: 'Cirque du Soleil KA', search: 'Cirque du Soleil KA', genre: 'Live Events', description: 'Compare Cirque du Soleil KA ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-mystere', name: 'Cirque du Soleil Mystere', search: 'Cirque du Soleil Mystere', genre: 'Live Events', description: 'Compare Cirque du Soleil Mystere ticket prices across verified sellers.' },
  { slug: 'galileo', name: 'Galileo', search: 'Galileo', genre: 'Live Events', description: 'Compare Galileo ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-auana', name: 'Cirque du Soleil Auana', search: 'Cirque du Soleil Auana', genre: 'Live Events', description: 'Compare Cirque du Soleil Auana ticket prices across verified sellers.' },
  { slug: 'garden-brothers-nuclear-circus', name: 'Garden Brothers Nuclear Circus', search: 'Garden Brothers Nuclear Circus', genre: 'Live Events', description: 'Compare Garden Brothers Nuclear Circus ticket prices across verified sellers.' },
  { slug: 'christmas-spectacular-starring-the-radio-city-rockettes', name: 'Christmas Spectacular Starring The Radio City Rockettes', search: 'Christmas Spectacular Starring The Radio City Rockettes', genre: 'Live Events', description: 'Compare Christmas Spectacular Starring The Radio City Rockettes ticket prices across verified sellers.' },
  { slug: 'eddie-griffin', name: 'Eddie Griffin', search: 'Eddie Griffin', genre: 'Live Events', description: 'Compare Eddie Griffin ticket prices across verified sellers.' },
  { slug: 'grand-shanghai-circus', name: 'Grand Shanghai Circus', search: 'Grand Shanghai Circus', genre: 'Live Events', description: 'Compare Grand Shanghai Circus ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-mad-apple', name: 'Cirque du Soleil Mad Apple', search: 'Cirque du Soleil Mad Apple', genre: 'Live Events', description: 'Compare Cirque du Soleil Mad Apple ticket prices across verified sellers.' },
  { slug: 'cats', name: 'Cats', search: 'Cats', genre: 'Live Events', description: 'Compare Cats ticket prices across verified sellers.' },
  { slug: 'beauty-and-the-beast', name: 'Beauty And The Beast', search: 'Beauty And The Beast', genre: 'Live Events', description: 'Compare Beauty And The Beast ticket prices across verified sellers.' },
  { slug: 'chippendales', name: 'Chippendales', search: 'Chippendales', genre: 'Live Events', description: 'Compare Chippendales ticket prices across verified sellers.' },
  { slug: 'laugh-factory', name: 'Laugh Factory', search: 'Laugh Factory', genre: 'Live Events', description: 'Compare Laugh Factory ticket prices across verified sellers.' },
  { slug: 'big-black-comedy-show', name: 'Big Black Comedy Show', search: 'Big Black Comedy Show', genre: 'Live Events', description: 'Compare Big Black Comedy Show ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-o', name: 'Cirque Du Soleil O', search: 'Cirque Du Soleil O', genre: 'Live Events', description: 'Compare Cirque Du Soleil O ticket prices across verified sellers.' },
  { slug: 'aladdin', name: 'Aladdin', search: 'Aladdin', genre: 'Live Events', description: 'Compare Aladdin ticket prices across verified sellers.' },
  { slug: 'jamie-allans-amaze', name: 'Jamie Allan\'s Amaze', search: 'Jamie Allan\'s Amaze', genre: 'Live Events', description: 'Compare Jamie Allan\'s Amaze ticket prices across verified sellers.' },
  { slug: 'adam-london-laughternoon', name: 'Adam London Laughternoon', search: 'Adam London Laughternoon', genre: 'Live Events', description: 'Compare Adam London Laughternoon ticket prices across verified sellers.' },
  { slug: 'metropolitan-opera', name: 'Metropolitan Opera', search: 'Metropolitan Opera', genre: 'Live Events', description: 'Compare Metropolitan Opera ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-drawn-to-life', name: 'Cirque du Soleil Drawn to Life', search: 'Cirque du Soleil Drawn to Life', genre: 'Live Events', description: 'Compare Cirque du Soleil Drawn to Life ticket prices across verified sellers.' },
  { slug: 'just-in-time', name: 'Just In Time', search: 'Just In Time', genre: 'Live Events', description: 'Compare Just In Time ticket prices across verified sellers.' },
  { slug: 'mean-girls', name: 'Mean Girls', search: 'Mean Girls', genre: 'Live Events', description: 'Compare Mean Girls ticket prices across verified sellers.' },
  { slug: 'drunk-pirates', name: 'Drunk Pirates', search: 'Drunk Pirates', genre: 'Live Events', description: 'Compare Drunk Pirates ticket prices across verified sellers.' },
  { slug: 'blueys-big-play', name: 'Bluey\'s Big Play', search: 'Bluey\'s Big Play', genre: 'Live Events', description: 'Compare Bluey\'s Big Play ticket prices across verified sellers.' },
  { slug: 'joseph-and-the-amazing-technicolor-dreamcoat', name: 'JOSEPH AND THE AMAZING TECHNICOLOR DREAMCOAT', search: 'JOSEPH AND THE AMAZING TECHNICOLOR DREAMCOAT', genre: 'Live Events', description: 'Compare JOSEPH AND THE AMAZING TECHNICOLOR DREAMCOAT ticket prices across verified sellers.' },
  { slug: 'la-comedy-club', name: 'LA Comedy Club', search: 'LA Comedy Club', genre: 'Live Events', description: 'Compare LA Comedy Club ticket prices across verified sellers.' },
  { slug: 'a-beautiful-noise', name: 'A Beautiful Noise', search: 'A Beautiful Noise', genre: 'Live Events', description: 'Compare A Beautiful Noise ticket prices across verified sellers.' },
  { slug: 'boop-the-musical', name: 'Boop The Musical', search: 'Boop The Musical', genre: 'Live Events', description: 'Compare Boop The Musical ticket prices across verified sellers.' },
  { slug: 'menopause-the-musical', name: 'Menopause The Musical', search: 'Menopause The Musical', genre: 'Live Events', description: 'Compare Menopause The Musical ticket prices across verified sellers.' },
  { slug: 'le-grand-cirque', name: 'Le Grand Cirque', search: 'Le Grand Cirque', genre: 'Live Events', description: 'Compare Le Grand Cirque ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-michael-jackson-one', name: 'Cirque du Soleil: Michael Jackson ONE', search: 'Cirque du Soleil: Michael Jackson ONE', genre: 'Live Events', description: 'Compare Cirque du Soleil: Michael Jackson ONE ticket prices across verified sellers.' },
  { slug: 'heathers', name: 'Heathers', search: 'Heathers', genre: 'Live Events', description: 'Compare Heathers ticket prices across verified sellers.' },
  { slug: 'legends-in-concert', name: 'Legends In Concert', search: 'Legends In Concert', genre: 'Live Events', description: 'Compare Legends In Concert ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-luzia', name: 'Cirque Du Soleil Luzia', search: 'Cirque Du Soleil Luzia', genre: 'Live Events', description: 'Compare Cirque Du Soleil Luzia ticket prices across verified sellers.' },
  { slug: 'delirious-comedy-club', name: 'Delirious Comedy Club', search: 'Delirious Comedy Club', genre: 'Live Events', description: 'Compare Delirious Comedy Club ticket prices across verified sellers.' },
  { slug: 'circus-vazquez', name: 'Circus Vazquez', search: 'Circus Vazquez', genre: 'Live Events', description: 'Compare Circus Vazquez ticket prices across verified sellers.' },
  { slug: 'joshua', name: 'Joshua', search: 'Joshua', genre: 'Live Events', description: 'Compare Joshua ticket prices across verified sellers.' },
  { slug: 'an-r-rated-magic-show', name: 'An R-Rated Magic Show', search: 'An R-Rated Magic Show', genre: 'Live Events', description: 'Compare An R-Rated Magic Show ticket prices across verified sellers.' },
  { slug: 'los-angeles-philharmonic', name: 'Los Angeles Philharmonic', search: 'Los Angeles Philharmonic', genre: 'Live Events', description: 'Compare Los Angeles Philharmonic ticket prices across verified sellers.' },
  { slug: 'chicago-architecture-center-river-cruise', name: 'Chicago Architecture Center River Cruise', search: 'Chicago Architecture Center River Cruise', genre: 'Live Events', description: 'Compare Chicago Architecture Center River Cruise ticket prices across verified sellers.' },
  { slug: 'beautiful', name: 'Beautiful', search: 'Beautiful', genre: 'Live Events', description: 'Compare Beautiful ticket prices across verified sellers.' },
  { slug: 'how-the-grinch-stole-christmas', name: 'How The Grinch Stole Christmas', search: 'How The Grinch Stole Christmas', genre: 'Live Events', description: 'Compare How The Grinch Stole Christmas ticket prices across verified sellers.' },
  { slug: 'carrot-top', name: 'Carrot Top', search: 'Carrot Top', genre: 'Live Events', description: 'Compare Carrot Top ticket prices across verified sellers.' },
  { slug: 'anastasia', name: 'Anastasia', search: 'Anastasia', genre: 'Live Events', description: 'Compare Anastasia ticket prices across verified sellers.' },
  { slug: 'david-goldrake', name: 'David Goldrake', search: 'David Goldrake', genre: 'Live Events', description: 'Compare David Goldrake ticket prices across verified sellers.' },
  { slug: 'the-wizard-of-oz', name: 'The Wizard Of Oz', search: 'The Wizard Of Oz', genre: 'Live Events', description: 'Compare The Wizard Of Oz ticket prices across verified sellers.' },
  { slug: 'garden-bros-nuclear-circus', name: 'Garden Bros Nuclear Circus', search: 'Garden Bros Nuclear Circus', genre: 'Live Events', description: 'Compare Garden Bros Nuclear Circus ticket prices across verified sellers.' },
  { slug: 'second-city-mainstage-revue', name: 'Second City Mainstage Revue', search: 'Second City Mainstage Revue', genre: 'Live Events', description: 'Compare Second City Mainstage Revue ticket prices across verified sellers.' },
  { slug: 'piano-man', name: 'Piano Man', search: 'Piano Man', genre: 'Live Events', description: 'Compare Piano Man ticket prices across verified sellers.' },
  { slug: 'radio-city-christmas-spectacular', name: 'Radio City Christmas Spectacular', search: 'Radio City Christmas Spectacular', genre: 'Live Events', description: 'Compare Radio City Christmas Spectacular ticket prices across verified sellers.' },
  { slug: 'shanghai-circus', name: 'Shanghai Circus', search: 'Shanghai Circus', genre: 'Live Events', description: 'Compare Shanghai Circus ticket prices across verified sellers.' },
  { slug: 'the-empire-strips-back', name: 'The Empire Strips Back', search: 'The Empire Strips Back', genre: 'Live Events', description: 'Compare The Empire Strips Back ticket prices across verified sellers.' },
  { slug: 'piff-the-magic-dragon', name: 'Piff the Magic Dragon', search: 'Piff the Magic Dragon', genre: 'Live Events', description: 'Compare Piff the Magic Dragon ticket prices across verified sellers.' },
  { slug: 'venardos-circus', name: 'Venardos Circus', search: 'Venardos Circus', genre: 'Live Events', description: 'Compare Venardos Circus ticket prices across verified sellers.' },
  { slug: 'rupauls-drag-race', name: 'Rupaul\'s Drag Race', search: 'Rupaul\'s Drag Race', genre: 'Live Events', description: 'Compare Rupaul\'s Drag Race ticket prices across verified sellers.' },
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let artist = ARTISTS.find(a => a.slug === normSlug);

  // If not in the hardcoded list, check KV for auto-discovered artist data
  if (!artist) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`concert:artist:${normSlug}`);
        if (kvData) {
          artist = JSON.parse(kvData);
        }
      } catch {}
    }
  }

  // Fallback — check Awin events for any unknown slug
  if (!artist) {
    const name = normSlug.replace(/-/g, ' ');
    try {
      const origin  = new URL(request.url).origin;
      const awinUrl = `${origin}/api/awin-events?name=${encodeURIComponent(name)}&size=1`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        if (awinData.events && awinData.events.length > 0) {
          const ev          = awinData.events[0];
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

  return jsonResponse({
    artist: {
      slug:        artist.slug,
      name:        artist.name,
      genre:       artist.genre,
      description: artist.description
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