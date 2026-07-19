// ===========================
// TicketScout — /api/go click-out redirector + signal beacon (Phase 6.4 / 6.3)
//
// One endpoint, four roles:
//   1. ATTRIBUTION  — every outbound affiliate click flows through here and is
//                     counted into D1 merchant_daily (the 6.3 denominator)
//   2. KILL-SWITCH  — checks merchant:suspend:{id} in KV; a suspended merchant's
//                     clicks bounce back to the referring page in seconds
//   3. ANALYTICS    — optional Workers Analytics Engine datapoint per click
//                     (bind CLICKS on the Pages project to activate; fully
//                     guarded — absent binding is a silent no-op)
//   4. SIGNAL BEACON — compare.js posts adapter errors / request counts /
//                     implausible-listing hits here (?beacon=...) → D1
//
// Design notes (honest v1):
// - STATELESS: the affiliate URL travels in the ?u= param, validated against a
//   strict affiliate-domain whitelist. This is NOT an open redirector — any
//   host outside the whitelist 302s to the homepage, never to the target.
// - The roadmap's KV click:{id} records + alternate-offer fallback routing +
//   the 6.1 price-verification interstitial all require a server-side render
//   writing click records. compare.js renders client-side today, so those
//   pieces are deferred to the 1.4B server-render. What ships now is the
//   attribution + hygiene + kill-switch layer they will plug into.
// - robots.txt already has Disallow: /api/ — crawlers never spend budget here
//   and affiliate params never enter Google's index. (The Allow: /api/sitemap
//   line is more specific and unaffected.)
// - 302 (never 301) + no-store: affiliate URLs change; nothing may cache them.
// - D1 writes ride waitUntil() so the user's redirect is never blocked by
//   logging. Missing PRICE_DB binding degrades to redirect-only, no errors.
//
// Usage:
//   /api/go?u=<encodeURIComponent(affiliateUrl)>&s=<source>&p=<priceGBP>
//   /api/go?beacon=err&s=<source>            — adapter fetch/parse failure
//   /api/go?beacon=req&n=<adapterCount>      — one per compare render (denominator)
//   /api/go?beacon=implausible&s=<source>    — E2 median-gate hit
// ===========================

// Suffix-matched whitelist: exact host or any subdomain of these.
// Direct merchant domains + the four networks' tracking domains.
const ALLOWED_HOSTS = [
  // Direct merchants
  'ticketmaster.co.uk', 'gigsberg.com', 'sportsevents365.com', 'ticombo.com',
  'eventim.co.uk', 'eventim.pl', 'theatreticketsdirect.co.uk',
  'ticketnetwork.com', 'vividseats.com', 'skiddle.com', 'seatgeek.com',
  'hotels.com', 'trivago.co.uk', 'soldout.com',
  // Awin
  'awin1.com',
  // Partnerize
  'prf.hn',
  // Impact (Vivid Seats / TicketNetwork tracking links)
  'pxf.io', 'sjv.io', 'evyy.net',
  // CJ (Hotels.com / Trivago tracking links)
  'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com'
];

// compare.js source label → merchant id (D1 merchants.id / KV suspend keys)
const SOURCE_TO_MERCHANT = {
  'Ticketmaster':            'tm',
  'Gigsberg':                'gigsberg',
  'Gigsberg UK':             'gigsberg',
  'Vivid Seats':             'vividseats',
  'SportsEvents365':         'se365',
  'Skiddle':                 'skiddle',
  'SeatGeek':                'seatgeek',
  'Theatre Tickets Direct':  'ttd',
  'Football TicketNet UK':   'ftn',
  'Ticombo':                 'ticombo',
  'TicketNetwork':           'ticketnetwork',
  'Eventim':                 'eventim_uk',
  'Eventim PL':              'eventim_pl',
  'Soldout':                 'soldout'
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);

  // ── Beacon mode: signal collection from compare.js ──────────────────────
  const beacon = url.searchParams.get('beacon');
  if (beacon) {
    const source = url.searchParams.get('s') || '';
    const merchant = SOURCE_TO_MERCHANT[source] || null;
    if (beacon === 'err' && merchant) {
      context.waitUntil(bumpDaily(env, merchant, today, 'api_errors', 1));
    } else if (beacon === 'implausible' && merchant) {
      context.waitUntil(bumpDaily(env, merchant, today, 'implausible_listings', 1));
    } else if (beacon === 'req') {
      // Site-wide adapter-request denominator: one beacon per compare render,
      // n = how many adapters were attempted
      const n = Math.min(parseInt(url.searchParams.get('n') || '0', 10) || 0, 30);
      if (n > 0) context.waitUntil(bumpDaily(env, '_site', today, 'requests', n));
    }
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── Redirect mode ────────────────────────────────────────────────────────
  const rawTarget = url.searchParams.get('u') || '';
  const source    = url.searchParams.get('s') || 'unknown';
  const price     = parseFloat(url.searchParams.get('p') || '') || 0;
  const merchant  = SOURCE_TO_MERCHANT[source] || null;

  let target = null;
  try { target = new URL(rawTarget); } catch {}
  const hostAllowed = target
    && target.protocol === 'https:'
    && ALLOWED_HOSTS.some(d => target.hostname === d || target.hostname.endsWith('.' + d));

  // Anything invalid or off-whitelist goes HOME, never to the target —
  // this endpoint must not be usable as an open redirector.
  if (!hostAllowed) {
    return redirect('/', 302);
  }

  // Kill-switch: merchant:suspend:{id} in KV pulls a partner in seconds.
  // Suspended clicks bounce back to the page they came from (soft landing).
  if (merchant) {
    try {
      const suspended = await env.GIGSBERG_KV?.get(`merchant:suspend:${merchant}`);
      if (suspended) {
        const back = request.headers.get('Referer') || '/';
        return redirect(back, 302);
      }
    } catch {}
  }

  // Click logging — never blocks the redirect
  if (merchant) {
    context.waitUntil(bumpDaily(env, merchant, today, 'clicks', 1));
  }
  try {
    // Workers Analytics Engine — optional binding, silent no-op if absent
    env.CLICKS?.writeDataPoint({
      blobs:   [source, target.hostname, request.headers.get('User-Agent')?.slice(0, 80) || ''],
      doubles: [price],
      indexes: [merchant || 'unknown']
    });
  } catch {}

  return redirect(target.href, 302);
}

function redirect(location, status) {
  return new Response(null, {
    status,
    headers: {
      'Location': location,
      'Cache-Control': 'no-store',       // affiliate URLs must never be cached
      'Referrer-Policy': 'no-referrer',  // don't leak our URLs downstream
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

// D1 upsert into merchant_daily — guarded, absent binding is a no-op
async function bumpDaily(env, merchantId, day, column, n) {
  if (!env.PRICE_DB) return;
  // column comes only from our own literals above — never user input
  const safe = ['clicks', 'api_errors', 'implausible_listings', 'requests'];
  if (!safe.includes(column)) return;
  try {
    await env.PRICE_DB.prepare(
      `INSERT INTO merchant_daily (merchant_id, day, ${column}) VALUES (?, ?, ?)
       ON CONFLICT(merchant_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`
    ).bind(merchantId, day, n).run();
  } catch (err) {
    console.error('[go] merchant_daily write failed:', String(err));
  }
}
