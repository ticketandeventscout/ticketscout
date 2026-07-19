// ===========================
// TicketScout — Ticombo catalog cache builder
// Runs as a Cloudflare Pages Function at /api/ticombo-cache
//
// Downloads Ticombo event feeds from Partnerize (feeds.performancehorizon.com)
// for each available campaign region, merges them into a single KV index.
//
// Feed URLs follow the pattern:
//   https://feeds.performancehorizon.com/ticketandeventscoutpartnerize/{campaignId}/{hash}
//
// Available feeds (from Partnerize Creative Overview):
//   Europe:    1011l6399 — hash provided by user
//   Germany:   1011l6400 — hash provided by user
//   Singapore: 1101l6348 — hash provided by user
//   Spain:     1100l6336 — hash provided by user
//   UK:        1100l6335 — hash provided by user
//
// Feed format: CSV similar to Vivid Seats — columns TBD from first download
//
// KV keys:
//   ticombo:catalog:index   — JSON array of compact event objects
//   ticombo:catalog:updated — ISO timestamp
//   ticombo:catalog:stats   — { total, updated, campaigns }
//
// Required env vars:
//   GIGSBERG_KV — KV namespace binding
//   (No auth needed — feed URLs are pre-authenticated via hash)
//
// Usage:
//   ?trigger=1        — download all feeds, build KV index
//   ?trigger=1&test=1 — test feed URL connectivity (HEAD requests only)
// ===========================

// Feed URLs confirmed from Partnerize Creative Overview dashboard
// Note: all 5 feeds share the same hash (a1f3f49c2e6d13ca6d33d24088acc238)
// US, APAC, LATAM, Mexico have no feeds available
const HASH = 'a1f3f49c2e6d13ca6d33d24088acc238';
const FEED_BASE = 'https://feeds.performancehorizon.com/ticketandeventscoutpartnerize';

const FEEDS = [
  { id: '1100l6335', region: 'UK',        camref: '1100l5P9x2', url: `${FEED_BASE}/1100l6335/${HASH}` },
  { id: '1011l6399', region: 'Europe',    camref: '1100l5P9wQ', url: `${FEED_BASE}/1011l6399/${HASH}` },
  { id: '1011l6400', region: 'Germany',   camref: '1100l5P9wR', url: `${FEED_BASE}/1011l6400/${HASH}` },
  { id: '1100l6336', region: 'Spain',     camref: '1100l5P9wT', url: `${FEED_BASE}/1100l6336/${HASH}` },
  { id: '1101l6348', region: 'Singapore', camref: '1100l5P9wS', url: `${FEED_BASE}/1101l6348/${HASH}` },
];

