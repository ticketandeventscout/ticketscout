// ===========================
// TicketScout — Football URL router
// File location: functions/football/[slug].js
//
// Fetches football.html fresh on every request and injects the slug.
// This means updating football.html instantly updates ALL football pages —
// no need to regenerate static files when the template changes.
//
// IMPORTANT: This file MUST exist for the fetch pattern to work.
// Without it, Cloudflare serves the static football/[slug].html directly,
// bypassing this router. With it, this router takes priority for any slug
// that doesn't have a matching static file, AND static files still work
// for slugs that do have them (Cloudflare prefers static over function).
//
// Wait — actually Cloudflare Pages static files take priority over functions.
// So we need to ALSO replace static files with lightweight stubs that just
// set window.__FOOTBALL_SLUG__ and let football.html do the work.
// See: the lightweight stub generator script.
// ===========================

const TEAMS = [
  { slug: 'arsenal',             name: 'Arsenal',                 genre: 'Football' },
  { slug: 'chelsea',             name: 'Chelsea',                 genre: 'Football' },
  { slug: 'liverpool',           name: 'Liverpool',               genre: 'Football' },
  { slug: 'manchester-united',   name: 'Manchester United',       genre: 'Football' },
  { slug: 'manchester-city',     name: 'Manchester City',         genre: 'Football' },
  { slug: 'tottenham',           name: 'Tottenham Hotspur',       genre: 'Football' },
  { slug: 'newcastle',           name: 'Newcastle United',        genre: 'Football' },
  { slug: 'aston-villa',         name: 'Aston Villa',             genre: 'Football' },
  { slug: 'west-ham',            name: 'West Ham United',         genre: 'Football' },
  { slug: 'brighton',            name: 'Brighton & Hove Albion',  genre: 'Football' },
  { slug: 'everton',             name: 'Everton',                 genre: 'Football' },
  { slug: 'fulham',              name: 'Fulham',                  genre: 'Football' },
  { slug: 'brentford',           name: 'Brentford',               genre: 'Football' },
  { slug: 'crystal-palace',      name: 'Crystal Palace',          genre: 'Football' },
  { slug: 'nottingham-forest',   name: 'Nottingham Forest',       genre: 'Football' },
  { slug: 'leeds-united',        name: 'Leeds United',            genre: 'Football' },
  { slug: 'wolves',              name: 'Wolverhampton Wanderers', genre: 'Football' },
  { slug: 'rangers',             name: 'Rangers',                 genre: 'Football' },
  { slug: 'celtic',              name: 'Celtic',                  genre: 'Football' },
  { slug: 'leicester-city',      name: 'Leicester City',          genre: 'Football' },
  { slug: 'southampton',         name: 'Southampton',             genre: 'Football' },
  { slug: 'ipswich',             name: 'Ipswich Town',            genre: 'Football' },
  { slug: 'bournemouth',         name: 'Bournemouth',             genre: 'Football' },
  { slug: 'sheffield-united',    name: 'Sheffield United',        genre: 'Football' },
  { slug: 'sheffield-wednesday', name: 'Sheffield Wednesday',     genre: 'Football' },
  { slug: 'sunderland',          name: 'Sunderland',              genre: 'Football' },
  { slug: 'middlesbrough',       name: 'Middlesbrough',           genre: 'Football' },
  { slug: 'hearts',              name: 'Heart of Midlothian',     genre: 'Football' },
  { slug: 'hibernian',           name: 'Hibernian',               genre: 'Football' },
];

export async function onRequestGet({ request, params }) {
  const slug = (params.slug || '').toLowerCase();
  if (!slug) return Response.redirect('/', 302);

  const url         = new URL(request.url);
  const templateUrl = `${url.origin}/football.html`;
  const pageUrl     = `https://www.ticketscout.co.uk/football/${slug}`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) return Response.redirect('/', 302);

  let html = await templateResp.text();

  const team = TEAMS.find(t => t.slug === slug);
  const name = team?.name || toTitleCase(slug.replace(/-/g, ' '));
  const desc = `Compare ${name} ticket prices across verified sellers. Find the cheapest ${name} match tickets and buy direct from the seller.`;

  html = html
    .replace(
      /<title id="page-title">.*?<\/title>/,
      `<title id="page-title">${escAttr(name)} Tickets — Compare Prices | TicketScout</title>`
    )
    .replace(
      /<meta name="description" id="meta-description"[^>]*>/,
      `<meta name="description" id="meta-description" content="${escAttr(desc)}" />`
    )
    .replace(
      /<link rel="canonical" id="canonical"[^>]*>/,
      `<link rel="canonical" id="canonical" href="${pageUrl}" />`
    )
    .replace(/<meta property="og:title" id="og-title"[^>]*>/, `<meta property="og:title" id="og-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
    .replace(/<meta property="og:description" id="og-description"[^>]*>/, `<meta property="og:description" id="og-description" content="${escAttr(desc)}" />`)
    .replace(/<meta property="og:url" id="og-url"[^>]*>/, `<meta property="og:url" id="og-url" content="${pageUrl}" />`)
    .replace(/<meta name="twitter:title" id="tw-title"[^>]*>/, `<meta name="twitter:title" id="tw-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
    .replace(/<meta name="twitter:description" id="tw-description"[^>]*>/, `<meta name="twitter:description" id="tw-description" content="${escAttr(desc)}" />`)
    .replace('</head>', `<script>window.__FOOTBALL_SLUG__ = ${JSON.stringify(slug)};</script>\n</head>`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
