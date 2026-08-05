// ===========================
// TicketScout — Page discovery and auto-deployment
// Runs as a Cloudflare Pages Function at /api/discover-pages
//
// TWO PHASES — run separately to stay within Cloudflare's 30s limit:
//
// PHASE 1 — DISCOVER (source-specific, fast, no GitHub calls):
//   ?trigger=1&source=ticketmaster   — fetch TM trending events, queue new artists/venues to KV
//   ?trigger=1&source=se365          — queue SE365 participants to KV (prod only)
//   ?trigger=1&source=skiddle        — disabled (poor data quality — event names not artist names)
//   NOTE: Awin discovery is handled automatically by awin-category-cache.js
//         during its 6-hourly feed refresh — no separate job needed
//
// PHASE 2 — COMMIT (reads pending queue from KV, commits to GitHub):
//   ?trigger=1&phase=commit          — commit all pending pages to GitHub
//
// GENRE ROUTING (new — 05 Jul 2026):
//   Each queued item carries a `category` field: 'football' | 'theatre' | 'concert'
//   Commit phase routes to correct subfolder and data file:
//     football → football/[slug].html + functions/api/football.js
//     theatre  → theatre/[slug].html  + functions/api/theatre.js
//     concert  → concert/[slug].html  + functions/api/concert.js
//
// Cron schedule (cron-job.org):
//   Mon 00:00 — ?trigger=1&source=ticketmaster
//   Mon 00:10 — ?trigger=1&phase=commit          (after TM discovery + Awin cache writes)
//   Mon 00:15 — ?trigger=1&source=se365          (prod only — no-op until SE365_PROD=true)
//   Mon 00:20 — ?trigger=1&source=vividseats      — discover new artists from VS catalog
//
// Required env vars:
//   TM_API_KEY     — Ticketmaster API key (Secret)
//   GITHUB_TOKEN   — GitHub Personal Access Token with repo scope (Secret)
//   GIGSBERG_KV    — KV namespace
//   GITHUB_OWNER   — e.g. ticketandeventscout (plain text)
//   GITHUB_REPO    — e.g. ticketscout (plain text)
//   GITHUB_BRANCH  — e.g. main (plain text)
//   SE365_PROD     — set 'true' to enable SE365 discovery
// ===========================

const PENDING_KEY      = 'autodiscover:awin:pending';
const KNOWN_KEY        = 'autodiscover:artists:known';
const KNOWN_VENUES_KEY = 'autodiscover:venues:known';

// ── DIAGNOSTIC INSTRUMENTATION (added 1 Aug 2026) ──────────────────────────
// fix-categories&confirm=yes has been timing out (524) with only partial
// progress each time — confirmed by comparing consecutive dry-run outputs
// and seeing a handful of specific slugs disappear from the misfiled list
// between attempts, meaning the Worker keeps running after the client gives
// up, same pattern already found and fixed in price-rollup.js. This writes
// a KV checkpoint immediately after each stage of the confirm=yes apply
// path, so even if the whole request 524s again, we can see exactly how
// far it got. Separate KV namespace (debug:fixcat:*) from price-rollup's
// (debug:price-rollup:*) so the two never collide.
async function checkpoint(kv, step, t0) {
  const ms = Date.now() - t0;
  try {
    await kv.put(`debug:fixcat:${step}`, JSON.stringify({
      step, ms, at: new Date().toISOString()
    }), { expirationTtl: 3600 });
  } catch { /* never let instrumentation itself break the job */ }
}

// ── mergefragments instrumentation (added 1 Aug 2026, same day) ───────────
// A fresh mergefragments dry run 524'd after the scan-loop chunking fix had
// already been confirmed working (a prior run completed cleanly at
// checked: 6085). entity-lifecycle?status=1 came back fast and clean at the
// same time, ruling out general platform contention — so this is specific
// to mergefragments itself on an otherwise-idle account. Leading hypothesis:
// the registry has grown significantly while unattended (daily discovery
// crons run regardless of whether anyone is actively working), pushing
// total scan cost — not just KV round-trips, but cumulative CPU time across
// many JSON.parse + looksLikeEvent regex checks — back over the platform
// limit. This writes a progress checkpoint every 10 scan chunks (~250
// entities) so a repeat timeout shows exactly how far the scan got, rather
// than a blind 524. Own KV namespace (debug:mergefrag:*), separate from
// fix-categories' (debug:fixcat:*) — never collides.
async function mergefragCheckpoint(kv, step, t0, extra) {
  const ms = Date.now() - t0;
  try {
    await kv.put(`debug:mergefrag:${step}`, JSON.stringify({
      step, ms, at: new Date().toISOString(), ...extra
    }), { expirationTtl: 3600 });
  } catch { /* never let instrumentation itself break the job */ }
}

// ── Phase 4 keys ─────────────────────────────────────────────────────────
// sitemap:registry — per-category slug→lastmod map, the single source of
// truth for the dynamic sitemap (/api/sitemap). Built once from the GitHub
// tree (?phase=build-registry), then maintained by every commit run.
const REGISTRY_KEY = 'sitemap:registry';
// autodiscover:deferred — entities that failed the liquidity gate at commit
// time. Re-checked weekly via ?phase=recheck-deferred; requeued to pending
// when a priced offer reappears, dropped after MAX_DEFER_ATTEMPTS.
const DEFERRED_KEY          = 'autodiscover:deferred';
const LIQUIDITY_FRESH_DAYS  = 14;  // items queued within this window pass the gate
const MAX_DEFER_ATTEMPTS    = 8;   // ~2 months of weekly re-checks, then dropped

const TRIBUTE_KEYWORDS = [
  'tribute', 'salute', 'legacy', 'experience', 'revival', 'forever',
  'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs ',
  'greatest hits', 'live band', 'orchestra plays', 'ultimate'
];

