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
//   /api/sitemap?sec=sports    — all non-football sports entity pages
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
  '/sports',
  '/faq',
  '/contact',
  '/privacy',
  '/terms'
];

const SECTIONS = ['static', 'concert', 'football', 'theatre', 'sports', 'venue', 'event'];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sec = (url.searchParams.get('sec') || 'index').toLowerCase();
  const kv  = env.GIGSBERG_KV;
  if (!kv) return xml('<error>Missing GIGSBERG_KV</error>', 500);

  // ── Registration-coverage diagnostic (read-only) ────────────────────────
  // Sizes the gap between events we LINK to (one per registry entity's
  // upcoming shows) and events actually REGISTERED in event_pages — an
  // unregistered /event/{slug} self-renders with noindex, so this ratio is the
  // real ceiling on how many event pages Google can index. Pure reads.
  if (url.searchParams.get('coverage') === '1') {
    const db = env.PRICE_DB;
    const out = { generatedAt: new Date().toISOString(), registeredEvents: {}, registryEntities: {}, activity: {}, newPages: {}, notes: [] };
    if (!db) { out.error = 'Missing PRICE_DB'; return json(out, 503); }
    try {
      const total = await db.prepare("SELECT COUNT(*) AS n FROM event_pages WHERE event_date >= date('now')").first();
      out.registeredEvents.upcomingTotal = total?.n ?? 0;
      const byCat = await db.prepare("SELECT category, COUNT(*) AS n FROM event_pages WHERE event_date >= date('now') GROUP BY category").all();
      for (const r of (byCat.results || [])) out.registeredEvents[r.category || 'null'] = r.n;
      // "activity" = updated_at churn — bumps on ANY content change (a price
      // tick from price-sampler/price-rollup counts too), so this measures
      // capture ACTIVITY, not new-page creation. Renamed from the earlier
      // 'freshness' naming, which was misleading: a high number here does NOT
      // mean that many new pages are awaiting indexing — most of it is price
      // refreshes on pages Google already knows about.
      const act = await db.prepare(
        "SELECT " +
        "  (SELECT COUNT(*) FROM event_pages WHERE updated_at >= date('now','-1 day'))  AS last1d, " +
        "  (SELECT COUNT(*) FROM event_pages WHERE updated_at >= date('now','-7 day'))  AS last7d, " +
        "  (SELECT MAX(updated_at) FROM event_pages) AS newest"
      ).first();
      out.activity = { rowsChangedLast24h: act?.last1d ?? 0, rowsChangedLast7d: act?.last7d ?? 0, newestChange: act?.newest ?? null };
    } catch (e) {
      out.error = 'event_pages read failed: ' + String(e);
      return json(out, 500);
    }
    // Genuinely NEW pages — created_at is set once, at first registration, and
    // never touched again (see tsRegisterEvents). This is the number that
    // actually predicts indexing lag: how much new inventory is Google being
    // asked to discover, as opposed to price churn on pages it already knows.
    // Isolated try/catch: on a fresh deploy before the
    // "ALTER TABLE event_pages ADD COLUMN created_at TEXT;" migration has run,
    // this column doesn't exist yet — that should degrade ONLY this section,
    // not the whole diagnostic.
    try {
      const np = await db.prepare(
        "SELECT " +
        "  (SELECT COUNT(*) FROM event_pages WHERE created_at >= date('now','-1 day')) AS last1d, " +
        "  (SELECT COUNT(*) FROM event_pages WHERE created_at >= date('now','-7 day')) AS last7d, " +
        "  (SELECT COUNT(*) FROM event_pages WHERE created_at IS NULL) AS legacyUnknownVintage"
      ).first();
      out.newPages = {
        genuinelyNewLast24h: np?.last1d ?? 0,
        genuinelyNewLast7d: np?.last7d ?? 0,
        legacyRowsPredatingCreatedAt: np?.legacyUnknownVintage ?? 0
      };
    } catch (e) {
      out.newPages = { unavailable: true,
        note: 'created_at column not present yet — run: ALTER TABLE event_pages ADD COLUMN created_at TEXT; (Cloudflare dashboard → D1 → Console). Existing rows will show NULL/legacy until they are next touched by a real content change; only rows registered after the migration get a true created_at.' };
    }
    // Registry entity counts per section.
    try {
      const r = await kv.get('sitemap:registry');
      const reg = r ? JSON.parse(r) : null;
      if (reg?.sections) for (const s of Object.keys(reg.sections)) out.registryEntities[s] = Object.keys(reg.sections[s] || {}).length;
    } catch (e) { out.notes.push('registry read failed: ' + String(e)); }
    // Rough coverage read. NB: TM "Sports" registers under category 'football'
    // in event_pages, so the football/sports split won't line up 1:1.
    out.notes.push('registeredEvents are upcoming rows in event_pages; registryEntities are linkable hubs. A low events:entity ratio indicates a coverage gap (see the ticketmaster.js ?sweep=1 backfill). "activity" is refresh churn (includes price ticks on already-indexed pages) — use "newPages" (created_at-based) to judge how much genuinely new inventory Google has to discover.');
    return json(out, 200);
  }

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

  // ── Event section (Phase 1.4B) — read from the D1 events registry ──────
  // Individual fixtures/shows served by functions/event/[slug].js.
  // Only upcoming events are listed; lastmod is the row's updated_at,
  // which only moves on real content change (never render time).
  if (sec === 'event') {
    const db = env.PRICE_DB;
    if (!db) return xml('<e>Missing PRICE_DB binding</e>', 503);
    try {
      const { results } = await db.prepare(
        "SELECT slug, updated_at FROM event_pages WHERE event_date >= date('now') ORDER BY slug LIMIT 45000"
      ).all();
      const entries = (results || []).map(r =>
        `  <url><loc>${HOST}/event/${r.slug}</loc><lastmod>${String(r.updated_at || '').slice(0, 10)}</lastmod></url>`
      ).join('\n');
      return xml(urlset(entries));
    } catch (e) {
      // Table not created yet / D1 hiccup — return an empty urlset rather
      // than an error so GSC never sees a broken section sitemap.
      return xml(urlset(''));
    }
  }

  // ── Entity sections — read from the registry ────────────────────────────
  let registry = null;
  try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); } catch {}
  if (!registry || !registry.sections) {
    return xml('<error>sitemap:registry not built yet — run /api/discover-pages?trigger=1&amp;phase=build-registry</error>', 503);
  }

  const slugs = registry.sections[sec] || {};

  // ── Dormant delisting (entity-lifecycle.js) ─────────────────────────────
  // Entities with no priced offers for MISSES_TO_DORMANT consecutive weekly
  // sweeps are dropped from the sitemap. We stop ASKING Google to crawl a page
  // that has nothing to sell; the page itself still resolves, and the moment
  // offers reappear the lifecycle sweep resets misses to 0 and it returns here
  // automatically. Nothing is deleted by this and nothing is permanent.
  //
  // FAIL-OPEN BY DESIGN: any error, missing key or malformed state leaves
  // `dormant` empty and the full sitemap is emitted. A bug in the lifecycle
  // state must never be able to silently empty the sitemap — that would be far
  // more damaging than listing a few dead pages.
  const dormant = new Set();
  try {
    const raw = await kv.get(`lifecycle:state:${sec}`);
    if (raw) {
      const state = JSON.parse(raw);
      // TIME-BASED, matching entity-lifecycle.js DORMANT_AFTER_DAYS. Sweep
      // counts are not comparable across sections: the cursor checks each
      // entity once per full cycle, and cycle length scales with section size.
      const DORMANT_AFTER_DAYS = 30; // keep in step with entity-lifecycle.js
      const DAY_MS = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      for (const [slug, v] of Object.entries(state)) {
        if (!v || !v.firstMiss) continue;
        const ts = Date.parse(v.firstMiss);
        if (!Number.isFinite(ts)) continue;
        if ((nowMs - ts) / DAY_MS >= DORMANT_AFTER_DAYS) dormant.add(slug);
      }
    }
  } catch { /* fail open */ }

  // Guard: if dormancy would remove more than half a section, treat the state
  // as untrustworthy and emit everything. Protects against a runaway sweep
  // (e.g. a liquidity source down for weeks marking the whole site dormant).
  const total = Object.keys(slugs).length;
  const suppress = dormant.size > 0 && dormant.size <= Math.floor(total / 2);

  const entries = Object.entries(slugs)
    .filter(([slug]) => !(suppress && dormant.has(slug)))
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
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