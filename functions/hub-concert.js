// functions/concert.js   ← REPO DESTINATION (repo-root functions/, NOT functions/api/,
// and NOT inside the existing functions/concert/ folder — this is a sibling FILE next
// to that folder. functions/concert/[slug].js keeps handling /concert/{slug} completely
// unchanged; this file only ever matches the exact bare path /concert.)
// =============================================================================
// TicketScout — concert HUB (browse-by-artist) page, now server-rendered
// =============================================================================
//
// WHY THIS EXISTS (10 Aug 2026, Session 18's "next session centrepiece" item)
// -----------------------------------------------------------------------------
// /concert (no slug) is concert.html's HUB MODE: "Browse by artist". Until
// this file, #events-container shipped as a single static
// "Loading upcoming dates…" placeholder — the real artist grid (genre pills +
// every artist link) was built entirely by concert.html's own loadHub() ->
// renderHub() -> paintHub() chain, which only runs after the browser fetches
// /api/concert?list=1 client-side. Robots.txt's /api/ block was already lifted
// this session (H1, closed Session 16) so that fetch is no longer BLOCKED —
// but it still requires a crawler to execute JS and wait on a second
// round-trip before any of the ~2,600+ artist links exist in the DOM. Exactly
// the same class of defect the homepage had (its own #events-grid was an
// empty "Loading events…" div before functions/index.js), just one level
// down the site hierarchy.
//
// football.html's hub is NOT affected by this — its /football grid (all 117
// clubs) is baked directly into the static template at commit time already
// ("Static hub content ships in the template HTML — nothing to render here",
// football.html's own init() comment). Only concert/theatre/sports use the
// client-fetch loadHub() pattern for their hub view, so only those three get
// a matching Function (functions/theatre.js, functions/sports.js — same
// pattern, ship together).
//
// MECHANISM — same as functions/index.js, ONE DIFFERENCE FLAGGED BELOW:
//   env.ASSETS.fetch() reaches the static asset directly, bypassing Pages
//   Functions routing entirely — the same documented mechanism that took
//   four rounds to land correctly for the homepage. That work proved:
//     - fetch(request) or fetch('/index.html') as a normal request both loop
//       back into whatever Function is bound to that exact path — NEVER do
//       either of those here.
//     - env.ASSETS.fetch('/index.html') returned an UNFOLLOWED 308 (redirects
//       to canonical "/"); env.ASSETS.fetch('/') returned a clean 200. The
//       working rule was: request the CANONICAL clean-URL path, not a
//       filename with an extension.
//   /concert (this route) is already the canonical, already-linked,
//   already-indexed clean-URL path — the same *shape* as "/", not the same
//   shape as "/index.html" (no extension, matches M2's standardised
//   no-trailing-slash hub URL exactly). Requesting env.ASSETS.fetch('/concert')
//   is therefore expected to behave like the homepage's "/" case, not its
//   "/index.html" case.
//
//   ⚠ THIS IS INFERENCE FROM THE SAME PLATFORM'S PROVEN BEHAVIOUR, NOT A
//   LIVE-TESTED FACT FOR THIS SPECIFIC PATH. Per the standing rule from the
//   homepage saga ("either test the actual failure path directly, or say
//   plainly that a specific piece is inference rather than proof"): this has
//   NOT been tested live. See hub-ssr-diagnostic.js (deploy to a disposable
//   route, e.g. functions/concert-hub-test.js -> /concert-hub-test, FIRST)
//   and the test plan in this session's handover before promoting this file
//   into the live /concert route.
//
// ROLLBACK: delete this file (or rename it back out of functions/). concert.html
// is untouched — Cloudflare goes straight back to serving it statically with
// its original empty-then-JS-filled hub, exactly as before this existed.
//
// The client-side loadHub()->renderHub() chain still runs afterward exactly
// as before and OVERWRITES box.innerHTML wholesale with its own freshly
// fetched data (this is a full replace, not a hydrate-in-place — confirmed
// from concert.html's own renderHub(), which does `box.innerHTML = pills + ...`
// unconditionally). This only changes what's in the HTML BEFORE that JS runs.
// =============================================================================

const HUB_LIST_ENDPOINT = '/api/concert?list=1';
const CANONICAL_PATH    = '/concert';

// Static defaults already correct for hub mode, confirmed against
// concert.html directly — left untouched:
//   <h1 id="artist-name">           already "Concert Tickets"
//   <p id="artist-sub">             already "Compare ticket prices across verified sellers"
//   <h2 id="faq-heading">           already "Frequently asked questions"
// Only these three are entity-page defaults that read wrong on the hub and
// get corrected below, exactly matching what the client's own init() sets
// in hub mode (concert.html, hub-mode branch):
const GENRE_BADGE_HUB_TEXT   = 'Concerts';
const EVENTS_HEADING_HUB_TEXT = 'Browse by artist';
const ABOUT_HEADING_HUB_TEXT  = 'About concert tickets on TicketScout';

