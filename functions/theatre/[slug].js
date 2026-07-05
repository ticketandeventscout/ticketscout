// ===========================
// TicketScout — Theatre URL router
// File location: functions/theatre/[slug].js
// ===========================

const SHOWS = [
  { slug: 'the-lion-king',        name: 'The Lion King' },
  { slug: 'wicked',               name: 'Wicked' },
  { slug: 'hamilton',             name: 'Hamilton' },
  { slug: 'phantom-of-the-opera', name: 'The Phantom of the Opera' },
  { slug: 'moulin-rouge',         name: 'Moulin Rouge! The Musical' },
  { slug: 'back-to-the-future',   name: 'Back to the Future: The Musical' },
  { slug: 'les-miserables',       name: 'Les Misérables' },
  { slug: 'mamma-mia',            name: 'Mamma Mia!' },
  { slug: 'operation-mincemeat',  name: 'Operation Mincemeat' },
  { slug: 'chicago',              name: 'Chicago' },
  { slug: 'standing-at-the-sky-edge', name: "Standing at the Sky's Edge" },
  { slug: 'guys-and-dolls',       name: 'Guys and Dolls' },
  { slug: 'cabaret',              name: 'Cabaret' },
];

export async function onRequestGet({ request, params }) {
  const slug = (params.slug || '').toLowerCase();
  if (!slug) return Response.redirect('/', 302);

  const url         = new URL(request.url);
  const templateUrl = `${url.origin}/theatre.html`;
  const pageUrl     = `https://www.ticketscout.co.uk/theatre/${slug}`;

  const templateResp = await fetch(templateUrl);
  if (!templateResp.ok) return Response.redirect('/', 302);

  let html = await templateResp.text();

  const show = SHOWS.find(s => s.slug === slug);
  const name = show?.name || toTitleCase(slug.replace(/-/g, ' '));
  const desc = `Compare ${name} ticket prices across verified sellers. Find the cheapest ${name} tickets and buy direct from the seller.`;

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
    .replace('</head>', `<script>window.__THEATRE_SLUG__ = ${JSON.stringify(slug)};</script>\n</head>`);

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
