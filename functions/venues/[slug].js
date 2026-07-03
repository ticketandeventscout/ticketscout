// ===========================
// TicketScout — Venue URL router
// Runs as a Cloudflare Pages Function at /venue/[slug]
// File location: functions/venue/[slug].js
// ===========================

export async function onRequestGet({ request, params, env }) {
  const slug = params.slug;
  if (!slug) return Response.redirect('/', 302);

  const url = new URL(request.url);
  const templateUrl = `${url.origin}/venue.html`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) return Response.redirect('/', 302);

  let html = await templateResp.text();
  const slugScript = `<script>window.__VENUE_SLUG__ = ${JSON.stringify(slug.toLowerCase())};</script>`;
  html = html.replace('</head>', `${slugScript}\n</head>`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
