// ===========================
// TicketScout — Events & Router
// Ticketmaster Integration (via server-side proxy)
// ===========================

const CATEGORY_MAP = {
  all:    { segment: '' },
  music:  { segment: 'Music' },
  sports: { segment: 'Sports' },
  // Theatre does NOT come from Ticketmaster. TM's Arts & Theatre segment
  // returns a single production at any page size — measured 23 Jul, 1 unique
  // attraction from 100 rows, because a West End run occupies every slot.
  // The registry (161 shows) is the only source that can fill a grid.
  arts:   { hub: '/api/theatre?list=1', label: 'show' }
};

// TM segments that represent real ticketed events. Everything else — notably
// segment "Miscellaneous" / genre "Undefined", which is how TM classifies
// attractions like The View from The Shard, Twist Museum and Sea Life — is
// excluded from the homepage. Confirmed 23 Jul against the live TM payload.
const TRENDING_SEGMENTS = new Set(['Music', 'Sports', 'Arts & Theatre']);

// Collapse repeat performances of the same production. A West End run puts
// the same show on consecutive nights, and relevance,desc surfaces all of
// them — live evidence 23 Jul had Harry Potter in slots 3, 4, 5 and 6.
// TM's own attraction id is the identity where present; the normalised name
// is the fallback for events TM ships without an attraction link.
function performanceKey(e) {
  const attr = e && e._embedded && e._embedded.attractions && e._embedded.attractions[0];
  if (attr && attr.id) return 'a:' + attr.id;
  const name = String((e && e.name) || '')
    .toLowerCase()
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ')      // 14:00
    .replace(/\b\d{1,2}\s*(am|pm)\b/g, ' ')     // 7pm
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return 'n:' + name;
}

function dedupePerformances(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = performanceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function isRealEvent(e) {
  const c = (e && e.classifications && e.classifications[0]) || null;
  if (!c) return false;
  const seg = (c.segment && c.segment.name) || '';
  const genre = (c.genre && c.genre.name) || '';
  if (!TRENDING_SEGMENTS.has(seg)) return false;
  if (genre === 'Undefined') return false;
  return true;
}

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

// Auto-trigger category filter from URL param e.g. /?cat=comedy from nav links
window.addEventListener('DOMContentLoaded', function() {
  const cat = new URLSearchParams(window.location.search).get('cat');
  if (cat) {
    const pills = document.querySelectorAll('.cat-pill');
    const pill = Array.from(pills).find(p => p.getAttribute('onclick') && p.getAttribute('onclick').includes("'" + cat + "'"));
    if (pill) { window.history.replaceState({}, '', '/'); filterCategory(pill, cat); }
  }
});
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

async function fetchEvents(keyword = '', segmentName = '', genreId = '', subGenreId = '') {
  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Loading events…</div>';

  try {
    // Filtering, deduping and segment blending all happen server-side in
    // /api/trending. Doing it here meant shipping up to 4 MB of raw TM JSON
    // to every visitor; the endpoint returns ~5 KB of the same shape.
    //
    // IMPORTANT: do NOT re-run dedupePerformances() on this response. The
    // endpoint strips _embedded.attractions to keep the payload small, so the
    // client would fall back to name matching and could wrongly collapse two
    // distinct productions that share a name. The server has already deduped.
    const params = new URLSearchParams();
    if (segmentName) params.set('segment', segmentName);

    // A keyword search is a different intent from a trending grid, so it
    // still goes to the raw proxy and keeps its own client-side filtering.
    const useTrending = !keyword;
    const url = useTrending
      ? `/api/trending${params.toString() ? '?' + params.toString() : ''}`
      : `/api/ticketmaster?keyword=${encodeURIComponent(keyword)}&size=40`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error || !data._embedded || !data._embedded.events) {
      grid.innerHTML = '<div class="error-msg">No events found. Try a different search.</div>';
      return;
    }

    const events = useTrending
      ? data._embedded.events.slice(0, 12)
      : dedupePerformances(data._embedded.events.filter(isRealEvent)).slice(0, 12);

    if (!events.length) {
      grid.innerHTML = '<div class="error-msg">No events found. Try a different search.</div>';
      return;
    }

    renderEventCards(grid, events);
  } catch (error) {
    grid.innerHTML = '<div class="error-msg">Unable to load events right now. Please try again shortly.</div>';
    console.error('Ticketmaster fetch error:', error);
  }
}

