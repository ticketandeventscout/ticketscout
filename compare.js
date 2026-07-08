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
      return `/api/awin-category?${params.toString()}`;
    },

    normalise(data, eventName) {
      // awin-category returns { matches: [...] } or { matches: [] }
      const matches = data?.matches || [];
      if (!matches.length) return null;
      const best = matches[0]; // already ranked best match
      if (!best.url) return null;
      return {
        source:    best.merchant_name || 'Gigsberg',
        price:     best.price ? Math.round(best.price) : null,
        currency:  best.currency || 'GBP',
        url:       best.url,
        available: true
      };
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
      if (!match.url) return null;

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
      return `/api/vividseats?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.match || !data.match.url) return null;
      const match = data.match;
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

  // ── Future adapters go here ──────────────────────────────────────────────
  //
  // {
  //   source: 'viagogo',
  //   buildUrl(eventName, venueCity) { ... },
  //   normalise(data, eventName) { ... }
  // },
  //
  // {
  //   source: 'Eventim',
  //   buildUrl(eventName, venueCity) { ... },
  //   normalise(data, eventName) { ... }
  // },
  // ────────────────────────────────────────────────────────────────────────
];


// ===========================
// Orchestrator — runs all adapters in parallel
// Returns an array of normalised results (nulls and errors silently dropped)
// ===========================

// Extract the core performer/artist name from a full TM event title
// "Metallica: Life Burns Faster" -> "Metallica"
// "Arsenal vs Chelsea" -> "Arsenal"  (keep vs format for sports)
// "Phantom of the Opera" -> "Phantom of the Opera" (no colon = keep as-is)
function extractPerformerName(fullName) {
  if (!fullName) return '';
  // Strip subtitle after colon (e.g. "Metallica: Life Burns Faster" -> "Metallica")
  const colonIdx = fullName.indexOf(':');
  if (colonIdx > 0) return fullName.slice(0, colonIdx).trim();
  // Strip subtitle after " - " (e.g. "Metallica - Suite Reservation" -> "Metallica")
  const dashIdx = fullName.indexOf(' - ');
  if (dashIdx > 0) return fullName.slice(0, dashIdx).trim();
  return fullName.trim();
}

async function comparePrices(eventName, venueCity, eventDate, venueName) {
  // Use performer name (stripped of subtitles) for adapter searches
  // so "Metallica: Life Burns Faster" matches "Metallica" on Gigsberg/VS
  const performerName = extractPerformerName(eventName);
  const settled = await Promise.allSettled(
    ADAPTERS.map(async adapter => {
      // Pass performerName for search queries, but keep full eventName for normalise matching
      const url = adapter.buildUrl(performerName, venueCity, eventDate, venueName);

      const response = await fetch(url);
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        console.warn('[compare]', adapter.source, 'returned non-JSON:', response.status, ct);
        return null;
      }
      const data = await response.json().catch(e => { console.warn('[compare]', adapter.source, 'JSON parse error:', e); return null; });
      if (!data) return null;
      const result = await adapter.normalise(data, performerName);
      // result is null if adapter found no match
      return result;
    })
  );

  return settled
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
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
      <div class="compare-footnote">Prices shown are the lowest available and may exclude booking fees. Resale prices may differ from face value. Always confirm on the seller's site before purchasing.</div>
    </div>
  `;

  comparePrices(eventName, venueCity, eventDate, venueName).then(results => {
    const slot = document.getElementById('adapter-prices');
    if (!slot) return;

    // Include VS and other sources even without price — affiliate click still earns commission
    const withPrices = results
      .filter(r => r.available && (r.price || r.source === 'Vivid Seats'))
      .sort((a, b) => {
        // Sort by price ascending (best/lowest first)
        // Items without price go to the bottom
        if (!a.price && !b.price) return 0;
        if (!a.price) return 1;
        if (!b.price) return -1;
        return a.price - b.price;
      });

    if (withPrices.length === 0) {
      // No other sellers — show TM as the only source (even if no price)
      slot.innerHTML = buildRow('Ticketmaster', tmPrice, tmUrl, 'GBP');
    } else {
      // Other sellers have prices — only include TM if it also has a price
      slot.innerHTML = '';
      if (tmPrice) {
        slot.insertAdjacentHTML('beforeend', buildRow('Ticketmaster', tmPrice, tmUrl, 'GBP'));
      }
      withPrices.forEach(result => {
        slot.insertAdjacentHTML('beforeend', buildRow(result.source, result.price, result.url, result.currency));
      });
    }

    highlightBestPrice();
  });
}

// Builds a single comparison row as an HTML string.
// price is a number (GBP) or null/undefined for "See site".
// Source styles — logo image URLs where available, coloured abbr badge as fallback
// Source logos — favicons from affiliate sites with coloured abbr badge as fallback
const SOURCE_STYLES = {
  'Ticketmaster':          { logo: 'https://www.ticketmaster.co.uk/favicon.ico', bg: '#026cdf', color: '#fff', abbr: 'TM' },
  'Gigsberg':              { logo: 'https://www.gigsberg.com/favicon.ico',        bg: '#0a1628', color: '#fff', abbr: 'GS' },
  'Gigsberg UK':           { logo: 'https://www.gigsberg.com/favicon.ico',        bg: '#0a1628', color: '#fff', abbr: 'GS' },
  'Vivid Seats':           { logo: '/public/logos/vividseats.svg',                 bg: '#00a0e9', color: '#fff', abbr: 'VS' },
  'SportsEvents365':       { logo: 'https://www.sportsevents365.com/favicon.ico', bg: '#e85d04', color: '#fff', abbr: 'SE' },
  'Skiddle':               { logo: 'https://www.skiddle.com/favicon.ico',         bg: '#00b4b4', color: '#fff', abbr: 'SK' },
  'SeatGeek':              { logo: 'https://seatgeek.com/favicon.ico',            bg: '#de5448', color: '#fff', abbr: 'SG' },
  'Theatre Tickets Direct':{ logo: 'https://www.theatreticketsdirect.co.uk/favicon.ico', bg: '#7c3aed', color: '#fff', abbr: 'TD' },
  'Football TicketNet UK': { logo: null,                                           bg: '#16a34a', color: '#fff', abbr: 'FT' },
};

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

function buildRow(source, price, url, currency) {
  const symbol    = (currency && currency !== 'GBP') ? '$' : '£';
  const priceText = price ? `${symbol}${Math.round(price)}` : null;
  const dataPrice = price ? Math.round(price) : 0;
  const style     = SOURCE_STYLES[source] || { logo: null, bg: '#1a6fc4', color: '#fff', abbr: source.slice(0,2).toUpperCase() };

  return `
    <div class="compare-row" data-price="${dataPrice}">
      <div style="flex-shrink:0;width:36px;height:36px;display:flex;align-items:center;justify-content:center;">
        ${buildLogoEl(style)}
      </div>
      <div class="compare-source-name">${source}</div>
      <div class="compare-right">
        ${priceText
          ? `<div class="compare-from">From</div><div class="compare-price-wrap"><div class="price-label">${priceText}</div></div>`
          : `<div class="compare-price-wrap"><div class="price-label" style="font-size:13px;color:#888;">Check site</div></div>`
        }
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="compare-buy">Get tickets →</a>
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
    if (price > 0 && price < lowest) lowest = price;
  });

  if (lowest === Infinity) return;

  rows.forEach(row => {
    const price = parseFloat(row.dataset.price);
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
