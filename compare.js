// ===========================
// TicketScout — Price Compare (adapter pattern)
//
// Each source is registered in ADAPTERS as a lightweight descriptor.
// The orchestrator (comparePrices) calls every adapter in parallel and
// collects normalised results shaped like:
//
//   {
//     source:    string   — display name shown in the comparison block
//     price:     number   — lowest available price (GBP), or null
//     currency:  'GBP'
//     url:       string   — deep link to the event on that seller's site
//     available: boolean  — false when sold out or no inventory found
//   }
//
// Adding a new source in future:
//   1. Create functions/api/<source>.js (Cloudflare Function proxy)
//   2. Add one entry to ADAPTERS below — nothing else needs to change
// ===========================


// ===========================
// Adapter registry
// Each entry declares how to call a proxy endpoint and how to parse
// its response into the normalised shape above.
// ===========================

const ADAPTERS = [
  {
    source: 'SeatGeek',

    // Build the URL for our server-side proxy
    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (venueCity) params.set('city', venueCity);
      return `/api/seatgeek?${params.toString()}`;
    },

    // Parse the raw proxy response into a normalised result
    // Returns null if no usable price was found
    normalise(data, eventName) {
      if (data.error || !data.events?.length) return null;

      // Pick the best-matching event by name similarity then lowest price
      const normQuery = normaliseName(eventName);
      const candidates = data.events
        .filter(e => e.stats?.lowest_price)
        .sort((a, b) => {
          const aMatch = normaliseName(a.title).includes(normQuery) ? 0 : 1;
          const bMatch = normaliseName(b.title).includes(normQuery) ? 0 : 1;
          if (aMatch !== bMatch) return aMatch - bMatch;
          return a.stats.lowest_price - b.stats.lowest_price;
        });

      if (!candidates.length) return null;

      const event = candidates[0];
      const price = Math.round(event.stats.lowest_price);

      return {
        source: 'SeatGeek',
        price,
        currency: 'GBP',
        url: event.url,
        available: true
      };
    }
  },

  {
    source: 'Skiddle',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName, feed: 'topsellers' });
      return `/api/skiddle?${params.toString()}`;
    },

    async normalise(data, eventName) {
      if (data.error) return null;

      // If top sellers feed had no match, try the festivals feed
      if (!data.match) {
        const fallback = await fetch(
          `/api/skiddle?q=${encodeURIComponent(eventName)}&feed=festivals`
        ).then(r => r.json()).catch(() => ({}));
        if (!fallback.match) return null;
        data = fallback;
      }

      const match = data.match;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard
      if (!match.price) return null;

      return {
        source:    'Skiddle',
        price:     Math.round(match.price),
        currency:  'GBP',
        url:       match.url,
        available: true
      };
    }
  },

  {
    // Gigsberg adapter — uses /api/awin-category which reads from awin:category:latest KV
    // Returns { matches: [...] } — picks best match by name then lowest price
    source: 'Gigsberg',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      return `/api/awin-category?${params.toString()}`;
    },

    normalise(data, eventName) {
      // awin-category returns { matches: [...] } — one best match per merchant.
      // Return them ALL as separate compare rows (Gigsberg + Eventim PL + FTN...)
      const matches = data?.matches || [];
      if (!matches.length) return null;
      const rows = matches.filter(m => m.url).map(best => ({
        source:    best.merchant_name || 'Gigsberg',
        price:     best.price ? Math.round(best.price) : null,
        currency:  best.currency || 'GBP',
        url:       best.url,
        available: true
      }));
      return rows.length ? rows : null;
    }
  },

  {
    // SportsEvents365 — real-time REST API, sports and shows inventory
    // Strong on football, F1, rugby, and major international sports events
    // Approved affiliate: 7% commission, affiliate ID stored in Cloudflare env
    source: 'SportsEvents365',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      return `/api/sportsevents365?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.match) return null;

      const match = data.match;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard
      if (!match.url) return null;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard

      // Price may be null if SE365 doesn't return one — still surface the seller
      // with a "See site" fallback so the user knows it's available
      return {
        source:    'SportsEvents365',
        price:     match.price || null,
        currency:  match.currency || 'GBP',
        url:       match.url,
        available: true
      };
    }
  },

  {
    // Vivid Seats (via Impact affiliate deep-link)
    // Strong US/UK/Canada inventory — concerts, sports, theatre
    // Commission tracked via Impact: vivid-seats.pxf.io/c/7443544/952533/12730
    source: 'Vivid Seats',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      return `/api/vividseats?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.match || !data.match.url) return null;
      const match = data.match;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard
      // Prices are in USD from VS catalog — display as USD, not GBP
      // Still surface even without price (earns commission on click-through)
      return {
        source:    'Vivid Seats',
        price:     match.price ? Math.round(match.price) : null,
        currency:  match.currency || 'USD',
        url:       match.url,
        available: true
      };
    }
  },

  {
    // Ticombo (via Partnerize) — global ticket marketplace
    // Region-aware: CF-IPCountry header routes to correct regional camref
    // 9 campaigns: UK, US, Europe, Germany, Spain, Singapore, Mexico, APAC, LATAM
    source: 'Ticombo',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      return `/api/ticombo?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.match || !data.match.url) {
        return null;
      }
      const match = data.match;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard
      return {
        source:     'Ticombo',
        price:      match.isFallback ? null : (match.price ? Math.round(match.price) : null),
        currency:   match.currency || 'GBP',
        url:        match.url,
        available:  true,
        // Flag fallback so UI can show "Search" instead of a price
        isFallback: !!match.isFallback
      };
    }
  },

  {
    // TicketNetwork (via Impact) — 12-14% commission, 184k+ events
    // Impact Publisher: 7443544, Campaign: 2322
    source: 'TicketNetwork',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      return `/api/ticketnetwork?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.match || !data.match.url) return null;
      const match = data.match;
      if (competitionMismatch(eventName, match.name)) return null;  // E1 guard
      return {
        source:    'TicketNetwork',
        price:     match.price ? Math.round(match.price) : null,
        currency:  match.currency || 'USD',
        url:       match.url,
        available: true
      };
    }
  },

  // ── Eventim PL — priced rows from the Awin category cache ───────────────
  // Eventim PL has a real product feed (4,171 rows) in the Awin cache, but
  // the Gigsberg adapter only surfaces ONE best Awin row per event across
  // all merchants. This adapter queries the same cache restricted to
  // merchant='Eventim PL' so Polish events show Eventim PL's price as its
  // own compare row alongside Gigsberg's.
  {
    source: 'Eventim PL',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName, merchant: 'Eventim PL' });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      return `/api/awin-category?${params.toString()}`;
    },

    normalise(data, eventName) {
      const matches = data?.matches || [];
      if (!matches.length) return null;
      const best = matches[0];
      if (!best.url) return null;
      if (competitionMismatch(eventName, best.name)) return null;  // E1 guard
      return {
        source:    'Eventim PL',
        price:     best.price ? Math.round(best.price) : null,
        currency:  best.currency || 'PLN',
        url:       best.url,
        available: true
      };
    }
  },

  // ── Eventim UK — deep link only (no product feed) ───────────────────────
  // Awin publisher 2960641, merchant 15330. Constructs a search deep link
  // directly — no API call, no price, shows "Search Eventim" in the table.
  // Only shown for UK-relevant events (concerts + theatre, not football).
  // Commission: per-click or per-sale depending on campaign terms.
  {
    source: 'Eventim',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      // Returns the event name — the custom fetch() builds the actual URL
      return eventName;
    },

    async fetch(url, eventName) {
      // url is just the eventName passed through from buildUrl
      // Build the Eventim search deep link with Awin tracking
      const searchQuery = encodeURIComponent((eventName || url).split(' vs ')[0].trim());
      const destination = encodeURIComponent(
        `https://www.eventim.co.uk/search/?affiliate=EVT&search_term=${searchQuery}`
      );
      const affiliateUrl = `https://www.awin1.com/cread.php?awinmid=15330&awinaffid=2960641&ued=${destination}`;
      return { eventimUrl: affiliateUrl };
    },

    normalise(data, eventName, eventDate, venueName, venueCity) {
      if (!data || !data.eventimUrl) return null;
      // Shown on ALL categories including football — a no-price fallback link
      // costs nothing, gives users one more option, and every click is tracked.
      return {
        source:     'Eventim',
        price:      null,           // no price — deep link only
        currency:   'GBP',
        url:        data.eventimUrl,
        available:  true,
        isFallback: true            // renders as "Search Eventim" not a price
      };
    }
  },

  // ── Future adapters go here ───────────────────────────────────────────────
];


