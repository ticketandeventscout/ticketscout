// ===========================
// TicketScout — TicketNetwork catalog cache
// Runs as a Cloudflare Pages Function at /api/ticketnetwork-cache
//
// Uses Impact catalog API — catalog 1872 (193,637 events, API type)
// Returns XML not JSON — parsed with regex extraction
//
// Field mapping for catalog 1872:
//   Name        → event name
//   Url         → pre-built affiliate tracking link (ad ID 267961)
//   LaunchDate  → event date (ExpirationDate is empty)
//   Labels/Label[0] → venue name
//   Gtin        → city
//   Asin        → country
//   Category    → SPORTS/THEATRE/CONCERTS etc
//   Text1       → price range e.g. "$82.50- $82.50" (extract min)
//   AfterId pagination via @nextpageuri
//
// Runs in chunks — each cron trigger fetches MAX_PAGES pages and appends to KV
// First run: ?trigger=1&reset=1 (clears existing index)
// Subsequent runs: ?trigger=1 (appends to existing)
//
// KV keys:
//   tn:catalog:chunk:N  — JSON arrays of event objects
//   tn:catalog:chunks   — total chunk count
//   tn:catalog:cursor   — AfterId cursor for next run
//   tn:catalog:updated  — ISO timestamp
//   tn:catalog:stats    — { total, pages, updated }
//
// Required env vars: IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, GIGSBERG_KV
// ===========================

const CATALOG_ID = '1872';
const MAX_PAGES  = 150;  // ~15,000 items per run — stays under 30s limit
const CHUNK_MB   = 20;
const KV_TTL     = 8 * 24 * 60 * 60;
const TRACKING   = 'https://ticketnetwork.lusg.net/c/7443544/120057/2322';

