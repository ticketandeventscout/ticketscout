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

const TRACKING_BASE  = 'https://ticketnetwork.lusg.net/c/7443544/132208/2322';  // Catalog 896 ad ID
const TRACKING_BASE2 = 'https://ticketnetwork.lusg.net/c/7443544/132208/2322';  // Catalog 896 ad ID
const KV_INDEX       = 'tn:catalog:index';

export async function onRequestGet({ request, env }) {
  const kv   = env.GIGSBERG_KV;
  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || '';
  const mode = url.searchParams.get('mode') || 'single'; // 'list' returns all matches

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  // Build fallback search deep-link
  const searchUrl   = `https://www.ticketnetwork.com/tickets/search?q=${encodeURIComponent(q)}`;
  const fallbackUrl = `${TRACKING_BASE}?u=${encodeURIComponent(searchUrl)}`;
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

      if (targetMs && item.d) {
        const diffDays = Math.abs(new Date(item.d).getTime() - targetMs) / 86400000;
        if (diffDays <= 1)  score += 20;
        else if (diffDays <= 7) score += 10;
      }
      scored.push({ item, score });
    }

    if (scored.length === 0) return jsonResponse(mode === 'list' ? { matches: [] } : { match: fallback }, 200);

    scored.sort((a, b) => b.score - a.score);

    const buildMatch = (item) => ({
      name:     item.n,
      url:      item.u || fallbackUrl,
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