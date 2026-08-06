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

    // Parse the raw proxy response into a normalised result.
    // SeatGeek's /2/events never returns a price for us (stats.lowest_price is
    // empty for every event — US and international alike), and its inventory is
    // US-centric, so we only surface it as a "Check site" link for events that
    // are physically IN THE US. We read the country straight off SeatGeek's own
    // matched venue, so no country needs threading from the caller. A price-less
    // US event still shows (bottom-sorted) and earns a click-through; a UK/intl
    // event (e.g. the NFL London game, venue.country "UK") is dropped here.
    normalise(data, eventName, ctx) {
      if (data.error || !data.events?.length) return null;
      const raw = ctx?.raw || eventName;
      const scored = data.events.map(e => {
        const price = e.stats?.lowest_price != null ? Math.round(e.stats.lowest_price) : null;
        const m = {
          name: e.title || e.short_title || '',
          city: e.venue?.city || null,
          date: (e.datetime_local || '').slice(0, 10) || null,
          price
        };
        const tier = matchTrust(raw, m, ctx?.city, ctx?.date).tier;
        return { e, m, price, tier };
      });
      const rank = { price: 0, fallback: 1, drop: 2 };
      scored.sort((a, b) =>
        (rank[a.tier] - rank[b.tier]) || ((a.price ?? Infinity) - (b.price ?? Infinity)));
      const top = scored[0];
      if (!top || top.tier === 'drop') return null;   // nothing corroborates
      // US-only: SeatGeek is US-centric and price-less for us — only worth a
      // click-through when the event itself is in the US.
      if ((top.e.venue?.country || '').toUpperCase() !== 'US') return null;
      return {
        source: 'SeatGeek',
        price: top.price,
        currency: 'GBP',
        url: top.e.url,
        available: true,
        _match: top.m
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

    buildUrl(eventName, venueCity, eventDate, venueName, category) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      if (category)  params.set('cat', category);   // drops wrong-category noise
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

    buildUrl(eventName, venueCity, eventDate, venueName, category) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueCity) params.set('city', venueCity);
      if (category)  params.set('cat', category);   // drops wrong-category noise
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

  // ── Soldout.com — CJ deep link only (no product feed) ───────────────────
  // CJ advertiser link 17268238 (publisher 101816942). Builds a Soldout
  // performer-page URL (/performer/{slug}-tickets) wrapped in the CJ click
  // link — no API price. Renders as "Search Soldout" in the compare table.
  // The /api/soldout endpoint already performer-slugs the name; compare.js
  // additionally passes the performer-stripped name, so tour subtitles are
  // handled. Compare-table only — never added to event LIST fetches.
  {
    source: 'Soldout',

    buildUrl(eventName, venueCity, eventDate, venueName, category) {
      // Soldout lists UK football clubs as "{Name} FC" (arsenal-fc-tickets),
      // but concerts/theatre/foreign clubs keep their plain name. Pass the
      // category so the endpoint can append 'fc' only for football.
      const catParam = category === 'football' ? '&cat=football' : '';
      return `/api/soldout?q=${encodeURIComponent(eventName)}${catParam}`;
    },

    normalise(data, eventName, ctx) {
      // US-only: Soldout is a US ticket site, so only surface its click-through
      // when the event is in the US. Soldout has no match data of its own, so
      // it relies on the event country passed from the caller; unknown country
      // is treated as non-US (suppressed) since TicketScout traffic is UK-first.
      if ((ctx?.country || '').toUpperCase() !== 'US') return null;
      const match = data?.match;
      if (!match || !match.url) return null;
      return {
        source:     'Soldout',
        price:      null,           // deep link only — no price
        currency:   'GBP',
        url:        match.url,
        available:  true,
        isFallback: true            // renders as "Search Soldout" not a price
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

// Festival/series prefix detection for extractPerformerName. High-precision:
// a 4-digit year in the prefix, or a strong festival/series keyword. Kept
// deliberately small — a miss just yields the current behaviour, and a false
// positive is caught downstream by the trust gate.
function looksLikeFestivalPrefix(s) {
  const t = ' ' + (s || '').toLowerCase() + ' ';
  if (/\b(19|20)\d{2}\b/.test(t)) return true;
  return /\b(festival|sessions|presents|weekender|fringe|proms|all points east|british summer time|summer series|winter series)\b/.test(t);
}
// The suffix after a festival prefix should be an act, not a day/ticket/round
// label — otherwise keep the festival name (it's the sellable entity).
function looksLikePerformerSuffix(s) {
  const t = (s || '').toLowerCase().trim();
  if (!t) return false;
  return !/^(day\s*\d|day\s+(one|two|three|four|five)|saturday|sunday|friday|monday|tuesday|wednesday|thursday|weekend|vip|ga\b|general admission|parking|hospitality|camping|final|semi[\s-]?final|quarter[\s-]?final|round\b|group\s|ceremony|heat\b|qualifier|practice|session\b|early entry|add[\s-]?on)/i.test(t);
}

// When a colon-less fixture name still carries a series/league prefix (e.g.
// TM sometimes returns "Nfl London 2026 Houston Texans v Jacksonville
// Jaguars" with no colon at all — a title-cased de-slugified name, or a
// reissued TM title), the general vs-extraction below greedily captures the
// WHOLE prefix as the "home team" ("Nfl London 2026 Houston Texans"),
// sending every affiliate a query no seller can match. A 4-digit year
// followed by real text marks where a series/edition prefix ends and the
// actual team/act name begins, so cut there. No-op when there's no year.
function stripSeriesYearPrefix(text) {
  const m = text.match(/\b(19|20)\d{2}\b\s+(.+)$/);
  return (m && m[2].trim()) ? m[2].trim() : text;
}

function extractPerformerName(fullName) {
  if (!fullName) return '';
  // Strip subtitle after colon (e.g. "Metallica: Life Burns Faster" -> "Metallica")
  const colonIdx = fullName.indexOf(':');
  if (colonIdx > 0) {
    // A fixture can sit AFTER a series/venue prefix, e.g.
    // "NFL London 2026: Houston Texans v Jacksonville Jaguars" — there the
    // fixture IS the event, so parse the home team from the part after the
    // colon rather than searching sellers for the prefix "NFL London 2026".
    // Only triggers when the after-part is itself a vs/v fixture, so
    // "Metallica: Life Burns Faster" is unaffected.
    const after   = fullName.slice(colonIdx + 1).trim();
    const afterVs = after.match(/^(.+?)\s+vs?\.?\s+.+$/i);
    if (afterVs) return afterVs[1].trim();
    // Festival/series prefix — "Southampton Summer Sessions: Bowling For Soup"
    // → the sellable act is AFTER the colon, not before. Only flip when the
    // prefix clearly reads as a festival/series (keyword or year) AND the
    // suffix reads as a performer (not a day/ticket/round label). Conservative
    // by design: a wrong flip only mis-queries, and the trust gate catches any
    // resulting mismatch — but "Metallica: M72 Tour" etc. are left untouched.
    const before = fullName.slice(0, colonIdx).trim();
    if (looksLikeFestivalPrefix(before) && looksLikePerformerSuffix(after)) {
      return after;
    }
    return before;
  }
  // Strip " vs " / " vs. " / " v " — football match names (keep home team only)
  // e.g. "FC Bayern Munich vs. RB Leipzig" -> "FC Bayern Munich"
  // e.g. "Real Madrid CF vs Real Sociedad" -> "Real Madrid CF"
  const vsMatch = fullName.match(/^(.+?)\s+vs?\.?\s+.+$/i);
  if (vsMatch) return stripSeriesYearPrefix(vsMatch[1].trim());
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
  'TicketNetwork': 'ticketnetwork', 'Eventim': 'eventim_uk', 'Eventim PL': 'eventim_pl',
  'Soldout': 'soldout'
};

// Route outbound affiliate links through /api/go for attribution, the
// merchant kill-switch, and analytics. FAIL-SAFE: only hosts on this list
// are wrapped — an unrecognised domain keeps its direct link (exactly
// today's behaviour, just without attribution) so a whitelist gap can
// never bounce a paying customer to the homepage. Must stay a subset of
// ALLOWED_HOSTS in functions/api/go.js. Unrecognised affiliate domains
// are console.warned — add them to BOTH lists when spotted.
const GO_HOSTS = [
  'ticketmaster.co.uk', 'ticketmaster.com', 'gigsberg.com', 'sportsevents365.com', 'ticombo.com',
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
// { suspended: [ids], badges: [ids], scores: {id: 0..1}, typicalRows: {cat: n} }
// Promise-cached (6 Aug 2026, same pattern as loadFxRates below) — now
// called TWICE per render: once early by renderComparePrices() to size the
// initial skeleton, once again inside comparePrices() as before. Without
// caching that's a duplicate network round-trip for no reason; the second
// call now just returns the same in-flight/resolved promise.
let MERCHANT_STATUS = { suspended: [], badges: [], scores: {}, typicalRows: {} };
let merchantStatusPromise = null;
function loadMerchantStatus() {
  if (merchantStatusPromise) return merchantStatusPromise;
  merchantStatusPromise = (async () => {
    try {
      const r = await fetch('/api/merchant-status');
      if (r.ok) MERCHANT_STATUS = await r.json();
    } catch { /* keep defaults */ }
    return MERCHANT_STATUS;
  })();
  return merchantStatusPromise;
}

async function comparePrices(eventName, venueCity, eventDate, venueName, category, country) {
  // Use performer name (stripped of subtitles) for adapter searches
  const performerName = extractPerformerName(eventName);

  // ── Diagnostic instrument (read-only, opt-in) ────────────────────────────
  // Enabled by ?cmpdebug=1 in the query string OR the hash fragment (the
  // hash route carries params after the event id). When on, every adapter's
  // sent query and returned match are captured into window.__CMP_DEBUG__ and
  // rendered as a panel, so cross-affiliate mismatches are visible in one
  // place without touching any matching logic. No effect on normal renders.
  const CMP_DEBUG = /[?&]cmpdebug=1/.test(location.search + location.hash);
  const dbgRecords = [];
  if (CMP_DEBUG) {
    window.__CMP_DEBUG__ = {
      rawEventName: eventName,
      performerNameSent: performerName,
      venueCity: venueCity || null,
      eventDate: eventDate || null,
      venueName: venueName || null,
      category: category || null,
      adapters: dbgRecords
    };
  }

  // Phase 6.3: skip suspended merchants entirely; count adapter attempts
  // (site-wide denominator for the reliability score)
  await loadMerchantStatus();
  const activeAdapters = ADAPTERS.filter(a =>
    !MERCHANT_STATUS.suspended.includes(MERCHANT_IDS[a.source]));
  signalBeacon('req&n=' + activeAdapters.length);

  const settled = await Promise.allSettled(
    activeAdapters.map(async adapter => {
      // Diagnostic record — pushed synchronously and in adapter order so
      // dbgRecords[i] lines up with activeAdapters[i] for the rejected sweep.
      const dbg = CMP_DEBUG
        ? { source: adapter.source, qSent: performerName, url: null,
            outcome: 'pending', matchName: null, matchPrice: null,
            matchDate: null, matchCity: null, isFallback: null, note: null }
        : null;
      if (dbg) dbgRecords.push(dbg);

      // Pass performerName for search queries, but keep full eventName for normalise matching.
      // category (optional) lets an adapter tailor its URL — e.g. Soldout appends
      // 'fc' for UK football clubs. Undefined for callers that don't supply it.
      const url = adapter.buildUrl(performerName, venueCity, eventDate, venueName, category);
      if (dbg) dbg.url = url;

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
          if (dbg) { dbg.outcome = 'non-json'; dbg.note = response.status + ' ' + ct; }
          return null;
        }
        data = await response.json().catch(e => {
          console.warn('[compare]', adapter.source, 'JSON parse error:', e);
          signalBeacon('err&s=' + encodeURIComponent(adapter.source));
          if (dbg) { dbg.outcome = 'json-error'; dbg.note = String(e); }
          return null;
        });
      }
      if (!data) return null;
      // Capture the raw match the server/adapter returned BEFORE normalise, so
      // we can see a server-side fallback even when normalise later drops it.
      if (dbg && data && data.match) {
        dbg.matchName  = data.match.name  ?? null;
        dbg.matchPrice = data.match.price ?? null;
        dbg.matchDate  = data.match.date  ?? null;
        dbg.matchCity  = data.match.city  ?? null;
        dbg.isFallback = data.match.isFallback === true;
      }
      const result = await adapter.normalise(data, performerName, { raw: eventName, city: venueCity, date: eventDate, country: country });
      // result is null if adapter found no match

      // Central match-trust classification — runs on the raw match every
      // adapter returns. Adapters whose payload isn't the {match} shape can
      // instead attach result._match {name,city,date} so they get validated
      // too (e.g. SeatGeek). 'drop' hides a wrong-event match; 'fallback'
      // keeps the seller as a "Check site" link but strips an unconfirmed
      // price; 'price' shows it. Single-object results only (array results are
      // best-per-merchant with their own dedup). Skips adapter-native fallbacks.
      const rawMatch = (data && data.match) || (result && result._match) || null;
      if (dbg && rawMatch) {
        dbg.matchName  = dbg.matchName  ?? (rawMatch.name  ?? null);
        dbg.matchDate  = dbg.matchDate  ?? (rawMatch.date  ?? null);
        dbg.matchCity  = dbg.matchCity  ?? (rawMatch.city  ?? null);
      }
      if (result && !Array.isArray(result) && !result.isFallback && eventName && rawMatch) {
        const trust = matchTrust(eventName, rawMatch, venueCity, eventDate);
        if (trust.tier === 'drop') {
          signalBeacon('trustdrop&s=' + encodeURIComponent(adapter.source));
          if (dbg) { dbg.outcome = 'rejected'; dbg.note = trust.reason; }
          return null;
        }
        if (trust.tier === 'fallback') {
          // Right entity, unconfirmed price → surface as a click-through only.
          result.price = null;
          result.isFallback = true;
          if (dbg) { dbg.outcome = 'demoted-fallback'; dbg.note = trust.reason; dbg.matchPrice = null; }
        }
      }

      if (dbg && dbg.outcome === 'pending') {
        if (result == null) {
          dbg.outcome = 'no-match';
        } else if (Array.isArray(result)) {
          dbg.outcome = 'matched(' + result.length + ')';
          const r0 = result[0] || {};
          dbg.matchName  = dbg.matchName  ?? (r0.name  ?? null);
          dbg.matchPrice = dbg.matchPrice ?? (r0.price ?? null);
        } else {
          dbg.outcome    = dbg.isFallback ? 'fallback-link' : 'matched';
          dbg.matchName  = dbg.matchName  ?? (result.name  ?? null);
          dbg.matchPrice = dbg.matchPrice ?? (result.price ?? null);
        }
      }
      return result;
    })
  );

  // Network-level adapter failures (rejected promises) → error beacon
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[compare]', activeAdapters[i].source, 'adapter failed:', r.reason);
      signalBeacon('err&s=' + encodeURIComponent(activeAdapters[i].source));
      if (CMP_DEBUG && dbgRecords[i]) {
        dbgRecords[i].outcome = 'threw';
        dbgRecords[i].note = String(r.reason);
      }
    }
  });

  if (CMP_DEBUG) renderCmpDebugPanel();

  return settled
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    // Adapters may return a single result OR an array (e.g. awin best-per-merchant)
    .flatMap(r => Array.isArray(r.value) ? r.value : [r.value]);
}