export async function onRequestGet({ request, env }) {
  const url        = new URL(request.url);
  const kv         = env.GIGSBERG_KV;
  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get('tn:catalog:updated').catch(() => null);
    const stats   = await kv?.get('tn:catalog:stats').catch(() => null);
    const cursor  = await kv?.get('tn:catalog:cursor').catch(() => null);
    return text([
      'TicketNetwork catalog cache (XML API, catalog 1872)',
      '  ?trigger=1          — fetch next batch and append to KV',
      '  ?trigger=1&reset=1  — clear index and start fresh',
      '  ?trigger=1&test=1   — fetch 2 items and show parsed result',
      '',
      `Last updated: ${updated || 'never'}`,
      `Next cursor:  ${cursor || 'start (no cursor)'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!accountSid || !authToken) return json({ error: 'Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN' }, 500);
  if (!kv)                        return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/xml' };
  const base      = `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/${CATALOG_ID}/Items`;

  // Test mode — fetch 2 items and show parsed result
  if (url.searchParams.get('test') === '1') {
    const r    = await fetch(`${base}?PageSize=2`, { headers });
    const xml  = await r.text();
    const items = parseXmlItems(xml);
    return json({ status: r.status, parsed: items, rawSnippet: xml.slice(0, 300) }, 200);
  }

  // Reset mode — clear all existing chunks
  if (url.searchParams.get('reset') === '1') {
    const chunkCountRaw = await kv.get('tn:catalog:chunks').catch(() => null);
    if (chunkCountRaw) {
      const n = parseInt(chunkCountRaw, 10);
      await Promise.all(Array.from({ length: n }, (_, i) => kv.delete(`tn:catalog:chunk:${i}`)));
    }
    await Promise.all([
      kv.delete('tn:catalog:chunks'),
      kv.delete('tn:catalog:cursor'),
      kv.delete('tn:catalog:stats'),
      kv.delete('tn:catalog:updated'),
    ]);
    return json({ reset: true, message: 'Index cleared. Run ?trigger=1 to start fresh build.' }, 200);
  }

  // Load existing state
  const today         = new Date();
  let   afterId       = await kv.get('tn:catalog:cursor').catch(() => null);
  let   chunkCountRaw = await kv.get('tn:catalog:chunks').catch(() => null);
  let   existingChunks = chunkCountRaw ? parseInt(chunkCountRaw, 10) : 0;
  let   existingStats  = null;
  try { existingStats = JSON.parse(await kv.get('tn:catalog:stats') || '{}'); } catch {}

  const newItems = [];
  let pages      = 0;
  let done       = false;

  while (pages < MAX_PAGES) {
    const reqUrl = new URL(base);
    reqUrl.searchParams.set('PageSize', '100');
    if (afterId) reqUrl.searchParams.set('AfterId', afterId);

    const resp = await fetch(reqUrl.toString(), { headers });
    if (!resp.ok) {
      return json({ error: `HTTP ${resp.status} on page ${pages + 1}`, itemsSoFar: newItems.length }, 500);
    }

    const xml   = await resp.text();
    const items = parseXmlItems(xml);
    pages++;

    for (const item of items) {
      if (!item.n || !item.u) continue;
      // Skip events with no launch date or already past
      if (item.d && new Date(item.d) < today) continue;
      newItems.push(item);
    }

    // Get next cursor from nextpageuri
    const nextMatch = xml.match(/nextpageuri="[^"]*AfterId=([^"&]+)"/);
    if (!nextMatch || items.length === 0) {
      done = true;
      afterId = null;
      break;
    }
    afterId = decodeURIComponent(nextMatch[1]);
  }

  // Split new items into chunks and append to existing
  const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;
  let   chunk       = [];
  let   chunkBytes  = 0;
  let   chunkIdx    = existingChunks;
  const puts        = [];

  for (const item of newItems) {
    const s = JSON.stringify(item);
    if (chunkBytes + s.length > CHUNK_BYTES && chunk.length > 0) {
      puts.push(kv.put(`tn:catalog:chunk:${chunkIdx}`, JSON.stringify(chunk), { expirationTtl: KV_TTL }));
      chunkIdx++; chunk = []; chunkBytes = 0;
    }
    chunk.push(item); chunkBytes += s.length;
  }
  if (chunk.length > 0) {
    puts.push(kv.put(`tn:catalog:chunk:${chunkIdx}`, JSON.stringify(chunk), { expirationTtl: KV_TTL }));
    chunkIdx++;
  }

  const totalItems = (existingStats?.total || 0) + newItems.length;
  const stats = {
    total: totalItems,
    chunks: chunkIdx,
    pages: (existingStats?.pages || 0) + pages,
    done,
    updated: new Date().toISOString()
  };

  puts.push(kv.put('tn:catalog:chunks', String(chunkIdx),      { expirationTtl: KV_TTL }));
  puts.push(kv.put('tn:catalog:stats',  JSON.stringify(stats), { expirationTtl: KV_TTL }));
  puts.push(kv.put('tn:catalog:updated', new Date().toISOString(), { expirationTtl: KV_TTL }));

  if (!done && afterId) {
    puts.push(kv.put('tn:catalog:cursor', afterId, { expirationTtl: KV_TTL }));
  } else {
    puts.push(kv.delete('tn:catalog:cursor'));
  }

  await Promise.all(puts);

  return json({
    success:    true,
    newItems:   newItems.length,
    totalItems,
    chunks:     chunkIdx,
    pages,
    done,
    nextCursor: done ? null : afterId,
    message:    done ? 'Index complete!' : `Run ?trigger=1 again to fetch next batch`
  }, 200);
}

// Parse XML items from Impact API response
function parseXmlItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<Item>([\s\S]*?)<\/Item>/g) || [];

  for (const block of itemBlocks) {
    const get = tag => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };
    const getFirst = tag => {
      const m = block.match(new RegExp(`<${tag}>[\\s\\S]*?<Label>([^<]*)<\\/Label>`));
      return m ? m[1].trim() : '';
    };

    const name      = get('Name');
    const url       = get('Url');
    const launchDate = get('LaunchDate');
    const priceText  = get('Text1'); // e.g. "$82.50- $82.50"
    const venue      = getFirst('Labels') || get('Description');
    const city       = get('Gtin');
    const category   = get('Category');

    // Extract min price from Text1 "$82.50- $82.50"
    const priceMatch = priceText.match(/\$?([\d.]+)/);
    const price      = priceMatch ? parseFloat(priceMatch[1]) : null;

    // Format date from LaunchDate ISO string
    const date = launchDate ? launchDate.split('T')[0] : '';

    if (!name || !url) continue;

    items.push({
      n: name,
      u: url,   // already contains affiliate tracking (ad ID 267961)
      p: price && price > 0 ? price : null,
      c: 'USD',
      d: date,
      v: venue,
      t: city,
      g: category,
    });
  }
  return items;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}