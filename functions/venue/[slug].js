// ===========================
// TicketScout — Venue URL router  
// File location: functions/venue/[slug].js
// ===========================

export async function onRequestGet({ request, params, env }) {
  try {
    const slug = (params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) return new Response('', { status: 302, headers: { Location: '/' } });

    // FIX (1 Aug 2026): same issue as functions/concert/[slug].js — this
    // Function intercepts EVERY /venue/{slug} request regardless of
    // whether a static file exists at that path, so a redirect-stub .html
    // file written by mergefragments/fix-categories for a merged/renamed
    // slug is never actually served; this Function always renders a full,
    // independent page instead. This check runs first and is the only
    // thing that makes a real HTTP 301 happen for a merged/renamed venue
    // slug. Same shared key scheme as concert's fix: value is a full
    // "category/slug" path, not a bare slug, since fix-categories can move
    // an entity to a different category.
    try {
      const kv = env.GIGSBERG_KV;
      if (kv) {
        const destPath = await kv.get(`redirectSlug:venue:${slug}`);
        if (destPath) {
          return Response.redirect(`https://ticketscout.co.uk/${destPath}`, 301);
        }
      }
    } catch { /* redirect lookup failing should never break the normal page */ }

    const url         = new URL(request.url);
    const templateUrl = `${url.origin}/venue.html`;
    const pageUrl     = `https://ticketscout.co.uk/venue/${slug}`;
    const name        = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

    const templateResp = await fetch(templateUrl);
    if (!templateResp || !templateResp.ok) {
      return new Response('', { status: 302, headers: { Location: '/' } });
    }

    let html = await templateResp.text();

    const description = `Compare ticket prices for events at ${name} across verified sellers.`;
    const title       = `${name} — Venue Tickets | TicketScout`;

    // L3 (9 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): venue pages had NO
    // og:* or twitter:* tags at all — zero social preview when shared.
    // Unlike the concert/football/theatre templates, venue.html has no
    // placeholder tags with IDs to .replace() into, so these are injected
    // fresh at the </head> boundary instead (same insertion point as the
    // __VENUE_SLUG__ script below).
    //
    // NOTE on the image filename: the actual asset in the repo root is
    // 'ogdefault.png' (no hyphen) — confirmed by directory listing, and
    // it's what _slug_.js correctly uses. concert.html / football.html /
    // theatre.html / sports.html all reference 'og-default.png' WITH a
    // hyphen, which does not exist — so those four templates are currently
    // serving a broken og:image and very likely showing no preview image
    // when shared. Using the correct name here rather than copying the
    // broken one; the other four are a separate fix worth doing.
    const socialTags = [
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="TicketScout" />`,
      `<meta property="og:title" id="og-title" content="${esc(title)}" />`,
      `<meta property="og:description" id="og-description" content="${esc(description)}" />`,
      `<meta property="og:url" id="og-url" content="${pageUrl}" />`,
      `<meta property="og:image" id="og-image" content="https://ticketscout.co.uk/ogdefault.png" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" id="tw-title" content="${esc(title)}" />`,
      `<meta name="twitter:description" id="tw-description" content="${esc(description)}" />`,
      `<meta name="twitter:image" id="tw-image" content="https://ticketscout.co.uk/ogdefault.png" />`
    ].join('\n  ');

    html = html
      .replace('</head>', `  ${socialTags}\n<script>window.__VENUE_SLUG__ = ${JSON.stringify(slug)};</script>\n</head>`)
      .replace(/<title id="page-title">.*?<\/title>/, `<title id="page-title">${esc(title)}</title>`)
      .replace(/<meta name="description" id="meta-description"[^>]*>/, `<meta name="description" id="meta-description" content="${esc(description)}" />`)
      .replace(/<link rel="canonical" id="canonical"[^>]*>/, `<link rel="canonical" id="canonical" href="${pageUrl}" />`);

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    return new Response('', { status: 302, headers: { Location: '/' } });
  }
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }