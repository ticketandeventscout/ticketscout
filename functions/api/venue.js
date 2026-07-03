// ===========================
// TicketScout — Venue Data
// Auto-managed by /api/discover-pages
// ===========================

const VENUES = [
  { slug: 'wembley-stadium', name: 'Wembley Stadium', city: 'London', country: 'Great Britain', venueId: 'KovZ9177ML0', description: 'Wembley Stadium is one of London\'s premier live event venues, hosting concerts, sports events, theatre shows and more throughout the year. Compare ticket prices from verified sellers for all upcoming' },
  { slug: 'palace-theatre', name: 'Palace Theatre', city: 'London', country: 'Great Britain', venueId: 'KovZ9177gU0', description: 'Palace Theatre is one of London\'s premier live event venues, hosting concerts, sports events, theatre shows and more throughout the year. Compare ticket prices from verified sellers for all upcoming ' },
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'slug is required' }, 400);

  const venue = VENUES.find(v => v.slug === slug.toLowerCase());
  if (!venue)  return jsonResponse({ error: 'Venue not found' }, 404);

  const apiKey = env.TM_API_KEY;
  let events = [];

  if (apiKey && venue.venueId) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('venueId', venue.venueId);
      tmUrl.searchParams.set('size', '20');
      tmUrl.searchParams.set('sort', 'date,asc');
      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      events = tmData?._embedded?.events || [];
    } catch (err) { console.error('TM venue events error:', err); }
  }

  return jsonResponse({ venue, events }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
}

export default VENUES;
