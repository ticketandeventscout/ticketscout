// ===========================
// TicketScout — SSR event pages (Phase 1.4B)
// Runs as a Cloudflare Pages Function at /event/{slug}
//
// REPO LOCATION: functions/event/[slug].js
// (NOT functions/football/... or functions/theatre/... — those collide with
//  the static stub folders and cause Error 1101/522 loops. /event/ is a
//  fresh path with no static-folder counterpart, which is why it's safe.)
//
// Serves every individual fixture/show as real server-rendered HTML so
// Google can index match-level long-tail queries ("arsenal vs chelsea
// tickets"). Replaces the crawl-invisible /#/event/{id} hash routes.
//
// Slug format (FROZEN v1 — changing it breaks every indexed URL):
//   {category}-{yyyy-mm-dd}-{normalised-name}
//   e.g. football-2026-08-09-arsenal-vs-borussia-dortmund
//
// Data: one D1 row from the `events` registry (see events-schema.sql),
// written opportunistically by the TM/SE365/Awin proxies and the daily
// Awin bulk sync. If no row exists the page still renders best-effort
// from the slug itself, but with <meta name="robots" content="noindex">
// so arbitrary made-up slugs can never pollute the index.
//
// Prices: the registry price is a render-time snapshot read per request —
// never baked into committed files. JSON-LD offers block is only emitted
// when a real, reasonably fresh price exists (same rule as the GSC schema
// fix: no offers is better than a fake/stale price).
//
// Caching: found+future pages edge-cache 1h with SWR (ISR-equivalent).
// noindex/best-effort pages cache briefly; malformed slugs 404 no-store.
// ===========================

const HOST = 'https://ticketscout.co.uk';

const SLUG_RE = /^(football|concert|theatre)-(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]*)$/;

const CATEGORY_META = {
  football: { label: 'Football',  hub: '/football/', schemaType: 'SportsEvent',  noun: 'match'  },
  concert:  { label: 'Concerts',  hub: '/concert',   schemaType: 'MusicEvent',   noun: 'show'   },
  theatre:  { label: 'Theatre',   hub: '/theatre',   schemaType: 'TheaterEvent', noun: 'show'   }
};

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;
  const rawSlug = String(params.slug || '').toLowerCase();

  // ── Edge cache — identical to the ticketmaster.js pattern ────────────────
  const cache    = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const m = rawSlug.match(SLUG_RE);
  if (!m) return notFound();

  const [, category, eventDate, nameSlug] = m;
  const cat = CATEGORY_META[category];

  // ── Look up the registry row ─────────────────────────────────────────────
  let row = null;
  if (env.PRICE_DB) {
    try {
      row = await env.PRICE_DB
        .prepare('SELECT * FROM event_pages WHERE slug = ?1')
        .bind(rawSlug).first();
    } catch (e) {
      // Table missing / D1 hiccup → degrade to best-effort render
      console.error('event page D1 lookup failed:', e);
    }
  }

  const today  = new Date().toISOString().slice(0, 10);
  const isPast = eventDate < today;

  // Best-effort fields when no registry row exists (or to fill gaps)
  const name  = row?.name  || titleCaseFromSlug(nameSlug);
  const venue = row?.venue || '';
  const city  = row?.city  || '';
  const image = row?.image || '';
  const tmUrl = row?.tm_url || '';

  // Price snapshot only trusted when reasonably fresh (≤7 days old)
  let price = null, currency = 'GBP';
  if (row?.price && row?.updated_at) {
    const ageMs = Date.now() - Date.parse(row.updated_at);
    if (isFinite(ageMs) && ageMs < 7 * 24 * 3600 * 1000) {
      price = Math.round(Number(row.price));
      currency = row.currency || 'GBP';
    }
  }
  // TM price snapshot is only used for the client hydration call (compare.js
  // renders the TM row from it) when the event is TM-sourced.
  const tmPrice = (tmUrl && price) ? price : null;

  // Indexable only when we have real registry data AND the event is upcoming
  const indexable = !!row && !isPast;

  const html = renderPage({
    slug: rawSlug, category, cat, name, eventDate, venue, city, image,
    price, currency, tmUrl, tmPrice, isPast, indexable
  });

  const resp = new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': indexable
        ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
        : 'public, max-age=60, s-maxage=600'
    }
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ===========================
// Page rendering
// ===========================