const KV_INDEX   = 'ticombo:catalog:index';
const KV_UPDATED = 'ticombo:catalog:updated';
const KV_STATS   = 'ticombo:catalog:stats';
const KV_TTL     = 8 * 24 * 60 * 60; // 8 days

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv  = env.GIGSBERG_KV;

  if (url.searchParams.get('trigger') !== '1') {
    const updated = await kv?.get(KV_UPDATED).catch(() => null);
    const stats   = await kv?.get(KV_STATS).catch(() => null);
    return text([
      'Ticombo catalog cache',
      `  Configured feeds: ${FEEDS.length}`,
      '  ?trigger=1        — download all feeds, build KV index',
      '  ?trigger=1&test=1 — connectivity test only',
      '  ?trigger=1&raw=1  — DIAGNOSTIC: dump raw columns from ALL feeds + scan for hidden dates',
      '                      options: &rows=N (sample rows per feed, max 25) &region=uk|europe|germany|spain|singapore',
      '',
      `Last updated: ${updated || 'never'}`,
      stats ? `Stats: ${stats}` : 'No stats yet'
    ].join('\n'));
  }

  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  if (FEEDS.length === 0) {
    return json({ error: 'No feed URLs configured. Add feed URLs to the FEEDS array in ticombo-cache.js' }, 500);
  }

  // Sample mode — reads existing KV index and shows first 3 items with all fields
  // Use this to check what data is actually stored (including whether dates exist)
  // ?sample=1              — first 5 items + date coverage
  // ?find=metallica        — search the index by name (case-insensitive substring)
  if (url.searchParams.get('sample') === '1' || url.searchParams.get('find')) {
    try {
      const raw = await kv.get(KV_INDEX);   // was 'ticombo:index' — wrong key; use the real one
      if (!raw) return jsonResponse({ error: 'No KV data found — run ?trigger=1 first' }, 200);
      const index = JSON.parse(raw);
      const shape = item => ({
        name: item.n,
        url: item.u ? item.u.slice(0, 90) + '…' : null,
        price: item.p,
        currency: item.c,
        date: item.d,
        venue: item.v,
        city: item.t,
        category: item.g,
        region: item.r
      });

      const findTerm = (url.searchParams.get('find') || '').toLowerCase().trim();
      if (findTerm) {
        const hits = index.filter(i => (i.n || '').toLowerCase().includes(findTerm));
        return jsonResponse({
          total: index.length,
          query: findTerm,
          matchCount: hits.length,
          matches: hits.slice(0, 25).map(shape)
        }, 200);
      }

      const sample = index.slice(0, 5).map(shape);
      const withDates = index.filter(i => i.d).slice(0, 3).map(i => ({ name: i.n, date: i.d }));
      return jsonResponse({
        total: index.length,
        sample_items: sample,
        items_with_dates: withDates.length,
        sample_with_dates: withDates
      }, 200);
    } catch(e) {
      return jsonResponse({ error: String(e) }, 200);
    }
  }

  // ── RAW DIAGNOSTIC MODE — ?trigger=1&raw=1 ────────────────────────────────
  // Downloads ALL regional feeds (or one via &region=) and, per feed:
  //   1. Dumps the full header row (every column name, in order)
  //   2. Shows the first N rows fully keyed by header name (&rows=N, default 8, max 25)
  //   3. Scans up to 400 rows per feed, EVERY column, for date-like patterns
  //      (ISO, dd/mm/yyyy, yyyy/mm/dd, and textual months in EN/DE/ES)
  //      → reports hit counts + sample matches per column
  // Purpose: determine whether event dates are hidden in event_full_name,
  // deep_link, or any other column — before asking Partnerize to change the feed.
  // READ-ONLY: writes nothing to KV, never touches the live index.
  if (url.searchParams.get('raw') === '1') {
    const rowsWanted = Math.min(parseInt(url.searchParams.get('rows') || '8', 10) || 8, 25);
    const regionParam = (url.searchParams.get('region') || '').toLowerCase();
    const feedsToScan = regionParam
      ? FEEDS.filter(f => f.region.toLowerCase() === regionParam)
      : FEEDS;
    if (feedsToScan.length === 0) {
      return json({ error: `Unknown region '${regionParam}' — use uk|europe|germany|spain|singapore` }, 400);
    }

    const SCAN_ROWS = 400; // per feed — enough to see pattern frequency without CPU risk

    // Date-like patterns. Textual months cover EN + DE + ES since feeds are regional.
    const DATE_PATTERNS = [
      { label: 'iso (yyyy-mm-dd)',        re: /\b(20\d{2})-(\d{2})-(\d{2})\b/ },
      { label: 'dd/mm/yyyy or dd.mm.yyyy', re: /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})\b/ },
      { label: 'yyyy/mm/dd',              re: /\b(20\d{2})[.\/](\d{1,2})[.\/](\d{1,2})\b/ },
      { label: 'textual month EN/DE/ES',  re: /\b\d{1,2}\.?\s*(jan|feb|mar|mär|maerz|apr|may|mai|jun|jul|aug|sep|set|okt|oct|nov|dec|dez|dic|ene|abr|ago)[a-zäé]*\.?\s*(20\d{2})\b/i },
      { label: 'unix-ish timestamp',      re: /\b1[6-9]\d{8}\b/ },
    ];

    const report = [];

    for (const feed of feedsToScan) {
      try {
        const feedText = await fetchFeedText(feed);
        if (feedText.error) { report.push({ region: feed.region, error: feedText.error }); continue; }

        const lines  = feedText.text.split('\n');
        const header = parseCSVLine(lines[0] || '').map(h => h.trim());

        // First N rows, fully keyed by header name
        const sampleRows = [];
        for (let i = 1; i <= rowsWanted && i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const cols = parseCSVLine(lines[i]);
          const row = {};
          header.forEach((h, idx) => {
            const v = (cols[idx] || '').trim();
            row[h || `col_${idx}`] = v.length > 220 ? v.slice(0, 220) + '…' : v;
          });
          sampleRows.push(row);
        }

        // Date scan: every column, up to SCAN_ROWS rows
        const colHits = {}; // colName → { pattern → { count, samples[] } }
        let scanned = 0;
        for (let i = 1; i < lines.length && scanned < SCAN_ROWS; i++) {
          if (!lines[i].trim()) continue;
          scanned++;
          const cols = parseCSVLine(lines[i]);
          for (let idx = 0; idx < header.length; idx++) {
            const v = (cols[idx] || '').trim();
            if (!v) continue;
            for (const p of DATE_PATTERNS) {
              const m = v.match(p.re);
              if (m) {
                const colName = header[idx] || `col_${idx}`;
                colHits[colName]           = colHits[colName] || {};
                colHits[colName][p.label]  = colHits[colName][p.label] || { count: 0, samples: [] };
                const bucket = colHits[colName][p.label];
                bucket.count++;
                if (bucket.samples.length < 3) {
                  bucket.samples.push(v.length > 160 ? v.slice(0, 160) + '…' : v);
                }
              }
            }
          }
        }

        // Verdict per feed: any column with hits in >50% of scanned rows is a
        // reliable date carrier; 1-50% = partial (some event types only); 0 = none.
        const verdicts = Object.entries(colHits).map(([colName, patterns]) => {
          const best = Object.entries(patterns).sort((a, b) => b[1].count - a[1].count)[0];
          const pct  = scanned ? Math.round((best[1].count / scanned) * 100) : 0;
          return {
            column: colName,
            best_pattern: best[0],
            hit_rate: `${best[1].count}/${scanned} rows (${pct}%)`,
            reliability: pct > 50 ? 'RELIABLE — parse this column' : pct > 0 ? 'PARTIAL — some rows only' : 'none',
            samples: best[1].samples
          };
        }).sort((a, b) => parseInt(b.hit_rate) - parseInt(a.hit_rate));

        report.push({
          region:        feed.region,
          campaign_id:   feed.id,
          total_lines:   lines.length - 1,
          rows_scanned:  scanned,
          header,
          date_scan:     verdicts.length ? verdicts : 'NO date-like patterns found in any column',
          sample_rows:   sampleRows
        });

      } catch (err) {
        report.push({ region: feed.region, error: String(err) });
      }
    }

    return json({
      mode: 'raw diagnostic (read-only, nothing written to KV)',
      feeds_scanned: report.length,
      how_to_read: 'Check date_scan per feed first. A RELIABLE column means dates ARE in the feed and we patch ingestion to parse them. If all feeds say NO patterns, dates must come from Partnerize column mapping or cross-source enrichment.',
      report
    }, 200);
  }

  // Connectivity test
  if (url.searchParams.get('test') === '1') {
    const apiKey  = env.PARTNERIZE_API_KEY;
    const userKey = env.PARTNERIZE_USER_KEY;
    const basicAuth = (apiKey && userKey) ? btoa(`${userKey}:${apiKey}`) : null;

    const results = [];
    for (const feed of FEEDS) {
      // Try 4 auth approaches for each feed
      const attempts = [
        { label: 'no auth',      headers: {} },
        { label: 'basic auth',   headers: basicAuth ? { 'Authorization': `Basic ${basicAuth}` } : null },
        { label: 'api key param', url: feed.url + '?api_key=' + (apiKey||'') },
      ].filter(a => a.headers !== null);

      for (const attempt of attempts) {
        try {
          const fetchUrl = attempt.url || feed.url;
          const r = await fetch(fetchUrl, { method: 'HEAD', headers: attempt.headers || {} });
          results.push({
            region: feed.region,
            attempt: attempt.label,
            status: r.status,
            ok: r.ok,
            size: r.headers.get('content-length'),
            type: r.headers.get('content-type')
          });
          if (r.ok) break; // stop trying if one works
        } catch(e) {
          results.push({ region: feed.region, attempt: attempt.label, error: String(e) });
        }
      }
    }
    return json({ feedTests: results }, 200);
  }

  // Download and parse all feeds
  const today    = new Date();
  const allItems = [];
  const feedStats = [];

  for (const feed of FEEDS) {
    try {
      const resp = await fetch(feed.url);
      if (!resp.ok) {
        feedStats.push({ region: feed.region, error: `HTTP ${resp.status}` });
        continue;
      }

      // Buffer the entire response body once as ArrayBuffer, then decode.
      // Cannot use resp.body twice — buffer first, then decide how to decompress.
      const buffer = await resp.arrayBuffer();
      let text = '';
      const contentEncoding = resp.headers.get('content-encoding') || '';
      const contentType     = resp.headers.get('content-type')     || '';
      const looksGzipped    = contentEncoding.includes('gzip')
                           || contentType.includes('octet-stream')
                           || contentType.includes('gzip');
      try {
        if (looksGzipped) {
          const ds     = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          const reader = ds.readable.getReader();
          writer.write(new Uint8Array(buffer));
          writer.close();
          const dec = new TextDecoder('utf-8');
          let chunk;
          while (!(chunk = await reader.read()).done) {
            text += dec.decode(chunk.value, { stream: true });
            if (text.length > 30 * 1024 * 1024) break; // 30MB cap per feed
          }
        } else {
          text = new TextDecoder('utf-8').decode(buffer);
        }
      } catch {
        // Decompression failed — try decoding as plain text
        text = new TextDecoder('utf-8').decode(buffer);
      }

      const lines  = text.split('\n');
      const header = parseCSVLine(lines[0] || '');

      const col = name => header.findIndex(
        h => h.toLowerCase().replace(/[\s_"]/g, '') === name.toLowerCase().replace(/[\s_]/g, '')
      );

      // Column mapping — actual Ticombo feed columns:
      // event_id, event_name, event_full_name, category, venue_name,
      // venue_country, venue_city, deep_link, image_url, qty_tickets,
      // min_sell_price, min_final_sell_price
      // Note: no date or currency column in the feed.
      const iName   = col('eventname')         !== -1 ? col('eventname')         : col('eventfullname');
      const iUrl    = col('deeplink')          !== -1 ? col('deeplink')          : col('url');
      // Prefer min_final_sell_price (fees included) over min_sell_price
      const iPrice  = col('minfinalsellprice') !== -1 ? col('minfinalsellprice') : col('minsellprice');
      // Feed exposes currency per row (EUR, GBP etc) — was hardcoded before
      const iCurr   = col('currency');
      // Feed exposes event_start_date as ISO datetime e.g. 2026-07-14T14:00:00.000Z
      const iDate   = col('eventstartdate')    !== -1 ? col('eventstartdate')    : col('eventstart');
      const iVenue  = col('venuename')         !== -1 ? col('venuename')         : col('venue');
      const iCity   = col('venuecity')         !== -1 ? col('venuecity')         : col('city');
      const iCat    = col('category');

      // Confirm column detection in Workers logs (first two feeds only)
      if (feed.region === 'UK' || feed.region === 'Europe') {
        console.log('[Ticombo:' + feed.region + '] date col idx=' + iDate
          + ' (' + (header[iDate] || 'NOT FOUND') + ')'
          + ', currency col idx=' + iCurr + ' (' + (header[iCurr] || 'NOT FOUND') + ')'
          + ', price col idx=' + iPrice + ' (' + (header[iPrice] || 'NOT FOUND') + ')');
      }

      let kept = 0;
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols  = parseCSVLine(lines[i]);
        const name  = iName !== -1 ? (cols[iName] || '').trim() : '';
        const url   = iUrl  !== -1 ? (cols[iUrl]  || '').trim() : '';
        const date  = iDate !== -1 ? (cols[iDate]  || '').trim() : '';

        if (!name || !url) continue;
        if (date && new Date(date) < today) continue; // skip past events

        // The deep_link from the feed already contains the Partnerize tracking URL
        // (prf.hn/click/camref:.../) with the correct regional camref baked in.
        // Use it directly — do NOT wrap it in a second prf.hn hop or commission
        // attribution breaks. Only fall back to constructing a link if the URL
        // is a bare ticombo.com path (no tracking wrapper).
        const isPrfLink   = url.includes('prf.hn/click/');
        const destUrl     = url.startsWith('http') ? url : `https://www.ticombo.com${url}`;
        const affiliateUrl = isPrfLink
          ? url   // already a valid Partnerize tracking link — use as-is
          : `https://ticombo.prf.hn/click/camref:${feed.camref}/destination:${encodeURIComponent(destUrl)}`;

        allItems.push({
          n: name,
          u: affiliateUrl,
          p: iPrice !== -1 && cols[iPrice] ? parseFloat(cols[iPrice]) : null,
          c: iCurr !== -1 && cols[iCurr] ? cols[iCurr].trim() : (feed.region === 'UK' ? 'GBP' : 'EUR'),
          d: date ? date.split('T')[0] : '',
          v: iVenue !== -1 ? (cols[iVenue] || '') : '',
          t: iCity  !== -1 ? (cols[iCity]  || '') : '',
          g: iCat   !== -1 ? (cols[iCat]   || '') : '',
          r: feed.region
        });
        kept++;
      }

      feedStats.push({ region: feed.region, lines: lines.length - 1, kept, columns: header.slice(0, 12) });

    } catch(err) {
      feedStats.push({ region: feed.region, error: String(err) });
    }
  }

  // Deduplicate by event_id (from URL path) + region.
  // Cannot use name+date because the feed has no date column (d is always '').
  // Deduping purely by name would collapse the same event across regions,
  // losing regional pricing. Keep one entry per (name, region) pair instead.
  // If the same event appears multiple times in a region, keep lowest price.
  const bestByKey = new Map();
  for (const item of allItems) {
    const key = item.n.toLowerCase().trim() + '|' + item.r;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, item);
    } else {
      // Keep whichever has a lower price (or keep existing if new has no price)
      if (item.p !== null && (existing.p === null || item.p < existing.p)) {
        bestByKey.set(key, item);
      }
    }
  }
  const unique = Array.from(bestByKey.values());

  const indexJson = JSON.stringify(unique);
  const stats     = { total: unique.length, feeds: feedStats, updated: new Date().toISOString() };

  await Promise.all([
    kv.put(KV_INDEX,   indexJson,               { expirationTtl: KV_TTL }),
    kv.put(KV_UPDATED, new Date().toISOString(), { expirationTtl: KV_TTL }),
    kv.put(KV_STATS,   JSON.stringify(stats),    { expirationTtl: KV_TTL }),
  ]);

  return json({ success: true, total: unique.length, sizeMB: (indexJson.length/1024/1024).toFixed(2), feedStats }, 200);
}

