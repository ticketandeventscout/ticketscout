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

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let artist = ARTISTS.find(a => a.slug === normSlug);

  // If not in the hardcoded list, generate a fallback from the slug itself
  // Only for multi-word slugs (likely a show/event name e.g. "a-christmas-carol")
  // Single-word slugs that aren't in the list are likely misspellings — return 404
  // so the search flow can offer a "did you mean?" suggestion instead
  if (!artist) {
    const wordCount = normSlug.split('-').length;

    // Single word not in list = likely a misspelling, don't create a page
    if (wordCount === 1) {
      return jsonResponse({ error: 'Artist not found' }, 404);
    }

    const name = toTitleCase(normSlug.replace(/-/g, ' '));
    artist = {
      slug:        normSlug,
      name,
      search:      name,
      genre:       'Live Events',
      description: `Compare ${name} ticket prices across verified sellers. Find the best deal and buy directly from your chosen seller.`
    };
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
      tmUrl.searchParams.set('size', '10'); // fetch more so we can filter properly

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        // Score attractions — exact name match wins, tribute acts penalised
        const TRIBUTE_KEYWORDS = ['tribute', 'salute', 'legacy', 'experience', 'revival',
          'forever', 'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs '];

        const normSearch = artist.search.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        const scored = attractions.map(a => {
          const normName = (a.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          let score = 0;
          if (normName === normSearch)             score = 100;
          else if (normName.startsWith(normSearch)) score = 50;
          else if (normName.includes(normSearch))   score = 20;

          // Penalise tribute acts heavily
          const isTribute = TRIBUTE_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw));
          if (isTribute) score -= 60;

          return { attraction: a, score };
        }).sort((a, b) => b.score - a.score);

        const best = scored[0].attraction;
        attractionId = best.id;
        const images = best.images || [];
        // Prefer largest 16:9 image for hero background quality
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
      'Cache-Control': 'public, max-age=3600' // cache for 1 hour — attraction IDs don't change
    }
  });
}