// ===========================
// Orchestrator — runs all adapters in parallel
// Returns an array of normalised results (nulls and errors silently dropped)
// ===========================

// Extract the core performer/artist name from a full TM event title
// "Metallica: Life Burns Faster" -> "Metallica"
// "Arsenal vs Chelsea" -> "Arsenal"  (keep vs format for sports)
// "Friday Day - Wireless 2026" -> "Wireless 2026" (don't strip generic day words)
// "Phantom of the Opera" -> "Phantom of the Opera" (no colon = keep as-is)
const GENERIC_PREFIXES = new Set([
  'friday', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday',
  'day', 'night', 'vip', 'general', 'ga', 'early', 'late', 'opening',
  'friday day', 'saturday day', 'sunday day', 'friday night', 'saturday night',
  'day 1', 'day 2', 'day 3', 'day 4', 'weekend', 'weekend pass'
]);

function extractPerformerName(fullName) {
  if (!fullName) return '';
  // Strip subtitle after colon (e.g. "Metallica: Life Burns Faster" -> "Metallica")
  const colonIdx = fullName.indexOf(':');
  if (colonIdx > 0) return fullName.slice(0, colonIdx).trim();
  // Strip " vs " / " vs. " / " v " — football match names (keep home team only)
  // e.g. "FC Bayern Munich vs. RB Leipzig" -> "FC Bayern Munich"
  // e.g. "Real Madrid CF vs Real Sociedad" -> "Real Madrid CF"
  const vsMatch = fullName.match(/^(.+?)\s+vs?\.?\s+.+$/i);
  if (vsMatch) return vsMatch[1].trim();
  // Strip subtitle after " - " ONLY if the part before is not a generic day/type word
  const dashIdx = fullName.indexOf(' - ');
  if (dashIdx > 0) {
    const before = fullName.slice(0, dashIdx).trim().toLowerCase();
    const after  = fullName.slice(dashIdx + 3).trim();
    if (GENERIC_PREFIXES.has(before)) return after;
    return fullName.slice(0, dashIdx).trim();
  }
  return fullName.trim();
}