const GENERIC_NAMES = new Set([
  'nfl', 'nba', 'nhl', 'mlb', 'mls', 'ufc', 'wwe', 'pga', 'nascar',
  'premier league', 'champions league', 'europa league', 'la liga',
  'serie a', 'bundesliga', 'ligue 1', 'formula 1', 'formula one'
]);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return text([
      'TicketScout page discovery — usage:',
      '  ?trigger=1&source=ticketmaster  — discover from Ticketmaster, queue to KV',
      '  ?trigger=1&source=se365         — discover from SE365, queue to KV',
      '  ?trigger=1&source=vividseats    — discover from Vivid Seats catalog, queue to KV',
      '  ?trigger=1&source=ticombo       — discover from Ticombo via Partnerize API, queue to KV',
      '  ?trigger=1&phase=commit         — commit queued pages to GitHub',
      '  ?trigger=1&phase=fix-categories — find/move entities in the wrong section (dry by default)',
      '  ?trigger=1&phase=backfill       — write KV data for already-committed pages',
      '  ?trigger=1&phase=build-registry — build sitemap:registry from the GitHub tree (one-time)',
      '  ?trigger=1&phase=slugaudit&category=concert — READ-ONLY: list slugs that disagree with toSlug(name)',
      '  ?trigger=1&phase=eventaudit&category=concert — READ-ONLY: list entities whose NAME is an event, not an entity',
      '  ?trigger=1&phase=rejected — READ-ONLY: last 200 names the event filter rejected at discovery',
      '  ?trigger=1&phase=nameaudit&category=concert — READ-ONLY: series prefixes + city variants to merge',
      '  ?trigger=1&phase=genreaudit&category=sports — re-genre sports entities stuck on \'Sports\' (dry; &confirm=yes to apply)',
      '  ?trigger=1&phase=recheck-deferred — re-check liquidity-gated entities, requeue liquid ones',
      '  &dry=1                          — dry run, no writes',
      '',
      'NOTE: Awin discovery runs automatically via awin-category-cache — no separate job needed.'
    ].join('\n'));
  }

  const dryRun = url.searchParams.get('dry') === '1';
  const source = url.searchParams.get('source') || '';
  const phase  = url.searchParams.get('phase')  || 'discover';

  const kv          = env.GIGSBERG_KV;
  const githubToken = env.GITHUB_TOKEN;
  const owner       = env.GITHUB_OWNER  || 'ticketandeventscout';
  const repo        = env.GITHUB_REPO   || 'ticketscout';
  const branch      = env.GITHUB_BRANCH || 'main';

  if (!kv) return json({ error: 'Missing GIGSBERG_KV' }, 500);

  // ── RECONCILE-VENUES PHASE — finds venues with NO backing data anywhere ──
  // repair-known-venues assumes a venue was at least marked "known" at some
  // point. "707-nightlife" proved that assumption wrong: it has a committed
  // static page and a sitemap entry, but is absent from the static array,
  // absent from the known-set, and has no venue:auto: KV record — it was
  // never touched by ANY commit path this session has found, likely a
  // leftover from an earlier version of this pipeline predating current
  // tracking entirely. repair-known-venues cannot find these; there's
  // nothing to compare knownVenues against for a slug that was never marked
  // known in the first place.
  //
  // This instead reads the REAL repo file tree (same method as
  // ?phase=build-registry) to get the TRUE set of committed venue pages,
  // and compares that against everywhere data could resolve (the static
  // array UNION every venue:auto:* KV key). The difference is a genuine
  // orphan: a live page with nothing backing it, anywhere.
  //
  // Dry run (default): reports the orphan list only.
  // &confirm=yes: for up to &limit= (default 10) orphans, attempts a live
  // Ticketmaster venue-name search to recover REAL venueId/city/country and
  // writes a venue:auto: record if found. An orphan the search can't match
  // is left alone and reported as unresolved — this never guesses or writes
  // fabricated data.
  if (phase === 'reconcile-venues') {
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const github = new GitHubAPI(githubToken, owner, repo, branch);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 25);
    const doWrite = url.searchParams.get('confirm') === 'yes';

    let tree;
    try {
      const ref  = await github.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const head = await github.request('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
      tree = await github.request('GET', `/repos/${owner}/${repo}/git/trees/${head.tree.sha}?recursive=1`);
    } catch (err) {
      return json({ error: 'GitHub tree fetch failed', detail: String(err) }, 500);
    }
    const venueRe = /^venue\/([a-z0-9-]+)\.html$/;
    const repoVenueSlugs = [];
    for (const node of (tree.tree || [])) {
      if (node.type !== 'blob') continue;
      const m = venueRe.exec(node.path);
      if (m) repoVenueSlugs.push(m[1]);
    }

    let venueJsContent;
    try { venueJsContent = await github.getFileContent('functions/api/venue.js'); }
    catch (e) { return json({ error: 'could not read functions/api/venue.js: ' + String(e) }, 500); }
    const staticSlugs = new Set(
      [...venueJsContent.matchAll(/slug:\s*'([^']+)'/g)].map(m => m[1])
    );

    let autoKvSlugs = new Set();
    try {
      let cursor;
      do {
        const page = await kv.list({ prefix: 'venue:auto:', cursor });
        for (const k of page.keys) autoKvSlugs.add(k.name.replace('venue:auto:', ''));
        cursor = page.cursor;
        if (page.list_complete) break;
      } while (cursor);
    } catch (e) {
      return json({ error: 'venue:auto: KV list failed: ' + String(e) }, 500);
    }

    const orphans = repoVenueSlugs.filter(s => !staticSlugs.has(s) && !autoKvSlugs.has(s));

    if (!doWrite) {
      return json({
        dryRun: true,
        repoVenuePages: repoVenueSlugs.length,
        resolvableViaStaticArray: staticSlugs.size,
        resolvableViaAutoKv: autoKvSlugs.size,
        orphanCount: orphans.length,
        orphanSample: orphans.slice(0, 40),
        note: orphans.length
          ? `${orphans.length} venue page(s) exist in the repo with no data anywhere (not static array, not known-set, not venue:auto: KV). Add &confirm=yes&limit=N to attempt live TM recovery for up to N of them.`
          : 'No true orphans found — every committed venue page resolves via the static array or a venue:auto: record.'
      }, 200);
    }

    const apiKey = env.TM_API_KEY;
    if (!apiKey) return json({ error: 'Missing TM_API_KEY — needed to attempt recovery' }, 500);

    let breakerOpen = false;
    try { breakerOpen = !!(await kv.get('tm:quota:exhausted')); } catch {}
    if (breakerOpen) {
      return json({ quotaBreakerOpen: true, note: 'TM quota breaker is open — no calls made. Retry later.' }, 200);
    }

    const batch = orphans.slice(0, limit);
    const recovered = [], unresolved = [];
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await new Promise(res => setTimeout(res, 250));
      const slug = batch[i];
      const keyword = slug.replace(/-/g, ' ');
      let venueData = null;
      try {
        const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/venues.json');
        tmUrl.searchParams.set('apikey', apiKey);
        tmUrl.searchParams.set('keyword', keyword);
        tmUrl.searchParams.set('size', '5');
        const r = await fetch(tmUrl.toString());
        if (r.status === 429) {
          try { await kv.put('tm:quota:exhausted', new Date().toISOString(), { expirationTtl: 600 }); } catch {}
          unresolved.push({ slug, reason: 'quota hit — stopped batch here, retry later' });
          break;
        }
        if (r.ok) {
          const data = await r.json();
          const hit = (data?._embedded?.venues || [])[0];
          if (hit) {
            venueData = {
              slug, name: hit.name || keyword,
              city: hit.city?.name || '', country: hit.country?.name || '',
              venueId: hit.id || null,
              description: `Compare ${hit.name || keyword} ticket prices across verified sellers on TicketScout.`
            };
          }
        }
      } catch (e) {
        unresolved.push({ slug, reason: 'TM fetch error: ' + String(e) });
        continue;
      }
      if (venueData) {
        try {
          await kv.put(`venue:auto:${slug}`, JSON.stringify(venueData));
          recovered.push(venueData);
        } catch (e) {
          unresolved.push({ slug, reason: 'KV write failed: ' + String(e) });
        }
      } else {
        unresolved.push({ slug, reason: 'no TM venue match for this name — needs manual attention or deletion' });
      }
    }

    return json({
      dryRun: false,
      attempted: batch.length,
      recoveredCount: recovered.length,
      recovered,
      unresolvedCount: unresolved.length,
      unresolved,
      remainingOrphans: orphans.length - batch.length,
      next: orphans.length - batch.length > 0
        ? `?phase=reconcile-venues&trigger=1&confirm=yes&limit=${limit}` : null
    }, 200);
  }

  // ── REPAIR-KNOWN-VENUES PHASE — recovery for the venue-data-file bug ────
  // Fixes the fallout from the computeVenueDataFileUpdate bug (see that
  // function's comment): venues whose static page committed and got marked
  // "known" (excluding them from all future discovery) but whose real data
  // (venueId/city/country) never actually made it into venue.js's VENUES
  // array, because the old insertion logic silently no-op'd. Those venues
  // are stuck forever under the OLD code, since "known" venues are never
  // re-offered by discovery.
  //
  // Self-correcting rather than a hardcoded list: reads the REAL venue.js
  // file to see which slugs actually have data, reads the "known" set to
  // see which slugs were marked as handled, and the difference IS the stuck
  // set — this also catches any future recurrence of the same failure mode
  // automatically, not just this one incident.
  //
  // Dry-run by default (reports the stuck list only). &confirm=yes removes
  // exactly those slugs from the known-set, so the NEXT discover+commit
  // sweep finds them again — with FRESH real data pulled from live TM
  // events, since the original discovery data for the stuck batch was
  // already cleared (PENDING_KEY is deleted at the end of every commit,
  // succeeded or not) and can't be recovered directly.
  if (phase === 'repair-known-venues') {
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const github = new GitHubAPI(githubToken, owner, repo, branch);

    let venueJsContent;
    try {
      venueJsContent = await github.getFileContent('functions/api/venue.js');
    } catch (e) {
      return json({ error: 'could not read functions/api/venue.js: ' + String(e) }, 500);
    }
    const realSlugs = new Set(
      [...venueJsContent.matchAll(/slug:\s*'([^']+)'/g)].map(m => m[1])
    );

    let knownVenues = [];
    try {
      const k = await kv.get(KNOWN_VENUES_KEY);
      if (k) knownVenues = JSON.parse(k);
    } catch (e) {
      return json({ error: 'could not read ' + KNOWN_VENUES_KEY + ': ' + String(e) }, 500);
    }

    // ?inspect=<slug> — direct, single-slug diagnostic. Bypasses the whole
    // known-set/stuck computation and just reports every place this ONE
    // slug's data could plausibly live, so a confusing case can be checked
    // directly instead of inferred from the aggregate repair numbers.
    const inspectSlug = url.searchParams.get('inspect');
    if (inspectSlug) {
      const s = inspectSlug.toLowerCase();
      let kvAutoRaw = null;
      try { kvAutoRaw = await kv.get(`venue:auto:${s}`); } catch {}
      return json({
        slug: s,
        inStaticVenuesArray: realSlugs.has(s),
        inKnownVenuesSet: knownVenues.includes(s),
        kvAutoRecordExists: !!kvAutoRaw,
        kvAutoRecord: kvAutoRaw ? JSON.parse(kvAutoRaw) : null
      }, 200);
    }

    // A venue is genuinely fine if it's in the static array OR has a
    // venue:auto:{slug} KV record — the latter is now the NORMAL path for
    // anything committed via commitPendingPagesBatch (the default commit
    // function), not a sign of anything wrong. Only flag as stuck if
    // NEITHER exists — that's the actual "known but data saved nowhere"
    // dead end this phase exists to find.
    const stuck = [];
    for (const slug of knownVenues) {
      if (realSlugs.has(slug)) continue;
      try {
        const raw = await kv.get(`venue:auto:${slug}`);
        if (raw) continue; // has a valid KV record — not stuck
      } catch {}
      stuck.push(slug);
    }

    // FIX: this used to branch on the file-wide `dryRun` variable (defined
    // once at the top of onRequestGet from ?dry=1), NOT on this phase's own
    // documented &confirm=yes convention. Since neither of those are the
    // same query param, calling this phase with &confirm=yes had ZERO
    // effect — every call, with or without it, ran the WRITE path (dry=1
    // was never set), and "the dry run" was silently never a dry run at
    // all. Now gated on its own explicit, local check.
    const doWrite = url.searchParams.get('confirm') === 'yes';
    if (!doWrite) {
      return json({
        dryRun: true,
        realVenuesInDataFile: realSlugs.size,
        totalMarkedKnown: knownVenues.length,
        stuckCount: stuck.length,
        stuckSample: stuck.slice(0, 30),
        note: stuck.length
          ? `${stuck.length} venue(s) are marked "known" but have no entry in venue.js — they have a static page and sitemap listing but their API 404s. Add &confirm=yes to un-stick them for rediscovery.`
          : 'Nothing stuck — known-set matches the real data file exactly.'
      }, 200);
    }

    const stuckSet = new Set(stuck);
    const repaired = knownVenues.filter(slug => !stuckSet.has(slug));
    try {
      await kv.put(KNOWN_VENUES_KEY, JSON.stringify(repaired));
    } catch (e) {
      return json({ error: 'write failed: ' + String(e) }, 500);
    }
    return json({
      dryRun: false,
      removedFromKnown: stuck.length,
      removedSample: stuck.slice(0, 30),
      note: 'These will be re-offered by the next ?phase=discover run, with fresh real data — their static pages already exist so the new commit will just update, not duplicate, them.'
    }, 200);
  }

  // ── COMMIT PHASE ──────────────────────────────────────────────────────────
  if (phase === 'commit') {
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const useLegacy = url.searchParams.get('legacy') === '1';
    return useLegacy
      ? await commitPendingPages(kv, githubToken, owner, repo, branch, dryRun, env)
      : await commitPendingPagesBatch(kv, githubToken, owner, repo, branch, dryRun, env);
  }

  // ── BUILD-REGISTRY PHASE (Phase 4) — one-time sitemap registry build ─────
  // Reads the FULL repo tree from GitHub (1 API call) and records every
  // on-disk entity page into sitemap:registry, keyed by category:
  //   { updated, sections: { concert: {slug:'YYYY-MM-DD'}, football: {...},
  //     theatre: {...}, venue: {...} } }
  // /api/sitemap serves the live sitemap directly from this key.
  // Initial lastmod = today (we don't know true creation dates; from now on
  // the commit job stamps real dates). Safe to re-run: existing lastmod
  // values are preserved, only missing slugs are added.
  if (phase === 'build-registry') {
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const github = new GitHubAPI(githubToken, owner, repo, branch);
    let tree;
    try {
      const ref  = await github.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const head = await github.request('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
      tree = await github.request('GET', `/repos/${owner}/${repo}/git/trees/${head.tree.sha}?recursive=1`);
    } catch (err) {
      return json({ error: 'GitHub tree fetch failed', detail: String(err) }, 500);
    }

    let registry = { updated: null, sections: { concert: {}, football: {}, theatre: {}, sports: {}, venue: {} } };
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    for (const cat of ['concert', 'football', 'theatre', 'sports', 'venue']) {
      if (!registry.sections[cat]) registry.sections[cat] = {};
    }

    const today = new Date().toISOString().slice(0, 10);
    const counts = { concert: 0, football: 0, theatre: 0, sports: 0, venue: 0, skipped: 0 };
    const re = /^(concert|football|theatre|sports|venue)\/([a-z0-9-]+)\.html$/;
    for (const node of (tree.tree || [])) {
      if (node.type !== 'blob') continue;
      const m = re.exec(node.path);
      if (!m) continue;
      const [, cat, slug] = m;
      if (registry.sections[cat][slug]) { counts.skipped++; continue; } // preserve existing lastmod
      registry.sections[cat][slug] = today;
      counts[cat]++;
    }
    registry.updated = new Date().toISOString();

    if (dryRun) return json({ dryRun: true, added: counts,
      totals: Object.fromEntries(Object.entries(registry.sections).map(([k, v]) => [k, Object.keys(v).length])),
      truncatedTree: !!tree.truncated }, 200);

    await kv.put(REGISTRY_KEY, JSON.stringify(registry));
    return json({
      message: 'Sitemap registry built. Verify at /api/sitemap?sec=football then deploy the new static sitemap.xml index.',
      added: counts,
      totals: Object.fromEntries(Object.entries(registry.sections).map(([k, v]) => [k, Object.keys(v).length])),
      truncatedTree: !!tree.truncated
    }, 200);
  }

  // ── RECHECK-DEFERRED PHASE (Phase 4) — weekly liquidity re-check ─────────
  // Walks the deferred queue (entities that had no priced offer at commit
  // time). For each, searches the live Awin cache; if the entity now has
  // ≥1 offer it's requeued to pending with a fresh timestamp. Items are
  // dropped after MAX_DEFER_ATTEMPTS failed re-checks.
  // Usage: ?trigger=1&phase=recheck-deferred [&limit=10]
  if (phase === 'recheck-deferred') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 25);
    let deferred = [];
    try { const d = await kv.get(DEFERRED_KEY); if (d) deferred = JSON.parse(d); } catch {}
    if (deferred.length === 0) return json({ message: 'Deferred queue is empty.', rechecked: 0 }, 200);

    const origin = new URL(request.url).origin;
    const batch = deferred.slice(0, limit);
    const rest  = deferred.slice(limit);
    const requeued = [], kept = [], dropped = [];

    for (const item of batch) {
      let liquid = false;
      // Cheap check first: Phase 2 price summary
      try { if (await kv.get(`price:summary:entity:${item.slug}`)) liquid = true; } catch {}
      // Otherwise search the Awin cache via our own API (same-zone subrequest)
      if (!liquid) {
        try {
          const r = await fetch(`${origin}/api/awin-category?q=${encodeURIComponent(item.name || item.slug)}`);
          if (r.ok) { const d = await r.json(); liquid = (d.matches || []).length > 0; }
        } catch {}
      }
      if (liquid) {
        requeued.push({ ...item, queuedAt: new Date().toISOString(), deferAttempts: undefined });
      } else {
        const attempts = (item.deferAttempts || 0) + 1;
        if (attempts >= MAX_DEFER_ATTEMPTS) dropped.push(item.slug);
        else kept.push({ ...item, deferAttempts: attempts });
      }
    }

    if (!dryRun) {
      // Rotate: unprocessed rest first, then kept (so next run sees fresh items)
      await kv.put(DEFERRED_KEY, JSON.stringify([...rest, ...kept]));
      if (requeued.length) {
        let existing = { artists: [], venues: [] };
        try { const ep = await kv.get(PENDING_KEY); if (ep) existing = JSON.parse(ep); } catch {}
        await kv.put(PENDING_KEY, JSON.stringify({
          artists: [...(existing.artists || []), ...requeued],
          venues: existing.venues || [],
          updatedAt: new Date().toISOString()
        }), { expirationTtl: 8 * 60 * 60 });
      }
    }
    return json({ rechecked: batch.length, requeued: requeued.map(i => i.slug),
      stillDeferred: kept.length + rest.length, dropped, dryRun }, 200);
  }

  // ── REGENERATE PHASE (Phase 4.1/4.2) — rebuild existing stubs in batches ─
  // Regenerates on-disk entity stubs with: the Tier-1 comparison title
  // pattern, a fact-based meta description, and the server-side JSON-LD
  // @graph (from entity:meta written by /api/enrich-entities). Also cures
  // Hamilton-class template drift — every regenerated stub points at the
  // current TEMPLATE_VERSION.
  // Cursor-batched: ?trigger=1&phase=regenerate&category=football [&limit=50]
  // Run per category after enrichment has covered it. Safe to re-run.
  if (phase === 'regenerate') {
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const category = url.searchParams.get('category');
    if (!['football', 'concert', 'theatre', 'sports'].includes(category)) {
      return json({ error: 'category is required: football | concert | theatre | sports' }, 400);
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 150);

    let registry = null;
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    if (!registry || !registry.sections || !registry.sections[category]) {
      return json({ error: 'sitemap:registry not built — run ?phase=build-registry first' }, 503);
    }
    const slugs = Object.keys(registry.sections[category]).sort();

    const cursorKey = `regen:cursor:${category}`;
    let offset = parseInt(url.searchParams.get('offset') || '', 10);
    if (isNaN(offset)) {
      try { const c = await kv.get(cursorKey); offset = c ? parseInt(c, 10) || 0 : 0; } catch { offset = 0; }
    }
    const batch = slugs.slice(offset, offset + limit);
    if (batch.length === 0) {
      if (!dryRun) await kv.delete(cursorKey).catch(() => {});
      return json({ message: `Regeneration of ${category} complete (${slugs.length} pages). Cursor reset.`, done: true }, 200);
    }

    // Build enriched HTML for the batch
    const kvPrefix = categoryToKvPrefix(category);
    const htmlGenerator = categoryToHtmlGenerator(category);
    const files = [];
    let enrichedCount = 0;
    for (const slug of batch) {
      let name = null, facts = null;
      try { const rec = await kv.get(kvPrefix + slug); if (rec) name = JSON.parse(rec).name; } catch {}
      try {
        const m = await kv.get(`entity:meta:${category}:${slug}`);
        if (m) { facts = JSON.parse(m).facts; enrichedCount++; }
      } catch {}
      files.push({ path: `${category}/${slug}.html`, content: htmlGenerator(slug, { name, facts }) });
    }

    if (dryRun) {
      return json({
        dryRun: true, category, offset, batchSize: batch.length,
        withEnrichmentFacts: enrichedCount, totalInSection: slugs.length,
        sampleHead: files[0].content.slice(0, 1400),
        message: 'Dry run — nothing committed.'
      }, 200);
    }

    // Reuse the commit lock so a regen never races the Mon 00:10 auto-commit
    const lock = await kv.get(COMMIT_LOCK_KEY);
    if (lock) return json({ error: 'A commit run is in progress — try again in a few minutes.', lockedAt: lock }, 429);
    await kv.put(COMMIT_LOCK_KEY, new Date().toISOString(), { expirationTtl: COMMIT_LOCK_TTL });

    const github = new GitHubAPI(githubToken, owner, repo, branch);
    let commitSha;
    try {
      commitSha = await github.commitFilesBatch(files,
        `Regenerate ${files.length} ${category} stubs: enriched titles, meta, JSON-LD (v${TEMPLATE_VERSION})`);
    } catch (err) {
      await kv.delete(COMMIT_LOCK_KEY).catch(() => {});
      return json({ error: 'Batch commit failed — cursor NOT advanced, safe to retry.', detail: String(err) }, 500);
    }

    // lastmod = today for regenerated pages (real content change: new copy/schema)
    const today = new Date().toISOString().slice(0, 10);
    for (const slug of batch) registry.sections[category][slug] = today;
    registry.updated = new Date().toISOString();
    await kv.put(REGISTRY_KEY, JSON.stringify(registry));

    const nextOffset = offset + batch.length;
    const done = nextOffset >= slugs.length;
    if (done) await kv.delete(cursorKey).catch(() => {});
    else await kv.put(cursorKey, String(nextOffset));
    await kv.delete(COMMIT_LOCK_KEY).catch(() => {});

    return json({
      category, commitSha, regenerated: batch.length, withEnrichmentFacts: enrichedCount,
      progress: `${nextOffset}/${slugs.length}`, done,
      next: done ? null : `?trigger=1&phase=regenerate&category=${category}&limit=${limit}`
    }, 200);
  }

  // ── BACKFILL PHASE — write KV data for already-committed pages ───────────
  // ── GENREAUDIT / GENREFIX PHASE ──────────────────────────────────────────
  // The 300 entities moved to /sports/ by fix-categories landed under "Other"
  // because their stored genre is the literal string 'Sports' (the SE365 1023
  // corruption). fix-categories fixed the SECTION; this fixes the GENRE, so the
  // sports hub can sub-classify them into Tennis / Motorsport / Wrestling / etc.
  //
  // Mirror image of the SPORTS_GENRES fix: that stopped NEW sports events
  // becoming concerts; this re-genres the EXISTING ones already in /sports/.
  //
  // SPORT INFERENCE IS FROM THE EVENT NAME, structurally, per s7.6. Each rule
  // is a distinctive multi-token signature, not a bare noun. A name matching NO
  // rule is left as-is and reported under 'unmatched' for review — we never
  // guess. This is the same discipline as the event filter: under-classify
  // rather than mislabel.
  //
  // Also re-genres the 5 musician-veto entities (adele etc.) whose CONCERT-
  // section genre is still 'Sports' — they get 'Live Music' so they stop
  // appearing in every fix-categories dry run.
  //
  // Usage: ?trigger=1&phase=genreaudit[&category=sports]           dry, default
  //        ?trigger=1&phase=genreaudit&category=sports&confirm=yes  apply
  if (phase === 'genreaudit' || phase === 'genrefix') {
    const category = (url.searchParams.get('category') || 'sports').toLowerCase();
    const confirm  = url.searchParams.get('confirm') === 'yes';
    const limit    = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 800);

    let registry = null;
    try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
    if (!registry?.sections?.[category]) {
      return json({ error: 'No registry section "' + category + '"' }, 503);
    }

    // Distinctive signatures only. First match wins; order is specific->general.
    // ORDER MATTERS: specific sports with unambiguous keywords first, so that a
    // greedy generic like 'open' (which reads as tennis) cannot pre-empt an
    // esports or golf event that also contains it. 'open' is deliberately the
    // LAST tennis signal and gated to appear only where no earlier rule fired.
    // ORDER MATTERS: unambiguous org/league keywords first; greedy generics
    // ('open','masters','final four') last within their family. Every rule is a
    // distinctive multi-token signature, never a bare common noun (s7.6).
    const SPORT_RULES = [
      { sport: 'esports',           re: /\b(esl|blast premier|intel extreme|fortnite|counter-strike|league of legends|dota|valorant|age of empires)\b/i },
      // Volleyball BEFORE basketball: 'CEV ... Final Four Final' is volleyball,
      // but basketball's 'final four' rule would otherwise steal it.
      { sport: 'volleyball',        re: /\b(volleyball|\bcev\b|siatk)\b/i },
      { sport: 'motorsport',        re: /\b(f1|formula 1|formula e|grand prix|\bgp\b|\bgp:|motogp|nascar|le mans|24 hours of|e-prix|festival of speed)\b/i },
      { sport: 'wrestling',         re: /\b(wwe|aew|wrestling|wrestlemania|smackdown|dynamite|collision)\b/i },
      { sport: 'american football', re: /\b(nfl|super bowl|afle|thursday night football|sunday night football|monday night football)\b/i },
      { sport: 'ice hockey',        re: /\b(nhl|iihf|ice hockey|stanley cup|hockey|oiho)\b/i },
      { sport: 'basketball',        re: /\b(nba|euroleague|basketball|final four)\b/i },
      { sport: 'rugby',             re: /\b(rugby|six nations|premiership rugby)\b/i },
      { sport: 'boxing',            re: /\b(boxing|title fight|heavyweight|welterweight|la velada)\b/i },
      { sport: 'mma',               re: /\b(ufc|mma|bellator|cage warriors)\b/i },
      { sport: 'cricket',           re: /\b(cricket|the ashes|\bt20\b|\bodi\b|\bipl\b)\b/i },
      { sport: 'baseball',          re: /\b(mlb|baseball|world series)\b/i },
      { sport: 'handball',          re: /\b(handball|piłce ręcznej|pilce recznej)\b/i },
      { sport: 'darts',            re: /\b(darts|pdc)\b/i },
      { sport: 'snooker',          re: /\b(snooker)\b/i },
      { sport: 'horse racing',     re: /\b(cheltenham|grand national|royal ascot|epsom derby|aintree|goodwood|horse racing)\b/i },
      { sport: 'winter sports',    re: /\b(winter games|big air|free skating|figure skating|snowboard|osbd|ocur|ofsk|curling)\b/i },
      { sport: 'football',         re: /\b(champions league|carabao cup|fa cup|world cup|europa league|coupe de france|super match|premier league)\b/i },
      { sport: 'golf',              re: /\b(pga|ryder cup|the open championship|players championship|golf)\b/i },
      // Tennis LAST. 'open'/'masters' are greedy so they sit here, after every
      // unambiguous sport has had first refusal.
      { sport: 'tennis',            re: /\b(atp|wta|tennis|davis cup|laver cup|wimbledon|roland garros|\bopen\b|masters|bnl)\b/i },
    ];

    const prefix = category === 'sports' ? categoryToKvPrefix('sports') : categoryToKvPrefix(category);
    const slugs  = Object.keys(registry.sections[category]).slice(0, limit);

    const bySport = {};
    const unmatched = [];
    const plan = [];
    let checked = 0, alreadyOk = 0, noRecord = 0;

    // In the CONCERT section we only touch entities whose genre is the bogus
    // 'Sports' string (the veto set) — everything else keeps its genre.
    const concertMode = category === 'concert';

    for (const slug of slugs) {
      let rec = null;
      try { const raw = await kv.get(prefix + slug); if (raw) rec = JSON.parse(raw); } catch {}
      if (!rec) { noRecord++; continue; }
      checked++;
      const name  = rec.name || slug;
      const genre = rec.genre || '';

      if (concertMode) {
        // Widened to catch both the plural 'Sports' (original SE365 1023 bug)
        // and the singular 'Sport' (confirmed live 31 Jul on real entities
        // carrying this exact string) — same corruption, two literal forms.
        if (genre !== 'Sports' && genre !== 'Sport') continue;  // only the corrupted ones
        plan.push({ slug, name, from: genre, to: 'Live Music', sport: 'music' });
        continue;
      }

      // sports section: only re-genre entities still carrying a non-sport genre
      const g = genre.toLowerCase();
      const alreadySport = SPORT_RULES.some(r => r.sport === g);
      if (alreadySport) { alreadyOk++; continue; }

      const hit = SPORT_RULES.find(r => r.re.test(name));
      if (!hit) { unmatched.push({ slug, name, genre }); continue; }
      bySport[hit.sport] = (bySport[hit.sport] || 0) + 1;
      plan.push({ slug, name, from: genre, to: hit.sport, sport: hit.sport });
    }

    // APPLY
    let updated = 0;
    if (confirm && plan.length) {
      for (const item of plan) {
        try {
          const raw = await kv.get(prefix + item.slug);
          if (!raw) continue;
          const rec = JSON.parse(raw);
          rec.genre = item.to;
          await kv.put(prefix + item.slug, JSON.stringify(rec));
          updated++;
        } catch {}
      }
      // Bust the hub cache so the sub-category counts refresh.
      try { await kv.delete(category + ':hub:index'); } catch {}
    }

    return json({
      phase: 'genreaudit',
      category,
      dryRun: !confirm,
      checked, alreadyOk, noRecord,
      planCount: plan.length,
      updated,
      bySport: concertMode ? { music: plan.length } : bySport,
      unmatchedCount: unmatched.length,
      unmatched: unmatched.slice(0, 60),
      planSample: plan.slice(0, 40),
      message: confirm
        ? `Updated ${updated} genres. Hub cache cleared.`
        : 'Dry run — add &confirm=yes to apply. Review unmatched: those keep their current genre.'
    }, 200);
  }

  // ── NAMEAUDIT PHASE — READ-ONLY, no writes ───────────────────────────────
  // Finds the two junk classes the event filter CANNOT catch, because neither
  // should be rejected — both should be MERGED into an existing entity.
  //
  //   A. SERIES PREFIX   "Southampton Summer Sessions: Bowling For Soup"
  //                      "Firenze Rocks: Lenny Kravitz"
  //      The artist is the entity we want; the prefix fragments it across many
  //      near-duplicate pages.
  //
  //   B. CITY VARIANT    "Burna Boy" / "Burna Boy Copenhagen" / "... Helsinki"
  //                      "Fito & Fitipaldis" + five city variants
  //
  // DETECTION IS DATA-DRIVEN, NOT A WORD LIST. Per s7.6, a hand-written list of
  // festival or city nouns would score well here and fail on the next section.
  // Instead:
  //   A. a token prefix shared by >= MIN_SERIES distinct slugs, each with a
  //      DIFFERENT remainder, is a series prefix — the repetition is the
  //      evidence.
  //   B. a slug that extends another slug that ALSO EXISTS in the registry is
  //      a variant of it — the base entity's existence is the evidence.
  //
  // Operates on registry slugs only: ONE KV read, whole-section clustering, no
  // per-entity fetches.
  //
  // THIS IS A REVIEW QUEUE, NOT AN ACTION LIST. Class B especially: "Real
  // Madrid" / "Real Madrid Castilla" are different clubs, and "Aberdeen" /
  // "Aberdeen FC" are the same one. Nothing here is safe to merge blind.
  //
  // Usage: ?trigger=1&phase=nameaudit&category=concert[&minSeries=3][&full=1]
  if (phase === 'nameaudit') {
    const category   = (url.searchParams.get('category') || 'concert').toLowerCase();
    const MIN_SERIES = Math.max(2, parseInt(url.searchParams.get('minSeries') || '3', 10) || 3);
    const full       = url.searchParams.get('full') === '1';

    let registry = null;
    try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
    if (!registry?.sections?.[category]) {
      return json({ error: 'No registry section "' + category + '"' }, 503);
    }

    const slugs   = Object.keys(registry.sections[category]).sort();
    const slugSet = new Set(slugs);

    // ── Class A: repeated token prefixes ──────────────────────────────────
    const prefixMap = new Map();
    for (const slug of slugs) {
      const parts = slug.split('-');
      for (let k = 2; k <= Math.min(6, parts.length - 1); k++) {
        const pre = parts.slice(0, k).join('-');
        const rem = parts.slice(k).join('-');
        if (!rem) continue;
        if (!prefixMap.has(pre)) prefixMap.set(pre, new Set());
        prefixMap.get(pre).add(rem);
      }
    }
    let series = [];
    for (const [pre, rems] of prefixMap) {
      if (rems.size >= MIN_SERIES) series.push({ prefix: pre, variants: rems.size });
    }
    // Keep only the LONGEST prefix of each family: "southampton-summer" and
    // "southampton-summer-sessions" both qualify; only the latter is the real
    // series name.
    series.sort((a, b) => b.prefix.length - a.prefix.length);
    const kept = [];
    for (const s of series) {
      if (!kept.some(k => k.prefix.startsWith(s.prefix + '-'))) kept.push(s);
    }
    kept.sort((a, b) => b.variants - a.variants);
    const seriesOut = (full ? kept : kept.slice(0, 40)).map(s => ({
      ...s,
      examples: slugs.filter(x => x.startsWith(s.prefix + '-')).slice(0, 5)
    }));

    // ── Class B: slugs extending an existing slug ─────────────────────────
    const variants = [];
    for (const slug of slugs) {
      const parts = slug.split('-');
      for (let k = parts.length - 1; k >= 1; k--) {
        const base = parts.slice(0, k).join('-');
        if (slugSet.has(base)) {
          variants.push({ slug, base, extra: parts.slice(k).join('-') });
          break; // longest existing base only
        }
      }
    }

    return json({
      phase: 'nameaudit',
      readOnly: true,
      category,
      totalInSection: slugs.length,
      minSeries: MIN_SERIES,
      seriesPrefixCount: kept.length,
      seriesPrefixes: seriesOut,
      variantCount: variants.length,
      variants: full ? variants : variants.slice(0, 60),
      note: 'REVIEW QUEUE. Class B contains legitimate distinct entities ' +
            '(Real Madrid / Real Madrid Castilla). Nothing here is safe to merge blind.'
    }, 200);
  }

  // ── REJECTED PHASE — READ-ONLY. What the event filter actually stopped.
  // Check this after each discovery run for the first few weeks: a name here
  // that is a real performer means a pattern needs narrowing.
  // Usage: ?trigger=1&phase=rejected
  // ── RECONCILE (read-only): find split-state entities from an interrupted move
  // A move that timed out mid-KV-loop can leave: new page + registry updated,
  // but the OLD-section KV record NOT deleted (old URL still serves), or the new
  // KV record missing (new URL 404s). This audits the registry against KV to
  // surface both. Usage: ?trigger=1&phase=reconcile[&section=theatre]
  if (phase === 'reconcile') {
    // MUST be batched: a full nested scan is >10k KV reads and trips 1102.
    // One section per call, cursor-paged, and we only check the ONE most-likely
    // stale prefix per section (the theatre move came FROM concert or sports),
    // not all four — that cuts KV reads to ~2 per entity.
    let registry = null;
    try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
    if (!registry?.sections) return json({ error: 'no registry' }, 503);

    const sec    = (url.searchParams.get('section') || 'theatre').toLowerCase();
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '150', 10) || 150, 200);
    const doFix  = url.searchParams.get('fix') === '1';

    const prefixes = {
      concert: 'concert:artist:', football: 'football:team:',
      theatre: 'theatre:show:', sports: 'sports:team:', venue: 'venue:venue:'
    };
    // Where entities in `sec` most plausibly have a stale record. The moves this
    // session were concert->theatre, sports->concert, sports->football,
    // concert->football. So a theatre entity's stale twin is in concert; a
    // football entity's is in sports or concert; a concert entity's is in sports.
    const staleSourcesFor = {
      theatre:  ['concert'],
      football: ['concert', 'sports'],
      concert:  ['sports'],
      sports:   ['concert'],
      venue:    []
    };

    const allSlugs = Object.keys(registry.sections[sec] || {}).sort();
    const slice = allSlugs.slice(offset, offset + limit);
    const newPfx = prefixes[sec];
    const sources = staleSourcesFor[sec] || [];

    const staleOldRecords = [];
    const missingNewRecords = [];
    let fixed = 0;

    const doRepair = url.searchParams.get('repair') === '1';
    let skippedFixWouldOrphan = 0, repaired = 0;
    for (const slug of slice) {
      // (a) new record present?
      let present = false;
      try { present = !!(await kv.get(newPfx + slug)); } catch {}
      if (!present) missingNewRecords.push({ slug, section: sec, expectedKey: newPfx + slug });
      // (b) stale record in a plausible source section?
      for (const src of sources) {
        const staleKey = prefixes[src] + slug;
        let staleRaw = null;
        try { staleRaw = await kv.get(staleKey); } catch {}
        if (staleRaw) {
          staleOldRecords.push({ slug, nowIn: sec, staleIn: src, staleKey });

          if (!present && doRepair) {
            // SPLIT-STATE REPAIR: new record missing but old survives. Copy the
            // old record to the new key (fixing the 404), stamp the new section,
            // then delete the old (fixing the duplicate). This is the cats case.
            try {
              const rec = JSON.parse(staleRaw);
              rec.category = sec;
              rec.slug = slug;
              await kv.put(newPfx + slug, JSON.stringify(rec));
              await kv.delete(staleKey);
              repaired++;
              present = true; // now present, so the fix branch below is satisfied
            } catch {}
          } else if (doFix && present) {
            // Clean delete: new record exists, old is a leftover duplicate.
            try { await kv.delete(staleKey); fixed++; } catch {}
          } else if (doFix && !present) {
            skippedFixWouldOrphan++;
          }
        }
      }
    }

    const nextOffset = offset + limit;
    const done = nextOffset >= allSlugs.length;
    return json({
      phase: 'reconcile', readOnly: !doFix && !doRepair, section: sec,
      batch: { offset, size: slice.length, total: allSlugs.length },
      staleOldRecordCount: staleOldRecords.length,
      missingNewRecordCount: missingNewRecords.length,
      fixedStaleRecords: fixed,
      repairedSplitState: repaired,
      skippedFixWouldOrphan,
      staleOldRecords: staleOldRecords.slice(0, 100),
      missingNewRecords: missingNewRecords.slice(0, 100),
      done,
      next: done ? null : `?trigger=1&phase=reconcile&section=${sec}&offset=${nextOffset}&limit=${limit}${doFix ? '&fix=1' : ''}`,
      guidance: 'staleOldRecords: old URL still serves — &fix=1 deletes the stale key (safe; registry points elsewhere). ' +
                'missingNewRecords: new URL 404s — needs the page/record recreated (separate step).'
    }, 200);
  }

  if (phase === 'rejected') {
    let log = [];
    try { const r = await kv.get('discover:rejected:log'); if (r) log = JSON.parse(r); } catch {}
    const byLabel = {};
    for (const e of log) byLabel[e.label] = (byLabel[e.label] || 0) + 1;
    return json({ phase: 'rejected', readOnly: true, total: log.length, byLabel, log }, 200);
  }

  // ── EVENTAUDIT PHASE — READ-ONLY, performs no writes ─────────────────────
  // Runs looksLikeEvent() over every registered entity NAME and reports what a
  // discovery-time filter WOULD have rejected. Nothing is rejected or removed.
  //
  // Read the counts per label before trusting any pattern: a label firing far
  // more than expected is the signature of a false positive, which is exactly
  // how the s7.6 purge-detector failure would have been caught early.
  //
  // Usage: ?trigger=1&phase=eventaudit&category=concert&offset=0&limit=400
  //        &full=1  — list every match rather than samples
  if (phase === 'eventaudit') {
    const category = (url.searchParams.get('category') || 'concert').toLowerCase();
    const offset   = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
    const limit    = Math.min(parseInt(url.searchParams.get('limit') || '400', 10) || 400, 600);
    const full     = url.searchParams.get('full') === '1';

    let registry = null;
    try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
    if (!registry || !registry.sections || !registry.sections[category]) {
      return json({ error: 'No registry section "' + category + '"' }, 503);
    }

    const slugs  = Object.keys(registry.sections[category]).sort();
    const batch  = slugs.slice(offset, offset + limit);
    const prefix = categoryToKvPrefix(category);

    const byLabel = {};
    const cleanSample = [];
    let checked = 0, noRecord = 0, tierA = 0, tierB = 0;

    for (const slug of batch) {
      let raw = null;
      try { raw = await kv.get(prefix + slug); } catch {}
      if (!raw) { noRecord++; continue; }
      let rec = null;
      try { rec = JSON.parse(raw); } catch { continue; }
      const name = (rec && rec.name) || '';
      if (!name) continue;
      checked++;

      const hit = looksLikeEvent(name);
      if (!hit) {
        if (cleanSample.length < 15) cleanSample.push(name);
        continue;
      }
      if (hit.tier === 'A') tierA++; else tierB++;
      const key = hit.tier + ':' + hit.label;
      if (!byLabel[key]) byLabel[key] = { tier: hit.tier, label: hit.label, count: 0, samples: [] };
      byLabel[key].count++;
      if (full || byLabel[key].samples.length < 6) byLabel[key].samples.push({ slug, name });
    }

    const groups = Object.values(byLabel).sort((a, b) => b.count - a.count);
    const nextOffset = offset + batch.length;
    const done = nextOffset >= slugs.length;

    return json({
      phase: 'eventaudit',
      readOnly: true,
      category,
      totalInSection: slugs.length,
      batch: { offset, size: batch.length },
      checked, noRecord,
      wouldRejectTierA: tierA,
      flagForReviewTierB: tierB,
      groups,
      cleanSample,
      done,
      next: done ? null : '?trigger=1&phase=eventaudit&category=' + category +
        '&offset=' + nextOffset + '&limit=' + limit + (full ? '&full=1' : '')
    }, 200);
  }

  // ── SLUGAUDIT PHASE — READ-ONLY, performs no writes ──────────────────────
  // Lists entities whose stored slug disagrees with toSlug(name) recomputed
  // from the stored display name.
  //
  // WHY: before 24 Jul 2026, toSlug() deleted any letter with no canonical NFD
  // decomposition — Polish l-stroke most visibly — so "Michal Szotan" became
  // "micha-sotan". Fixing toSlug does NOT rename those entities: discovery
  // would register "michal-szotan" as a NEW entity beside the mangled one,
  // reproducing the duplicate-club-page problem on purpose.
  //
  // Run this, review, purge the confirmed mangled slugs via /api/registry-purge,
  // THEN the corrected toSlug is safe to rely on.
  //
  // This is a REVIEW QUEUE, not a removal list (cf. 'no-kv-record is a repair
  // signal'). A mismatch can also mean the display name was legitimately edited
  // after registration, or the slug was hand-curated. Confirm before purging.
  //
  // Long names may differ only in the tail: the old toSlug dropped characters
  // BEFORE the 60-char truncation, so the corrected slug can truncate at a
  // different point. Those are still genuine mangles.
  //
  // Usage: ?trigger=1&phase=slugaudit&category=concert&offset=0&limit=200
  if (phase === 'slugaudit') {
    const category = (url.searchParams.get('category') || 'concert').toLowerCase();
    const offset   = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
    const limit    = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 400);

    let registry = null;
    try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
    if (!registry || !registry.sections || !registry.sections[category]) {
      return json({ error: 'No registry section "' + category + '" — valid: ' +
        Object.keys((registry && registry.sections) || {}).join(', ') }, 503);
    }

    const slugs  = Object.keys(registry.sections[category]).sort();
    const batch  = slugs.slice(offset, offset + limit);
    const prefix = categoryToKvPrefix(category);

    const mismatches = [];
    let checked = 0, noRecord = 0, noName = 0, errors = 0;

    for (const slug of batch) {
      try {
        const raw = await kv.get(prefix + slug);
        if (!raw) { noRecord++; continue; }
        let rec;
        try { rec = JSON.parse(raw); } catch { errors++; continue; }
        const name = (rec && rec.name) || '';
        if (!name) { noName++; continue; }
        checked++;
        const correct = toSlug(name);
        if (correct && correct !== slug) {
          mismatches.push({ slug, name, correctSlug: correct });
        }
      } catch { errors++; }
    }

    const nextOffset = offset + batch.length;
    const done = nextOffset >= slugs.length;
    return json({
      phase: 'slugaudit',
      readOnly: true,
      category,
      totalInSection: slugs.length,
      batch: { offset, size: batch.length },
      checked, noRecord, noName, errors,
      mismatchCount: mismatches.length,
      mismatches,
      done,
      next: done ? null : '?trigger=1&phase=slugaudit&category=' + category +
        '&offset=' + nextOffset + '&limit=' + limit
    }, 200);
  }

  // Run once after deploying genre routing to populate KV for existing pages
  // Usage: ?trigger=1&phase=backfill
  if (phase === 'backfill') {
    // Walk the known-slugs list (all auto-committed pages ever), and for each:
    //   - if its entity record exists in KV: rewrite it WITHOUT a TTL
    //     (repairs records silently counting down to 30-day expiry)
    //   - if the record already expired: write a minimal record so the
    //     page's /api/[category]?slug= stops 404ing
    // Batched: ?phase=backfill&offset=0&limit=80 — response tells you the
    // next offset. Repeat until done:true.
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '80', 10) || 80, 150);

    let knownSlugs = [];
    try { const k = await kv.get(KNOWN_KEY); if (k) knownSlugs = JSON.parse(k); } catch {}
    if (knownSlugs.length === 0) {
      return json({ message: 'Known-slugs list is empty — nothing to backfill.', written: 0, done: true }, 200);
    }

    const batch = knownSlugs.slice(offset, offset + limit);
    const PREFIXES = ['concert:artist:', 'football:team:', 'theatre:show:'];
    let repaired = 0, created = 0, errors = 0;

    for (const slug of batch) {
      try {
        // Find which category prefix holds this slug (if any)
        let found = null, foundPrefix = null;
        for (const prefix of PREFIXES) {
          const raw = await kv.get(prefix + slug);
          if (raw) { found = JSON.parse(raw); foundPrefix = prefix; break; }
        }
        if (found) {
          await kv.put(foundPrefix + slug, JSON.stringify(found)); // rewrite = TTL removed
          repaired++;
        } else {
          // Record expired — recreate minimal (concert prefix is the safe default;
          // football/theatre entities live in their static data files too)
          const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await kv.put('concert:artist:' + slug, JSON.stringify({
            slug, name: displayName, search: displayName, genre: 'Live Events',
            description: `Compare ${displayName} ticket prices across verified sellers.`
          }));
          created++;
        }
      } catch { errors++; }
    }

    const nextOffset = offset + batch.length;
    const done = nextOffset >= knownSlugs.length;
    return json({
      message: `Backfill batch complete.`,
      totalKnown: knownSlugs.length,
      batch: { offset, processed: batch.length },
      repaired, createdMinimal: created, errors,
      done,
      next: done ? null : `?trigger=1&phase=backfill&offset=${nextOffset}&limit=${limit}`
    }, 200);
  }

  // ── REGISTER-KNOWN PHASE — one-time sitemap slug registration ─────────────
  // Writes all 283 sitemap slugs into KNOWN_KEY and KNOWN_VENUES_KEY so the
  // backfill system can protect them, and creates minimal KV entity records for
  // any slug that doesn't already have one (so /api/concert?slug= stops 404ing).
  // Run ONCE: ?trigger=1&phase=register-known
  // Safe to re-run — existing KV records are never overwritten, only missing ones created.
  // ── CLEAR-QUEUE PHASE ────────────────────────────────────────────────────
  // Safely wipes the pending autodiscovery queue without touching KNOWN_KEY,
  // entity KV records, or any committed pages.
  // Usage: ?trigger=1&phase=clear-queue
  // Add &confirm=yes to actually clear (dry-run by default).
  // ── FIX-CATEGORIES PHASE ────────────────────────────────────────────────
  // Repairs entities committed into the WRONG category folder.
  //
  // Why this exists: when /sports/ shipped, the commit path's `byCategory`
  // object had no 'sports' key, and its fallback is `: 'concert'`. Sports
  // entities were therefore written to concert/{slug}.html and
  // concert:artist:{slug} instead of the sports equivalents. The bug is
  // fixed, but the already-committed pages need moving.
  //
  // Detection is by GENRE on the stored KV record — the same field the
  // router uses — so it can never disagree with genreToCategory().
  //
  // Usage: ?trigger=1&phase=fix-categories            — dry run (default)
  //        ?trigger=1&phase=fix-categories&confirm=yes — apply
  //        &limit=N  (default 100, max 300)
  if (phase === 'fix-categories') {
    const confirm = url.searchParams.get('confirm') === 'yes';
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 300);
    const t0 = Date.now(); // instrumentation: start of the WHOLE request — detection + apply share this one timer

    let registry = null;
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    if (!registry || !registry.sections) {
      return json({ error: 'sitemap:registry not built — run ?phase=build-registry first' }, 503);
    }

    // FIX (1 Aug 2026, later same session): this detection loop was fully
    // sequential — up to 2 awaited kv.get() calls per candidate slug (genre
    // lookup + musician-veto lookup), zero batching, for however many slugs
    // it takes to accumulate `limit` misfiled hits. Early tonight this ran
    // fast because dense clusters of misfiled entries meant few slugs needed
    // checking before hitting the limit. After grinding through most of
    // those clusters, remaining hits are sparser — combined with the
    // registry having grown from tonight's own discovery/merge/canonical-
    // creation activity, this loop now has to sequentially check far more
    // slugs to find `limit` hits, which is very plausibly what's timing out
    // now. Same anti-pattern already fixed three times tonight elsewhere,
    // just never applied to THIS loop since the apply path was the
    // suspected (and, at the time, correct) bottleneck.
    //
    // Chunked to 25 concurrent per batch. The limit check now happens
    // BETWEEN chunks rather than per-item, so a final chunk can slightly
    // overshoot `limit` before stopping — bounded to at most one chunk's
    // worth of overshoot, same tradeoff already accepted in mergefragments'
    // scan loop. Trimmed back to exactly `limit` afterward so callers see
    // the same contract as before.
    const misfiled = [];
    let scanned = 0;
    const DETECT_CHUNK = 25;
    const DETECT_CHECKPOINT_EVERY = 10; // every ~250 slugs, matches mergefragments' interval
    let detectChunksDone = 0;
    outer:
    for (const fromCat of ['concert', 'football', 'theatre', 'sports']) {
      const slugs = Object.keys(registry.sections[fromCat] || {});
      for (let i = 0; i < slugs.length; i += DETECT_CHUNK) {
        const chunk = slugs.slice(i, i + DETECT_CHUNK);
        await Promise.all(chunk.map(async slug => {
          scanned++;
          let rec = null;
          try {
            const raw = await kv.get(categoryToKvPrefix(fromCat) + slug);
            if (raw) rec = JSON.parse(raw);
          } catch {}
          if (!rec || !rec.genre) return;          // no genre = no evidence = leave alone
          const shouldBeCat = genreToCategory(rec.genre);
          // Stale slug: toSlug used to delete diacritics instead of
          // transliterating them ("yair-rodrguez") and used to join words
          // across a removed parenthetical ("ahavatgordon"). Both are fixed,
          // so re-deriving from the stored NAME finds pages minted by the old
          // rule. Left alone, the next discovery run would mint the corrected
          // slug as a brand-new page and we'd have duplicates.
          const shouldBeSlug = rec.name ? toSlug(rec.name) : slug;
          let catWrong  = shouldBeCat !== fromCat;
          const slugWrong = shouldBeSlug && shouldBeSlug !== slug;

          // ── MUSICIAN VETO (24 Jul 2026) ───────────────────────────────────
          // The concert section holds ~217 entities whose stored genre is the
          // literal string 'Sports'. Most are genuinely misfiled tournament
          // sessions — but some are REAL MUSICIANS (adele, arctic-monkeys,
          // ariana-grande, alt-j), residue of the SE365 1023 mapping bug this
          // file's own comments describe: "1023 (909 music acts) was missing
          // entirely and fell through to 'Sports'". The mapping was fixed; the
          // records written before the fix still carry the wrong genre.
          //
          // A bulk concert->sports move would drag Adele into /sports/. So before
          // moving anything OUT of concert, ask the enrichment record: a
          // MusicBrainz match means an external authority recognises this name as
          // a recording artist. Genre is the corrupted field here; MusicBrainz is
          // independent evidence, so it wins.
          //
          // Vetoed entities are reported with reason 'musician-veto' and left
          // exactly where they are — their GENRE is wrong, not their section.
          // VETO SCOPE (fixed 25 Jul): the veto exists to stop real MUSICIANS being
          // dragged concert->SPORTS by the SE365 1023 genre corruption. It must NOT
          // block concert->THEATRE moves: a jukebox musical or tribute show ('A
          // Beautiful Noise' = Neil Diamond, 'Beautiful' = Carole King) matches a
          // MusicBrainz artist, but the SHOW is theatre. For theatre we have
          // STRONGER evidence than MusicBrainz — TM returned segment 'Arts &
          // Theatre' explicitly. So the veto only guards the sports direction.
          let musicianVeto = false;
          if (catWrong && fromCat === 'concert' && shouldBeCat === 'sports') {
            try {
              const metaRaw = await kv.get(`entity:meta:concert:${slug}`);
              if (metaRaw) {
                const meta = JSON.parse(metaRaw);
                // enrich-entities.js sets source='musicbrainz' UNCONDITIONALLY for
                // every concert entity, BEFORE the lookup — so source alone vetoed
                // everything, incl. tennis sessions (confirmed 25 Jul: 300/300
                // vetoed). The real hit signal is facts.mbid: musicbrainzArtistFacts
                // only returns an mbid on a score>=90 match, else {}. mbid present
                // == a confident recording-artist match. That is the veto.
                const hasMbid = meta?.facts?.mbid || meta?.mbid;
                if (hasMbid) musicianVeto = true;
              }
            } catch {}
            if (musicianVeto) catWrong = false;
          }

          if (musicianVeto && !slugWrong) {
            misfiled.push({
              slug, from: fromCat, to: fromCat, toSlug: slug,
              reason: 'musician-veto',
              genre: rec.genre, name: rec.name || slug,
              note: 'MusicBrainz match — genre is wrong, section is right. Not moved.'
            });
            return;
          }

          if (catWrong || slugWrong) {
            misfiled.push({
              slug, from: fromCat, to: shouldBeCat,
              toSlug: slugWrong ? shouldBeSlug : slug,
              reason: catWrong && slugWrong ? 'category+slug' : catWrong ? 'category' : 'slug',
              genre: rec.genre, name: rec.name || slug
            });
          }
        }));
        detectChunksDone++;
        if (detectChunksDone % DETECT_CHECKPOINT_EVERY === 0) {
          await checkpoint(kv, `detectScan_${fromCat}_scanned${scanned}_found${misfiled.length}`, t0);
        }
        if (misfiled.length >= limit) break outer;
      }
    }
    await checkpoint(kv, `detectScan_COMPLETE_scanned${scanned}_found${misfiled.length}`, t0);
    // Trim back to exactly `limit` — a chunk can overshoot by up to
    // (DETECT_CHUNK - 1) items past the target, same bounded tradeoff
    // accepted elsewhere tonight.
    if (misfiled.length > limit) misfiled.length = limit;

    if (!misfiled.length) {
      return json({ message: 'No mis-categorised entities found.', scanned }, 200);
    }
    if (!confirm) {
      // Full breakdown across ALL matches (not just the shown 50), so a large
      // plan can be sanity-checked without applying blind. Added 25 Jul when a
      // 269-move plan showed only 50 in the sample.
      const byTo = {}, byReason = {};
      for (const m of misfiled) {
        byTo[m.to] = (byTo[m.to] || 0) + 1;
        byReason[m.reason] = (byReason[m.reason] || 0) + 1;
      }
      // ?target=concert filters the shown entities to one destination bucket,
      // so a large plan's non-obvious moves can be reviewed. Added 25 Jul.
      const targetFilter = url.searchParams.get('target');
      const shown = targetFilter
        ? misfiled.filter(m => m.to === targetFilter)
        : misfiled;
      return json({
        dryRun: true, scanned, found: misfiled.length,
        summaryByTarget: byTo,
        summaryByReason: byReason,
        message: 'Add &confirm=yes to move these. Old URLs will 404 afterwards — see note.',
        note: 'Pages committed today are unlikely to be indexed yet. If any ARE indexed, ' +
              'add explicit 301s to _redirects for those slugs before applying.',
        entities: shown.slice(0, 60),
        shownFilter: targetFilter || 'all',
        truncatedSample: shown.length > 60
      }, 200);
    }
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);

    const github = new GitHubAPI(githubToken, owner, repo, branch);

    // Fetch the current tree ONCE and build a set of existing paths. The move
    // deletes the old path, but a delete (sha:null) for a path NOT in the tree
    // makes GitHub throw GitRPC::BadObjectState and reject the WHOLE commit.
    // The 228 theatre entities included ex-hardcoded-array shows that never had
    // a committed concert/*.html file — their phantom delete-paths 422'd the
    // entire batch (confirmed 25 Jul). So: only emit a delete for a path that
    // actually exists.
    let existingPaths = new Set();
    try {
      const ref  = await github.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const head = await github.request('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
      const full = await github.request('GET', `/repos/${owner}/${repo}/git/trees/${head.tree.sha}?recursive=1`);
      for (const node of (full.tree || [])) {
        if (node.type === 'blob') existingPaths.add(node.path);
      }
    } catch (err) {
      return json({ error: 'Could not read repo tree to validate move', detail: String(err) }, 500);
    }
    await checkpoint(kv, `stepA_treeFetch_paths${existingPaths.size}`, t0);

    // One atomic commit: write the new path, delete the old one (if it exists).
    // FIX (1 Aug 2026): was one sequential await kv.get(enrichment) per item —
    // confirmed via checkpoint instrumentation + observed partial progress
    // across repeated timeouts to be the same anti-pattern already found and
    // fixed in price-rollup.js. Pure reads here (no side effects besides the
    // shared push/counter, both synchronous and therefore safe to share
    // across concurrent tasks under JS's single-threaded model — no two
    // pushes or increments can interleave mid-operation), so chunking this
    // into bounded concurrency changes nothing about correctness, only speed.
    const files = [];
    let skippedPhantomDeletes = 0;
    const CHUNK_SIZE = 25;
    for (let i = 0; i < misfiled.length; i += CHUNK_SIZE) {
      const chunk = misfiled.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async m => {
        const gen = categoryToHtmlGenerator(m.to);
        const target = m.toSlug || m.slug;
        let enrich = null;
        try {
          const meta = await kv.get(`entity:meta:${m.from}:${m.slug}`);
          if (meta) enrich = JSON.parse(meta);
        } catch {}
        files.push({ path: `${m.to}/${target}.html`, content: gen(target, enrich || { name: m.name }) });
        const oldPath = `${m.from}/${m.slug}.html`;
        // Delete only if the path differs AND actually exists in the repo tree.
        if (`${m.from}/${m.slug}` !== `${m.to}/${target}`) {
          if (existingPaths.has(oldPath)) {
            files.push({ path: oldPath, content: null });
          } else {
            skippedPhantomDeletes++;
          }
        }
      }));
    }
    await checkpoint(kv, `stepB_preCommitBuild_files${files.length}`, t0);

    let commitSha = null;
    try {
      commitSha = await github.commitFilesBatch(files,
        `Fix category: move ${misfiled.length} entities to correct sections`);
    } catch (err) {
      return json({ error: 'Move commit failed — nothing changed in KV.', detail: String(err) }, 500);
    }
    await checkpoint(kv, 'stepC_commitDone', t0);

    // Only after the commit succeeds do we touch KV, so a failed commit
    // can never leave the registry pointing at files that don't exist.
    // FIX (1 Aug 2026): same chunked-parallel treatment as the pre-commit
    // loop above — this loop (up to 4 sequential KV ops per item) was the
    // other half of the confirmed bottleneck.
    //
    // IMPORTANT CORRECTNESS NOTE: the KNOWN_KEY update was PULLED OUT of the
    // per-item body and moved below, done ONCE for the whole batch. Left
    // per-item under Promise.all, every renamed slug in the same chunk would
    // independently read-modify-write the SAME KV key concurrently — each
    // task working from its own stale snapshot, so whichever write lands
    // last would silently overwrite every other task's changes, quietly
    // losing most of the batch's KNOWN_KEY updates. Collecting the renames
    // and applying them in one single read-modify-write after the parallel
    // loop avoids that race entirely, and is also strictly more efficient
    // than the original (one read+write for the whole batch instead of up
    // to 99 separate sequential ones).
    const today = new Date().toISOString().slice(0, 10);
    const moved = [];
    const renamedSlugs = [];
    for (let i = 0; i < misfiled.length; i += CHUNK_SIZE) {
      const chunk = misfiled.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async m => {
        try {
          const target = m.toSlug || m.slug;
          const oldKey = categoryToKvPrefix(m.from) + m.slug;
          const newKey = categoryToKvPrefix(m.to) + target;
          const raw = await kv.get(oldKey);
          if (raw) {
            const rec = JSON.parse(raw);
            rec.category = m.to;
            rec.slug = target;
            await kv.put(newKey, JSON.stringify(rec));
            if (oldKey !== newKey) await kv.delete(oldKey);
          }
          if (m.slug !== target) {
            renamedSlugs.push({ oldSlug: m.slug, newSlug: target });
          }
          // FIX (1 Aug 2026): the routing Functions (functions/{category}/
          // [slug].js) intercept EVERY request matching their path pattern
          // regardless of whether a static file exists there — deleting the
          // old .html file in the commit above does NOT stop the old URL
          // from being served; the Function just renders a generic fallback
          // page for it instead of 404ing or redirecting. This write is
          // what the routing Function checks to issue a real 301. Stored
          // as a full "category/slug" path, not a bare slug, because this
          // tool can move an entity to a DIFFERENT category — the
          // destination may not be under the same /{m.from}/ path at all.
          try {
            await kv.put(`redirectSlug:${m.from}:${m.slug}`, `${m.to}/${target}`);
          } catch { /* best-effort — a missing redirect entry degrades to the pre-existing broken-fallback behaviour, not a hard failure */ }
          if (registry.sections[m.from]) delete registry.sections[m.from][m.slug];
          if (!registry.sections[m.to]) registry.sections[m.to] = {};
          registry.sections[m.to][target] = today;
          moved.push(`${m.from}/${m.slug} -> ${m.to}/${target} (${m.reason})`);
        } catch (err) {
          // Reported, not thrown — one bad record shouldn't abort the rest.
          moved.push(`ERROR ${m.slug}: ${err}`);
        }
      }));
    }
    await checkpoint(kv, `stepD_kvLoopDone_items${misfiled.length}`, t0);

    // Drop the stale slugs from the known-set, or discovery will treat the
    // corrected slugs as brand new and re-queue duplicates. Single
    // read-modify-write for the whole batch — see correctness note above.
    if (renamedSlugs.length) {
      try {
        const k = await kv.get(KNOWN_KEY);
        const known = new Set(k ? JSON.parse(k) : []);
        for (const { oldSlug, newSlug } of renamedSlugs) {
          known.delete(oldSlug);
          known.add(newSlug);
        }
        await kv.put(KNOWN_KEY, JSON.stringify([...known]));
      } catch {}
    }
    await checkpoint(kv, 'stepE_knownKeyDone', t0);

    registry.updated = new Date().toISOString();
    await kv.put(REGISTRY_KEY, JSON.stringify(registry));
    await kv.delete('sports:hub:index').catch(() => {});   // hub list changed
    await checkpoint(kv, 'stepF_registrySaved_COMPLETE', t0);

    return json({
      message: 'Mis-categorised entities moved.',
      commitSha, movedCount: misfiled.length,
      skippedPhantomDeletes,
      filesInCommit: files.length,
      filesChanged: files.length,
      sample: moved.slice(0, 20),
      next: misfiled.length >= limit
        ? '?trigger=1&phase=fix-categories&confirm=yes — more may remain, re-run'
        : null
    }, 200);
  }

  // ── PHASE: fix-sports-events (added 5 Aug 2026) ────────────────────────────
  // Companion to the awin-category-cache.js genreToCategory() fix shipped the
  // same day: that fix stops NEW mis-registrations, this phase cleans up
  // ones already sitting in the D1 event_pages table. Confirmed live via GSC
  // Crawl Stats: rugby, ice hockey and football fixtures registered as
  // /event/concert-... pages, each one ALSO existing correctly under
  // /event/sports-.../football-... from a different discovery source (TM) —
  // Google was crawling both.
  //
  // SCOPE: only event_pages rows where category='concert' AND the name
  // splits cleanly into "X vs Y" (via the same normaliseFixtureName() vs-
  // detection already proven for H6). Real concert/theatre acts essentially
  // never have "vs" in their billed name, and nothing gets touched unless a
  // matching sports/football row is also found — so a false-positive "vs"
  // match on a genuine concert name is inert, not destructive.
  //
  // Two possible outcomes per scanned candidate:
  //   1. A matching sports/football row for the SAME event already exists
  //      (checked two ways: exact slug-tail match after swapping the
  //      category prefix, then a same-date normalised-name fallback for
  //      cases where the stored raw names differ more than that) — the
  //      concert-category row is the erroneous duplicate, so it is DELETED
  //      (never the sports/football one — that row is left untouched).
  //   2. No matching row exists — this event has ONLY the wrong-category
  //      page. There's no live re-verification signal available here (no
  //      stored genre on event_pages, unlike ticketmaster.js's own
  //      recategorisation pass), so guessing sports vs football and moving
  //      it would be exactly the kind of speculative fix this project
  //      avoids. These are reported under `unmatched` for manual review —
  //      NEVER deleted or moved automatically, confirm=yes or not.
  //
  // MOVE MODE (added same day, after the first live dry run surfaced a real
  // unmatched queue mixing US sports leagues — genuinely `sports` — with a
  // Serie A derby — genuinely `football`, not `sports`, on this site's own
  // scheme): resolves the `unmatched` queue once a human has read the names
  // and decided the correct category per slug. INSERT-corrected + DELETE-old,
  // same pattern as ticketmaster.js's own recategorisation pass — falls back
  // to a plain delete if the target slug has been registered by something
  // else since the dry run (i.e. it's now a confirmed duplicate too).
  //
  // Usage: ?trigger=1&phase=fix-sports-events
  //          — dry run (default): lists what WOULD be deleted, and the
  //            unmatched review queue
  //        ?trigger=1&phase=fix-sports-events&confirm=yes
  //          — deletes the confirmed-duplicate concert-category rows only
  //        ?trigger=1&phase=fix-sports-events&move=slug1:sports,slug2:football
  //          — dry run (default): reports what WOULD move + any rejected pairs
  //        ?trigger=1&phase=fix-sports-events&move=slug1:sports,slug2:football&confirm=yes
  //          — performs the move
  if (phase === 'fix-sports-events') {
    const confirm = url.searchParams.get('confirm') === 'yes';
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500);
    const db = env.PRICE_DB;
    if (!db) return json({ error: 'PRICE_DB binding not available' }, 503);

    // ── MOVE MODE — resolves the `unmatched` review queue from a normal run.
    // No auto-detection here on purpose: these rows had no sports/football
    // counterpart to verify against, so the target category is supplied
    // explicitly by whoever reviewed the dry-run's `unmatched` list.
    //
    // Usage: &move=slug1:category1,slug2:category2,...
    //   dry run (default): reports what WOULD move, and any rejected pairs
    //   &confirm=yes: performs the move. Each move is INSERT corrected row +
    //   DELETE old row (same pattern ticketmaster.js's own recategorisation
    //   pass uses) — UNLESS the target slug has been registered by something
    //   else since the dry run, in which case that's now a confirmed
    //   duplicate and the old row is simply deleted instead (never
    //   overwrites an existing row).
    const moveParam = url.searchParams.get('move');
    if (moveParam) {
      const VALID_CATS = ['football', 'concert', 'theatre', 'sports'];
      const pairs = moveParam.split(',').map(s => s.trim()).filter(Boolean);
      const wouldMove = [];
      const rejected = [];

      for (const pair of pairs) {
        const idx = pair.lastIndexOf(':');
        if (idx < 1) { rejected.push({ pair, reason: 'expected slug:category' }); continue; }
        const slug = pair.slice(0, idx);
        const targetCat = pair.slice(idx + 1).toLowerCase();
        if (!VALID_CATS.includes(targetCat)) { rejected.push({ pair, reason: 'unknown category "' + targetCat + '"' }); continue; }

        let row = null;
        try { row = await db.prepare('SELECT * FROM event_pages WHERE slug = ?1').bind(slug).first(); } catch (e) {
          rejected.push({ pair, reason: 'read failed: ' + String(e) }); continue;
        }
        if (!row) { rejected.push({ pair, reason: 'slug not found — already moved or deleted?' }); continue; }
        if (row.category === targetCat) { rejected.push({ pair, reason: 'already in category ' + targetCat }); continue; }

        const oldPrefix = row.category + '-';
        const tail = row.slug.startsWith(oldPrefix) ? row.slug.slice(oldPrefix.length) : null;
        const newSlug = tail ? targetCat + '-' + tail : null;
        if (!newSlug) { rejected.push({ pair, reason: 'could not derive new slug from ' + row.slug }); continue; }

        wouldMove.push({ oldSlug: slug, newSlug, targetCategory: targetCat, name: row.name });
      }

      if (!confirm) {
        return json({ phase: 'fix-sports-events', mode: 'move', dryRun: true, wouldMove, rejected }, 200);
      }

      const moved = [];
      const moveErrors = [];
      for (const m of wouldMove) {
        try {
          const row = await db.prepare('SELECT * FROM event_pages WHERE slug = ?1').bind(m.oldSlug).first();
          if (!row) { moveErrors.push({ ...m, error: 'row disappeared between dry run and confirm' }); continue; }

          const dup = await db.prepare('SELECT slug FROM event_pages WHERE slug = ?1').bind(m.newSlug).first();
          if (dup) {
            // Something else registered the correct slug since the dry run —
            // this is now a confirmed duplicate, same handling as the main
            // scan-and-delete path: remove the wrong row only.
            await db.batch([ db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(m.oldSlug) ]);
            moved.push({ ...m, action: 'duplicate-removed' });
            continue;
          }

          const hasCreatedAt = Object.prototype.hasOwnProperty.call(row, 'created_at');
          const insertSql = hasCreatedAt
            ? 'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)'
            : 'INSERT INTO event_pages (slug, category, name, event_date, venue, city, price, currency, tm_url, image, source, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)';
          const binds = [m.newSlug, m.targetCategory, row.name, row.event_date, row.venue, row.city,
                         row.price, row.currency, row.tm_url, row.image, row.source, row.updated_at];
          if (hasCreatedAt) binds.push(row.created_at ?? row.updated_at);
          await db.batch([
            db.prepare(insertSql).bind(...binds),
            db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(m.oldSlug)
          ]);
          moved.push({ ...m, action: 'moved' });
        } catch (e) {
          moveErrors.push({ ...m, error: String(e) });
        }
      }

      return json({ phase: 'fix-sports-events', mode: 'move', dryRun: false, moved, moveErrors, rejected }, 200);
    }

    let rows = [];
    try {
      const { results } = await db.prepare(
        "SELECT slug, category, name, event_date FROM event_pages " +
        "WHERE category = 'concert' AND event_date >= date('now') " +
        "ORDER BY event_date LIMIT ?1"
      ).bind(limit).all();
      rows = results || [];
    } catch (e) {
      return json({ error: 'candidate read failed: ' + String(e) }, 500);
    }

    // Candidates: name contains a "vs"/"v" pairing once normalised the same
    // way H6 already does for slug-building, so drift (v/vs, dots, spacing)
    // doesn't cause a missed match.
    const candidates = rows.filter(r => {
      const n = normaliseFixtureName(r.name || '');
      return /\svs\s/i.test(n);
    });

    const toDelete = [];   // confirmed duplicate — safe to remove
    const unmatched = [];  // no sports/football counterpart found — needs a human
    const errors = [];

    for (const row of candidates) {
      const normName = normaliseFixtureName(row.name || '');
      const tail = row.slug.startsWith('concert-') ? row.slug.slice('concert-'.length) : null;

      let match = null;
      try {
        // Method 1 — exact slug-tail match with the category prefix swapped.
        // The tail (date + normalised name) is category-independent, so for
        // any event registered under H6's normaliser on both sides this is
        // an exact, high-confidence match.
        if (tail) {
          const r1 = await db.prepare(
            "SELECT slug, category, name FROM event_pages WHERE slug IN (?1, ?2)"
          ).bind('sports-' + tail, 'football-' + tail).first();
          if (r1) match = r1;
        }
        // Method 2 — same event_date, category sports/football, same name
        // after normalising both sides. Fallback for cases where the raw
        // stored names differ enough (e.g. city-prefixed team names) that
        // the slug tail itself doesn't match exactly.
        if (!match) {
          const { results: sameDate } = await db.prepare(
            "SELECT slug, category, name FROM event_pages " +
            "WHERE event_date = ?1 AND category IN ('sports','football')"
          ).bind(row.event_date).all();
          match = (sameDate || []).find(r => normaliseFixtureName(r.name || '') === normName) || null;
        }
      } catch (e) {
        errors.push({ slug: row.slug, error: String(e) });
        continue;
      }

      if (match) {
        toDelete.push({ wrongSlug: row.slug, name: row.name, correctSlug: match.slug, correctCategory: match.category });
      } else {
        unmatched.push({ slug: row.slug, name: row.name, date: row.event_date });
      }
    }

    if (!confirm) {
      return json({
        phase: 'fix-sports-events',
        dryRun: true,
        scanned: rows.length,
        candidates: candidates.length,
        wouldDelete: toDelete.length,
        unmatchedNeedsReview: unmatched.length,
        toDelete,
        unmatched,
        errors,
        next: rows.length >= limit ? '?trigger=1&phase=fix-sports-events&limit=' + limit + ' — more may remain, re-run' : null
      }, 200);
    }

    let deleted = 0;
    const deleteErrors = [];
    for (const d of toDelete) {
      try {
        await db.prepare('DELETE FROM event_pages WHERE slug = ?1').bind(d.wrongSlug).run();
        deleted++;
      } catch (e) {
        deleteErrors.push({ slug: d.wrongSlug, error: String(e) });
      }
    }

    return json({
      phase: 'fix-sports-events',
      dryRun: false,
      scanned: rows.length,
      candidates: candidates.length,
      deleted,
      deleteErrors,
      unmatchedNeedsReview: unmatched.length,
      unmatched,
      next: rows.length >= limit ? '?trigger=1&phase=fix-sports-events&confirm=yes&limit=' + limit + ' — more may remain, re-run' : null
    }, 200);
  }

  // ── PHASE: mergefragments (added 1 Aug 2026, H2) ──────────────────────────
  // Automates the whole H2 workflow end-to-end: detect ticket-type-fragment
  // entities (day-passes, multi-day packs, session numbers — the SAME
  // looksLikeEvent() Tier A/B classifier already used by ?phase=eventaudit),
  // work out whether a clean "parent" entity for that fragment ALREADY
  // exists in the registry, and — only for that confirmed-safe case — merge
  // the fragment into it: replace the fragment's stub HTML with a redirect
  // to the parent, remove the fragment from the registry/KV, in one batched,
  // reversible-by-design operation.
  //
  // WHY THIS EXISTS: eventaudit + registry-purge already do detection and
  // removal — but manually deciding "does a parent exist, and should this be
  // a redirect not a straight delete" for every single hit (potentially
  // dozens across the registry) is exactly the manual grind this phase
  // removes. Same "review Tier A automatically, Tier B stays human-reviewed"
  // risk split the rest of this file already uses — not a new risk
  // tolerance, just the existing one applied here too.
  //
  // Tier A (auto-actionable): merged automatically once a base match is
  //   found. If no base match exists, reported as 'unresolved' — never
  //   guessed at, same quarantine principle as everywhere else in this file.
  // Tier B (day-of-week / month names etc — genuinely ambiguous by the
  //   existing classifier's own design, e.g. "Sobota" is Polish for Saturday
  //   AND a real rapper): NEVER auto-merged, even with confirm=yes. Reported
  //   as 'likelyMergeableTierB' so a human can approve a short, pre-filtered
  //   list instead of researching every hit from scratch — this is the part
  //   that turns "manually check every small festival finding" into
  //   "skim a short list and say yes/no".
  //
  // Redirect target uses the SAME safe static-HTML-stub approach as the H2
  // scope doc (meta refresh + canonical) — NOT a Cloudflare _redirects rule.
  // This project has a documented real 522 outage from exactly that shape of
  // change (a redirect rule colliding with a stub's own internal fetch), so
  // that mechanism is deliberately never used here.
  //
  // Usage: ?trigger=1&phase=mergefragments&category=concert
  //          — dry run (default): shows what WOULD merge, what's unresolved,
  //            and Tier B candidates for manual review
  //        ?trigger=1&phase=mergefragments&category=concert&confirm=yes
  //          — merges Tier A hits with a confirmed base match. Batch size is
  //            deliberately small (default 15, capped at 20) — learned
  //            tonight that commitFilesBatch's GitHub commit step scales
  //            with how much HTML content is in one commit, not just file
  //            count, so small batches avoid the same 524 fix-categories hit
  //            at limit=100.
  if (phase === 'mergefragments') {
    const confirm = url.searchParams.get('confirm') === 'yes';
    const category = (url.searchParams.get('category') || 'concert').toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10) || 15, 20);
    const t0 = Date.now(); // instrumentation: start of this call

    let registry = null;
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    if (!registry?.sections?.[category]) {
      return json({ error: `No registry section "${category}"` }, 503);
    }

    const slugs  = Object.keys(registry.sections[category]);
    const prefix = categoryToKvPrefix(category);
    // Records totalSlugs against the last confirmed-working run (checked:
    // 6085) so a repeat timeout's checkpoint data directly confirms or rules
    // out "the registry grew" as the cause, rather than needing a separate
    // manual check.
    await mergefragCheckpoint(kv, 'stepA_registryLoaded', t0, { totalSlugs: slugs.length });

    // Ticket-type-fragment suffix stripper — built from the actual Tier A/B
    // examples observed 31 Jul-1 Aug 2026 (day-passes, Polish multi-day
    // packs, weekday splits), same evidence-based discipline as H6's
    // competition-prefix list. Order matters: more specific patterns first.
    // Reuses toSlug()'s own diacritic handling — never re-implemented here.
    function stripFragmentSuffix(slug) {
      let s = slug;
      // FIX (1 Aug 2026, same session): was a single pass, so a compound
      // suffix like "-friday-saturday" only ever stripped ONE trailing
      // token, leaving "-friday" behind — which then wrongly matched a
      // DIFFERENT real fragment ("leeds-festival-friday") as if it were the
      // true canonical base. Confirmed live: this produced a false merge
      // suggestion for leeds-festival-friday-saturday and three TRNSMT
      // variants. Looping until no further pattern matches fixes this —
      // "leeds-festival-friday-saturday" now correctly reduces all the way
      // to "leeds-festival" in two passes instead of stopping after one.
      let prev;
      do {
        prev = s;
        s = s.replace(/-pakiet-\d+-dniowy(-dzien-\d+)*$/, '');       // Polish "N-day pack"
        s = s.replace(/-\d+-dniowy$/, '');
        s = s.replace(/-dzien-\d+(-dzien-\d+)*$/, '');                 // Polish "day N (+ day N...)"
        s = s.replace(/-karnet$/, '');                                  // Polish "season pass"
        s = s.replace(/-\d+-day-pass$/, '');
        s = s.replace(/-day-pass$/, '');
        s = s.replace(/-(weekend|multi)-pass$/, '');
        s = s.replace(/-(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/, '');
      } while (s !== prev);
      return s;
    }

    // Derive a human-readable canonical name FROM the (now correctly)
    // cleaned base slug, rather than comparing raw text across cluster
    // members — tried a longest-common-prefix-of-names approach first, but
    // it breaks when members diverge mid-word (e.g. "JAROCIN FESTIWAL 2026
    // - DZIEŃ 1" vs "...DZIEŃ 2" shares "DZIEŃ " as a raw prefix, which is a
    // dangling, incomplete word once trimmed). Deriving from the slug
    // sidesteps that entirely. Known minor cosmetic cost: apostrophes and
    // acronym capitalisation are already lost once a name is slugified
    // (e.g. "Open'er Festival" -> "opener-festival" -> "Opener Festival",
    // "TRNSMT Festival" -> "Trnsmt Festival") — acceptable, cosmetic only.
    function titleCaseFromSlug(slug) {
      return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    const tierAHits = [];
    const tierBHits = [];
    let checked = 0;

    // FIX (1 Aug 2026, same session): this loop was ONE sequential, awaited
    // kv.get() per entity with NO batching at all — for concert's ~5,886
    // entities that's ~5,886 round-trips back to back, easily 2+ minutes,
    // which is exactly what timed out. Same anti-pattern already found and
    // fixed three times tonight (price-rollup, fix-categories twice) —
    // reintroduced fresh here because the write-side loop below was chunked
    // from the start (learned from fix-categories) but this read-side scan
    // wasn't given the same treatment when the phase was first built. Pure
    // reads with no shared read-modify-write key (unlike fix-categories'
    // KNOWN_KEY situation), so straightforward to chunk with no correctness
    // concerns — push()/counter increments are synchronous and safe to
    // share across concurrent tasks under JS's single-threaded model.
    const SCAN_CHUNK = 25;
    const CHECKPOINT_EVERY = 10; // every ~250 entities
    for (let i = 0; i < slugs.length; i += SCAN_CHUNK) {
      const chunk = slugs.slice(i, i + SCAN_CHUNK);
      await Promise.all(chunk.map(async slug => {
        checked++;
        let rec = null;
        try { const raw = await kv.get(prefix + slug); if (raw) rec = JSON.parse(raw); } catch {}
        const name = rec?.name || slug;
        const verdict = looksLikeEvent(name);
        if (!verdict) return;

        const baseSlug   = stripFragmentSuffix(slug);
        const baseExists = baseSlug !== slug && !!registry.sections[category][baseSlug];
        const item = {
          slug, name, tier: verdict.tier, label: verdict.label,
          baseSlugCandidate: baseSlug, baseExists
        };
        (verdict.tier === 'A' ? tierAHits : tierBHits).push(item);
      }));
      const chunksDone = Math.floor(i / SCAN_CHUNK) + 1;
      if (chunksDone % CHECKPOINT_EVERY === 0) {
        await mergefragCheckpoint(kv, 'stepB_scanProgress', t0, {
          checked, totalSlugs: slugs.length,
          pctComplete: Math.round(100 * checked / slugs.length)
        });
      }
    }
    await mergefragCheckpoint(kv, 'stepC_scanComplete', t0, {
      checked, tierACount: tierAHits.length, tierBCount: tierBHits.length
    });

    const mergeableA   = tierAHits.filter(x => x.baseExists);
    const unresolvedA  = tierAHits.filter(x => !x.baseExists);
    const likelyB      = tierBHits.filter(x => x.baseExists);

    // ── Clustering (added 1 Aug 2026, same session) ──────────────────────
    // Some unresolved Tier A hits aren't "no parent found, one-off" cases —
    // they're MULTIPLE fragments of the same real event where NO canonical
    // page was ever created at all (confirmed live: Leeds Festival, Open'er
    // Festival, Eurovision Song Contest — every variant of these is a
    // fragment, none is the "real" page). Group unresolved Tier A hits by
    // their shared base candidate; a group of 2+ is a strong signal of a
    // genuine cluster, not a coincidence. Tier B is deliberately excluded
    // from clustering — creating new pages is a more consequential action
    // than merging into an existing one, so it gets the SAME conservative
    // Tier-A-only treatment as everything else in this file, not a looser
    // one.
    const clusterMap = {};
    for (const item of unresolvedA) {
      (clusterMap[item.baseSlugCandidate] ||= []).push(item);
    }
    const clusterableTierA = Object.entries(clusterMap)
      .filter(([, members]) => members.length >= 2)
      .map(([baseSlug, members]) => ({
        baseSlugCandidate: baseSlug,
        proposedName: titleCaseFromSlug(baseSlug),
        memberCount: members.length,
        members: members.map(m => ({ slug: m.slug, name: m.name }))
      }));
    // Anything left in unresolvedA after removing clustered members really
    // is a one-off — no obvious relationship to anything else found, so it
    // stays exactly as "unresolved", never guessed at.
    const clusteredSlugs = new Set(clusterableTierA.flatMap(c => c.members.map(m => m.slug)));
    const trueUnresolvedA = unresolvedA.filter(x => !clusteredSlugs.has(x.slug));

    if (!confirm) {
      return json({
        dryRun: true, category, checked,
        tierA: {
          total: tierAHits.length, mergeable: mergeableA.length,
          clusterable: clusterableTierA.reduce((n, c) => n + c.memberCount, 0),
          trueUnresolved: trueUnresolvedA.length
        },
        tierB: {
          total: tierBHits.length, likelyMergeable: likelyB.length,
          note: 'Tier B is NEVER auto-merged, even with confirm=yes — the same ambiguity the rest of this file already treats as review-only (e.g. a weekday name can also be a real artist name). This list is pre-filtered to only the ones with a found base match, so it should be short — skim and decide, rather than research each one from scratch.'
        },
        mergeableTierA: mergeableA,
        clusterableTierA: {
          note: 'Groups of 2+ Tier A fragments that share a derived base with NO existing canonical page — e.g. Leeds Festival only exists as day-specific fragments, never as its own page. Add &confirm=yes&createcanonical=yes to create a new canonical entity per cluster (named from proposedName) and redirect all members into it. This is a MORE consequential action than a normal merge (it creates new pages), so it requires the extra createcanonical=yes flag on top of confirm=yes.',
          clusters: clusterableTierA
        },
        unresolvedTierA: trueUnresolvedA.slice(0, 50),
        likelyMergeableTierB: likelyB.slice(0, 50),
        message: mergeableA.length
          ? `Add &confirm=yes to merge ${Math.min(mergeableA.length, limit)} of ${mergeableA.length} mergeable Tier A fragments now (small batches — see &limit=). Add &createcanonical=yes as well to also create canonical pages for the ${clusterableTierA.length} clusters found. Tier B is never auto-merged.`
          : clusterableTierA.length
            ? `No direct merges available, but ${clusterableTierA.length} clusters with no canonical page were found. Add &confirm=yes&createcanonical=yes to create canonicals and merge them.`
            : 'No Tier A fragments with a confirmed base entity found. Re-run at a later offset if the registry is large — this phase currently scans the WHOLE section in one pass, so if it times out, lower &limit and note how far `checked` got before retrying.'
      }, 200);
    }

    const createCanonical = url.searchParams.get('createcanonical') === 'yes';

    // ── CONFIRM: merge a small batch of Tier A hits with a confirmed base ──
    if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
    const github = new GitHubAPI(githubToken, owner, repo, branch);
    const batch  = mergeableA.slice(0, limit);

    // Canonical-creation batch (only if explicitly requested). Capped by
    // TOTAL FILE COUNT, not cluster count — a cluster with many members
    // (Eurovision had 6) contributes 1 new canonical + N redirect stubs,
    // so this bounds total commit size the same way the regular batch does,
    // rather than risking one call trying to create several large clusters
    // at once and hitting the same content-size ceiling found earlier
    // tonight in commitFilesBatch.
    const clusterBatch = [];
    if (createCanonical) {
      let fileBudget = limit;
      for (const cluster of clusterableTierA) {
        const cost = 1 + cluster.memberCount; // 1 new canonical + N redirects
        if (cost > fileBudget) continue; // skip clusters too big for what's left
        clusterBatch.push(cluster);
        fileBudget -= cost;
        if (fileBudget <= 0) break;
      }
    }

    if (!batch.length && !clusterBatch.length) {
      return json({
        message: createCanonical
          ? 'Nothing to merge or create — no mergeable Tier A fragments and no cluster fit in the file budget for this pass.'
          : 'Nothing to merge — no mergeable Tier A fragments found in this pass. Add &createcanonical=yes if you want to create canonical pages for the clusters this dry run reported.',
        checked
      }, 200);
    }

    const HOST = 'https://ticketscout.co.uk';
    const files = batch.map(item => {
      const baseUrl = `${HOST}/${category}/${item.baseSlugCandidate}`;
      // Safe redirect mechanism: a static HTML stub the fragment's own file
      // is REPLACED with (meta refresh + canonical), never a Cloudflare
      // _redirects rule — see the phase comment above for why.
      const html = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" />
<title>Redirecting… | TicketScout</title>
<meta name="robots" content="noindex" />
<link rel="canonical" href="${baseUrl}" />
<meta http-equiv="refresh" content="0; url=${baseUrl}" />
</head><body><p>This page has moved. <a href="${baseUrl}">Continue →</a></p></body></html>`;
      return { path: `${category}/${item.slug}.html`, content: html };
    });

    // For each cluster being processed: generate the NEW canonical entity's
    // own page (reusing the SAME generator every other entity page in this
    // category uses, so it looks and behaves identically to a normal page,
    // not a special one-off), plus a redirect stub for every member —
    // identical redirect mechanism to the regular merge above.
    const gen = categoryToHtmlGenerator(category);
    for (const cluster of clusterBatch) {
      files.push({
        path: `${category}/${cluster.baseSlugCandidate}.html`,
        content: gen(cluster.baseSlugCandidate, { name: cluster.proposedName })
      });
      const baseUrl = `${HOST}/${category}/${cluster.baseSlugCandidate}`;
      for (const member of cluster.members) {
        const html = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8" />
<title>Redirecting… | TicketScout</title>
<meta name="robots" content="noindex" />
<link rel="canonical" href="${baseUrl}" />
<meta http-equiv="refresh" content="0; url=${baseUrl}" />
</head><body><p>This page has moved. <a href="${baseUrl}">Continue →</a></p></body></html>`;
        files.push({ path: `${category}/${member.slug}.html`, content: html });
      }
    }

    let commitSha = null;
    try {
      const msgParts = [];
      if (batch.length) msgParts.push(`merge ${batch.length} fragments into existing entities`);
      if (clusterBatch.length) msgParts.push(`create ${clusterBatch.length} canonical entities from clusters`);
      commitSha = await github.commitFilesBatch(files, `H2 (${category}): ${msgParts.join('; ')}`);
    } catch (err) {
      return json({ error: 'Merge/create commit failed — nothing changed in KV.', detail: String(err) }, 500);
    }

    // Registry + KV cleanup, chunked — same bounded-concurrency pattern
    // applied to fix-categories tonight, at this batch size purely a safety
    // margin rather than a confirmed necessity (20 items is well under
    // where fix-categories' loops actually needed it).
    const merged = [];
    const created = [];
    const CHUNK = 20;

    // Regular merges: remove fragment, no new entity involved.
    for (let i = 0; i < batch.length; i += CHUNK) {
      const chunk = batch.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async item => {
        try {
          // FIX (1 Aug 2026): see the identical note in fix-categories —
          // without this, the routing Function still intercepts the old
          // slug's URL and renders a generic fallback page instead of
          // redirecting, regardless of the static stub file below.
          try {
            await kv.put(`redirectSlug:${category}:${item.slug}`, `${category}/${item.baseSlugCandidate}`);
          } catch { /* best-effort */ }
          delete registry.sections[category][item.slug];
          await kv.delete(prefix + item.slug);
          merged.push(`${item.slug} -> ${item.baseSlugCandidate}`);
        } catch (err) {
          merged.push(`ERROR ${item.slug}: ${err}`);
        }
      }));
    }

    // Cluster merges: create the new canonical entity's registry/KV record
    // FIRST (today's date as lastmod, same shape every other entity uses),
    // then remove every member the same way as a regular merge.
    const today = new Date().toISOString().slice(0, 10);
    for (const cluster of clusterBatch) {
      try {
        registry.sections[category][cluster.baseSlugCandidate] = today;
        await kv.put(prefix + cluster.baseSlugCandidate, JSON.stringify({
          name: cluster.proposedName,
          slug: cluster.baseSlugCandidate,
          category
        }));
        created.push(`${cluster.baseSlugCandidate} ("${cluster.proposedName}", ${cluster.memberCount} members)`);
      } catch (err) {
        created.push(`ERROR creating ${cluster.baseSlugCandidate}: ${err}`);
        continue; // don't remove members if the canonical itself failed to save
      }
      for (let i = 0; i < cluster.members.length; i += CHUNK) {
        const chunk = cluster.members.slice(i, i + CHUNK);
        await Promise.all(chunk.map(async member => {
          try {
            // FIX (1 Aug 2026): same as the regular-merge loop above — this
            // is what actually makes the redirect happen. Without it the
            // routing Function still renders the old slug's generic
            // fallback page rather than redirecting, regardless of the
            // static stub file this member's path already got replaced
            // with in the commit.
            try {
              await kv.put(`redirectSlug:${category}:${member.slug}`, `${category}/${cluster.baseSlugCandidate}`);
            } catch { /* best-effort */ }
            delete registry.sections[category][member.slug];
            await kv.delete(prefix + member.slug);
            merged.push(`${member.slug} -> ${cluster.baseSlugCandidate} (new canonical)`);
          } catch (err) {
            merged.push(`ERROR ${member.slug}: ${err}`);
          }
        }));
      }
    }

    registry.updated = new Date().toISOString();
    await kv.put(REGISTRY_KEY, JSON.stringify(registry));
    await kv.delete(`${category}:hub:index`).catch(() => {});

    const remainingClusters = clusterableTierA.length - clusterBatch.length;
    return json({
      message: 'Fragments merged' + (clusterBatch.length ? ' and canonical entities created.' : '.'),
      commitSha,
      mergedCount: merged.length,
      sample: merged.slice(0, 20),
      createdCanonicals: created,
      remainingMergeable: mergeableA.length - batch.length,
      remainingClusters,
      next: (mergeableA.length > batch.length || remainingClusters > 0)
        ? `?trigger=1&phase=mergefragments&category=${category}&confirm=yes${createCanonical ? '&createcanonical=yes' : ''} — more remain, re-run`
        : null
    }, 200);
  }

  if (phase === 'clear-queue') {
    const confirm = url.searchParams.get('confirm') === 'yes';
    const pendingRaw = await kv.get(PENDING_KEY);
    if (!pendingRaw) {
      return json({ message: 'Queue is already empty — nothing to clear.', cleared: 0 }, 200);
    }
    const pending  = JSON.parse(pendingRaw);
    const artists  = (pending.artists || []).length;
    const venues   = (pending.venues  || []).length;
    if (!confirm) {
      return json({
        dryRun: true,
        message: 'Queue found — add &confirm=yes to clear it.',
        wouldClear: { artists, venues, total: artists + venues },
        sampleArtists: (pending.artists || []).slice(0, 5).map(a => a.slug)
      }, 200);
    }
    await kv.delete(PENDING_KEY);
    return json({
      message: 'Pending queue cleared.',
      cleared: { artists, venues, total: artists + venues },
      note: 'KNOWN_KEY and all entity records are untouched. Fresh discoveries will repopulate the queue via the weekly cron or a manual ?trigger=1 scan.'
    }, 200);
  }

  if (phase === 'register-known') {
  const ALL_CONCERT = [
    '58th-street',
    'a-christmas-carol',
    'a-fine-idea',
    'a-midsummer-nights-dream',
    'a-midsummer-nights-dream-globe-theatre',
    'abba-voyage',
    'abigails-party',
    'ac-dc',
    'adele',
    'adriana-mater-english-national-opera',
    'alcina-royal-ballet-and-opera',
    'alice-in-wonderland',
    'all-points-east',
    'all-the-things-we-cant-explain',
    'allegra',
    'alt-j',
    'alvin-ailey-american-dance-theater-new-works',
    'angel-bones-english-national-opera',
    'anne-marie',
    'arcadia',
    'archduke',
    'arctic-monkeys',
    'are-you-watching',
    'ariana-grande',
    'around-the-world-in-80-days',
    'as-you-like-it',
    'attention',
    'austentatious',
    'avenue-q',
    'bad-bunny',
    'bad-omens',
    'bastille',
    'be-like-blippi',
    'beetlejuice-the-musical',
    'berlin',
    'beyonce',
    'biffy-clyro',
    'big-bad-wolf',
    'big-time-rush',
    'bill-bailey-vaudevillean',
    'billie-eilish',
    'billy-elliot-the-musical',
    'black-is-the-color-of-my-voice',
    'blink-182',
    'bloc-party',
    'blood-of-my-blood',
    'blueys-big-play-liverpool',
    'blur',
    'bombay-bicycle-club',
    'brainiac-live',
    'breaking-the-waves-english-national-opera',
    'bruno-mars',
    'bryan-adams',
    'buffy-revamped',
    'burlesque-the-musical',
    'cabaret',
    'cardi-b',
    'care',
    'carmen-royal-ballet-and-opera',
    'cats',
    'charlatans',
    'chat-noir',
    'christmas-carol-goes-wrong',
    'cinderella',
    'cirque-alice',
    'cloud-9',
    'coldplay',
    'come-alive-the-greatest-showman-circus-spectacular',
    'cyrano-de-bergerac',
    'd-block-europe',
    'dark-of-the-moon',
    'darkling',
    'dave',
    'david-bowie-youre-not-alone',
    'death-note-the-musical',
    'deep-heat-rivalry',
    'def-leppard',
    'dianathe-untold-and-untrue-story',
    'dinosaur-world-live',
    'dirty-dancing',
    'disneys-hercules',
    'dog-man-the-musical',
    'doja-cat',
    'don-giovanni-royal-ballet-and-opera',
    'drake',
    'dreamscape',
    'driftwood',
    'dua-lipa',
    'ed-sheeran',
    'electrapersona',
    'elton-john',
    'eminem',
    'english-national-ballet-romeo-and-juliet',
    'equus',
    'eurotrash',
    'fall-out-boy',
    'fences',
    'fleetwood-mac',
    'foals',
    'foo-fighters',
    'francesco-de-gregori',
    'girls',
    'glengarry-glen-ross',
    'global-majority',
    'gojira',
    'grace-pervades',
    'grayson-the-musical-a-first-look',
    'grease-the-immersive-movie-musical',
    'green-day',
    'gruffalo',
    'guns-n-roses',
    'hadestown',
    'hamilton',
    'harry-potter-and-the-cursed-child',
    'harry-potter-and-the-cursed-child-part-one',
    'harry-potter-and-the-cursed-child-part-one-and-two',
    'harry-styles',
    'hauser',
    'hay-fever',
    'heathers-the-musical',
    'here-comes-j-edgar-a-comedy-musical',
    'high-school-musical',
    'high-society',
    'hit-machine',
    'holy-fool',
    'horrible-histories-barmy-britain-the-best-bits',
    'hot-mess-a-new-musical',
    'how-the-other-half-loves',
    'i-puritani',
    'ice-nine-kills-nottingham',
    'im-every-woman',
    'imagine-dragons',
    'insane-asylum-seekers',
    'interpol',
    'into-the-woods',
    'iphigenie-en-tauride-english-national-opera',
    'iron-maiden',
    'ivanov',
    'jack-and-the-beanstalk',
    'jacksonville-jaguars',
    'james-arthur',
    'jay-z',
    'jeeves-and-wooster-in-stiff-upper-lip-jeeves',
    'jeeves-takes-charge',
    'jess-glynne',
    'jesus-christ-superstar',
    'jesus-christ-superstar-theatre-royal-drury-lane',
    'jimmy-carr',
    'johannes-radebe-finally-home',
    'john-proctor-is-the-villain',
    'judas-priest',
    'kaiser-chiefs',
    'kanye-west',
    'kaspar-prince-of-cats',
    'katy-perry',
    'keane',
    'kendrick-lamar',
    'kimberly-akimbo',
    'kinky-boots',
    'knocked-loose',
    'la-bohme-royal-ballet-and-opera',
    'la-distance',
    'la-fille-du-regiment-royal-ballet-and-opera',
    'la-traviata-english-national-opera',
    'lady-gaga',
    'les-miserables',
    'lewis-capaldi',
    'linkin-park',
    'little-simz',
    'loves-labours-lost',
    'loyle-carner',
    'machine-gun-kelly',
    'madness',
    'magic-mike-live',
    'malory-towers',
    'man-to-man',
    'manic-street-preachers',
    'manon-royal-ballet-and-opera',
    'matilda',
    'mermaids-pirates',
    'metallica',
    'monument',
    'moulin-rouge-the-musical',
    'mousetrap',
    'much-ado-about-nothing',
    'mumford-sons',
    'murder-she-didnt-write',
    'muse',
    'my-chemical-romance',
    'my-neighbour-totoro',
    'my-sons-a-queer-but-what-can-you-do',
    'nicki-minaj',
    'nine-night',
    'noda-map-320f',
    'nutcracker-london-coliseum',
    'oasis',
    'oh-mary',
    'olivia-rodrigo',
    'one-day-the-musical',
    'our-mighty-groove',
    'our-public-house',
    'ozzy-osbourne',
    'paddington-the-musical',
    'panic-at-the-disco',
    'pantera',
    'paramore',
    'paranormal-activity',
    'paul-mccartney',
    'peppa-pigs-big-family-show',
    'pete-tong',
    'pink',
    'placebo',
    'post-malone',
    'prehistoric-planet-discovering-dinosaurs',
    'pride',
    'pulp',
    'radiohead',
    'raising-gays-a-concert-reading',
    'rammstein',
    'red-hot-chili-peppers',
    'relics',
    'representasian-an-evening-of-asian-talent',
    'ride-the-cyclone',
    'rihanna',
    'ripples',
    'rod-stewart',
    'roller-rink-at-electric-summer',
    'sabaton',
    'sabrage',
    'sam-smith',
    'san-francisco-ballet-mere-mortals',
    'scrooge-a-cirque-extravaganza',
    'secret-cinema-presents-disneys-pirates-of-the-caribbean-the-',
    'shakeitup',
    'shanay-holmes-live-in-concert',
    'shania-twain',
    'showstopper-the-improvised-musical',
    'sinatra-the-musical',
    'six',
    'slipknot',
    'slowthai',
    'snow-patrol',
    'soprano',
    'state-ballet-of-georgia-swan-lake',
    'stereophonics',
    'stories-the-tap-dance-sensation',
    'stormzy',
    'suede',
    'sum-41',
    'system-of-a-down',
    'tame-impala',
    'tango-after-dark',
    'tao-of-glass',
    'taylor-swift',
    'the-1975',
    'the-boy-who-harnessed-the-wind',
    'the-car-man',
    'the-devil-wears-prada',
    'the-elvis-years',
    'the-fratellis',
    'the-killers',
    'the-last-ship',
    'the-little-match-girl-ballo-arthur-pita',
    'the-magic-flute-royal-ballet-and-opera',
    'the-magicians-table',
    'the-marriage-of-figaro-royal-ballet-and-opera',
    'the-phantom-of-the-opera',
    'the-producers',
    'the-rolling-stones',
    'the-shamrocks',
    'the-simon-garfunkel-story',
    'the-smartest-giant-in-town',
    'the-strokes',
    'the-weeknd',
    'theatre-royal-drury-lane-tour',
    'theatre-royalty-drury-lane',
    'thelma-louise-a-new-musical',
    'three-days-grace',
    'till-lindemann',
    'titanique',
    'to-die-for-a-comedy-english-national',
    'tom-grennan',
    'too-much-too-young',
    'tosca-english-national-opera',
    'trainspotting-the-musical',
    'travis',
    'trevor-ashley-a-million-years-of-minnelli',
    'trial-by-jury-the-zoo-english-national-opera',
    'twenty-one-pilots',
    'two-door-cinema-club',
    'un-ballo-in-maschera-royal-ballet-and-opera',
    'visionaries-robbins-and-macmillan-royal-ballet-and-opera',
    'wild-about-you',
    'wolf-alice',
    'you-it'
  ];
  const ALL_THEATRE = [
    'a-little-night-music',
    'back-to-the-future',
    'beautiful-carole-king-musical',
    'blood-brothers',
    'cat',
    'charlie-and-the-chocolate-factory',
    'chicago',
    'come-from-away',
    'company',
    'disney-aladdin',
    'frozen-the-musical',
    'grease',
    'guys-and-dolls',
    'hamlet-globe',
    'harry-potter-cursed-child',
    'jersey-boys',
    'joseph-amazing-technicolor-dreamcoat',
    'les-miserables-sondheim-theatre',
    'mamma-mia',
    'matilda-the-musical',
    'moulin-rouge',
    'now-you-see-me-live',
    'oliver',
    'one-man-two-guvnors',
    'operation-mincemeat',
    'phantom-of-the-opera',
    'phantom-of-the-opera-movie',
    'rent',
    'rocky-horror-show',
    'romeo-and-juliet-globe',
    'saturday-night-fever',
    'six-the-musical',
    'spring-awakening',
    'standing-at-the-sky-edge',
    'stephen-sondheim',
    'sweeney-todd',
    'the-book-of-mormon',
    'the-curious-incident-of-the-dog-in-the-night-time',
    'the-lion-king',
    'the-play-that-goes-wrong',
    'uncle-vanya',
    'wicked'
  ];
  const ALL_FOOTBALL = [
    'aberdeen',
    'ac-milan',
    'ajax',
    'alaves',
    'arsenal',
    'arsenal-women',
    'as-roma',
    'aston-villa',
    'atalanta',
    'athletic-bilbao',
    'atletico-madrid',
    'az-alkmaar',
    'bayer-leverkusen',
    'bayern-munich',
    'benfica',
    'blackburn-rovers',
    'bologna',
    'borussia-dortmund',
    'borussia-monchengladbach',
    'bournemouth',
    'braga',
    'brentford',
    'brighton',
    'burnley',
    'cagliari',
    'cardiff-city',
    'celta-vigo',
    'celtic',
    'chelsea',
    'chelsea-women',
    'coventry-city',
    'crystal-palace',
    'derby-county',
    'dundee-united',
    'eintracht-frankfurt',
    'espanyol',
    'everton',
    'fc-augsburg',
    'fc-barcelona',
    'feyenoord',
    'fiorentina',
    'fsv-mainz-05',
    'fulham',
    'getafe',
    'girona',
    'hamburger-sv',
    'hearts',
    'hellas-verona',
    'hibernian',
    'hoffenheim',
    'hull-city',
    'inter-milan',
    'ipswich',
    'juventus',
    'las-palmas',
    'lazio',
    'leeds-united',
    'leganes',
    'leicester-city',
    'lille-osc',
    'liverpool',
    'liverpool-women',
    'luton-town',
    'mallorca',
    'manchester-city',
    'manchester-united',
    'manchester-united-women',
    'middlesbrough',
    'millwall',
    'monaco',
    'motherwell',
    'napoli',
    'newcastle',
    'nice',
    'norwich-city',
    'nottingham-forest',
    'nottingham-forest-fc',
    'olympique-lyonnais',
    'olympique-marseille',
    'osasuna',
    'paris-saint-germain',
    'parma',
    'porto',
    'psv-eindhoven',
    'queens-park-rangers',
    'rangers',
    'rayo-vallecano',
    'rb-leipzig',
    'rc-lens',
    'rc-strasbourg',
    'real-betis',
    'real-madrid',
    'real-sociedad',
    'real-valladolid',
    'sc-freiburg',
    'schalke-04',
    'sevilla',
    'sheffield-united',
    'sheffield-wednesday',
    'southampton',
    'sporting-cp',
    'stade-brestois',
    'stade-rennais',
    'stoke-city',
    'sunderland',
    'swansea-city',
    'torino',
    'tottenham',
    'udinese',
    'union-berlin',
    'valencia',
    'vfb-stuttgart',
    'vfl-wolfsburg',
    'villarreal',
    'watford',
    'werder-bremen',
    'west-ham',
    'wolverhampton',
    'wolves'
  ];
  const ALL_VENUE = [
    'adelphi-theatre',
    'allianz-arena',
    'amex-stadium',
    'anfield',
    'barbican-centre',
    'boomtown-fair',
    'camp-nou',
    'cardiff-arena',
    'co-op-live-manchester',
    'download-festival',
    'emirates-stadium',
    'estadio-do-dragao',
    'estadio-metropolitano',
    'etihad-stadium',
    'first-direct-arena-leeds',
    'glastonbury-festival',
    'johan-cruyff-arena',
    'juventus-stadium',
    'latitude-festival',
    'leeds-festival',
    'london-stadium',
    'lyceum-theatre',
    'madison-square-garden',
    'motorpoint-arena-nottingham',
    'o2-arena',
    'old-trafford',
    'ovo-hydro-glasgow',
    'palace-theatre',
    'palace-theatre-london',
    'parc-des-princes',
    'reading-festival',
    'resorts-world-arena-birmingham',
    'royal-albert-hall',
    'royal-festival-hall',
    'san-siro',
    'santiago-bernabeu',
    'savoy-theatre',
    'shaftesbury-theatre',
    'signal-iduna-park',
    'sphere-las-vegas',
    'sse-arena-belfast',
    'st-james-park',
    'stade-de-france',
    'stamford-bridge',
    'tottenham-hotspur-stadium',
    'utilita-arena-birmingham',
    'victoria-palace-theatre',
    'villa-park',
    'wembley-stadium'
  ];

    let knownArtists = new Set();
    let knownVenues  = new Set();
    try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
    try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

    let created = 0, skipped = 0, errors = 0;

    // Register concert slugs
    for (const slug of ALL_CONCERT) {
      knownArtists.add(slug);
      const key = 'concert:artist:' + slug;
      try {
        const existing = await kv.get(key);
        if (!existing) {
          const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await kv.put(key, JSON.stringify({
            slug, name: displayName, search: displayName,
            genre: 'Live Events',
            description: `Compare ${displayName} ticket prices across verified sellers.`
          }));  // no TTL — permanent
          created++;
        } else { skipped++; }
      } catch { errors++; }
    }

    // Register theatre slugs
    for (const slug of ALL_THEATRE) {
      knownArtists.add(slug);
      const key = 'theatre:show:' + slug;
      try {
        const existing = await kv.get(key);
        if (!existing) {
          const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await kv.put(key, JSON.stringify({
            slug, name: displayName, search: displayName,
            genre: 'Theatre',
            description: `Compare ${displayName} ticket prices across verified sellers.`
          }));
          created++;
        } else { skipped++; }
      } catch { errors++; }
    }

    // Register football slugs
    for (const slug of ALL_FOOTBALL) {
      knownArtists.add(slug);
      const key = 'football:team:' + slug;
      try {
        const existing = await kv.get(key);
        if (!existing) {
          const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await kv.put(key, JSON.stringify({
            slug, name: displayName, search: displayName,
            genre: 'Football',
            description: `Compare ${displayName} ticket prices across verified sellers.`
          }));
          created++;
        } else { skipped++; }
      } catch { errors++; }
    }

    // Register venue slugs (separate known list)
    for (const slug of ALL_VENUE) {
      knownVenues.add(slug);
      const key = 'venue:' + slug;
      try {
        const existing = await kv.get(key);
        if (!existing) {
          const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await kv.put(key, JSON.stringify({
            slug, name: displayName, search: displayName,
            description: `Compare ticket prices for events at ${displayName}.`
          }));
          created++;
        } else { skipped++; }
      } catch { errors++; }
    }

    // Persist the updated known sets
    await kv.put(KNOWN_KEY,        JSON.stringify([...knownArtists]));
    await kv.put(KNOWN_VENUES_KEY, JSON.stringify([...knownVenues]));

    return json({
      message: 'Sitemap slugs registered into KNOWN_KEY.',
      totalRegistered: ALL_CONCERT.length + ALL_THEATRE.length +
                       ALL_FOOTBALL.length + ALL_VENUE.length,
      breakdown: {
        concert:  ALL_CONCERT.length,
        theatre:  ALL_THEATRE.length,
        football: ALL_FOOTBALL.length,
        venue:    ALL_VENUE.length
      },
      kvEntityRecords: { created, skipped, errors },
      backfillNext: '?trigger=1&phase=backfill',
      note: 'Run ?phase=backfill next to repair any TTLs on existing records.'
    }, 200);
  }

  const apiKey = env.TM_API_KEY;
  if (!apiKey) return json({ error: 'Missing TM_API_KEY' }, 500);

  // Load known sets to avoid re-queuing already-created pages
  let knownArtists = new Set();
  let knownVenues  = new Set();
  try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
  try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

  const newArtists = new Map();
  const newVenues  = new Map();
  const results    = { source, skipped: [], errors: [] };

  // ── Ticketmaster ──────────────────────────────────────────────────────────
  if (source === 'ticketmaster') {
    try {
      // Fetch Music, Sports, and Arts & Theatre segments for full genre coverage
      const tmDiag = [];
      const events = await fetchTicketmasterEvents(apiKey, kv, tmDiag);
      results.eventsScanned = events.length;
      results.tmDiag = tmDiag;

      for (const event of events) {
        const genre    = getGenre(event);
        const category = genreToCategory(genre);

        for (const attraction of (event._embedded?.attractions || [])) {
          if (!isValidName(attraction.name) || isTribute(attraction.name)) continue;
          const slug = toSlug(attraction.name);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          newArtists.set(slug, {
            slug, name: attraction.name, search: attraction.name,
            genre, category,
            description: generateArtistDescription(attraction.name, genre),
            source: 'ticketmaster'
          });
        }

        const venue = event._embedded?.venues?.[0];
        if (venue?.name && venue?.id) {
          const slug = toSlug(venue.name);
          if (slug && !knownVenues.has(slug) && !newVenues.has(slug)) {
            newVenues.set(slug, {
              slug, name: venue.name,
              city: venue.city?.name || '',
              country: venue.country?.name || '',
              venueId: venue.id,
              description: generateVenueDescription(venue.name, venue.city?.name || '', venue.country?.name || ''),
              source: 'ticketmaster'
            });
          }
        }
      }
    } catch (err) {
      results.errors.push({ source: 'ticketmaster', error: String(err) });
    }
  }

  // ── SportsEvents365 ───────────────────────────────────────────────────────
  if (source === 'se365') {
    const isProd = env.SE365_PROD === 'true';
    if (!isProd) {
      return json({ message: 'SE365 discovery skipped — SE365_PROD is not true', source }, 200);
    }
    try {
      const se365Cache = await kv.get('se365:participants:latest');
      if (se365Cache) {
        const participants = Object.values(JSON.parse(se365Cache));
        results.participantsScanned = participants.length;
        for (const p of participants) {
          // SE365 returns names with leading whitespace (" Jamie XX"). toSlug
          // trims so slugs looked fine, but the stored name fed page titles
          // and JSON-LD. Normalise once, here.
          const pName = String(p.name || '').replace(/\s+/g, ' ').trim();
          if (!pName) continue;
          if (!isValidName(pName) || isTribute(pName)) continue;
          // Fail CLOSED: an unmapped eventTypeId used to become 'Sports' and
          // get a /concert/ page. No genre now means no page.
          const genre = se365Genre(p.eventTypeId);
          if (!genre || !SE365_QUEUEABLE_GENRES.has(genre)) continue;
          const slug = toSlug(pName);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          const category = genreToCategory(genre);
          newArtists.set(slug, {
            slug, name: pName, search: pName,
            genre, category,
            description: generateArtistDescription(pName, genre),
            source: 'sportsevents365'
          });
        }
      } else {
        results.errors.push({ source: 'se365', error: 'Participant cache empty' });
      }
    } catch (err) {
      results.errors.push({ source: 'se365', error: String(err) });
    }
  }

  // ── Vivid Seats (Impact catalog) ─────────────────────────────────────────
  if (source === 'vividseats') {
    const accountSid = env.IMPACT_ACCOUNT_SID;
    const authToken  = env.IMPACT_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      results.errors.push({ source: 'vividseats', error: 'Impact credentials not configured' });
    } else {
      try {
        const basicAuth  = btoa(`${accountSid}:${authToken}`);
        let   page       = 1;
        let   totalPages = 1;
        let   scanned    = 0;

        while (page <= totalPages && page <= 10) { // cap at 10 pages to stay within 30s limit
          // Impact's catalog resource is /Catalogs/{CatalogId}/Items — the ID
          // belongs in the PATH. This previously called /Catalogs/Items with
          // CampaignId=12730 as a query param, which is not a resource, so it
          // 404'd on page 1 every time and VS discovery has never returned
          // anything. Catalog 7904 = Vivid Seats, per impact-debug.js:47,
          // which exercises exactly this URL.
          const catalogUrl = new URL(`https://api.impact.com/Mediapartners/${accountSid}/Catalogs/${VS_CATALOG_ID}/Items`);
          catalogUrl.searchParams.set('PageSize',   '100');
          catalogUrl.searchParams.set('Page',       String(page));

          const resp = await fetch(catalogUrl.toString(), {
            headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' }
          });

          if (!resp.ok) {
            // Capture the body — a bare status cost real debug time on the TM
            // and Partnerize bugs. Impact names the offending resource.
            let body = '';
            try { body = (await resp.text()).slice(0, 300); } catch {}
            results.errors.push({
              source: 'vividseats',
              error: `HTTP ${resp.status} on page ${page}`,
              url: catalogUrl.toString().replace(accountSid, '{accountSid}'),
              body
            });
            break;
          }

          const text = await resp.text();
          let items = [];

          // Try JSON first, fall back to XML parsing
          try {
            const data = JSON.parse(text);
            items = data?.Items || data?.CatalogItems || [];
            if (page === 1) {
              totalPages = Math.ceil((data?.total || data?.Total || items.length) / 100) || 1;
            }
          } catch {
            // XML: extract Name fields
            const nameMatches = [...text.matchAll(/<Name>(.*?)<\/Name>/gi)];
            items = nameMatches.map(m => ({ Name: m[1] }));
            const totalMatch = text.match(/<Catalogs[^>]+total="(\d+)"/i);
            if (totalMatch && page === 1) totalPages = Math.ceil(parseInt(totalMatch[1]) / 100);
          }

          for (const item of items) {
            const rawName = item.Name || item.name || '';
            if (!rawName || !isValidName(rawName) || isTribute(rawName)) continue;
            // Strip common event suffixes to get artist/team name
            const cleanName = rawName
              .replace(/\s*(tickets?|tour|live|concert|at\s+.+)$/i, '')
              .trim();
            if (!cleanName || cleanName.length < 3) continue;
            const slug = toSlug(cleanName);
            if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
            const genre    = 'Live Events';
            const category = 'concert'; // default; TM will classify on page load
            newArtists.set(slug, {
              slug, name: cleanName, search: cleanName,
              genre, category,
              description: generateArtistDescription(cleanName, genre),
              source: 'vividseats'
            });
          }

          scanned += items.length;
          page++;
        }
        results.vsScanned = scanned;
      } catch (err) {
        results.errors.push({ source: 'vividseats', error: String(err) });
      }
    }
  }

  // ── Ticombo (Partnerize) ──────────────────────────────────────────────────
  if (source === 'ticombo') {
    const apiKey      = env.PARTNERIZE_API_KEY;
    const userKey     = env.PARTNERIZE_USER_KEY;
    const publisherId = env.PARTNERIZE_PUBLISHER_ID;

    if (!apiKey || !userKey || !publisherId) {
      results.errors.push({ source: 'ticombo', error: 'Missing Partnerize credentials' });
    } else {
      try {
        const basicAuth = btoa(`${userKey}:${apiKey}`);
        // Partnerize's API lives on the LEGACY performancehorizon.com domain.
        // api.partnerize.com returns 404 for every path — this was found and
        // fixed in affiliate-conversions.js during session 10 but never here,
        // so Ticombo discovery had 404'd since it was written (confirmed
        // 24 Jul 2026). Do not "modernise" this hostname.
        const resp = await fetch(
          `https://api.performancehorizon.com/publisher/${publisherId}/campaign.json?limit=100`,
          { headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' } }
        );
        if (!resp.ok) {
          // Capture the body: a bare status cost real debug time here. A 404 on
          // the CORRECT domain means the PATH is wrong, not the host.
          let body = '';
          try { body = (await resp.text()).slice(0, 200); } catch {}
          results.errors.push({ source: 'ticombo', error: `Partnerize API: HTTP ${resp.status}`, body });
        } else {
          const data = await resp.json();
          const campaigns = data?.campaigns || [];
          const ticombo = campaigns.filter(c =>
            (c.campaign_name || c.title || '').toLowerCase().includes('ticombo')
          );
          results.ticomboDiscovery = {
            totalCampaigns: campaigns.length,
            ticomboFound: ticombo.length,
            note: 'Event-level discovery requires product feed access — using Ticombo search deep-links for now'
          };
        }
      } catch (err) {
        results.errors.push({ source: 'ticombo', error: String(err) });
      }
    }
  }

  // ── EVENT FILTER (Tier A only) ───────────────────────────────────────────
  // Single choke point: TM, SE365 and Vivid Seats all converge here, so one
  // filter covers every discovery source.
  //
  // Rejects ONE-OCCURRENCE names ("Session 4", "DZIEN 1", "3-Day Pass") that
  // can never be a stable comparison target. Tier B is NEVER applied here —
  // it is reporting-only via ?phase=eventaudit. "Saturday Night Fever" is a
  // West End musical that Tier B flags and Tier A correctly ignores.
  //
  // Validated 24 Jul 2026 across 2,983 registered entities in three sections
  // (concert 194 hits, football 13, theatre 0) with no false positive found.
  //
  // Escape hatches, in order of preference:
  //   KV key 'discover:eventfilter' = 'off'  — kill-switch, no deploy needed
  //   &nofilter=1                            — one-off bypass for testing
  //
  // Rejections are logged to 'discover:rejected:log' (last 200) so a bad
  // pattern surfaces as a review queue rather than as silent data loss.
  let rejectedEvents = [];
  let eventFilterOn  = url.searchParams.get('nofilter') !== '1';
  if (eventFilterOn) {
    try { if ((await kv.get('discover:eventfilter')) === 'off') eventFilterOn = false; } catch {}
  }

  let artistList = [...newArtists.values()];
  const venueList  = [...newVenues.values()];

  if (eventFilterOn) {
    const kept = [];
    for (const a of artistList) {
      const hit = looksLikeEvent(a.name);
      if (hit && hit.tier === 'A') {
        rejectedEvents.push({ slug: a.slug, name: a.name, label: hit.label, category: a.category });
      } else {
        kept.push(a);
      }
    }
    artistList = kept;

    if (rejectedEvents.length && !dryRun) {
      try {
        let log = [];
        try { const r = await kv.get('discover:rejected:log'); if (r) log = JSON.parse(r); } catch {}
        const stamp = new Date().toISOString();
        log = rejectedEvents.map(r => ({ ...r, at: stamp })).concat(log).slice(0, 200);
        await kv.put('discover:rejected:log', JSON.stringify(log));
      } catch {}
    }
  }

  if (dryRun) {
    return json({
      ...results,
      dryRun: true,
      eventFilter: eventFilterOn ? 'on' : 'off',
      rejectedAsEvents: rejectedEvents.length,
      rejectedSample: rejectedEvents.slice(0, 25),
      newArtists: artistList.map(a => ({ slug: a.slug, name: a.name, genre: a.genre, category: a.category })),
      newVenues:  venueList.map(v => ({ slug: v.slug, name: v.name, city: v.city })),
      message: 'Dry run — nothing written. Remove &dry=1 to queue for commit.'
    }, 200);
  }

  if (artistList.length === 0 && venueList.length === 0) {
    return json({ ...results, eventFilter: eventFilterOn ? 'on' : 'off',
      rejectedAsEvents: rejectedEvents.length, rejectedSample: rejectedEvents.slice(0, 25),
      message: 'No new pages discovered — all already known.' }, 200);
  }

  // Merge with existing pending queue (may include items from Awin cache refresh)
  let existing = { artists: [], venues: [] };
  try { const ep = await kv.get(PENDING_KEY); if (ep) existing = JSON.parse(ep); } catch {}

  const stamp = new Date().toISOString();
  // Dedup by slug — see mergePendingQueue. Appending unconditionally here
  // grew the SE365 queue to 25.68 MiB of duplicates and broke the KV write.
  const mergedArtists = mergePendingQueue(
    existing.artists, artistList.map(a => ({ ...a, queuedAt: stamp })), 'slug');
  const mergedVenues  = mergePendingQueue(
    existing.venues,  venueList.map(v => ({ ...v, queuedAt: stamp })), 'slug');
  const built = buildPendingBody(mergedArtists, mergedVenues, stamp);
  await kv.put(PENDING_KEY, built.body, { expirationTtl: 8 * 60 * 60 });

  return json({
    ...results,
    queued: { artists: artistList.length, venues: venueList.length },
    message: 'Queued for commit. Run ?trigger=1&phase=commit to deploy to GitHub.'
  }, 200);
}

