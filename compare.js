// ===========================
// TicketScout — Price Compare
// Renders inline on the event detail page (no more floating popup —
// since each event now has its own real page, the comparison lives
// directly on it)
// ===========================

async function comparePrices(eventName, venueCity) {
  const results = [];

  try {
    const sg = await fetchSeatGeekPrices(eventName, venueCity);
    if (sg) results.push(sg);
  } catch (e) {
    console.warn('SeatGeek fetch failed:', e);
  }

  return results;
}

// SeatGeek price fetch — via our own /api/seatgeek proxy
// (keeps the SeatGeek client ID server-side)
async function fetchSeatGeekPrices(keyword, city) {
  const params = new URLSearchParams({ q: keyword, per_page: '3' });
  if (city) params.set('city', city);

  const response = await fetch(`/api/seatgeek?${params.toString()}`);
  const data = await response.json();

  if (data.error || !data.events || data.events.length === 0) return null;

  const event = data.events[0];
  const price = event.stats?.lowest_price;
  if (!price) return null;

  return {
    source: 'SeatGeek',
    price: Math.round(price),
    url: event.url,
    label: `£${Math.round(price)}`
  };
}

// Renders the comparison block into a given container element on the event detail page
function renderComparePrices(container, eventName, tmPrice, tmUrl, venueCity) {
  if (!container) return;

  container.innerHTML = `
    <div class="compare-block">
      <div class="compare-title">Price comparison</div>
      <div id="compare-rows">
        <div class="compare-row" data-price="${tmPrice || 0}">
          <span class="compare-source">Ticketmaster</span>
          <div class="compare-right">
            <div class="price-label">${tmPrice ? `£${Math.round(tmPrice)}` : 'See site'}</div>
            <a href="${tmUrl}" target="_blank" rel="noopener noreferrer" class="compare-buy">Buy now →</a>
          </div>
        </div>
        <div id="extra-prices">
          <div class="compare-loading">Loading other sources…</div>
        </div>
      </div>
      <div class="compare-footnote">Prices from verified sellers only</div>
    </div>
  `;

  comparePrices(eventName, venueCity).then(results => {
    const extra = document.getElementById('extra-prices');
    if (!extra) return;

    if (results.length === 0) {
      extra.innerHTML = '<div class="compare-loading">No additional prices found for this event</div>';
      return;
    }

    extra.innerHTML = '';
    results.forEach(result => {
      const row = document.createElement('div');
      row.className = 'compare-row';
      row.dataset.price = result.price;
      row.innerHTML = `
        <span class="compare-source">${result.source}</span>
        <div class="compare-right">
          <div class="price-label">${result.label}</div>
          <a href="${result.url}" target="_blank" rel="noopener noreferrer" class="compare-buy">Buy now →</a>
        </div>
      `;
      extra.appendChild(row);
    });

    highlightBestPrice();
  });
}

function highlightBestPrice() {
  const rows = document.querySelectorAll('#compare-rows .compare-row');
  if (rows.length === 0) return;

  let lowest = Infinity;
  rows.forEach(row => {
    const price = parseFloat(row.dataset.price);
    if (price > 0 && price < lowest) lowest = price;
  });

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
