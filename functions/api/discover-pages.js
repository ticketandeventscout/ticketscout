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
      '  ?trigger=1&phase=backfill       — write KV data for already-committed pages',
      '  ?trigger=1&phase=build-registry — build sitemap:registry from the GitHub tree (one-time)',
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

    let registry = { updated: null, sections: { concert: {}, football: {}, theatre: {}, venue: {} } };
    try { const r = await kv.get(REGISTRY_KEY); if (r) registry = JSON.parse(r); } catch {}
    for (const cat of ['concert', 'football', 'theatre', 'venue']) {
      if (!registry.sections[cat]) registry.sections[cat] = {};
    }

    const today = new Date().toISOString().slice(0, 10);
    const counts = { concert: 0, football: 0, theatre: 0, venue: 0, skipped: 0 };
    const re = /^(concert|football|theatre|venue)\/([a-z0-9-]+)\.html$/;
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
    if (!['football', 'concert', 'theatre'].includes(category)) {
      return json({ error: 'category is required: football | concert | theatre' }, 400);
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
      const events = await fetchTicketmasterEvents(apiKey, kv);
      results.eventsScanned = events.length;

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
          if (!isValidName(p.name) || isTribute(p.name)) continue;
          const slug = toSlug(p.name);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          const genre    = se365Genre(p.eventTypeId);
          const category = genreToCategory(genre);
          newArtists.set(slug, {
            slug, name: p.name, search: p.name,
            genre, category,
            description: generateArtistDescription(p.name, genre),
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
          const catalogUrl = new URL(`https://api.impact.com/Mediapartners/${accountSid}/Catalogs/Items`);
          catalogUrl.searchParams.set('CampaignId', '12730');
          catalogUrl.searchParams.set('PageSize',   '100');
          catalogUrl.searchParams.set('Page',       String(page));

          const resp = await fetch(catalogUrl.toString(), {
            headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' }
          });

          if (!resp.ok) {
            results.errors.push({ source: 'vividseats', error: `HTTP ${resp.status} on page ${page}` });
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
        // Try to list product feeds for Ticombo campaigns via Partnerize publisher API
        const resp = await fetch(
          `https://api.partnerize.com/user/${publisherId}/campaigns.json?limit=100`,
          { headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' } }
        );
        if (!resp.ok) {
          results.errors.push({ source: 'ticombo', error: `Partnerize API: HTTP ${resp.status}` });
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

  const artistList = [...newArtists.values()];
  const venueList  = [...newVenues.values()];

  if (dryRun) {
    return json({
      ...results,
      dryRun: true,
      newArtists: artistList.map(a => ({ slug: a.slug, name: a.name, genre: a.genre, category: a.category })),
      newVenues:  venueList.map(v => ({ slug: v.slug, name: v.name, city: v.city })),
      message: 'Dry run — nothing written. Remove &dry=1 to queue for commit.'
    }, 200);
  }

  if (artistList.length === 0 && venueList.length === 0) {
    return json({ ...results, message: 'No new pages discovered — all already known.' }, 200);
  }

  // Merge with existing pending queue (may include items from Awin cache refresh)
  let existing = { artists: [], venues: [] };
  try { const ep = await kv.get(PENDING_KEY); if (ep) existing = JSON.parse(ep); } catch {}

  const stamp = new Date().toISOString();
  await kv.put(PENDING_KEY, JSON.stringify({
    artists:   [...existing.artists, ...artistList.map(a => ({ ...a, queuedAt: stamp }))],
    venues:    [...existing.venues,  ...venueList.map(v => ({ ...v, queuedAt: stamp }))],
    updatedAt: stamp
  }), { expirationTtl: 8 * 60 * 60 });

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

  // Cap the batch; keep the remainder queued for the next run
  let remainderArtists = [], remainderVenues = [];
  if (artists.length + venues.length > COMMIT_BATCH_CAP) {
    const artistCap = Math.min(artists.length, COMMIT_BATCH_CAP);
    remainderArtists = artists.slice(artistCap);
    artists = artists.slice(0, artistCap);
    const venueCap = Math.max(0, COMMIT_BATCH_CAP - artists.length);
    remainderVenues = venues.slice(venueCap);
    venues = venues.slice(0, venueCap);
  }

  const github = new GitHubAPI(githubToken, owner, repo, branch);
  const committed = { concert: [], football: [], theatre: [], venues: [], errors: [] };

  let knownArtists = new Set();
  let knownVenues  = new Set();
  try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
  try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

  // Bucket artists by category
  const byCategory = { concert: [], football: [], theatre: [] };
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
  for (const venue of venues) knownVenues.add(venue.slug);

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
    let registry = { updated: null, sections: { concert: {}, football: {}, theatre: {}, venue: {} } };
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
  const byCategory = { concert: [], football: [], theatre: [] };
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

  // Commit venue pages
  for (const venue of venues) {
    try {
      await github.createFile(
        `venue/${venue.slug}.html`,
        generateVenuePageHtml(venue.slug),
        `Auto-add venue page: ${venue.name} [${venue.source}]`
      );
      committed.venues.push(venue.slug);
      knownVenues.add(venue.slug);
    } catch (err) {
      committed.errors.push({ type: 'venue', slug: venue.slug, error: String(err) });
    }
  }

  if (venues.length > 0) {
    try { await updateVenueDataFile(github, venues); } catch (err) {
      committed.errors.push({ type: 'venue-data', error: String(err) });
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

  const updated = isNew
    ? content.replace('// VENUES_PLACEHOLDER', entries)
    : content.replace(/(\];\s*\n\nexport async function)/, `${entries}\n];\n\nexport async function`);

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

const TM_CURSOR_KEY = 'autodiscover:tm:cursor';

async function fetchTicketmasterEvents(apiKey, kv) {
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

  for (const segmentId of segmentIds) {
    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    u.searchParams.set('apikey', apiKey);
    u.searchParams.set('size', '200');
    u.searchParams.set('page', String(page));
    u.searchParams.set('sort', 'onSaleStartDate,desc');
    u.searchParams.set('segmentId', segmentId);
    // No countryCode filter — discover international events too.
    // UK fans buy tickets to events worldwide (European football, US tours etc).
    try {
      const resp = await fetch(u.toString());
      const data = await resp.json();
      for (const e of (data?._embedded?.events || [])) {
        if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
      }
    } catch {}
  }

  // Advance cursor for next run (wraps at MAX_PAGE)
  try {
    await kv.put(TM_CURSOR_KEY, JSON.stringify({ page: (page + 1) % MAX_PAGE, lastRun: new Date().toISOString() }));
  } catch {}

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
    // 3. New tree with all files (content inline — GitHub encodes it)
    const tree = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }))
    });
    // 4. Commit pointing at the new tree
    const commit = await this.request('POST', `/repos/${this.owner}/${this.repo}/git/commits`, {
      message, tree: tree.sha, parents: [headSha]
    });
    // 5. Advance the branch ref
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
const TEMPLATE_VERSION = '20260714a';

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
  } else if (category === 'concert' && facts.origin) {
    fragment = `${facts.genres && facts.genres.length ? ` ${facts.genres[0].replace(/\b\w/g, c => c.toUpperCase())} from ${facts.origin}.` : ` Touring artist from ${facts.origin}.`}`;
  }
  let description = `Compare ${name} ticket prices across verified sellers and find the cheapest ${name} tickets. Updated daily.${fragment}`;
  if (description.length > 158) description = description.slice(0, 155).replace(/\s+\S*$/, '') + '…';

  // JSON-LD @graph — nodes/fields self-omit when facts are missing
  const graph = [];
  const catLabel = { football: 'Football', concert: 'Concerts', theatre: 'Theatre' }[category] || category;
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
function genreToCategory(genre) {
  const g = (genre || '').toLowerCase();
  if (g.includes('football') || g.includes('soccer')) return 'football';
  if (g.includes('theatre') || g.includes('musical') || g.includes('opera') || g.includes('ballet')) return 'theatre';
  // Sports from TM (non-football) → concert for now (we don't have a general sports page yet)
  // Could route to dedicated sport page in future
  return 'concert';
}

/**
 * Maps a category to the KV key prefix used by the matching /api/[category] handler.
 */
function categoryToKvPrefix(category) {
  if (category === 'football') return 'football:team:';
  if (category === 'theatre')  return 'theatre:show:';
  return 'concert:artist:';
}

/**
 * Maps a category to its HTML generator function.
 */
function categoryToHtmlGenerator(category) {
  if (category === 'football') return generateFootballPageHtml;
  if (category === 'theatre')  return generateTheatrePageHtml;
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

function se365Genre(eventTypeId) {
  const map = { 1000: 'Football', 1002: 'Basketball', 1005: 'Baseball', 1014: 'Boxing',
    1019: 'Cricket', 1035: 'MMA', 1001: 'Tennis', 1006: 'Ice Hockey',
    1007: 'American Football', 1008: 'Rugby', 1009: 'Golf', 1010: 'Motorsport' };
  return map[eventTypeId] || 'Sports';
}

function toSlug(name) {
  return (name || '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    // Transliterate diacritics BEFORE stripping: "Bayern München" -> "bayern-munchen"
    // (previously the ü was deleted entirely -> "bayern-mnchen")
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/Ø/g, 'o')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'ae').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function isValidName(name) {
  if (!name || name.length < 3) return false;
  const slug = toSlug(name);
  if (/^\d+$/.test(slug)) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
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