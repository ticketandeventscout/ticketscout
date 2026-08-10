// functions/homepage-test.js — DISPOSABLE TEST COPY, maps to /homepage-test
// =============================================================================
// Byte-identical logic to homepage-index.js (the real functions/index.js
// candidate), deployed at a throwaway path instead of the real homepage —
// the same staged-test approach that worked for the sitemap.xml fix
// earlier this session. functions/index.js took the live homepage down on
// its first deploy (see homepage-index.js's own header for the full story);
// this file exists so the same core logic can be proven working against
// real production data at zero risk before it goes anywhere near "/" again.
//
// TEST PLAN:
//   1. Deploy ONLY this file. Do not touch functions/index.js or
//      index.html — the real homepage is completely unaffected by
//      anything in this file, since nothing else on the site links to
//      or depends on /homepage-test.
//   2. Visit https://ticketscout.co.uk/homepage-test
//   3. Confirm: the page loads without error, shows real event cards
//      (names/dates/venues/prices, not "Loading events…"), the rest of
//      the page (nav, footer, etc.) looks normal, and view-source shows
//      the cards already present in the raw HTML (not injected by JS).
//   4. Only once all of that is confirmed: copy this file's logic into
//      functions/index.js (or just rename/redeploy) to go live on the
//      real homepage, and delete this test file afterward.
// =============================================================================

export async function onRequestGet({ request, env }) {
  const origin = new URL(request.url).origin;
  try {
    const templateResp = await fetch(`${origin}/index.html`);
    // FIX (10 Aug 2026, live incident): the previous version did
    // `return fetch(request)` here as a "fallback to static serving". That
    // is NOT safe — `request` is the SAME incoming request for "/", inside
    // the Function already bound to "/", so fetching it again very likely
    // re-invokes this same Function rather than falling through to the
    // static file. That self-reference took the homepage down entirely on
    // first deploy. There is no dangerous fallback left anywhere in this
    // file now — every path either returns real content fetched from the
    // explicit /index.html URL (a genuinely different path, already proven
    // safe by the main content fetch two lines above) or, if that fetch
    // itself fails, a minimal built-in string that needs no fetch at all.
    if (!templateResp.ok) return staticFallbackResponse();

    let html = await templateResp.text();
    const cardsHtml = await buildTrendingCardsHtml(env);

    if (cardsHtml) {
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
    console.error('[homepage SSR] onRequestGet failed:', String(e));
    return staticFallbackResponse();
  }
}

// Genuinely safe fallback: no fetch, no dependency on anything that could
// itself fail or loop. A minimal, valid page that at least lets a visitor
// navigate the site, used only if fetching /index.html itself somehow
// fails — which the main content path already handles without ever
// reaching this function in the normal case.
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
