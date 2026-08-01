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

    html = html
      .replace('</head>', `<script>window.__VENUE_SLUG__ = ${JSON.stringify(slug)};</script>\n</head>`)
      .replace(/<title id="page-title">.*?<\/title>/, `<title id="page-title">${esc(name)} — Venue Tickets | TicketScout</title>`)
      .replace(/<meta name="description" id="meta-description"[^>]*>/, `<meta name="description" id="meta-description" content="Compare ticket prices for events at ${esc(name)} across verified sellers." />`)
      .replace(/<link rel="canonical" id="canonical"[^>]*>/, `<link rel="canonical" id="canonical" href="${pageUrl}" />`);

    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (e) {
    return new Response('', { status: 302, headers: { Location: '/' } });
  }
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
