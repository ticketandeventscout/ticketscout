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
// Cron schedule (cron-job.org):
//   Mon 00:00 — ?trigger=1&source=ticketmaster
//   Mon 00:10 — ?trigger=1&phase=commit          (after TM discovery + Awin cache writes)
//   Mon 00:15 — ?trigger=1&source=se365          (prod only — no-op until SE365_PROD=true)
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
      '  ?trigger=1&phase=commit         — commit queued pages to GitHub',
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
    return await commitPendingPages(kv, githubToken, owner, repo, branch, dryRun, env);
  }

  // ── BACKFILL PHASE — write KV data for already-committed pages ───────────
  // Run once after deploying this fix to populate KV for existing pages
  // Usage: ?trigger=1&phase=backfill
  if (phase === 'backfill') {
    const pendingRaw = await kv.get(PENDING_KEY);
    let artists = [];
    if (pendingRaw) {
      const pending = JSON.parse(pendingRaw);
      artists = pending.artists || [];
    }

    if (artists.length === 0) {
      return json({ message: 'No pending artists to backfill KV data for.', written: 0 }, 200);
    }

    let written = 0;
    for (const artist of artists) {
      try {
        await kv.put(`concert:artist:${artist.slug}`, JSON.stringify({
          slug:        artist.slug,
          name:        artist.name,
          search:      artist.search || artist.name,
          genre:       artist.genre || 'Live Events',
          description: artist.description || `Compare ${artist.name} ticket prices across verified sellers.`
        }), { expirationTtl: 30 * 24 * 60 * 60 });
        written++;
      } catch {}
    }

    return json({ message: `Backfilled KV data for ${written} artists.`, written }, 200);
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
      const events = await fetchTicketmasterEvents(apiKey);
      results.eventsScanned = events.length;

      for (const event of events) {
        const genre = getGenre(event);

        for (const attraction of (event._embedded?.attractions || [])) {
          if (!isValidName(attraction.name) || isTribute(attraction.name)) continue;
          const slug = toSlug(attraction.name);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          newArtists.set(slug, {
            slug, name: attraction.name, search: attraction.name,
            genre, description: generateArtistDescription(attraction.name, genre),
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
          const genre = se365Genre(p.eventTypeId);
          newArtists.set(slug, {
            slug, name: p.name, search: p.name,
            genre, description: generateArtistDescription(p.name, genre),
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

  const artistList = [...newArtists.values()];
  const venueList  = [...newVenues.values()];

  if (dryRun) {
    return json({
      ...results,
      dryRun: true,
      newArtists: artistList.map(a => ({ slug: a.slug, name: a.name, genre: a.genre })),
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
// Clears the queue and updates the known sets after committing
// ===========================

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
        artists: artists.map(a => ({ slug: a.slug, name: a.name })),
        venues:  venues.map(v => ({ slug: v.slug, name: v.name }))
      },
      message: 'Dry run — nothing committed. Remove &dry=1 to deploy.'
    }, 200);
  }

  const github    = new GitHubAPI(githubToken, owner, repo, branch);
  const committed = { artists: [], venues: [], errors: [] };

  // Load known sets to update after committing
  let knownArtists = new Set();
  let knownVenues  = new Set();
  try { const k = await kv.get(KNOWN_KEY);        if (k) knownArtists = new Set(JSON.parse(k)); } catch {}
  try { const k = await kv.get(KNOWN_VENUES_KEY); if (k) knownVenues  = new Set(JSON.parse(k)); } catch {}

  for (const artist of artists) {
    try {
      await github.createFile(
        `concert/${artist.slug}.html`,
        generateArtistPageHtml(artist.slug),
        `Auto-add concert page: ${artist.name} [${artist.source}]`
      );
      committed.artists.push(artist.slug);
      knownArtists.add(artist.slug);

      // Store artist data in KV so /api/concert can serve it
      await kv.put(`concert:artist:${artist.slug}`, JSON.stringify({
        slug:        artist.slug,
        name:        artist.name,
        search:      artist.search || artist.name,
        genre:       artist.genre || 'Live Events',
        description: artist.description || `Compare ${artist.name} ticket prices across verified sellers.`
      }), { expirationTtl: 30 * 24 * 60 * 60 }); // 30 days

    } catch (err) {
      committed.errors.push({ type: 'artist', slug: artist.slug, error: String(err) });
    }
  }

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

  // Update concert.js and venue.js data files
  if (artists.length > 0) {
    try { await updateArtistDataFile(github, artists); } catch (err) {
      committed.errors.push({ type: 'concert-data', error: String(err) });
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
// Ticketmaster fetcher
// ===========================

async function fetchTicketmasterEvents(apiKey) {
  const events = [];
  const seen   = new Set();
  for (const sort of ['relevance,desc', 'onSaleStartDate,desc']) {
    const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    u.searchParams.set('apikey', apiKey);
    u.searchParams.set('countryCode', 'GB');
    u.searchParams.set('size', '50');
    u.searchParams.set('sort', sort);
    try {
      const resp = await fetch(u.toString());
      const data = await resp.json();
      for (const e of (data?._embedded?.events || [])) {
        if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
      }
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
}

// ===========================
// Data file updaters
// ===========================

async function updateArtistDataFile(github, artists) {
  const path    = 'functions/api/concert.js';
  const current = await github.request('GET', `/repos/${github.owner}/${github.repo}/contents/${path}?ref=${github.branch}`);
  const content = decodeURIComponent(escape(atob(current.content)));
  const entries = artists.map(a =>
    `  { slug: '${a.slug}', name: '${esc(a.name)}', search: '${esc(a.search)}', genre: '${esc(a.genre)}', description: '${esc(a.description)}' },`
  ).join('\n');
  const updated = content.replace(/(\];\s*\nexport default)/, `${entries}\n];\nexport default`);
  await github.createFile(path, updated, `Auto-update artists: ${artists.map(a => a.name).join(', ')}`);
}

async function updateVenueDataFile(github, venues) {
  const path = 'functions/api/venue.js';
  let content = '';
  let isNew   = false;
  try {
    const current = await github.request('GET', `/repos/${github.owner}/${github.repo}/contents/${path}?ref=${github.branch}`);
    content = decodeURIComponent(escape(atob(current.content)));
  } catch { isNew = true; content = generateBaseVenueJs(); }

  const entries = venues.map(v =>
    `  { slug: '${v.slug}', name: '${esc(v.name)}', city: '${esc(v.city)}', country: '${esc(v.country)}', venueId: '${v.venueId}', description: '${esc(v.description)}' },`
  ).join('\n');

  const updated = isNew
    ? content.replace('// VENUES_PLACEHOLDER', entries)
    : content.replace(/(\];\s*\nexport default)/, `${entries}\n];\nexport default`);

  await github.createFile(path, updated, `Auto-update venues: ${venues.map(v => v.name).join(', ')}`);
}

// ===========================
// HTML generators
// ===========================

function generateArtistPageHtml(slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loading\u2026</title>
  <script>window.__CONCERT_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body><script>
  (async function() {
    const r = await fetch('/concert.html');
    const html = await r.text();
    const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
    if (!m) return;
    document.body.innerHTML = m[1];
    document.body.querySelectorAll('script').forEach(function(o) {
      var s = document.createElement('script');
      if (o.src) s.src = o.src; else s.textContent = o.textContent;
      document.body.appendChild(s); o.remove();
    });
  })();
</script></body></html>`;
}

function generateVenuePageHtml(slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loading\u2026</title>
  <script>window.__VENUE_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body><script>
  (async function() {
    const r = await fetch('/venue.html');
    const html = await r.text();
    const m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
    if (!m) return;
    document.body.innerHTML = m[1];
    document.body.querySelectorAll('script').forEach(function(o) {
      var s = document.createElement('script');
      if (o.src) s.src = o.src; else s.textContent = o.textContent;
      document.body.appendChild(s); o.remove();
    });
  })();
</script></body></html>`;
}

function generateBaseVenueJs() {
  return `// TicketScout — Venue Data (auto-managed)\nconst VENUES = [\n// VENUES_PLACEHOLDER\n];\nexport async function onRequestGet({ request, env }) {\n  const url = new URL(request.url);\n  const slug = url.searchParams.get('slug');\n  if (!slug) return jsonResponse({ error: 'slug required' }, 400);\n  const venue = VENUES.find(v => v.slug === slug.toLowerCase());\n  if (!venue) return jsonResponse({ error: 'Venue not found' }, 404);\n  const apiKey = env.TM_API_KEY;\n  let events = [];\n  if (apiKey && venue.venueId) {\n    try {\n      const u = new URL('https://app.ticketmaster.com/discovery/v2/events.json');\n      u.searchParams.set('apikey', apiKey);\n      u.searchParams.set('venueId', venue.venueId);\n      u.searchParams.set('size', '20');\n      u.searchParams.set('sort', 'date,asc');\n      const resp = await fetch(u.toString());\n      const data = await resp.json();\n      events = data?._embedded?.events || [];\n    } catch {}\n  }\n  return jsonResponse({ venue, events }, 200);\n}\nfunction jsonResponse(body, status) {\n  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });\n}\nexport default VENUES;\n`;
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