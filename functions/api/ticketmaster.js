// ===========================
// TicketScout — Server-side Ticketmaster proxy
// Runs as a Cloudflare Pages Function at /api/ticketmaster
// Keeps TM_API_KEY out of client-side code.
//
// Set TM_API_KEY in: Cloudflare Pages dashboard →
// your project → Settings → Environment variables
// ===========================

// TM Discovery v2 sort values. There is no popularity sort; 'relevance,desc'
// is the closest available proxy for demand.
const TM_SORTS = new Set([
  'date,asc', 'date,desc', 'name,asc', 'name,desc',
  'relevance,asc', 'relevance,desc', 'random'
]);

export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  // ── Permanent diagnostic: /api/ticketmaster?diag=1 ──────────────────────
  // Answers the one question the 503 cannot: is the circuit breaker open,
  // is the key present, and what does TM actually say right now? Runs above
  // the edge cache so it is never served a stale answer. Costs one TM call
  // with size=1. The API key is never echoed.
  if (new URL(request.url).searchParams.get('diag') === '1') {
    const out = {
      checkedAt: new Date().toISOString(),
      hasApiKey: !!env.TM_API_KEY,
      apiKeyLength: env.TM_API_KEY ? env.TM_API_KEY.length : 0,
      hasKv: !!env.GIGSBERG_KV,
      quotaBreaker: null,
      liveCall: null,
      lastGoodHomepage: null
    };

    try {
      if (env.GIGSBERG_KV) {
        const flag = await env.GIGSBERG_KV.get('tm:quota:exhausted');
        out.quotaBreaker = flag
          ? { open: true, setAt: flag }
          : { open: false };
      }
    } catch (e) { out.quotaBreaker = { error: String(e) }; }

    if (env.TM_API_KEY) {
      try {
        const probe = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
        probe.searchParams.set('apikey', env.TM_API_KEY);
        probe.searchParams.set('countryCode', 'GB');
        probe.searchParams.set('size', '1');
        const r = await fetch(probe.toString());
        const body = await r.text();
        out.liveCall = {
          status: r.status,
          ok: r.ok,
          // TM returns a { fault: { faultstring, detail } } object on quota
          // and auth errors — that string is the actual answer we need.
          bodySnippet: body.slice(0, 400)
        };
      } catch (e) {
        out.liveCall = { error: String(e) };
      }
    }

    try {
      if (env.GIGSBERG_KV) {
        // lastGoodKey is built from INCOMING params, not the outbound TM URL.
        // The homepage sends only size=40, so this is its exact key.
        const k = 'tm:lastgood:/api/ticketmaster?size=40';
        const hit = await env.GIGSBERG_KV.get(k);
        out.lastGoodHomepage = { key: k, exists: !!hit, bytes: hit ? hit.length : 0 };
      }
    } catch (e) { out.lastGoodHomepage = { error: String(e) }; }

    return new Response(JSON.stringify(out, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  // ── Registration-coverage backfill: ?sweep=1&trigger=1&category=X ───────
  // Registration into event_pages is otherwise 100% traffic-driven (only a
  // fresh cache-miss proxy call captures events, see tsCaptureThrottled
  // below) — so low-traffic registry entities (most of 'sports', many of
  // 'football') never get an upcoming event registered even though entity
  // pages link to /event/{slug} for them, and those links then noindex.
  // This sweep walks the registry directly and registers via keyword search
  // — ONE TM call per entity (not attractionId resolve + fetch) to fit many
  // more entities inside the 5k/day quota. Cursor-batched across runs, same
  // pattern as discover-pages.js ?phase=regenerate. Dry by default — pass
  // &confirm=yes to write, matching the ?phase=genreaudit convention.
  if (new URL(request.url).searchParams.get('sweep') === '1'
      && new URL(request.url).searchParams.get('trigger') === '1') {
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const VALID_CATS = new Set(['concert', 'football', 'theatre', 'sports']);
    if (!VALID_CATS.has(category)) {
      return jsonResponse({ error: `category must be one of: ${[...VALID_CATS].join(', ')}` }, 400);
    }
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 40);
    const confirm = url.searchParams.get('confirm') === 'yes';
    const dryRun  = !confirm;
    const kv = env.GIGSBERG_KV, db = env.PRICE_DB, apiKey = env.TM_API_KEY;
    if (!kv)     return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
    if (!db)     return jsonResponse({ error: 'Missing PRICE_DB' }, 500);
    if (!apiKey) return jsonResponse({ error: 'Missing TM_API_KEY' }, 500);

    // Respect the existing circuit breaker — never burn calls on guaranteed 429s.
    let breakerOpen = false;
    try { breakerOpen = !!(await kv.get('tm:quota:exhausted')); } catch {}
    if (breakerOpen) {
      return jsonResponse({ sweep: true, category, quotaBreakerOpen: true,
        note: 'TM quota breaker is open — no calls made, cursor not advanced. Retry later.' }, 200);
    }

    let registry = null;
    try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); }
    catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }
    const allSlugs = Object.keys(registry?.sections?.[category] || {});
    if (!allSlugs.length) {
      return jsonResponse({ error: `no registry entities for category "${category}" — has build-registry run?` }, 200);
    }

    const cursorKey = `regsweep:cursor:${category}`;
    let offset = 0;
    if (!dryRun) { try { const c = await kv.get(cursorKey); offset = c ? (parseInt(c, 10) || 0) : 0; } catch {} }
    const batch = allSlugs.slice(offset, offset + limit);

    // Verify D1 writes actually land (waitUntil writes have failed silently
    // before) — count this category's upcoming rows before and after.
    let beforeCount = null;
    try {
      const r = await db.prepare(
        "SELECT COUNT(*) AS n FROM event_pages WHERE category = ?1 AND event_date >= date('now')"
      ).bind(category).first();
      beforeCount = r?.n ?? null;
    } catch {}

    const details = [];
    let entitiesQueried = 0, eventsFoundTotal = 0, eventsRegisteredTotal = 0;
    let quotaBreakerHit = false, stoppedAt = null;

    for (let i = 0; i < batch.length; i++) {
      // Space out calls — the diag=1 evidence (429 cleared within ~8 minutes,
      // far too fast for a genuine 5k/day quota reset) points to a per-second
      // burst limit, not daily exhaustion. A sweep firing calls back-to-back
      // can trip that limit on its own, or combine with organic site traffic
      // in the same window. A small gap costs little (25 entities ≈ 5s extra)
      // and meaningfully reduces that risk.
      if (i > 0) await new Promise(res => setTimeout(res, 250));

      const slug = batch[i];
      const keyword = slug.replace(/-/g, ' ');
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('countryCode', 'GB');
      tmUrl.searchParams.set('keyword', keyword);
      tmUrl.searchParams.set('size', '50');
      tmUrl.searchParams.set('sort', 'date,asc');
      tmUrl.searchParams.set('startDateTime', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

      entitiesQueried++;
      let recs = [];
      try {
        const r = await fetch(tmUrl.toString());
        if (r.status === 429) {
          quotaBreakerHit = true;
          stoppedAt = i;
          try { await kv.put('tm:quota:exhausted', new Date().toISOString(), { expirationTtl: 600 }); } catch {}
          break; // stop the batch; cursor stays at this entity so the next run retries it
        }
        if (!r.ok) { details.push({ slug, error: 'HTTP ' + r.status }); continue; }
        const data = await r.json();
        recs = tsExtractTmRecords(data);
      } catch (e) {
        details.push({ slug, error: String(e) });
        continue;
      }

      // Keyword search on an entity name is loose — an ambiguous name can
      // return a completely unrelated TM event that happens to share a word
      // (e.g. "london lions" keyword matching "Disney's The Lion King";
      // "london irish" matching an unrelated Irish music act). TM's own
      // classification for each hit is trustworthy; the ENTITY-to-CATEGORY
      // relevance is not. So only keep hits whose classified category
      // belongs to the same family as the section being swept — a stray
      // concert/theatre match on a sports/football entity is discarded
      // rather than seeding an unrelated page under the wrong section.
      const FAMILY = { football: ['football', 'sports'], sports: ['football', 'sports'],
                       concert: ['concert'], theatre: ['theatre'] };
      const allowed = FAMILY[category] || [category];
      const byCategory = {};
      for (const rec of recs) byCategory[rec.category] = (byCategory[rec.category] || 0) + 1;
      const kept = recs.filter(rec => allowed.includes(rec.category));
      const discarded = recs.length - kept.length;

      eventsFoundTotal += kept.length;
      if (recs.length) {
        details.push({
          slug, keyword, eventsFound: recs.length, kept: kept.length, discardedOffTopic: discarded,
          byCategory, sample: kept[0]?.name || recs[0]?.name
        });
        if (!dryRun && kept.length) {
          try { await tsRegisterEvents(env, kept); eventsRegisteredTotal += kept.length; }
          catch (e) { details.push({ slug, error: 'register failed: ' + String(e) }); }
        }
      }
    }

    const processed = quotaBreakerHit ? stoppedAt : batch.length;
    const nextOffset = offset + processed;
    const done = nextOffset >= allSlugs.length;
    if (!dryRun) {
      try {
        if (done) await kv.delete(cursorKey);
        else await kv.put(cursorKey, String(nextOffset));
      } catch {}
    }

    let afterCount = null, verified = null;
    if (!dryRun) {
      try {
        const r = await db.prepare(
          "SELECT COUNT(*) AS n FROM event_pages WHERE category = ?1 AND event_date >= date('now')"
        ).bind(category).first();
        afterCount = r?.n ?? null;
        verified = (afterCount !== null && beforeCount !== null) ? (afterCount - beforeCount) : null;
      } catch {}
    }

    return jsonResponse({
      sweep: true, category, dryRun, offset, limit,
      totalRegistryEntities: allSlugs.length,
      entitiesQueried, eventsFoundTotal, eventsRegisteredTotal,
      d1RowCountBefore: beforeCount, d1RowCountAfter: afterCount, d1RowCountDelta: verified,
      quotaBreakerHit, done, nextOffset: done ? null : nextOffset,
      next: done ? null : `?sweep=1&trigger=1&category=${category}&limit=${limit}${confirm ? '&confirm=yes' : ''}`,
      details: details.slice(0, 60)
    }, 200);
  }

  // ── One-time correction: ?fixcategory=1&trigger=1 ────────────────────────
  // tsTmCategory() used to map EVERY TM 'Sports' segment event to 'football'
  // (fixed above via genre). Rows written before that fix — rugby, tennis,
  // motorsport etc. registered by the ?sweep=1 backfill or organic capture —
  // are stuck under category='football' with a football-*  slug. This walks
  // exactly that candidate set (source='tm' AND category='football'),
  // re-checks each against TM's OWN classification (never guesses from
  // name/venue text), and moves genuinely mis-filed rows to category='sports'
  // with a freshly built slug. Handles the case where a correctly-tagged
  // 'sports' row for the same event already exists (e.g. from SE365) — then
  // it just removes the erroneous football-slug duplicate rather than
  // creating a second copy. Dry by default; &confirm=yes to write.
  if (new URL(request.url).searchParams.get('fixcategory') === '1'
      && new URL(request.url).searchParams.get('trigger') === '1') {
    const url = new URL(request.url);
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '15', 10) || 15, 30);
    const confirm = url.searchParams.get('confirm') === 'yes';
    const dryRun  = !confirm;
    const kv = env.GIGSBERG_KV, db = env.PRICE_DB, apiKey = env.TM_API_KEY;
    if (!db)     return jsonResponse({ error: 'Missing PRICE_DB' }, 500);
    if (!apiKey) return jsonResponse({ error: 'Missing TM_API_KEY' }, 500);

    let breakerOpen = false;
    try { breakerOpen = !!(kv && await kv.get('tm:quota:exhausted')); } catch {}
    if (breakerOpen) {
      return jsonResponse({ fixcategory: true, quotaBreakerOpen: true,
        note: 'TM quota breaker is open — no calls made, cursor not advanced. Retry later.' }, 200);
    }

    // Keyset (seek) pagination, NOT offset — this WHERE set shrinks as rows
    // get reclassified/deleted out of it, and a numeric OFFSET would then
    // silently skip whatever shifted into that position (undercounting the
    // sweep). Tracking the last slug actually examined is immune to that:
    // deleted rows simply vanish from every future query, and untouched rows
    // are never skipped or re-checked.
    const cursorKey = 'fixcat:lastslug';
    let lastSlug = '';
    if (!dryRun) { try { const c = kv ? await kv.get(cursorKey) : null; lastSlug = c || ''; } catch {} }

    let rows = [];
    try {
      const { results } = await db.prepare(
        "SELECT * FROM event_pages WHERE source = 'tm' AND category = 'football' " +
        "AND event_date >= date('now') AND slug > ?1 ORDER BY slug LIMIT ?2"
      ).bind(lastSlug, limit).all();
      rows = results || [];
    } catch (e) {
      return jsonResponse({ error: 'candidate read failed: ' + String(e) }, 500);
    }

    let beforeFootball = null, beforeSports = null;
    try {
      const r = await db.prepare(
        "SELECT " +
        "  (SELECT COUNT(*) FROM event_pages WHERE category='football' AND event_date >= date('now')) AS f, " +
        "  (SELECT COUNT(*) FROM event_pages WHERE category='sports'   AND event_date >= date('now')) AS s"
      ).first();
      beforeFootball = r?.f ?? null; beforeSports = r?.s ?? null;
    } catch {}

    const details = [];
    let checked = 0, confirmedFootball = 0, recategorized = 0, duplicatesRemoved = 0, unverifiable = 0;
    let quotaBreakerHit = false, stoppedAt = null;

    for (let i = 0; i < rows.length; i++) {
      if (i > 0) await new Promise(res => setTimeout(res, 250));
      const row = rows[i];
      checked++;

      // Re-verify against TM's OWN classification for the SAME event — never
      // infer from stored name/venue text. Bound tightly to the exact stored
      // date to avoid picking up an unrelated same-name fixture.
      const dateStart = row.event_date + 'T00:00:00Z';
      const dateEnd   = row.event_date + 'T23:59:59Z';
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', row.name);
      tmUrl.searchParams.set('startDateTime', dateStart);
      tmUrl.searchParams.set('endDateTime', dateEnd);
      tmUrl.searchParams.set('size', '5');
      tmUrl.searchParams.set('sort', 'relevance,desc');

      let trueCategory = null, genre = null;
      try {
        const r = await fetch(tmUrl.toString());
        if (r.status === 429) {
          quotaBreakerHit = true; stoppedAt = i;
          try { if (kv) await kv.put('tm:quota:exhausted', new Date().toISOString(), { expirationTtl: 600 }); } catch {}
          break;
        }
        if (!r.ok) { details.push({ slug: row.slug, error: 'HTTP ' + r.status }); unverifiable++; continue; }
        const data = await r.json();
        const ev = data?._embedded?.events?.[0];
        if (!ev) { details.push({ slug: row.slug, name: row.name, note: 'no TM match for this name+date — left unchanged' }); unverifiable++; continue; }
        genre = ev?.classifications?.[0]?.genre?.name || null;
        trueCategory = tsTmCategory(ev);
      } catch (e) {
        details.push({ slug: row.slug, error: String(e) }); unverifiable++; continue;
      }

      if (trueCategory === 'football' || !trueCategory) {
        confirmedFootball++;
        continue; // genuinely football (or TM gave nothing classifiable) — leave as-is
      }

      // Mis-filed — trueCategory is 'sports' (the only other value tsTmCategory
      // can produce for a Sports-segment event after the genre fix).
      const newSlug = tsEventSlug(trueCategory, row.event_date, row.name);
      if (!newSlug) { details.push({ slug: row.slug, note: 'could not build corrected slug — left unchanged' }); unverifiable++; continue; }

      if (dryRun) {
        recategorized++;
        details.push({ oldSlug: row.slug, newSlug, name: row.name, genre, action: 'would-recategorize' });
        continue;
      }

      try {
        const dup = await db.prepare('SELECT slug FROM event_pages WHERE slug = ?1').bind(newSlug).first();
        if (dup) {
          // A correctly-tagged row for this event already exists (e.g. from
          // SE365) — just remove the erroneous football-slug duplicate.
          await db.batch([ db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(row.slug) ]);
          duplicatesRemoved++;
          details.push({ oldSlug: row.slug, newSlug, name: row.name, genre, action: 'duplicate-removed' });
        } else {
          const hasCreatedAt = Object.prototype.hasOwnProperty.call(row, 'created_at');
          const insertSql = hasCreatedAt
            ? 'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)'
            : 'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)';
          const binds = [newSlug, trueCategory, row.name, row.event_date, row.venue, row.city,
                         row.price, row.currency, row.tm_url, row.image, row.source, row.updated_at];
          if (hasCreatedAt) binds.push(row.created_at ?? row.updated_at);
          await db.batch([
            db.prepare(insertSql).bind(...binds),
            db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(row.slug)
          ]);
          recategorized++;
          details.push({ oldSlug: row.slug, newSlug, name: row.name, genre, action: 'recategorized' });
        }
      } catch (e) {
        details.push({ slug: row.slug, error: 'correction write failed: ' + String(e) });
      }
    }

    const processed = quotaBreakerHit ? stoppedAt : rows.length;
    // The cursor advances to the slug of the LAST row actually examined —
    // if a 429 stopped us at index `stoppedAt`, that's rows[stoppedAt-1]
    // (the row AT stoppedAt itself was never checked, so it must be retried,
    // not skipped). If stoppedAt is 0, nothing this run succeeded — leave
    // the cursor exactly where it was.
    const lastExaminedSlug = processed > 0 ? rows[processed - 1]?.slug : null;
    const nextCursor = lastExaminedSlug || lastSlug;
    const done = rows.length < limit && !quotaBreakerHit; // fewer rows than asked for = reached the end
    if (!dryRun && kv) {
      try {
        if (done) await kv.delete(cursorKey);
        else await kv.put(cursorKey, nextCursor);
      } catch {}
    }

    let afterFootball = null, afterSports = null;
    if (!dryRun) {
      try {
        const r = await db.prepare(
          "SELECT " +
          "  (SELECT COUNT(*) FROM event_pages WHERE category='football' AND event_date >= date('now')) AS f, " +
          "  (SELECT COUNT(*) FROM event_pages WHERE category='sports'   AND event_date >= date('now')) AS s"
        ).first();
        afterFootball = r?.f ?? null; afterSports = r?.s ?? null;
      } catch {}
    }

    return jsonResponse({
      fixcategory: true, dryRun, limit,
      resumeFrom: lastSlug || null,
      checked, confirmedFootball, recategorized, duplicatesRemoved, unverifiable,
      footballCountBefore: beforeFootball, footballCountAfter: afterFootball,
      sportsCountBefore: beforeSports, sportsCountAfter: afterSports,
      quotaBreakerHit, done, nextCursor: done ? null : nextCursor,
      // Note: this URL doesn't need an explicit cursor param — the endpoint
      // reads fixcat:lastslug from KV itself. Re-hitting the same URL
      // resumes correctly as long as &confirm=yes is present (dry runs never
      // read or advance the cursor, so a bare dry-run retry always restarts
      // from the beginning — that's intentional, dry runs are for preview).
      next: done ? null : `?fixcategory=1&trigger=1&limit=${limit}${confirm ? '&confirm=yes' : ''}`,
      details: details.slice(0, 60)
    }, 200);
  }

  // ── Edge cache: identical queries answered from the Cloudflare colo ──
  // for 10 minutes instead of hitting TM's API (5k calls/day quota).
  // One viral event page = at most ~6 TM calls/colo/hour instead of
  // one call per page view. This is the traffic-surge protection layer.
  const cache    = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const apiKey = env.TM_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: 'Server is missing TM_API_KEY environment variable.' }, 500);
  }

  const incoming = new URL(request.url);
  const eventId = incoming.searchParams.get('id');
  const attractionSearch = incoming.searchParams.get('attractionSearch');

  let tmUrl;

  if (eventId) {
    // Single event lookup — used by event detail pages
    tmUrl = new URL(`https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json`);
    tmUrl.searchParams.set('apikey', apiKey);
  } else if (attractionSearch) {
    // Attraction search — used to get team/artist images for football/SE365 detail pages
    tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('keyword', attractionSearch);
    tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '3');
  } else {
    // Event search — used for trending/category browsing and per-artist event lists
    tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('countryCode', 'GB');
    tmUrl.searchParams.set('size', incoming.searchParams.get('size') || '12');
    tmUrl.searchParams.set('sort', 'date,asc');

    const page = incoming.searchParams.get('page');
    if (page) tmUrl.searchParams.set('page', page);

    const startDateTime = incoming.searchParams.get('startDateTime');
    const endDateTime   = incoming.searchParams.get('endDateTime');
    // Always default to today at midnight UTC so past events are never returned
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    tmUrl.searchParams.set('startDateTime', startDateTime || nowIso);
    if (endDateTime) tmUrl.searchParams.set('endDateTime', endDateTime);

    const keyword = incoming.searchParams.get('keyword');
    if (keyword) tmUrl.searchParams.set('keyword', keyword);

    const segmentName = incoming.searchParams.get('segmentName');
    if (segmentName) {
      tmUrl.searchParams.set('segmentName', segmentName);
      // countryCode=GB is deliberately KEPT here. The only caller that passes
      // segmentName is fetchEvents() in events.js, which renders the homepage
      // under the heading "Trending events in the UK" — dropping GB returned
      // New York results under a UK heading. attractionId and venueId below
      // still drop it, because those are genuinely global lookups.
    }

    // Sort override — lets a live A/B be run from the URL before any default
    // is changed. Whitelisted against TM's documented sort values.
    const sort = incoming.searchParams.get('sort');
    if (sort && TM_SORTS.has(sort)) tmUrl.searchParams.set('sort', sort);



    // Setting this guarantees results belong to exactly one artist/attraction
    const attractionId = incoming.searchParams.get('attractionId');
    if (attractionId) {
      tmUrl.searchParams.set('attractionId', attractionId);
      // Remove GB filter for artist searches — fans want ALL global dates
      // (e.g. Metallica at Sphere Las Vegas would be excluded by countryCode=GB)
      tmUrl.searchParams.delete('countryCode');
    }

    // venueId — used by venue pages to load all events at a specific venue
    const venueId = incoming.searchParams.get('venueId');
    if (venueId) {
      tmUrl.searchParams.set('venueId', venueId);
      tmUrl.searchParams.delete('countryCode');
    }
  }

  // ── Last-good fallback (KV) ─────────────────────────────────────────────
  // TM's free quota is 5k calls/day. When it's exhausted (429) or TM is
  // down (5xx), serve the most recent good response for this exact query
  // from KV instead of surfacing the error — the homepage/trending and
  // entity event lists degrade to slightly-stale data instead of blank.
  const kv = env.GIGSBERG_KV;
  const lastGoodKey = 'tm:lastgood:' + incoming.pathname + '?' +
    [...incoming.searchParams].filter(([k]) => k !== 'apikey').sort()
      .map(([k, v]) => k + '=' + v).join('&');

  // Circuit breaker: while the quota flag is set, don't burn calls on
  // guaranteed 429s — go straight to the last-good copy for 10 minutes.
  let quotaExhausted = false;
  try { quotaExhausted = !!(kv && await kv.get('tm:quota:exhausted')); } catch {}

  if (!quotaExhausted) {
    try {
      const tmResponse = await fetch(tmUrl.toString());
      const data = await tmResponse.json();
      const resp = jsonResponse(data, tmResponse.status, tmResponse.ok);
      if (tmResponse.ok) {
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        // Refresh the last-good copy (7-day TTL — long enough to ride out
        // a full quota day, short enough to never serve ancient events)
        if (kv) ctx.waitUntil(kv.put(lastGoodKey, JSON.stringify(data), { expirationTtl: 7 * 24 * 3600 }));
        // Phase 1.4B: register served events into the D1 events registry so
        // /event/{slug} pages can server-render them. Throttled per-query via
        // the Cache API (edge cache already limits calls; this caps D1 writes).
        tsCaptureThrottled(env, (p) => ctx.waitUntil(p), 'tm:' + lastGoodKey,
          () => tsExtractTmRecords(data));
        return resp;
      }
      if (tmResponse.status === 429 && kv) {
        // Set the breaker so subsequent requests skip TM for 10 minutes
        ctx.waitUntil(kv.put('tm:quota:exhausted', new Date().toISOString(), { expirationTtl: 600 }));
      }
      // Non-OK → fall through to last-good
    } catch (err) {
      // Network failure → fall through to last-good
    }
  }

  // Serve the stale copy if we have one
  if (kv) {
    try {
      const stale = await kv.get(lastGoodKey);
      if (stale) {
        return new Response(stale, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            // Cache the stale answer briefly at the edge too — during an
            // outage this keeps function invocations near zero
            'Cache-Control': 'public, max-age=60, s-maxage=300',
            'X-TM-Fallback': 'stale'
          }
        });
      }
    } catch {}
  }

  return jsonResponse({ error: 'Ticketmaster unavailable and no cached copy exists yet.' }, 503);
}

