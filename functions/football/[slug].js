// ===========================
// TicketScout — Football team page router
// Cloudflare Pages Function at functions/football/[slug].js
//
// Serves football.html for any /football/[slug] URL.
// Injects the slug as window.__FOOTBALL_SLUG__ and updates OG meta tags
// server-side for social sharing previews (Googlebot, Twitter, Facebook).
//
// Usage: GET /football/arsenal → serves football.html with injected slug
// ===========================

// Hardcoded team data for server-side OG meta injection
// Keep in sync with football.js (functions/api/football.js)
const TEAMS = {
  'arsenal':           { name: 'Arsenal',                  description: 'Compare Arsenal ticket prices across verified sellers. Find the cheapest Arsenal match tickets.' },
  'chelsea':           { name: 'Chelsea',                   description: 'Compare Chelsea ticket prices across verified sellers. Find the cheapest Chelsea match tickets.' },
  'liverpool':         { name: 'Liverpool',                 description: 'Compare Liverpool ticket prices across verified sellers. Find the cheapest Liverpool match tickets.' },
  'manchester-united': { name: 'Manchester United',         description: 'Compare Manchester United ticket prices across verified sellers. Find the cheapest Man Utd tickets.' },
  'manchester-city':   { name: 'Manchester City',           description: 'Compare Manchester City ticket prices across verified sellers. Find the cheapest Man City tickets.' },
  'tottenham':         { name: 'Tottenham Hotspur',         description: 'Compare Tottenham Hotspur ticket prices across verified sellers. Find the cheapest Spurs tickets.' },
  'newcastle':         { name: 'Newcastle United',          description: 'Compare Newcastle United ticket prices across verified sellers. Find the cheapest Newcastle tickets.' },
  'aston-villa':       { name: 'Aston Villa',               description: 'Compare Aston Villa ticket prices across verified sellers. Find the cheapest Aston Villa tickets.' },
  'west-ham':          { name: 'West Ham United',           description: 'Compare West Ham United ticket prices across verified sellers. Find the cheapest West Ham tickets.' },
  'brighton':          { name: 'Brighton & Hove Albion',    description: 'Compare Brighton ticket prices across verified sellers. Find the cheapest Brighton match tickets.' },
  'everton':           { name: 'Everton',                   description: 'Compare Everton ticket prices across verified sellers. Find the cheapest Everton match tickets.' },
  'rangers':           { name: 'Rangers',                   description: 'Compare Rangers ticket prices across verified sellers. Find the cheapest Rangers match tickets.' },
  'celtic':            { name: 'Celtic',                    description: 'Compare Celtic ticket prices across verified sellers. Find the cheapest Celtic match tickets.' },
  'leeds-united':      { name: 'Leeds United',              description: 'Compare Leeds United ticket prices across verified sellers. Find the cheapest Leeds United tickets.' },
  'wolves':            { name: 'Wolverhampton Wanderers',   description: 'Compare Wolves ticket prices across verified sellers. Find the cheapest Wolverhampton Wanderers tickets.' },
};

export async function onRequestGet({ request, params, env }) {
  const slug = (params.slug || '').toLowerCase();
  const team = TEAMS[slug];

  const teamName    = team?.name || toTitleCase(slug.replace(/-/g, ' '));
  const description = team?.description
    || `Compare ${teamName} ticket prices across verified sellers. Find the best match tickets and buy direct.`;
  const pageUrl   = `https://www.ticketscout.co.uk/football/${slug}`;
  const ogImage   = 'https://www.ticketscout.co.uk/og-default.png';
  const pageTitle = `${teamName} Tickets — Compare Prices | TicketScout`;

  // Fetch football.html template
  const templateUrl = new URL('/football.html', request.url);
  const templateResp = await fetch(templateUrl.toString());

  if (!templateResp.ok) {
    return new Response('Template not found', { status: 500 });
  }

  let html = await templateResp.text();

  // Inject slug for client-side JS
  const slugScript = `<script>window.__FOOTBALL_SLUG__ = ${JSON.stringify(slug)};<\/script>`;
  html = html.replace('<script src="/autocomplete.js"></script>', `${slugScript}\n  <script src="/autocomplete.js"><\/script>`);

  // Server-side OG/Twitter meta injection for social crawlers
  html = html
    .replace(/id="page-title">[^<]*</, `id="page-title">${pageTitle}<`)
    .replace(/id="meta-description" content="[^"]*"/, `id="meta-description" content="${escHtml(description)}"`)
    .replace(/id="canonical" href="[^"]*"/, `id="canonical" href="${escHtml(pageUrl)}"`)
    .replace(/id="og-title" content="[^"]*"/, `id="og-title" content="${escHtml(pageTitle)}"`)
    .replace(/id="og-description" content="[^"]*"/, `id="og-description" content="${escHtml(description)}"`)
    .replace(/id="og-url" content="[^"]*"/, `id="og-url" content="${escHtml(pageUrl)}"`)
    .replace(/id="og-image" content="[^"]*"/, `id="og-image" content="${escHtml(ogImage)}"`)
    .replace(/id="tw-title" content="[^"]*"/, `id="tw-title" content="${escHtml(pageTitle)}"`)
    .replace(/id="tw-description" content="[^"]*"/, `id="tw-description" content="${escHtml(description)}"`)
    .replace(/id="tw-image" content="[^"]*"/, `id="tw-image" content="${escHtml(ogImage)}"`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
