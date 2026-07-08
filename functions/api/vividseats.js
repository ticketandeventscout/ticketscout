// ===========================
// TicketScout — Vivid Seats affiliate adapter
// Runs as a Cloudflare Pages Function at /api/vividseats
//
// Uses Impact Partner API /Catalogs/ItemSearch endpoint for real-time keyword search.
// This endpoint searches across all catalog item fields including Name, Description,
// Manufacturer etc — unlike /Catalogs/{Id}/Items which ignores Keywords param entirely.
//
// Endpoint: GET /Mediapartners/{AccountSID}/Catalogs/ItemSearch?Keyword={q}&PageSize=20
// Auth: HTTP Basic (AccountSID:AuthToken) — uses IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN
//
// Each result item contains a pre-built affiliate tracking URL in the Url field.
// Prices in USD.
//
// Usage: GET /api/vividseats?q=Arsenal
// Returns: { match: { name, url, price, currency, date, venue, city } } or { match: null }
// ===========================

export async function onRequestGet({ request, env }) {
  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return jsonResponse({ error: 'Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN' }, 500);
  }

  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || '';

  if (!q || q.length < 2) {
    return jsonResponse({ error: 'q (search term) is required' }, 400);
  }

  const basicAuth = btoa(`${accountSid}:${authToken}`);

  try {
    // Use the ItemSearch endpoint — searches across all fields, actually works
    const searchUrl = new URL(
      `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/ItemSearch`
    );
    searchUrl.searchParams.set('Keyword',  q);
    searchUrl.searchParams.set('PageSize', '20');

    const resp = await fetch(searchUrl.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept':        'application/json'
      }
    });

    if (!resp.ok) {
      console.error(`VS ItemSearch error: HTTP ${resp.status}`);
      return jsonResponse({ match: null, reason: `HTTP ${resp.status}` }, 200);
    }

    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return jsonResponse({ match: null, reason: 'non-json response' }, 200);
    }

    const data  = await resp.json();
    const items = data?.Items || [];

    if (items.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    // Score items by name match quality, date proximity, and UK/IE city boost
    const normQ    = normaliseName(q);
    const today    = new Date();
    const targetMs = date ? new Date(date).getTime() : 0;

    const UK_CITIES = new Set([
      'london','manchester','birmingham','glasgow','edinburgh','liverpool',
      'leeds','newcastle','sheffield','bristol','nottingham','cardiff',
      'belfast','dublin','leicester','southampton','brighton','reading'
    ]);

    const scored = items
      .filter(item => {
        // Skip expired events
        if (item.ExpirationDate && new Date(item.ExpirationDate) < today) return false;
        return true;
      })
      .map(item => {
        const normName = normaliseName(item.Name || '');
        let score = 0;

        if (normName === normQ)                         score = 100;
        else if (normName.startsWith(normQ + ' '))      score = 80;
        else if (normName.includes(normQ))              score = 60;
        else {
          const words = normQ.split(/\s+/).filter(w => w.length > 2);
          if (words.length > 0 && words.every(w => normName.includes(w))) score = 40;
        }

        if (score === 0) return { item, score };

        // UK/IE city boost
        const city = (item.Text2 || '').toLowerCase();
        if (UK_CITIES.has(city)) score += 25;

        // Date proximity boost
        if (targetMs && item.ExpirationDate) {
          const diffDays = Math.abs(new Date(item.ExpirationDate).getTime() - targetMs) / 86400000;
          if (diffDays <= 1)  score += 20;
          else if (diffDays <= 7)  score += 10;
        }

        return { item, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    const best  = scored[0].item;
    const price = best.CurrentPrice ? parseFloat(best.CurrentPrice) : null;
    const eventDate = best.ExpirationDate ? best.ExpirationDate.split('T')[0] : '';

    return jsonResponse({
      match: {
        name:     best.Name,
        url:      best.Url,         // pre-built affiliate tracking URL
        price:    price ? Math.round(price) : null,
        currency: best.Currency || 'USD',
        date:     eventDate,
        venue:    best.Text1 || null,
        city:     best.Text2 || null,
        category: best.Category || null
      }
    }, 200);

  } catch (err) {
    console.error('VS adapter error:', err);
    return jsonResponse({ match: null }, 200);
  }
}

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}