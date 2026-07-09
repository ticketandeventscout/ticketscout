// ===========================
// Impact API auth debug endpoint
// GET /api/impact-debug
// Tests IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN credentials
// REMOVE before significant traffic
// ===========================

export async function onRequestGet({ request, env }) {
  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;

  const results = {
    envCheck: {
      hasAccountSid: !!accountSid,
      hasAuthToken:  !!authToken,
      sidLength:     accountSid?.length,
      tokenLength:   authToken?.length,
      tokenLastChars: authToken ? authToken.slice(-4) : null, // last 4 chars to verify correct token
    },
    tests: []
  };

  if (!accountSid || !authToken) {
    results.error = 'Missing credentials';
    return json(results, 200);
  }

  const basicAuth = btoa(`${accountSid}:${authToken}`);

  // Test 1: Quick catalog check (1 item only)
  try {
    const r = await fetch(
      `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/1872/Items?PageSize=1`,
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/xml' } }
    );
    results.tests.push({
      test:   'Catalog 1872 (TicketNetwork) — 1 item',
      status: r.status,
      ok:     r.ok,
      note:   r.ok ? '✅ Valid' : '❌ Invalid — update IMPACT_AUTH_TOKEN in Cloudflare'
    });
  } catch(e) { results.tests.push({ test: 'Catalog 1872', error: String(e) }); }

  // Test 2: Vivid Seats catalog (verify VS still works too)
  try {
    const r = await fetch(
      `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/7904/Items?PageSize=1`,
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' } }
    );
    results.tests.push({
      test:   'Catalog 7904 (Vivid Seats) — 1 item',
      status: r.status,
      ok:     r.ok,
      note:   r.ok ? '✅ Valid' : '❌ Invalid'
    });
  } catch(e) { results.tests.push({ test: 'Catalog 7904', error: String(e) }); }

  // Test 3: Campaigns list
  try {
    const r = await fetch(
      `https://api.impact.com/Mediapartners/${accountSid}/Campaigns`,
      { headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' } }
    );
    results.tests.push({
      test:   'Campaigns list',
      status: r.status,
      ok:     r.ok
    });
  } catch(e) { results.tests.push({ test: 'Campaigns', error: String(e) }); }

  return json(results, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}