// Render the ?cmpdebug=1 panel. Read-only; shows what every affiliate was
// sent and what it returned, so a shared mangled query (extractPerformerName)
// or a per-adapter fallback stands out at a glance. Also logs a console table.
function renderCmpDebugPanel() {
  const d = window.__CMP_DEBUG__;
  if (!d) return;
  try { console.table(d.adapters); } catch {}
  document.getElementById('cmp-debug-panel')?.remove();
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = d.adapters.map(a => {
    const flag = (a.outcome === 'fallback-link' || a.outcome === 'no-match'
      || a.outcome === 'threw' || a.outcome === 'non-json' || a.outcome === 'json-error');
    return '<tr style="color:' + (flag ? '#b00' : '#060') + '">'
      + '<td>' + esc(a.source) + '</td>'
      + '<td><b>' + esc(a.outcome) + '</b></td>'
      + '<td>' + esc(a.qSent) + '</td>'
      + '<td>' + esc(a.matchName) + '</td>'
      + '<td>' + (a.matchPrice == null ? '—' : esc(a.matchPrice)) + '</td>'
      + '<td>' + esc(a.matchDate) + '</td>'
      + '<td>' + esc(a.matchCity) + '</td>'
      + '<td>' + esc(a.note) + '</td></tr>';
  }).join('');
  const panel = document.createElement('div');
  panel.id = 'cmp-debug-panel';
  panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;'
    + 'max-height:46vh;overflow:auto;background:#fff;border:2px solid #333;'
    + 'border-radius:8px;padding:10px 12px;font:12px/1.4 monospace;'
    + 'box-shadow:0 4px 24px rgba(0,0,0,.35)';
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    + '<b>cmpdebug</b> — raw: "' + esc(d.rawEventName) + '" → q sent: "' + esc(d.performerNameSent)
    + '" · city:' + esc(d.venueCity) + ' · date:' + esc(d.eventDate) + ' · cat:' + esc(d.category)
    + '<button onclick="this.closest(\'#cmp-debug-panel\').remove()" '
    + 'style="margin-left:8px;cursor:pointer">×</button></div>'
    + '<table style="border-collapse:collapse;width:100%">'
    + '<thead><tr style="text-align:left;border-bottom:1px solid #ccc">'
    + '<th>source</th><th>outcome</th><th>q sent</th><th>match name</th>'
    + '<th>price</th><th>date</th><th>city</th><th>note</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
  document.body.appendChild(panel);
}


