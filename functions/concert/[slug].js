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

  // FIX (1 Aug 2026): this Function intercepts EVERY /concert/{slug} request
  // regardless of whether a static file exists at that path — Cloudflare
  // Pages gives a dynamic Function routing priority over a static asset at
  // the same path. That meant the redirect-stub HTML written by
  // mergefragments/fix-categories for a merged or renamed slug was NEVER
  // actually served — this Function always rendered a full, independent
  // page instead, using the raw old slug as a generic fallback name. This
  // check runs FIRST, before anything else, and is the ONLY thing that
  // makes a real HTTP 301 actually happen for a merged/renamed slug.
  //
  // Key scheme: 'redirectSlug:concert:{oldSlug}' -> '{destCategory}/{newSlug}'
  // (a full relative path, NOT a bare slug) — because fix-categories can
  // move an entity to a DIFFERENT category (e.g. concert -> sports), not
  // just rename it within the same one, so the destination page may not
  // live under /concert/ at all. Written by both mergefragments and
  // fix-categories in discover-pages.js. Shared scheme, not concert-
  // specific — the same lookup format and this same check need replicating
  // in football/theatre/sports/venue's routing functions before either
  // tool is ever run against those categories, since they share the
  // identical architecture and would have the identical gap.
  try {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      const destPath = await kv.get(`redirectSlug:concert:${slug.toLowerCase()}`);
      if (destPath) {
        return Response.redirect(`https://ticketscout.co.uk/${destPath}`, 301);
      }
    }
  } catch { /* redirect lookup failing should never break the normal page */ }

  const url         = new URL(request.url);
  const templateUrl = `${url.origin}/concert.html`;
  const pageUrl     = `https://ticketscout.co.uk/concert/${slug}`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) return Response.redirect('/', 302);

  let html = await templateResp.text();

  // ── Look up artist metadata for server-side OG tags ──────────────────────
  const artist = ARTISTS.find(a => a.slug === slug.toLowerCase());
  const name   = artist?.name || toTitleCase(slug.replace(/-/g, ' '));
  const desc   = `Compare ${name} ticket prices across verified sellers. Find the cheapest ${name} tickets and buy direct.`;

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
