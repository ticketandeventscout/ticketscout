// ===========================
// TicketScout — Events
// Ticketmaster Integration (via server-side proxy)
// ===========================

// Category map — converts our pill filters to Ticketmaster segment names
const CATEGORY_MAP = {
  all: '',
  music: 'Music',
  sports: 'Sports',
  arts: 'Arts & Theatre',
  comedy: 'Arts & Theatre'
};

// Placeholder icons per category
const CATEGORY_ICONS = {
  Music: '🎵',
  Sports: '⚽',
  'Arts & Theatre': '🎭',
  default: '🎟️'
};

// ===========================
// Fetch events via our own /api/ticketmaster proxy
// (keeps the Ticketmaster API key server-side)
// ===========================

async function fetchEvents(keyword = '', segmentName = '') {
  const grid = document.getElementById('events-grid');
  grid.innerHTML = '<div class="loading">Loading events…</div>';

  try {
    const params = new URLSearchParams({ size: '12' });
    if (keyword) params.set('keyword', keyword);
    if (segmentName) params.set('segmentName', segmentName);

    const response = await fetch(`/api/ticketmaster?${params.toString()}`);
    const data = await response.json();

    if (data.error) {
      grid.innerHTML = '<div class="error-msg">Unable to load events right now. Please try again shortly.</div>';
      console.error('Ticketmaster proxy error:', data.error);
      return;
    }

    if (!data._embedded || !data._embedded.events) {
      grid.innerHTML = '<div class="error-msg">No events found. Try a different search.</div>';
      return;
    }

    renderEvents(data._embedded.events);

  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Unable to load events right now. Please try again shortly.</div>';
    console.error('Ticketmaster fetch error:', error);
  }
}

// ===========================
// Render event cards
// ===========================

function renderEvents(events) {
  const grid = document.getElementById('events-grid');
  grid.innerHTML = '';

  events.forEach(event => {
    const name = event.name || 'Event';
    const url = event.url || '#';
    const date = formatDate(event.dates?.start?.localDate);
    const venue = event._embedded?.venues?.[0]?.name || '';
    const city = event._embedded?.venues?.[0]?.city?.name || '';
    const location = [venue, city].filter(Boolean).join(' · ');
    const image = getBestImage(event.images);
    const segment = event.classifications?.[0]?.segment?.name || 'default';
    const minPrice = event.priceRanges?.[0]?.min;
    const priceDisplay = minPrice
      ? `From £${Math.round(minPrice)}`
      : 'Check site for prices';

    const card = document.createElement('a');
    card.className = 'event-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

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
// Helper — pick best image
// ===========================

function getBestImage(images) {
  if (!images || images.length === 0) return null;
  const preferred = images.find(img => img.ratio === '16_9' && img.width > 300);
  return preferred ? preferred.url : images[0].url;
}

// ===========================
// Helper — format date
// ===========================

function formatDate(dateStr) {
  if (!dateStr) return 'Date TBC';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

// ===========================
// Search handler
// ===========================

function searchEvents() {
  const keyword = document.getElementById('search-input').value.trim();
  fetchEvents(keyword, '');

  // Reset category pills
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  document.querySelector('.cat-pill').classList.add('active');
}

// Allow pressing Enter to search
document.getElementById('search-input').addEventListener('keypress', function (e) {
  if (e.key === 'Enter') searchEvents();
});

// ===========================
// Category filter handler
// ===========================

function filterCategory(pill, category) {
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  const segmentName = CATEGORY_MAP[category] || '';
  fetchEvents('', segmentName);
}

// ===========================
// Load events on page start
// ===========================

fetchEvents();
