// functions/theatre.js   ← REPO DESTINATION (repo-root functions/, sibling to the
// existing functions/venue/[slug].js etc. Theatre has NO functions/theatre/[slug].js
// — per HARD RULES that must never be created (folder-collision 1101/522 trap with
// the static theatre/ stub folder). This file is unrelated to that: it only ever
// matches the exact bare path /theatre, never /theatre/*.)
// =============================================================================
// TicketScout — theatre HUB (browse-by-show) page, now server-rendered
// =============================================================================
// Same fix, same rationale, same mechanism as functions/concert.js (see that
// file's header for the full history and the explicit inference-not-proof
// flag on env.ASSETS.fetch(<clean-URL-path>) for a non-"/" route) — ported
// here rather than re-derived, per this codebase's own convention (theatre's
// client-side renderHub()/paintHub()/hubGrid() in theatre.html even carries
// the comment "ported from sports.html").
//
// theatre.html's hub mode (/theatre, no slug) ships #events-container as a
// static "Loading upcoming performances…" placeholder; the real show grid is
// built entirely by loadHub('/api/theatre?list=1', 'Theatre') client-side.
// This Function server-renders that same content ahead of any JS running.
//
// ROLLBACK: delete this file. theatre.html is untouched.
// =============================================================================

const HUB_LIST_ENDPOINT = '/api/theatre?list=1';
const CANONICAL_PATH    = '/theatre';

// Static defaults already correct for hub mode, confirmed against
// theatre.html directly — left untouched:
//   <h1 id="artist-name">   already "Theatre Tickets"
//   <p id="artist-sub">     already "Compare West End and theatre ticket prices across verified sellers"
//   <h2 id="faq-heading">   already "Frequently asked questions"
const GENRE_BADGE_HUB_TEXT    = 'Theatre';
const EVENTS_HEADING_HUB_TEXT = 'Browse by show';
const ABOUT_HEADING_HUB_TEXT  = 'About theatre tickets on TicketScout';

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
    console.error('[theatre hub SSR] onRequestGet failed:', String(e));
    return staticFallbackResponse();
  }
}

async function fetchStaticTemplate(request, env, canonicalPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const assetUrl = new URL(canonicalPath, request.url);
    return await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  } catch (e) {
    console.error('[theatre hub SSR] env.ASSETS.fetch failed:', String(e));
    return null;
  }
}

function staticFallbackResponse() {
  return new Response(
    `<!DOCTYPE html><html><head><title>Theatre Tickets | TicketScout</title></head><body>
     <p>TicketScout is temporarily unable to load the theatre listing. Try
     <a href="/">the homepage</a>, <a href="/concert">Concerts</a>,
     <a href="/football">Football</a>, or <a href="/sports">Sports</a>.</p>
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
    console.error('[theatre hub SSR] hub list fetch failed:', String(e));
    return null;
  }
}

// MUST MATCH theatre.html's own renderHub()+paintHub()+hubGrid() output for
// the default ("all") filter view.
const CONTAINER_RE = /<div id="events-container">\s*<div class="events-loading">[^<]*<\/div>\s*<\/div>/;

function injectHubGrid(html, hub) {
  if (!CONTAINER_RE.test(html)) return html;
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
      '<h2 id="events-heading">Upcoming performances</h2>',
      `<h2 id="events-heading">${esc(EVENTS_HEADING_HUB_TEXT)}</h2>`
    )
    .replace(
      '<h2 id="about-heading">About the show</h2>',
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
    // Shows don't carry a city in this payload today — kept for parity with
    // theatre.html's own hubGrid(), which guards the same way (its comment:
    // "Venues carry a city; artists and shows do not.").
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
