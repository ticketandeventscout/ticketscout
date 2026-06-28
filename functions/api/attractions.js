// ===========================
// TicketScout — Server-side Ticketmaster Attractions proxy
// Runs as a Cloudflare Pages Function at /api/attractions
//
// Used to resolve a free-text search (e.g. "Coldplay") into one or
// more specific attraction records (artists/teams/shows) BEFORE
// fetching events — this is what lets us guarantee a single artist
// per event query later, instead of loose keyword matching.
// ===========================

export async function onRequestGet({ request, env }) {
  const apiKey = env.TM_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Server is missing TM_API_KEY environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const keyword = incoming.searchParams.get('keyword');

  if (!keyword) {
    return jsonResponse({ error: 'A keyword is required.' }, 400);
  }

  const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
  tmUrl.searchParams.set('apikey', apiKey);
  tmUrl.searchParams.set('keyword', keyword);
  tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '8');

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
