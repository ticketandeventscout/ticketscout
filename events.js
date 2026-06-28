// ===========================
// TicketScout — Events & Router
// Ticketmaster Integration (via server-side proxy)
// ===========================

const CATEGORY_MAP = {
  all: '',
  music: 'Music',
  sports: 'Sports',
  arts: 'Arts & Theatre',
  comedy: 'Arts & Theatre'
};

const CATEGORY_ICONS = {
  Music: '🎵',
  Sports: '⚽',
  'Arts & Theatre': '🎭',
  default: '🎟️'
};

// ===========================
// Tiny hash router
// Views: #/                          -> home (trending / category browse)
//        #/search/<keyword>          -> artist picker (or auto-skip if 1 match)
//        #/artist/<id>/<slug>        -> all dates for one specific artist
//        #/event/<id>                -> single event detail page
// ===========================

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

function navigate(path) {
  window.location.hash = path;
}

function getResultsEl() {
  return document.getElementById('events-grid');
}

function setChromeVisible(visible) {
  const catRow = document.getElementById('cat-row');
  const howSection = document.getElementById('how-section');
  if (catRow) catRow.style.display = visible ? 'flex' : 'none';
  if (howSection) howSection.style.display = visible ? 'block' : 'none';
}

function setBreadcrumb(html) {
  const el = document.getElementById('view-breadcrumb');
  if (!el) return;
  el.innerHTML = html;
  el.style.display = html ? 'block' : 'none';
}

function render() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] === 'search' && parts[1]) {
    setChromeVisible(false);
    runSearch(decodeURIComponent(parts[1]));
  } else if (parts[0] === 'artist' && parts[1]) {
    setChromeVisible(false);
    showArtistEvents(parts[1], parts[2] ? decodeURIComponent(parts[2]) : '');
  } else if (parts[0] === 'event' && parts[1]) {
    setChromeVisible(false);
    showEventDetail(parts[1]);
  } else {
    setChromeVisible(true);
    setBreadcrumb('');
    document.getElementById('results-title').textContent = 'Trending events in the UK';
    fetchEvents();
  }
}

// ===========================
// Home view — trending / category browse
// ===========================

async function fetchEvents(keyword = '', segmentName = '') {
  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Loading events…</div>';

  try {
    const params = new URLSearchParams({ size: '12' });
    if (keyword) params.set('keyword', keyword);
    if (segmentName) params.set('segmentName', segmentName);

    const response = await fetch(`/api/ticketmaster?${params.toString()}`);
    const data = await response.json();

    if (data.error || !data._embedded || !data._embedded.events) {
      grid.innerHTML = '<div class="error-msg">No events found. Try a different search.</div>';
      return;
    }

    renderEventCards(grid, data._embedded.events);
  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Unable to load events right now. Please try again shortly.</div>';
    console.error('Ticketmaster fetch error:', error);
  }
}

function filterCategory(pill, category) {
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  navigate('/');
  const segmentName = CATEGORY_MAP[category] || '';
  fetchEvents('', segmentName);
}

// ===========================
// Search handler — resolves to an artist first
// ===========================

function handleSearch() {
  const keyword = document.getElementById('search-input').value.trim();
  if (!keyword) return;
  navigate(`/search/${encodeURIComponent(keyword)}`);
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') handleSearch();
    });
  }
});

async function runSearch(keyword) {
  document.getElementById('results-title').textContent = `Results for "${keyword}"`;
  setBreadcrumb(`<a href="#/">← Back to trending</a>`);

  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Searching…</div>';

  try {
    const response = await fetch(`/api/attractions?keyword=${encodeURIComponent(keyword)}`);
    const data = await response.json();
    const attractions = data._embedded?.attractions || [];

    if (attractions.length === 0) {
      // Fall back to a plain event keyword search (covers venues, festivals, etc.
      // that aren't modeled as a single "attraction")
      grid.innerHTML = '<div class="loading">No specific artist match — showing event results…</div>';
      const evResponse = await fetch(`/api/ticketmaster?keyword=${encodeURIComponent(keyword)}&size=12`);
      const evData = await evResponse.json();
      if (evData.error || !evData._embedded?.events) {
        grid.innerHTML = '<div class="error-msg">No events found. Try a different search.</div>';
        return;
      }
      renderEventCards(grid, evData._embedded.events);
      return;
    }

    if (attractions.length === 1) {
      const a = attractions[0];
      navigate(`/artist/${a.id}/${encodeURIComponent(a.name)}`);
      return;
    }

    renderArtistPicker(grid, attractions);
  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Search failed. Please try again shortly.</div>';
    console.error('Attraction search error:', error);
  }
}

function renderArtistPicker(grid, attractions) {
  grid.className = 'picker-grid';
  grid.innerHTML = '';

  attractions.forEach(a => {
    const image = getBestImage(a.images);
    const type = a.classifications?.[0]?.segment?.name || '';

    const card = document.createElement('div');
    card.className = 'picker-card';
    card.onclick = () => navigate(`/artist/${a.id}/${encodeURIComponent(a.name)}`);
    card.innerHTML = `
      ${image
        ? `<img class="picker-img" src="${image}" alt="${a.name}" loading="lazy" />`
        : `<div class="picker-img-placeholder">${CATEGORY_ICONS[type] || CATEGORY_ICONS.default}</div>`
      }
      <div class="picker-name">${a.name}</div>
      ${type ? `<div class="picker-type">${type}</div>` : ''}
    `;
    grid.appendChild(card);
  });
}

