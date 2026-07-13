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
  if (phase === 'register-known') {
  const SITEMAP_CONCERT = [
    'adele',
    'all-points-east',
    'allegra',
    'arctic-monkeys',
    'ariana-grande',
    'bad-bunny',
    'beyonce',
    'biffy-clyro',
    'billie-eilish',
    'blink-182',
    'bloc-party',
    'blur',
    'bruno-mars',
    'coldplay',
    'doja-cat',
    'dua-lipa',
    'ed-sheeran',
    'elton-john',
    'foo-fighters',
    'gojira',
    'green-day',
    'harry-styles',
    'interpol',
    'iron-maiden',
    'judas-priest',
    'kaiser-chiefs',
    'keane',
    'knocked-loose',
    'lewis-capaldi',
    'linkin-park',
    'manic-street-preachers',
    'metallica',
    'my-chemical-romance',
    'now-you-see-me-live',
    'oasis',
    'pantera',
    'placebo',
    'pulp',
    'radiohead',
    'rammstein',
    'red-hot-chili-peppers',
    'sam-smith',
    'slipknot',
    'snow-patrol',
    'stereophonics',
    'suede',
    'sum-41',
    'system-of-a-down',
    'tame-impala',
    'taylor-swift',
    'the-1975',
    'the-fratellis',
    'the-killers',
    'the-rolling-stones',
    'the-strokes',
    'the-weeknd',
    'travis',
    'two-door-cinema-club',
    'wolf-alice'
  ];
  const SITEMAP_FOOTBALL = [
    'arsenal',
    'chelsea',
    'liverpool',
    'manchester-united',
    'manchester-city',
    'tottenham',
    'newcastle',
    'aston-villa',
    'west-ham',
    'brighton',
    'everton',
    'fulham',
    'brentford',
    'crystal-palace',
    'nottingham-forest',
    'leicester-city',
    'southampton',
    'ipswich',
    'wolverhampton',
    'bournemouth',
    'leeds-united',
    'celtic',
    'rangers',
    'sheffield-united',
    'sheffield-wednesday',
    'sunderland',
    'middlesbrough',
    'hearts',
    'hibernian',
    'burnley',
    'watford',
    'blackburn-rovers',
    'cardiff-city',
    'coventry-city',
    'derby-county',
    'hull-city',
    'luton-town',
    'millwall',
    'norwich-city',
    'queens-park-rangers',
    'swansea-city',
    'stoke-city',
    'aberdeen',
    'motherwell',
    'dundee-united',
    'arsenal-women',
    'chelsea-women',
    'liverpool-women',
    'manchester-united-women',
    'fc-barcelona',
    'real-madrid',
    'atletico-madrid',
    'sevilla',
    'real-sociedad',
    'villarreal',
    'athletic-bilbao',
    'real-betis',
    'valencia',
    'getafe',
    'osasuna',
    'rayo-vallecano',
    'celta-vigo',
    'espanyol',
    'mallorca',
    'girona',
    'alaves',
    'leganes',
    'las-palmas',
    'real-valladolid',
    'bayern-munich',
    'borussia-dortmund',
    'bayer-leverkusen',
    'rb-leipzig',
    'eintracht-frankfurt',
    'vfb-stuttgart',
    'sc-freiburg',
    'borussia-monchengladbach',
    'werder-bremen',
    'hoffenheim',
    'fc-augsburg',
    'vfl-wolfsburg',
    'fsv-mainz-05',
    'union-berlin',
    'hamburger-sv',
    'schalke-04',
    'juventus',
    'ac-milan',
    'inter-milan',
    'napoli',
    'as-roma',
    'lazio',
    'atalanta',
    'fiorentina',
    'torino',
    'bologna',
    'udinese',
    'hellas-verona',
    'cagliari',
    'parma',
    'paris-saint-germain',
    'olympique-marseille',
    'olympique-lyonnais',
    'monaco',
    'nice',
    'stade-rennais',
    'rc-lens',
    'stade-brestois',
    'lille-osc',
    'rc-strasbourg',
    'ajax',
    'psv-eindhoven',
    'feyenoord',
    'az-alkmaar',
    'porto',
    'benfica',
    'sporting-cp',
    'braga'
  ];
  const SITEMAP_THEATRE = [
    'a-little-night-music',
    'a-midsummer-nights-dream',
    'allegra',
    'avenue-q',
    'back-to-the-future',
    'be-like-blippi',
    'beautiful-carole-king-musical',
    'beetlejuice-the-musical',
    'berlin',
    'big-bad-wolf',
    'bill-bailey-vaudevillean',
    'billy-elliot-the-musical',
    'black-is-the-color-of-my-voice',
    'blood-brothers',
    'cabaret',
    'cat',
    'charlie-and-the-chocolate-factory',
    'chicago',
    'come-from-away',
    'company',
    'dirty-dancing',
    'disney-aladdin',
    'frozen-the-musical',
    'grease',
    'guys-and-dolls',
    'hadestown',
    'hamilton',
    'hamlet-globe',
    'harry-potter-cursed-child',
    'into-the-woods',
    'jersey-boys',
    'joseph-amazing-technicolor-dreamcoat',
    'les-miserables',
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
  const SITEMAP_VENUE = [
    'adelphi-theatre',
    'lyceum-theatre',
    'palace-theatre',
    'palace-theatre-london',
    'savoy-theatre',
    'shaftesbury-theatre',
    'victoria-palace-theatre',
    'barbican-centre',
    'royal-albert-hall',
    'royal-festival-hall',
    'wembley-stadium',
    'emirates-stadium',
    'stamford-bridge',
    'london-stadium',
    'tottenham-hotspur-stadium',
    'anfield',
    'old-trafford',
    'etihad-stadium',
    'st-james-park',
    'villa-park',
    'amex-stadium',
    'co-op-live-manchester',
    'first-direct-arena-leeds',
    'ovo-hydro-glasgow',
    'cardiff-arena',
    'sse-arena-belfast',
    'resorts-world-arena-birmingham',
    'motorpoint-arena-nottingham',
    'utilita-arena-birmingham',
    'glastonbury-festival',
    'reading-festival',
    'leeds-festival',
    'download-festival',
    'latitude-festival',
    'boomtown-fair',
    'o2-arena',
    'camp-nou',
    'santiago-bernabeu',
    'estadio-metropolitano',
    'allianz-arena',
    'signal-iduna-park',
    'san-siro',
    'juventus-stadium',
    'parc-des-princes',
    'stade-de-france',
    'johan-cruyff-arena',
    'estadio-do-dragao',
    'madison-square-garden',
    'sphere-las-vegas'
  ];

    let knownArtists = new Set();
    let knownVenues  = new Set();
    try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
    try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

    let created = 0, skipped = 0, errors = 0;

    // Register concert slugs
    for (const slug of SITEMAP_CONCERT) {
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
    for (const slug of SITEMAP_THEATRE) {
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
    for (const slug of SITEMAP_FOOTBALL) {
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
    for (const slug of SITEMAP_VENUE) {
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
      totalRegistered: SITEMAP_CONCERT.length + SITEMAP_THEATRE.length +
                       SITEMAP_FOOTBALL.length + SITEMAP_VENUE.length,
      breakdown: {
        concert:  SITEMAP_CONCERT.length,
        theatre:  SITEMAP_THEATRE.length,
        football: SITEMAP_FOOTBALL.length,
        venue:    SITEMAP_VENUE.length
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

  await kv.put(PENDING_KEY, JSON.stringify({
    artists:   [...existing.artists, ...artistList],
    venues:    [...existing.venues,  ...venueList],
    updatedAt: new Date().toISOString()
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

async function commitPendingPagesBatch(kv, githubToken, owner, repo, branch, dryRun, env) {
  const pendingRaw = await kv.get(PENDING_KEY);
  if (!pendingRaw) return json({ message: 'No pending pages to commit.', committed: 0 }, 200);

  const pending = JSON.parse(pendingRaw);
  let artists = pending.artists || [];
  let venues  = pending.venues  || [];
  if (artists.length === 0 && venues.length === 0) {
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
      files.push({ path: `${category}/${artist.slug}.html`, content: htmlGenerator(artist.slug) });
      committed[category].push(artist.slug);
    }
  }
  for (const venue of venues) {
    files.push({ path: `venue/${venue.slug}.html`, content: generateVenuePageHtml(venue.slug) });
    committed.venues.push(venue.slug);
  }

  // ── Updated data files (read current content, splice, include in tree) ─
  for (const [category, items] of Object.entries(byCategory)) {
    if (items.length === 0) continue;
    try {
      const dataFile = await computeCategoryDataFileUpdate(github, category, items);
      if (dataFile) files.push(dataFile);
    } catch (err) {
      committed.errors.push({ type: `${category}-data`, error: String(err) });
    }
  }
  if (venues.length > 0) {
    try {
      const venueFile = await computeVenueDataFileUpdate(github, venues);
      if (venueFile) files.push(venueFile);
    } catch (err) {
      committed.errors.push({ type: 'venue-data', error: String(err) });
    }
  }

  // ── ONE commit for everything ────────────────────────────────────────
  const names = [...artists.map(a => a.name), ...venues.map(v => v.name)];
  const message = `Auto-add ${files.length} files: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8} more` : ''}`;
  let commitSha = null;
  try {
    commitSha = await github.commitFilesBatch(files, message);
  } catch (err) {
    // Whole batch failed — leave the queue intact for retry, report the error
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

  return json({
    committed, commitSha, filesInCommit: files.length,
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
          htmlGenerator(artist.slug),
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
    u.searchParams.set('countryCode', 'GB');
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

function generateArtistPageHtml(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Tickets | Compare Prices | TicketScout</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="Compare ${displayName} ticket prices across verified sellers. Find the cheapest ${displayName} tickets and buy direct. Updated daily." />
  <meta property="og:title" content="${displayName} Tickets | TicketScout" />
  <meta property="og:description" content="Compare ${displayName} ticket prices across verified sellers. Find the best deal." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/concert/${slug}" />
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
      const r = await fetch('/concert.html?v=20260712a');
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

function generateFootballPageHtml(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Tickets | Compare Prices | TicketScout</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="Compare ${displayName} ticket prices across verified sellers. Find the cheapest ${displayName} tickets and buy direct. Updated daily." />
  <meta property="og:title" content="${displayName} Tickets | TicketScout" />
  <meta property="og:description" content="Compare ${displayName} ticket prices across verified sellers. Find the best deal." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/football/${slug}" />
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
      const r = await fetch('/football.html?v=20260712d');
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

function generateTheatrePageHtml(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Tickets | Compare Prices | TicketScout</title>
  <meta name="robots" content="index, follow" />
  
  <meta name="description" content="Compare ${displayName} ticket prices across verified sellers. Find the cheapest ${displayName} tickets and buy direct. Updated daily." />
  <meta property="og:title" content="${displayName} Tickets | TicketScout" />
  <meta property="og:description" content="Compare ${displayName} ticket prices across verified sellers. Find the best deal." />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://ticketscout.co.uk/theatre/${slug}" />
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
      const r = await fetch('/theatre.html?v=20260712a');
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