// ── Competition-marker mismatch guard (E1) ─────────────────────────────────
// "Arsenal vs Chelsea" and "Arsenal Women vs Chelsea Women" can share a week
// and a stadium. If the query and the matched listing disagree on a
// women's/youth/legends marker, the match is a different competition —
// comparing its price would be comparing a different product entirely.
const COMPETITION_MARKERS = /\b(women|women's|womens|wsl|ladies|u21|u23|u18|u19|academy|youth|legends|reserves)\b/i;
function competitionMismatch(queryName, matchName) {
  if (!queryName || !matchName) return false;
  const q = COMPETITION_MARKERS.test(queryName);
  const m = COMPETITION_MARKERS.test(matchName);
  return q !== m;   // one has a marker, the other doesn't → different competition
}

// ===========================
// Phase 6 — click-out attribution, signal beacons, merchant status
// ===========================
// Source label → merchant id (must mirror SOURCE_TO_MERCHANT in /api/go)
const MERCHANT_IDS = {
  'Ticketmaster': 'tm', 'Gigsberg': 'gigsberg', 'Gigsberg UK': 'gigsberg',
  'Vivid Seats': 'vividseats', 'SportsEvents365': 'se365', 'Skiddle': 'skiddle',
  'SeatGeek': 'seatgeek', 'Theatre Tickets Direct': 'ttd',
  'Football TicketNet UK': 'ftn', 'Ticombo': 'ticombo',
  'TicketNetwork': 'ticketnetwork', 'Eventim': 'eventim_uk', 'Eventim PL': 'eventim_pl'
};

// Route outbound affiliate links through /api/go for attribution, the
// merchant kill-switch, and analytics. FAIL-SAFE: only hosts on this list
// are wrapped — an unrecognised domain keeps its direct link (exactly
// today's behaviour, just without attribution) so a whitelist gap can
// never bounce a paying customer to the homepage. Must stay a subset of
// ALLOWED_HOSTS in functions/api/go.js. Unrecognised affiliate domains
// are console.warned — add them to BOTH lists when spotted.
const GO_HOSTS = [
  'ticketmaster.co.uk', 'gigsberg.com', 'sportsevents365.com', 'ticombo.com',
  'eventim.co.uk', 'eventim.pl', 'theatreticketsdirect.co.uk',
  'ticketnetwork.com', 'vividseats.com', 'skiddle.com', 'seatgeek.com',
  'hotels.com', 'trivago.co.uk', 'awin1.com', 'prf.hn',
  'pxf.io', 'sjv.io', 'evyy.net',
  'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com'
];
function goUrl(url, source, price) {
  if (!url || url === '#' || !/^https:\/\//.test(url)) return url;
  try {
    const host = new URL(url).hostname;
    if (!GO_HOSTS.some(d => host === d || host.endsWith('.' + d))) {
      console.warn('[go] unlisted affiliate domain, linking direct:', host, '(' + source + ')');
      return url;   // fail-safe: direct link, no attribution, no breakage
    }
  } catch { return url; }
  const p = new URLSearchParams({ u: url, s: source || '' });
  if (price) p.set('p', String(Math.round(price)));
  return '/api/go?' + p.toString();
}

// Fire-and-forget signal beacon (errors, request counts, implausible hits).
// keepalive lets it survive the user navigating away mid-flight.
function signalBeacon(params) {
  try {
    fetch('/api/go?beacon=' + params, { method: 'GET', keepalive: true }).catch(() => {});
  } catch {}
}

// Merchant status — fetched once per compare render, edge-cached 5 min.
// { suspended: [ids], badges: [ids], scores: {id: 0..1} }
let MERCHANT_STATUS = { suspended: [], badges: [], scores: {} };
async function loadMerchantStatus() {
  try {
    const r = await fetch('/api/merchant-status');
    if (r.ok) MERCHANT_STATUS = await r.json();
  } catch {}
  return MERCHANT_STATUS;
}

async function comparePrices(eventName, venueCity, eventDate, venueName) {
  // Use performer name (stripped of subtitles) for adapter searches
  const performerName = extractPerformerName(eventName);

  // Phase 6.3: skip suspended merchants entirely; count adapter attempts
  // (site-wide denominator for the reliability score)
  await loadMerchantStatus();
  const activeAdapters = ADAPTERS.filter(a =>
    !MERCHANT_STATUS.suspended.includes(MERCHANT_IDS[a.source]));
  signalBeacon('req&n=' + activeAdapters.length);

  const settled = await Promise.allSettled(
    activeAdapters.map(async adapter => {
      // Pass performerName for search queries, but keep full eventName for normalise matching
      const url = adapter.buildUrl(performerName, venueCity, eventDate, venueName);

      // Adapters with a custom fetch() method (e.g. deep-link adapters that
      // don't make network calls) bypass the standard JSON fetch path
      let data;
      if (adapter.fetch) {
        data = await adapter.fetch(url, performerName, venueCity, eventDate, venueName);
      } else {
        const response = await fetch(url);
        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          console.warn('[compare]', adapter.source, 'returned non-JSON:', response.status, ct);
          signalBeacon('err&s=' + encodeURIComponent(adapter.source));
          return null;
        }
        data = await response.json().catch(e => {
          console.warn('[compare]', adapter.source, 'JSON parse error:', e);
          signalBeacon('err&s=' + encodeURIComponent(adapter.source));
          return null;
        });
      }
      if (!data) return null;
      const result = await adapter.normalise(data, performerName);
      // result is null if adapter found no match
      return result;
    })
  );

  // Network-level adapter failures (rejected promises) → error beacon
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[compare]', activeAdapters[i].source, 'adapter failed:', r.reason);
      signalBeacon('err&s=' + encodeURIComponent(activeAdapters[i].source));
    }
  });

  return settled
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    // Adapters may return a single result OR an array (e.g. awin best-per-merchant)
    .flatMap(r => Array.isArray(r.value) ? r.value : [r.value]);
}