// ===========================
// Renderer — builds the comparison block on the event detail page
// Called from events.js with the Ticketmaster price already in hand
// (TM data comes from the event detail fetch, not a separate adapter call)
// ===========================

async function renderComparePrices(container, eventName, tmPrice, tmUrl, venueCity, eventDate, venueName, category, country) {
  if (!container) return;

  // CLS fix (6 Aug 2026): await merchant-status BEFORE the first paint, not
  // after, so the initial skeleton can be sized close to the real eventual
  // row count via MERCHANT_STATUS.typicalRows (nightly-computed per
  // category — see price-rollup.js and go.js's 'rows' beacon). This is a
  // genuine architecture change, not a bigger guess: two earlier CLS fixes
  // (Session 16, 280px then 450px) both tried a single FIXED height and
  // both measurably failed live PageSpeed re-tests on a high-seller-count
  // event, because "how tall should the loading state be" isn't one
  // number — it depends on category and current source coverage, and both
  // drift over time. Trading a few ms of first paint (this endpoint is
  // edge-cached 5 min, so typically a warm/fast hit) for a skeleton that's
  // actually the right shape is what moves CLS; a skeleton that's wrong
  // then corrects itself before real rows arrive would cause TWO shifts,
  // not fewer.
  await loadMerchantStatus();
  const FALLBACK_SKELETON_ROWS = 4; // used only before any beacon data exists for this category (day one, or right after the D1 migration)
  const skeletonRowCount = Math.max(2, Math.min(8,
    MERCHANT_STATUS.typicalRows?.[category] || FALLBACK_SKELETON_ROWS));

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
        .compare-block { font-family:'Inter','Helvetica Neue',Arial,sans-serif; box-sizing:border-box; overflow-x:auto; }
        /* Real-table rewrite (6 Aug 2026): replaces the flexbox-div markup +
           role="table"/"row"/"cell" ARIA stopgap from 1 Aug. Screen readers
           and AI agents now get genuine table semantics from the DOM itself
           instead of a bolted-on accessibility-tree signal, and rows behave
           correctly under user zoom/reflow the way real tables do. Layout is
           unchanged visually: <col> widths reproduce the old flex
           proportions (fixed logo column, flexible name column,
           shrink-to-content price/CTA column via the standard width:1%
           trick), and the price+CTA cluster keeps its own internal flex
           layout — that is presentation WITHIN a cell, not an override of
           row/cell display types, so it carries no accessibility risk. All
           existing class names (.compare-row, .compare-source-name,
           .compare-price-wrap, etc.) are unchanged, so highlightBestPrice()
           needed zero JS changes — verified it only ever calls
           querySelector/dataset on the row element itself, which behaves
           identically on a <tr> as it did on a <div>. NEEDS A LIVE VISUAL
           CHECK on a real event page (desktop + both mobile breakpoints
           below) before treating this as fully done — table auto-layout
           column sizing can behave slightly differently across browsers
           than flexbox did.
        */
        #compare-rows { width:100%; border-collapse:collapse; }
        .compare-row { border-bottom:1px solid #f0f0f0; }
        .compare-row:last-child { border-bottom:none; }
        .compare-row td, .compare-row th { padding:12px 20px; vertical-align:middle; text-align:left; font-weight:normal; }
        .compare-logo-cell { width:36px; }
        .compare-source-logo { width:36px; height:36px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; flex-shrink:0; }
        .compare-source-name { font-size:14px; font-weight:600; color:#1a1a1a; }
        .compare-right-inner { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; row-gap:6px; }
        /* A11y fix (1 Aug 2026): #888 measured 3.54:1 against white — fails
           WCAG AA's 4.5:1 minimum, confirmed via live PageSpeed Insights.
           #666 (5.74:1) passes comfortably and is the SAME shade already
           used, un-flagged, for equivalent secondary text elsewhere on this
           site (e.g. the price-history widget's ".ts-ph-low"). */
        .compare-from { font-size:11px; color:#666; white-space:nowrap; width:28px; text-align:right; flex-shrink:0; }
        .compare-price-wrap { display:flex; flex-direction:column; align-items:flex-end; min-width:64px; }
        .price-label { font-size:17px; font-weight:700; color:#1a1a1a; white-space:nowrap; }
        .compare-buy { background:#1a6fc4; color:#fff; padding:9px 16px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; flex-shrink:0; margin-left:4px; }
        .compare-buy:hover { background:#155da0; }
        /* A11y fix (1 Aug 2026): white text on #22c55e measured 2.28:1 —
           fails WCAG AA badly (needs 4.5:1), confirmed via live PageSpeed
           Insights. #15803d gives 5.02:1 with white text, comfortably
           passing, while staying recognisably "success green". */
        .best-price-badge { display:block; background:#15803d; color:#fff; font-size:10px; font-weight:700; padding:2px 7px; border-radius:10px; text-align:center; margin-top:2px; }
        .trusted-badge { display:inline-block; color:#16a34a; font-size:10px; font-weight:600; margin-left:6px; white-space:nowrap; }
        /* A11y fix (2 Aug 2026): #888 measured 3.54:1 against white — fails
           WCAG AA's 4.5:1 minimum. #666 (5.74:1) passes and is the SAME
           shade already used for .compare-from above. */
        .compare-loading { padding:20px; text-align:center; color:#666; font-size:14px; }
        /* Skeleton loading rows (CLS fix, 6 Aug 2026) — reuse .compare-row
           so height/padding is IDENTICAL to a real row by construction,
           which is what actually matters for CLS: zero mismatch between
           the loading state's box model and the real content's. Only the
           cell CONTENTS differ (shimmer blocks vs real text/logo/button). */
        .skeleton-block { background:#eee; border-radius:4px; display:inline-block; position:relative; overflow:hidden; }
        .skeleton-block::after {
          content:''; position:absolute; inset:0; transform:translateX(-100%);
          background:linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
          animation:compare-skeleton-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes compare-skeleton-shimmer { 100% { transform:translateX(100%); } }
        @media (prefers-reduced-motion: reduce) { .skeleton-block::after { animation:none; } }
        .skeleton-logo { width:36px; height:36px; border-radius:6px; }
        .skeleton-name { width:55%; height:14px; }
        .skeleton-price { width:48px; height:17px; }
        .skeleton-button { width:92px; height:34px; border-radius:6px; }
        /* A11y fix (2 Aug 2026): #999 measured 2.85:1 against .compare-block's
           white background — fails WCAG AA badly (same failure, same 2.85:1,
           as the shared footer disclaimer already fixed elsewhere this
           session). #666 (5.74:1) passes and matches the established shade. */
        .compare-footnote { font-size:11px; color:#666; text-align:center; padding:12px 20px 4px; line-height:1.5; }
        .compare-title { font-size:14px; font-weight:600; color:#1a1a1a; padding:14px 20px 10px; border-bottom:1px solid #f0f0f0; }
        @media(max-width:560px) {
          .compare-row td, .compare-row th { padding:11px 14px; }
          .compare-right-inner { gap:8px; }
          .compare-source-name { font-size:13px; }
          .compare-from { font-size:10px; width:24px; }
          .price-label { font-size:15px; min-width:52px; }
          .compare-buy { padding:8px 11px; font-size:12px; }
        }
        @media(max-width:400px) {
          .compare-row td, .compare-row th { padding:10px 12px; }
          .compare-right-inner { gap:6px; }
          .compare-from { display:none; }
          .price-label { font-size:14px; min-width:48px; }
          .compare-buy { padding:7px 9px; font-size:11px; }
        }
      </style>
      <table id="compare-rows" aria-label="Ticket price comparison across sellers" aria-busy="true">
        <colgroup>
          <col style="width:56px">
          <col>
          <col style="width:1%">
        </colgroup>
        <tbody id="adapter-prices">
          ${buildSkeletonRows(skeletonRowCount)}
        </tbody>
      </table>
      <div class="compare-footnote">Prices shown are the lowest available and may exclude booking fees. Ticketmaster and SportsEvents365 prices are live; other sellers' prices are refreshed several times a day. Resale prices may differ from face value. Always confirm the final price on the seller's site before purchasing.</div>
    </div>
  `;

  // Kick off the FX rate fetch in parallel with the adapter calls so it's
  // ready by the time results arrive (falls back silently if it fails).
  loadFxRates();

  comparePrices(eventName, venueCity, eventDate, venueName, category, country).then(async results => {
    const slot = document.getElementById('adapter-prices');
    if (!slot) return;

    // Ensure live rates are loaded before normalising (no-op if already done).
    await loadFxRates();

    // TM display rules (unchanged in effect, just applied by MERGING it into
    // the same sortable array everyone else uses, instead of always printing
    // it first regardless of price):
    //   1. No other seller found a price → include TM even without a price
    //      (sole coverage; it'll sit among the no-price rows like everyone else)
    //   2. Other sellers found prices AND TM has a price → include it, sorted
    //      into its correct position by price like any other seller
    //   3. Other sellers found prices AND TM has no price → omit it entirely
    //      (no commission + no value)
    // Previously TM was always inserted first in the DOM regardless of price,
    // which is why a £50 Ticketmaster row could sit above a £32 "Best price"
    // Ticombo row — the badge was computed correctly, but TM's POSITION never
    // participated in the sort.
    const otherHavePrices = results.some(r => r.price);
    if (tmUrl && tmUrl !== '#' && (tmPrice || !otherHavePrices)) {
      results.push({
        source: 'Ticketmaster', price: tmPrice || null, currency: 'GBP',
        url: tmUrl, available: true, isFallback: !tmPrice
      });
    }

    // ── Currency normalisation → GBP ────────────────────────────────────
    // Sellers report in their own currency (VS/TN in USD, Ticombo in EUR,
    // etc.). Comparing raw numbers made a cheap $67 look dearer than €177
    // and even tripped the plausibility gate. Convert every price to GBP up
    // front so sort, the E2 gate, the Best Price badge and the display all
    // operate on one currency. (Static rates — refreshed manually for now;
    // when we internationalise, this is the single hook to swap the base
    // currency and plug in live rates + geo-detected display currency.)
    results.forEach(r => {
      if (r.price) {
        const gbp = toGbp(r.price, r.currency);
        r.price = gbp;
        r.currency = 'GBP';
      }
    });

    // Keep every available seller, with or without a price — a price-less row
    // renders as a "Check site" click-through (still earns commission and is
    // honest when we can't confirm the exact price). Previously a hardcoded
    // source allowlist silently dropped price-less rows from other sellers
    // (e.g. a correct SportsEvents365 match with no price).
    const withPrices = results
      .filter(r => r.available)
      .sort((a, b) => {
        // Sort by price ascending (best/lowest first)
        // Items without price go to the bottom
        if (!a.price && !b.price) {
          // Among the price-less "Check site" rows, SeatGeek sinks last —
          // its inventory is mostly US, so a UK visitor sees the more
          // relevant sellers' fallback links first.
          const aSG = a.source === 'SeatGeek' ? 1 : 0;
          const bSG = b.source === 'SeatGeek' ? 1 : 0;
          return aSG - bSG;
        }
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
    withPrices.forEach(result => {
      slot.insertAdjacentHTML('beforeend', buildRow(result.source, result.price, result.url, result.currency, result.implausible));
    });
    document.getElementById('compare-rows')?.removeAttribute('aria-busy');

    // CLS fix data collection (6 Aug 2026) — one signal per successful
    // render, recording the REAL final row count for this category. See
    // go.js's beacon handler and price-rollup.js's nightly aggregation;
    // this is what teaches the skeleton (above) how many rows to show next
    // time. Fires after the count is fully final (post dedup + plausibility
    // gate), not before.
    signalBeacon('rows&n=' + withPrices.length + '&cat=' + encodeURIComponent(category || 'unknown'));

    highlightBestPrice();
  });
}

// Skeleton loading rows (CLS fix, 6 Aug 2026) — see renderComparePrices()'s
// skeletonRowCount and the .skeleton-block CSS above. Deliberately reuses
// .compare-row so height/padding matches a real row exactly; aria-hidden
// since these carry no real information (the table's aria-busy="true"
// already tells assistive tech this region is loading).
function buildSkeletonRows(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `
      <tr class="compare-row" aria-hidden="true">
        <td class="compare-logo-cell"><div class="skeleton-block skeleton-logo"></div></td>
        <td><div class="skeleton-block skeleton-name"></div></td>
        <td>
          <div class="compare-right-inner">
            <div class="skeleton-block skeleton-price"></div>
            <div class="skeleton-block skeleton-button"></div>
          </div>
        </td>
      </tr>`;
  }
  return out;
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
  'Soldout':               { logo: fav('soldout.com'),                 bg: '#1a2b49', color: '#fff', abbr: 'SO' },
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

// ── Currency → GBP conversion ─────────────────────────────────────────────
// Rates are "units of currency per 1 GBP". Live rates come from /api/fx
// (ECB via Frankfurter, lazily refreshed daily, KV-cached). The hardcoded
// table below is the fallback used before the first fetch resolves or if the
// endpoint is unavailable — the comparison never breaks on a rates failure.
// These only affect ranking/badge/display, never what the seller charges
// (the affiliate link goes to the seller's own checkout in their currency).
let FX_PER_GBP = { GBP: 1, USD: 1.27, EUR: 1.17, PLN: 5.0, CHF: 1.12, CAD: 1.73, AUD: 1.93, SGD: 1.71 };
let fxPromise = null;

// Fetch live rates once per page load; merge over the fallback so any missing
// symbol keeps its fallback value. Returns the same in-flight promise on
// repeated calls so callers can await the actual fetch completing.
function loadFxRates() {
  if (fxPromise) return fxPromise;
  fxPromise = (async () => {
    try {
      const resp = await fetch('/api/fx');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.rates && data.rates.GBP === 1) {
        FX_PER_GBP = { ...FX_PER_GBP, ...data.rates };
      }
    } catch { /* keep fallback rates */ }
  })();
  return fxPromise;
}

function toGbp(amount, currency) {
  const cur = (currency || 'GBP').toUpperCase();
  const rate = FX_PER_GBP[cur];
  if (!rate || !amount) return Math.round(amount || 0);   // unknown currency → leave as-is
  return Math.round(amount / rate);
}



function buildRow(source, price, url, currency, implausible) {
  const symbol    = CURRENCY_SYMBOLS[(currency || 'GBP').toUpperCase()] || (currency + ' ');
  const priceText = price ? `${symbol}${Math.round(price)}` : null;
  const dataPrice = price ? Math.round(price) : 0;
  const style     = SOURCE_STYLES[source] || { logo: null, bg: '#1a6fc4', color: '#fff', abbr: source.slice(0,2).toUpperCase() };
  // Real-table rewrite (6 Aug 2026): row is now a <tr> with a logo <td>, a
  // name <th scope="row"> (a row header is semantically a <th>, not a <td>
  // — this is more correct than the old role="rowheader" div, not just a
  // like-for-like swap), and a price+CTA <td> whose internal cluster keeps
  // its own flex layout. data-price/data-implausible stay on the <tr> itself
  // — highlightBestPrice() reads them via row.dataset, unchanged.
  const ctaLabel = `Get tickets from ${source}${priceText ? ` — ${priceText}` : ''}`;

  return `
    <tr class="compare-row" data-price="${dataPrice}" data-implausible="${implausible ? '1' : '0'}">
      <td class="compare-logo-cell">
        ${buildLogoEl(style)}
      </td>
      <th class="compare-source-name" scope="row">${source}${MERCHANT_STATUS.badges.includes(MERCHANT_IDS[source]) ? ' <span class="trusted-badge" title="Consistently reliable pricing and availability over 60+ days">✓ Trusted Seller</span>' : ''}</th>
      <td>
        <div class="compare-right-inner">
          ${priceText
            ? `<div class="compare-from">From</div><div class="compare-price-wrap"><div class="price-label">${priceText}</div></div>`
            : `<div class="compare-price-wrap"><div class="price-label" style="font-size:13px;color:#666;">Check site</div></div>`
          }
          <a href="${goUrl(url, source, price)}" target="_blank" rel="sponsored nofollow noopener noreferrer" class="compare-buy" aria-label="${ctaLabel}">Get tickets →</a>
        </div>
      </td>
    </tr>
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

// ── Match trust engine (all adapters) ──────────────────────────────────────
// Adapters score candidates with a loose substring/every-word name match and
// treat city only as a ranking BOOST, so two failure modes leak through:
//   • wrong matches — "Sting" hits "Willmar Stingers"/"...Wine Tasting";
//     "Lincoln City" hits "Lincoln Stars vs Sioux City Musketeers" (both
//     tokens scattered across two US teams, same-name city passes the geo
//     boost). These show a MISLEADING PRICE for a different event.
//   • no fallback — a correct match with no price is dropped instead of shown
//     as a "Check site" link.
// This engine runs once, centrally, on the raw match every adapter returns and
// classifies it into one of three tiers:
//   'price'    — name corroborates AND city/date don't contradict → show price
//   'fallback' — right entity but unconfirmed price (no price, or a different
//                occurrence: date far off / seller titled by home club only
//                without city+date backup) → show a "Check site" link, no price
//   'drop'     — the match names a DIFFERENT event entirely → hide it
// Matching is PHRASE-based (whole-word bounded), not substring, and a fixture
// requires BOTH teams (or the home team + corroborating city & date). FAIL-OPEN
// on missing data: a match is only ever demoted/dropped on positive evidence.
const PRICE_DATE_WINDOW = 4;               // days; wider ⇒ 'fallback', not a lie
const NAME_STOPWORDS = new Set(['fc','afc','cf','sc','ac','the','vs','v','at','and','de']);

function normPhrase(str) {
  return ' ' + (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}
// Whole-word-bounded phrase presence: " sting " is NOT in " willmar stingers ".
function phrasePresent(haystackPadded, needle) {
  const nRaw = normPhrase(needle);
  const sig = nRaw.trim().split(' ').filter(t => t && !NAME_STOPWORDS.has(t));
  if (!sig.length) return false;
  return haystackPadded.includes(' ' + sig.join(' ') + ' ');
}
function isoDayDiff(a, b) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(a || '') || !/^\d{4}-\d{2}-\d{2}/.test(b || '')) return null;
  const ta = new Date(String(a).slice(0, 10)).getTime(), tb = new Date(String(b).slice(0, 10)).getTime();
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.abs(ta - tb) / 86400000;
}
function citiesContradict(a, b) {
  const x = normPhrase(a).trim(), y = normPhrase(b).trim();
  if (!x || !y) return false;                          // fail-open on missing
  return !((' '+x+' ').includes(' '+y+' ') || (' '+y+' ').includes(' '+x+' '));
}
function citiesAgree(a, b) {
  const x = normPhrase(a).trim(), y = normPhrase(b).trim();
  if (!x || !y) return false;
  return (' '+x+' ').includes(' '+y+' ') || (' '+y+' ').includes(' '+x+' ');
}
// Split a raw event title into home/away phrases if it is a fixture, else null.
// Handles a series prefix before a colon, e.g.
// "NFL London 2026: Houston Texans v Jacksonville Jaguars".
function parseFixtureSides(rawName) {
  if (!rawName) return null;
  let s = rawName;
  const c = s.indexOf(':');
  if (c > 0 && /\s+vs?\.?\s+/i.test(s.slice(c + 1))) s = s.slice(c + 1);
  const m = s.match(/^(.+?)\s+vs?\.?\s+(.+)$/i);
  if (!m) return null;
  return { home: m[1].trim(), away: m[2].trim() };
}
// Performer phrase for non-fixture titles (reuses the same subtitle stripping).
function performerPhrase(rawName) {
  return extractPerformerName(rawName);
}
// Classify a raw match against the event the user is comparing.
// Returns { tier:'price'|'fallback'|'drop', reason }.
function matchTrust(rawEventName, m, queryCity, queryDate) {
  if (!m || !m.name) return { tier: 'drop', reason: 'no match name' };
  if (m.isFallback) return { tier: 'fallback', reason: 'adapter fallback' };
  const hay = normPhrase(m.name);
  const priced = m.price != null && m.price !== '';
  const dGap = isoDayDiff(m.date, queryDate);
  const dateFar = dGap != null && dGap > PRICE_DATE_WINDOW;

  const sides = parseFixtureSides(rawEventName);
  if (sides) {
    const homeOK = phrasePresent(hay, sides.home);
    const awayOK = phrasePresent(hay, sides.away);
    if (!homeOK && !awayOK) return { tier: 'drop', reason: 'neither team named ("' + m.name + '")' };
    if (citiesContradict(m.city, queryCity))
      return { tier: 'drop', reason: 'wrong city ' + m.city + ' \u2260 ' + queryCity + ' ("' + m.name + '")' };
    const bothTeams = homeOK && awayOK;
    if (!priced) return { tier: 'fallback', reason: 'no price' };
    if (dateFar)  return { tier: 'fallback', reason: 'date ' + String(m.date).slice(0,10) + ' \u2260 ' + queryDate };
    if (bothTeams) return { tier: 'price', reason: 'both teams + ok' };
    // Only one team named — trust the price only if city AND date corroborate.
    if (citiesAgree(m.city, queryCity) && dGap != null && dGap <= PRICE_DATE_WINDOW)
      return { tier: 'price', reason: 'one team + city/date ok' };
    return { tier: 'fallback', reason: 'only one team named, weak corroboration' };
  }

  // Non-fixture (concert/show): the performer must be named as whole words.
  if (!phrasePresent(hay, performerPhrase(rawEventName)))
    return { tier: 'drop', reason: 'performer not named ("' + m.name + '")' };
  if (citiesContradict(m.city, queryCity))
    return { tier: 'drop', reason: 'wrong city ' + m.city + ' \u2260 ' + queryCity + ' ("' + m.name + '")' };
  if (!priced) return { tier: 'fallback', reason: 'no price' };
  if (dateFar)  return { tier: 'fallback', reason: 'different date ' + String(m.date).slice(0,10) + ' \u2260 ' + queryDate };
  return { tier: 'price', reason: 'performer + ok' };
}

// ===========================
// H6 (2 Aug 2026) — client-side twin of the server-side
// normaliseFixtureName() in ticketmaster.js/sportsevents365.js/
// awin-events.js/awin-category-cache.js. !! MUST MATCH !! those four
// copies exactly (plus the identical copies now in concert.html,
// football.html, theatre.html, sports.html, venue.html).
// Global on purpose — events.js (homepage event cards) calls this global
// function the same way it already calls the global tsEventSlug() below,
// via a defensive `typeof` check, since not every page that includes
// events.js also includes this file.
// ===========================
function normaliseFixtureName(name) {
  var n = String(name || '');
  var COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (var i = 0; i < COMPETITION_PREFIXES.length; i++) {
    var p = COMPETITION_PREFIXES[i];
    var re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');
  var stripSuffix = function (side) {
    return side
      .replace(/\./g, '')
      .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
      .trim();
  };
  var parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    var sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort(function (a, b) { return a.localeCompare(b); });
    n = sides[0] + ' vs ' + sides[1];
  }
  return n.trim();
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
