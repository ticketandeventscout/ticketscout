// ===========================
// TicketScout — Price Compare
// Multi-source comparison (via server-side proxy)
// ===========================

// ===========================
// Compare prices across sources
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

// ===========================
// SeatGeek price fetch — via our own /api/seatgeek proxy
// (keeps the SeatGeek client ID server-side, and the proxy
// already restricts results to GB venues)
// ===========================

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

// ===========================
// Render comparison panel
// ===========================

function renderComparePanel(eventName, tmPrice, tmUrl, venueCity) {
  const existing = document.getElementById('compare-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'compare-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #ffffff;
    border: 1px solid #c8dff5;
    border-radius: 12px;
    padding: 20px 24px;
    width: 300px;
    box-shadow: 0 8px 32px rgba(26,111,196,0.15);
    z-index: 999;
    font-family: 'Inter', sans-serif;
  `;

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <span style="font-size:14px; font-weight:600; color:#1a1a1a;">Price comparison</span>
      <span onclick="document.getElementById('compare-panel').remove()"
        style="cursor:pointer; color:#888; font-size:18px; line-height:1;">✕</span>
    </div>
    <div style="font-size:13px; color:#555; margin-bottom:14px; line-height:1.4;">${eventName}</div>
    <div id="compare-rows">
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #eee;" data-price="${tmPrice || 0}">
        <span style="font-size:13px; color:#1a1a1a; font-weight:500;">Ticketmaster</span>
        <div style="text-align:right;">
          <div class="price-label" style="font-size:14px; font-weight:600; color:#1a6fc4;">${tmPrice ? `£${Math.round(tmPrice)}` : 'See site'}</div>
          <a href="${tmUrl}" target="_blank" rel="noopener noreferrer"
            style="font-size:11px; color:#1a6fc4;">Buy now →</a>
        </div>
      </div>
      <div id="extra-prices" style="margin-top:4px;">
        <div style="font-size:12px; color:#aaa; padding:8px 0;">Loading SeatGeek prices…</div>
      </div>
    </div>
    <div style="margin-top:14px; font-size:11px; color:#aaa; text-align:center;">
      Prices from verified sellers only
    </div>
  `;

  document.body.appendChild(panel);

  // Load SeatGeek prices
  comparePrices(eventName, venueCity).then(results => {
    const container = document.getElementById('extra-prices');
    if (!container) return;

    if (results.length === 0) {
      container.innerHTML = '<div style="font-size:12px; color:#aaa; padding:8px 0;">No additional UK prices found for this event</div>';
      return;
    }

    container.innerHTML = '';
    results.forEach(result => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #eee;';
      row.dataset.price = result.price;
      row.innerHTML = `
        <span style="font-size:13px; color:#1a1a1a; font-weight:500;">${result.source}</span>
        <div style="text-align:right;">
          <div class="price-label" style="font-size:14px; font-weight:600; color:#1a6fc4;">${result.label}</div>
          <a href="${result.url}" target="_blank" rel="noopener noreferrer"
            style="font-size:11px; color:#1a6fc4;">Buy now →</a>
        </div>
      `;
      container.appendChild(row);
    });

    highlightBestPrice();
  });
}

// ===========================
// Highlight lowest price
// ===========================

function highlightBestPrice() {
  const rows = document.querySelectorAll('#compare-panel [data-price]');
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
      badge.style.cssText = `
        background: #e8f2fc;
        color: #185fa5;
        font-size: 10px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 20px;
        margin-left: 6px;
        vertical-align: middle;
      `;
      row.querySelector('.price-label').appendChild(badge);
    }
  });
}

// ===========================
// Attach compare to cards
// ===========================

function attachCompareListeners() {
  document.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', function(e) {
      e.preventDefault();

      const name = this.querySelector('.event-name')?.textContent || '';
      const priceText = this.querySelector('.event-price')?.textContent || '';
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || null;
      const url = this.href || '#';
      const metaText = this.querySelector('.event-meta')?.textContent || '';
      const city = metaText.split('·')[1]?.trim() || 'London';

      renderComparePanel(name, price, url, city);
    });
  });
}

// ===========================
// Watch for new event cards
// ===========================

const grid = document.getElementById('events-grid');
if (grid) {
  const observer = new MutationObserver(() => {
    attachCompareListeners();
  });
  observer.observe(grid, { childList: true });
}