// ===========================
// Renderer — builds the comparison block on the event detail page
// Called from events.js with the Ticketmaster price already in hand
// (TM data comes from the event detail fetch, not a separate adapter call)
// ===========================

function renderComparePrices(container, eventName, tmPrice, tmUrl, venueCity, eventDate, venueName) {
  if (!container) return;

  // Render the shell immediately with a loading state — TM row is NOT
  // rendered yet because we need to know what other adapters return first.
  // TM display rules (decided once adapter results are in):
  //   1. No other sellers found prices → show TM as the only option (even without a price)
  //   2. Other sellers found prices AND TM has a price → show TM (it adds to the comparison)
  //   3. Other sellers found prices AND TM has no price → hide TM (no commission + no value)
  container.innerHTML = `
    <div class="compare-block">
      <div class="compare-title">Compare prices from verified sellers</div>
      <style>
        .compare-block { font-family:'Inter','Helvetica Neue',Arial,sans-serif; box-sizing:border-box; }
        .compare-row { display:flex; align-items:center; gap:10px; padding:12px 20px; border-bottom:1px solid #f0f0f0; box-sizing:border-box; }
        .compare-row:last-child { border-bottom:none; }
        .compare-source-logo { width:36px; height:36px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; flex-shrink:0; }
        .compare-source-name { flex:1; font-size:14px; font-weight:600; color:#1a1a1a; }
        .compare-right { display:flex; align-items:center; gap:8px; }
        .compare-from { font-size:11px; color:#888; white-space:nowrap; width:28px; text-align:right; flex-shrink:0; }
        .compare-price-wrap { display:flex; flex-direction:column; align-items:flex-end; min-width:64px; }
        .price-label { font-size:17px; font-weight:700; color:#1a1a1a; white-space:nowrap; }
        .compare-buy { background:#1a6fc4; color:#fff; padding:9px 16px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; flex-shrink:0; margin-left:4px; }
        .compare-buy:hover { background:#155da0; }
        .best-price-badge { display:block; background:#22c55e; color:#fff; font-size:10px; font-weight:700; padding:2px 7px; border-radius:10px; text-align:center; margin-top:2px; }
        .trusted-badge { display:inline-block; color:#16a34a; font-size:10px; font-weight:600; margin-left:6px; white-space:nowrap; }
        .compare-loading { padding:20px; text-align:center; color:#888; font-size:14px; }
        .compare-footnote { font-size:11px; color:#999; text-align:center; padding:12px 20px 4px; line-height:1.5; }
        .compare-title { font-size:14px; font-weight:600; color:#1a1a1a; padding:14px 20px 10px; border-bottom:1px solid #f0f0f0; }
        @media(max-width:560px) {
          .compare-row { padding:11px 14px; gap:8px; }
          .compare-source-name { font-size:13px; }
          .compare-from { font-size:10px; width:24px; }
          .price-label { font-size:15px; min-width:52px; }
          .compare-buy { padding:8px 11px; font-size:12px; }
        }
        @media(max-width:400px) {
          .compare-row { padding:10px 12px; gap:6px; }
          .compare-from { display:none; }
          .price-label { font-size:14px; min-width:48px; }
          .compare-buy { padding:7px 9px; font-size:11px; }
        }
      </style>
      <div id="compare-rows">
        <div id="adapter-prices">
          <div class="compare-loading">Checking prices across sellers…</div>
        </div>
      </div>
      <div class="compare-footnote">Prices shown are the lowest available and may exclude booking fees. Ticketmaster and SportsEvents365 prices are live; other sellers' prices are refreshed several times a day. Resale prices may differ from face value. Always confirm the final price on the seller's site before purchasing.</div>
    </div>
  `;

  comparePrices(eventName, venueCity, eventDate, venueName).then(results => {
    const slot = document.getElementById('adapter-prices');
    if (!slot) return;

    // Include VS and other sources even without price — affiliate click still earns commission
    const withPrices = results
      .filter(r => r.available && (r.price || r.source === 'Vivid Seats' || r.source === 'Ticombo' || r.source === 'TicketNetwork' || r.source === 'Eventim'))
      .sort((a, b) => {
        // Sort by price ascending (best/lowest first)
        // Items without price go to the bottom
        if (!a.price && !b.price) return 0;
        if (!a.price) return 1;
        if (!b.price) return -1;
        return a.price - b.price;
      });

    // ── Source dedup ───────────────────────────────────────────────────
    // The same seller can arrive twice for one event (e.g. Eventim PL via
    // its dedicated adapter AND inside the generic Awin best-per-merchant
    // rows). One row per seller: keep the cheapest priced entry, or the
    // first entry when none carry a price.
    {
      const bySource = new Map();
      for (const r of withPrices) {
        const existing = bySource.get(r.source);
        if (!existing) { bySource.set(r.source, r); continue; }
        if (r.price && (!existing.price || r.price < existing.price)) bySource.set(r.source, r);
      }
      if (bySource.size < withPrices.length) {
        withPrices.length = 0;
        withPrices.push(...bySource.values());
        withPrices.sort((a, b) => {
          if (!a.price && !b.price) return 0;
          if (!a.price) return 1;
          if (!b.price) return -1;
          return a.price - b.price;
        });
      }
    }

    // ── Plausibility gate (E2) ─────────────────────────────────────────
    // A price under 40% of the cross-source median for the same event is
    // very likely a speculative listing or a wrong-event match. Keep the
    // row (click still earns commission) but mark it implausible so it
    // never wins the "Best price" badge or the headline slot.
    const realPrices = withPrices.map(r => r.price).filter(Boolean).sort((a, b) => a - b);
    if (realPrices.length >= 3) {
      const median = realPrices[Math.floor(realPrices.length / 2)];
      withPrices.forEach(r => {
        if (r.price && r.price < median * 0.4) {
          r.implausible = true;
          signalBeacon('implausible&s=' + encodeURIComponent(r.source));
        }
      });
      // Re-sort: plausible prices first (ascending), implausible after, no-price last
      withPrices.sort((a, b) => {
        const rank = r => !r.price ? 2 : (r.implausible ? 1 : 0);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (!a.price || !b.price) return 0;
        return a.price - b.price;
      });
    }

    slot.innerHTML = '';
    const otherHavePrices = withPrices.some(r => r.price);
    // Show TM when: it has a price, OR no other seller has a real price (sole coverage)
    if (tmPrice || !otherHavePrices) {
      if (tmUrl && tmUrl !== '#') {
        slot.insertAdjacentHTML('beforeend', buildRow('Ticketmaster', tmPrice, tmUrl, 'GBP'));
      }
    }
    withPrices.forEach(result => {
      slot.insertAdjacentHTML('beforeend', buildRow(result.source, result.price, result.url, result.currency, result.implausible));
    });
    // Safety — if nothing rendered at all, show TM as fallback
    if (!slot.innerHTML.trim() && tmUrl && tmUrl !== '#') {
      slot.innerHTML = buildRow('Ticketmaster', tmPrice, tmUrl, 'GBP');
    }

    highlightBestPrice();
  });
}