function renderPage(d) {
  const dateStr = prettyDate(d.eventDate);
  const where   = [d.venue, d.city].filter(Boolean).join(', ');
  const metaBits = [dateStr, where].filter(Boolean).join(' · ');

  const title = `${d.name} Tickets — ${dateStr} | Compare Prices | TicketScout`;
  const description = d.isPast
    ? `${d.name} took place on ${dateStr}${where ? ' at ' + where : ''}. Browse upcoming ${d.cat.label.toLowerCase()} events and compare ticket prices on TicketScout.`
    : `Compare ${d.name} ticket prices${where ? ' at ' + where : ''} on ${dateStr}. See prices from up to 13 verified ticket sites side by side — find the cheapest ${d.cat.noun} tickets on TicketScout.`;

  const canonical = `${HOST}/event/${d.slug}`;

  // ── JSON-LD — location ALWAYS populated (GSC schema fix rule), offers
  //    only when a real fresh price exists ────────────────────────────────
  const eventLd = {
    '@context': 'https://schema.org',
    '@type': d.cat.schemaType,
    name: d.name,
    startDate: d.eventDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: d.venue || 'Venue to be announced',
      ...(d.city ? { address: { '@type': 'PostalAddress', addressLocality: d.city } } : {})
    },
    ...(d.image ? { image: [d.image] } : {}),
    url: canonical,
    ...(d.price && !d.isPast ? {
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: d.price,
        priceCurrency: d.currency,
        availability: 'https://schema.org/InStock',
        url: canonical
      }
    } : {})
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: HOST + '/' },
      { '@type': 'ListItem', position: 2, name: d.cat.label, item: HOST + d.cat.hub },
      { '@type': 'ListItem', position: 3, name: d.name, item: canonical }
    ]
  };

  // Values handed to the client hydration script — JSON-encoded, never
  // string-interpolated raw (XSS safety for D1-sourced strings).
  const hydrate = JSON.stringify({
    name: d.name, tmPrice: d.tmPrice, tmUrl: d.tmUrl || '#',
    city: d.city, date: d.eventDate, venue: d.venue, category: d.category
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  ${d.indexable ? '' : '<meta name="robots" content="noindex" />'}
  <meta property="og:site_name" content="TicketScout" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(d.image || HOST + '/ogdefault.png')}" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
  <script type="application/ld+json">${JSON.stringify(eventLd).replace(/</g, '\\u003c')}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <nav class="navbar">
    <div class="nav-inner">
      <a href="/" aria-label="TicketScout - Compare UK Ticket Prices" style="text-decoration:none; display:flex; align-items:center; gap:10px;">
        <svg width="36" height="36" viewBox="0 40 248 200" xmlns="http://www.w3.org/2000/svg">
          <rect x="40" y="72" width="168" height="136" rx="12" fill="#1a6fc4"/>
          <circle cx="40" cy="140" r="16" fill="#ffffff"/>
          <circle cx="208" cy="140" r="16" fill="#ffffff"/>
          <line x1="40" y1="140" x2="208" y2="140" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5" opacity="0.5"/>
          <rect x="62" y="92" width="88" height="6" rx="3" fill="#ffffff" opacity="0.9"/>
          <rect x="62" y="106" width="60" height="6" rx="3" fill="#ffffff" opacity="0.6"/>
          <g transform="translate(168, 112)">
            <polygon points="0,-14 3.5,-5 13,-5 5.5,1 8.5,11 0,5.5 -8.5,11 -5.5,1 -13,-5 -3.5,-5" fill="#ffffff" opacity="0.95"/>
          </g>
          <rect x="62" y="158" width="50" height="5" rx="2.5" fill="#ffffff" opacity="0.5"/>
          <rect x="62" y="170" width="72" height="5" rx="2.5" fill="#ffffff" opacity="0.35"/>
          <rect x="62" y="182" width="40" height="5" rx="2.5" fill="#ffffff" opacity="0.25"/>
        </svg>
        <div style="display:flex; flex-direction:column; justify-content:center; line-height:1.2;">
          <span style="font-family:'Inter','Helvetica Neue',Arial,sans-serif; font-weight:700; font-size:22px; color:#0c2d5a; letter-spacing:-0.5px;">TicketScout</span>
          <span style="font-family:'Inter','Helvetica Neue',Arial,sans-serif; font-weight:400; font-size:11px; color:#1a6fc4; letter-spacing:2px;">compare. save. enjoy.</span>
        </div>
      </a>
      <div class="nav-links">
        <a href="/concert">Concerts</a>
        <a href="/football/">Football</a>
        <a href="/theatre">Theatre</a>
      </div>
    </div>
  </nav>

  <main class="container" style="max-width:900px; margin:0 auto; padding:24px 16px;">
    <div style="font-size:13px; color:#666; margin-bottom:14px;">
      <a href="/">Home</a> › <a href="${esc(d.cat.hub)}">${esc(d.cat.label)}</a> › ${esc(d.name)}
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        ${d.image ? `<img class="detail-img" src="${esc(d.image)}" alt="${esc(d.name)}" />` : ''}
        <div class="detail-body">
          <h1 class="detail-name" style="font-size:24px; margin:0 0 6px;">${esc(d.name)}</h1>
          <div class="detail-meta">${esc(metaBits) || 'Details to be confirmed'}</div>
          ${d.price && !d.isPast ? `<div class="detail-meta" style="margin-top:8px; font-weight:600; color:#0c2d5a;">Tickets from £${d.price}</div>` : ''}
          ${d.isPast ? `<div class="detail-meta" style="margin-top:8px; color:#b00;">This event has taken place. <a href="${esc(d.cat.hub)}">Browse upcoming ${esc(d.cat.label.toLowerCase())} →</a></div>` : ''}
        </div>
      </div>
      <div id="detail-compare"><div class="loading">Loading live prices…</div></div>
      <div id="detail-hotels"></div>
    </div>

    <section style="margin-top:28px; font-size:14px; line-height:1.6; color:#444;">
      <h2 style="font-size:17px; color:#0c2d5a;">Compare ${esc(d.name)} ticket prices</h2>
      <p>TicketScout compares ${esc(d.name)} ticket prices${where ? ' for the ' + esc(dateStr) + ' ' + d.cat.noun + ' at ' + esc(where) : ''} from up to 13 verified ticket sites side by side, so you can see who has the cheapest tickets before you buy. Prices are refreshed through the day. TicketScout does not sell tickets — always confirm price and availability on the seller's site.</p>
    </section>
  </main>

  <footer class="footer">
    <div class="footer-inner">
      <p>© 2026 TicketScout · ticketscout.co.uk · All prices in GBP</p>
      <p style="margin-top:6px;"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a> · <a href="/faq">FAQ</a> · <a href="/contact">Contact</a></p>
      <p style="margin-top:14px; font-size:12px; color:#999; max-width:560px; margin-left:auto; margin-right:auto; line-height:1.5;">
        TicketScout does not sell tickets and is not a ticket retailer. We display pricing and availability sourced from third-party providers and cannot guarantee its accuracy. Always confirm event details, pricing and availability on the seller's site before purchasing.
      </p>
    </div>
  </footer>

  <script src="/compare.js?v=20260719d"></script>
  <script>
    (function () {
      var EV = ${hydrate};
      // Hydrate the compare table exactly as the hash-route detail view does
      if (typeof renderComparePrices === 'function') {
        renderComparePrices(
          document.getElementById('detail-compare'),
          EV.name, EV.tmPrice, EV.tmUrl, EV.city, EV.date, EV.venue, EV.category
        );
      }
      // Hotel card (inline copy of events.js renderHotelCard — events.js
      // itself can't load here: its router expects the homepage DOM)
      if (EV.city && EV.date) {
        (async function () {
          var container = document.getElementById('detail-hotels');
          if (!container) return;
          try {
            var params = new URLSearchParams({ city: EV.city, date: EV.date });
            if (EV.venue) params.set('venue', EV.venue);
            var resp = await fetch('/api/hotels?' + params.toString());
            var data = await resp.json().catch(function () { return null; });
            if (!data || !data.hotels) return;
            var h = data.hotels;
            var dateStr = h.checkin ? new Date(h.checkin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            container.innerHTML =
              '<div class="hotel-card">' +
                '<div class="hotel-card-title">' +
                  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' +
                  ' Where to stay near ' + EV.city +
                '</div>' +
                (dateStr ? '<div class="hotel-card-date">Check-in: ' + dateStr + '</div>' : '') +
                '<div class="hotel-card-links">' +
                  '<a href="' + h.hotels_url + '" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--primary">Search Hotels.com →</a>' +
                  '<a href="' + h.trivago_url + '" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--secondary">Compare on Trivago →</a>' +
                '</div>' +
                '<div class="hotel-card-note">Prices from verified hotel booking sites. No booking fees added by us.</div>' +
              '</div>';
          } catch (e) { /* supplementary — silent fail */ }
        })();
      }
    })();
  </script>
</body>
</html>`;
}

// ===========================
// Helpers
// ===========================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function prettyDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return iso; }
}

// "arsenal-vs-borussia-dortmund" → "Arsenal vs Borussia Dortmund"
function titleCaseFromSlug(nameSlug) {
  const connectors = ['vs', 'v', 'at', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on'];
  const alwaysUpper = ['fc', 'cf', 'ac', 'sc', 'rc', 'afc', 'utd', 'ud', 'rcd'];
  return nameSlug.split('-').filter(Boolean).map((w, i) => {
    if (alwaysUpper.includes(w)) return w.toUpperCase();
    if (i > 0 && connectors.includes(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function notFound() {
  const body = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Event not found | TicketScout</title><meta name="robots" content="noindex" />
<link rel="stylesheet" href="/styles.css" /></head>
<body><main class="container" style="max-width:700px; margin:60px auto; padding:0 16px; text-align:center;">
<h1 style="color:#0c2d5a;">Event not found</h1>
<p>We couldn't find that event. It may have passed or the link may be incorrect.</p>
<p><a href="/">← Back to TicketScout</a> · <a href="/football/">Football</a> · <a href="/concert">Concerts</a> · <a href="/theatre">Theatre</a></p>
</main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
