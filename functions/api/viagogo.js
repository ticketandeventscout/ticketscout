// ===========================
// TicketScout — Server-side viagogo adapter
// Runs as a Cloudflare Pages Function at /api/viagogo
// Keeps VIAGOGO_CLIENT_ID and VIAGOGO_CLIENT_SECRET out of client-side code.
//
// Part of the TicketScout source adapter pattern:
// this proxy returns raw viagogo API data; normalisation into
// { source, price, currency, url, available } is handled in
// compare.js by the viagogo adapter entry.
//
// viagogo uses OAuth 2.0 (client credentials flow).
// Required env vars (set in Cloudflare Pages → Settings → Variables and secrets):
//   VIAGOGO_CLIENT_ID
//   VIAGOGO_CLIENT_SECRET
//
// ── STATUS: STUB — not yet active ────────────────────────────────────────
// Fill in the implementation once viagogo affiliate credentials are approved.
// To activate, also uncomment the viagogo entry in compare.js ADAPTERS.
// ─────────────────────────────────────────────────────────────────────────
// ===========================

export async function onRequestGet({ request, env }) {
  const clientId = env.VIAGOGO_CLIENT_ID;
  const clientSecret = env.VIAGOGO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return jsonResponse({ error: 'Server is missing viagogo credentials.' }, 500);
  }

  // TODO: implement OAuth 2.0 token fetch (client credentials grant)
  // POST https://account.viagogo.com/oauth2/token
  // body: grant_type=client_credentials&scope=read:events
  // auth: Basic base64(clientId:clientSecret)

  // TODO: use token to call viagogo Catalog API
  // GET https://api.viagogo.com/catalog/events/search?q=<keyword>

  // TODO: extract lowest listed price from response and return raw data
  // (normalisation happens in compare.js)

  return jsonResponse({ error: 'viagogo adapter not yet implemented.' }, 501);
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