// Builds a single comparison row as an HTML string.
// price is a number (GBP) or null/undefined for "See site".
// Source styles — logo image URLs where available, coloured abbr badge as fallback
// Source logos — favicons from affiliate sites with coloured abbr badge as fallback
const SOURCE_STYLES = {
  // Logos via Google's favicon service — crisp 64px, works for every
  // provider, no local asset maintenance. Coloured abbr badge remains
  // the fallback if an icon fails to load.
  'Ticketmaster':          { logo: fav('ticketmaster.co.uk'),          bg: '#026cdf', color: '#fff', abbr: 'TM' },
  'Gigsberg':              { logo: fav('gigsberg.com'),                bg: '#0a1628', color: '#fff', abbr: 'GS' },
  'Gigsberg UK':           { logo: fav('gigsberg.com'),                bg: '#0a1628', color: '#fff', abbr: 'GS' },
  'Vivid Seats':           { logo: fav('vividseats.com'),              bg: '#00a0e9', color: '#fff', abbr: 'VS' },
  'SportsEvents365':       { logo: fav('sportsevents365.com'),         bg: '#e85d04', color: '#fff', abbr: 'SE' },
  'Skiddle':               { logo: fav('skiddle.com'),                 bg: '#00b4b4', color: '#fff', abbr: 'SK' },
  'SeatGeek':              { logo: fav('seatgeek.com'),                bg: '#de5448', color: '#fff', abbr: 'SG' },
  'Theatre Tickets Direct':{ logo: fav('theatreticketsdirect.co.uk'),  bg: '#7c3aed', color: '#fff', abbr: 'TD' },
  'Football TicketNet UK': { logo: fav('footballticketnet.com'),       bg: '#16a34a', color: '#fff', abbr: 'FT' },
  'Ticombo':               { logo: fav('ticombo.com'),                 bg: '#6366f1', color: '#fff', abbr: 'TC' },
  'TicketNetwork':         { logo: fav('ticketnetwork.com'),           bg: '#c0392b', color: '#fff', abbr: 'TN' },
  'Eventim':               { logo: fav('eventim.co.uk'),               bg: '#e8252a', color: '#fff', abbr: 'EV' },
  'Eventim PL':            { logo: fav('eventim.pl'),                  bg: '#003399', color: '#fff', abbr: 'EP' },
};
function fav(domain) { return 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=64'; }

function buildLogoEl(style) {
  if (style.logo) {
    // Use img tag with fallback to abbr badge if image fails to load
    return `<img src="${style.logo}" alt="" width="36" height="36"
      style="border-radius:6px;object-fit:contain;background:#f5f5f5;padding:4px;"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <div class="compare-source-logo" style="display:none;background:${style.bg};color:${style.color};">${style.abbr}</div>`;
  }
  return `<div class="compare-source-logo" style="background:${style.bg};color:${style.color};">${style.abbr}</div>`;
}

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€', PLN: 'zł', CHF: 'CHF ', CAD: 'C$', AUD: 'A$', SGD: 'S$' };

function buildRow(source, price, url, currency, implausible) {
  const symbol    = CURRENCY_SYMBOLS[(currency || 'GBP').toUpperCase()] || (currency + ' ');
  const priceText = price ? `${symbol}${Math.round(price)}` : null;
  const dataPrice = price ? Math.round(price) : 0;
  const style     = SOURCE_STYLES[source] || { logo: null, bg: '#1a6fc4', color: '#fff', abbr: source.slice(0,2).toUpperCase() };

  return `
    <div class="compare-row" data-price="${dataPrice}" data-implausible="${implausible ? '1' : '0'}">
      <div style="flex-shrink:0;width:36px;height:36px;display:flex;align-items:center;justify-content:center;">
        ${buildLogoEl(style)}
      </div>
      <div class="compare-source-name">${source}${MERCHANT_STATUS.badges.includes(MERCHANT_IDS[source]) ? ' <span class="trusted-badge" title="Consistently reliable pricing and availability over 60+ days">✓ Trusted Seller</span>' : ''}</div>
      <div class="compare-right">
        ${priceText
          ? `<div class="compare-from">From</div><div class="compare-price-wrap"><div class="price-label">${priceText}</div></div>`
          : `<div class="compare-price-wrap"><div class="price-label" style="font-size:13px;color:#888;">Check site</div></div>`
        }
        <a href="${goUrl(url, source, price)}" target="_blank" rel="sponsored nofollow noopener noreferrer" class="compare-buy">Get tickets →</a>
      </div>
    </div>
  `;
}

function highlightBestPrice() {
  const rows = document.querySelectorAll('#compare-rows .compare-row');
  if (rows.length === 0) return;

  // Remove any existing badges first (safe to call multiple times)
  document.querySelectorAll('.best-price-badge').forEach(b => b.remove());

  let lowest = Infinity;
  rows.forEach(row => {
    const price = parseFloat(row.dataset.price);
    // Implausible prices (E2 gate) never win the Best price badge
    if (row.dataset.implausible === '1') return;
    if (price > 0 && price < lowest) lowest = price;
  });

  if (lowest === Infinity) return;

  rows.forEach(row => {
    const price = parseFloat(row.dataset.price);
    if (row.dataset.implausible === '1') return;
    if (price === lowest) {
      const badge = document.createElement('span');
      badge.textContent = 'Best price';
      badge.className = 'best-price-badge';
      // Append to price-wrap so badge sits below the price, not inside it
      const wrap = row.querySelector('.compare-price-wrap');
      if (wrap) wrap.appendChild(badge);
      else row.querySelector('.price-label')?.insertAdjacentElement('afterend', badge);
    }
  });
}


// ===========================
// Shared helper
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}


// ===========================
// Phase 1.4B — client copy of the event slug builder
// MUST MATCH the server copies in functions/api/ticketmaster.js,
// sportsevents365.js, awin-events.js, awin-category-cache.js and the
// parser in functions/event/[slug].js. FROZEN v1 — never change without
// migrating every indexed /event/ URL.
// Returns null when no stable slug is possible (missing/invalid date or
// empty name) — callers fall back to the legacy /#/event/ hash route.
// ===========================
function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  var norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}
