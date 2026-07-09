// ===========================
// TicketScout — TicketNetwork catalog cache
// Runs as a Cloudflare Pages Function at /api/ticketnetwork-cache
//
// Uses Impact catalog API (same account as Vivid Seats)
// Catalog ID 896: 184,619 products (CSV feed)
// Catalog ID 1872: 192,937 products (API feed)
//
// Auth: IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN (already in Cloudflare env)
//
// Usage:
//   ?trigger=1        — build KV index from Impact catalog API
//   ?trigger=1&test=1 — connectivity test only
// ===========================

const CATALOG_ID  = '1872'; // API catalog — larger inventory
const KV_INDEX    = 'tn:catalog:index';
const KV_UPDATED  = 'tn:catalog:updated';
const KV_STATS    = 'tn:catalog:stats';
const KV_TTL      = 8 * 24 * 60 * 60;
const TRACKING    = 'https://ticketnetwork.lusg.net/c/7443544/120057/2322';

export async function onRequestGet({ request, env }) {
  const url        = new URL(request.url);
  const kv         = env.GIGSBERG_KV;
  const accountSid = env.IMPACT_ACCOUNT_SID;
  const authToken  = env.IMPACT_AUTH_TOKEN;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'TicketNetwork catalog cache',
      `  Catalog ID: ${CATALOG_ID}`,
      '  ?trigger=1        — build KV index',
      '  ?trigger=1&test=1 — connectivity test',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!accountSid || !authToken) return json({ error: 'Missing IMPACT_ACCOUNT_SID or IMPACT_AUTH_TOKEN' }, 500);
  if (!kv)                        return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const headers   = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };
  const base      = `https://api.impact.com/Mediapartners/${accountSid}/Catalogs/${CATALOG_ID}/Items`;

  // Connectivity test
  if (url.searchParams.get('test') === '1') {
    try {
      const r = await fetch(`${base}?PageSize=3`, { headers });
      const text = await r.text();
      return json({ status: r.status, ok: r.ok, response: JSON.parse(text.slice(0, 500)) }, 200);
    } catch(e) {
      return json({ error: String(e) }, 200);
    }
  }

  // Paginate through catalog and build index
  const today   = new Date();
  const index   = [];
  let   afterId = null;
  let   pages   = 0;

  while (pages < 300) { // up to 30,000 items
    const reqUrl = new URL(base);
    reqUrl.searchParams.set('PageSize', '100');
    if (afterId) reqUrl.searchParams.set('AfterId', afterId);

    const resp = await fetch(reqUrl.toString(), { headers });
    if (!resp.ok) {
      return json({ error: `Catalog fetch failed: HTTP ${resp.status} on page ${pages + 1}`, kept: index.length }, 500);
    }

    const data  = await resp.json();
    const items = data?.Items || [];
    pages++;

    if (items.length === 0) break;

    for (const item of items) {
      if (item.ExpirationDate && new Date(item.ExpirationDate) < today) continue;

      const destUrl      = item.Url || '';
      const affiliateUrl = destUrl
        ? `${TRACKING}?u=${encodeURIComponent(destUrl)}`
        : TRACKING;

      index.push({
        n: item.Name          || '',
        u: affiliateUrl,
        p: item.CurrentPrice  ? parseFloat(item.CurrentPrice) : null,
        c: item.Currency      || 'USD',
        d: item.ExpirationDate ? item.ExpirationDate.split('T')[0] : '',
        v: item.Text1         || item.Venue || '',
        t: item.Text2         || item.City  || '',
        g: item.Category      || '',
      });
    }

    const nextUri    = data['@nextpageuri'] || '';
    const afterMatch = nextUri.match(/AfterId=([^&]+)/);
    if (!afterMatch || items.length < 100) break;
    afterId = afterMatch[1];
  }

  // Split into chunks (25MB KV limit)
  const CHUNK_MB  = 20;
  const chunks    = [];
  let   chunk     = [];
  let   chunkBytes = 0;

  for (const item of index) {
    const s = JSON.stringify(item);
    if (chunkBytes + s.length > CHUNK_MB * 1024 * 1024 && chunk.length > 0) {
      chunks.push(chunk); chunk = []; chunkBytes = 0;
    }
    chunk.push(item); chunkBytes += s.length;
  }
  if (chunk.length > 0) chunks.push(chunk);

  const puts = chunks.map((ch, i) =>
    kv.put(`tn:catalog:chunk:${i}`, JSON.stringify(ch), { expirationTtl: KV_TTL })
  );
  const stats = { total: index.length, chunks: chunks.length, updated: new Date().toISOString() };
  puts.push(kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }));
  puts.push(kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }));
  puts.push(kv.put('tn:catalog:chunks', String(chunks.length), { expirationTtl: KV_TTL }));
  puts.push(kv.delete(KV_INDEX).catch(() => {}));
  await Promise.all(puts);

  return json({ success: true, total: index.length, chunks: chunks.length, pages, updatedAt: new Date().toISOString() }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}