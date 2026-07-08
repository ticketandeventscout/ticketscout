// ===========================
// TicketScout — Ticombo affiliate adapter
// Runs as a Cloudflare Pages Function at /api/ticombo
//
// Ticombo is a global ticket marketplace with campaigns in 9 regions via Partnerize.
// Deep-link format: https://ticombo.prf.hn/click/camref:{CAMREF}/destination:{ENCODED_URL}
//
// Region routing: detect user's country from CF-IPCountry header, map to correct camref.
// Fallback: UK camref for unknown regions.
//
// Ticombo search URL format:
//   https://www.ticombo.com/en/search?q={artist_name}
//
// Required env vars:
//   PARTNERIZE_API_KEY  — Partnerize User API key
//   PARTNERIZE_USER_KEY — Partnerize User Application key
//   PARTNERIZE_PUBLISHER_ID — Partnerize Publisher ID
//   (camrefs are hardcoded as they are public-facing values)
//
// Usage: GET /api/ticombo?q=Metallica&date=2026-10-01&country=GB
// Returns: { match: { name, url, price, currency, date, venue, city } } or { match: null }
// ===========================

// Ticombo Partnerize campaigns — confirmed from API
// campaign_id → for API calls | camref → for tracking links
const CAMPAIGNS = {
  GB:    { camref: '1100l5P9x2', campaign_id: '1100l6335', title: 'Ticombo UK'        },
  US:    { camref: '1100l5P9x3', campaign_id: '1011l6397', title: 'Ticombo US'        },
  EU:    { camref: '1100l5P9wQ', campaign_id: '1011l6399', title: 'Ticombo Europe'    },
  DE:    { camref: '1100l5P9wR', campaign_id: '1011l6400', title: 'Ticombo Germany'   },
  ES:    { camref: '1100l5P9wT', campaign_id: '1100l6336', title: 'Ticombo Spain'     },
  SG:    { camref: '1100l5P9wS', campaign_id: '1101l6348', title: 'Ticombo Singapore' },
  MX:    { camref: '1100l5P9wN', campaign_id: '1110l49',   title: 'Ticombo Mexico'   },
  APAC:  { camref: '1100l5P9wP', campaign_id: '1011l6398', title: 'Ticombo APAC'     },
  LATAM: { camref: '1100l5P9wM', campaign_id: '1100l6567', title: 'Ticombo LATAM'    },
};

// Convenience map: just camrefs for building tracking links
const CAMREFS = Object.fromEntries(Object.entries(CAMPAIGNS).map(([k,v]) => [k, v.camref]));

// Commission rate: 7% on all sales (confirmed from API)

// Country → camref mapping
const COUNTRY_TO_CAMREF = {
  // UK
  GB: CAMREFS.GB,
  // US
  US: CAMREFS.US,
  // Germany
  DE: CAMREFS.DE,
  // Spain
  ES: CAMREFS.ES,
  // Singapore
  SG: CAMREFS.SG,
  // Mexico
  MX: CAMREFS.MX,
  // EU countries → Europe camref
  FR: CAMREFS.EU, IT: CAMREFS.EU, NL: CAMREFS.EU, BE: CAMREFS.EU,
  PT: CAMREFS.EU, AT: CAMREFS.EU, CH: CAMREFS.EU, SE: CAMREFS.EU,
  NO: CAMREFS.EU, DK: CAMREFS.EU, FI: CAMREFS.EU, PL: CAMREFS.EU,
  CZ: CAMREFS.EU, RO: CAMREFS.EU, HU: CAMREFS.EU, GR: CAMREFS.EU,
  IE: CAMREFS.EU, HR: CAMREFS.EU, SK: CAMREFS.EU, BG: CAMREFS.EU,
  // APAC countries
  AU: CAMREFS.APAC, NZ: CAMREFS.APAC, JP: CAMREFS.APAC,
  KR: CAMREFS.APAC, TH: CAMREFS.APAC, MY: CAMREFS.APAC,
  PH: CAMREFS.APAC, ID: CAMREFS.APAC, IN: CAMREFS.APAC, CN: CAMREFS.APAC,
  // LATAM countries
  BR: CAMREFS.LATAM, AR: CAMREFS.LATAM, CO: CAMREFS.LATAM,
  CL: CAMREFS.LATAM, PE: CAMREFS.LATAM, VE: CAMREFS.LATAM,
};

const DEFAULT_CAMREF = CAMREFS.GB; // fallback for unknown regions
const TICOMBO_BASE  = 'https://www.ticombo.com';

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const q       = (url.searchParams.get('q')    || '').trim();
  const date    = url.searchParams.get('date')  || '';

  if (!q || q.length < 2) {
    return jsonResponse({ error: 'q (search term) is required' }, 400);
  }

  // Detect user's country from Cloudflare header (automatic, no IP lookup needed)
  const country = request.headers.get('CF-IPCountry') || url.searchParams.get('country') || 'GB';
  const camref  = COUNTRY_TO_CAMREF[country] || DEFAULT_CAMREF;

  // Build Ticombo search URL for the artist/event
  const searchUrl = `${TICOMBO_BASE}/en/search?q=${encodeURIComponent(q)}`;
  const trackingUrl = buildDeepLink(camref, searchUrl);

  // Try to find a specific event match via Partnerize API (product feeds)
  // If no specific match found, return the search deep-link as fallback
  const specificMatch = await findSpecificEvent(q, date, camref, env);

  if (specificMatch) {
    return jsonResponse({ match: specificMatch }, 200);
  }

  // Fallback: return search deep-link (still earns commission on purchase)
  return jsonResponse({
    match: {
      name:       `${q} tickets on Ticombo`,
      url:        trackingUrl,
      price:      null,
      currency:   'GBP',
      date:       date || null,
      venue:      null,
      city:       null,
      isFallback: true
    }
  }, 200);
}

async function findSpecificEvent(q, date, camref, env) {
  const apiKey     = env.PARTNERIZE_API_KEY;
  const userKey    = env.PARTNERIZE_USER_KEY;
  const publisherId = env.PARTNERIZE_PUBLISHER_ID;

  if (!apiKey || !userKey || !publisherId) return null;

  try {
    // Ticombo does NOT provide a product feed via Partnerize (confirmed via creatives API)
    // 34 creatives = image banners + tracking links only — no event CSV/XML feed
    // Search deep-link is the correct permanent approach for Ticombo
    // 7% commission tracked on any purchase made after clicking through
    return null;

  } catch (e) {
    console.error('Ticombo API error:', e);
    return null;
  }
}

function buildDeepLink(camref, destinationUrl) {
  return `https://ticombo.prf.hn/click/camref:${camref}/destination:${encodeURIComponent(destinationUrl)}`;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}