// ===========================
// Commit phase — reads pending queue and commits to GitHub
// Routes each item to the correct category folder and data file.
// ===========================

// ── Trees-API batch commit — ONE commit for all pending pages ─────────
// Fixed ~7 GitHub calls total (5 for the tree + 2 data-file reads) vs
// 2 calls PER FILE on the legacy path. Cap: 300 pages/run; remainder
// stays queued. Falls back available at ?phase=commit&legacy=1.
const COMMIT_BATCH_CAP = 300;
const COMMIT_LOCK_KEY  = 'discover:commit:lock';
const COMMIT_LOCK_TTL  = 5 * 60; // 5 minutes — self-heals if function crashes mid-run

async function commitPendingPagesBatch(kv, githubToken, owner, repo, branch, dryRun, env) {
  // ── Commit lock — prevents concurrent runs double-splicing data files ──
  if (!dryRun) {
    const lock = await kv.get(COMMIT_LOCK_KEY);
    if (lock) {
      return json({
        error: 'Another commit run is already in progress (lock expires in 5 min). Try again shortly.',
        lockedAt: lock
      }, 429);
    }
    await kv.put(COMMIT_LOCK_KEY, new Date().toISOString(), { expirationTtl: COMMIT_LOCK_TTL });
  }

  const pendingRaw = await kv.get(PENDING_KEY);
  if (!pendingRaw) {
    if (!dryRun) await kv.delete(COMMIT_LOCK_KEY).catch(() => {});
    return json({ message: 'No pending pages to commit.', committed: 0 }, 200);
  }

  const pending = JSON.parse(pendingRaw);
  let artists = pending.artists || [];
  let venues  = pending.venues  || [];
  if (artists.length === 0 && venues.length === 0) {
    if (!dryRun) await kv.delete(COMMIT_LOCK_KEY).catch(() => {});
    return json({ message: 'Pending queue is empty.', committed: 0 }, 200);
  }

  if (dryRun) {
    return json({
      dryRun: true, mode: 'trees-batch',
      pending: {
        artists: artists.map(a => ({ slug: a.slug, name: a.name, genre: a.genre,
          category: a.category || genreToCategory(a.genre || '') })),
        venues: venues.map(v => ({ slug: v.slug, name: v.name }))
      },
      message: 'Dry run — nothing committed. Remove &dry=1 to deploy.'
    }, 200);
  }

  // ── LIQUIDITY GATE (Phase 4.1) ────────────────────────────────────────
  // Only publish entities that plausibly have ≥1 priced offer right now.
  // Rules (cheapest first, zero external calls in the hot path):
  //   PASS if a Phase 2 price summary exists for the slug, OR
  //   PASS if the item was queued within LIQUIDITY_FRESH_DAYS (it was just
  //        discovered inside a live priced feed — liquidity by construction).
  //   Items with no queuedAt (legacy queue entries) are treated as fresh so
  //   the current queue drain is not disrupted.
  //   FAIL → moved to autodiscover:deferred for weekly re-checks.
  // Venues are exempt: venue pages list events, they don't sell a headline price.
  const liquid = [], gated = [];
  const freshCutoff = Date.now() - LIQUIDITY_FRESH_DAYS * 86400000;
  for (const artist of artists) {
    const queuedTs = artist.queuedAt ? Date.parse(artist.queuedAt) : NaN;
    if (isNaN(queuedTs) || queuedTs >= freshCutoff) { liquid.push(artist); continue; }
    let hasSummary = false;
    try { hasSummary = !!(await kv.get(`price:summary:entity:${artist.slug}`)); } catch {}
    if (hasSummary) liquid.push(artist); else gated.push(artist);
  }
  if (gated.length) {
    let deferred = [];
    try { const d = await kv.get(DEFERRED_KEY); if (d) deferred = JSON.parse(d); } catch {}
    const known = new Set(deferred.map(i => i.slug));
    for (const g of gated) if (!known.has(g.slug)) deferred.push({ ...g, deferredAt: new Date().toISOString() });
    await kv.put(DEFERRED_KEY, JSON.stringify(deferred));
  }
  artists = liquid;

  // Cap the batch; keep the remainder queued for the next run.
  //
  // FIX: this used to give artists first claim on the ENTIRE cap
  // (artistCap = min(artists.length, CAP)), with venues only getting
  // whatever was left over (CAP - artists.length, floored at 0). With a
  // large pending-artist backlog — the normal state during any active
  // backfill — artists alone reliably meet or exceed CAP every single run,
  // so venues got committed ZERO times, run after run. This is the exact
  // reason venue.js sat at 49 entries despite the discovery side of this
  // pipeline (in the ticketmaster branch above) actively finding new venues
  // the whole time — they were being silently starved at the commit step.
  // Now venues get a GUARANTEED minimum slice of the cap first; artists take
  // whatever remains. Venue counts are naturally much smaller than artist
  // counts per run, so this costs artists little while finally letting
  // venue coverage grow.
  let remainderArtists = [], remainderVenues = [];
  if (artists.length + venues.length > COMMIT_BATCH_CAP) {
    const VENUE_MIN_SHARE = Math.min(venues.length, 50);
    const venueCap  = Math.max(VENUE_MIN_SHARE, Math.min(venues.length, COMMIT_BATCH_CAP));
    remainderVenues = venues.slice(venueCap);
    venues = venues.slice(0, venueCap);
    const artistCap = Math.max(0, COMMIT_BATCH_CAP - venues.length);
    remainderArtists = artists.slice(artistCap);
    artists = artists.slice(0, artistCap);
  }

  const github = new GitHubAPI(githubToken, owner, repo, branch);
  const committed = { concert: [], football: [], theatre: [], sports: [], venues: [], errors: [] };

  let knownArtists = new Set();
  let knownVenues  = new Set();
  try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
  try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

  // Bucket artists by category
  // 'sports' MUST be listed here. It was missing when the section shipped,
  // and because the fallback is `: 'concert'`, every sports entity was
  // silently committed as a /concert/ page — the exact mis-categorisation
  // the section exists to prevent. Any new category must be added here too
  // or it fails the same silent way.
  const byCategory = { concert: [], football: [], theatre: [], sports: [] };
  for (const artist of artists) {
    const cat = artist.category || genreToCategory(artist.genre || '');
    const bucket = byCategory[cat] ? cat : 'concert';
    byCategory[bucket].push({ ...artist, category: bucket });
  }

  // ── Build ALL file contents up front (no API calls yet) ──────────────
  const files = [];
  for (const [category, items] of Object.entries(byCategory)) {
    if (items.length === 0) continue;
    const htmlGenerator = categoryToHtmlGenerator(category);
    for (const artist of items) {
      files.push({ path: `${category}/${artist.slug}.html`, content: htmlGenerator(artist.slug, { name: artist.name }) });
      committed[category].push(artist.slug);
    }
  }
  for (const venue of venues) {
    files.push({ path: `venue/${venue.slug}.html`, content: generateVenuePageHtml(venue.slug) });
    committed.venues.push(venue.slug);
  }

  // ── Data files (concert.js / football.js / theatre.js) are NOT modified ─
  // Auto-discovered entries are served from KV (concert:artist:slug etc),
  // which the API handlers already read as their primary fallback path.
  // The JS arrays are hand-curated static lists — never auto-modified.
  // This permanently eliminates the double-splice build failures.

  // ── ONE commit for everything ────────────────────────────────────────
  const names = [...artists.map(a => a.name), ...venues.map(v => v.name)];
  const message = `Auto-add ${files.length} files: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8} more` : ''}`;
  let commitSha = null;
  try {
    commitSha = await github.commitFilesBatch(files, message);
  } catch (err) {
    // Whole batch failed — leave the queue intact for retry, report the error
    await kv.delete(COMMIT_LOCK_KEY).catch(() => {});
    return json({ error: 'Batch commit failed — pending queue preserved for retry.',
                  detail: String(err), filesAttempted: files.length }, 500);
  }

  // ── KV entity writes (permanent — no TTL) + known-set updates ────────
  for (const [category, items] of Object.entries(byCategory)) {
    const kvPrefix = categoryToKvPrefix(category);
    for (const artist of items) {
      try {
        await kv.put(`${kvPrefix}${artist.slug}`, JSON.stringify({
          slug:        artist.slug,
          name:        artist.name,
          search:      artist.search || artist.name,
          genre:       artist.genre || 'Live Events',
          description: artist.description || `Compare ${artist.name} ticket prices across verified sellers.`
        }));
        knownArtists.add(artist.slug);
      } catch (err) {
        committed.errors.push({ type: `${category}-kv`, slug: artist.slug, error: String(err) });
      }
    }
  }
  for (const venue of venues) {
    // FIX (the real bug — the earlier venue.js-splice fix targeted the
    // LEGACY commitPendingPages function, which this default path never
    // calls). This function was deliberately redesigned to route artist
    // data through KV instead of splicing concert.js/football.js/theatre.js
    // (see the comment above, "permanently eliminates the double-splice
    // build failures") — but venues never got the equivalent KV write, so a
    // venue committed here had its static page created and was marked
    // "known", with its actual data (venueId, city, country) saved
    // NOWHERE the API could ever read it. venue.js's onRequestGet only
    // checked its static VENUES array — with no KV fallback at all, unlike
    // every other category — so this was a structural dead end, not a
    // one-off glitch. Now writes venue:auto:{slug}, matching the same
    // pattern as concert:artist:/football:team:/sports:team:; venue.js's
    // onRequestGet needs a matching KV-fallback read (see that file).
    try {
      await kv.put(`venue:auto:${venue.slug}`, JSON.stringify({
        slug:        venue.slug,
        name:        venue.name,
        city:        venue.city || '',
        country:     venue.country || '',
        venueId:     venue.venueId || null,
        description: venue.description || `Compare ${venue.name} ticket prices across verified sellers on TicketScout.`
      }));
      knownVenues.add(venue.slug);
    } catch (err) {
      committed.errors.push({ type: 'venue-kv', slug: venue.slug, error: String(err) });
      // Deliberately NOT added to knownVenues on failure — same principle
      // as the legacy-path fix: only mark "known" once the data is actually
      // saved somewhere retrievable, so a failure here leaves the venue
      // eligible for rediscovery next sweep instead of silently stranded.
    }
  }

  // ── Requeue remainder or clear ────────────────────────────────────────
  if (remainderArtists.length || remainderVenues.length) {
    await kv.put(PENDING_KEY, JSON.stringify({
      artists: remainderArtists, venues: remainderVenues,
      updated: new Date().toISOString()
    }), { expirationTtl: 8 * 60 * 60 });
  } else {
    await kv.delete(PENDING_KEY);
  }
  await kv.put(KNOWN_KEY,        JSON.stringify([...knownArtists]));
  await kv.put(KNOWN_VENUES_KEY, JSON.stringify([...knownVenues]));

  // ── Sitemap registry update (Phase 4.3D) ─────────────────────────────
  // New pages appear in /api/sitemap on the same run that creates them.
  // lastmod = commit date (a real content change, not render time).
  try {
    let registry = { updated: null, sections: { concert: {}, football: {}, theatre: {}, sports: {}, venue: {} } };
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    for (const [category, items] of Object.entries(byCategory)) {
      if (!registry.sections[category]) registry.sections[category] = {};
      for (const artist of items) registry.sections[category][artist.slug] = today;
    }
    if (!registry.sections.venue) registry.sections.venue = {};
    for (const venue of venues) registry.sections.venue[venue.slug] = today;
    registry.updated = new Date().toISOString();
    await kv.put(REGISTRY_KEY, JSON.stringify(registry));
    // The sports hub serves a 6h-cached index. Drop it here so entities
    // committed by the daily job appear on /sports immediately instead of
    // lagging the sitemap by up to six hours.
    if (byCategory.sports && byCategory.sports.length) {
      await kv.delete('sports:hub:index').catch(() => {});
    }
  } catch (err) {
    committed.errors.push({ type: 'sitemap-registry', error: String(err) });
  }

  await kv.delete(COMMIT_LOCK_KEY).catch(() => {});
  return json({
    committed, commitSha, filesInCommit: files.length,
    liquidityGate: { passed: liquid.length, deferred: gated.length },
    remainderQueued: remainderArtists.length + remainderVenues.length,
    message: 'Done — one batch commit pushed; Cloudflare deploying.'
  }, 200);
}

async function commitPendingPages(kv, githubToken, owner, repo, branch, dryRun, env) {
  const pendingRaw = await kv.get(PENDING_KEY);
  if (!pendingRaw) {
    return json({ message: 'No pending pages to commit.', committed: 0 }, 200);
  }

  const pending = JSON.parse(pendingRaw);
  const artists = pending.artists || [];
  const venues  = pending.venues  || [];

  if (artists.length === 0 && venues.length === 0) {
    return json({ message: 'Pending queue is empty.', committed: 0 }, 200);
  }

  if (dryRun) {
    return json({
      dryRun: true,
      pending: {
        artists: artists.map(a => ({
          slug:     a.slug,
          name:     a.name,
          genre:    a.genre,
          category: a.category || genreToCategory(a.genre || '')
        })),
        venues: venues.map(v => ({ slug: v.slug, name: v.name }))
      },
      message: 'Dry run — nothing committed. Remove &dry=1 to deploy.'
    }, 200);
  }

  const github    = new GitHubAPI(githubToken, owner, repo, branch);
  const committed = {
    concert:  [],
    football: [],
    theatre:  [],
    venues:   [],
    errors:   []
  };

  // Load known sets to update after committing
  let knownArtists = new Set();
  let knownVenues  = new Set();
  try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
  try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

  // Bucket artists by category
  // 'sports' MUST be listed here. It was missing when the section shipped,
  // and because the fallback is `: 'concert'`, every sports entity was
  // silently committed as a /concert/ page — the exact mis-categorisation
  // the section exists to prevent. Any new category must be added here too
  // or it fails the same silent way.
  const byCategory = { concert: [], football: [], theatre: [], sports: [] };
  for (const artist of artists) {
    const cat = artist.category || genreToCategory(artist.genre || '');
    const bucket = byCategory[cat] ? cat : 'concert';
    byCategory[bucket].push({ ...artist, category: bucket });
  }

  // Commit each bucket
  for (const [category, items] of Object.entries(byCategory)) {
    if (items.length === 0) continue;

    const htmlGenerator = categoryToHtmlGenerator(category);
    const kvPrefix      = categoryToKvPrefix(category);

    for (const artist of items) {
      try {
        const path = `${category}/${artist.slug}.html`;
        await github.createFile(
          path,
          htmlGenerator(artist.slug, { name: artist.name }),
          `Auto-add ${category} page: ${artist.name} [${artist.source}]`
        );
        committed[category].push(artist.slug);
        knownArtists.add(artist.slug);

        // Store data in KV so the relevant /api/[category] can serve it
        await kv.put(`${kvPrefix}${artist.slug}`, JSON.stringify({
          slug:        artist.slug,
          name:        artist.name,
          search:      artist.search || artist.name,
          genre:       artist.genre || 'Live Events',
          description: artist.description || `Compare ${artist.name} ticket prices across verified sellers.`
        }));  // NO TTL — entity records are permanent; a TTL here was
              // silently deleting artists 30 days after commit (live bug)

      } catch (err) {
        committed.errors.push({ type: category, slug: artist.slug, error: String(err) });
      }
    }

    // Update the category data file (concert.js / football.js / theatre.js)
    try {
      await updateCategoryDataFile(github, category, items);
    } catch (err) {
      committed.errors.push({ type: `${category}-data`, error: String(err) });
    }
  }

  // Commit venue pages (static HTML stubs)
  const staticCommitOk = new Set();
  for (const venue of venues) {
    try {
      await github.createFile(
        `venue/${venue.slug}.html`,
        generateVenuePageHtml(venue.slug),
        `Auto-add venue page: ${venue.name} [${venue.source}]`
      );
      committed.venues.push(venue.slug);
      staticCommitOk.add(venue.slug);
    } catch (err) {
      committed.errors.push({ type: 'venue', slug: venue.slug, error: String(err) });
    }
  }

  let venueDataFileOk = false;
  if (venues.length > 0) {
    try { await updateVenueDataFile(github, venues); venueDataFileOk = true; } catch (err) {
      committed.errors.push({ type: 'venue-data', error: String(err) });
    }
  }

  // FIX: previously marked a venue "known" (excluding it from all future
  // discovery) the moment its STATIC PAGE committed — before the data-file
  // update was even attempted. Combined with the bug above, that's how ~250+
  // venues got silently stranded: static page live, sitemap listed, marked
  // "known" so the discovery sweep would never offer them again, but the
  // one piece of data the API actually needs (venueId) never made it
  // anywhere durable. Now: only mark "known" once the shared venue.js data
  // file update has ALSO been confirmed to succeed, so a partial failure
  // leaves the venue eligible to be rediscovered (with fresh, real data)
  // next sweep instead of stuck forever.
  if (venueDataFileOk) {
    for (const venue of venues) {
      if (staticCommitOk.has(venue.slug)) knownVenues.add(venue.slug);
    }
  }

  // Clear the pending queue and save updated known sets
  await kv.delete(PENDING_KEY);
  await kv.put(KNOWN_KEY,        JSON.stringify([...knownArtists]));
  await kv.put(KNOWN_VENUES_KEY, JSON.stringify([...knownVenues]));

  return json({ committed, message: 'Done — pages committed to GitHub and deploying via Cloudflare.' }, 200);
}

// ===========================
// Category data file updater — routes to correct .js file
// ===========================

// Compute-only variant: returns { path, content } for the batch commit tree.
async function computeCategoryDataFileUpdate(github, category, items) {
  const dataFilePaths = {
    concert:  'functions/api/concert.js',
    football: 'functions/api/football.js',
    theatre:  'functions/api/theatre.js'
  };
  const arrayNames = {
    concert:  'ARTISTS',
    football: 'TEAMS',
    theatre:  'SHOWS'
  };

  const path      = dataFilePaths[category] || dataFilePaths.concert;
  const arrayName = arrayNames[category] || 'ARTISTS';

  const content = await github.getFileContent(path);

  // Build entry rows appropriate to each data file
  let entries;
  if (category === 'football') {
    entries = items.map(a =>
      `  { slug: '${esc(a.slug)}', name: '${esc(a.name)}', search: '${esc(a.search)}', tmSearch: '${esc(a.name)}', genre: 'Football', description: '${esc(a.description)}' },`
    ).join('\n');
  } else {
    entries = items.map(a =>
      `  { slug: '${esc(a.slug)}', name: '${esc(a.name)}', search: '${esc(a.search)}', genre: '${esc(a.genre)}', description: '${esc(a.description)}' },`
    ).join('\n');
  }

  // All three data files use ];\n\nexport async function pattern (no export default)
  let updated = content.replace(
    /(\];\s*\n\nexport async function)/,
    `${entries}\n];\n\nexport async function`
  );
  if (updated === content) {
    updated = content.replace(
      /(\];\s*\nexport async function)/,
      `${entries}\n];\nexport async function`
    );
  }
  if (updated === content) {
    throw new Error(`Could not find insertion point in ${path} — ${arrayName} array closing bracket not matched`);
  }
  return { path, content: updated };
}

// Legacy wrapper — used only by the &legacy=1 commit path.
async function updateCategoryDataFile(github, category, items) {
  const file = await computeCategoryDataFileUpdate(github, category, items);
  await github.createFile(file.path, file.content, `Auto-update ${category}: ${items.map(a => a.name).join(', ')}`);
}

// Compute-only variant: returns { path, content } for the batch commit tree.
async function computeVenueDataFileUpdate(github, venues) {
  const path = 'functions/api/venue.js';
  let content = '';
  let isNew   = false;
  try {
    content = await github.getFileContent(path);
  } catch { isNew = true; content = generateBaseVenueJs(); }

  const entries = venues.map(v =>
    `  { slug: '${esc(v.slug)}', name: '${esc(v.name)}', city: '${esc(v.city)}', country: '${esc(v.country)}', venueId: '${esc(v.venueId)}', description: '${esc(v.description)}' },`
  ).join('\n');

  let updated;
  if (isNew) {
    updated = content.replace('// VENUES_PLACEHOLDER', entries);
  } else {
    // FIX: previously matched /(\];\s*\n\nexport async function)/ — assumed
    // the VENUES array's closing "];" was immediately followed by "export
    // async function onRequestGet". venue.js has since grown a SECOND array
    // (VENUE_TYPE_RULES) plus venueType()/listVenues() between the VENUES
    // array and onRequestGet, so that pattern no longer exists ANYWHERE in
    // the file. content.replace() found no match and silently returned the
    // ORIGINAL content UNCHANGED — no error, nothing to see in the commit
    // response — while the static page commit below succeeded independently
    // every time. That's exactly how venues ended up with a live page and a
    // sitemap entry but a 404 API: venueId/city/country were never actually
    // saved anywhere. Now: find the VENUES array's OWN closing bracket
    // specifically (the first "];" after "const VENUES = ["), and throw
    // rather than silently do nothing if that structure isn't found — a
    // loud failure in committed.errors beats an invisible no-op.
    const arrayStart = content.indexOf('const VENUES = [');
    if (arrayStart === -1) {
      throw new Error('venue.js: could not find "const VENUES = [" — refusing to silently no-op.');
    }
    const closeIdx = content.indexOf('\n];', arrayStart);
    if (closeIdx === -1) {
      throw new Error('venue.js: found the VENUES array start but no closing "];" after it — structure has changed again.');
    }
    updated = content.slice(0, closeIdx) + '\n' + entries + content.slice(closeIdx + 1);
  }

  return { path, content: updated };
}

// Legacy wrapper — used only by the &legacy=1 commit path.
async function updateVenueDataFile(github, venues) {
  const file = await computeVenueDataFileUpdate(github, venues);
  await github.createFile(file.path, file.content, `Auto-update venues: ${venues.map(v => v.name).join(', ')}`);
}

// ===========================
// Ticketmaster fetcher — Music, Sports, Arts & Theatre
// ===========================

// Vivid Seats catalog on Impact. Confirmed in impact-debug.js:47.
// TicketNetwork is catalog 896 if a second source is ever added here.
const VS_CATALOG_ID = '7904';

const TM_CURSOR_KEY = 'autodiscover:tm:cursor';

async function fetchTicketmasterEvents(apiKey, kv, diag) {
  const events = [];
  const seen   = new Set();

  // Rotating cursor sweep replaces the old top-300-trending skim.
  // Grid: 3 segments x 5 pages of 200 = 3,000-event window per full sweep.
  // Each run advances one page across all 3 segments (600 events/run),
  // so a full sweep completes every 5 runs, then wraps and re-sweeps —
  // perpetually catching new on-sales across the whole GB catalogue.
  const segmentIds = [
    'KZFzniwnSyZfZ7v7nJ', // Music
    'KZFzniwnSyZfZ7v7nE', // Sports
    'KZFzniwnSyZfZ7v7na', // Arts & Theatre
  ];
  const MAX_PAGE = 5; // TM caps page*size at 1000 => pages 0-4 at size=200

  let cursor = { page: 0 };
  try { const c = await kv.get(TM_CURSOR_KEY); if (c) cursor = JSON.parse(c); } catch {}
  const page = (cursor.page >= 0 && cursor.page < MAX_PAGE) ? cursor.page : 0;

  let segIndex = 0;
  for (const segmentId of segmentIds) {
    // TM spike arrest: 5 messages/sec across the whole key, shared with live
    // proxy traffic. Unspaced back-to-back calls produced a 429 on the third
    // segment (confirmed 24 Jul 2026). Same 240ms spacing as the s7.2 fix.
    if (segIndex++ > 0) await new Promise(r => setTimeout(r, 260));

    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    u.searchParams.set('apikey', apiKey);
    u.searchParams.set('size', '200');
    u.searchParams.set('page', String(page));
    // 'onSaleStartDate,desc' is NOT a valid TM sort and returned 400 (DIS1016)
    // on every call since this was written — silently, because the catch below
    // was empty. Valid values per TM: name,asc | name,desc | date,asc |
    // date,desc | relevance,asc | relevance,desc | distance,asc |
    // distance,date,asc | name,date,asc. 'date,asc' is used elsewhere in the
    // codebase and gives deterministic ordering, which deep paging needs.
    u.searchParams.set('sort', 'date,asc');
    u.searchParams.set('segmentId', segmentId);
    // No countryCode filter — discover international events too.
    // UK fans buy tickets to events worldwide (European football, US tours etc).
    // INSTRUMENTED 24 Jul 2026. This block previously had an EMPTY catch and
    // never checked resp.ok, so a 400/401/429 and a genuinely empty result were
    // indistinguishable — both produced eventsScanned: 0 with no error. TM
    // discovery was returning zero with the API provably healthy (?diag=1
    // returned 200) and nothing surfaced it. Never re-empty this catch.
    const d = { segmentId, page, status: null, ok: false, returned: 0 };
    try {
      const resp = await fetch(u.toString());
      d.status = resp.status;
      d.ok     = resp.ok;
      const raw = await resp.text();
      if (!resp.ok) {
        d.body = raw.slice(0, 300);
      } else {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { d.parseError = String(e).slice(0, 120); }
        const list = data?._embedded?.events || [];
        d.returned  = list.length;
        d.totalElements = data?.page?.totalElements;
        d.totalPages    = data?.page?.totalPages;
        if (!list.length) d.body = raw.slice(0, 300);
        for (const e of list) {
          if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
        }
      }
    } catch (err) {
      d.fetchError = String(err).slice(0, 200);
    }
    if (diag) diag.push(d);
  }

  // Advance the cursor ONLY if this run actually retrieved something.
  // Previously it advanced unconditionally, so while every request was 400ing
  // the cursor kept rotating 0->1->2->3->4->0, making the failure both
  // invisible AND self-perpetuating. On a total failure we now re-try the same
  // page next run rather than silently skipping a fifth of the catalogue.
  if (events.length > 0) {
    try {
      await kv.put(TM_CURSOR_KEY, JSON.stringify({ page: (page + 1) % MAX_PAGE, lastRun: new Date().toISOString() }));
    } catch {}
  }

  return events;
}

// ===========================
// GitHub API
// ===========================

class GitHubAPI {
  constructor(token, owner, repo, branch) {
    this.token = token; this.owner = owner; this.repo = repo; this.branch = branch;
  }
  async request(method, path, body) {
    const resp = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'TicketScout-AutoDeploy'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!resp.ok) throw new Error(`GitHub ${method} ${path} → ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }
  async getFileSha(path) {
    try {
      const d = await this.request('GET', `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`);
      return d.sha;
    } catch { return null; }
  }
  async createFile(path, content, message) {
    const sha  = await this.getFileSha(path);
    const body = { message, content: btoa(unescape(encodeURIComponent(content))), branch: this.branch };
    if (sha) body.sha = sha;
    return this.request('PUT', `/repos/${this.owner}/${this.repo}/contents/${path}`, body);
  }

  // ── Git Trees API — commit ANY number of files in ~5 API calls ──────
  // Old path: 2 calls PER FILE (GET sha + PUT) — capped runs at ~25-40 pages.
  // Trees path: fixed 5 calls regardless of file count.
  async getFileContent(path) {
    const d = await this.request('GET', `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`);
    return decodeURIComponent(escape(atob(d.content)));
  }
  async commitFilesBatch(files, message) {
    // files: [{ path: 'concert/x.html', content: '...' }, ...]
    if (!files.length) return null;
    // 1. Current branch head
    const ref = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.branch}`);
    const headSha = ref.object.sha;
    // 2. Base tree of head commit
    const headCommit = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/commits/${headSha}`);
    const baseTreeSha = headCommit.tree.sha;

    // 3. FIX (1 Aug 2026): blobs created in parallel FIRST, tree built from
    // SHA references — not inline content. Confirmed via checkpoint
    // instrumentation that a single tree-creation call with inline content
    // for ~100 files took 2+ minutes and 524'd, even though the tree-fetch
    // and every other step took ~1s each. The "~5 calls regardless of file
    // count" framing above is about REQUEST COUNT from this client, not
    // GitHub's server-side WORK per request — passing inline content forces
    // GitHub to blob-ify every file synchronously as part of processing one
    // huge tree-creation request, and that cost scales with total content
    // size in the batch, not file count. Splitting blob creation into its
    // own step lets it run CONCURRENTLY (chunked, same bounded-concurrency
    // pattern used everywhere else tonight) instead of serially inside
    // GitHub's own black-box tree processing — this removes the scaling
    // problem rather than just working around it with smaller batches.
    // Delete entries (content === null) never needed a blob and are
    // unaffected — sha: null already told GitHub to remove that path.
    const BLOB_CHUNK = 25;
    const toCreate = files.filter(f => f.content !== null);
    const blobShaByPath = {};
    for (let i = 0; i < toCreate.length; i += BLOB_CHUNK) {
      const chunk = toCreate.slice(i, i + BLOB_CHUNK);
      const results = await Promise.all(chunk.map(f =>
        this.request('POST', `/repos/${this.owner}/${this.repo}/git/blobs`, {
          content: f.content, encoding: 'utf-8'
        })
      ));
      chunk.forEach((f, idx) => { blobShaByPath[f.path] = results[idx].sha; });
    }

    // 4. New tree — every entry now references a pre-created blob SHA (or
    // sha: null for a delete), so this call does no content processing at
    // all and should be fast regardless of how much total content was in
    // the batch.
    const tree = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: files.map(f => (f.content === null
        ? { path: f.path, mode: '100644', type: 'blob', sha: null }
        : { path: f.path, mode: '100644', type: 'blob', sha: blobShaByPath[f.path] }))
    });
    // 5. Commit pointing at the new tree
    const commit = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      message, tree: tree.sha, parents: [headSha]
    });
    // 6. Advance the branch ref
    await this.request('PATCH', `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`, {
      sha: commit.sha
    });
    return commit.sha;
  }
}

