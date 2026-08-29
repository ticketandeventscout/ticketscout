// ===========================
// TicketScout — /sitemap.xml
// File location: functions/sitemap.xml.js
// ===========================
//
// WHY THIS FILE EXISTS (9 Aug 2026, technical SEO audit)
//
// robots.txt points Google at https://ticketscout.co.uk/sitemap.xml, which
// until now was a STATIC file in the repo root listing the seven child
// sitemaps with no <lastmod> at all.
//
// <lastmod> on a sitemap index is Google's primary signal for deciding which
// child sitemaps to re-fetch and how often. On a registry that auto-commits
// pages continuously, without it Google has no way to know the concert
// section changed today — which directly delays discovery of new event
// pages. On a ticket site, speed-to-index is the business.
//
// A static file fundamentally cannot carry an accurate <lastmod>: any date
// committed into it is stale the moment the next entity is auto-committed,
// and Google disregards <lastmod> SITEWIDE once it decides the values are
// untrustworthy. That failure mode is strictly worse than emitting none.
//
// So /sitemap.xml is now served dynamically by this Function, which simply
// proxies the already-existing, already-correct index that /api/sitemap
// generates (see sitemap.js, sec=index — it derives each section's date from
// the same real per-URL data the child sitemaps emit, never Date.now()).
//
// DELETE THE STATIC /sitemap.xml FROM THE REPO ROOT when deploying this.
// In Cloudflare Pages a static asset ALWAYS wins over a Function at the same
// path, so if that file is still present this code never runs and nothing
// changes. That is the one deployment step that can silently no-op this fix.
//
// Kept as a proxy rather than duplicating the index-building logic here: one
// implementation, in sitemap.js, that both /sitemap.xml and
// /api/sitemap?sec=index share. Duplicating it would be exactly the kind of
// drift that broke the robots.txt crawler groups.

export async function onRequestGet({ request }) {
  const origin = new URL(request.url).origin;
  try {
    const resp = await fetch(`${origin}/api/sitemap?sec=index`, {
      headers: { 'User-Agent': 'TicketScout-Sitemap-Proxy' }
    });
    if (!resp.ok) throw new Error('upstream ' + resp.status);
    const body = await resp.text();
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml;charset=UTF-8',
        // 1h: long enough to spare the origin on repeat crawls, short enough
        // that a newly-committed section's lastmod surfaces the same day.
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (e) {
    // FAIL SAFE: if the dynamic index is unavailable for any reason, emit the
    // same seven <loc> entries the old static file had, just without
    // <lastmod>. Google still gets a valid, complete index and every child
    // sitemap stays discoverable — degraded, never broken. An empty or 5xx
    // sitemap.xml would be far more damaging than a missing lastmod.
    const HOST = 'https://ticketscout.co.uk';
    const SECTIONS = ['static', 'concert', 'football', 'theatre', 'sports', 'venue', 'event'];
    const entries = SECTIONS.map(s =>
      `  <sitemap><loc>${HOST}/api/sitemap?sec=${s}</loc></sitemap>`).join('\n');
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`,
      { headers: { 'Content-Type': 'application/xml;charset=UTF-8', 'Cache-Control': 'public, max-age=300' } }
    );
  }
}
