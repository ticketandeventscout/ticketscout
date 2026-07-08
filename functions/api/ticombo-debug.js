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

  // Confirmed working base: api.performancehorizon.com
  const BASE = `https://api.performancehorizon.com/user/publisher/${publisherId}`;

  // Test 1: Full campaign list with all fields
  try {
    const url = `${BASE}/campaign.json`;
    const r = await fetch(url, { headers });
    const data = tryJson(await r.text());
    // Extract just the key fields we need
    const campaigns = (data?.campaigns || []).map(c => ({
      id:    c.campaign?.campaign_id,
      title: c.campaign?.title,
      url:   c.campaign?.destination_url,
      status: c.campaign?.status
    }));
    results.tests.push({ test: 'All campaigns', status: r.status, ok: r.ok, count: data?.count, campaigns });
  } catch(e) { results.tests.push({ test: 'All campaigns', error: String(e) }); }

  // Test 2: Creatives for each campaign — check for product feed links
  // Use Ticombo US campaign ID 1011l6397 as first test
  const testCampaignId = '1011l6397';
  try {
    const url = `${BASE}/campaign/${testCampaignId}/creative.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     `Creatives for campaign ${testCampaignId} (Ticombo US)`,
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 1500))
    });
  } catch(e) { results.tests.push({ test: 'Creatives', error: String(e) }); }

  // Test 3: Commission rates for Ticombo US
  try {
    const url = `${BASE}/campaign/${testCampaignId}/commission.json`;
    const r = await fetch(url, { headers });
    const text = await r.text();
    results.tests.push({
      test:     `Commission rates for ${testCampaignId}`,
      url,
      status:   r.status,
      ok:       r.ok,
      response: tryJson(text.slice(0, 800))
    });
  } catch(e) { results.tests.push({ test: 'Commission', error: String(e) }); }

  // Test 4: Deep-link generation
  const sampleDestination = 'https://www.ticombo.com/en/search?q=Metallica';
  // Test 5: Try to discover feed URLs for each campaign
  // Feed URL format: https://feeds.performancehorizon.com/{accountName}/{campaignId}/{hash}
  // Account name: ticketandeventscoutpartnerize (from publisher profile)
  const campaignIds = ['1011l6397','1011l6398','1011l6399','1011l6400','1100l6335','1100l6336','1100l6567','1101l6348','1110l49'];
  const feedResults = [];
  for (const cid of campaignIds) {
    try {
      const feedListUrl = `${BASE}/campaign/${cid}/feed.json`;
      const r = await fetch(feedListUrl, { headers });
      const text = await r.text();
      feedResults.push({ campaign: cid, status: r.status, response: tryJson(text.slice(0, 300)) });
    } catch(e) { feedResults.push({ campaign: cid, error: String(e) }); }
  }
  results.feedDiscovery = feedResults;

  results.sampleLinks = {
    UK:    `https://ticombo.prf.hn/click/camref:1100l5P9x2/destination:${encodeURIComponent(sampleDestination)}`,
    US:    `https://ticombo.prf.hn/click/camref:1100l5P9x3/destination:${encodeURIComponent(sampleDestination)}`,
    DE:    `https://ticombo.prf.hn/click/camref:1100l5P9wR/destination:${encodeURIComponent(sampleDestination)}`,
    detected: `https://ticombo.prf.hn/click/camref:${
      {'GB':'1100l5P9x2','US':'1100l5P9x3','DE':'1100l5P9wR'}[country] || '1100l5P9x2'
    }/destination:${encodeURIComponent(sampleDestination)}`
  };

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