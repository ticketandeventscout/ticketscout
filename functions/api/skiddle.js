// ===========================
// TicketScout — Server-side Skiddle adapter
// Runs as a Cloudflare Pages Function at /api/skiddle
//
// Skiddle provides two affiliate XML feeds:
//   - Top sellers: http://xml.skiddlecdn.co.uk/xml/affiliates/topsellers.xml
//   - Festivals:   http://xml.skiddlecdn.co.uk/xml/affiliates/festivals.xml
//
// Both feeds are fetched and cached in Cloudflare KV (SKIDDLE_KV) for
// 6 hours to avoid hammering the feed URL on every page load.
// At request time we search the cached feed for the best name match
// and return a normalised result to the client.
//
// Affiliate tag (sktag) is appended to all outbound URLs so purchases
// are tracked back to TicketScout.
//
// Required env vars (Cloudflare Pages → Settings → Variables and secrets):
//   SKIDDLE_AFFILIATE_TAG   — your affiliate tag number (e.g. 15734)
//
// Optional KV binding (add when ready for caching):
//   SKIDDLE_KV              — KV namespace binding
//
// Part of the TicketScout source adapter pattern.
// Normalisation into { source, price, currency, url, available }
// is handled in compare.js by the Skiddle adapter entry.
// ===========================

const FEED_URLS = {
  topsellers: 'http://xml.skiddlecdn.co.uk/xml/affiliates/topsellers.xml',
  festivals:  'http://xml.skiddlecdn.co.uk/xml/affiliates/festivals.xml'
};

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export async function onRequestGet({ request, env }) {
  const affiliateTag = env.SKIDDLE_AFFILIATE_TAG;

  if (!affiliateTag) {
    return jsonResponse({ error: 'Server is missing SKIDDLE_AFFILIATE_TAG.' }, 500);
  }

  const incoming = new URL(request.url);
  const q        = incoming.searchParams.get('q');
  const feed     = incoming.searchParams.get('feed') || 'topsellers';

  if (!q) {
    return jsonResponse({ error: 'q (event name) is required.' }, 400);
  }

  if (!FEED_URLS[feed]) {
    return jsonResponse({ error: `Unknown feed "${feed}". Use "topsellers" or "festivals".` }, 400);
  }

  try {
    const xml = await fetchFeed(feed, env);
    if (!xml) {
      return jsonResponse({ error: 'Feed unavailable.' }, 502);
    }

    const events = parseFeed(xml);
    const match  = findBestMatch(events, q);

    if (!match) {
      return jsonResponse({ match: null }, 200);
    }

    // Append affiliate tag to the event URL
    const url = appendAffiliateTag(match.url, affiliateTag);

    return jsonResponse({ match: { ...match, url } }, 200);
  } catch (err) {
    console.error('Skiddle feed error:', err);
    return jsonResponse({ error: 'Unable to fetch Skiddle feed.' }, 502);
  }
}

// ===========================
// Feed fetching — uses KV cache when available, falls back to direct fetch
// ===========================

async function fetchFeed(feedName, env) {
  const cacheKey = `skiddle:feed:${feedName}`;

  // Try KV cache first
  if (env.SKIDDLE_KV) {
    try {
      const cached = await env.SKIDDLE_KV.get(cacheKey);
      if (cached) return cached;
    } catch (e) {
      console.warn('KV read failed, falling back to direct fetch:', e);
    }
  }

  // Fetch fresh from Skiddle CDN
  const response = await fetch(FEED_URLS[feedName]);
  if (!response.ok) return null;

  const xml = await response.text();

  // Store in KV cache if available
  if (env.SKIDDLE_KV && xml) {
    try {
      await env.SKIDDLE_KV.put(cacheKey, xml, { expirationTtl: CACHE_TTL_SECONDS });
    } catch (e) {
      console.warn('KV write failed:', e);
    }
  }

  return xml;
}

// ===========================
// XML parsing — extracts event records from Skiddle's feed format
// Expected fields per event: <name>, <date>, <price>, <link>, <venue>
// We parse conservatively — missing fields are set to null rather than erroring
// ===========================

function parseFeed(xml) {
  const events = [];

  // Match each <event>...</event> block
  const eventBlocks = xml.match(/<event[\s\S]*?<\/event>/gi) || [];

  eventBlocks.forEach(block => {
    const get = tag => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : null;
    };

    const name  = get('name') || get('eventname') || get('title');
    const link  = get('link') || get('url') || get('eventlink');
    const price = get('price') || get('mincost') || get('ticketprice');
    const venue = get('venue') || get('venuename');
    const date  = get('date') || get('eventdate') || get('startdate');

    if (name && link) {
      events.push({
        name,
        url: link,
        price: parsePrice(price),
        venue: venue || null,
        date:  date  || null
      });
    }
  });

  return events;
}

function parsePrice(raw) {
  if (!raw) return null;
  // Strip currency symbols and extract first number
  const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// ===========================
// Matching — find the best event name match for a given query
// Prefers exact then starts-with then contains; among ties picks lowest price
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function findBestMatch(events, query) {
  const normQuery = normaliseName(query);

  const scored = events
    .map(e => {
      const normName = normaliseName(e.name);
      let score = 0;
      if (normName === normQuery)              score = 100;
      else if (normName.startsWith(normQuery)) score = 60;
      else if (normName.includes(normQuery))   score = 30;
      else if (normQuery.includes(normName) && normName.length > 4) score = 20;
      return { ...e, _score: score };
    })
    .filter(e => e._score > 0)
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      // Among equal scores, prefer events with a price, then lowest price
      if (a.price && !b.price) return -1;
      if (!a.price && b.price) return  1;
      if (a.price && b.price)  return a.price - b.price;
      return 0;
    });

  return scored.length > 0 ? scored[0] : null;
}

// ===========================
// Affiliate tag — appends ?sktag=<tag> to Skiddle URLs
// ===========================

function appendAffiliateTag(url, tag) {
  try {
    const u = new URL(url);
    u.searchParams.set('sktag', tag);
    return u.toString();
  } catch {
    // If URL parsing fails, append manually
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}sktag=${tag}`;
  }
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