// ===========================
// HTML generators — one per category
// ===========================

function generateArtistPageHtml(slug, enrich) {
  const { name: displayName, title, description, jsonLd } = stubHeadEnrichment('concert', slug, enrich);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escAttr(title)}</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="${escAttr(description)}" />
  <meta property="og:title" content="${escAttr(displayName)} Tickets | TicketScout" />
  <meta property="og:description" content="${escAttr(description)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/concert/${slug}" />
  <script type="application/ld+json">${jsonLd}</script>
  <script>window.__CONCERT_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://s1.ticketm.net" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel=\'stylesheet\'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/concert.html?v=${TEMPLATE_VERSION}');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\\s\\S]*?)<\\/style>/i);
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load concert template:', e); }
  })();
</script></body></html>`;
}

// ── Template version used inside generated stubs — single point of truth ──
// Bump here when football.html/concert.html/theatre.html change, then run
// ?phase=regenerate per category to cure stub drift (Hamilton-class bug).
const TEMPLATE_VERSION = '20260717a';

// ── Phase 4 head enrichment for generated stubs ──────────────────────────
// Returns { title, description, jsonLd } for a stub's <head>. All three are
// server-visible and survive the client-side body swap (only <body> is
// replaced by the template loader). JS-injected JSON-LD is unreliably picked
// up by Google — baking it into the head at commit time is the fix (4.2).
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function stubHeadEnrichment(category, slug, enrich) {
  const facts = (enrich && enrich.facts) || {};
  const name  = (enrich && enrich.name) || facts.name ||
                slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const pageUrl = `https://ticketscout.co.uk/${category}/${slug}`;

  // Tier-1 comparison-intent title pattern (4.1)
  const title = `Compare ${name} Ticket Prices — Cheapest ${name} Tickets | TicketScout`;

  // Meta description: comparison base + one entity-specific fact fragment
  let fragment = '';
  if (category === 'football' && facts.stadium) {
    fragment = ` Home matches at ${facts.stadium}${facts.city ? `, ${facts.city}` : ''}.`;
  } else if (category === 'sports' && (facts.venue || facts.league)) {
    fragment = facts.venue
      ? ` Home events at ${facts.venue}${facts.city ? `, ${facts.city}` : ''}.`
      : ` Competing in the ${facts.league}.`;
  } else if (category === 'concert' && facts.origin) {
    fragment = `${facts.genres && facts.genres.length ? ` ${facts.genres[0].replace(/\b\w/g, c => c.toUpperCase())} from ${facts.origin}.` : ` Touring artist from ${facts.origin}.`}`;
  }
  let description = `Compare ${name} ticket prices across verified sellers and find the cheapest ${name} tickets. Updated daily.${fragment}`;
  if (description.length > 158) description = description.slice(0, 155).replace(/\s+\S*$/, '') + '…';

  // JSON-LD @graph — nodes/fields self-omit when facts are missing
  const graph = [];
  const catLabel = { football: 'Football', concert: 'Concerts', theatre: 'Theatre', sports: 'Sports' }[category] || category;
  if (category === 'football') {
    const team = { '@type': 'SportsTeam', '@id': `${pageUrl}#team`, name, sport: 'Football' };
    if (facts.league)  team.memberOf = { '@type': 'SportsOrganization', name: facts.league };
    if (facts.founded) team.foundingDate = facts.founded;
    if (facts.stadium) {
      team.location = { '@id': `${pageUrl}#venue` };
      const venue = { '@type': 'StadiumOrArena', '@id': `${pageUrl}#venue`, name: facts.stadium };
      if (facts.capacity) venue.maximumAttendeeCapacity = facts.capacity;
      if (facts.city) {
        venue.address = { '@type': 'PostalAddress', addressLocality: facts.city };
        if (facts.country) venue.address.addressCountry = facts.country;
      }
      graph.push(venue);
    }
    graph.push(team);
  } else if (category === 'concert') {
    const artist = { '@type': facts.artistType === 'Person' ? 'Person' : 'MusicGroup', '@id': `${pageUrl}#artist`, name };
    if (facts.genres && facts.genres.length) artist.genre = facts.genres;
    if (facts.artistType !== 'Person' && facts.origin) artist.foundingLocation = { '@type': 'Place', name: facts.origin };
    graph.push(artist);
  } else if (category === 'sports') {
    // A sports entity is either a club or an individual competitor. Only
    // claim SportsTeam when enrichment actually says so — asserting a boxer
    // is a "team" is the same fabrication the SE365 descriptions used to make.
    const isPerson = facts.entityType === 'Person' || facts.artistType === 'Person';
    const node = isPerson
      ? { '@type': 'Person', '@id': `${pageUrl}#athlete`, name }
      : { '@type': 'SportsTeam', '@id': `${pageUrl}#team`, name };
    if (facts.sport)   node.sport = facts.sport;
    if (facts.league)  node.memberOf = { '@type': 'SportsOrganization', name: facts.league };
    if (!isPerson && facts.founded) node.foundingDate = facts.founded;
    if (facts.venue) {
      node.location = { '@id': `${pageUrl}#venue` };
      const venue = { '@type': 'StadiumOrArena', '@id': `${pageUrl}#venue`, name: facts.venue };
      if (facts.capacity) venue.maximumAttendeeCapacity = facts.capacity;
      if (facts.city) {
        venue.address = { '@type': 'PostalAddress', addressLocality: facts.city };
        if (facts.country) venue.address.addressCountry = facts.country;
      }
      graph.push(venue);
    }
    graph.push(node);
  }
  graph.push({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: catLabel, item: `https://ticketscout.co.uk/${category}` },
      { '@type': 'ListItem', position: 2, name: `${name} Tickets` }
    ]
  });
  // \u003c escaping prevents any </script> breakout from entity names
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');

  return { name, title, description, jsonLd };
}

