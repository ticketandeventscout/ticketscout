// ===========================
// TicketScout — SSR event pages (Phase 1.4B)
// Runs as a Cloudflare Pages Function at /event/{slug}
//
// REPO LOCATION: functions/event/[slug].js
// (NOT functions/football/... or functions/theatre/... — those collide with
//  the static stub folders and cause Error 1101/522 loops. /event/ is a
//  fresh path with no static-folder counterpart, which is why it's safe.)
//
// Serves every individual fixture/show as real server-rendered HTML so
// Google can index match-level long-tail queries ("arsenal vs chelsea
// tickets"). Replaces the crawl-invisible /#/event/{id} hash routes.
//
// Slug format (FROZEN v1 — changing it breaks every indexed URL):
//   {category}-{yyyy-mm-dd}-{normalised-name}
//   e.g. football-2026-08-09-arsenal-vs-borussia-dortmund
//
// Data: one D1 row from the `events` registry (see events-schema.sql),
// written opportunistically by the TM/SE365/Awin proxies and the daily
// Awin bulk sync. If no row exists the page still renders best-effort
// from the slug itself, but with <meta name="robots" content="noindex">
// so arbitrary made-up slugs can never pollute the index.
//
// Prices: the registry price is a render-time snapshot read per request —
// never baked into committed files. JSON-LD offers block is only emitted
// when a real, reasonably fresh price exists (same rule as the GSC schema
// fix: no offers is better than a fake/stale price).
//
// Caching: found+future pages edge-cache 1h with SWR (ISR-equivalent).
// noindex/best-effort pages cache briefly; malformed slugs 404 no-store.
// ===========================

const HOST = 'https://ticketscout.co.uk';

// 'sports' was missing here even though CATEGORY_META already defines a full
// entry for it — any correctly-registered sports-category event (SE365
// writes these when its caller passes cat='sports', e.g. rugby/tennis/
// motorsport pages) hit this regex FIRST and 404'd before the DB was ever
// queried, regardless of whether the row existed and was correct.
const SLUG_RE = /^(football|concert|theatre|sports)-(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]*)$/;