export async function onRequestGet({ request, env }) {
  try {
    const templateResp = await fetchStaticTemplate(request, env, CANONICAL_PATH);
    if (!templateResp || !templateResp.ok) return staticFallbackResponse();

    let html = await templateResp.text();
    const hub = await fetchHubList(new URL(request.url).origin);

    if (hub && Array.isArray(hub.entities) && hub.entities.length) {
      html = injectHubGrid(html, hub);
      html = injectHeadingText(html);
    }
    // Empty/failed hub fetch -> html returned exactly as the static template
    // shipped it (still a valid page, still has its "Loading…" placeholder
    // for client JS to fill) — never worse than today, only sometimes better.

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    console.error('[concert hub SSR] onRequestGet failed:', String(e));
    return staticFallbackResponse();
  }
}

// Identical mechanism to functions/index.js's fetchStaticIndexHtml() — see
// that file's own header for the four-round history of why THIS is the
// correct call shape. Falls back to null on any failure; caller treats that
// the same as any other failure (safe static response, never a loop).
async function fetchStaticTemplate(request, env, canonicalPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const assetUrl = new URL(canonicalPath, request.url);
    return await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  } catch (e) {
    console.error('[concert hub SSR] env.ASSETS.fetch failed:', String(e));
    return null;
  }
}

// Genuinely safe fallback: no fetch, nothing that could itself fail or loop.
function staticFallbackResponse() {
  return new Response(
    `<!DOCTYPE html><html><head><title>Concert Tickets | TicketScout</title></head><body>
     <p>TicketScout is temporarily unable to load the concert listing. Try
     <a href="/">the homepage</a>, <a href="/football">Football</a>,
     <a href="/theatre">Theatre</a>, or <a href="/sports">Sports</a>.</p>
     </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}

// Calls /api/concert?list=1 SERVER-SIDE — the exact same endpoint and same
// KV-cached hub index (concert:hub:index, 30h TTL) concert.html's client-side
// loadHub() already calls, so this can only ever show what's already proven
// correct, never a second independent approximation of it. One read, edge
// side, same cost class as the homepage's /api/trending call.
async function fetchHubList(origin) {
  try {
    const r = await fetch(`${origin}${HUB_LIST_ENDPOINT}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('[concert hub SSR] hub list fetch failed:', String(e));
    return null;
  }
}

// Replaces the static "Loading upcoming dates…" placeholder with real,
// crawlable markup. MUST MATCH concert.html's own renderHub()+paintHub()+
// hubGrid() output for the default ("all") filter view — byte-identical
// class names/structure, so the client JS's own full-innerHTML overwrite on
// top of this produces zero visible flash/layout shift on real browsers.
const CONTAINER_RE = /<div id="events-container">\s*<div class="events-loading">[^<]*<\/div>\s*<\/div>/;

function injectHubGrid(html, hub) {
  if (!CONTAINER_RE.test(html)) return html; // template shape changed — never guess, leave untouched
  const inner = buildHubHtml(hub);
  return html.replace(CONTAINER_RE, `<div id="events-container">${inner}</div>`);
}

function injectHeadingText(html) {
  return html
    .replace(
      '<div class="artist-genre-badge" id="genre-badge">Loading…</div>',
      `<div class="artist-genre-badge" id="genre-badge">${esc(GENRE_BADGE_HUB_TEXT)}</div>`
    )
    .replace(
      '<h2 id="events-heading">Upcoming dates</h2>',
      `<h2 id="events-heading">${esc(EVENTS_HEADING_HUB_TEXT)}</h2>`
    )
    .replace(
      '<h2 id="about-heading">About the artist</h2>',
      `<h2 id="about-heading">${esc(ABOUT_HEADING_HUB_TEXT)}</h2>`
    );
}

function buildHubHtml(data) {
  const entities = data.entities || [];
  const genres   = data.genres || [];

  const pills = '<div class="genre-pills">' +
    '<button class="genre-pill is-active" data-g="all">All' +
      '<span class="genre-count">' + (data.count ?? entities.length) + '</span></button>' +
    genres.map(g =>
      '<button class="genre-pill" data-g="' + attr(g.genre) + '">' +
        esc(g.genre) + '<span class="genre-count">' + g.count + '</span></button>'
    ).join('') +
    '</div>';

  const groups = {};
  for (const e of entities) (groups[e.genre] = groups[e.genre] || []).push(e);

  const results = genres.map(g => {
    const list = groups[g.genre];
    if (!list || !list.length) return '';
    return '<h3 class="genre-heading">' + esc(g.genre) +
      ' <span class="genre-count-inline">' + list.length + '</span></h3>' + hubGrid(list);
  }).join('');

  const note = data.truncated
    ? '<div class="hub-note">Showing the first ' + (data.count ?? entities.length) + ' of ' +
      data.totalRegistered + ' — the rest are in the sitemap.</div>'
    : '';

  return pills + '<div id="hub-results">' + results + '</div>' + note;
}

function hubGrid(list) {
  return '<div class="hub-grid">' + list.map(e => {
    // Artists don't carry a city in this payload today — kept for parity
    // with concert.html's own hubGrid(), which guards the same way.
    const sub = e.city
      ? '<span class="hub-item-sub">' + esc([e.city, e.country].filter(Boolean).join(', ')) + '</span>'
      : '';
    return '<a class="hub-item" href="' + attr(e.url) + '">' + esc(e.name) + sub + '</a>';
  }).join('') + '</div>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}
function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