function jsonResponse(body, status, cacheable) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // s-maxage: Cloudflare edge caches for 10 min; SWR serves stale
      // while revalidating in the background. Browsers get 1 min.
      'Cache-Control': cacheable
        ? 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600'
        : 'no-store'
    }
  });
}


// ===========================
// Phase 1.4B — event registry capture
// Shared block: an identical copy lives in sportsevents365.js,
// awin-events.js and awin-category-cache.js, and tsEventSlug has a client
// copy in compare.js. The slug format is FROZEN v1 — never change it
// without migrating every indexed /event/ URL.
// ===========================

// {category}-{yyyy-mm-dd}-{normalised-name} — MUST MATCH all other copies.
function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}

// TM segment → TicketScout category. Unknown segments are skipped.
//
// IMPORTANT FIX: this previously mapped EVERY 'Sports' segment event to
// 'football' — meaning rugby, tennis, motorsport, cricket, etc. were all
// silently filed as football. That's why a sports-registry backfill sweep
// showed d1RowCountDelta=0 for category='sports': matches were being written
// successfully, just under 'football' instead. Genre-level TM classification
// distinguishes real football/soccer from other sports; 'Soccer' is TM's
// standard genre label for association football globally.
// CAVEAT: this hasn't been confirmed against a live non-football TM payload
// from this account — if a real rugby/tennis event still comes back
// category='football', check event.classifications[0].genre.name in that
// response and adjust the check below to match what TM actually sends.
function tsTmCategory(event) {
  const seg   = event?.classifications?.[0]?.segment?.name || '';
  const genre = event?.classifications?.[0]?.genre?.name || '';
  if (seg === 'Sports') return (genre === 'Soccer') ? 'football' : 'sports';
  if (seg === 'Music') return 'concert';
  if (seg === 'Arts & Theatre') return 'theatre';
  return null;
}