function generateFootballPageHtml(slug, enrich) {
  const { name: displayName, title, description, jsonLd } = stubHeadEnrichment('football', slug, enrich);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escAttr(title)}</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="${escAttr(description)}" />
  <meta property="og:title" content="${escAttr(displayName)} Tickets | TicketScout" />
  <meta property="og:description" content="${escAttr(description)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/football/${slug}" />
  <script type="application/ld+json">${jsonLd}</script>
  <script>window.__FOOTBALL_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://s1.ticketm.net" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel=\'stylesheet\'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/football.html?v=${TEMPLATE_VERSION}');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\\s\\S]*?)<\\/style>/i);
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load football template:', e); }
  })();
</script></body></html>`;
}

// Sports entity stub. Static file at sports/{slug}.html — deliberately NOT a
// Pages Function. Creating functions/sports/[slug].js would collide with the
// /sports/ static folder and produce Error 1101/522, the same trap documented
// for football and theatre. Only concert, venue and event have safe dynamic
// routes.
function generateSportsPageHtml(slug, enrich) {
  const { name: displayName, title, description, jsonLd } = stubHeadEnrichment('sports', slug, enrich);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escAttr(title)}</title>
  <meta name="robots" content="index, follow" />
  <meta name="description" content="${escAttr(description)}" />
  <meta property="og:title" content="${escAttr(displayName)} Tickets | TicketScout" />
  <meta property="og:description" content="${escAttr(description)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/sports/${slug}" />
  <script type="application/ld+json">${jsonLd}</script>
  <script>window.__SPORTS_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://s1.ticketm.net" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel=\'stylesheet\'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/sports.html?v=${TEMPLATE_VERSION}');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\\s\\S]*?)<\\/style>/i);
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load sports template:', e); }
  })();
</script></body></html>`;
}