const CATEGORY_META = {
  football: { label: 'Football',  hub: '/football',  schemaType: 'SportsEvent',  noun: 'match'  },
  concert:  { label: 'Concerts',  hub: '/concert',   schemaType: 'MusicEvent',   noun: 'show'   },
  theatre:  { label: 'Theatre',   hub: '/theatre',   schemaType: 'TheaterEvent', noun: 'show'   },
  sports:   { label: 'Sports',    hub: '/sports' ,   schemaType: 'SportsEvent',  noun: 'event'  }
};

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;
  const rawParam = String(params.slug || '');

  // R5 (22 Aug 2026): optional stable-ID suffix, "-E{digits}" at the very end
  // of the URL segment — matched BEFORE lowercasing anything. Every slug
  // this site generates is already fully lowercase (tsEventSlug() lowercases
  // its input before building it), so an UPPERCASE "-E" marker here can
  // never collide with real slug content, even a slug that happens to end
  // in a chunk like "e10". Once a request is ID-addressable this way, the
  // slug text becomes decorative: it can be regenerated (a naming-
  // convention change, a venue getting added, etc.) without breaking the
  // URL, because the ID is looked up first and today's canonical slug is
  // re-derived from the row it actually points at — see the redirect logic
  // below. This is what "unfreezes" the slug format this file's own header
  // has warned about since Phase 1.4B: the ID, not the slug text, is now
  // the real primary key. id itself is event_pages' own SQLite rowid — every
  // row already has one; no schema migration needed.
  const idMatch  = rawParam.match(/-E(\d+)$/);
  const stableId = idMatch ? Number(idMatch[1]) : null;
  const rawSlug  = (idMatch ? rawParam.slice(0, -idMatch[0].length) : rawParam).toLowerCase();

  // FIX (6 Aug 2026): mirrors the identical fix in functions/concert/[slug].js
  // (1 Aug 2026). Without this, deleting a wrong-category row from
  // event_pages (see discover-pages.js's fix-sports-events phase) didn't
  // retire the old URL — it just made `row` come back null, and the
  // best-effort fallback below still rendered a full, fully-functional page
  // from the raw slug (noindexed, but still live for real users, still
  // querying every seller's compare widget). Checked BEFORE the edge-cache
  // lookup, not after — a stale cached 200 from before the redirect was
  // written would otherwise keep winning for up to its s-maxage.
  //
  // Key scheme: 'redirectSlug:event:{oldSlug}' -> 'event/{newSlug}' (relative
  // path, no leading slash — matches concert/[slug].js's destPath format).
  // Written by discover-pages.js's fix-sports-events phase (both the plain
  // duplicate-delete path and move mode) whenever it removes an event_pages
  // row for a slug that had (or now has) a correct counterpart elsewhere.
  try {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      const destPath = await kv.get(`redirectSlug:event:${rawSlug}`);
      if (destPath) {
        return Response.redirect(`${HOST}/${destPath}`, 301);
      }
    }
  } catch { /* redirect lookup failing should never break the normal page */ }

  // ── Edge cache — identical to the ticketmaster.js pattern ────────────────
  const cache    = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const m = rawSlug.match(SLUG_RE);
  if (!m) return notFound();

  const [, category, eventDate, nameSlug] = m;
  const cat = CATEGORY_META[category];

  // ── Look up the registry row ─────────────────────────────────────────────
  // R5: an incoming stable ID is matched FIRST and is authoritative — the
  // slug text in the URL is only used as a fallback lookup (legacy links
  // with no ID yet) or to detect drift against the row the ID resolves to.
  let row = null;
  if (env.PRICE_DB) {
    try {
      if (stableId != null) {
        row = await env.PRICE_DB
          .prepare('SELECT rowid AS id, * FROM event_pages WHERE rowid = ?1')
          .bind(stableId).first();
      }
      if (!row) {
        row = await env.PRICE_DB
          .prepare('SELECT rowid AS id, * FROM event_pages WHERE slug = ?1')
          .bind(rawSlug).first();
      }
    } catch (e) {
      // Table missing / D1 hiccup → degrade to best-effort render
      console.error('event page D1 lookup failed:', e);
    }
  }

  // R5: canonical realignment, only possible once a row (and so a real id)
  // exists. alreadyCanonical covers the common case (id AND slug both
  // already match what's stored) so a healthy, already-correct request
  // never pays for a KV read below.
  //  - Request carried SOME id, but it doesn't fully match this row —
  //    either the id was right and the slug has since drifted (a naming-
  //    convention change regenerated it), OR the id itself was stale/
  //    deleted and this row was only found via the slug fallback above.
  //    Either way, once an id is involved at all it's authoritative and
  //    this always corrects via a real 301 — nothing to gate, this is the
  //    literal spec ("matched on ID, 301 any slug mismatch to canonical").
  //  - Request carried NO id at all (every URL indexed before this shipped)
  //    → OPTIONALLY consolidate onto the ID-suffixed canonical. Gated
  //    behind a KV flag, since unlike the case above this is — in effect —
  //    a 301 for every previously-indexed /event/ URL on the site, and
  //    that rollout should be Rt's call, not automatic the moment this
  //    deploys. Same pattern as feature:concert-slug-v2.
  if (row && row.id != null) {
    const alreadyCanonical = stableId === row.id && row.slug === rawSlug;
    if (!alreadyCanonical) {
      const canonicalEventUrl = `${HOST}/event/${row.slug}-E${row.id}`;
      // Cached at the edge like every other response in this file — a bare
      // Response.redirect() carries no Cache-Control, which meant every
      // legacy-URL hit was paying for a live KV read (and, on the
      // stale-id path, a second D1 query) instead of getting served
      // straight from cache. Same cache lifetime as the 15–90-day
      // past-event redirect just below: once a row has a stable id, this
      // target doesn't change on any normal timescale.
      const cachedRedirect = () => {
        const resp = new Response(null, {
          status: 301,
          headers: { 'Location': canonicalEventUrl, 'Cache-Control': 'public, max-age=3600, s-maxage=86400' }
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      };
      if (stableId != null) {
        return cachedRedirect();
      }
      let redirectToId = false;
      try { redirectToId = (await env.GIGSBERG_KV?.get('feature:event-id-redirect')) === 'on'; } catch { /* default off */ }
      if (redirectToId) {
        return cachedRedirect();
      }
    }
  }

  const today  = new Date().toISOString().slice(0, 10);
  const isPast = eventDate < today;
  // Whole-day age, computed from date-only strings (no time component), so
  // this is stable across a single UTC day regardless of request time.
  const ageDays = Math.floor((Date.parse(today) - Date.parse(eventDate)) / 86400000);

  // Best-effort fields, needed by every branch below (past or future).
  const name  = row?.name  || titleCaseFromSlug(nameSlug);
  const venue = row?.venue || '';
  const city  = row?.city  || '';

  // H5: entity slug/url hoisted here so all three past-event tiers below can
  // use it, not just the live-render path. See deriveEntitySlug() — same
  // derivation the price-history chart already uses; a wrong guess degrades
  // to a best-effort entity page rather than a broken destination.
  const entitySlug = deriveEntitySlug(category, name);
  const entityUrl  = entitySlug ? `${HOST}/${category}/${entitySlug}` : `${HOST}${cat.hub}`;
  const image = row?.image || '';

  // ── Past event → three-tier decay, not an immediate 410 ──────────────────
  // A hard 410 the instant an event passes was destroying real, still-live
  // search demand (recap/highlights/"how was it" queries land on the event
  // page in the days right after) and throwing away a page that may have
  // already earned real ranking. The ladder:
  //   0–14 days past  → 200 + noindex,follow: keep serving the page (so any
  //                     inbound links/traffic still land somewhere useful),
  //                     point at the entity page for what's coming up next.
  //   15–90 days past → 301 → the parent entity page. Recap demand has
  //                     mostly faded; consolidate any remaining equity onto
  //                     the entity page rather than leaving a dead end.
  //   90+ days past   → 410 Gone (unchanged from before). By now the URL is
  //                     genuinely stale; tell Google to drop it from the
  //                     index rather than keep re-checking it.
  // Runs whether or not a registry row exists — eventDate is parsed straight
  // from the frozen-format slug, so all three tiers work even for a
  // self-rendered/unregistered page.
  if (isPast && ageDays > 90) {
    const resp = goneResponse({ cat, name, eventDate, venue, city });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  if (isPast && ageDays > 14) {
    const resp = new Response(null, {
      status: 301,
      headers: {
        'Location': entityUrl,
        // Frozen slug ⇒ frozen date ⇒ this tier boundary for THIS slug never
        // reverses — same reasoning as the 410's generous cache lifetime.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400'
      }
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  if (isPast) {
    // 1–14 days past.
    const resp = recentlyFinishedResponse({ cat, name, eventDate, venue, city, entityUrl });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
  const tmUrl = row?.tm_url || '';

  // Price snapshot only trusted when reasonably fresh (≤7 days old)
  let price = null, currency = 'GBP';
  if (row?.price && row?.updated_at) {
    const ageMs = Date.now() - Date.parse(row.updated_at);
    if (isFinite(ageMs) && ageMs < 7 * 24 * 3600 * 1000) {
      price = Math.round(Number(row.price));
      currency = row.currency || 'GBP';
    }
  }
  // TM price snapshot is only used for the client hydration call (compare.js
  // renders the TM row from it) when the event is TM-sourced.
  const tmPrice = (tmUrl && price) ? price : null;

  // Indexable only when we have real registry data AND the event is upcoming
  const indexable = !!row && !isPast;

  // CLS FIX v2 (6 Aug 2026): the first attempt removed the static
  // min-height:450px outright and made CLS WORSE (0.144 → 0.397, confirmed
  // live via PageSpeed) — #detail-compare went from growing off an
  // already-substantial 450px baseline to growing off nearly zero, a much
  // bigger height delta that pushed everything below it (hotels widget, SEO
  // text block) further down, registering as MORE cumulative shift, not
  // less. The fix isn't "no reservation" or "a different guessed number" —
  // it's a reservation genuinely informed by real data, computed fresh on
  // every request from the SAME 'compare:typical-rows' KV key compare.js's
  // own skeleton uses (see price-rollup.js's nightly aggregation of the
  // 'rows' beacon). Self-tunes as real seller coverage changes; nobody
  // re-guesses a number again. Row-height estimate (60px) is read directly
  // off compare.js's own CSS: 12px+12px cell padding plus a 36px logo slot
  // is the tallest content per row. Title (~40px) and footnote (~65px,
  // wraps to 2-3 lines at 11px) are the same fixed CSS in every render, so
  // they're constants, not guesses.
  let skeletonRowCount = 4; // matches compare.js's own FALLBACK_SKELETON_ROWS
  try {
    const raw = await env.GIGSBERG_KV?.get('compare:typical-rows');
    if (raw) {
      const typicalRows = JSON.parse(raw).typicalRows || {};
      if (typicalRows[category]) skeletonRowCount = typicalRows[category];
    }
  } catch { /* KV miss or not-yet-populated — fallback default is fine */ }
  skeletonRowCount = Math.max(2, Math.min(8, skeletonRowCount));
  const estimatedCompareHeight = 40 + (skeletonRowCount * 60) + 65;

  const html = renderPage({
    slug: row?.slug || rawSlug, id: row?.id ?? null, category, cat, name, eventDate, venue, city, image,
    price, currency, tmUrl, tmPrice, isPast, indexable, entitySlug,
    estimatedCompareHeight
  });

  const resp = new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': indexable
        ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
        : 'public, max-age=60, s-maxage=600'
    }
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ===========================
// Page rendering
// ===========================

function renderPage(d) {
  const dateStr = prettyDate(d.eventDate);
  const where   = [d.venue, d.city].filter(Boolean).join(', ');
  const metaBits = [dateStr, where].filter(Boolean).join(' · ');

  // M3 fix (6 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): concert/theatre
  // title+H1 now include venue+city, targeting long-tail queries with
  // currently zero coverage ("{artist} {city} tickets", "{artist} {venue}
  // tickets"). Scoped to concert/theatre only, per spec — football/sports
  // titles are unchanged (a fixture name like "Arsenal vs Chelsea" already
  // IS the venue-independent long-tail query; adding venue there wouldn't
  // open new query surface the way it does for a touring artist). Reuses
  // the SAME `where` string already built above for .detail-meta — no new
  // venue/city formatting logic, so this can never drift out of sync with
  // what's already displayed elsewhere on the page.
  const isConcertOrTheatre = d.category === 'concert' || d.category === 'theatre';

  // S19-C fix (14 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): every crawled
  // /event/ page had a too-long <title> tag (11/11 in the Semrush trial
  // audit's sample — a systemic template bug, not isolated pages). The old
  // line above concatenated the full event name + venue + city + a
  // long-form date + a brand suffix with NO length budget at all — e.g. a
  // real live page rendered as "All Points East Presents Outbreak -
  // Deftones at Victoria Park London, London — 23 August 2026 Tickets |
  // TicketScout" (118 characters, against Google's practical ~60-char
  // budget). Scoped to <title>/og:title ONLY — h1Text, the meta
  // description, and the JSON-LD `name` field below all keep the full,
  // untruncated real name; nothing indexable loses information, only the
  // title tag gets shorter.
  //
  // Three changes, applied in this order:
  //   1. shortDate() — abbreviated month ("23 Aug 2026" vs "23 August
  //      2026") saves ~4 chars on every single title, free.
  //   2. The " | TicketScout" brand suffix is dropped from <title> —
  //      matches h1Text's own existing precedent just below, which
  //      already drops the identical suffix for the identical reason
  //      (redundant next to the page's own header). Kept in og:title,
  //      where a social-share preview benefits from branding since it's
  //      seen outside the site's own context.
  //   3. The event NAME itself is truncated at a word boundary with a
  //      real ellipsis (truncateWords()) when it's still too long after
  //      (1) and (2). This is the actual fix for genuinely long names
  //      (multi-act festival lineups, "X presents Y" billing) — no amount
  //      of trimming the date or brand fixes those, only shortening the
  //      name does. `where` (venue+city) is deliberately left untouched
  //      here rather than also budgeted/truncated — M3 (6 Aug 2026) added
  //      it specifically to target "{artist} {city} tickets"-style
  //      long-tail queries with previously zero coverage, so cutting it
  //      would undo that fix rather than complement this one. This means
  //      an event with both a very long name AND a long venue/city string
  //      can still end up somewhat over 60 chars — a real, accepted
  //      trade-off, not an oversight — but every title is now dramatically
  //      shorter than before and the common case comfortably fits.
  const TITLE_BUDGET = 60;
  const shortDateStr = shortDate(d.eventDate);

  // S19-G fix (14 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): 345 "Team vs
  // Team" fixture keywords, 180,030/mo combined volume (Keyword Strategy
  // export) — but raw fixture names from the data feeds use inconsistent
  // separators ("V", "v", "vs", " - ", " at ", confirmed by splitFixture()
  // a few hundred lines below, which already has to handle all of them for
  // JSON-LD competitor parsing). This normalizes to the single "vs"
  // phrasing that actually matches search behaviour, reusing that SAME
  // splitFixture() parser — already proven correct elsewhere in this file —
  // rather than a second, possibly-inconsistent regex.
  //
  // Football/sports ONLY (!isConcertOrTheatre). Concert/theatre names are
  // free text (artist names, show titles) that can legitimately contain
  // " - " or " at " without being a two-sided fixture — touching those
  // would risk mangling a real name, so displayName === d.name unchanged
  // for that branch.
  //
  // displayName is used for every user-VISIBLE/SEO-facing instance of the
  // event name on this page (title, H1, meta description, breadcrumb, hero
  // alt text, body copy) — matching the same "title/H1 alignment" principle
  // already established for h1Text below. It is NOT used for: the JSON-LD
  // `name` field (stays exactly as the source data reported it — structured
  // data should match upstream literally, not a cosmetic rewrite), the
  // client hydration blob, or entity-slug derivation — all of those need
  // the raw d.name for correct downstream matching.
  const fixtureSides = !isConcertOrTheatre ? splitFixture(d.name) : [];
  const displayName = fixtureSides.length === 2 ? fixtureSides.join(' vs ') : d.name;

  // S19-J fix (14 Aug 2026, TICKETSCOUT-AUDIT-ROADMAP.md): every football
  // club page in the crawl sample scored ILR 11 (internal link rate) vs
  // hub pages' 33-78. Traced to: entityUrl/entitySlug already existed in
  // this file (built in onRequestGet, reused by the price-history chart
  // and the past-event redirect) but were never actually rendered as a
  // visible link on the main LIVE event page — only on the secondary
  // "recently finished" fallback page (recentlyFinishedResponse(), a much
  // smaller slice of traffic). This adds real, visible links here too —
  // genuinely useful navigation for a reader, not link-stuffing: "see this
  // team's/artist's other upcoming dates," not a bare keyword-matching
  // anchor.
  //
  // For a genuine two-sided fixture (reusing `fixtureSides` above, not
  // re-deriving it), links to BOTH sides — deliberately going further than
  // deriveEntitySlug()'s existing home-side-only behaviour, since that
  // function serves a different purpose (H5's price-history probe only
  // ever needed one best-effort guess) and changing its scope wasn't
  // necessary or appropriate here; this builds its own two-sided list
  // instead of touching that shared function.
  //
  // Known, accepted limitation, shared with the existing entityUrl
  // mechanism this reuses toEntitySlug() from: this is a best-effort slug
  // guess, not a verified-to-exist check — a mismatch between how a
  // fixture name derives here and the actual registered entity slug would
  // produce a link that 404s. No worse than the risk entityUrl's redirect
  // path already accepts elsewhere in this file; not a new risk class.
  const relatedLinks = fixtureSides.length === 2
    ? fixtureSides.map(side => {
        const slug = toEntitySlug(side);
        return slug ? { slug, label: `${side} tickets` } : null;
      }).filter(Boolean)
    : (() => {
        const slug = deriveEntitySlug(d.category, d.name);
        return slug ? [{ slug, label: `${displayName} tickets` }] : [];
      })();
  const relatedLinksHtml = relatedLinks.length
    ? `<p style="margin-top:12px;">See also: ${relatedLinks
        .map(l => `<a href="/${esc(d.category)}/${esc(l.slug)}">${esc(l.label)}</a>`)
        .join(' &middot; ')}</p>`
    : '';

  const titleSuffix = isConcertOrTheatre
    ? ` — ${shortDateStr} Tickets`
    : ` Tickets — ${shortDateStr}`;
  const titleWhere = isConcertOrTheatre && where ? ` at ${where}` : '';
  const titleNameBudget = Math.max(20, TITLE_BUDGET - titleSuffix.length - titleWhere.length);
  const titleName = truncateWords(displayName, titleNameBudget);
  const title = `${titleName}${titleWhere}${titleSuffix}`;
  const ogTitle = `${title} | TicketScout`;
  // H1 intentionally drops the " | TicketScout" brand suffix the roadmap's
  // title-tag spec included — that's standard practice for a title TAG
  // (browser tab / SERP), but redundant inside a page's own visible
  // heading, especially with the same brand name already in the header
  // above. Keyword content (artist/venue/city/date) matches the title
  // exactly, which is the actual SEO intent (title/H1 alignment); only the
  // branding repetition is dropped.
  const h1Text = isConcertOrTheatre
    ? `${displayName}${where ? ' at ' + where : ''} — ${dateStr} Tickets`
    : displayName;
  const description = d.isPast
    ? `${displayName} took place on ${dateStr}${where ? ' at ' + where : ''}. Browse upcoming ${d.cat.label.toLowerCase()} events and compare ticket prices on TicketScout.`
    : `Compare ${displayName} ticket prices${where ? ' at ' + where : ''} on ${dateStr}. See prices from up to 13 verified ticket sites side by side — find the cheapest ${d.cat.noun} tickets on TicketScout.`;

  // R5: once a row (and so a real id) exists, this is the URL every
  // outbound signal on the page (canonical, JSON-LD url/offers.url,
  // breadcrumb, og:url) should point at — the id-suffixed form. A
  // best-effort/unregistered render (d.id == null) has no stable identity
  // to attach, so it stays on the bare slug, same as before R5.
  const canonical = d.id != null ? `${HOST}/event/${d.slug}-E${d.id}` : `${HOST}/event/${d.slug}`;

  // ── JSON-LD — location ALWAYS populated (GSC schema fix rule), offers
  //    only when a real fresh price exists ────────────────────────────────
  // GSC non-critical enrichments (all from real data, nothing fabricated):
  //  - description: the same human description shown in the meta tag
  //  - endDate: same day as start (our events are single-day; we hold a
  //    date only, so a same-day endDate is honest, not invented)
  //  - performer (MusicEvent/TheaterEvent): the act itself
  //  - competitor (SportsEvent): the two sides parsed from "A vs B"
  //  - organizer (concert/theatre only): the act; skipped for football where
  //    the true organiser is genuinely unknown
  const performerName = extractActName(d.name);
  const isSport = d.cat.schemaType === 'SportsEvent';

  let performerBlock = {};
  if (isSport) {
    const sides = splitFixture(d.name);
    if (sides.length === 2) {
      performerBlock = { competitor: sides.map(s => ({ '@type': 'SportsTeam', name: s })) };
    }
  } else if (performerName) {
    performerBlock = {
      performer: { '@type': 'PerformingGroup', name: performerName },
      organizer: { '@type': 'Organization', name: performerName, url: canonical }
    };
  }

  const eventLd = {
    '@context': 'https://schema.org',
    '@type': d.cat.schemaType,
    name: d.name,
    description: description,
    startDate: d.eventDate,
    endDate: d.eventDate,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: d.venue || 'Venue to be announced',
      ...(d.city ? { address: { '@type': 'PostalAddress', addressLocality: d.city } } : {})
    },
    ...performerBlock,
    ...(d.image ? { image: [d.image] } : {}),
    url: canonical,
    // OFFERS — see the client-side correction in compare.js.
    //
    // d.price is ONE seller's cached price from the event_pages row (usually
    // SE365) and, as the .detail-meta comment below records, it routinely
    // disagrees with the cheapest row actually shown in the compare table —
    // £92 here against a £69.52 best price on the same page in the logged
    // example. Emitting that as lowPrice tells Google a number the visible
    // page contradicts, which is exactly the structured-data/content
    // mismatch Google penalises.
    //
    // It stays here as a SERVER-RENDERED PLACEHOLDER on purpose: it is real
    // (not fabricated), it is present in the initial HTML for a crawler that
    // never runs JS, and it is better than no offers block at all. Once
    // compare.js has resolved every adapter it OVERWRITES this block via
    // #event-schema with the true lowPrice / highPrice / offerCount across
    // all sellers actually displayed — the real comparison proposition, and
    // the only version that matches what the user sees.
    //
    // Do not "simplify" this by deleting the block: a JS-less crawl would
    // then get no price signal at all.
    ...(d.price && !d.isPast ? {
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: d.price,
        priceCurrency: d.currency,
        // R2 (22 Aug 2026): TicketScout aggregates resale marketplace
        // inventory — declare it honestly. Present on the SSR placeholder
        // too so a JS-less crawl sees it, not just the compare.js
        // correction (which sets the same field — see
        // updateEventSchemaOffers() there).
        category: 'Secondary',
        availability: 'https://schema.org/InStock',
        url: canonical
      }
    } : {})
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: HOST + '/' },
      { '@type': 'ListItem', position: 2, name: d.cat.label, item: HOST + d.cat.hub },
      { '@type': 'ListItem', position: 3, name: d.name, item: canonical }
    ]
  };

  // Values handed to the client hydration script — JSON-encoded, never
  // string-interpolated raw (XSS safety for D1-sourced strings).
  // Entity slug for the price-history chart, computed once in onRequestGet
  // (deriveEntitySlug) and passed through as d.entitySlug — H5 reuses that
  // same value as the past-event decay ladder's redirect target, so the two
  // never disagree. The chart probes /api/price-history with this and
  // silently renders nothing on a miss, so a wrong guess is harmless.
  const entitySlug = d.entitySlug || '';

  const hydrate = JSON.stringify({
    name: d.name, tmPrice: d.tmPrice, tmUrl: d.tmUrl || '#',
    city: d.city, date: d.eventDate, venue: d.venue, category: d.category,
    entitySlug: entitySlug, eventDate: d.eventDate
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  ${d.indexable ? '' : '<meta name="robots" content="noindex" />'}
  <meta property="og:site_name" content="TicketScout" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(ogTitle)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(d.image || HOST + '/ogdefault.png')}" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
  <script type="application/ld+json" id="event-schema">${JSON.stringify(eventLd).replace(/</g, '\\u003c')}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumbLd).replace(/</g, '\\u003c')}</script>
  <!-- Defined here, not in the later <script src="/compare.js"> block near
       the footer — this must exist BEFORE the hero <img> in <body> below
       can possibly fail to load, and image errors can fire while the rest
       of the page is still being parsed. -->
  <script>
    function imgFallback(img) {
      img.onerror = null; // clear first — a genuinely broken raw URL must not loop
      var raw = img.dataset.rawSrc;
      if (raw) img.src = raw;
    }
  </script>
</head>
<body>
  <nav class="navbar">
    <div class="nav-inner">
      <a href="/" aria-label="TicketScout - Compare UK Ticket Prices" style="text-decoration:none; display:flex; align-items:center; gap:10px;">
        <svg width="36" height="36" viewBox="0 40 248 200" xmlns="http://www.w3.org/2000/svg">
          <rect x="40" y="72" width="168" height="136" rx="12" fill="#1a6fc4"/>
          <circle cx="40" cy="140" r="16" fill="#ffffff"/>
          <circle cx="208" cy="140" r="16" fill="#ffffff"/>
          <line x1="40" y1="140" x2="208" y2="140" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5" opacity="0.5"/>
          <rect x="62" y="92" width="88" height="6" rx="3" fill="#ffffff" opacity="0.9"/>
          <rect x="62" y="106" width="60" height="6" rx="3" fill="#ffffff" opacity="0.6"/>
          <g transform="translate(168, 112)">
            <polygon points="0,-14 3.5,-5 13,-5 5.5,1 8.5,11 0,5.5 -8.5,11 -5.5,1 -13,-5 -3.5,-5" fill="#ffffff" opacity="0.95"/>
          </g>
          <rect x="62" y="158" width="50" height="5" rx="2.5" fill="#ffffff" opacity="0.5"/>
          <rect x="62" y="170" width="72" height="5" rx="2.5" fill="#ffffff" opacity="0.35"/>
          <rect x="62" y="182" width="40" height="5" rx="2.5" fill="#ffffff" opacity="0.25"/>
        </svg>
        <div style="display:flex; flex-direction:column; justify-content:center; line-height:1.2;">
          <span style="font-family:'Inter','Helvetica Neue',Arial,sans-serif; font-weight:700; font-size:22px; color:#0c2d5a; letter-spacing:-0.5px;">TicketScout</span>
          <span style="font-family:'Inter','Helvetica Neue',Arial,sans-serif; font-weight:400; font-size:11px; color:#1a6fc4; letter-spacing:2px;">compare. save. enjoy.</span>
        </div>
      </a>
      <div class="nav-links">
        <a href="/concert">Concerts</a>
        <a href="/football">Football</a>
        <a href="/theatre">Theatre</a>
      </div>
    </div>
  </nav>

  <main class="container" style="max-width:900px; margin:0 auto; padding:24px 16px;">
    <div style="font-size:13px; color:#666; margin-bottom:14px;">
      <!-- A11y fix (1 Aug 2026): the global a-tag rule (text-decoration:
           none) meant these links were distinguished from the surrounding
           #666 text ONLY by their blue colour — flagged by PageSpeed as
           "links rely on color to be distinguishable" (WCAG 1.4.1). Fixed
           narrowly with an inline underline on just these two links, rather
           than changing the global rule, which would alter every link on
           the site (navbar, buttons, etc.) — a much bigger, unverified
           change this session isn't positioned to visually check. -->
      <a href="/" style="text-decoration:underline;">Home</a> › <a href="${esc(d.cat.hub)}" style="text-decoration:underline;">${esc(d.cat.label)}</a> › ${esc(displayName)}
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <!-- R9-adjacent fix (24 Aug 2026): Cloudflare's own onerror=redirect
             (see cfImageUrl()'s comment) only covers failures IN the
             transform itself (a bad/missing remote image). It does NOT
             cover the zone's Transformations "Sources" allow-list
             rejecting the request outright — confirmed live: a Gigsberg-
             hosted event image 403'd flatly with no fallback once Sources
             was restricted, because that's a gateway-level rejection
             Cloudflare's own onerror handling never sees. This adds a
             SECOND, client-side fallback: if the transformed URL fails to
             load for ANY reason, swap to the raw original image once.
             d.image is untrusted third-party feed data (Awin/TM), so it
             goes into data-raw-src as plain attribute text (safe via esc()
             either way) rather than being concatenated into the inline
             onerror handler's JS itself — HTML-entity escaping does NOT
             make a value safe to embed inside inline JS text, since the
             browser decodes entities in the attribute BEFORE that text
             runs as code; a stray quote in a feed-supplied URL could break
             the string or worse. imgFallback() reads it back out via the
             DOM's own dataset API, never via string concatenation. -->
        ${d.image ? `<img class="detail-img" src="${esc(cfImageUrl(d.image, 700))}" data-raw-src="${esc(d.image)}" alt="${esc(displayName)}" fetchpriority="high" onerror="imgFallback(this)" />` : ''}
        <div class="detail-body">
          <h1 class="detail-name" style="font-size:24px; margin:0 0 6px;">${esc(h1Text)}</h1>
          <div class="detail-meta">${esc(metaBits) || 'Details to be confirmed'}</div>
          <!-- The "Tickets from £X" line was removed deliberately. It came
               from the event_pages row — one seller's cached price, usually
               SE365 — and routinely disagreed with the cheapest row in the
               compare table below (£92 above a £69.52 best price). Two
               different "from" prices on one page is worse than none, and the
               price-history card below already shows a current figure that IS
               reconciled against the live table. -->
          ${d.isPast ? `<div class="detail-meta" style="margin-top:8px; color:#b00;">This event has taken place. <a href="${esc(d.cat.hub)}">Browse upcoming ${esc(d.cat.label.toLowerCase())} →</a></div>` : ''}
        </div>
      </div>
      <div id="detail-pricehist"></div>
      <!-- CLS fix, ROUND 3 (6 Aug 2026) — history for whoever reads this next:
           Round 1 (1 Aug): static 280px. Confirmed live: zero measurable
           difference — still 0.144.
           Round 2 (1 Aug): static 450px, reasoned from ~60px/row × a
           deliberate 7-8 row middle ground, expressly flagged then as "an
           ESTIMATE... the honest long-term fix is a skeleton-row loading
           state sized to the real seller count, known server-side, if
           tracked" — i.e. this exact fix, not yet built at the time.
           Round 3a (6 Aug): removed the reservation outright once
           compare.js grew its own client-side skeleton system. Confirmed
           live via PageSpeed this was WORSE (0.144 → 0.397): with zero
           reservation, #detail-compare grew from near-zero to full height
           instead of from an already-substantial baseline — a much bigger
           delta that pushed the hotels widget and SEO text block further
           down, registering as MORE total shift, not less.
           Round 3b (this version): the actually-honest fix Round 2
           predicted. estimatedCompareHeight is computed server-side, per
           request, from the SAME 'compare:typical-rows' KV data
           compare.js's own client-side skeleton reads (nightly-aggregated
           real seller counts, see price-rollup.js + go.js's 'rows'
           beacon) — genuinely data-driven, self-tunes as real coverage
           changes, nobody re-guesses a number again. -->
      <div id="detail-compare" style="min-height:${d.estimatedCompareHeight}px;"><div class="loading">Loading live prices…</div></div>
      <div id="detail-hotels"></div>
    </div>

    <section style="margin-top:28px; font-size:14px; line-height:1.6; color:#444;">
      <h2 style="font-size:17px; color:#0c2d5a;">Compare ${esc(displayName)} ticket prices</h2>
      <p>TicketScout compares ${esc(displayName)} ticket prices${where ? ' for the ' + esc(dateStr) + ' ' + d.cat.noun + ' at ' + esc(where) : ''} from up to 13 verified ticket sites side by side, so you can see who has the cheapest tickets before you buy. Prices are refreshed through the day. TicketScout does not sell tickets — always confirm price and availability on the seller's site.</p>
      ${relatedLinksHtml}
    </section>
  </main>

  <footer class="footer">
    <div class="footer-inner">
      <p>© 2026 TicketScout · ticketscout.co.uk · All prices in GBP</p>
      <p style="margin-top:6px;"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a> · <a href="/faq">FAQ</a> · <a href="/contact">Contact</a></p>
      <p style="margin-top:14px; font-size:12px; color:#666; max-width:560px; margin-left:auto; margin-right:auto; line-height:1.5;">
        TicketScout does not sell tickets and is not a ticket retailer. We display pricing and availability sourced from third-party providers and cannot guarantee its accuracy. Always confirm event details, pricing and availability on the seller's site before purchasing.
      </p>
    </div>
  </footer>

  <script src="/compare.js?v=20260809b"></script>
  <script>
    (function () {
      var EV = ${hydrate};
      // Hydrate the compare table exactly as the hash-route detail view does
      if (typeof renderComparePrices === 'function') {
        renderComparePrices(
          document.getElementById('detail-compare'),
          EV.name, EV.tmPrice, EV.tmUrl, EV.city, EV.date, EV.venue, EV.category
        );
      }
      // Price history — event-scoped (this fixture/show on this date), so the
      // cited price is unambiguously about the event on screen. Fails silent:
      // no entity slug, no data, or a fetch error → the card simply doesn't
      // appear. Never blocks the compare table above.
      //
      // &venue= added 16 Aug 2026 — EV.venue was already sitting right here
      // (used two blocks below for the hotels card) but was never sent to
      // price-history. Confirmed live on Les Miserables, 25 Aug 2026: slug+
      // date alone matched THREE event rows sharing this entity/date — the
      // real London show under two venue spellings, plus a genuinely
      // different Tuacahn Amphitheatre (Utah) production that coincidentally
      // shares a date — and the chart blended all three into one line, with
      // the caption landing on the wrong one entirely. price-history.js now
      // uses this to resolve the correct row(s); a venue it doesn't
      // recognise degrades to the old unfiltered behaviour rather than
      // blanking the chart.
      if (EV.entitySlug && EV.eventDate) {
        (function () {
          var box = document.getElementById('detail-pricehist');
          if (!box) return;
          var qs = '?slug=' + encodeURIComponent(EV.entitySlug) + '&date=' + encodeURIComponent(EV.eventDate) + (EV.venue ? '&venue=' + encodeURIComponent(EV.venue) : '');
          fetch('/api/price-history' + qs)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              if (!data || data.error) return;
              // Reconcile against the LIVE compare table. The sampler only
              // captures VS/TN/Ticombo catalog snapshots 4x/day, so its stored
              // "current" can lag a fresher live listing — which looked like a
              // bug: an £807 headline above a £477 seller row.
              livePriceThen(function (livePrice) {
                phReconcile(data, livePrice);
                renderPriceHistory(box, data, { entityName: EV.name });
              });
            })
            .catch(function () { /* supplementary — silent */ });
        })();
      }
      // Hotel card (inline copy of events.js renderHotelCard — events.js
      // itself can't load here: its router expects the homepage DOM)
      if (EV.city && EV.date) {
        (async function () {
          var container = document.getElementById('detail-hotels');
          if (!container) return;
          try {
            var params = new URLSearchParams({ city: EV.city, date: EV.date });
            if (EV.venue) params.set('venue', EV.venue);
            var resp = await fetch('/api/hotels?' + params.toString());
            var data = await resp.json().catch(function () { return null; });
            if (!data || !data.hotels) return;
            var h = data.hotels;
            var dateStr = h.checkin ? new Date(h.checkin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            container.innerHTML =
              '<div class="hotel-card">' +
                '<div class="hotel-card-title">' +
                  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' +
                  ' Where to stay near ' + EV.city +
                '</div>' +
                (dateStr ? '<div class="hotel-card-date">Check-in: ' + dateStr + '</div>' : '') +
                '<div class="hotel-card-links">' +
                  '<a href="' + h.hotels_url + '" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--primary">Search Hotels.com →</a>' +
                  '<a href="' + h.trivago_url + '" target="_blank" rel="noopener noreferrer" class="hotel-btn hotel-btn--secondary">Compare on Trivago →</a>' +
                '</div>' +
                '<div class="hotel-card-note">Prices from verified hotel booking sites. No booking fees added by us.</div>' +
              '</div>';
          } catch (e) { /* supplementary — silent fail */ }
        })();
      }
    })();
  </script>
  <script>
  // Reads the cheapest plausible price from the live compare table once
  // compare.js has rendered it. Polls briefly (compare hydrates async) and
  // gives up quietly after ~4s, calling back with null — the chart then just
  // shows its own figure. Reads the same data-price rows and E2 implausible
  // flag compare.js uses for its own "Best price" badge, so we agree with it.
  //
  // REGRESSION FIX (9 Aug 2026): this used to return as soon as ANY
  // '#compare-rows .compare-row' existed. The CLS fix shipped 6 Aug added
  // SKELETON loading rows that deliberately reuse .compare-row so their
  // height matches a real row exactly — so from the first paint this
  // selector matched immediately, the poll returned on placeholder rows that
  // carry no data-price, every parseFloat was NaN, and the callback got
  // null. Reconciliation then bailed at its first guard and the card kept
  // showing the stale sampled figure while the table below it displayed a
  // cheaper live price (£158.35 vs £122 on the JAY-Z page).
  //
  // Two guards now, both reading signals compare.js already sets:
  //   - aria-busy="true" on #compare-rows means still loading -> keep polling
  //   - aria-hidden="true" on a row means it is a skeleton -> skip it
  // Either alone would fix this; both together mean a future change to one
  // of them cannot silently reintroduce the bug.
  function livePriceThen(cb) {
    var tries = 0, MAX = 20; // 20 × 200ms = 4s
    (function poll() {
      var table = document.getElementById('compare-rows');
      var stillLoading = table && table.getAttribute('aria-busy') === 'true';
      var rows = document.querySelectorAll('#compare-rows .compare-row:not([aria-hidden="true"])');
      if (!stillLoading && rows.length) {
        var lo = Infinity;
        rows.forEach(function (row) {
          if (row.dataset.implausible === '1') return;
          var p = parseFloat(row.dataset.price);
          if (p > 0 && p < lo) lo = p;
        });
        return cb(lo === Infinity ? null : lo);
      }
      if (++tries >= MAX) return cb(null);
      setTimeout(poll, 200);
    })();
  }

  // Reconcile tracked history against the live compare table.
  //
  // Two distinct situations, and conflating them is what produced a card that
  // claimed a "30-day low" the drawn line never reached:
  //
  //  1. MILD LAG — the live price undercuts our latest sample but sits within
  //     the tracked range. The last point IS today's sample and the live read
  //     is a fresher view of the same day, so we correct that point, then
  //     recompute low + trend from the amended series. Headline, line and
  //     badge all agree afterwards.
  //
  //  2. NOT COMPARABLE — the live price is far below EVERY tracked point. Our
  //     history plainly isn't measuring the same listings (a stale catalog
  //     snapshot, or samples filed under a different event_key). Plotting that
  //     gap would draw a ~40% price crash that never happened, which is worse
  //     than showing nothing: someone might buy or wait on the strength of it.
  //     So we suppress the trend entirely and show only what we can stand
  //     behind — the live price.
  function phReconcile(data, livePrice) {
    if (livePrice == null || !data || !data.summary) return;
    var s = data.summary;
    var series = (data.series || []).filter(function (p) { return p && typeof p.min === 'number'; });
    if (!series.length) return;

    var seriesMin = series.reduce(function (m, p) { return p.min < m ? p.min : m; }, series[0].min);

    if (livePrice < seriesMin * 0.85) {   // >15% below the whole series
      data._inconsistent = true;
      data._livePrice = livePrice;
      return;
    }

    if (typeof s.current !== 'number' || livePrice >= s.current) return;

    s.current = livePrice;
    data._reconciled = true;

    // Same-day correction, not a fabricated point.
    var last = series[series.length - 1];
    if (livePrice < last.min) last.min = livePrice;

    s.low30d = series.reduce(function (m, p) { return p.min < m ? p.min : m; }, series[0].min);

    // Recompute the badge so it can never describe the superseded figure.
    if (typeof s.weekAgo === 'number' && s.weekAgo > 0) {
      var d = livePrice - s.weekAgo;
      s.trend = d > s.weekAgo * 0.05 ? 'up' : d < -s.weekAgo * 0.05 ? 'down' : 'flat';
    }
  }

  // ── Price-history renderer (inline SVG, zero dependencies) ──────────────
  // Kept self-contained on the page rather than in compare.js: it's only used
  // here, and inlining avoids a compare.js version bump for a display-only
  // addition. If entity pages adopt it later, promote this to a shared file.
  function renderPriceHistory(container, data, opts) {
    opts = opts || {};
    if (!container) return;
    var series = (data && Array.isArray(data.series)) ? data.series.filter(function (p) { return p && typeof p.min === 'number'; }) : [];
    if (series.length === 0) { container.innerHTML = ''; return; }

    var summary = data.summary || {};
    var scope   = data.scope || 'entity';
    var money   = function (n) { return '\u00a3' + (Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };

    var anchorLine, scopeTag;
    if (scope === 'event' && data.event) {
      var dd = data.event.date ? new Date(data.event.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      anchorLine = 'Get-in price for ' + (data.event.name || 'this event') + (dd ? ' on ' + dd : '') + (data.event.venue ? ', ' + data.event.venue : '');
      scopeTag = 'this event';
    } else {
      anchorLine = 'Cheapest ticket across all ' + (opts.entityName || 'upcoming') + ' dates' + (summary.upcomingEvents ? ' (' + summary.upcomingEvents + ' events)' : '');
      scopeTag = 'all dates';
    }

    var current = summary.current != null ? summary.current : series[series.length - 1].min;
    var low     = summary.low30d  != null ? summary.low30d  : series.reduce(function (m, p) { return p.min < m ? p.min : m; }, series[0].min);
    var trend   = summary.trend || 'flat';
    var trendTxt = { up: 'trending up', down: 'trending down', flat: 'holding steady' }[trend] || 'holding steady';
    var trendArrow = { up: '\u25b2', down: '\u25bc', flat: '\u25ac' }[trend] || '';

    // Tracked history isn't comparable to what sellers are listing right now
    // (see phReconcile). Previously this rendered a "no trend" disclaimer
    // card; per product decision, when there's no graph to show, show
    // nothing at all rather than an explanatory card that reads oddly.
    if (data._inconsistent) {
      container.innerHTML = '';
      return;
    }

    if (series.length < 4) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML =
      '<div class="ts-pricehist">' +
        '<div class="ts-ph-head">' +
          /* A11y fix (1 Aug 2026): was <h3>, flagged by PageSpeed as
             "heading elements are not in a sequentially-descending order" —
             this was the ONLY heading between the page's <h1> and the later
             "Compare {name} ticket prices" <h2> further down, so document
             order was h1 -> h3 -> h2 (skips a level, then goes backwards).
             Now both are h2 siblings under the h1, which is valid. */
          '<h2 class="ts-ph-title">Price history</h2>' +
          '<span class="ts-ph-scope">last ' + series.length + ' days \u00b7 ' + phEsc(scopeTag) + '</span>' +
        '</div>' +
        '<div class="ts-ph-figs">' +
          '<span class="ts-ph-current"><span class="cur">\u00a3</span>' + phNum(current) + '</span>' +
          '<span class="ts-ph-trend ' + phEsc(trend) + '">' + trendArrow + ' ' + phEsc(trendTxt) + '</span>' +
          '<span class="ts-ph-low">30-day low <b>' + money(low) + '</b></span>' +
        '</div>' +
        phSvg(series, trend) +
        '<div class="ts-ph-foot"><span class="anchor">' + phEsc(anchorLine) + '.</span> ' +
          (data._reconciled ? 'Current figure reflects the cheapest live seller price now; the line shows our tracked daily history. ' : '') +
          'Cheapest ticket price we found per day, in GBP. Always confirm the final price on the seller\\'s site before purchasing.</div>' +
      '</div>';
  }

  function phSvg(series, trend) {
    var W = 640, H = 150, padL = 10, padR = 10, padT = 20, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var mins = series.map(function (p) { return p.min; });
    var lo = Math.min.apply(null, mins), hi = Math.max.apply(null, mins);
    var loFlat = (hi === lo);
    if (loFlat) { hi = lo + 1; lo = lo - 1; }
    var padY = (hi - lo) * 0.15; lo -= padY; hi += padY;
    var x = function (i) { return padL + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw); };
    var y = function (v) { return padT + ih - ((v - lo) / (hi - lo)) * ih; };
    var stroke = trend === 'up' ? '#c0392b' : trend === 'down' ? '#1e8449' : '#1a6fc4';
    var fill   = trend === 'up' ? 'rgba(192,57,43,0.08)' : trend === 'down' ? 'rgba(30,132,73,0.08)' : 'rgba(26,111,196,0.08)';
    var line = series.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.min).toFixed(1); }).join(' ');
    var area = 'M' + x(0).toFixed(1) + ' ' + (padT + ih) + ' ' + line.replace(/^M/, 'L') + ' L' + x(series.length - 1).toFixed(1) + ' ' + (padT + ih) + ' Z';
    var d0 = phDay(series[0].day), d1 = phDay(series[series.length - 1].day);

    // Value readouts: the series high and low get a labelled dot each, so the
    // reader sees the actual prices behind the shape rather than bare
    // direction. (No y-axis — two anchored numbers are cleaner than a scale.)
    var hiI = 0, loI = 0;
    for (var i = 1; i < series.length; i++) {
      if (series[i].min > series[hiI].min) hiI = i;
      if (series[i].min < series[loI].min) loI = i;
    }
    var lastI = series.length - 1;
    var readout = '';
    if (!loFlat) {
      readout += phDot(x(hiI), y(series[hiI].min), stroke, phMoney(series[hiI].min), 'above', hiI, lastI);
      readout += phDot(x(loI), y(series[loI].min), stroke, phMoney(series[loI].min), 'below', loI, lastI);
    }
    // Always mark + label the latest point (the number the headline quotes).
    var lx = x(lastI), ly = y(series[lastI].min);
    readout += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="3.5" fill="' + stroke + '" />';

    return '<svg class="ts-ph-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cheapest daily ticket price over the tracked period">' +
      '<path d="' + area + '" fill="' + fill + '" />' +
      '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />' +
      readout +
      '<text x="' + padL + '" y="' + (H - 8) + '" font-size="12" fill="#9aa4ae" font-family="Inter,sans-serif">' + d0 + '</text>' +
      '<text x="' + (W - padR) + '" y="' + (H - 8) + '" font-size="12" fill="#9aa4ae" text-anchor="end" font-family="Inter,sans-serif">' + d1 + '</text>' +
    '</svg>';
  }

  // A labelled dot on the line. Label sits above or below the point, and
  // flips its text-anchor near the edges so readouts never clip the viewBox.
  function phDot(cx, cy, colour, label, pos, i, lastI) {
    if (i === lastI) return ''; // the latest point is marked separately
    var dy = pos === 'above' ? -8 : 15;
    var anchor = cx < 60 ? 'start' : cx > 580 ? 'end' : 'middle';
    return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3" fill="' + colour + '" />' +
      '<text x="' + cx.toFixed(1) + '" y="' + (cy + dy).toFixed(1) + '" font-size="12" font-weight="600" fill="#5a6b7b" text-anchor="' + anchor + '" font-family="Inter,sans-serif">' + label + '</text>';
  }

  function phMoney(n) { n = Math.round(n); return '\u00a3' + n; }

  function phDay(iso) { var d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function phNum(n) { n = Math.round(n * 100) / 100; return (n % 1 === 0) ? String(n) : n.toFixed(2); }
  function phEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  </script>
</body>
</html>`;
}

// ===========================
// Helpers
// ===========================

// Strips a tour/subtitle to get the act name for JSON-LD performer/organizer.
// "Metallica: Life Burns Faster" -> "Metallica". Mirrors the compare.js
// extractPerformerName intent, kept local to the route.
function extractActName(fullName) {
  if (!fullName) return '';
  const colon = fullName.indexOf(':');
  if (colon > 0) return fullName.slice(0, colon).trim();
  const dash = fullName.indexOf(' - ');
  if (dash > 0) return fullName.slice(0, dash).trim();
  return fullName.trim();
}

// Splits a fixture name into its two sides for SportsEvent competitor[].
// "Arsenal vs Borussia Dortmund" -> ["Arsenal", "Borussia Dortmund"].
// Handles all three separators the feeds use — "vs"/"v", " - ", and " at " —
// mirroring price-sampler.js matchEntity so the home side we derive matches
// the entity the sampler recorded prices under. Returns [] when it isn't a
// recognisable two-sided fixture.
function splitFixture(name) {
  const m = String(name || '').split(/\s+(?:vs?\.?|v)\s+|\s+-\s+|\s+at\s+/i);
  return m.length === 2 ? m.map(s => s.trim()).filter(Boolean) : [];
}

// Derive an entity slug from a name, mirroring discover-pages.js toSlug()
// (same diacritic transliteration) + the sampler's club-suffix strip, so the
// result matches the `entities.slug` the price-history API queries. Football
// entities are stored bare ("arsenal", not "arsenal-fc"), so the suffix strip
// is essential; for concert/theatre it's a no-op on normal act names.
// MUST MATCH: discover-pages.js toSlug + price-sampler.js matchEntity strip.
function toEntitySlug(name) {
  const base = String(name || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/Ø/g, 'o')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'ae').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return base.replace(/-(fc|cf|afc|sc|ac|club)$/, '');
}

// H5: entity slug candidate for a given category + event name — shared by
// the price-history chart hydration (silently no-ops on a miss) and the
// past-event decay ladder's redirect target (degrades to a best-effort
// entity page on a miss, per entityUrl's cat.hub fallback in onRequestGet).
// football → home side of the fixture; concert/theatre/sports → the act
// with any tour/subtitle stripped.
function deriveEntitySlug(category, name) {
  if (category === 'football') {
    const sides = splitFixture(name);
    return toEntitySlug(sides.length ? sides[0] : name);
  }
  return toEntitySlug(extractActName(name));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// LCP FIX (6 Aug 2026): rewrites the hero <img> URL through Cloudflare's
// Image Resizing at RENDER TIME, not capture time — deliberately chosen
// over a D1 backfill. The capture-side picker fix (ticketmaster.js's
// pickHeroImage(), shipped the same day) only affects events registered
// AFTER the fix, because event_pages.image is written via
// COALESCE(excluded.image, event_pages.image) — an already-populated
// image value is NEVER overwritten, even by a fresh re-capture of the same
// event. Confirmed live: a PageSpeed re-test on an existing page (Metallica:
// Life Burns Faster) still showed the original 2.7MB image after the
// capture-side fix had already shipped. A D1 backfill would fix today's
// rows but not protect against the same class of bug recurring from any
// future capture path nobody's audited yet (trending.js already turned out
// to have silently copied the exact same bug once this session already).
// Rewriting at render time fixes EVERY row — past, present, and any future
// source — with no re-crawl, no migration, nothing to run twice.
//
// REQUIRES a one-time dashboard check (not a backfill): Cloudflare
// dashboard → Speed → Optimization → Image Resizing, "Resize images from
// any origin" must be ON, since the source is a third-party domain
// (s1.ticketm.net), not ticketscout.co.uk itself. Works on the free plan.
// If that setting is off, onerror=redirect below falls back to the
// original unresized URL rather than a broken image — degrades safely.
//
// Deliberately NOT applied to the JSON-LD `image` field or the og:image
// meta tag elsewhere on this page: neither loads in a real visitor's
// browser (JSON-LD is just a string for crawlers; og:image is only ever
// fetched by social-share bots), so neither affects real-user LCP or
// bandwidth — and Google's structured-data guidelines actually recommend
// LARGER images (1200px+) for rich-result eligibility, so shrinking those
// specifically would be counterproductive, not helpful.
function cfImageUrl(rawUrl, width) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'ticketscout.co.uk') return rawUrl; // already ours, nothing to proxy
  } catch { return rawUrl; } // not a valid absolute URL — leave untouched rather than guess
  return `${HOST}/cdn-cgi/image/width=${width},quality=80,format=auto,onerror=redirect/${rawUrl}`;
}

function prettyDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch { return iso; }
}

// S19-C fix — abbreviated-month date used ONLY in the <title>/og:title
// budget calculation above. h1Text, the meta description, and prettyDate()
// itself (used everywhere else on this page) are untouched — this is a
// second, separate formatter, not a change to the existing one.
function shortDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  } catch { return iso; }
}

// S19-C fix — word-safe truncation with a real ellipsis. Never fabricates
// or paraphrases content: this only shortens a genuinely-too-long real
// string at the nearest word boundary at or before maxLen, so what remains
// is always a true, unmodified prefix of the actual name.
function truncateWords(s, maxLen) {
  const str = String(s == null ? '' : s);
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen).replace(/\s+\S*$/, '');
  return (cut || str.slice(0, maxLen)).trim() + '…';
}

// "arsenal-vs-borussia-dortmund" → "Arsenal vs Borussia Dortmund"
function titleCaseFromSlug(nameSlug) {
  const connectors = ['vs', 'v', 'at', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on'];
  const alwaysUpper = ['fc', 'cf', 'ac', 'sc', 'rc', 'afc', 'utd', 'ud', 'rcd'];
  return nameSlug.split('-').filter(Boolean).map((w, i) => {
    if (alwaysUpper.includes(w)) return w.toUpperCase();
    if (i > 0 && connectors.includes(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// H5: 1–14 days past. Unlike goneResponse (410, permanently gone), this is a
// 200 so the URL keeps resolving to something useful for the short window
// where recap/highlights-style search demand is still real — but noindex,
// follow so Google doesn't keep indexing a page whose content is now just a
// "this has finished" notice. The entity page (linked prominently) already
// lists the artist/team's next upcoming dates, so there's no need to
// duplicate that list here.
function recentlyFinishedResponse({ cat, name, eventDate, venue, city, entityUrl }) {
  const where = [venue, city].filter(Boolean).join(', ');
  const body = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(name)} has taken place | TicketScout</title><meta name="robots" content="noindex, follow" />
<link rel="stylesheet" href="/styles.css" /></head>
<body><main class="container" style="max-width:700px; margin:60px auto; padding:0 16px; text-align:center;">
<h1 style="color:#0c2d5a;">This event has just taken place</h1>
<p><strong>${esc(name)}</strong>${where ? ' · ' + esc(where) : ''} was on ${esc(prettyDate(eventDate))}.</p>
<p><a href="${esc(entityUrl)}" style="font-weight:600;">See ${esc(name)}'s upcoming ${esc(cat.noun)}s →</a></p>
<p><a href="${esc(cat.hub)}">Browse upcoming ${esc(cat.label.toLowerCase())} →</a></p>
<p><a href="/">← Back to TicketScout</a> · <a href="/football">Football</a> · <a href="/concert">Concerts</a> · <a href="/theatre">Theatre</a></p>
</main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short-ish lifetime: this tier is only ever true for a 13-day window
      // per slug, and the boundary into the next tier (301, day 15) should
      // not be masked by an over-long cache.
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
    }
  });
}

function goneResponse({ cat, name, eventDate, venue, city }) {
  const where = [venue, city].filter(Boolean).join(', ');
  const body = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(name)} has taken place | TicketScout</title><meta name="robots" content="noindex" />
<link rel="stylesheet" href="/styles.css" /></head>
<body><main class="container" style="max-width:700px; margin:60px auto; padding:0 16px; text-align:center;">
<h1 style="color:#0c2d5a;">This event has already taken place</h1>
<p><strong>${esc(name)}</strong>${where ? ' · ' + esc(where) : ''} was on ${esc(prettyDate(eventDate))}.</p>
<p><a href="${esc(cat.hub)}">Browse upcoming ${esc(cat.label.toLowerCase())} →</a></p>
<p><a href="/">← Back to TicketScout</a> · <a href="/football">Football</a> · <a href="/concert">Concerts</a> · <a href="/theatre">Theatre</a></p>
</main></body></html>`;
  return new Response(body, {
    status: 410,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Permanent state for a given slug (the date is frozen in the slug
      // itself) — safe to cache generously, unlike the noindex/best-effort path.
      'Cache-Control': 'public, max-age=3600, s-maxage=86400'
    }
  });
}

function notFound() {
  const body = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Event not found | TicketScout</title><meta name="robots" content="noindex" />
<link rel="stylesheet" href="/styles.css" /></head>
<body><main class="container" style="max-width:700px; margin:60px auto; padding:0 16px; text-align:center;">
<h1 style="color:#0c2d5a;">Event not found</h1>
<p>We couldn't find that event. It may have passed or the link may be incorrect.</p>
<p><a href="/">← Back to TicketScout</a> · <a href="/football">Football</a> · <a href="/concert">Concerts</a> · <a href="/theatre">Theatre</a></p>
</main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}