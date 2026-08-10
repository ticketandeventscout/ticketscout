// functions/homepage-test.js — DISPOSABLE TEST COPY, maps to /homepage-test
// =============================================================================
// Byte-identical logic to homepage-index.js (the real functions/index.js
// candidate). Deployed at a throwaway path so the mechanism can be proven
// against real production data before it goes anywhere near "/" — the same
// staged-test approach that worked for the sitemap.xml fix, and that
// skipping cost a live homepage outage on this feature's first attempt.
//
// SECOND FIX ROUND (10 Aug 2026) — the first working version of this file
// queried event_pages directly:
//     SELECT ... FROM event_pages WHERE source='tm' ORDER BY updated_at DESC
// That query has no geographic scoping at all, and event_pages is written
// to by MORE than trending.js — the TM entity sweep tool (built earlier
// this session) also writes source='tm' rows while cursoring through the
// FULL registry, which includes international artists with no UK
// relevance (confirmed live: the raw query surfaced Portland and San
// Francisco shows for touring band Bailen). There is no way to tell "this
// row came from trending.js's own UK-scoped pull" from "this row came from
// the sweep tool" using the source column alone — both legitimately say
// 'tm'.
//
// FIX: stop trying to filter event_pages after the fact. /api/trending
// (see trending.js) already does the real filtering correctly —
// countryCode=GB is set directly on its own TM fetch — and is EXACTLY what
// the client-side widget this replaces calls. So this Function now calls
// that same endpoint server-side and renders whatever it returns, which
// guarantees identical results to what's already proven correct on the
// live homepage, rather than a second, independently-derived approximation
// of it that can silently disagree.
//
// TEST PLAN:
//   1. Deploy ONLY this file. Do not touch functions/index.js or
//      index.html — nothing else on the site links to /homepage-test, so
//      the real homepage is completely unaffected by anything here.
//   2. Visit https://ticketscout.co.uk/homepage-test
//   3. Confirm: real event cards, UK-relevant (compare directly against
//      what / currently shows — should be the same events, not merely
//      "some real events"), correct /event/{slug} links, no error.
//   4. Only once confirmed: copy this file's logic into functions/index.js
//      to go live, and delete this test file afterward.
// =============================================================================

export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
  try {
    const templateResp = await fetch(`${origin}/index.html`);
    // No recursive fetch(request) anywhere in this file — that was the
    // actual cause of the first outage (see homepage-index.js's own
    // history for the full account). Every fallback here is either a
    // fetch to a genuinely different, explicit URL, or a fetch-free
    // static string.
    if (!templateResp.ok) return staticFallbackResponse();

    let html = await templateResp.text();
    const cardsHtml = await buildTrendingCardsHtml(origin);

    if (cardsHtml) {
      html = html.replace(
        /<div class="events-grid" id="events-grid">[\s\S]*?<\/div>\s*<\/section>/,
        `<div class="events-grid" id="events-grid">${cardsHtml}</div>\n  </section>`
      );
    }
    // Empty cardsHtml (trending fetch failed, or genuinely no events) means
    // html is returned completely unmodified — original loading state and
    // its fallback link list stay exactly as they were. Never worse than
    // today, only sometimes better.

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    console.error('[homepage SSR] onRequestGet failed:', String(e));
    return staticFallbackResponse();
  }
}

