// ===========================
// TicketScout — Dynamic sitemap (Phase 4.3D)
// Runs as a Cloudflare Pages Function at /api/sitemap
//
// The static /sitemap.xml in the repo root is now a tiny sitemap INDEX
// pointing at the five section sitemaps served by this function:
//
//   /api/sitemap?sec=static    — homepage, hubs, info pages
//   /api/sitemap?sec=concert   — all concert entity pages
//   /api/sitemap?sec=football  — all football entity pages
//   /api/sitemap?sec=theatre   — all theatre entity pages
//   /api/sitemap?sec=venue     — all venue pages
//
// URLs come from the KV key sitemap:registry, which is:
//   - built once from the GitHub repo tree (?phase=build-registry on
//     /api/discover-pages), and
//   - updated by every auto-commit run (new pages appear in the sitemap
//     on the run that creates them — no regeneration step).
//
// <lastmod> is the entity's commit date (a real content change), never
// render time — fake daily lastmod trains Google to ignore lastmod.
// changefreq/priority deliberately omitted (ignored by Google; noise).
//
// robots.txt must contain "Allow: /api/sitemap" ABOVE "Disallow: /api/"
// so crawlers may fetch the section sitemaps (longest-match wins, but
// keep it explicit and first for readability).
// ===========================

const HOST = 'https://ticketscout.co.uk';

// Update this date when the static pages / templates meaningfully change.
const STATIC_LASTMOD = '2026-07-14';

const STATIC_URLS = [
  '',            // homepage
  '/concert',
  '/football',
  '/theatre',
  '/faq',
  '/contact',
  '/privacy',
  '/terms'
];

const SECTIONS = ['static', 'concert', 'football', 'theatre', 'venue'];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sec = (url.searchParams.get('sec') || 'index').toLowerCase();
  const kv  = env.GIGSBERG_KV;
  if (!kv) return xml('<error>Missing GIGSBERG_KV</error>', 500);

  // ── Sitemap index (also mirrored by the static /sitemap.xml file) ──────
  if (sec === 'index') {
    const entries = SECTIONS.map(s =>
      `  <sitemap><loc>${HOST}/api/sitemap?sec=${s}</loc></sitemap>`).join('\n');
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`);
  }

  if (!SECTIONS.includes(sec)) {
    return xml(`<error>Unknown section "${sec}". Valid: ${SECTIONS.join(', ')}, index</error>`, 400);
  }

  // ── Static pages section ────────────────────────────────────────────────
  if (sec === 'static') {
    const entries = STATIC_URLS.map(p =>
      `  <url><loc>${HOST}${p}</loc><lastmod>${STATIC_LASTMOD}</lastmod></url>`).join('\n');
    return xml(urlset(entries));
  }

  // ── Entity sections — read from the registry ────────────────────────────
  let registry = null;
  try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); } catch {}
  if (!registry || !registry.sections) {
    return xml('<error>sitemap:registry not built yet — run /api/discover-pages?trigger=1&amp;phase=build-registry</error>', 503);
  }

  const slugs = registry.sections[sec] || {};
  const entries = Object.entries(slugs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, lastmod]) =>
      `  <url><loc>${HOST}/${sec}/${slug}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join('\n');

  return xml(urlset(entries));
}

function urlset(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`;
}

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // ISR-equivalent: fresh within an hour, stale served while revalidating.
      // Errors are never cached — a cached 503 would blind Google for an hour.
      'Cache-Control': status === 200
        ? 'public, s-maxage=3600, stale-while-revalidate=86400'
        : 'no-store'
    }
  });
}
