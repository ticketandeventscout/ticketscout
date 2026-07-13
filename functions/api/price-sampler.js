// ============================================================================
// TicketScout — Price Sampler
// Runs at /api/price-sampler — snapshots the get-in price for every event
// matching a known entity, from the feed caches ALREADY sitting in KV.
// Zero new upstream fetches. This is the TicketData feature at £0/month.
//
// Usage (fired by the cron worker 30 min after each feed refresh):
//   ?trigger=1&source=vividseats      — sample from the VS catalog chunks
//   ?trigger=1&source=ticketnetwork   — sample from the TN catalog chunks
//   ?trigger=1&source=ticombo         — sample from the Ticombo index
//
// Requires bindings on the Pages project:
//   GIGSBERG_KV — existing KV namespace
//   PRICE_DB    — the ticketscout-prices D1 database (see price-schema.sql)
// ============================================================================

const KNOWN_KEY = 'autodiscover:artists:known';
const FX_KEY    = 'fx:rates';
// Fallback rates if fx:rates isn't in KV yet (rollup cron refreshes it nightly)
const FX_FALLBACK = { USD: 0.79, EUR: 0.85, GBP: 1, CAD: 0.58, AUD: 0.52, SGD: 0.58, CHF: 0.88 };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv  = env.GIGSBERG_KV;
  const db  = env.PRICE_DB;

  if (url.searchParams.get('trigger') !== '1') {
    return json({
      usage: [
        '?trigger=1&source=vividseats     — sample VS catalog',
        '?trigger=1&source=ticketnetwork  — sample TN catalog',
        '?trigger=1&source=ticombo        — sample Ticombo catalog',
      ]
    }, 200);
  }
  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);
  if (!db) return json({ error: 'Missing PRICE_DB binding — bind the D1 database in Pages Settings → Bindings' }, 500);

  const source = url.searchParams.get('source') || '';
  if (!['vividseats', 'ticketnetwork', 'ticombo'].includes(source)) {
    return json({ error: `Unknown source '${source}' — use vividseats | ticketnetwork | ticombo` }, 400);
  }

  // ── Load the known entity slugs (the 235+ pages we track prices for) ──
  let knownSlugs = new Set();
  try { const k = await kv.get(KNOWN_KEY); if (k) knownSlugs = new Set(JSON.parse(k)); } catch {}
  if (knownSlugs.size === 0) return json({ error: 'KNOWN_KEY empty — run register-known first' }, 500);

  // ── FX rates (KV-refreshed nightly by the rollup; fallback otherwise) ──
  let fx = FX_FALLBACK;
  try { const f = await kv.get(FX_KEY, 'json'); if (f) fx = { ...FX_FALLBACK, ...f }; } catch {}

  // ── Read the source's catalog items from KV ──────────────────────────
  let items = [];
  try {
    if (source === 'ticombo') {
      const raw = await kv.get('ticombo:catalog:index');
      if (raw) items = JSON.parse(raw);
    } else {
      const prefix = source === 'vividseats' ? 'vs' : 'tn';
      const nChunks = parseInt(await kv.get(`${prefix}:catalog:chunks`) || '0', 10);
      for (let i = 0; i < nChunks; i++) {
        const raw = await kv.get(`${prefix}:catalog:chunk:${i}`);
        if (raw) items = items.concat(JSON.parse(raw));
      }
    }
  } catch (err) {
    return json({ error: `Failed reading ${source} cache: ${err}` }, 500);
  }
  if (items.length === 0) return json({ error: `${source} cache is empty — trigger its cache rebuild first` }, 500);

  // ── Match items to known entities & find the min price per event ──────
  // Item shape (all three sources): { n: name, p: price, c: currency,
  //                                   d: 'YYYY-MM-DD', v: venue, t: city }
  const now      = Math.floor(Date.now() / 1000);
  const todayISO = new Date().toISOString().split('T')[0];
  const horizon  = addDaysISO(todayISO, 365);
  const eventMins = new Map(); // event_key -> { slug, name, venue, city, date, minGBP }

  let scanned = 0, matched = 0, noPrice = 0, noDate = 0;
  for (const item of items) {
    scanned++;
    const price = item.p;
    if (!price || price <= 0) { noPrice++; continue; }
    const date = (item.d || '').trim();
    if (!date || date < todayISO || date > horizon) { noDate++; continue; }

    const slug = matchEntity(item.n, knownSlugs);
    if (!slug) continue;
    matched++;

    const rate = fx[(item.c || 'GBP').toUpperCase()] ?? fx.GBP;
    const gbp  = Math.round(price * rate * 100) / 100;

    const eventKey = `${slug}|${date}|${toKeySlug(item.v || 'tba')}`;
    const cur = eventMins.get(eventKey);
    if (!cur || gbp < cur.minGBP) {
      eventMins.set(eventKey, { slug, name: item.n, venue: item.v || '', city: item.t || '', date, minGBP: gbp });
    }
  }

  if (eventMins.size === 0) {
    return json({ source, scanned, matched, samplesWritten: 0,
                  message: 'No matchable priced events found in this cache.' }, 200);
  }

  // ── Write to D1: upsert entities + events, insert samples ─────────────
  let entitiesUpserted = 0, eventsUpserted = 0, samplesWritten = 0, dbErrors = 0;
  const entries = [...eventMins.entries()];
  const BATCH = 40;

  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const stmts = [];
    for (const [eventKey, e] of slice) {
      stmts.push(db.prepare(
        `INSERT INTO entities (slug) VALUES (?) ON CONFLICT(slug) DO NOTHING`
      ).bind(e.slug));
      stmts.push(db.prepare(
        `INSERT INTO events (entity_id, event_key, name, venue, city, event_date)
         SELECT id, ?, ?, ?, ?, ? FROM entities WHERE slug = ?
         ON CONFLICT(event_key) DO NOTHING`
      ).bind(eventKey, e.name, e.venue, e.city, e.date, e.slug));
      stmts.push(db.prepare(
        `INSERT INTO price_samples (event_id, source, sampled_at, min_price_gbp)
         SELECT id, ?, ?, ? FROM events WHERE event_key = ?
         ON CONFLICT(event_id, source, sampled_at) DO NOTHING`
      ).bind(source, now, e.minGBP, eventKey));
    }
    try {
      await db.batch(stmts);
      samplesWritten += slice.length;
    } catch (err) {
      dbErrors++;
      console.error(`price-sampler ${source} batch ${i}: ${err}`);
    }
  }

  return json({
    source, scanned, matched,
    uniqueEvents: eventMins.size,
    samplesWritten, dbErrors,
    skipped: { noPrice, noDate },
    sampledAt: new Date(now * 1000).toISOString()
  }, 200);
}

// ── Entity matching ─────────────────────────────────────────────────────
// Matches an item name against the known slug set. Tries, in order:
//   1. slugified full name        ("Coldplay" -> coldplay)
//   2. first segment before " - " / " vs " / " at " ("Arsenal FC - Dortmund" -> arsenal-fc)
//   3. club-suffix-stripped        (arsenal-fc -> arsenal)
function matchEntity(name, knownSlugs) {
  if (!name) return null;
  const full = toKeySlug(name);
  if (knownSlugs.has(full)) return full;

  const first = toKeySlug(name.split(/ - | vs\.? | at /i)[0]);
  if (knownSlugs.has(first)) return first;

  const stripped = first.replace(/-(fc|cf|afc|sc|ac|club)$/,'');
  if (stripped !== first && knownSlugs.has(stripped)) return stripped;

  return null;
}

function toKeySlug(s) {
  return (s || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