function filterCategory(pill, category) {
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  navigate('/');
  const cat = CATEGORY_MAP[category] || {};
  if (cat.hub) { fetchHubEntities(cat.hub, cat.label || 'item'); return; }
  fetchEvents(cat.keyword || '', cat.segment || '');
}

// Renders registry entities (shows, artists) rather than dated events.
// These are browse links to entity pages, not individual performances, so
// they deliberately carry no date or price — claiming either would be a lie.
async function fetchHubEntities(endpoint, label) {
  const grid = document.getElementById('events-grid');
  const title = document.getElementById('results-title');
  if (title) title.textContent = 'Browse ' + label + 's';
  if (!grid) return;

  grid.innerHTML = '<div class="loading">Loading…</div>';

  try {
    const response = await fetch(endpoint);
    const data = await response.json();
    const entities = (data && data.entities) || [];

    if (!entities.length) {
      grid.innerHTML = '<div class="error-msg">Nothing here yet.</div>';
      return;
    }

    grid.innerHTML = '';
    entities.slice(0, 24).forEach(ent => {
      const card = document.createElement('a');
      card.className = 'event-card';
      card.href = ent.url;
      card.innerHTML = `
        <div class="event-img-placeholder">${CATEGORY_ICONS['Arts & Theatre'] || CATEGORY_ICONS.default}</div>
        <div class="event-body">
          <div class="event-name">${escapeHtml(ent.name)}</div>
          <div class="event-meta">${escapeHtml(ent.genre || '')}</div>
          <span class="compare-badge">Compare prices →</span>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = '<div class="error-msg">Couldn\'t load that list. Please try again.</div>';
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
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

async function renderHotelCard(container, city, date, venue) {
  if (!container) return;

  try {
    const params = new URLSearchParams({ city, date });
    if (venue) params.set('venue', venue);
    const resp = await fetch(`/api/hotels?${params.toString()}`);
    const data = await resp.json().catch(() => null);
    if (!data?.hotels) return;

    const { hotels_url, trivago_url, checkin, checkout } = data.hotels;
    const dateStr = checkin ? new Date(checkin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

    container.innerHTML = `
      <div class="hotel-card">
        <div class="hotel-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Where to stay near ${city}
        </div>
        ${dateStr ? `<div class="hotel-card-date">Check-in: ${dateStr}</div>` : ''}
        <div class="hotel-card-links">
          <a href="${hotels_url}" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--primary">
            Search Hotels.com →
          </a>
          <a href="${trivago_url}" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--secondary">
            Compare on Trivago →
          </a>
        </div>
        <div class="hotel-card-note">Prices from verified hotel booking sites. No booking fees added by us.</div>
      </div>
    `;
  } catch(e) {
    // Silent fail — hotel card is supplementary
  }
}

async function runSearch(keyword) {
  document.getElementById('results-title').textContent = `Results for "${keyword}"`;
  setBreadcrumb(`<a href="#/">← Back to trending</a>`);

  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Searching…</div>';

  // Check if a dedicated SEO page exists — football first, then theatre, then concert.
  // Only redirect to football/theatre if API returns RICH data (description > 80 chars),
  // meaning it's a hardcoded entry — not a synthesised fallback from the slug.
  const slug = toArtistSlug(keyword);
  if (slug) {
    try {
      const [footballResp, theatreResp, concertResp] = await Promise.all([
        fetch(`/api/football?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/theatre?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/concert?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const isRichFootball = (footballResp?.team?.description?.length || 0) > 150;
      const isRichConcert  = (concertResp?.artist?.description?.length || 0) > 150;
      // A rich concert match (hardcoded artist or real KV data) beats a theatre
      // match: the theatre API's Awin fallback synthesises a "rich" description
      // for ANY name Awin has events for (e.g. Coldplay), mislabelled as Theatre,
      // which otherwise mis-routed music artists to a non-existent /theatre/ page.
      const isRichTheatre  = (theatreResp?.show?.description?.length || 0) > 150 && !isRichConcert;
      if (isRichFootball) { window.location.href = `/football/${slug}`; return; }
      if (isRichTheatre)  { window.location.href = `/theatre/${slug}`; return; }
      if (concertResp)    { window.location.href = `/concert/${slug}`; return; }
    } catch {}
  }

  try {
    const response = await fetch(`/api/attractions?keyword=${encodeURIComponent(keyword)}`);
    const data = await response.json();
    const attractions = data._embedded?.attractions || [];

    if (attractions.length === 0 || attractions.every(a => isTributeName(a.name))) {
      // No real results — try event keyword search
      const evResponse = await fetch(`/api/ticketmaster?keyword=${encodeURIComponent(keyword)}&size=12`);
      const evData = await evResponse.json();

      if (evData.error || !evData._embedded?.events || evData._embedded.events.length === 0) {
        // Truly nothing found — show "did you mean?"
        const suggestion = await findSuggestion(keyword);
        if (suggestion) {
          grid.innerHTML = `
            <div class="no-results-msg">
              <p>No results found for <strong>"${keyword}"</strong>.</p>
              <p>Did you mean: <a href="#" class="suggestion-link" onclick="event.preventDefault(); document.getElementById('search-input').value='${suggestion.replace(/'/g,"\\'")}'; handleSearch();">${suggestion}</a>?</p>
            </div>`;
        } else {
          grid.innerHTML = `<div class="error-msg">No results found for "<strong>${keyword}</strong>". Try checking the spelling or search for a different artist or event.</div>`;
        }
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

// Fuzzy suggestion — searches TM with a loose fuzzy query and returns
// the best match name if it's sufficiently different from the original
async function findSuggestion(keyword) {
  try {
    // Use first few chars as a broader search
    const broadKeyword = keyword.slice(0, Math.max(4, keyword.length - 2));
    const resp = await fetch(`/api/attractions?keyword=${encodeURIComponent(broadKeyword)}&size=5`);
    const data = await resp.json();
    const attractions = data._embedded?.attractions || [];

    if (attractions.length === 0) return null;

    // Find the attraction whose name is closest to the keyword
    const normKeyword = keyword.toLowerCase();
    const scored = attractions
      .filter(a => !isTributeName(a.name))
      .map(a => ({
        name: a.name,
        score: similarityScore(normKeyword, a.name.toLowerCase())
      }))
      .filter(r => r.score > 0.5) // only suggest if reasonably similar
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    // Only suggest if it's different from what they typed
    if (scored[0].name.toLowerCase() === normKeyword) return null;
    return scored[0].name;
  } catch {
    return null;
  }
}

// Simple similarity score using character overlap (0-1)
function similarityScore(a, b) {
  if (a === b) return 1;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
}

function isTributeName(name) {
  const lower = (name || '').toLowerCase();
  return ['tribute', 'ultimate', 'salute', 'legacy', 'experience'].some(kw => lower.includes(kw));
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
// If a /concert/[slug] discovery page exists for this artist, redirect there
// so the user always sees the richer page with bio, FAQ, and price comparison
// ===========================

function toArtistSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, '') // strip bracketed suffixes
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

async function showArtistEvents(attractionId, name) {
  // Check if a dedicated SEO page exists — concert, football, or theatre.
  // If so, redirect there — richer content (bio, FAQ, Awin events, price comparison).
  if (name) {
    const slug = toArtistSlug(name);
    if (slug) {
      try {
        // Check all three APIs in parallel — faster and avoids sequential timeouts
        const [footballResp, theatreResp, concertResp] = await Promise.all([
          fetch(`/api/football?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`/api/theatre?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`/api/concert?slug=${encodeURIComponent(slug)}`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        // Only redirect to football/theatre if the API returned RICH data
        // (hardcoded entry or KV data — description > 80 chars means it's real, not synthesised)
        // This prevents generic words like "grease" or "oliver" routing to football
        const isRichFootball = footballResp?.team?.description?.length > 150;
        const isRichConcert  = concertResp?.artist?.description?.length > 150;
        // Concert wins over a theatre Awin-fallback synthesis (see runSearch note)
        const isRichTheatre  = theatreResp?.show?.description?.length > 150 && !isRichConcert;

        if (isRichFootball) { window.location.href = `/football/${slug}`; return; }
        if (isRichTheatre)  { window.location.href = `/theatre/${slug}`; return; }
        if (concertResp)    { window.location.href = `/concert/${slug}`; return; }
      } catch {}
    }
  }

  document.getElementById('results-title').textContent = name ? `${name} — upcoming dates` : 'Upcoming dates';
  setBreadcrumb(`<a href="#/">← Back to trending</a>`);

  const grid = getResultsEl();
  grid.className = 'events-grid';
  grid.innerHTML = '<div class="loading">Loading dates…</div>';

  try {
    // Fetch Ticketmaster and Awin events in parallel
    const [tmResp, awinResp] = await Promise.all([
      fetch(`/api/ticketmaster?attractionId=${encodeURIComponent(attractionId)}&size=50`),
      name ? fetch(`/api/awin-events?name=${encodeURIComponent(name)}&size=50`) : Promise.resolve(null)
    ]);

    const tmData   = await tmResp.json();
    const awinData = awinResp ? await awinResp.json().catch(() => ({ events: [] })) : { events: [] };

    const tmEvents   = tmData?._embedded?.events || [];
    const awinEvents = (awinData?.events || []).map(e => ({
      id:          e.id,
      name:        e.name,
      _awin:       true,
      _url:        e.url,
      _merchant:   e.merchantName,
      dates:       { start: { localDate: e.date || '' } },
      priceRanges: e.price ? [{ min: e.price }] : [],
      _embedded:   { venues: e.venue ? [{ name: e.venue, city: { name: '' } }] : [] },
      images:      e.image ? [{ url: e.image, width: 640 }] : []
    }));

    // Merge: TM first, then Awin events not already on same date
    const tmDates  = new Set(tmEvents.map(e => e.dates?.start?.localDate).filter(Boolean));
    const awinOnly = awinEvents.filter(e => !e.dates.start.localDate || !tmDates.has(e.dates.start.localDate));
    const allEvents = [...tmEvents, ...awinOnly];

    if (allEvents.length === 0) {
      grid.innerHTML = '<div class="error-msg">No upcoming dates found.</div>';
      return;
    }

    renderEventCards(grid, allEvents);
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

    if (event._awin && event._url) {
      // Awin events link directly to seller
      card.href = event._url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    } else {
      card.href = `#/event/${event.id}`;
    }

    const merchantBadge = event._merchant
      ? `<span style="font-size:10px;color:#888;margin-left:4px;">via ${event._merchant}</span>`
      : '';

    card.innerHTML = `
      ${image
        ? `<img class="event-img" src="${image}" alt="${name}" loading="lazy" />`
        : `<div class="event-img-placeholder">${CATEGORY_ICONS[segment] || CATEGORY_ICONS.default}</div>`
      }
      <div class="event-body">
        <div class="event-name">${name}${merchantBadge}</div>
        <div class="event-meta">
          ${location ? `${location}<br/>` : ''}
          ${date}
        </div>
        <div class="event-price">${priceDisplay}</div>
        <span class="compare-badge">${event._awin ? 'Buy tickets →' : 'Compare prices →'}</span>
      </div>
    `;

    grid.appendChild(card);
  });
}

// ===========================
// Event detail page — single event, full info + inline price comparison
// ===========================

async function showEventDetail(rawEventId) {
  // Split off any ?key=val params that were appended to the event id in the hash
  // e.g. "se365-2026-09-20-celtic-fc-vs-rangers-fc?date=2026-09-20&venue=Celtic%20Park"
  const qIdx = rawEventId.indexOf('?');
  const rawId     = qIdx !== -1 ? rawEventId.slice(0, qIdx) : rawEventId;
  const rawParams = qIdx !== -1 ? rawEventId.slice(qIdx + 1) : '';
  const hashParams = new URLSearchParams(rawParams);
  // Decode URL encoding that may be present in the hash fragment
  const eventId = decodeURIComponent(rawId);

  // Phase 1.4B note: legacy /#/event/ hash IDs deliberately stay on this
  // client-rendered view rather than redirecting to /event/{slug} — the ID
  // formats don't carry a category (and SE365 spans football/rugby/F1/
  // concerts, so it can't be assumed), and a wrong-category redirect is
  // worse than this still-working page. Hash URLs were never crawlable, so
  // no SEO equity is lost; all NEW links from the templates go straight to
  // the SSR /event/ pages.
  document.getElementById('results-title').textContent = 'Event details';
  setBreadcrumb(`<a href="javascript:history.back()">← Back to results</a>`);

  const grid = getResultsEl();
  grid.className = 'detail-grid';
  grid.innerHTML = '<div class="loading">Loading event…</div>';

  // Handle SE365 / VS / TN / Ticombo events — synthetic ID carries source, date, name
  // Format: se365-{yyyy-mm-dd}-{encoded-name} or vs-{date}-{name} or tn-{date}-{name}
  const nonTmSources = ['se365-', 'vs-', 'tn-', 'tc-'];
  if (nonTmSources.some(prefix => eventId.startsWith(prefix))) {
    // Strip the source prefix
    const prefixMatch = eventId.match(/^(se365|vs|tn|tc)-(.+)$/);
    const rawPart     = prefixMatch ? prefixMatch[2] : eventId;

    // Try to extract date: yyyy-mm-dd at start
    const dateMatch = rawPart.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    const eventDate = dateMatch ? dateMatch[1] : '';
    const encodedName = dateMatch ? dateMatch[2] : rawPart;
    const eventName = toTitleCase(decodeURIComponent(encodedName).replace(/-/g, ' '));

    const dateStr = eventDate
      ? new Date(eventDate).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
      : '';

    // Use venue/city passed in hash params — avoids re-fetching which can match wrong event
    let venue = decodeURIComponent(hashParams.get('venue') || '');
    let city  = decodeURIComponent(hashParams.get('city')  || '');
    let image = '';

    // Only fetch for image enrichment (Awin) — don't use it for venue/city
    if (!venue || !city) {
      try {
        const awinResp = await fetch(`/api/awin-events?name=${encodeURIComponent(eventName)}&size=5`).catch(() => null);
        if (awinResp?.ok) {
          const awinData = await awinResp.json().catch(() => ({}));
          const match = (awinData.events || []).find(e =>
            !eventDate || !e.date || e.date === eventDate || e.date.startsWith(eventDate)
          ) || (awinData.events || [])[0];
          if (match) {
            venue = venue || match.venue || '';
            city  = city  || match.city  || '';
            image = match.image || '';
          }
        }
      } catch(e) {}
    } else {
      // Venue/city came from hash params — still try to get an image
      // Try Awin first, then TM attraction search as fallback (good for football/sports)
      try {
        const awinResp = await fetch(`/api/awin-events?name=${encodeURIComponent(eventName)}&size=5`).catch(() => null);
        if (awinResp?.ok) {
          const awinData = await awinResp.json().catch(() => ({}));
          const match = (awinData.events || [])[0];
          if (match?.image) image = match.image;
        }
      } catch(e) {}

      // If no Awin image, try TM attractions search for a team/performer image
      if (!image) {
        try {
          const tmAttrResp = await fetch(`/api/ticketmaster?attractionSearch=${encodeURIComponent(eventName.split(' vs ')[0].trim())}&size=1`).catch(() => null);
          if (tmAttrResp?.ok) {
            const tmAttrData = await tmAttrResp.json().catch(() => ({}));
            const imgs = tmAttrData?._embedded?.attractions?.[0]?.images || [];
            const best = imgs.find(i => i.ratio === '16_9' && i.width > 300) || imgs[0];
            if (best?.url) image = best.url;
          }
        } catch(e) {}
      }
    }

    const metaParts = [dateStr, [venue, city].filter(Boolean).join(', ')].filter(Boolean);
    document.getElementById('results-title').textContent = eventName;
    grid.innerHTML = `
      <div class="detail-card">
        ${image ? `<img class="detail-img" src="${image}" alt="${eventName}" />` : ''}
        <div class="detail-body">
          <h3 class="detail-name">${eventName}</h3>
          <div class="detail-meta">${metaParts.join('<br/>')}</div>
        </div>
      </div>
      <div id="detail-compare"></div>
      <div id="detail-hotels"></div>
    `;

    renderComparePrices(
      document.getElementById('detail-compare'),
      eventName, null, '#', city, eventDate, venue
    );

    if (city && eventDate) {
      renderHotelCard(
        document.getElementById('detail-hotels'),
        city, eventDate, venue
      );
    }
    return;
  }

  // Handle Awin-sourced events (no TM ID) — extract name+date from synthetic ID
  if (eventId.startsWith('awin-')) {
    const decoded   = decodeURIComponent(eventId.slice(5));
    const dateMatch = decoded.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    const eventDate = dateMatch ? dateMatch[1] : '';
    // When no date, decoded IS the name (no leading dash)
    const rawName   = dateMatch ? dateMatch[2] : decoded.replace(/^-+/, '');
    const eventName = toTitleCase(rawName);
    const dateStr   = eventDate
      ? new Date(eventDate).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
      : '';

    // Fetch enriched event data from Awin cache to get venue, image etc.
    let venue = '', city = '', image = '';
    try {
      const awinResp = await fetch(`/api/awin-events?name=${encodeURIComponent(eventName)}&size=5`);
      const awinData = await awinResp.json().catch(() => ({}));
      const match = (awinData.events || []).find(e =>
        !eventDate || !e.date || e.date === eventDate || e.date.startsWith(eventDate)
      ) || (awinData.events || [])[0];
      if (match) {
        venue = match.venue || '';
        city  = match.city  || '';
        image = match.image || '';
      }
    } catch(e) {}

    const metaParts = [dateStr, [venue, city].filter(Boolean).join(', ')].filter(Boolean);
    document.getElementById('results-title').textContent = eventName;
    grid.innerHTML = `
      <div class="detail-card">
        ${image ? `<img class="detail-img" src="${image}" alt="${eventName}" />` : ''}
        <div class="detail-body">
          <h3 class="detail-name">${eventName}</h3>
          <div class="detail-meta">${metaParts.join('<br/>')}</div>
        </div>
      </div>
      <div id="detail-compare"></div>
      <div id="detail-hotels"></div>
    `;
    renderComparePrices(
      document.getElementById('detail-compare'),
      eventName, null, '#', city, eventDate, venue
    );

    // Hotel card for Awin events
    if (city && eventDate) {
      renderHotelCard(
        document.getElementById('detail-hotels'),
        city, eventDate, venue
      );
    }
    return;
  }

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
    const eventDate = event.dates?.start?.localDate || '';

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
      <div id="detail-hotels"></div>
    `;

    renderComparePrices(
      document.getElementById('detail-compare'),
      event.name,
      minPrice,
      tmUrl,
      city || 'London',
      eventDate,
      venueName
    );

    // Hotel card — shown when event has a city and date
    if (city && eventDate) {
      renderHotelCard(
        document.getElementById('detail-hotels'),
        city, eventDate, venueName
      );
    }

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
// Title-case a string — capitalises each word, keeping small connectors lowercase
// e.g. "as monaco vs paris saint germain fc" → "As Monaco vs Paris Saint Germain FC"
function toTitleCase(str) {
  const connectors = ['vs', 'v', 'at', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on'];
  const alwaysUpper = ['fc', 'cf', 'ac', 'sc', 'rc', 'asc', 'sco', 'ud', 'rcd', 'afc', 'utd'];
  return (str || '').split(' ').map((word, i) => {
    const w = word.toLowerCase();
    if (alwaysUpper.includes(w)) return w.toUpperCase();
    if (i > 0 && connectors.includes(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}