function generateTheatrePageHtml(slug, enrich) {
  const { name: displayName, title, description, jsonLd } = stubHeadEnrichment('theatre', slug, enrich);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escAttr(title)}</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="${escAttr(description)}" />
  <meta property="og:title" content="${escAttr(displayName)} Tickets | TicketScout" />
  <meta property="og:description" content="${escAttr(description)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/theatre/${slug}" />
  <script type="application/ld+json">${jsonLd}</script>
  <script>window.__THEATRE_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://s1.ticketm.net" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel=\'stylesheet\'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/theatre.html?v=${TEMPLATE_VERSION}');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\\s\\S]*?)<\\/style>/i);
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load theatre template:', e); }
  })();
</script></body></html>`;
}

function generateVenuePageHtml(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Events & Tickets | TicketScout</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="Compare ${displayName} ticket prices across verified sellers. Find the cheapest ${displayName} tickets and buy direct. Updated daily." />
  <meta property="og:title" content="${displayName} Tickets | TicketScout" />
  <meta property="og:description" content="Compare ${displayName} ticket prices across verified sellers. Find the best deal." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/venue/${slug}" />
  <script>window.__VENUE_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://s1.ticketm.net" crossorigin />
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" as="style" onload="this.onload=null;this.rel=\'stylesheet\'" />
  <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" /></noscript>
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/venue.html');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\\s\\S]*?)<\\/style>/i);
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load venue template:', e); }
  })();
</script></body></html>`;
}

