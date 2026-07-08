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

  // Test 1: Auth check — list campaigns for this publisher
  try {
    const r = await fetch(
      `https://api.partnerize.com/user/${publisherId}/campaigns.json?limit=20`,
      { headers }
    );
    const text = await r.text();
    results.tests.push({
      test:     'List publisher campaigns (v1)',
      url:      `https://api.partnerize.com/user/${publisherId}/campaigns.json`,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 800))
    });
  } catch(e) { results.tests.push({ test: 'List campaigns', error: String(e) }); }

  // Test 2: Check Ticombo feeds via campaign creatives endpoint
  // Ticombo UK campaign ID derived from camref — list all creatives/feeds
  try {
    const r = await fetch(
      `https://api.partnerize.com/user/${publisherId}/campaign_creatives.json`,
      { headers }
    );
    const text = await r.text();
    results.tests.push({
      test:     'List campaign creatives/feeds',
      url:      `https://api.partnerize.com/user/${publisherId}/campaign_creatives.json`,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 800))
    });
  } catch(e) { results.tests.push({ test: 'Campaign creatives', error: String(e) }); }

  // Test 3: Check available brands/advertisers via v3
  try {
    const r = await fetch(
      `https://api.partnerize.com/v3/partner/publishers/${publisherId}/advertisers`,
      { headers }
    );
    const text = await r.text();
    results.tests.push({
      test:     'List advertisers (v3)',
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 800))
    });
  } catch(e) { results.tests.push({ test: 'Advertisers v3', error: String(e) }); }

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