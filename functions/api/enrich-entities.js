// functions/api/entity-redirect.js
// =============================================================================
// TINY, READ-ONLY: exposes a single redirectSlug:{category}:{slug} lookup to
// client-side JS.
//
// WHY THIS EXISTS (9 Aug 2026, live incident)
// --------------------------------------------
// duplicate-entities.js's merge tool writes redirectSlug:{category}:{slug}
// keys — the same mechanism functions/venue/[slug].js and
// functions/concert/[slug].js check server-side before rendering, giving a
// real HTTP 301. It was assumed football/theatre/sports worked the same way.
// They do not: confirmed live (wolves + wolverhampton, both still render
// fully independently after a real merge) that no
// functions/football/[slug].js exists at all — football/theatre/sports are
// served via a static football.html/theatre.html/sports.html with the slug
// read out of the URL client-side (see football.html's getSlug():
// window.__FOOTBALL_SLUG__ is checked first but nothing ever sets it,
// because no Function exists to inject it — that whole branch has been dead
// code).
//
// Net effect while this was unaddressed: the merge tool's registry write
// (which does not depend on any router) succeeded, silently dropping the
// loser's URL out of the sitemap with nothing to redirect visitors or
// crawlers away from it — a real orphan-page regression. Restored via
// duplicate-entities.js's ?repair=1 mode as an immediate stopgap; this file
// is the follow-up that makes the ACTUAL merge outcome (one canonical page)
// work for these three categories going forward.
//
// This is a CLIENT-SIDE redirect (window.location.replace()), not a true
// HTTP 301 — weaker as an SEO canonicalization signal than what venue and
// concert get, since Google's own guidance prefers a server-side redirect
// for this exact purpose, even though Googlebot does execute JS during
// rendering and will eventually follow this. It is what's buildable without
// knowing the exact current _redirects/routing setup for these three pages,
// which was NOT verified before this was written — see the note in
// football.html's own comment for what to confirm next if a true 301 is
// wanted here later (a real functions/football/[slug].js, matching
// venue/concert's proven pattern, IF that can be added without conflicting
// with whatever currently serves /football/*).
//
// Usage: GET /api/entity-redirect?category=football&slug=wolverhampton
//   -> { redirect: "football/wolves" }   (if a redirect exists)
//   -> { redirect: null }                (if not — most requests)
// =============================================================================

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const category = (url.searchParams.get('category') || '').trim().toLowerCase();
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();

  const headers = {
    'Content-Type': 'application/json',
    // Short cache: a merge is a rare, deliberate action, not something that
    // needs to propagate instantly, and this keeps a KV read off the vast
    // majority of page loads (which have no redirect at all) once warm.
    'Cache-Control': 'public, max-age=300'
  };

  if (!category || !slug) return new Response(JSON.stringify({ redirect: null }), { headers });

  const kv = env.GIGSBERG_KV;
  if (!kv) return new Response(JSON.stringify({ redirect: null }), { headers });

  try {
    const redirect = await kv.get(`redirectSlug:${category}:${slug}`);
    return new Response(JSON.stringify({ redirect: redirect || null }), { headers });
  } catch {
    // Never let a lookup failure break the page — worst case, no redirect
    // fires and the page renders exactly as it did before this existed.
    return new Response(JSON.stringify({ redirect: null }), { headers });
  }
}