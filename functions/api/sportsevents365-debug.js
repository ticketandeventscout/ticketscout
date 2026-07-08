// ===========================
// SE365 Debug endpoint — tests authentication directly
// GET /api/sportsevents365-debug
//
// Tests different auth approaches against SE365 API to diagnose 401
// REMOVE before significant traffic
// ===========================

const PRODUCTION_BASE = 'https://api-v2.sportsevents365.com';
const SANDBOX_BASE    = 'https://api-v2.sandbox365.com';

export async function onRequestGet({ request, env }) {
  const apiKey   = env.SE365_API_KEY;
  const httpUser = env.SE365_HTTP_USERNAME;
  const httpPass = env.SE365_HTTP_PASSWORD;
  const source   = env.SE365_HTTP_SOURCE || '';
  const isProd   = env.SE365_PROD === 'true' || env.SE365_PROD === true;

  const results = {
    envCheck: {
      hasApiKey:  !!apiKey,
      hasUser:    !!httpUser,
      hasPass:    !!httpPass,
      hasSource:  !!source,
      isProd,
      apiKeyLen:  apiKey?.length,
      userLen:    httpUser?.length,
    },
    tests: []
  };

  const basicAuth = btoa(`${httpUser}:${httpPass}`);
  const base = isProd ? PRODUCTION_BASE : SANDBOX_BASE;

  // Test a simple endpoint — /event-types is lightweight and always exists
  const testEndpoint = `${base}/event-types?apiKey=${encodeURIComponent(apiKey)}&perPage=3`;

  // Test 1: Basic auth + Source header (current implementation)
  try {
    const r = await fetch(testEndpoint, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Source': source
      }
    });
    const text = await r.text();
    results.tests.push({
      test: 'Basic auth + Source header',
      status: r.status,
      ok: r.ok,
      response: text.slice(0, 200)
    });
  } catch(e) { results.tests.push({ test: 'Basic auth + Source header', error: String(e) }); }

  // Test 2: Basic auth only (no Source header)
  try {
    const r = await fetch(testEndpoint, {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    const text = await r.text();
    results.tests.push({
      test: 'Basic auth only (no Source)',
      status: r.status,
      ok: r.ok,
      response: text.slice(0, 200)
    });
  } catch(e) { results.tests.push({ test: 'Basic auth only', error: String(e) }); }

  // Test 3: API key in URL only (no Basic auth)
  try {
    const r = await fetch(testEndpoint);
    const text = await r.text();
    results.tests.push({
      test: 'API key in URL only (no auth header)',
      status: r.status,
      ok: r.ok,
      response: text.slice(0, 200)
    });
  } catch(e) { results.tests.push({ test: 'API key URL only', error: String(e) }); }

  // Test 4: Sandbox vs production check
  const otherBase = isProd ? SANDBOX_BASE : PRODUCTION_BASE;
  const otherEndpoint = `${otherBase}/event-types?apiKey=${encodeURIComponent(apiKey)}&perPage=3`;
  try {
    const r = await fetch(otherEndpoint, {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    results.tests.push({
      test: `Other base (${isProd ? 'sandbox' : 'production'})`,
      status: r.status,
      ok: r.ok
    });
  } catch(e) { results.tests.push({ test: 'Other base', error: String(e) }); }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}