// Genuinely safe fallback: no fetch, no dependency on anything that could
// itself fail or loop.
function staticFallbackResponse() {
  return new Response(
    `<!DOCTYPE html><html><head><title>TicketScout</title></head><body>
     <p>TicketScout is temporarily unable to load the homepage content. Try
     <a href="/concert">Concerts</a>, <a href="/football">Football</a>,
     <a href="/theatre">Theatre</a>, or <a href="/sports">Sports</a>.</p>
     </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}

// Calls /api/trending SERVER-SIDE — the exact same endpoint the client-side
// widget calls, so this can only ever show what's already proven correct,
// never a second independent approximation of it.
async function buildTrendingCardsHtml(origin) {
  try {
    const r = await fetch(`${origin}/api/trending`);
    if (!r.ok) return '';
    const data = await r.json();
    const events = (data && data._embedded && data._embedded.events) || [];
    if (!events.length) return '';
    return events.slice(0, 24).map(e => buildCard(e)).filter(Boolean).join('\n');
  } catch (e) {
    console.error('[homepage SSR] /api/trending fetch failed:', String(e));
    return '';
  }
}

function buildCard(e) {
  const name = e.name || 'Event';
  const iso = (e.dates && e.dates.start && e.dates.start.localDate) || '';
  const venue = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || null;
  const location = venue ? [venue.name, venue.city && venue.city.name].filter(Boolean).join(' · ') : '';
  const dateStr = prettyDate(iso);
  const image = (e.images && e.images[0] && e.images[0].url) || null;
  const pr = e.priceRanges && e.priceRanges[0];
  const priceDisplay = (pr && pr.min != null)
    ? `From ${currencySymbol(pr.currency)}${Math.round(pr.min)}`
    : 'Check site for prices';

  // Same slug derivation as events.js's client-side card builder — reusing
  // tsTmCategory/normaliseFixtureName/tsEventSlug from THIS SAME FILE
  // (trending.js's own copies, already proven to match what the backend
  // registers into event_pages) rather than re-deriving the logic a third
  // time in yet another file.
  const category = tsTmCategory(e);
  const slug = (category && iso) ? tsEventSlug(category, iso, normaliseFixtureName(name)) : null;
  const href = slug ? `/event/${slug}` : null;
  if (!href) return ''; // no reliable link — skip rather than render a dead card

  const imgHtml = image
    ? `<img class="event-img" src="${esc(image)}" alt="${esc(name)}" loading="lazy" />`
    : `<div class="event-img-placeholder">🎟️</div>`;

  return `
    <a class="event-card" href="${esc(href)}">
      ${imgHtml}
      <div class="event-body">
        <div class="event-name">${esc(name)}</div>
        <div class="event-meta">
          ${location ? `${esc(location)}<br/>` : ''}
          ${esc(dateStr)}
        </div>
        <div class="event-price">${priceDisplay}</div>
        <span class="compare-badge">Compare prices →</span>
      </div>
    </a>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function prettyDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return iso; }
}

function currencySymbol(c) {
  return { GBP: '£', USD: '$', EUR: '€', PLN: 'zł', CHF: 'CHF ', CAD: 'C$', AUD: 'A$', SGD: 'S$' }[(c || 'GBP').toUpperCase()] || '';
}

// ── Byte-identical copies of trending.js's own helpers ──────────────────
// Reused, not re-derived, so this can never silently drift from what the
// backend actually registers into event_pages (see trending.js for the
// canonical versions and the "MUST MATCH" convention this codebase already
// uses across ticketmaster.js / awin-events.js / sportsevents365.js).

function tsTmCategory(event) {
  const seg = event && event.classifications && event.classifications[0] && event.classifications[0].segment && event.classifications[0].segment.name || '';
  const genre = event && event.classifications && event.classifications[0] && event.classifications[0].genre && event.classifications[0].genre.name || '';
  if (seg === 'Sports') return (genre === 'Soccer') ? 'football' : 'sports';
  if (seg === 'Music') return 'concert';
  if (seg === 'Arts & Theatre') return 'theatre';
  return null;
}

function normaliseFixtureName(name) {
  let n = String(name || '');
  const COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (const p of COMPETITION_PREFIXES) {
    const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');
  const stripSuffix = (side) => side
    .replace(/\./g, '')
    .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
    .trim();
  const parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    const sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort((a, b) => a.localeCompare(b));
    n = sides[0] + ' vs ' + sides[1];
  }
  return n.trim();
}

function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}