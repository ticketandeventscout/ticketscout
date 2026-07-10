// ===========================
// TicketScout — Vivid Seats affiliate adapter
// Runs as a Cloudflare Pages Function at /api/vividseats
//
// Searches the KV cache built by /api/vividseats-cache.
// Falls back to a Vivid Seats search deep-link if cache is empty.
//
// Required KV key: vs:catalog:index (built by vividseats-cache.js)
// ===========================

const FALLBACK_LINK = 'https://vivid-seats.pxf.io/c/7443544/952533/12730';

export async function onRequestGet({ request, env }) {
  const kv   = env.GIGSBERG_KV;
  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || '';
  const city = (url.searchParams.get('city') || '').toLowerCase().trim();
  const mode = url.searchParams.get('mode') || 'single'; // 'list' returns all matches

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  if (!kv) return jsonResponse({ match: null, reason: 'kv_missing' }, 200);

  try {
    // Read chunked index — chunks are stored as vs:catalog:chunk:0, :1, :2 ...
    const chunkCountRaw = await kv.get('vs:catalog:chunks');

    if (!chunkCountRaw) {
      // Cache not yet built — return search fallback link so page still works
      const searchUrl = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(q)}`;
      return jsonResponse({
        match: {
          name:       `Search ${q} on Vivid Seats`,
          url:        `${FALLBACK_LINK}?u=${encodeURIComponent(searchUrl)}`,
          price:      null, currency: 'USD', date: null, venue: null, city: null,
          isFallback: true
        }
      }, 200);
    }

    // Fetch all chunks in parallel
    const numChunks  = parseInt(chunkCountRaw, 10);
    const chunkKeys  = Array.from({ length: numChunks }, (_, i) => `vs:catalog:chunk:${i}`);
    const chunkRaws  = await Promise.all(chunkKeys.map(k => kv.get(k)));
    const index      = chunkRaws.flatMap(raw => raw ? JSON.parse(raw) : []);
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

      // Skip past events
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

    if (scored.length === 0) return jsonResponse(mode === 'list' ? { matches: [] } : { match: null }, 200);

    scored.sort((a, b) => b.score - a.score);

    const buildMatch = (item) => ({
      name:     item.n,
      url:      item.u,
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