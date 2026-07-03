// ===========================
// TicketScout — Concert URL router
// Runs as a Cloudflare Pages Function at /concert/[slug]
// File location: functions/concert/[slug].js
//
// This is the correct way to handle clean SEO URLs in Cloudflare Pages.
// A Pages Function at functions/concert/[slug].js automatically handles
// ALL requests to /concert/* and receives the slug as a route parameter.
//
// It fetches concert.html and serves it with the correct Content-Type,
// while the browser URL stays as /concert/coldplay etc.
// The slug is injected into the HTML as a global JS variable so
// concert.html can read it without any URL parsing tricks.
// ===========================

export async function onRequestGet({ request, params, env }) {
  const slug = params.slug;

  if (!slug) {
    return Response.redirect('/', 302);
  }

  // Fetch the concert template from our own origin
  const url = new URL(request.url);
  const templateUrl = `${url.origin}/concert.html`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) {
    return Response.redirect('/', 302);
  }

  let html = await templateResp.text();

  // Inject the slug as a global variable BEFORE the closing </head>
  // so the page JS can read it instantly without URL parsing
  const slugScript = `<script>window.__CONCERT_SLUG__ = ${JSON.stringify(slug.toLowerCase())};</script>`;
  html = html.replace('</head>', `${slugScript}\n</head>`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300' // cache for 5 minutes
    }
  });
}
