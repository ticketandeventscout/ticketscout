// ===========================
// TicketScout — Awin events lookup by artist/show name
// Runs as a Cloudflare Pages Function at /api/awin-events
// ===========================

const CACHE_KEY = 'awin:category:latest';

export async function onRequestGet({ request, env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const url  = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim().toLowerCase();
  const size = parseInt(url.searchParams.get('size') || '50');
  const debug = url.searchParams.get('debug') === '1'; // ?debug=1 to inspect raw rows

  if (!name || name.length < 2) {
    return jsonResponse({ error: 'name is required (min 2 chars)' }, 400);
  }

  try {
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });
    if (!index?.chunks) return jsonResponse({ events: [], total: 0, debug: 'no index found' }, 200);

    // Debug mode — return sample rows from first chunk so we can see real field values
    if (debug) {
      const chunk0 = await kv.get(`${CACHE_KEY}:chunk:0`, { type: 'json' });
      if (!chunk0) return jsonResponse({ error: 'chunk 0 empty' }, 200);

      // Find rows from Football TicketNet or Gigsberg sport rows
      const footballRows = chunk0
        .filter(r => 
          (r.merchant_name || '').toLowerCase().includes('football') ||
          (r.merchant_name || '').toLowerCase().includes('gigsberg') ||
          (r.merchant_category || '').toLowerCase().includes('sport') ||
          (r.merchant_category || '').toLowerCase().includes('football')
        )
        .slice(0, 10);

      // Also sample first 5 rows regardless
      const sampleRows = chunk0.slice(0, 5);

      return jsonResponse({
        chunks: index.chunks,
        chunk0_total_rows: chunk0.length,
        football_sample: footballRows.map(r => ({
          product_name: r.product_name,
          merchant_name: r.merchant_name,
          merchant_category: r.merchant_category,
          description: r.description,
          price: r.price,
          currency: r.currency
        })),
        general_sample: sampleRows.map(r => ({
          product_name: r.product_name,
          merchant_name: r.merchant_name,
          merchant_category: r.merchant_category,
          description: (r.description || '').slice(0, 150)
        }))
      }, 200);
    }

    const matches = [];

    for (let i = 0; i < index.chunks; i++) {
      const chunk = await kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' });
      if (!chunk) continue;

      for (const row of chunk) {
        const productName = (row.product_name || '').toLowerCase();
        const description = (row.description || '').toLowerCase();
        const merchantCategory = (row.merchant_category || '').toLowerCase();

        // Match against product name OR description
        if (!productName.includes(name) && !description.includes(name)) continue;

        matches.push({
          id:            `awin-${row.merchant_id}-${encodeURIComponent(row.aw_deep_link).slice(-20)}`,
          name:          row.product_name,
          url:           row.aw_deep_link,
          price:         row.price,
          currency:      row.currency || 'GBP',
          image:         row.image_url || null,
          merchantName:  row.merchant_name,
          category:      row.merchant_category || row.category_name,
          description:   row.description,
          date:          extractDate(row.description),
          venue:         extractVenue(row.description),
        });

        if (matches.length >= size * 2) break;
      }

      if (matches.length >= size * 2) break;
    }

    // Filter out past events
    const todayStr = new Date().toISOString().slice(0, 10);
    const future = matches.filter(m => !m.date || m.date >= todayStr);

    // Deduplicate
    const seen = new Set();
    const deduped = future.filter(m => {
      const key = `${m.name}|${m.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, size);

    // Sort by date ascending
    deduped.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    return jsonResponse({ events: deduped, total: deduped.length }, 200);

  } catch (err) {
    console.error('Awin events error:', err);
    return jsonResponse({ error: String(err) }, 500);
  }
}

function extractDate(description) {
  if (!description) return null;
  const isoMatch = description.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
  if (isoMatch) return isoMatch[1];
  const dmyMatch = description.match(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  return null;
}

function extractVenue(description) {
  if (!description) return null;
  const match = description.match(/Venue:\s*([^,\n]+)/i);
  return match ? match[1].trim() : null;
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