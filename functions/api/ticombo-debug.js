// ===========================
// Ticombo debug endpoint
// GET /api/ticombo-debug
// Tests Partnerize API auth and lists available campaigns/feeds
// REMOVE before significant traffic
// ===========================

export async function onRequestGet({ request, env }) {
  const apiKey      = env.PARTNERIZE_API_KEY;
  const userKey     = env.PARTNERIZE_USER_KEY;
  const publisherId = env.PARTNERIZE_PUBLISHER_ID;
  const country     = request.headers.get('CF-IPCountry') || 'unknown';

  const results = {
    envCheck: {
      hasApiKey:       !!apiKey,
      hasUserKey:      !!userKey,
      hasPublisherId:  !!publisherId,
      publisherId,
      cfCountry:       country,
    },
    tests: []
  };

  if (!apiKey || !userKey) {
    results.error = 'Missing PARTNERIZE_API_KEY or PARTNERIZE_USER_KEY';
    return json(results, 200);
  }

  const basicAuth = btoa(`${userKey}:${apiKey}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };

  // Partnerize uses performancehorizon.com domain for the publisher API
  // URL format: /user/publisher/{publisherId}/
  const BASE = `https://api.partnerize.com/user/publisher/${publisherId}`;

  // Test 1: List all campaigns for this publisher
  try {
    const url = `${BASE}/campaign.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     'List campaigns (/user/publisher/{id}/campaign.json)',
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 1000))
    });
  } catch(e) { results.tests.push({ test: 'List campaigns', error: String(e) }); }

  // Test 2: List creatives (includes product feeds/deep-links)
  try {
    const url = `${BASE}/creative.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     'List creatives (/user/publisher/{id}/creative.json)',
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 1000))
    });
  } catch(e) { results.tests.push({ test: 'List creatives', error: String(e) }); }

  // Test 3: Get publisher profile
  try {
    const url = `https://api.partnerize.com/user/publisher/${publisherId}.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     'Publisher profile',
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 500))
    });
  } catch(e) { results.tests.push({ test: 'Publisher profile', error: String(e) }); }

  // Test 4: Try performancehorizon.com base (legacy domain)
  try {
    const url = `https://api.performancehorizon.com/user/publisher/${publisherId}/campaign.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     'Campaigns via performancehorizon.com (legacy domain)',
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 500))
    });
  } catch(e) { results.tests.push({ test: 'Legacy domain', error: String(e) }); }

  // Test 3: Sample tracking link verification
  const sampleUrl = `https://ticombo.prf.hn/click/camref:1100l5P9x2/destination:${encodeURIComponent('https://www.ticombo.com/en/search?q=Metallica')}`;
  results.tests.push({
    test:           'Sample UK deep-link',
    url:            sampleUrl,
    note:           'Click this URL to verify tracking in Partnerize dashboard'
  });

  return json(results, 200);
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}