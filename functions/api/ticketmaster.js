// ===========================
// TicketScout — Server-side Ticketmaster proxy
// Runs as a Cloudflare Pages Function at /api/ticketmaster
// Keeps TM_API_KEY out of client-side code.
//
// Set TM_API_KEY in: Cloudflare Pages dashboard →
// your project → Settings → Environment variables
// ===========================

export async function onRequestGet({ request, env }) {
  const apiKey = env.TM_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Server is missing TM_API_KEY environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const eventId = incoming.searchParams.get('id');

  let tmUrl;

  if (eventId) {
    // Single event lookup — used by event detail pages
    tmUrl = new URL(`https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json`);
    tmUrl.searchParams.set('apikey', apiKey);
  } else {
    // Event search — used for trending/category browsing and per-artist event lists
    tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('countryCode', 'GB');
    tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '12');
    tmUrl.searchParams.set('sort', 'date,asc');

    const page = incoming.searchParams.get('page');
    if (page) tmUrl.searchParams.set('page', page);

    const startDateTime = incoming.searchParams.get('startDateTime');
    const endDateTime   = incoming.searchParams.get('endDateTime');
    // Always default to today at midnight UTC so past events are never returned
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    tmUrl.searchParams.set('startDateTime', startDateTime || nowIso);
    if (endDateTime) tmUrl.searchParams.set('endDateTime', endDateTime);

    const keyword = incoming.searchParams.get('keyword');
    if (keyword) tmUrl.searchParams.set('keyword', keyword);

    const segmentName = incoming.searchParams.get('segmentName');
    if (segmentName) tmUrl.searchParams.set('segmentName', segmentName);

    // Setting this guarantees results belong to exactly one artist/attraction
    const attractionId = incoming.searchParams.get('attractionId');
    if (attractionId) tmUrl.searchParams.set('attractionId', attractionId);

    // venueId — used by venue pages to load all events at a specific venue
    // When venueId is set, omit countryCode so non-GB venues aren't filtered out
    const venueId = incoming.searchParams.get('venueId');
    if (venueId) {
      tmUrl.searchParams.set('venueId', venueId);
      tmUrl.searchParams.delete('countryCode');
    }
  }

  try {
    const tmResponse = await fetch(tmUrl.toString());
    const data = await tmResponse.json();
    return jsonResponse(data, tmResponse.status);
  } catch (err) {
    return jsonResponse({ error: 'Unable to reach Ticketmaster.' }, 502);
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