// ===========================
// TicketScout — Vivid Seats debug endpoint
// Runs at /api/vividseats-debug
// Shows raw Impact API responses to diagnose catalog structure
//
// Usage:
//   /api/vividseats-debug?step=catalogs        — list all VS catalogs
//   /api/vividseats-debug?step=items&id=XXXXX  — list items in catalog ID
//   /api/vividseats-debug?step=search&q=Arsenal — search catalog items
//   /api/vividseats-debug?step=ads             — list VS ads/tracking links
//
// REMOVE THIS FILE before significant traffic — debug only
// ===========================

const CAMPAIGN_ID = '12730';
const ACCOUNT_SID = 'IR9mKsCFHL777443544zNqEHFE8tqSZqT1';

export async function onRequestGet({ request, env }) {
  const authToken  = env.IMPACT_AUTH_TOKEN;
  const accountSid = env.IMPACT_ACCOUNT_SID || ACCOUNT_SID;

  if (!authToken) return json({ error: 'IMPACT_AUTH_TOKEN not set in env' }, 500);

  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };

  const url  = new URL(request.url);
  const step = url.searchParams.get('step') || 'catalogs';
  const id   = url.searchParams.get('id')   || '';
  const q    = url.searchParams.get('q')    || '';

  const base = `https://api.impact.com/Mediapartners/${accountSid}`;

  try {
    // ── Step 1: List all catalogs for Vivid Seats ──────────────────────────
    if (step === 'catalogs') {
      const r = await fetch(`${base}/Catalogs?CampaignId=${CAMPAIGN_ID}`, { headers });
      const text = await r.text();
      return raw(text, r.status, r.headers.get('content-type'));
    }

    // ── Step 2: List items in a specific catalog ───────────────────────────
    if (step === 'items' && id) {
      const r = await fetch(`${base}/Catalogs/${id}/Items?PageSize=5`, { headers });
      const text = await r.text();
      return raw(text, r.status, r.headers.get('content-type'));
    }

    // ── Step 3: Search catalog items by keyword ────────────────────────────
    if (step === 'search' && q) {
      // Try both with and without catalog ID
      const urlA = `${base}/Catalogs/${id || 'MISSING'}/Items?Keywords=${encodeURIComponent(q)}&PageSize=5`;
      const urlB = `${base}/Catalogs?CampaignId=${CAMPAIGN_ID}&Keywords=${encodeURIComponent(q)}`;
      const [rA, rB] = await Promise.all([
        id ? fetch(urlA, { headers }) : Promise.resolve(null),
        fetch(urlB, { headers })
      ]);
      return json({
        urlA: id ? urlA : 'skipped (no id param)',
        responseA: id ? await rA.text() : null,
        statusA:   id ? rA.status : null,
        urlB,
        responseB: await rB.text(),
        statusB:   rB.status
      }, 200);
    }

    // ── Step 4: List ads (tracking links) for VS ──────────────────────────
    if (step === 'ads') {
      const r = await fetch(`${base}/Ads?CampaignId=${CAMPAIGN_ID}&PageSize=10`, { headers });
      const text = await r.text();
      return raw(text, r.status, r.headers.get('content-type'));
    }

    // ── Step 5: Check tracking links ──────────────────────────────────────
    if (step === 'links') {
      const r = await fetch(`${base}/TrackingLinks?CampaignId=${CAMPAIGN_ID}&PageSize=5`, { headers });
      const text = await r.text();
      return raw(text, r.status, r.headers.get('content-type'));
    }

    return json({ error: 'Unknown step. Use: catalogs, items&id=X, search&q=X&id=X, ads, links' }, 400);

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

function raw(text, status, ct) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': ct || 'text/plain',
      'Cache-Control': 'no-store'
    }
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
