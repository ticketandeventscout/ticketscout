// ===========================
// TicketScout — Vivid Seats affiliate adapter
// Runs as a Cloudflare Pages Function at /api/vividseats
//
// Uses Impact.com Partner API to search Vivid Seats catalog for events
// matching a given artist/team name, then returns deep-linked affiliate URLs.
//
// Impact API auth: HTTP Basic (AccountSID:AuthToken)
// Deep-link format: https://vivid-seats.pxf.io/c/7443544/952533/12730?u={encodedUrl}
//
// Required env vars (Cloudflare Pages → Settings → Variables):
//   IMPACT_ACCOUNT_SID  — IR9mKsCFHL777443544zNqEHFE8tqSZqT1
//   IMPACT_AUTH_TOKEN   — VgKtEH-c3SbPTsdPYtNgp5Ys.TYmpvZX
//
// Usage: GET /api/vividseats?q=Metallica&date=2026-08-15
// Returns: { match: { name, url, price, date, venue } } or { match: null }
// ===========================

const CAMPAIGN_ID    = '12730';
const PUBLISHER_REF  = '7443544'; // from tracking link middle segment
const AD_ID          = '952533';  // from tracking link
const BASE_TRACKING  = `https://vivid-seats.pxf.io/c/${PUBLISHER_REF}/${AD_ID}/${CAMPAIGN_ID}`;
const VS_SEARCH_BASE = 'https://www.vividseats.com/search?searchTerm=';

export async function onRequestGet({ request, env }) {
  const accountSid  = env.IMPACT_ACCOUNT_SID;
  const authToken   = env.IMPACT_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return jsonResponse({ error: 'Impact credentials not configured.' }, 500);
  }

  const url   = new URL(request.url);
  const q     = (url.searchParams.get('q') || '').trim();
  const date  = url.searchParams.get('date') || ''; // YYYY-MM-DD, optional

  if (!q || q.length < 2) {
    return jsonResponse({ error: 'q (search term) is required.' }, 400);
  }

  const basicAuth = btoa(`${accountSid}:${authToken}`);

  try {
    // ── Step 1: Search Vivid Seats catalog via Impact API ─────────────────
    // Impact Catalogs endpoint lets us search the advertiser's product catalog
    const catalogUrl = new URL(
      `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/Items`
    );
    catalogUrl.searchParams.set('CampaignId', CAMPAIGN_ID);
    catalogUrl.searchParams.set('Keywords',   q);
    catalogUrl.searchParams.set('PageSize',   '10');

    const catalogResp = await fetch(catalogUrl.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });

    // ── Step 2: If catalog returns results, pick best match ───────────────
    if (catalogResp.ok) {
      const ct = catalogResp.headers.get('content-type') || '';
      if (ct.includes('application/json') || ct.includes('text/xml') || ct.includes('application/xml')) {
        const text = await catalogResp.text();

        // Try JSON first
        let items = [];
        try {
          const data = JSON.parse(text);
          items = data?.Items || data?.CatalogItems || [];
        } catch {
          // XML fallback — parse item names and URLs from XML
          const nameMatches = [...text.matchAll(/<Name>(.*?)<\/Name>/gi)];
          const urlMatches  = [...text.matchAll(/<CatalogItemUrl>(.*?)<\/CatalogItemUrl>/gi)];
          const priceMatches = [...text.matchAll(/<Price>(.*?)<\/Price>/gi)];
          items = nameMatches.map((m, i) => ({
            Name:           m[1],
            CatalogItemUrl: urlMatches[i]?.[1] || '',
            Price:          priceMatches[i]?.[1] || null
          })).filter(item => item.Name && item.CatalogItemUrl);
        }

        if (items.length > 0) {
          // Score items by name match quality
          const normQ = q.toLowerCase();
          const scored = items.map(item => {
            const normName = (item.Name || item.name || '').toLowerCase();
            let score = 0;
            if (normName.includes(normQ)) score = 100;
            else if (normQ.split(' ').every(w => normName.includes(w))) score = 60;
            return { item, score };
          }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

          if (scored.length > 0) {
            const best      = scored[0].item;
            const destUrl   = best.CatalogItemUrl || best.catalogItemUrl || best.Url || best.url || '';
            const price     = best.Price || best.price || null;
            const eventName = best.Name || best.name || q;
            const eventDate = best.StartDate || best.startDate || best.Date || date || '';
            const venue     = best.Venue || best.venue || best.Location || null;

            return jsonResponse({
              match: {
                name:   eventName,
                url:    buildDeepLink(destUrl),
                price:  price ? parseFloat(price) : null,
                date:   eventDate,
                venue:  venue
              }
            }, 200);
          }
        }
      }
    }

    // ── Step 3: Fallback — build a search deep-link ────────────────────────
    // If catalog returns nothing, still give a useful affiliate search link
    // so the user can search on Vivid Seats directly (still earns commission)
    const searchUrl = VS_SEARCH_BASE + encodeURIComponent(q);
    return jsonResponse({
      match: {
        name:   `${q} tickets`,
        url:    buildDeepLink(searchUrl),
        price:  null,
        date:   date || null,
        venue:  null,
        isFallback: true
      }
    }, 200);

  } catch (err) {
    console.error('Vivid Seats adapter error:', err);
    return jsonResponse({ error: 'Unable to reach Vivid Seats.' }, 502);
  }
}

// Build an Impact deep-link to a specific Vivid Seats URL
function buildDeepLink(destUrl) {
  if (!destUrl) return BASE_TRACKING;
  return `${BASE_TRACKING}?u=${encodeURIComponent(destUrl)}`;
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