// Self-contained feed download + decompress for the raw diagnostic mode.
// Duplicates the trigger path's decompress logic on purpose — the diagnostic
// must not share/alter production code paths. Returns { text } or { error }.
async function fetchFeedText(feed) {
  try {
    const resp = await fetch(feed.url);
    if (!resp.ok) return { error: `HTTP ${resp.status}` };

    const buffer = await resp.arrayBuffer();
    const contentEncoding = resp.headers.get('content-encoding') || '';
    const contentType     = resp.headers.get('content-type')     || '';
    const looksGzipped    = contentEncoding.includes('gzip')
                         || contentType.includes('octet-stream')
                         || contentType.includes('gzip');
    let text = '';
    try {
      if (looksGzipped) {
        const ds     = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(new Uint8Array(buffer));
        writer.close();
        const dec = new TextDecoder('utf-8');
        let chunk;
        while (!(chunk = await reader.read()).done) {
          text += dec.decode(chunk.value, { stream: true });
          if (text.length > 30 * 1024 * 1024) break; // 30MB cap per feed
        }
      } else {
        text = new TextDecoder('utf-8').decode(buffer);
      }
    } catch {
      text = new TextDecoder('utf-8').decode(buffer);
    }
    return { text };
  } catch (err) {
    return { error: String(err) };
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
    } else {
      current += ch;
    }
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