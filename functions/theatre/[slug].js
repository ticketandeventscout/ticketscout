// ===========================
// TicketScout — Theatre show page router
// Cloudflare Pages Function at functions/theatre/[slug].js
//
// Serves theatre.html for any /theatre/[slug] URL.
// Injects the slug as window.__THEATRE_SLUG__ and updates OG meta tags
// server-side for social sharing previews (Googlebot, Twitter, Facebook).
//
// Usage: GET /theatre/the-lion-king → serves theatre.html with injected slug
// ===========================

// Hardcoded show data for server-side OG meta injection
// Keep in sync with theatre.js (functions/api/theatre.js)
const SHOWS = {
  'the-lion-king':          { name: 'The Lion King',                  description: 'Compare The Lion King ticket prices across verified sellers. Find the cheapest West End tickets for The Lion King.' },
  'wicked':                 { name: 'Wicked',                         description: 'Compare Wicked ticket prices across verified sellers. Find the cheapest Wicked West End tickets.' },
  'hamilton':               { name: 'Hamilton',                       description: 'Compare Hamilton ticket prices across verified sellers. Find the cheapest Hamilton West End tickets.' },
  'phantom-of-the-opera':   { name: 'The Phantom of the Opera',       description: 'Compare Phantom of the Opera ticket prices across verified sellers. Find the cheapest Phantom tickets.' },
  'moulin-rouge':           { name: 'Moulin Rouge! The Musical',      description: 'Compare Moulin Rouge ticket prices across verified sellers. Find the cheapest Moulin Rouge West End tickets.' },
  'back-to-the-future':     { name: 'Back to the Future: The Musical', description: 'Compare Back to the Future musical ticket prices. Find the cheapest West End tickets.' },
  'les-miserables':         { name: 'Les Misérables',                 description: 'Compare Les Misérables ticket prices across verified sellers. Find the cheapest Les Mis West End tickets.' },
  'mamma-mia':              { name: 'Mamma Mia!',                     description: 'Compare Mamma Mia ticket prices across verified sellers. Find the cheapest Mamma Mia tickets.' },
  'operation-mincemeat':    { name: 'Operation Mincemeat',            description: 'Compare Operation Mincemeat ticket prices across verified sellers. Find the cheapest West End tickets.' },
  '&juliet':                { name: '& Juliet',                       description: 'Compare & Juliet ticket prices across verified sellers. Find the cheapest & Juliet West End tickets.' },
  'chicago':                { name: 'Chicago',                        description: 'Compare Chicago musical ticket prices across verified sellers. Find the cheapest Chicago West End tickets.' },
  'standing-at-the-sky-edge': { name: "Standing at the Sky's Edge",  description: "Compare Standing at the Sky's Edge ticket prices. Find the cheapest West End tickets." },
  'guys-and-dolls':         { name: 'Guys and Dolls',                 description: 'Compare Guys and Dolls ticket prices across verified sellers. Find the cheapest West End tickets.' },
  'cabaret':                { name: 'Cabaret',                        description: 'Compare Cabaret ticket prices across verified sellers. Find the cheapest Cabaret West End tickets.' },
};

export async function onRequestGet({ request, params, env }) {
  const slug = (params.slug || '').toLowerCase();
  const show = SHOWS[slug];

  const showName    = show?.name || toTitleCase(slug.replace(/-/g, ' '));
  const description = show?.description
    || `Compare ${showName} ticket prices across verified sellers. Find the cheapest tickets and buy direct.`;
  const pageUrl   = `https://www.ticketscout.co.uk/theatre/${slug}`;
  const ogImage   = 'https://www.ticketscout.co.uk/og-default.png';
  const pageTitle = `${showName} Tickets — Compare Prices | TicketScout`;

  // Fetch theatre.html template
  const templateUrl  = new URL('/theatre.html', request.url);
  const templateResp = await fetch(templateUrl.toString());

  if (!templateResp.ok) {
    return new Response('Template not found', { status: 500 });
  }

  let html = await templateResp.text();

  // Inject slug for client-side JS
  const slugScript = `<script>window.__THEATRE_SLUG__ = ${JSON.stringify(slug)};<\/script>`;
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
