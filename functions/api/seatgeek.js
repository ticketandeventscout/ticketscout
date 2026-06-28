// ===========================
// TicketScout — Server-side SeatGeek proxy
// Runs as a Cloudflare Pages Function at /api/seatgeek
// Keeps SEATGEEK_CLIENT_ID out of client-side code, and
// restricts results to GB venues.
//
// Set SEATGEEK_CLIENT_ID in: Cloudflare Pages dashboard →
// your project → Settings → Environment variables
// ===========================

export async function onRequestGet({ request, env }) {
  const clientId = env.SEATGEEK_CLIENT_ID;

  if (!clientId) {
    return jsonResponse({ error: 'Server is missing SEATGEEK_CLIENT_ID environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const sgUrl = new URL('https://api.seatgeek.com/2/events');

  sgUrl.searchParams.set('client_id', clientId);
  sgUrl.searchParams.set('per_page', incoming.searchParams.get('per_page') || '3');

  // Restrict to GB venues — note SeatGeek's inventory is US/Canada-first,
  // so coverage for UK events will be thinner than Ticketmaster regardless.
  sgUrl.searchParams.set('venue.country', 'GB');

  const q = incoming.searchParams.get('q');
  if (q) sgUrl.searchParams.set('q', q);

  const city = incoming.searchParams.get('city');
  if (city) sgUrl.searchParams.set('venue.city', city);

  try {
    const sgResponse = await fetch(sgUrl.toString());
    const data = await sgResponse.json();
    return jsonResponse(data, sgResponse.status);
  } catch (err) {
    return jsonResponse({ error: 'Unable to reach SeatGeek.' }, 502);
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
