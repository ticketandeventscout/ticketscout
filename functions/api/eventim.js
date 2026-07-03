// ===========================
// TicketScout — Server-side Eventim adapter
// Runs as a Cloudflare Pages Function at /api/eventim
//
// Part of the TicketScout source adapter pattern.
// Normalisation into { source, price, currency, url, available }
// is handled in compare.js by the Eventim adapter entry.
//
// Eventim UK does not provide a real-time REST API.
// Their affiliate programme (via Awin/admitad) provides:
//   - A product feed (CSV or XML) updated periodically
//   - Deep-link affiliate URLs for each event
//
// Architecture for this adapter (feed-based, not API-based):
//
//   1. A scheduled Cloudflare Worker (cron trigger) fetches the Eventim
//      feed on a schedule (e.g. every 6 hours) and stores it in
//      Cloudflare KV under keys like "eventim:events:<date>"
//
//   2. This Function reads from KV at request time — no outbound
//      call to Eventim on every page load (feeds are not real-time)
//
//   3. Matching is done by event name + date fuzzy search against
//      the cached feed data
//
// Required env vars:
//   EVENTIM_FEED_URL     — the Awin/admitad feed URL (includes your
//                          affiliate tracking ID automatically)
//   EVENTIM_KV           — KV namespace binding (set in wrangler.toml
//                          or Cloudflare Pages dashboard)
//
// ── STATUS: STUB — not yet active ────────────────────────────────────────
// Implement once Eventim affiliate application (via Awin) is approved
// and feed URL is available.
// To activate, also uncomment the Eventim entry in compare.js ADAPTERS.
// ─────────────────────────────────────────────────────────────────────────
// ===========================

export async function onRequestGet({ request, env }) {
  const kv = env.EVENTIM_KV;

  if (!kv) {
    return jsonResponse({ error: 'Server is missing EVENTIM_KV binding.' }, 500);
  }

  const incoming = new URL(request.url);
  const q = incoming.searchParams.get('q');
  const city = incoming.searchParams.get('city');

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  // TODO: read cached feed from KV
  // const raw = await kv.get('eventim:events:latest', { type: 'json' });

  // TODO: fuzzy-match against feed entries by event name + city

  // TODO: return matched event(s) with lowest price and affiliate deep-link

  return jsonResponse({ error: 'Eventim adapter not yet implemented.' }, 501);
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