function generateBaseVenueJs() {
  return `// TicketScout — Venue Data (auto-managed)\nconst VENUES = [\n// VENUES_PLACEHOLDER\n];\nexport async function onRequestGet({ request, env }) {\n  const url = new URL(request.url);\n  const slug = url.searchParams.get('slug');\n  if (!slug) return jsonResponse({ error: 'slug required' }, 400);\n  const venue = VENUES.find(v => v.slug === slug.toLowerCase());\n  if (!venue) return jsonResponse({ error: 'Venue not found' }, 404);\n  const apiKey = env.TM_API_KEY;\n  let events = [];\n  if (apiKey && venue.venueId) {\n    try {\n      const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');\n      u.searchParams.set('apikey', apiKey);\n      u.searchParams.set('venueId', venue.venueId);\n      u.searchParams.set('size', '20');\n      u.searchParams.set('sort', 'date,asc');\n      const resp = await fetch(u.toString());\n      const data = await resp.json();\n      events = data?._embedded?.events || [];\n    } catch {}\n  }\n  return jsonResponse({ venue, events }, 200);\n}\nfunction jsonResponse(body, status) {\n  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });\n}\nexport default VENUES;\n`;
}

// ===========================
// Category routing helpers
// ===========================

/**
 * Maps a genre string to a page category folder.
 * football → 'football', theatre/musical → 'theatre', everything else → 'concert'
 */