// Build registry records from a TM API payload (list or single event).
function tsExtractTmRecords(data) {
  const events = data?._embedded?.events
    || (data?.id && data?.name && data?.dates ? [data] : []);
  const today = new Date().toISOString().slice(0, 10);
  const records = [];
  for (const e of events.slice(0, 50)) {
    const category = tsTmCategory(e);
    const date = e?.dates?.start?.localDate || '';
    if (!category || !date || date < today) continue;
    const slug = tsEventSlug(category, date, e.name);
    if (!slug) continue;
    const venue = e?._embedded?.venues?.[0];
    const img = (e.images || []).find(i => i.ratio === '16_9' && i.width > 300) || (e.images || [])[0];
    records.push({
      slug, category, name: e.name, date,
      venue: venue?.name || null,
      city: venue?.city?.name || null,
      price: e.priceRanges?.[0]?.min ? Math.round(e.priceRanges[0].min) : null,
      currency: e.priceRanges?.[0]?.currency || 'GBP',
      tmUrl: e.url || null,
      image: img?.url || null,
      source: 'tm'
    });
  }
  return records;
}

// Batched D1 upsert. updated_at only bumps when content actually changed —
// the sitemap uses it as lastmod, and fake lastmod trains Google to ignore it.
async function tsRegisterEvents(env, records) {
  const db = env.PRICE_DB;
  if (!db || !records || !records.length) return;
  const now = new Date().toISOString();
  // created_at is bound in the INSERT values but deliberately OMITTED from the
  // ON CONFLICT DO UPDATE SET clause — SQLite leaves an omitted column
  // untouched on conflict, so a row's created_at is set exactly once, at
  // first registration, and never overwritten by later refreshes. This is
  // what lets the coverage diagnostic tell "genuinely new page" apart from
  // "existing page, price refreshed" — updated_at alone conflated the two.
  const stmt = db.prepare(
    'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at, created_at) ' +
    'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ' +
    'ON CONFLICT(slug) DO UPDATE SET ' +
    'name=excluded.name, ' +
    'venue=COALESCE(excluded.venue, event_pages.venue), ' +
    'city=COALESCE(excluded.city, event_pages.city), ' +
    'price=COALESCE(excluded.price, event_pages.price), ' +
    'currency=COALESCE(excluded.currency, event_pages.currency), ' +
    'tm_url=COALESCE(excluded.tm_url, event_pages.tm_url), ' +
    'image=COALESCE(excluded.image, event_pages.image), ' +
    'source=excluded.source, ' +
    'updated_at=CASE WHEN event_pages.name IS NOT excluded.name ' +
    'OR event_pages.venue IS NOT COALESCE(excluded.venue, event_pages.venue) ' +
    'OR event_pages.city IS NOT COALESCE(excluded.city, event_pages.city) ' +
    'OR event_pages.price IS NOT COALESCE(excluded.price, event_pages.price) ' +
    'THEN excluded.updated_at ELSE event_pages.updated_at END'
    // created_at intentionally absent here — see comment above.
  );
  const seen = new Set();
  const batch = [];
  for (const r of records) {
    if (!r || !r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    batch.push(stmt.bind(
      r.slug, r.category, r.name, r.date,
      r.venue || null, r.city || null,
      r.price || null, r.currency || null,
      r.tmUrl || null, r.image || null,
      r.source || null, now, now
    ));
    if (batch.length >= 400) break; // per-request safety cap
  }
  if (!batch.length) return;
  try {
    await db.batch(batch);
  } catch (e) {
    // Deploy-order safety net: if the created_at column hasn't been added yet
    // (ALTER TABLE event_pages ADD COLUMN created_at TEXT; — see rollout
    // notes), the 13-column INSERT above fails on every row. Rather than
    // registration silently going dark until someone notices, fall back to
    // the pre-migration 12-column statement so events keep registering; we
    // just won't have created_at until the column is added and this code
    // path stops being needed.
    console.error('tsRegisterEvents: 13-col insert failed, falling back to legacy schema:', e);
    const legacyStmt = db.prepare(
      'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) ' +
      'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ' +
      'ON CONFLICT(slug) DO UPDATE SET ' +
      'name=excluded.name, ' +
      'venue=COALESCE(excluded.venue, event_pages.venue), ' +
      'city=COALESCE(excluded.city, event_pages.city), ' +
      'price=COALESCE(excluded.price, event_pages.price), ' +
      'currency=COALESCE(excluded.currency, event_pages.currency), ' +
      'tm_url=COALESCE(excluded.tm_url, event_pages.tm_url), ' +
      'image=COALESCE(excluded.image, event_pages.image), ' +
      'source=excluded.source, ' +
      'updated_at=CASE WHEN event_pages.name IS NOT excluded.name ' +
      'OR event_pages.venue IS NOT COALESCE(excluded.venue, event_pages.venue) ' +
      'OR event_pages.city IS NOT COALESCE(excluded.city, event_pages.city) ' +
      'OR event_pages.price IS NOT COALESCE(excluded.price, event_pages.price) ' +
      'THEN excluded.updated_at ELSE event_pages.updated_at END'
    );
    // Rebuild independently (don't try to re-slice `batch`, which is already
    // deduped/capped against different bind params) — same seen-set + cap
    // logic as the primary path above, just without created_at.
    const legacySeen = new Set();
    const legacyBatch = [];
    for (const r of records) {
      if (!r || !r.slug || legacySeen.has(r.slug)) continue;
      legacySeen.add(r.slug);
      legacyBatch.push(legacyStmt.bind(
        r.slug, r.category, r.name, r.date,
        r.venue || null, r.city || null,
        r.price || null, r.currency || null,
        r.tmUrl || null, r.image || null,
        r.source || null, now
      ));
      if (legacyBatch.length >= 400) break;
    }
    if (legacyBatch.length) await db.batch(legacyBatch);
  }
}

// Cache-API throttle: at most one registry write per markerId per 6h per
// colo. Costs zero KV writes; fail-open and fully fire-and-forget.
function tsCaptureThrottled(env, waitUntil, markerId, buildRecords) {
  try {
    if (!env.PRICE_DB) return;
    const cache = caches.default;
    const marker = new Request('https://ts-internal.ticketscout.co.uk/event-capture/' + encodeURIComponent(markerId));
    waitUntil((async () => {
      if (await cache.match(marker)) return;
      const records = buildRecords();
      if (!records || !records.length) return;
      await tsRegisterEvents(env, records);
      await cache.put(marker, new Response('1', { headers: { 'Cache-Control': 'max-age=21600' } }));
    })().catch(() => {}));
  } catch {}
}