// functions/index.js
// =============================================================================
// TicketScout — homepage, now server-rendered
// =============================================================================
//
// WHY THIS EXISTS (9 Aug 2026, technical SEO audit's #1 finding)
// -----------------------------------------------------------------------------
// Previously index.html was a static file with an EMPTY #events-grid div —
// just a "Loading events…" placeholder, with real event cards injected
// entirely by trending.js's client-side fetch. A crawler that doesn't run JS
// (or renders with any friction) sees no actual event content on the site's
// highest-traffic page. There was already a hand-written fallback link list
// buried in that loading state (a handful of hardcoded artist/team links) —
// a real but partial mitigation: static, never updates, and carries no real
// event data (dates, prices, images) at all.
//
// THE FIX DOESN'T NEED A NEW DATA SOURCE. trending.js's own registration
// hook (added earlier this session for an unrelated LCP fix) already writes
// real, fresh TM event data into event_pages every time it runs — that data
// already exists and is already current. This Function just reads it and
// renders real cards into the initial HTML, instead of nothing.
//
// The client-side trending.js fetch still runs afterward exactly as before
// and will overwrite this with its own live-fetched cards, same behaviour
// as today — this only changes what's in the HTML BEFORE that JS runs.
//
// CARD MARKUP deliberately matches events.js's renderEventCards() output
// byte-for-byte (same classes: event-card, event-img/event-img-placeholder,
// event-body, event-name, event-meta, event-price, compare-badge) so there
// is no visual flash or layout jump when the client-side version replaces
// it a moment later.
//
// SLUG FORMAT: /event/{slug} links use exactly what event_pages already
// stores — no re-derivation, no risk of drifting from the slug the backend
// actually registered and the sitemap actually lists.
//
// ⚠️ ROUTING RISK, READ BEFORE ASSUMING THIS WORKS: this project's own
// _redirects file already documents (see the SITEMAP INDEX section) that on
// this specific Cloudflare Pages deployment, a Pages Function did NOT get
// used at another path (functions/sitemap.xml.js never mapped to
// /sitemap.xml) even though the equivalent pattern is standard Cloudflare
// behaviour. The root path "/" is a different case from a named file like
// sitemap.xml, so this is not necessarily the same failure — but it has not
// been tested, and per that same lesson, don't assume either way.
//
// This is LOW-RISK TO TEST DIRECTLY, unlike that earlier case: index.html
// is deliberately left in place untouched. If this Function isn't used for
// "/", Cloudflare simply keeps serving the existing static index.html
// exactly as it does today — worst case is no change at all, not a broken
// homepage. If it DOES 404 or error instead of falling back, delete this
// file and the site is back to exactly today's behaviour immediately.
// =============================================================================

export async function onRequestGet({ request, env }) {
  try {
    const origin = new URL(request.url).origin;
    const templateResp = await fetch(`${origin}/index.html`);
    if (!templateResp.ok) return fetch(request); // fall through to static serving

    let html = await templateResp.text();
    const cardsHtml = await buildTrendingCardsHtml(env);

    if (cardsHtml) {
      // Replace the ENTIRE #events-grid block, loading state included —
      // the fallback link list inside it becomes redundant once this
      // renders real cards, and leaving both would be confusing duplicate
      // content in the initial HTML.
      html = html.replace(
        /<div class="events-grid" id="events-grid">[\s\S]*?<\/div>\s*<\/section>/,
        `<div class="events-grid" id="events-grid">${cardsHtml}</div>\n  </section>`
      );
    }
    // If cardsHtml is empty (no D1 binding, query failed, or genuinely no
    // rows yet), html is returned completely unmodified — the original
    // loading state and its fallback link list stay exactly as they were.
    // Never worse than today, only sometimes better.

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    // Any failure at all — fetch the static file directly rather than
    // risk serving a broken homepage.
    return fetch(request);
  }
}

async function buildTrendingCardsHtml(env) {
  const db = env.PRICE_DB;
  if (!db) return '';
  try {
    // source='tm' specifically: these are the events trending.js's
    // registration hook writes, itself sourced from TM's own
    // relevance-sorted top segments — a real, if imperfect, proxy for
    // "trending" without needing a dedicated trending flag anywhere.
    // Most-recently-updated first, since trending.js only touches a row
    // again when TM's own top results still include it.
    const { results } = await db.prepare(
      `SELECT slug, category, name, event_date, venue, city, price, currency, image
       FROM event_pages
       WHERE source = 'tm' AND event_date >= date('now')
       ORDER BY updated_at DESC LIMIT 24`
    ).all();
    if (!results || !results.length) return '';

    return results.map(r => buildCard(r)).join('\n');
  } catch (e) {
    console.error('[homepage SSR] trending query failed:', String(e));
    return '';
  }
}

function buildCard(r) {
  const href = `/event/${esc(r.slug)}`;
  const dateStr = prettyDate(r.event_date);
  const location = [r.venue, r.city].filter(Boolean).join(' · ');
  const priceDisplay = r.price ? `From ${currencySymbol(r.currency)}${Math.round(r.price)}` : 'Check site for prices';
  const imgHtml = r.image
    ? `<img class="event-img" src="${esc(r.image)}" alt="${esc(r.name)}" loading="lazy" />`
    : `<div class="event-img-placeholder">🎟️</div>`;

  return `
    <a class="event-card" href="${href}">
      ${imgHtml}
      <div class="event-body">
        <div class="event-name">${esc(r.name)}</div>
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
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return iso || ''; }
}

function currencySymbol(c) {
  return { GBP: '£', USD: '$', EUR: '€', PLN: 'zł', CHF: 'CHF ', CAD: 'C$', AUD: 'A$', SGD: 'S$' }[(c || 'GBP').toUpperCase()] || '';
}