// Non-football sports genres get their own section. Before this existed
// every one of them fell through to 'concert', which is how basketball
// teams and MMA fighters ended up on /concert/ pages.
// NOTE: 'american football' must be tested BEFORE the football check, or
// includes('football') would route NFL teams to the soccer section.
const SPORTS_GENRES = new Set([
  'basketball', 'mma', 'ice hockey', 'rugby', 'handball', 'american football',
  'baseball', 'boxing', 'tennis', 'cricket', 'motorsport', 'golf', 'wrestling',
  // Added 25 Jul: the genres the ?phase=genreaudit repair writes. Without these
  // genreToCategory() didn't recognise them as sports, so a fix-categories run
  // tried to drag every darts/snooker/esports/winter-sports/horse-racing entity
  // OUT of /sports/ and into concert. MUST stay in sync with SPORT_RULES in the
  // genreaudit phase — any sport there must be here too.
  'darts', 'snooker', 'esports', 'horse racing', 'winter sports', 'volleyball',
  // TM's SEGMENT name, not a genre. getGenre() falls back to the segment when
  // both subGenre and genre are 'Undefined' — which is the norm for tournament
  // sessions (Miami Open, ABN AMRO Open, F1 GP day passes). Without this entry
  // those fall through genreToCategory()'s catch-all and become CONCERTS.
  // 217 such entities were found in the concert section on 24 Jul 2026.
  'sports',
  // Added 31 Jul: the SINGULAR form 'Sport' — confirmed live on
  // mutua-madrid-open, monza-f1-gp-sunday, davis-cup (all three genuinely
  // sports, all three stuck in /concert/ because only the PLURAL 'sports'
  // was in this set). Same TM segment-fallback mechanism as 'sports' above,
  // just a singular variant from a different upstream code path. MUST stay
  // in sync with SPORT_RULES in the genreaudit phase, same as 'sports'.
  'sport'
]);

function genreToCategory(genre) {
  const g = (genre || '').toLowerCase().trim();
  if (SPORTS_GENRES.has(g)) return 'sports';
  if (g.includes('football') || g.includes('soccer')) return 'football';
  // Theatre routing covers TM's Arts & Theatre sub-genres. Expanded 25 Jul when
  // the promote-misfiled pass surfaced 228 theatre entities carrying sub-genres
  // (Comedy, Circus, Magic, Podcast, Variety...) that the old 4-keyword test
  // missed — they'd have been genre-set but stranded in concert.
  //
  // DELIBERATELY EXCLUDED — genres that are AMBIGUOUS with music and must stay
  // concert: 'classical' (orchestras are concerts, not theatre) and 'dance'
  // (dance MUSIC / EDM). A few theatre entries with these labels (alfie-boe,
  // dance-valley) will not move — the safe direction. Never add them here.
  if (
    g.includes('theatre') || g.includes('musical') || g.includes('opera') ||
    g.includes('ballet')   || g.includes('comedy')  || g.includes('circus') ||
    g.includes('drama')    ||
    g.includes('magic')    || g.includes('illusion')|| g.includes('cabaret') ||
    g.includes('variety')  || g.includes('performance art') ||
    g.includes('podcast')  || g.includes('documentary') ||
    g.includes('psychics') || g.includes('mediums') || g.includes('hypnotist') ||
    g.includes('specialty') || g === 'family'
  ) return 'theatre';
  return 'concert';
}

// H6 client/backend twin, added here 5 Aug 2026 for the fix-sports-events
// phase below (matching by normalised name against event_pages rows).
// !! MUST MATCH !! the identical copies in ticketmaster.js, sportsevents365.js,
// awin-events.js, awin-category-cache.js and compare.js — see H6 in
// TICKETSCOUT-AUDIT-ROADMAP.md for what each piece of this handles.
function normaliseFixtureName(name) {
  let n = String(name || '');
  const COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (const p of COMPETITION_PREFIXES) {
    const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');
  const stripSuffix = (side) => side
    .replace(/\./g, '')
    .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
    .trim();
  const parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    const sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort((a, b) => a.localeCompare(b));
    n = sides[0] + ' vs ' + sides[1];
  }
  return n.trim();
}

/**
 * Maps a category to the KV key prefix used by the matching /api/[category] handler.
 */
function categoryToKvPrefix(category) {
  if (category === 'football') return 'football:team:';
  if (category === 'theatre')  return 'theatre:show:';
  if (category === 'sports')   return 'sports:team:';
  return 'concert:artist:';
}

/**
 * Maps a category to its HTML generator function.
 */
function categoryToHtmlGenerator(category) {
  if (category === 'football') return generateFootballPageHtml;
  if (category === 'theatre')  return generateTheatrePageHtml;
  if (category === 'sports')   return generateSportsPageHtml;
  return generateArtistPageHtml;
}

// ===========================
// Content / genre helpers
// ===========================

function generateArtistDescription(name, genre) {
  const g = genre.toLowerCase();
  if (g.includes('football') || g.includes('soccer'))
    return `${name} are a professional football club with a passionate global fanbase. Compare ticket prices for upcoming matches across verified sellers on TicketScout.`;
  if (g.includes('theatre') || g.includes('musical'))
    return `${name} is a celebrated production known for its captivating performances and widespread critical acclaim. Compare ticket prices across verified sellers on TicketScout.`;
  if (g.includes('rock') || g.includes('metal'))
    return `${name} are celebrated for their powerful live performances and devoted global fanbase. Their shows consistently sell out major venues and festivals worldwide.`;
  return `${name} are a renowned ${genre} act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.`;
}

function generateVenueDescription(name, city, country) {
  const location = city || country || 'the UK';
  return `${name} is one of ${location}'s premier live event venues. Compare ticket prices from verified sellers for all upcoming events at ${name} on TicketScout.`;
}

function getGenre(event) {
  const sub     = event.classifications?.[0]?.subGenre?.name || '';
  const genre   = event.classifications?.[0]?.genre?.name || '';
  const segment = event.classifications?.[0]?.segment?.name || '';
  if (sub && sub !== 'Undefined')     return sub;
  if (genre && genre !== 'Undefined') return genre;
  return segment || 'Live Music';
}

// MUST MATCH sportsevents365-cache.js SE365_TYPE_MAP. Every entry verified
// against live participant names via ?types=1 on 23 Jul 2026. Note 1006 and
// 1010 were previously swapped ('Ice Hockey' / 'Motorsport'), mislabelling
// ~204 participants; 1023 (909 music acts) was missing entirely and fell
// through to 'Sports'. Unobserved IDs 1007/1008/1009 are NOT carried over.
const SE365_TYPE_MAP = {
  1000: 'Football',           1023: 'Concert',    1002: 'Basketball',
  1035: 'MMA',                1010: 'Ice Hockey', 1020: 'Rugby',
  1012: 'Handball',           1006: 'American Football',
  1005: 'Baseball',           1014: 'Boxing',     1060: 'MMA',
  1001: 'Tennis',             1019: 'Cricket',    1003: 'Motorsport',
  1026: 'MMA',                1028: 'Golf',       1032: 'Wrestling',
  1033: 'Wrestling'
};

// Genres we can give a correctly-categorised page. Now that /sports/ exists,
// the mapped sports genres are queueable too — they route to /sports/{slug}
// rather than being dumped on /concert/. Anything with a null genre (unmapped
// eventTypeId) is still skipped entirely.
const SE365_QUEUEABLE_GENRES = new Set([
  'Football', 'Concert',
  'Basketball', 'MMA', 'Ice Hockey', 'Rugby', 'Handball', 'American Football',
  'Baseball', 'Boxing', 'Tennis', 'Cricket', 'Motorsport', 'Golf', 'Wrestling'
]);

// Returns null for unmapped types — callers MUST treat null as "don't queue".
function se365Genre(eventTypeId) {
  return SE365_TYPE_MAP[eventTypeId] || null;
}

// ===========================
// Event-vs-entity detection
// ===========================
//
// An ENTITY is a performer, team, show or venue — something with many dates.
// An EVENT is one occurrence: "Session 4", "DZIEN 1", "3-Day Pass".
// Discovery has been registering events AS entities, producing pages like
// /concert/erste-letnie-brzmienia-2026-wroclaw-dzien-1 that can never rank
// and can never be a stable comparison target.
//
// PATTERN DISCIPLINE (session 13, s7.6 — read before adding anything):
// A name-based detector scored 10/10 on the section it was tuned against and
// 5 false positives out of 7 on the next one, because GENERIC SINGLE NOUNS ARE
// UNUSABLE — titles are made of them. "Bowling For Soup" is a band.
// So: every pattern here is either a multi-word phrase, or a word bound to a
// NUMBER or to structural punctuation. No bare nouns.
//
// TIER A — structural. Cannot occur in a performer name. Safe to reject.
// TIER B — suggestive but ambiguous. REVIEW ONLY, never auto-reject.
//          e.g. "Sobota" is Polish for Saturday AND the name of a real rapper;
//          "Karnet" means season-pass but could appear in a title.
//
const EVENT_PATTERNS = [
  // ── Tier A ──────────────────────────────────────────────────────────────
  { tier: 'A', label: 'session-number',   re: /\bsessions?\s*(?:#\s*)?\d+\b/i },
  { tier: 'A', label: 'single-session',   re: /\bsingle\s+session\b/i },
  { tier: 'A', label: 'day-pass',         re: /\b\d+\s*[-\u2013]?\s*day\s+(?:pass|ticket)\b/i },
  { tier: 'A', label: 'pl-multiday-pack', re: /\bpakiet\s+\d+\s*[-\u2013]?\s*dniow/i },
  { tier: 'A', label: 'pl-play-prefix',   re: /^\s*spektakl\b\s*[:\u2013-]?/i },
  { tier: 'A', label: 'pl-after-show',    re: /\bpo\s+spektaklu\b/i },
  { tier: 'A', label: 'pl-day-number',    re: /\bdzie[n\u0144]\s*\d+\b/i },
  { tier: 'A', label: 'pl-vip-ticket',    re: /\bbilet\s+vip\b/i },
  { tier: 'A', label: 'final-year',       re: /\bfinals?\s+20\d\d\b/i },
  { tier: 'A', label: 'semis-quarters',   re: /\b(?:semi[-\s]?finals?|quarter[-\s]?finals?)\b/i },
  { tier: 'A', label: 'round-number',     re: /\bround\s+\d+\b/i },
  { tier: 'A', label: 'matchday',         re: /\bmatchday\s*\d+\b/i },
  { tier: 'A', label: 'f1-gp-day',        re: /\bf1\s+gp\b/i },
  // DEMOTED TO TIER B, 24 Jul 2026. Validated clean on 2,983 entities across
  // concert/football/theatre — then produced false positives on the FIRST
  // Ticketmaster run: 'TK Maxx Presents Depot Live at Cardiff Castle' and
  // 'Drag Brunch at Hamburger Mary's'. Both are real recurring events.
  // '<X> at <Venue>' and '<Team> at <Team>' are indistinguishable by shape or
  // capitalisation; separating them needs a venue/team lookup we do not have.
  // The earlier sections were SE365-dominated and simply never produced this
  // name shape — a reminder that 'no false positives' means 'none in the data
  // seen so far'. Do NOT promote back without a venue list.
  { tier: 'B', label: 'away-fixture',     re: /\bat\s+[A-Z\u00c0-\u024f][\w'\u00c0-\u024f]*\s+[A-Z\u00c0-\u024f]/ },

  // ── Tier B — review only ────────────────────────────────────────────────
  { tier: 'B', label: 'pl-season-pass',   re: /\bkarnet\b/i },
  { tier: 'B', label: 'pl-weekday',       re: /\b(?:pi[a\u0105]tek|sobota|niedziela|czwartek)\b/i },
  { tier: 'B', label: 'en-weekday',       re: /\b(?:friday|saturday|sunday|monday)\b/i },
  { tier: 'B', label: 'pl-month',         re: /\b(?:stycze[n\u0144]|luty|marzec|kwiecie[n\u0144]|maj|czerwiec|lipiec|sierpie[n\u0144]|wrzesie[n\u0144]|pa[z\u017a]dziernik|listopad|grudzie[n\u0144])\b/i },
  { tier: 'B', label: 'premiere',         re: /\bpremiera\b/i },
  { tier: 'B', label: 'with-dinner',      re: /\b(?:z\s+kolacj|show\s+z\s+)/i }
];

/**
 * Returns { tier, label } for the FIRST matching pattern, or null.
 * Tier A is always evaluated before Tier B, regardless of array order.
 */
function looksLikeEvent(name) {
  const n = String(name || '');
  if (!n) return null;
  for (const tier of ['A', 'B']) {
    for (const p of EVENT_PATTERNS) {
      if (p.tier === tier && p.re.test(n)) return { tier: p.tier, label: p.label };
    }
  }
  return null;
}

function toSlug(name) {
  return (name || '')
    // Replace with a SPACE, not nothing: stripping the parenthetical along
    // with its surrounding spaces joined the neighbouring words
    // ("Ahavat (Hashem) Gordon" -> "ahavatgordon").
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    // Transliterate diacritics BEFORE stripping: "Bayern München" -> "bayern-munchen"
    // (previously the ü was deleted entirely -> "bayern-mnchen")
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/Ø/g, 'o')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'ae').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    // These have NO canonical NFD decomposition, so the strip below deletes
    // them outright. Polish l-stroke produced 'micha-sotan' from a real name.
    .replace(/ł/g, 'l').replace(/Ł/g, 'l')
    .replace(/ð/g, 'd').replace(/Ð/g, 'd').replace(/þ/g, 'th').replace(/Þ/g, 'th')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'oe').replace(/ı/g, 'i').replace(/ŀ/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

// MUST MATCH sportsevents365-cache.js PLACEHOLDER_PATTERNS. Each pattern
// matches something the live feed actually returned as a "participant".
const PLACEHOLDER_PATTERNS = [
  /^[a-z]\d{1,2}$/i,                                              // A1, B5, C2 bracket slots
  /\bqualifier\b/i,                                               // "African qualifier"
  /\b(?:winner|loser|runner[- ]up)\s+of\b/i,
  /^(?:america|asia|africa|europe|oceania|pacific)[\s\/]+[\w\s\/]*\d{1,2}$/i,
  /\bat\b.+\b(?:19|20)\d{2}$/i,                                  // event titles, not acts
  /-test$/i
];

function isValidName(name) {
  if (!name || name.length < 3) return false;
  const slug = toSlug(name);
  if (/^\d+$/.test(slug)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  if (PLACEHOLDER_PATTERNS.some(re => re.test(String(name).trim()))) return false;
  return true;
}

function isTribute(name) {
  return TRIBUTE_KEYWORDS.some(kw => (name || '').toLowerCase().includes(kw));
}

function esc(str) {
  return (str || '').replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 200);
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// ── Pending-queue merge (dedup + size guard) ─────────────────────────────
// The queue is a SINGLE KV value with a hard 25 MiB ceiling. The previous
// merge appended unconditionally AND refreshed the 8h TTL on every write, so
// the same slugs re-queued on every cron run and the value never expired —
// it grew to ~101,000 records (25.68 MiB) and started failing with
// "KV PUT failed: 413". 3,000 real records is only ~0.8 MiB; the entire
// overflow was duplicates.
//
// Dedup by slug, newest wins. The cap and byte guard are belt-and-braces so
// a future change can never reintroduce an unbounded write.
const QUEUE_MAX_ITEMS = 20000;
const QUEUE_MAX_BYTES = 24 * 1024 * 1024;   // headroom under the 25 MiB limit

function mergePendingQueue(existingItems, newItems, keyField) {
  const key = keyField || 'slug';
  const bySlug = new Map();
  for (const it of (existingItems || [])) {
    if (it && it[key]) bySlug.set(it[key], it);
  }
  for (const it of (newItems || [])) {
    if (it && it[key]) bySlug.set(it[key], it);   // newest wins
  }
  let merged = [...bySlug.values()];
  if (merged.length > QUEUE_MAX_ITEMS) merged = merged.slice(-QUEUE_MAX_ITEMS);
  return merged;
}

// Serialise and, if still oversized, trim from the oldest end until it fits.
// Returns { body, artists, venues, trimmed } so callers can report honestly
// instead of throwing a 413 that hides what happened.
function buildPendingBody(artists, venues, stamp) {
  let a = artists, v = venues, trimmed = 0;
  let body = JSON.stringify({ artists: a, venues: v, updatedAt: stamp });
  while (body.length > QUEUE_MAX_BYTES && a.length > 100) {
    const drop = Math.max(100, Math.floor(a.length * 0.1));
    a = a.slice(drop);
    trimmed += drop;
    body = JSON.stringify({ artists: a, venues: v, updatedAt: stamp });
  }
  return { body, artists: a, venues: v, trimmed };
}