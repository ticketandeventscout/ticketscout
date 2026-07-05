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
    // Awin category adapter — covers ALL approved Awin ticket merchants
    // in one call (currently: Gigsberg UK + Theatre Tickets Direct).
    // New approved Awin merchants appear automatically with no code changes.
    source: 'Awin',

    buildUrl(eventName, venueCity, eventDate, venueName) {
      const params = new URLSearchParams({ q: eventName });
      if (eventDate) params.set('date', eventDate);
      if (venueName) params.set('venue', venueName);
      return `/api/awin-category?${params.toString()}`;
    },

    normalise(data, eventName) {
      if (data.error || !data.matches?.length) return null;

      // awin-category returns the best match already — use it directly
      const match = data.matches[0];
      if (!match.price || !match.url) return null;

      // Use merchant_name as the display source so users see "Gigsberg" or
      // "Theatre Tickets Direct" rather than the generic "Awin" label
      return {
        source:    match.merchant_name || 'Awin',
        price:     Math.round(match.price),
        currency:  match.currency || 'GBP',
        url:       match.url,
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

async function comparePrices(eventName, venueCity, eventDate, venueName) {
  const settled = await Promise.allSettled(
    ADAPTERS.map(async adapter => {
      const url = adapter.buildUrl(eventName, venueCity, eventDate, venueName);
      const response = await fetch(url);
      const data = await response.json();
      return await adapter.normalise(data, eventName);
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
      <div class="compare-title">Compare prices</div>
      <div id="compare-rows">
        <div id="adapter-prices">
          <div class="compare-loading">Checking prices…</div>
        </div>
      </div>
      <div class="compare-footnote">Prices shown are the lowest available from each seller and may exclude booking fees. Resale platform prices may differ from the original ticket price. Always confirm on the seller's site before purchasing.</div>
    </div>
  `;

  comparePrices(eventName, venueCity, eventDate, venueName).then(results => {
    const slot = document.getElementById('adapter-prices');
    if (!slot) return;

    const withPrices = results.filter(r => r.available && r.price);

    if (withPrices.length === 0) {
      // No other sellers — show TM as the only source (even if no price)
      slot.innerHTML = buildRow('Ticketmaster', tmPrice, tmUrl);
    } else {
      // Other sellers have prices — only include TM if it also has a price
      slot.innerHTML = '';
      if (tmPrice) {
        slot.insertAdjacentHTML('beforeend', buildRow('Ticketmaster', tmPrice, tmUrl));
      }
      withPrices.forEach(result => {
        slot.insertAdjacentHTML('beforeend', buildRow(result.source, result.price, result.url));
      });
    }

    highlightBestPrice();
  });
}

// Builds a single comparison row as an HTML string.
// price is a number (GBP) or null/undefined for "See site".
function buildRow(source, price, url) {
  const priceDisplay = price ? `£${Math.round(price)}` : 'See site';
  const dataPrice = price ? Math.round(price) : 0;
  return `
    <div class="compare-row" data-price="${dataPrice}">
      <span class="compare-source">${source}</span>
      <div class="compare-right">
        <div class="price-label">${priceDisplay}</div>
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="compare-buy">Buy now →</a>
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
      row.querySelector('.price-label')?.appendChild(badge);
    }
  });
}


// ===========================
// Shared helper
// ===========================

function normaliseName(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}         
