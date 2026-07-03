// ===========================
// TicketScout — Concert URL router
// Runs as a Cloudflare Pages Function at /concert/[slug]
// File location: functions/concert/[slug].js
//
// Serves concert.html for all /concert/* requests.
// Injects:
//   1. window.__CONCERT_SLUG__ — for client-side JS to load artist data
//   2. Server-side OG meta tags — populated before serving so social crawlers
//      (WhatsApp, Twitter, Google) see real metadata without running JS
// ===========================

const ARTISTS = [
  { slug: 'coldplay',            name: 'Coldplay',            genre: 'Rock / Pop' },
  { slug: 'ed-sheeran',         name: 'Ed Sheeran',          genre: 'Pop' },
  { slug: 'metallica',          name: 'Metallica',           genre: 'Heavy Metal' },
  { slug: 'foo-fighters',       name: 'Foo Fighters',        genre: 'Rock' },
  { slug: 'bad-bunny',          name: 'Bad Bunny',           genre: 'Latin Trap / Reggaeton' },
  { slug: 'the-weeknd',         name: 'The Weeknd',          genre: 'R&B / Pop' },
  { slug: 'ariana-grande',      name: 'Ariana Grande',       genre: 'Pop / R&B' },
  { slug: 'bruno-mars',         name: 'Bruno Mars',          genre: 'Pop / R&B / Funk' },
  { slug: 'taylor-swift',       name: 'Taylor Swift',        genre: 'Pop / Country' },
  { slug: 'doja-cat',           name: 'Doja Cat',            genre: 'Hip-Hop / Pop / R&B' },
  { slug: 'tame-impala',        name: 'Tame Impala',         genre: 'Psychedelic Rock' },
  { slug: 'my-chemical-romance', name: 'My Chemical Romance', genre: 'Alternative Rock' },
  { slug: 'wolf-alice',         name: 'Wolf Alice',          genre: 'Alternative Rock' },
  { slug: 'biffy-clyro',        name: 'Biffy Clyro',         genre: 'Alternative Rock' },
  { slug: 'the-1975',           name: 'The 1975',            genre: 'Indie Pop' },
];

export async function onRequestGet({ request, params, env }) {
  const slug = params.slug;
  if (!slug) return Response.redirect('/', 302);

  const url         = new URL(request.url);
  const templateUrl = `${url.origin}/concert.html`;
  const pageUrl     = `https://www.ticketscout.co.uk/concert/${slug}`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) return Response.redirect('/', 302);

  let html = await templateResp.text();

  // ── Look up artist metadata for server-side OG tags ──────────────────────
  const artist = ARTISTS.find(a => a.slug === slug.toLowerCase());
  const name   = artist?.name || toTitleCase(slug.replace(/-/g, ' '));
  const desc   = `Compare ${name} ticket prices across verified sellers. Find the cheapest ${name} tickets and buy direct.`;
  const pageUrl = `https://www.ticketscout.co.uk/concert/${slug}`;

  // ── Inject server-side content into existing placeholder tags ────────────
  // We UPDATE the existing tags rather than removing/replacing them.
  // This is safer — the HTML structure stays intact for the client JS to work.
  // Social crawlers see the server-side values; JS updates them on load for the browser.
  html = html
    // Update title
    .replace(
      /<title id="page-title">.*?<\/title>/,
      `<title id="page-title">${escAttr(name)} Tickets — Compare Prices | TicketScout</title>`
    )
    // Update meta description
    .replace(
      /<meta name="description" id="meta-description"[^>]*>/,
      `<meta name="description" id="meta-description" content="${escAttr(desc)}" />`
    )
    // Update canonical
    .replace(
      /<link rel="canonical" id="canonical"[^>]*>/,
      `<link rel="canonical" id="canonical" href="${pageUrl}" />`
    )
    // Update OG tags
    .replace(/<meta property="og:title" id="og-title"[^>]*>/, `<meta property="og:title" id="og-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
    .replace(/<meta property="og:description" id="og-description"[^>]*>/, `<meta property="og:description" id="og-description" content="${escAttr(desc)}" />`)
    .replace(/<meta property="og:url" id="og-url"[^>]*>/, `<meta property="og:url" id="og-url" content="${pageUrl}" />`)
    // Update Twitter tags
    .replace(/<meta name="twitter:title" id="tw-title"[^>]*>/, `<meta name="twitter:title" id="tw-title" content="${escAttr(name)} Tickets — Compare Prices | TicketScout" />`)
    .replace(/<meta name="twitter:description" id="tw-description"[^>]*>/, `<meta name="twitter:description" id="tw-description" content="${escAttr(desc)}" />`)
    // Inject slug variable before </head>
    .replace('</head>', `<script>window.__CONCERT_SLUG__ = ${JSON.stringify(slug.toLowerCase())};</script>\n</head>`);

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
