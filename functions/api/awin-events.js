// ===========================
// TicketScout — Awin events lookup by artist/show name
// Runs as a Cloudflare Pages Function at /api/awin-events
//
// Searches the Awin KV cache for events matching a given name.
// Used by concert pages to show events from Theatre Tickets Direct,
// Gigsberg, Football TicketNet etc. when Ticketmaster has no results.
//
// Usage: GET /api/awin-events?name=Lion+King&size=50
// Returns: { events: [...], total: N }
//
// Required env vars:
//   GIGSBERG_KV — KV namespace binding
// ===========================

const CACHE_KEY = 'awin:category:latest';

export async function onRequestGet({ request, env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const url  = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim().toLowerCase();
  const size = parseInt(url.searchParams.get('size') || '50');

  if (!name || name.length < 2) {
    return jsonResponse({ error: 'name is required (min 2 chars)' }, 400);
  }

  try {
    // Load index to know how many chunks to scan
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });
    if (!index?.chunks) return jsonResponse({ events: [], total: 0 }, 200);

    const matches = [];

    for (let i = 0; i < index.chunks; i++) {
      const chunk = await kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' });
      if (!chunk) continue;

      for (const row of chunk) {
        const productName = (row.product_name || '').toLowerCase();
        const description = (row.description || '').toLowerCase();

        // Match against product name primarily
        if (!productName.includes(name)) continue;

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
          // Extract date from description if present
          date:          extractDate(row.description),
          venue:         extractVenue(row.description),
        });

        if (matches.length >= size * 2) break; // gather extra for dedup
      }

      if (matches.length >= size * 2) break;
    }

    // Deduplicate by product name + date combination
    const seen = new Set();
    const deduped = matches.filter(m => {
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

// Extract date from Awin description field
// Formats seen: "Date: 2026-08-15", "Date: 15/08/2026", "Sat 15 Aug 2026"
function extractDate(description) {
  if (!description) return null;

  // Format: "Date: YYYY-MM-DD"
  const isoMatch = description.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i);
  if (isoMatch) return isoMatch[1];

  // Format: "Date: DD/MM/YYYY"
  const dmyMatch = description.match(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;

  return null;
}

// Extract venue from Awin description field
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
      'Cache-Control': 'public, max-age=1800' // 30 min cache
    }
  });
}