// ===========================
// Artist view — all dates for ONE artist only (attractionId guarantees this)
// ===========================

async function showArtistEvents(attractionId, name) {
  document.getElementById('results-title').textContent = name ? `${name} — upcoming UK dates` : 'Upcoming dates';
  setBreadcrumb(`<a href="#/">← Back to trending</a>`);

  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Loading dates…</div>';

  try {
    const response = await fetch(`/api/ticketmaster?attractionId=${encodeURIComponent(attractionId)}&size=50`);
    const data = await response.json();

    if (data.error || !data._embedded || !data._embedded.events) {
      grid.innerHTML = '<div class="error-msg">No upcoming UK dates found for this artist.</div>';
      return;
    }

    renderEventCards(grid, data._embedded.events);
  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Unable to load dates right now. Please try again shortly.</div>';
    console.error('Artist events fetch error:', error);
  }
}

// ===========================
// Shared — render a grid of event cards (each links to its own detail page)
// ===========================

function renderEventCards(grid, events) {
  grid.innerHTML = '';

  if (events.length === 0) {
    grid.innerHTML = '<div class="error-msg">No events found.</div>';
    return;
  }

  events.forEach(event => {
    const name = event.name || 'Event';
    const date = formatDate(event.dates?.start?.localDate);
    const venue = event._embedded?.venues?.[0]?.name || '';
    const city = event._embedded?.venues?.[0]?.city?.name || '';
    const location = [venue, city].filter(Boolean).join(' · ');
    const image = getBestImage(event.images);
    const segment = event.classifications?.[0]?.segment?.name || 'default';
    const minPrice = event.priceRanges?.[0]?.min;
    const priceDisplay = minPrice ? `From £${Math.round(minPrice)}` : 'Check site for prices';

    const card = document.createElement('a');
    card.className = 'event-card';
    card.href = `#/event/${event.id}`;

    card.innerHTML = `
      ${image
        ? `<img class="event-img" src="${image}" alt="${name}" loading="lazy" />`
        : `<div class="event-img-placeholder">${CATEGORY_ICONS[segment] || CATEGORY_ICONS.default}</div>`
      }
      <div class="event-body">
        <div class="event-name">${name}</div>
        <div class="event-meta">
          ${location ? `${location}<br/>` : ''}
          ${date}
        </div>
        <div class="event-price">${priceDisplay}</div>
        <span class="compare-badge">Ticketmaster</span>
      </div>
    `;

    grid.appendChild(card);
  });
}

// ===========================
// Event detail page — single event, full info + inline price comparison
// ===========================

async function showEventDetail(eventId) {
  document.getElementById('results-title').textContent = 'Event details';
  setBreadcrumb(`<a href="javascript:history.back()">← Back to results</a>`);

  const grid = getResultsEl();
  grid.className = 'detail-grid';
  grid.innerHTML = '<div class="loading">Loading event…</div>';

  try {
    const response = await fetch(`/api/ticketmaster?id=${encodeURIComponent(eventId)}`);
    const event = await response.json();

    if (event.error || !event.id) {
      grid.innerHTML = '<div class="error-msg">Couldn\'t load this event. It may no longer be available.</div>';
      return;
    }

    document.getElementById('results-title').textContent = event.name || 'Event details';

    const venue = event._embedded?.venues?.[0];
    const venueName = venue?.name || '';
    const city = venue?.city?.name || '';
    const address = venue?.address?.line1 || '';
    const date = formatDate(event.dates?.start?.localDate);
    const time = event.dates?.start?.localTime ? event.dates.start.localTime.slice(0, 5) : '';
    const image = getBestImage(event.images);
    const minPrice = event.priceRanges?.[0]?.min;
    const tmUrl = event.url || '#';

    grid.innerHTML = `
      <div class="detail-card">
        ${image ? `<img class="detail-img" src="${image}" alt="${event.name}" />` : ''}
        <div class="detail-body">
          <h3 class="detail-name">${event.name}</h3>
          <div class="detail-meta">
            ${date}${time ? ` · ${time}` : ''}<br/>
            ${[venueName, address, city].filter(Boolean).join(', ')}
          </div>
        </div>
      </div>
      <div id="detail-compare"></div>
    `;

    renderComparePrices(
      document.getElementById('detail-compare'),
      event.name,
      minPrice,
      tmUrl,
      city || 'London'
    );
  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Unable to load this event right now.</div>';
    console.error('Event detail fetch error:', error);
  }
}

// ===========================
// Helpers
// ===========================

function getBestImage(images) {
  if (!images || images.length === 0) return null;
  const preferred = images.find(img => img.ratio === '16_9' && img.width > 300);
  return preferred ? preferred.url : images[0].url;
}

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBC';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}
