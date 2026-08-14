// functions/sports.js   ← REPO DESTINATION (repo-root functions/. Sports has NO
// functions/sports/[slug].js and must never get one — per discover-pages.js's own
// comment: "Creating functions/sports/[slug].js would collide with the /sports/
// static folder and produce Error 1101/522, the same trap documented [for football/
// theatre]." This file is unrelated to that risk: it only ever matches the exact
// bare path /sports, never /sports/*.)
// =============================================================================
// TicketScout — sports HUB (browse-by-team/competitor) page, now server-rendered
// =============================================================================
// Same fix, same rationale, same mechanism as functions/concert.js and
// functions/theatre.js (see concert.js's header for the full history and the
// explicit inference-not-proof flag on env.ASSETS.fetch(<clean-URL-path>) for
// a non-"/" route).
//
// sports.html's hub mode (/sports, no slug) ships #events-container as a
// static "Loading upcoming events…" placeholder; the real grid is built
// entirely by a client-side fetch('/api/sports?list=1') -> renderHub() chain.
// This Function server-renders that same content ahead of any JS running.
//
// sports.html's hub mode ALSO populates two things concert/theatre's hub mode
// does not: a real "About" paragraph (about-text) and a breadcrumb — both
// baked in here too, verbatim from sports.html's own init(), since a non-JS
// crawler currently sees neither.
//
// ROLLBACK: delete this file. sports.html is untouched.
// =============================================================================

const HUB_LIST_ENDPOINT = '/api/sports?list=1';
const CANONICAL_PATH    = '/sports';

// Static defaults already correct for hub mode, confirmed against
// sports.html directly — left untouched:
//   <h1 id="artist-name">   already "Sports Tickets"
const GENRE_BADGE_HUB_TEXT    = 'Sports';
const EVENTS_HEADING_HUB_TEXT = 'Browse by team or competitor';
const ABOUT_HEADING_HUB_TEXT  = 'About sports tickets on TicketScout';
// Verbatim from sports.html's own hub-mode init() — MUST MATCH.
const ABOUT_TEXT_HUB =
  'We compare ticket prices for basketball, ice hockey, boxing, MMA, tennis, ' +
  'rugby, cricket and more across verified resale sellers, so you can see the ' +
  'real get-in price for an event before you buy. Football has its own section.';
const BREADCRUMB_HUB_HTML = '<a href="/">Home</a> \u203a Sports';

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

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    console.error('[sports hub SSR] onRequestGet failed:', String(e));
    return staticFallbackResponse();
  }
}

async function fetchStaticTemplate(request, env, canonicalPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const assetUrl = new URL(canonicalPath, request.url);
    return await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  } catch (e) {
    console.error('[sports hub SSR] env.ASSETS.fetch failed:', String(e));
    return null;
  }
}

function staticFallbackResponse() {
  return new Response(
    `<!DOCTYPE html><html><head><title>Sports Tickets | TicketScout</title></head><body>
     <p>TicketScout is temporarily unable to load the sports listing. Try
     <a href="/">the homepage</a>, <a href="/concert">Concerts</a>,
     <a href="/football">Football</a>, or <a href="/theatre">Theatre</a>.</p>
     </body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}

async function fetchHubList(origin) {
  try {
    const r = await fetch(`${origin}${HUB_LIST_ENDPOINT}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('[sports hub SSR] hub list fetch failed:', String(e));
    return null;
  }
}

// MUST MATCH sports.html's own renderHub()+paintHub()+grid() output for the
// default ("all") filter view.
const CONTAINER_RE = /<div id="events-container">\s*<div class="events-loading">[^<]*<\/div>\s*<\/div>/;

function injectHubGrid(html, hub) {
  if (!CONTAINER_RE.test(html)) return html;
  const inner = buildHubHtml(hub);
  return html.replace(CONTAINER_RE, `<div id="events-container">${inner}</div>`);
}

function injectHeadingText(html) {
  let out = html
    .replace(
      '<div class="artist-genre-badge" id="genre-badge">Loading…</div>',
      `<div class="artist-genre-badge" id="genre-badge">${esc(GENRE_BADGE_HUB_TEXT)}</div>`
    )
    // events-heading carries an inline style attribute in sports.html — kept
    // verbatim, only the text node changes.
    .replace(
      '<h2 id="events-heading" style="font-size:20px;color:#0c2d5a;margin:18px 0 14px;">Upcoming events</h2>',
      `<h2 id="events-heading" style="font-size:20px;color:#0c2d5a;margin:18px 0 14px;">${esc(EVENTS_HEADING_HUB_TEXT)}</h2>`
    )
    .replace(
      '<h2 id="about-heading">About</h2>',
      `<h2 id="about-heading">${esc(ABOUT_HEADING_HUB_TEXT)}</h2>`
    )
    .replace(
      '<p id="about-text"></p>',
      `<p id="about-text">${esc(ABOUT_TEXT_HUB)}</p>`
    )
    .replace(
      '<nav class="breadcrumb" id="breadcrumb" aria-label="Breadcrumb"></nav>',
      `<nav class="breadcrumb" id="breadcrumb" aria-label="Breadcrumb">${BREADCRUMB_HUB_HTML}</nav>`
    );
  return out;
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

// sports.html's own client-side grid() has no city/hub-item-sub branch at
// all (unlike concert/theatre) — matched exactly here, not "improved", so
// SSR output and client-JS output stay identical.
function hubGrid(list) {
  return '<div class="hub-grid">' + list.map(e =>
    '<a class="hub-item" href="' + attr(e.url) + '">' + esc(e.name) + '</a>'
  ).join('') + '</div>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}
function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
