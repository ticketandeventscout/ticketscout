// ===========================
// TicketScout — TicketNetwork catalog cache (Catalog 896)
// Runs as a Cloudflare Pages Function at /api/ticketnetwork-cache
//
// Downloads TicketNetwork Product Catalog (896) from GitHub
// Catalog 896 columns: EventID, Event, Performer, Venue, DateTime,
// PCat, CCat, GCat, City, PriceRange, IMAGEURL, URLLink, RemainingTicketQty
//
// Uses streaming decompression to stay under Cloudflare memory limits
//
// Required env vars: GITHUB_OWNER, GITHUB_REPO, GIGSBERG_KV
// ===========================

const FEED_PATH  = 'public/ticketnetwork-feed-896.csv.gz';
const KV_TTL     = 8 * 24 * 60 * 60;
const CHUNK_MB   = 20;

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const kv    = env.GIGSBERG_KV;
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get('tn:catalog:updated').catch(() => null);
    const stats   = await kv?.get('tn:catalog:stats').catch(() => null);
    return text([
      'TicketNetwork catalog cache (896)',
      `  Feed: https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`,
      '  ?trigger=1        — build KV index',
      '  ?trigger=1&test=1 — connectivity test',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!owner || !repo) return json({ error: 'Missing GITHUB_OWNER or GITHUB_REPO' }, 500);
  if (!kv)             return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const feedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${FEED_PATH}`;

  if (url.searchParams.get('test') === '1') {
    const r = await fetch(feedUrl, { method: 'HEAD' });
    return json({ url: feedUrl, status: r.status, ok: r.ok, size: r.headers.get('content-length') }, 200);
  }

  const feedResp = await fetch(feedUrl);
  if (!feedResp.ok) return json({ error: `Feed download failed: HTTP ${feedResp.status}` }, 500);

  try {
    // Stream decompress
    const ds      = new DecompressionStream('gzip');
    const stream  = feedResp.body.pipeThrough(ds);
    const reader  = stream.getReader();
    const decoder = new TextDecoder('utf-8');

    let buffer  = '';
    let header  = null;
    let colMap  = null;
    const index = [];
    const today = new Date().toISOString().split('T')[0];

    const processLine = (line) => {
      if (!line.trim()) return;
      const cols = parseCSVLine(line);

      if (!header) {
        header = cols;
        // Build column index map
        const col = name => header.findIndex(
          h => h.toLowerCase().replace(/[\s_]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
        );
        colMap = {
          name:   col('event'),
          url:    col('urllink'),
          date:   col('datetime'),
          venue:  col('venue'),
          city:   col('city'),
          cat:    col('pcat'),
          price:  col('pricerange'),
          image:  col('imageurl'),
          qty:    col('remainingticketqty'),
          tickets: col('ticketsyn'),
        };
        return;
      }

      const { name: iN, url: iU, date: iD, venue: iV, city: iC,
              cat: iG, price: iP, image: iI, qty: iQ, tickets: iT } = colMap;

      const name = (cols[iN] || '').trim();
      const url  = (cols[iU] || '').trim();
      const date = (cols[iD] || '').trim().split('T')[0];

      if (!name || !url) return;
      if (date && date < today) return;
      if (iQ !== -1 && cols[iQ] === '0') return;
      if (iT !== -1 && cols[iT] === 'NoTickets') return;

      let price = null;
      if (iP !== -1 && cols[iP]) {
        const p = parseFloat(cols[iP].replace(/[^\d.]/g, ''));
        if (p > 0) price = p;
      }

      index.push({
        n: name,
        u: url,
        p: price,
        c: 'USD',
        d: date,
        v: iV !== -1 ? (cols[iV] || '').trim() : '',
        t: iC !== -1 ? (cols[iC] || '').trim() : '',
        g: iG !== -1 ? (cols[iG] || '').trim() : '',
      });
    };

    // Stream read
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      // Process complete lines from buffer
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        processLine(buffer.slice(0, nlIdx));
        buffer = buffer.slice(nlIdx + 1);
      }

      if (done) {
        if (buffer.trim()) processLine(buffer);
        break;
      }
    }

    // Split into 20MB chunks
    const chunks = [];
    let chunk = [], chunkBytes = 0;
    const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;

    for (const item of index) {
      const s = JSON.stringify(item);
      if (chunkBytes + s.length > CHUNK_BYTES && chunk.length > 0) {
        chunks.push(chunk); chunk = []; chunkBytes = 0;
      }
      chunk.push(item); chunkBytes += s.length;
    }
    if (chunk.length > 0) chunks.push(chunk);

    const puts = chunks.map((ch, i) =>
      kv.put(`tn:catalog:chunk:${i}`, JSON.stringify(ch), { expirationTtl: KV_TTL })
    );
    const stats = { total: index.length, chunks: chunks.length, updated: new Date().toISOString() };
    puts.push(kv.put('tn:catalog:chunks',  String(chunks.length),   { expirationTtl: KV_TTL }));
    puts.push(kv.put('tn:catalog:stats',   JSON.stringify(stats),   { expirationTtl: KV_TTL }));
    puts.push(kv.put('tn:catalog:updated', new Date().toISOString(), { expirationTtl: KV_TTL }));
    await Promise.all(puts);

    return json({
      success: true,
      total:   index.length,
      chunks:  chunks.length,
      sample:  index.slice(0, 2),
      updatedAt: new Date().toISOString()
    }, 200);

  } catch(err) {
    return json({ error: String(err) }, 500);
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else { current += ch; }
  }
  result.push(current);
  return result;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}