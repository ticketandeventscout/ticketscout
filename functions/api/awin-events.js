// ===========================
// TicketScout — Awin events lookup
// functions/api/awin-events.js
// ===========================

const CACHE_KEY = 'awin:category:latest';

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const url       = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim().toLowerCase();
  const size = parseInt(url.searchParams.get('size') || '50');
  // Phase 1.4B: templates pass their own category so served events can be
  // registered for SSR. Optional — omitted calls behave exactly as before.
  const cat  = (url.searchParams.get('cat') || '').trim().toLowerCase();

  try {
    const index = await kv.get(`${CACHE_KEY}:index`, { type: 'json' });
    if (!index?.chunks) return jsonResponse({ events: [], total: 0, note: 'no index' }, 200);


    if (!name || name.length < 2) {
      return jsonResponse({ error: 'name is required (min 2 chars)' }, 400);
    }

    // When the caller declares a category, only return rows that actually
    // belong to it. Without this, a pure name substring match pulls in wrong-
    // category events — e.g. comedian "Chelsea Handler" or "Liverpool Legends"
    // (a tribute act) onto the Chelsea / Liverpool FOOTBALL pages.
    const catMatchers = {
      football: /\b(football|soccer|sport)\b/i,
      concert:  /\b(concert|music|gig|live music|tour)\b/i,
      theatre:  /\b(theatre|theater|musical|play|west end|show)\b/i
    };
    const wantCat = catMatchers[cat] || null;
    const rowInCategory = (row) => {
      if (!wantCat) return true; // no category declared → no filter (back-compat)
      const hay = `${row.merchant_category || ''} ${row.category_name || ''}`;
      if (wantCat.test(hay)) return true;
      // Fall back to the "Event Type: X" marker embedded in the description
      const m = (row.description || '').match(/Event Type:\s*([^,\n]+)/i);
      return m ? wantCat.test(m[1]) : false;
    };

    const matches = [];
    for (let i = 0; i < index.chunks; i++) {
      const chunk = await kv.get(`${CACHE_KEY}:chunk:${i}`, { type: 'json' });
      if (!chunk) continue;
      for (const row of chunk) {
        const productName = (row.product_name || '').toLowerCase();
        const description = (row.description || '').toLowerCase();
        if (!productName.includes(name) && !description.includes(name)) continue;
        if (!rowInCategory(row)) continue;   // wrong-category guard
        matches.push({
          id:           `awin-${row.merchant_id}-${encodeURIComponent(row.aw_deep_link).slice(-20)}`,
          name:         row.product_name,
          url:          row.aw_deep_link,
          price:        row.price,
          currency:     row.currency || 'GBP',
          image:        row.image_url || null,
          merchantName: row.merchant_name,
          category:     row.merchant_category || row.category_name,
          description:  row.description,
          date:         extractDate(row.description),
          venue:        extractVenue(row.description),
        });
        if (matches.length >= size * 2) break;
      }
      if (matches.length >= size * 2) break;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const future = matches.filter(m => !m.date || m.date >= todayStr);
    const seen = new Set();
    const deduped = future.filter(m => {
      const key = `${m.name}|${m.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, size);
    deduped.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    // Phase 1.4B: register served events in the D1 events registry so
    // /event/{slug} pages can server-render them. Only when the caller
    // declared a category and the event has a real date (dateless Awin
    // rows can't form a stable slug — they stay on the legacy hash route).
    if (['football', 'concert', 'theatre'].includes(cat)) {
      tsCaptureThrottled(env, (p) => ctx.waitUntil(p), 'awin:' + cat + ':' + name, () => {
        const records = [];
        for (const m of deduped) {
          if (!m.date) continue;
          const slug = tsEventSlug(cat, m.date, m.name);
          if (!slug) continue;
          records.push({
            slug, category: cat, name: m.name, date: m.date,
            venue: m.venue || null, city: null,
            price: m.price ? Math.round(m.price) : null,
            currency: m.currency || 'GBP',
            tmUrl: null, image: m.image || null,
            source: 'awin:' + (m.merchantName || 'awin')
          });
        }
        return records;
      });
    }

    return jsonResponse({ events: deduped, total: deduped.length }, 200);

  } catch (err) {
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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}


// ===========================
// Phase 1.4B — event registry capture
// Shared block: identical copies live in ticketmaster.js and the other
// capture files; tsEventSlug also has a client copy in compare.js.
// Slug format is FROZEN v1 — never change without migrating /event/ URLs.
// ===========================

// {category}-{yyyy-mm-dd}-{normalised-name} — MUST MATCH all other copies.
function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}

// Batched D1 upsert. updated_at only bumps when content actually changed —
// the sitemap uses it as lastmod, and fake lastmod trains Google to ignore it.
async function tsRegisterEvents(env, records) {
  const db = env.PRICE_DB;
  if (!db || !records || !records.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) ' +
    'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ' +
    'ON CONFLICT(slug) DO UPDATE SET ' +
    'name=excluded.name, ' +
    'venue=COALESCE(excluded.venue, event_pages.venue), ' +
    'city=COALESCE(excluded.city, event_pages.city), ' +
    'price=COALESCE(excluded.price, event_pages.price), ' +
    'currency=COALESCE(excluded.currency, event_pages.currency), ' +
    'tm_url=COALESCE(excluded.tm_url, event_pages.tm_url), ' +
    'image=COALESCE(excluded.image, event_pages.image), ' +
    'source=excluded.source, ' +
    'updated_at=CASE WHEN event_pages.name IS NOT excluded.name ' +
    'OR event_pages.venue IS NOT COALESCE(excluded.venue, event_pages.venue) ' +
    'OR event_pages.city IS NOT COALESCE(excluded.city, event_pages.city) ' +
    'OR event_pages.price IS NOT COALESCE(excluded.price, event_pages.price) ' +
    'THEN excluded.updated_at ELSE event_pages.updated_at END'
  );
  const seen = new Set();
  const batch = [];
  for (const r of records) {
    if (!r || !r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    batch.push(stmt.bind(
      r.slug, r.category, r.name, r.date,
      r.venue || null, r.city || null,
      r.price || null, r.currency || null,
      r.tmUrl || null, r.image || null,
      r.source || null, now
    ));
    if (batch.length >= 400) break; // per-request safety cap
  }
  if (batch.length) await db.batch(batch);
}

// Cache-API throttle: at most one registry write per markerId per 6h per
// colo. Costs zero KV writes; fail-open and fully fire-and-forget.
function tsCaptureThrottled(env, waitUntil, markerId, buildRecords) {
  try {
    if (!env.PRICE_DB) return;
    const cache = caches.default;
    const marker = new Request('https://ts-internal.ticketscout.co.uk/event-capture/' + encodeURIComponent(markerId));
    waitUntil((async () => {
      if (await cache.match(marker)) return;
      const records = buildRecords();
      if (!records || !records.length) return;
      await tsRegisterEvents(env, records);
      await cache.put(marker, new Response('1', { headers: { 'Cache-Control': 'max-age=21600' } }));
    })().catch(() => {}));
  } catch {}
}
