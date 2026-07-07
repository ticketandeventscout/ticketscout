// ===========================
// TicketScout — Venue URL router  
// File location: functions/venue/[slug].js
// ===========================

export async function onRequestGet({ request, params }) {
  try {
    const slug = (params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) return new Response('', { status: 302, headers: { Location: '/' } });

    const url         = new URL(request.url);
    const templateUrl = `${url.origin}/venue.html`;
    const pageUrl     = `https://www.ticketscout.co.uk/venue/${slug}`;
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
