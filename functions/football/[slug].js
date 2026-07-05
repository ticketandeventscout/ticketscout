// ===========================
// TicketScout — Football URL router
// File location: functions/football/[slug].js
//
// ONLY runs when no static file exists at football/[slug].html
// (Cloudflare Pages static files take priority over functions)
//
// For known clubs, static stub files exist and are served directly.
// This function handles auto-discovered clubs not yet in the static set.
// ===========================

export async function onRequestGet({ request, params }) {
  try {
    const slug = (params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) return Response.redirect('https://www.ticketscout.co.uk/football.html', 302);

    const url         = new URL(request.url);
    const templateUrl = `${url.origin}/football.html`;
    const pageUrl     = `https://www.ticketscout.co.uk/football/${slug}`;

    // Fetch the football.html template
    const templateResp = await fetch(templateUrl, {
      headers: { 'User-Agent': 'TicketScout-Router/1.0' }
    });

    if (!templateResp.ok) {
      return Response.redirect('https://www.ticketscout.co.uk/', 302);
    }

    let html = await templateResp.text();

    // Reconstruct display name from slug
    const name = toTitleCase(slug.replace(/-/g, ' '));
    const desc = `Compare ${name} ticket prices across verified sellers. Find the cheapest ${name} match tickets and buy direct.`;

    // Inject slug and update meta tags server-side
    html = html
      .replace('</head>', `<script>window.__FOOTBALL_SLUG__ = ${JSON.stringify(slug)};</script>\n</head>`)
      .replace(/<title id="page-title">.*?<\/title>/, `<title id="page-title">${escAttr(name)} Tickets — Compare Prices | TicketScout</title>`)
      .replace(/<meta name="description" id="meta-description"[^>]*>/, `<meta name="description" id="meta-description" content="${escAttr(desc)}" />`)
      .replace(/<link rel="canonical" id="canonical"[^>]*>/, `<link rel="canonical" id="canonical" href="${pageUrl}" />`)
      .replace(/<meta property="og:title" id="og-title"[^>]*>/, `<meta property="og:title" id="og-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
      .replace(/<meta property="og:description" id="og-description"[^>]*>/, `<meta property="og:description" id="og-description" content="${escAttr(desc)}" />`)
      .replace(/<meta property="og:url" id="og-url"[^>]*>/, `<meta property="og:url" id="og-url" content="${pageUrl}" />`)
      .replace(/<meta name="twitter:title" id="tw-title"[^>]*>/, `<meta name="twitter:title" id="tw-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
      .replace(/<meta name="twitter:description" id="tw-description"[^>]*>/, `<meta name="twitter:description" id="tw-description" content="${escAttr(desc)}" />`);

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=300'
      }
    });

  } catch (err) {
    // Never show a raw 1101 — redirect to football landing page instead
    return Response.redirect('https://www.ticketscout.co.uk/football.html', 302);
  }
}

function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}

function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}