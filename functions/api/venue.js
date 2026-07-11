// ===========================
// TicketScout — Venue Data
// Auto-managed by /api/discover-pages
// ===========================

const VENUES = [
  { slug: 'adelphi-theatre', name: 'Adelphi Theatre', city: 'London', country: 'UK', venueId: 'KovZ917AJi7', description: 'The Adelphi Theatre is one of London\'s most historic West End venues on the Strand, hosting major musical theatre productions. Compare ticket prices from verified sellers for all upcoming shows.' },
  { slug: 'lyceum-theatre', name: 'Lyceum Theatre', city: 'London', country: 'UK', venueId: 'KovZ917AJi7', description: 'The Lyceum Theatre is a landmark West End theatre in London\'s Covent Garden, famously home to The Lion King for over two decades. Compare ticket prices from verified sellers.' },
  { slug: 'palace-theatre', name: 'Palace Theatre', city: 'London', country: 'UK', venueId: 'KovZ9177gU0', description: 'Palace Theatre is one of London\'s premier West End venues on Cambridge Circus, currently home to Harry Potter and the Cursed Child. Compare ticket prices from verified sellers.' },
  { slug: 'palace-theatre-london', name: 'Palace Theatre London', city: 'London', country: 'UK', venueId: null, description: 'Palace Theatre London is one of the West End\'s most iconic venues. Compare ticket prices from verified sellers for all upcoming productions.' },
  { slug: 'savoy-theatre', name: 'Savoy Theatre', city: 'London', country: 'UK', venueId: null, description: 'The Savoy Theatre is a historic London theatre on the Strand, opened in 1881, with a rich history of musicals and plays. Compare ticket prices from verified sellers.' },
  { slug: 'shaftesbury-theatre', name: 'Shaftesbury Theatre', city: 'London', country: 'UK', venueId: null, description: 'Shaftesbury Theatre is a West End venue in London\'s theatre district, known for long-running musicals and major productions. Compare ticket prices from verified sellers.' },
  { slug: 'victoria-palace-theatre', name: 'Victoria Palace Theatre', city: 'London', country: 'UK', venueId: null, description: 'Victoria Palace Theatre is a stunning West End venue near Victoria station, home to Hamilton since 2017. Compare ticket prices from verified sellers.' },
  { slug: 'barbican-centre', name: 'Barbican Centre', city: 'London', country: 'UK', venueId: null, description: 'The Barbican Centre is London\'s world-class arts venue hosting theatre, concerts, film and exhibitions. Compare ticket prices from verified sellers for all upcoming events.' },
  { slug: 'royal-albert-hall', name: 'Royal Albert Hall', city: 'London', country: 'UK', venueId: 'KovZpZAEvEAA', description: 'The Royal Albert Hall is one of the UK\'s most treasured and beautiful concert halls, hosting everything from classical performances to pop concerts and sporting events. Compare ticket prices.' },
  { slug: 'royal-festival-hall', name: 'Royal Festival Hall', city: 'London', country: 'UK', venueId: null, description: 'Royal Festival Hall on London\'s South Bank is one of the UK\'s premier concert venues, home to the Philharmonia Orchestra and London Philharmonic Orchestra. Compare ticket prices.' },
  { slug: 'wembley-stadium', name: 'Wembley Stadium', city: 'London', country: 'UK', venueId: 'KovZ9177ML0', description: 'Wembley Stadium is the home of English football and one of the world\'s greatest sporting venues with a capacity of 90,000. It hosts FA Cup finals, England internationals, and major concerts.' },
  { slug: 'emirates-stadium', name: 'Emirates Stadium', city: 'London', country: 'UK', venueId: 'KovZ917ABe7', description: 'The Emirates Stadium is the home of Arsenal FC in north London, one of the Premier League\'s most modern grounds with a capacity of 60,704.' },
  { slug: 'stamford-bridge', name: 'Stamford Bridge', city: 'London', country: 'UK', venueId: null, description: 'Stamford Bridge is the home of Chelsea FC in Fulham, west London. One of England\'s most famous football grounds with a capacity of 40,343.' },
  { slug: 'london-stadium', name: 'London Stadium', city: 'London', country: 'UK', venueId: 'KovZpZAEkn6A', description: 'London Stadium is home to West Ham United in Stratford, east London, with a capacity of 62,500. Also hosts major concerts and athletics events.' },
  { slug: 'tottenham-hotspur-stadium', name: 'Tottenham Hotspur Stadium', city: 'London', country: 'UK', venueId: null, description: 'Tottenham Hotspur Stadium is a state-of-the-art 62,850 capacity ground in north London, home to Spurs and also hosting NFL games and concerts.' },
  { slug: 'anfield', name: 'Anfield', city: 'Liverpool', country: 'UK', venueId: 'KovZ917AJb7', description: 'Anfield is the iconic home of Liverpool FC, one of England\'s most atmospheric football grounds and a pilgrimage site for fans worldwide. Capacity 61,000.' },
  { slug: 'old-trafford', name: 'Old Trafford', city: 'Manchester', country: 'UK', venueId: null, description: 'Old Trafford is the legendary home of Manchester United FC, known as the Theatre of Dreams. One of England\'s most famous stadiums with a capacity of 74,310.' },
  { slug: 'etihad-stadium', name: 'Etihad Stadium', city: 'Manchester', country: 'UK', venueId: null, description: 'The Etihad Stadium is the home of Manchester City FC, a modern 53,400 capacity ground that has hosted Champions League football and major concerts.' },
  { slug: 'st-james-park', name: 'St James Park', city: 'Newcastle', country: 'UK', venueId: null, description: 'St James\'s Park is the home of Newcastle United, one of England\'s largest football grounds with a capacity of 52,305 in the heart of Newcastle city centre.' },
  { slug: 'villa-park', name: 'Villa Park', city: 'Birmingham', country: 'UK', venueId: null, description: 'Villa Park is the home of Aston Villa FC in Birmingham, one of England\'s oldest and most historic football grounds with a capacity of 42,785.' },
  { slug: 'amex-stadium', name: 'Amex Stadium', city: 'Brighton', country: 'UK', venueId: null, description: 'The Amex Stadium is the home of Brighton and Hove Albion FC, a modern 31,800 capacity ground in Falmer, East Sussex.' },
  { slug: 'co-op-live-manchester', name: 'Co-op Live Manchester', city: 'Manchester', country: 'UK', venueId: null, description: 'Co-op Live is Manchester\'s brand new indoor arena, the largest in the UK with a capacity of 23,500, hosting major concerts and events.' },
  { slug: 'first-direct-arena-leeds', name: 'First Direct Arena Leeds', city: 'Leeds', country: 'UK', venueId: null, description: 'First Direct Arena is Leeds\' premier indoor concert venue with a capacity of 13,500, hosting major touring artists and events throughout the year.' },
  { slug: 'ovo-hydro-glasgow', name: 'OVO Hydro Glasgow', city: 'Glasgow', country: 'UK', venueId: null, description: 'OVO Hydro is Scotland\'s largest indoor arena in Glasgow with a capacity of 14,300, regularly hosting world-class concerts and major events.' },
  { slug: 'cardiff-arena', name: 'Cardiff Arena', city: 'Cardiff', country: 'UK', venueId: null, description: 'Cardiff Arena is Wales\' premier indoor events venue, hosting major concerts, sporting events and entertainment shows throughout the year.' },
  { slug: 'sse-arena-belfast', name: 'SSE Arena Belfast', city: 'Belfast', country: 'UK', venueId: null, description: 'SSE Arena Belfast is Northern Ireland\'s leading entertainment venue with a capacity of 11,000, hosting major concerts and sporting events.' },
  { slug: 'resorts-world-arena-birmingham', name: 'Resorts World Arena Birmingham', city: 'Birmingham', country: 'UK', venueId: null, description: 'Resorts World Arena is Birmingham\'s largest indoor arena with a capacity of 15,685, hosting major tours, concerts and events throughout the year.' },
  { slug: 'motorpoint-arena-nottingham', name: 'Motorpoint Arena Nottingham', city: 'Nottingham', country: 'UK', venueId: null, description: 'Motorpoint Arena Nottingham is the East Midlands\' premier entertainment venue with a capacity of 10,000, hosting major concerts and events.' },
  { slug: 'utilita-arena-birmingham', name: 'Utilita Arena Birmingham', city: 'Birmingham', country: 'UK', venueId: null, description: 'Utilita Arena Birmingham is one of the UK\'s top entertainment venues with a capacity of 15,800, regularly hosting the biggest names in music and entertainment.' },
  { slug: 'glastonbury-festival', name: 'Glastonbury Festival', city: 'Pilton', country: 'UK', venueId: null, description: 'Glastonbury Festival is the world\'s most famous music and performing arts festival, held annually at Worthy Farm in Somerset. Compare ticket prices from verified sellers.' },
  { slug: 'reading-festival', name: 'Reading Festival', city: 'Reading', country: 'UK', venueId: null, description: 'Reading Festival is one of the UK\'s longest-running music festivals, held annually in August at Richfield Avenue. Compare ticket prices from verified sellers.' },
  { slug: 'leeds-festival', name: 'Leeds Festival', city: 'Leeds', country: 'UK', venueId: null, description: 'Leeds Festival runs simultaneously with Reading Festival, one of the UK\'s most popular summer music events held at Bramham Park. Compare ticket prices.' },
  { slug: 'download-festival', name: 'Download Festival', city: 'Derby', country: 'UK', venueId: null, description: 'Download Festival is the UK\'s premier rock and metal festival held annually at Donington Park, Derbyshire. Compare ticket prices from verified sellers.' },
  { slug: 'latitude-festival', name: 'Latitude Festival', city: 'Southwold', country: 'UK', venueId: null, description: 'Latitude Festival is a beloved arts and music festival held annually in Henham Park, Suffolk, known for its eclectic lineup and relaxed atmosphere.' },
  { slug: 'boomtown-fair', name: 'Boomtown Fair', city: 'Winchester', country: 'UK', venueId: null, description: 'Boomtown Fair is one of the UK\'s most unique and theatrical music festivals held near Winchester, Hampshire, with an immersive city-themed experience.' },
  { slug: 'o2-arena', name: 'The O2 Arena', city: 'London', country: 'UK', venueId: 'KovZpZAEdvaA', description: 'The O2 Arena in Greenwich, London is one of the world\'s busiest entertainment venues, hosting the biggest names in music with a capacity of 20,000.' },
  { slug: 'camp-nou', name: 'Spotify Camp Nou', city: 'Barcelona', country: 'Spain', venueId: null, description: 'Spotify Camp Nou is the home of FC Barcelona and the largest stadium in Europe with a capacity of over 90,000. One of world football\'s most iconic venues.' },
  { slug: 'santiago-bernabeu', name: 'Santiago Bernabeu', city: 'Madrid', country: 'Spain', venueId: null, description: 'The Santiago Bernabeu is the legendary home of Real Madrid, one of the world\'s most iconic football stadiums with a capacity of 81,044 in the heart of Madrid.' },
  { slug: 'estadio-metropolitano', name: 'Estadio Metropolitano', city: 'Madrid', country: 'Spain', venueId: null, description: 'Estadio Metropolitano is the modern home of Atletico Madrid, opened in 2017 with a capacity of 68,000, hosting La Liga and Champions League football.' },
  { slug: 'allianz-arena', name: 'Allianz Arena', city: 'Munich', country: 'Germany', venueId: null, description: 'The Allianz Arena is the stunning home of Bayern Munich in Munich, famous for its illuminated facade and one of Europe\'s finest football stadiums, capacity 75,000.' },
  { slug: 'signal-iduna-park', name: 'Signal Iduna Park', city: 'Dortmund', country: 'Germany', venueId: null, description: 'Signal Iduna Park is the home of Borussia Dortmund and Germany\'s largest stadium, famous for the iconic Yellow Wall with 81,365 capacity.' },
  { slug: 'san-siro', name: 'San Siro', city: 'Milan', country: 'Italy', venueId: null, description: 'San Siro (Giuseppe Meazza Stadium) is the shared home of AC Milan and Inter Milan, one of Europe\'s most iconic football venues with a capacity of 75,923.' },
  { slug: 'juventus-stadium', name: 'Juventus Stadium', city: 'Turin', country: 'Italy', venueId: null, description: 'Juventus Stadium (Allianz Stadium) is the home of Juventus FC in Turin, a modern 41,507 capacity ground known for its excellent atmosphere and facilities.' },
  { slug: 'parc-des-princes', name: 'Parc des Princes', city: 'Paris', country: 'France', venueId: null, description: 'Parc des Princes is the home of Paris Saint-Germain in Paris, a 47,929 capacity stadium that has hosted World Cup matches and Champions League football.' },
  { slug: 'stade-de-france', name: 'Stade de France', city: 'Paris', country: 'France', venueId: null, description: 'Stade de France is France\'s national stadium in Saint-Denis with a capacity of 80,000, hosting international football, rugby and major concerts.' },
  { slug: 'johan-cruyff-arena', name: 'Johan Cruyff Arena', city: 'Amsterdam', country: 'Netherlands', venueId: null, description: 'Johan Cruyff Arena is the home of Ajax in Amsterdam, a modern 54,990 capacity stadium named after the legendary Dutch footballer Johan Cruyff.' },
  { slug: 'estadio-do-dragao', name: 'Estadio do Dragao', city: 'Porto', country: 'Portugal', venueId: null, description: 'Estadio do Dragao is the home of FC Porto, a stunning 50,033 capacity stadium in Porto that has hosted Champions League finals and international football.' },
  { slug: 'madison-square-garden', name: 'Madison Square Garden', city: 'New York', country: 'USA', venueId: null, description: 'Madison Square Garden is the world\'s most famous arena in the heart of Manhattan, hosting world-class concerts, boxing, NBA and NHL events.' },
  { slug: 'sphere-las-vegas', name: 'The Sphere Las Vegas', city: 'Las Vegas', country: 'USA', venueId: null, description: 'The Sphere is Las Vegas\'s revolutionary entertainment venue, the world\'s largest spherical structure featuring an immersive 160,000 square foot LED screen.' },
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'slug is required' }, 400);

  const venue = VENUES.find(v => v.slug === slug.toLowerCase());
  if (!venue)  return jsonResponse({ error: 'Venue not found' }, 404);

  const apiKey = env.TM_API_KEY;
  let events = [];
  let totalElements = 0;

  if (apiKey && venue.venueId) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('venueId', venue.venueId);
      tmUrl.searchParams.set('size', '50');
      tmUrl.searchParams.set('sort', 'date,asc');
      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      events = tmData?._embedded?.events || [];
      totalElements = tmData?.page?.totalElements || events.length;
    } catch (err) { console.error('TM venue events error:', err); }
  }

  return jsonResponse({ venue, events, totalElements }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
}

export default VENUES;