// ===========================
// TicketScout — TicketNetwork affiliate adapter
// Runs as a Cloudflare Pages Function at /api/ticketnetwork
//
// Uses Impact.com catalog search (same account as Vivid Seats)
// Commission: 12-14% on ticket sales
//
// Impact details:
//   Publisher: 7443544
//   Tracking links: https://ticketnetwork.lusg.net/c/7443544/120057/2322
//                   https://ticketnetwork.lusg.net/c/7443544/120057/2322
//   Catalog IDs: 896 (184,619 products) and 1872 (192,937 products - API)
//
// KV key: tn:catalog:index (built by ticketnetwork-cache.js)
//
// Usage: GET /api/ticketnetwork?q=Metallica&date=2026-10-01
// Returns: { match: { name, url, price, currency, date, venue, city } } or { match: null }
// ===========================

// TicketNetwork tracking: use their direct affiliate URL format
// Publisher 7443544, tracked via aff_id param on ticketnetwork.com
const TN_AFF_PARAMS = 'aff_id=1000&aff_sub=7443544&utm_source=impact&utm_medium=affiliate';
const TRACKING_BASE  = 'https://www.ticketnetwork.com';  // base domain
const TRACKING_BASE2 = 'https://www.ticketnetwork.com';
const KV_INDEX       = 'tn:catalog:index';

export async function onRequestGet({ request, env }) {
  const kv   = env.GIGSBERG_KV;
  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || '';
  const city = (url.searchParams.get('city') || '').toLowerCase().trim();
  const mode = url.searchParams.get('mode') || 'single'; // 'list' returns all matches

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  // Build fallback search deep-link — use clean Impact tracking URL
  // TN search URL — use /search not /tickets/search
  const searchUrl   = `https://www.ticketnetwork.com/search?q=${encodeURIComponent(q)}`;
  const fallbackUrl = `${searchUrl}&${TN_AFF_PARAMS}`;
  const fallback    = {
    name: `${q} tickets on TicketNetwork`,
    url:  fallbackUrl,
    price: null, currency: 'USD',
    date: null, venue: null, city: null,
    isFallback: true
  };

  if (!kv) return jsonResponse({ match: fallback }, 200);

  try {
    // Read chunked index
    const chunkCountRaw = await kv.get('tn:catalog:chunks');
    if (!chunkCountRaw) return jsonResponse({ match: fallback }, 200);

    const numChunks = parseInt(chunkCountRaw, 10);
    const chunkRaws = await Promise.all(
      Array.from({ length: numChunks }, (_, i) => kv.get(`tn:catalog:chunk:${i}`))
    );
    const index = chunkRaws.flatMap(r => r ? JSON.parse(r) : []);
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

      // Hard date filter — tighter when city context is available
      if (targetMs && item.d) {
        const diffDays = Math.abs(new Date(item.d).getTime() - targetMs) / 86400000;
        // With city: ±3 days only (same artist in different city = wrong event)
        // Without city: ±14 days (less context to go on)
        const maxDays = city ? 3 : 14;
        if (diffDays > maxDays) continue;
        if (diffDays <= 1)  score += 30;
        else if (diffDays <= 3) score += 15;
        else if (diffDays <= 7) score += 5;
      }

      // City boost — heavily weighted so wrong-city events never win
      if (city && item.t && item.t.toLowerCase().includes(city)) score += 40;

      scored.push({ item, score });
    }

    if (scored.length === 0) return jsonResponse(mode === 'list' ? { matches: [] } : { match: fallback }, 200);

    scored.sort((a, b) => b.score - a.score);

    // Clean the stored TN URL — strip broken clickId/afsrc params, keep just the path
    // and append our affiliate tracking params instead
    const cleanTnUrl = (rawUrl) => {
      try {
        const u = new URL(rawUrl);
        if (u.hostname.includes('ticketnetwork.com')) {
          // Keep just the path (e.g. /tickets/london-eye-tickets/...)
          const clean = new URL(u.pathname, 'https://www.ticketnetwork.com');
          // If it's a search page, preserve the q param
          if (u.searchParams.get('q')) clean.searchParams.set('q', u.searchParams.get('q'));
          // Append affiliate tracking
          const sep = clean.search ? '&' : '?';
          return clean.toString() + sep + TN_AFF_PARAMS;
        }
      } catch(e) {}
      return rawUrl;
    };

    const buildMatch = (item) => ({
      name:     item.n,
      url:      cleanTnUrl(item.u || fallbackUrl),
      price:    item.p ? Math.round(item.p) : null,
      currency: item.c || 'USD',
      date:     item.d || null,
      venue:    item.v || null,
      city:     item.t || null,
      category: item.g || null
    });

    if (mode === 'list') {
      // Return all matches above score threshold 40, capped at 50
      const matches = scored
        .filter(s => s.score >= 40)
        .slice(0, 50)
        .map(s => buildMatch(s.item));
      return jsonResponse({ matches }, 200);
    }

    return jsonResponse({ match: buildMatch(scored[0].item) }, 200);

  } catch(err) {
    console.error('TicketNetwork adapter error:', err);
    return jsonResponse({ match: fallback }, 200);
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