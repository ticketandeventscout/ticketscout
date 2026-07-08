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
  const kv  = env.GIGSBERG_KV;
  const url = new URL(request.url);
  const q   = (url.searchParams.get('q') || '').trim();
  const date = url.searchParams.get('date') || '';

  if (!q || q.length < 2) return jsonResponse({ error: 'q is required' }, 400);

  if (!kv) return jsonResponse({ match: null, reason: 'kv_missing' }, 200);

  try {
    const raw = await kv.get('vs:catalog:index');
    if (!raw) {
      // Cache not yet built — return search fallback link so page still works
      const searchUrl = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(q)}`;
      return jsonResponse({
        match: {
          name:       `Search ${q} on Vivid Seats`,
          url:        `${FALLBACK_LINK}?u=${encodeURIComponent(searchUrl)}`,
          price:      null,
          currency:   'USD',
          date:       null,
          venue:      null,
          city:       null,
          isFallback: true
        }
      }, 200);
    }

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

      // Skip past events
      if (item.d && new Date(item.d) < today) continue;

      // Date proximity boost
      if (targetMs && item.d) {
        const diffDays = Math.abs(new Date(item.d).getTime() - targetMs) / 86400000;
        if (diffDays <= 1) score += 20;
        else if (diffDays <= 7) score += 10;
      }

      scored.push({ item, score });
    }

    if (scored.length === 0) return jsonResponse({ match: null }, 200);

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].item;

    return jsonResponse({
      match: {
        name:     best.n,
        url:      best.u,
        price:    best.p ? Math.round(best.p) : null,
        currency: best.c || 'USD',
        date:     best.d || null,
        venue:    best.v || null,
        city:     best.t || null,
        category: best.g || null
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