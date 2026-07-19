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
  const city    = (url.searchParams.get('city') || '').toLowerCase().trim();
  const country = request.headers.get('CF-IPCountry') || url.searchParams.get('country') || 'GB';

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  const regionKey = COUNTRY_MAP[country] || 'GB';
  const campaign  = CAMPAIGNS[regionKey] || CAMPAIGNS.GB;
  const camref    = campaign.camref;

  // Build fallback search deep-link (always works, earns commission)
  // Ticombo search: /en/discover/search is the correct path (not /en/search)
  const searchUrl   = `https://www.ticombo.com/en/discover/search?query=${encodeURIComponent(q)}`;
  const fallbackUrl = `https://ticombo.prf.hn/click/camref:${camref}/destination:${encodeURIComponent(searchUrl)}`;
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
      let nameScore = 0;

      if (normName === normQ)                        score = 100;
      else if (normName.startsWith(normQ + ' '))     score = 80;
      else if (normName.includes(normQ))             score = 60;
      else {
        const words = normQ.split(/\s+/).filter(w => w.length > 2);
        if (words.length > 0 && words.every(w => normName.includes(w))) score = 40;
      }
      if (score === 0) continue;
      nameScore = score; // preserve the pure name-match strength before boosts

      if (item.d && new Date(item.d) < today) continue;

      // Boost by region match
      if (item.r === regionKey) score += 15;

      // Hard date filter — tighter window when city is provided
      if (targetMs && item.d) {
        const diffDays = Math.abs(new Date(item.d).getTime() - targetMs) / 86400000;
        // When city is known, only allow ±3 days (same performer in different city = wrong event)
        // When no city, allow ±7 days (tightened from 14 to reduce wrong-event matches)
        const maxDays = city ? 3 : 7;
        if (diffDays > maxDays) continue;
        if (diffDays <= 1)  score += 30;
        else if (diffDays <= 3) score += 15;
        else if (diffDays <= 7) score += 5;
      }

      // City boost — strongly prefer events in the right city
      let cityMatch = false;
      if (city && item.t && item.t.toLowerCase().includes(city)) { score += 40; cityMatch = true; }

      scored.push({ item, score, nameScore, cityMatch });
    }

    // Debug: log scoring results
    console.log('[Ticombo] query:', q, 'date:', date, 'city:', city,
      'scored:', scored.length, scored.slice(0,3).map(s => s.item.n + '(' + s.item.d + ')score=' + s.score).join('|'));

    // If date was provided but no events matched the date window, use search fallback
    // This prevents returning a completely wrong-date event
    if (targetMs && scored.length === 0) {
      console.log('[Ticombo] No date match — using search fallback');
      return jsonResponse({ match: fallbackMatch }, 200);
    }

    if (scored.length === 0) return jsonResponse({ match: fallbackMatch }, 200);

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // This feed carries NO date column, so matched items have no date. Rather
    // than suppress every price (the feed would then never show one), gate on
    // NAME-MATCH CONFIDENCE — but account for the fact that some categories are
    // RECURRING (a football team name repeats across dozens of fixtures, so a
    // strong name match alone can't pin the right date/price), while others are
    // effectively UNIQUE (a specific concert/tour/show name).
    //   • Unique-name categories (concerts, shows): a strong name match
    //     (nameScore >= 80) is enough to show the price.
    //   • Recurring categories (football/sport): a name match is NOT enough on
    //     its own — require a city match to corroborate, otherwise keep the
    //     click-through fallback (no misleading arbitrary-fixture price).
    const RECURRING = /(football|soccer|sport|rugby|cricket|tennis|basketball|nfl|nba|f1|formula|motogp|golf)/i;
    const isRecurring = RECURRING.test(best.item.g || '') || RECURRING.test(q);
    const dateConfident = !targetMs || !!best.item.d;   // a real date match, if any
    const nameConfident = isRecurring
      ? (best.nameScore >= 60 && best.cityMatch)         // recurring: need city corroboration
      : (best.nameScore >= 80 || (best.nameScore >= 60 && best.cityMatch)); // unique: strong name is enough
    if (!dateConfident && !nameConfident) {
      console.log('[Ticombo] No date + insufficient confidence (' +
        (isRecurring ? 'recurring' : 'unique') + ', nameScore=' + best.nameScore +
        ', city=' + best.cityMatch + ') — using search fallback');
      return jsonResponse({ match: fallbackMatch }, 200);
    }
    const bestItem = best.item;

    // The cached URL is already a complete Partnerize affiliate link (prf.hn) with
    // the feed's regional camref baked in. Use it directly — do NOT re-wrap.
    // If for any reason it is a bare ticombo.com URL, wrap it once.
    const affiliateUrl = bestItem.u.includes('prf.hn')
      ? bestItem.u
      : `https://ticombo.prf.hn/click/camref:${camref}/destination:${encodeURIComponent(bestItem.u)}`;

    return jsonResponse({
      match: {
        name:     bestItem.n,
        url:      affiliateUrl,
        price:    bestItem.p ? Math.round(bestItem.p) : null,
        currency: bestItem.c || 'EUR',
        date:     bestItem.d || null,
        venue:    bestItem.v || null,
        city:     bestItem.t || null,
        category: bestItem.g || null,
        region:   bestItem.r || null
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