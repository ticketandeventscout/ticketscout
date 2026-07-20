// ===========================
// TicketScout — FX rates endpoint (/api/fx)
//
// REPO LOCATION: functions/api/fx.js
//
// Serves GBP-based exchange rates (units of each currency per 1 GBP) for the
// compare table's currency normalisation. Lazy self-refresh — NO cron:
//   • On each request it reads the cached rates from KV.
//   • If they're missing or older than ~20h, it refreshes from Frankfurter
//     (ECB data, free, no API key) in the background via waitUntil, while
//     still serving the stale-but-valid cached rates immediately
//     (stale-while-revalidate — users never wait on the upstream fetch).
//   • Every layer falls back safely: upstream down → keep last-good KV;
//     KV empty → the hardcoded FALLBACK table below (same values compare.js
//     ships with). Rates never break the price comparison.
//
// Frankfurter updates once per working day (~16:00 CET); weekends/holidays
// reuse the last business day's rates, which is correct. A ~20h TTL means we
// pick up each new publication within a day without hammering the source.
//
// Source rates are "per 1 GBP" (base=GBP), i.e. FX_PER_GBP — divide a foreign
// amount by its rate to get GBP. Matches compare.js's toGbp().
// ===========================

const KV_KEY   = 'fx:gbp:rates';
const TTL_MS   = 20 * 60 * 60 * 1000;         // refresh if older than ~20h
const KV_TTL   = 7 * 24 * 3600;               // keep last-good up to 7 days
const SYMBOLS  = ['USD', 'EUR', 'PLN', 'CHF', 'CAD', 'AUD', 'SGD'];
const SOURCE   = `https://api.frankfurter.app/latest?base=GBP&symbols=${SYMBOLS.join(',')}`;

// Ultimate fallback — mirrors the table compare.js ships with. Used only if
// KV is empty AND the upstream fetch fails (e.g. very first request while the
// source is down). Approximate; the live feed supersedes these immediately.
const FALLBACK = { GBP: 1, USD: 1.27, EUR: 1.17, PLN: 5.0, CHF: 1.12, CAD: 1.73, AUD: 1.93, SGD: 1.71 };

export async function onRequestGet(ctx) {
  const { env } = ctx;
  const kv = env.GIGSBERG_KV;

  let cached = null;
  if (kv) {
    try { cached = await kv.get(KV_KEY, { type: 'json' }); } catch {}
  }

  const now = Date.now();
  const age = cached?.fetchedAt ? now - Date.parse(cached.fetchedAt) : Infinity;
  const stale = !cached || age > TTL_MS;

  // Refresh in the background when stale; serve what we have right now.
  if (stale && kv) {
    ctx.waitUntil(refresh(kv).catch(() => {}));
  }

  const rates = cached?.rates || FALLBACK;
  const asOf  = cached?.date || null;

  return json({
    base: 'GBP',
    rates,                      // { GBP:1, USD:1.27, ... } — units per 1 GBP
    date: asOf,                 // ECB publication date, or null on fallback
    source: cached ? 'frankfurter' : 'fallback'
  }, cached ? 200 : 200);
}

// Fetch fresh rates and write to KV. Guarded so a bad upstream payload never
// overwrites good cached rates.
async function refresh(kv) {
  const resp = await fetch(SOURCE, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) return;
  const data = await resp.json().catch(() => null);
  if (!data || !data.rates || typeof data.rates !== 'object') return;

  // Build the GBP-based table; GBP is always 1. Sanity-check each rate is a
  // positive finite number before trusting it.
  const rates = { GBP: 1 };
  for (const sym of SYMBOLS) {
    const v = Number(data.rates[sym]);
    if (isFinite(v) && v > 0) rates[sym] = v;
  }
  // Require at least USD + EUR to consider the payload usable.
  if (!rates.USD || !rates.EUR) return;

  await kv.put(KV_KEY, JSON.stringify({
    rates,
    date: data.date || null,
    fetchedAt: new Date().toISOString()
  }), { expirationTtl: KV_TTL });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Edge-cache 1h so a burst of compare renders shares one copy; the
      // lazy refresh keeps the underlying data fresh within ~20h.
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    }
  });
}
