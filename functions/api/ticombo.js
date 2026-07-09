// ===========================
// TicketScout — Ticombo affiliate adapter
// Runs as a Cloudflare Pages Function at /api/ticombo
//
// Searches the KV cache built by /api/ticombo-cache (event feeds from Partnerize).
// Falls back to a Ticombo search deep-link if cache is empty.
//
// Region routing: CF-IPCountry header → correct regional camref
// 9 campaigns: UK, US, Europe, Germany, Spain, Singapore, Mexico, APAC, LATAM
//
// KV keys: ticombo:catalog:index (built by ticombo-cache.js)
// ===========================

const CAMPAIGNS = {
  GB:    { camref: '1100l5P9x2', title: 'Ticombo UK'        },
  US:    { camref: '1100l5P9x3', title: 'Ticombo US'        },
  EU:    { camref: '1100l5P9wQ', title: 'Ticombo Europe'    },
  DE:    { camref: '1100l5P9wR', title: 'Ticombo Germany'   },
  ES:    { camref: '1100l5P9wT', title: 'Ticombo Spain'     },
  SG:    { camref: '1100l5P9wS', title: 'Ticombo Singapore' },
  MX:    { camref: '1100l5P9wN', title: 'Ticombo Mexico'    },
  APAC:  { camref: '1100l5P9wP', title: 'Ticombo APAC'      },
  LATAM: { camref: '1100l5P9wM', title: 'Ticombo LATAM'     },
};

// Country → campaign key mapping
const COUNTRY_MAP = {
  GB: 'GB', US: 'US', DE: 'DE', ES: 'ES', SG: 'SG', MX: 'MX',
  FR: 'EU', IT: 'EU', NL: 'EU', BE: 'EU', PT: 'EU', AT: 'EU',
  CH: 'EU', SE: 'EU', NO: 'EU', DK: 'EU', FI: 'EU', PL: 'EU',
  CZ: 'EU', RO: 'EU', HU: 'EU', GR: 'EU', IE: 'EU', HR: 'EU',
  AU: 'APAC', NZ: 'APAC', JP: 'APAC', KR: 'APAC', TH: 'APAC',
  MY: 'APAC', PH: 'APAC', ID: 'APAC', IN: 'APAC', CN: 'APAC',
  BR: 'LATAM', AR: 'LATAM', CO: 'LATAM', CL: 'LATAM', PE: 'LATAM',
};

const KV_INDEX = 'ticombo:catalog:index';

export async function onRequestGet({ request, env }) {
  const kv      = env.GIGSBERG_KV;
  const url     = new URL(request.url);
  const q       = (url.searchParams.get('q') || '').trim();
  const date    = url.searchParams.get('date') || '';
  const country = request.headers.get('CF-IPCountry') || url.searchParams.get('country') || 'GB';

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  const regionKey = COUNTRY_MAP[country] || 'GB';
  const campaign  = CAMPAIGNS[regionKey] || CAMPAIGNS.GB;
  const camref    = campaign.camref;

  // Build fallback search deep-link (always works, earns commission)
  const searchUrl     = `https://www.ticombo.com/en/search?q=${encodeURIComponent(q)}`;
  const fallbackUrl   = `https://ticombo.prf.hn/click/camref:${camref}/destination:${encodeURIComponent(searchUrl)}`;
  const fallbackMatch = {
    name: `${q} tickets on Ticombo`,
    url:  fallbackUrl,
    price: null, currency: 'GBP',
    date: null, venue: null, city: null,
    isFallback: true
  };

  if (!kv) return jsonResponse({ match: fallbackMatch }, 200);

  try {
    const raw = await kv.get(KV_INDEX);
    if (!raw) return jsonResponse({ match: fallbackMatch }, 200);

    const index    = JSON.parse(raw);
    const normQ    = normaliseName(q);
    const today    = new Date();
    const targetMs = date ? new Date(date).getTime() : 0;

    const scored = [];
    for (const item of index) {
      const normName = normaliseName(item.n);
      let score = 0;

      if (normName === normQ)                        score = 100;
      else if (normName.startsWith(normQ + ' '))     score = 80;
      else if (normName.includes(normQ))             score = 60;
      else {
        const words = normQ.split(/\s+/).filter(w => w.length > 2);
        if (words.length > 0 && words.every(w => normName.includes(w))) score = 40;
      }
      if (score === 0) continue;

      if (item.d && new Date(item.d) < today) continue;

      // Boost by region match
      if (item.r === regionKey) score += 15;

      // Date proximity boost
      if (targetMs && item.d) {
        const diffDays = Math.abs(new Date(item.d).getTime() - targetMs) / 86400000;
        if (diffDays <= 1)  score += 20;
        else if (diffDays <= 7) score += 10;
      }

      scored.push({ item, score });
    }

    if (scored.length === 0) return jsonResponse({ match: fallbackMatch }, 200);

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].item;

    // The cached URL is already a Partnerize affiliate link with the feed's camref baked in.
    // Simply swap the camref to the user's detected region for correct attribution.
    // Do NOT re-wrap in another prf.hn link — that creates a double-hop.
    let affiliateUrl = best.u;
    if (affiliateUrl.includes('camref:')) {
      // Replace whichever camref was stored during cache build with the user's camref
      affiliateUrl = affiliateUrl.replace(/camref:[^/]+/, `camref:${camref}`);
    } else {
      // Not a Partnerize link yet (bare ticombo.com URL) — wrap it once
      affiliateUrl = `https://ticombo.prf.hn/click/camref:${camref}/destination:${encodeURIComponent(affiliateUrl)}`;
    }

    return jsonResponse({
      match: {
        name:     best.n,
        url:      affiliateUrl,
        price:    best.p ? Math.round(best.p) : null,
        currency: best.c || 'EUR',
        date:     best.d || null,
        venue:    best.v || null,
        city:     best.t || null,
        category: best.g || null,
        region:   best.r || null
      }
    }, 200);

  } catch (err) {
    console.error('Ticombo adapter error:', err);
    return jsonResponse({ match: fallbackMatch }, 200);
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