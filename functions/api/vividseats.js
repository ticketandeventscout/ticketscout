// ===========================
// TicketScout — Vivid Seats affiliate adapter
// Runs as a Cloudflare Pages Function at /api/vividseats
//
// Uses Impact.com Partner API to search Vivid Seats catalog (ID: 7904)
// 131,500+ events with pre-built affiliate tracking URLs per item.
//
// Catalog item URL format (already contains affiliate tracking):
//   https://vivid-seats.pxf.io/c/7443544/1017970/12730?prodsku=XXXXX&u=...
//
// Key catalog fields:
//   Name          — event name
//   Url           — ready-made affiliate deep-link (use directly)
//   CurrentPrice  — lowest price in USD
//   Category      — Sport / Theater / Concert etc.
//   SubCategory   — NCAA Basketball / Musical / Rock etc.
//   ExpirationDate — event date/time
//   Text1         — venue name
//   Text2         — city
//
// Required env vars:
//   IMPACT_ACCOUNT_SID  — IR9mKsCFHL777443544zNqEHFE8tqSZqT1
//   IMPACT_AUTH_TOKEN   — VgKtEH-c3SbPTsdPYtNgp5Ys.TYmpvZX
//
// Usage: GET /api/vividseats?q=Arsenal&date=2026-08-15
// Returns: { match: { name, url, price, currency, date, venue, city } }
//      or: { match: null }
// ===========================

const CATALOG_ID     = '7904';
const CAMPAIGN_ID    = '12730';
const FALLBACK_LINK  = 'https://vivid-seats.pxf.io/c/7443544/952533/12730';

export async function onRequestGet({ request, env }) {
  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return jsonResponse({ error: 'Impact credentials not configured.' }, 500);
  }

  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || ''; // YYYY-MM-DD optional

  if (!q || q.length < 2) {
    return jsonResponse({ error: 'q (search term) is required.' }, 400);
  }

  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const headers   = {
    'Authorization': `Basic ${basicAuth}`,
    'Accept': 'application/json'
  };

  try {
    // Search catalog by keyword — returns items whose Name/Labels/Description match
    const searchUrl = new URL(
      `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/${CATALOG_ID}/Items`
    );
    searchUrl.searchParams.set('Keywords', q);
    searchUrl.searchParams.set('PageSize', '20');
    // Filter to future events only using ExpirationDate
    const nowIso = new Date().toISOString().split('T')[0];
    searchUrl.searchParams.set('SearchQuery', `ExpirationDate>${nowIso}`);

    const resp = await fetch(searchUrl.toString(), { headers });

    if (!resp.ok) {
      console.error(`VS catalog search error: ${resp.status}`);
      return jsonResponse({ match: null }, 200);
    }

    const data  = await resp.json();
    const items = data?.Items || [];

    if (items.length === 0) {
      return jsonResponse({ match: null }, 200);
    }

    // Score items by name match quality and date proximity
    const normQ    = normaliseName(q);
    const today    = new Date();
    const targetMs = date ? new Date(date).getTime() : 0;

    const scored = items
      .filter(item => {
        // Filter out expired events
        if (!item.ExpirationDate) return true;
        return new Date(item.ExpirationDate) > today;
      })
      .map(item => {
        const normName = normaliseName(item.Name || '');
        let score = 0;

        // Name matching
        if (normName === normQ)                          score += 100;
        else if (normName.startsWith(normQ))             score += 70;
        else if (normName.includes(normQ))               score += 50;
        else {
          // Check if all words in query appear in name
          const words = normQ.split(/\s+/).filter(w => w.length > 2);
          if (words.length > 0 && words.every(w => normName.includes(w))) score += 40;
        }

        // Boost UK events
        const city = (item.Text2 || '').toLowerCase();
        const addr = (item.Text3 || '').toLowerCase();
        if (addr.includes('uk') || addr.includes('united kingdom') ||
            city.includes('london') || city.includes('manchester') ||
            city.includes('birmingham') || city.includes('glasgow')) {
          score += 30;
        }

        // Date proximity boost
        if (targetMs && item.ExpirationDate) {
          const itemMs = new Date(item.ExpirationDate).getTime();
          const diffDays = Math.abs(itemMs - targetMs) / (1000 * 60 * 60 * 24);
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

    const best     = scored[0].item;
    const eventUrl = best.Url; // Already a complete affiliate tracking URL
    const price    = best.CurrentPrice ? parseFloat(best.CurrentPrice) : null;

    // ExpirationDate is the event date (when listing expires = when event happens)
    const eventDate = best.ExpirationDate
      ? best.ExpirationDate.split('T')[0]
      : '';

    return jsonResponse({
      match: {
        name:     best.Name,
        url:      eventUrl,
        price:    price ? Math.round(price) : null,
        currency: best.Currency || 'USD',
        date:     eventDate,
        venue:    best.Text1 || null,
        city:     best.Text2 || null,
        category: best.Category || null,
        image:    best.ImageUrl || null
      }
    }, 200);

  } catch (err) {
    console.error('Vivid Seats adapter error:', err);
    return jsonResponse({ error: 'Unable to reach Vivid Seats.' }, 502);
  }
}

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
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