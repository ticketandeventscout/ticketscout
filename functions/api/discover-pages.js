// ===========================
// TicketScout — Automatic page discovery and deployment
// Runs as a Cloudflare Pages Function at /api/discover-pages
//
// Triggered weekly by cron-job.org:
//   https://ticketscout.co.uk/api/discover-pages?trigger=1
//
// Data sources (all inclusive):
//   1. Ticketmaster API    — trending UK events, artist + venue discovery
//   2. Awin category feed  — KV cache (Gigsberg, Theatre Tickets Direct,
//                            Football TicketNet UK, future merchants)
//   3. SportsEvents365     — KV participant cache (3,739 sports teams/athletes)
//   4. Skiddle             — XML feed (festivals, club nights, smaller venues)
//
// For each new artist/venue discovered across ALL sources:
//   - Generates an HTML page file
//   - Commits directly to GitHub via GitHub API
//   - Cloudflare auto-deploys on push — pages live within 60 seconds
//
// Required env vars:
//   TM_API_KEY           — Ticketmaster API key (Secret)
//   GITHUB_TOKEN         — GitHub Personal Access Token with repo scope (Secret)
//   GIGSBERG_KV          — KV namespace (holds Awin feed + SE365 participant cache)
//   SE365_API_KEY        — SE365 API key (Secret) — used once production is live
//   SE365_HTTP_USERNAME  — SE365 HTTP username (Secret)
//   SE365_HTTP_PASSWORD  — SE365 HTTP password (Secret)
//   SE365_PROD           — set to 'true' to use SE365 production API
//   SKIDDLE_AFFILIATE_TAG — Skiddle affiliate tag
//   GITHUB_OWNER         — e.g. ticketandeventscout (plain text)
//   GITHUB_REPO          — e.g. ticketscout (plain text)
//   GITHUB_BRANCH        — e.g. main (plain text)
// ===========================

const KNOWN_ARTISTS_KEY = 'autodiscover:artists:known';
const KNOWN_VENUES_KEY  = 'autodiscover:venues:known';
const AWIN_CACHE_KEY    = 'awin:category:latest';
const SE365_CACHE_KEY   = 'se365:participants:latest';

const TRIBUTE_KEYWORDS = [
  'tribute', 'salute', 'legacy', 'experience', 'revival', 'forever',
  'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs ',
  'greatest hits', 'live band', 'orchestra plays', 'ultimate'
];

// Generic organisation/league names that aren't performers or shows
const GENERIC_NAMES = new Set([
  'nfl', 'nba', 'nhl', 'mlb', 'mls', 'ufc', 'wwe', 'pga', 'nascar',
  'premier league', 'champions league', 'europa league', 'la liga',
  'serie a', 'bundesliga', 'ligue 1', 'formula 1', 'formula one',
  'six nations', 'rugby world cup', 'cricket world cup'
]);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return text('Add ?trigger=1 to run the page discovery job.');
  }

  const dryRun = url.searchParams.get('dry') === '1';

  const apiKey      = env.TM_API_KEY;
  const githubToken = env.GITHUB_TOKEN;
  const kv          = env.GIGSBERG_KV;
  const owner       = env.GITHUB_OWNER  || 'ticketandeventscout';
  const repo        = env.GITHUB_REPO   || 'ticketscout';
  const branch      = env.GITHUB_BRANCH || 'main';

  if (!apiKey)      return json({ error: 'Missing TM_API_KEY' }, 500);
  if (!githubToken) return json({ error: 'Missing GITHUB_TOKEN' }, 500);
  if (!kv)          return json({ error: 'Missing GIGSBERG_KV' }, 500);

  const startTime = Date.now();
  const results = {
    sources:    {},
    newArtists: [],
    newVenues:  [],
    skipped:    [],
    errors:     [],
    dryRun,
    elapsedMs:  0
  };

  try {
    // ── Load known artists and venues from KV ─────────────────────────────
    let knownArtists = new Set();
    let knownVenues  = new Set();
    try { const ka = await kv.get(KNOWN_ARTISTS_KEY); if (ka) knownArtists = new Set(JSON.parse(ka)); } catch {}
    try { const kv2 = await kv.get(KNOWN_VENUES_KEY);  if (kv2) knownVenues  = new Set(JSON.parse(kv2)); } catch {}

    const newArtists = new Map(); // slug → artist data
    const newVenues  = new Map(); // slug → venue data

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 1: Ticketmaster — trending events + recent on-sales
    // Discovers: artists (attractions) + venues
    // ══════════════════════════════════════════════════════════════════════
    try {
      const tmEvents = await fetchTicketmasterEvents(apiKey);
      results.sources.ticketmaster = tmEvents.length;

      for (const event of tmEvents) {
        const segment = event.classifications?.[0]?.segment?.name || '';
        const genre   = getGenre(event);

        // Extract attractions (artists)
        for (const attraction of (event._embedded?.attractions || [])) {
          if (!isValidName(attraction.name)) continue;
          const slug = toSlug(attraction.name);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          if (isTribute(attraction.name)) {
            results.skipped.push({ source: 'TM', type: 'artist', name: attraction.name, reason: 'tribute' });
            continue;
          }
          newArtists.set(slug, {
            slug, name: attraction.name, search: attraction.name,
            genre, description: generateArtistDescription(attraction.name, genre),
            source: 'ticketmaster'
          });
        }

        // Extract venue
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

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 2: Awin category feed (KV cache)
    // Covers: Gigsberg UK, Theatre Tickets Direct, Football TicketNet UK,
    //         and any future approved Awin merchants automatically
    // Discovers: artists (product_name / primary_artist) + venues
    // ══════════════════════════════════════════════════════════════════════
    try {
      const awinIndex = await kv.get(`${AWIN_CACHE_KEY}:index`, { type: 'json' });
      if (awinIndex?.chunks) {
        let awinRowCount = 0;

        for (let i = 0; i < awinIndex.chunks; i++) {
          const chunk = await kv.get(`${AWIN_CACHE_KEY}:chunk:${i}`, { type: 'json' });
          if (!chunk) continue;

          for (const row of chunk) {
            awinRowCount++;
            const artistName = row.primary_artist || row.product_name || '';
            const venueName  = row.venue_name || '';
            const merchantCat = (row.merchant_category || '').toLowerCase();

            // Artist from Awin feed
            if (isValidName(artistName)) {
              const slug = toSlug(artistName);
              if (slug && !knownArtists.has(slug) && !newArtists.has(slug) && !isTribute(artistName)) {
                // Determine genre from merchant category
                const genre = awinGenre(merchantCat, row.category_name);
                newArtists.set(slug, {
                  slug, name: artistName, search: artistName,
                  genre, description: generateArtistDescription(artistName, genre),
                  source: `awin:${row.merchant_name || 'unknown'}`
                });
              }
            }

            // Venue from Awin feed
            if (venueName && venueName.length > 3) {
              const slug = toSlug(venueName);
              if (slug && !knownVenues.has(slug) && !newVenues.has(slug)) {
                const city = row.event_city || '';
                newVenues.set(slug, {
                  slug, name: venueName, city,
                  country: row.event_country || 'GB',
                  venueId: '',
                  description: generateVenueDescription(venueName, city, ''),
                  source: `awin:${row.merchant_name || 'unknown'}`
                });
              }
            }
          }
        }
        results.sources.awin = awinRowCount;
      } else {
        results.sources.awin = 'cache_empty';
      }
    } catch (err) {
      results.errors.push({ source: 'awin', error: String(err) });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 3: SportsEvents365 participant cache (KV)
    // Covers: football teams, F1 drivers, rugby, boxing, cricket, MMA etc.
    // Discovers: sports artists/teams (these become /concert/ pages for now,
    //            future: dedicated /sport/ pages)
    // Note: only active when SE365_PROD=true (production credentials live)
    // ══════════════════════════════════════════════════════════════════════
    try {
      const isProd = env.SE365_PROD === 'true';
      const se365Cache = await kv.get(SE365_CACHE_KEY);

      if (se365Cache && isProd) {
        const participants = JSON.parse(se365Cache);
        const participantList = Object.values(participants);
        results.sources.sportsevents365 = participantList.length;

        for (const p of participantList) {
          if (!p.name || p.name.length < 3) continue;
          const slug = toSlug(p.name);
          if (!slug || knownArtists.has(slug) || newArtists.has(slug)) continue;
          if (isTribute(p.name)) continue;

          // Map SE365 event type to genre
          const genre = se365Genre(p.eventTypeId);
          newArtists.set(slug, {
            slug, name: p.name, search: p.name,
            genre, description: generateArtistDescription(p.name, genre),
            source: 'sportsevents365'
          });
        }
      } else if (!isProd) {
        results.sources.sportsevents365 = 'sandbox_skipped';
      } else {
        results.sources.sportsevents365 = 'cache_empty';
      }
    } catch (err) {
      results.errors.push({ source: 'sportsevents365', error: String(err) });
    }

    // ══════════════════════════════════════════════════════════════════════
    // SOURCE 4: Skiddle — festivals and club night events
    // Covers: UK festivals, smaller venues not on Ticketmaster
    // Discovers: artists + venues from Skiddle's topsellers feed
    // ══════════════════════════════════════════════════════════════════════
    try {
      const skiddleEvents = await fetchSkiddleEvents();
      results.sources.skiddle = skiddleEvents.length;

      for (const event of skiddleEvents) {
        // Artist from Skiddle
        if (isValidName(event.name)) {
          const slug = toSlug(event.name);
          if (slug && !knownArtists.has(slug) && !newArtists.has(slug) && !isTribute(event.name)) {
            newArtists.set(slug, {
              slug, name: event.name, search: event.name,
              genre: 'Live Music',
              description: generateArtistDescription(event.name, 'Live Music'),
              source: 'skiddle'
            });
          }
        }

        // Venue from Skiddle
        if (event.venue && event.venue.length > 3) {
          const slug = toSlug(event.venue);
          if (slug && !knownVenues.has(slug) && !newVenues.has(slug)) {
            newVenues.set(slug, {
              slug, name: event.venue, city: '', country: 'GB',
              venueId: '',
              description: generateVenueDescription(event.venue, '', 'UK'),
              source: 'skiddle'
            });
          }
        }
      }
    } catch (err) {
      results.errors.push({ source: 'skiddle', error: String(err) });
    }

    // ── Summary ────────────────────────────────────────────────────────────
    const artistsToCreate = [...newArtists.values()];
    const venuesToCreate  = [...newVenues.values()];

    console.log(`Discovery complete: ${artistsToCreate.length} new artists, ${venuesToCreate.length} new venues`);

    if (artistsToCreate.length === 0 && venuesToCreate.length === 0) {
      return json({
        ...results,
        message: 'No new pages to create — all discovered artists and venues already exist',
        elapsedMs: Date.now() - startTime
      }, 200);
    }

    if (dryRun) {
      return json({
        ...results,
        newArtists: artistsToCreate.map(a => ({ slug: a.slug, name: a.name, genre: a.genre, source: a.source })),
        newVenues:  venuesToCreate.map(v => ({ slug: v.slug, name: v.name, city: v.city, source: v.source })),
        message: 'Dry run — no files committed. Remove &dry=1 to deploy.',
        elapsedMs: Date.now() - startTime
      }, 200);
    }

    // ── Commit to GitHub ───────────────────────────────────────────────────
    const github = new GitHubAPI(githubToken, owner, repo, branch);

    for (const artist of artistsToCreate) {
      try {
        await github.createFile(
          `concert/${artist.slug}.html`,
          generateArtistPageHtml(artist.slug),
          `Auto-add concert page: ${artist.name} [${artist.source}]`
        );
        results.newArtists.push({ slug: artist.slug, name: artist.name, genre: artist.genre, source: artist.source });
        knownArtists.add(artist.slug);
      } catch (err) {
        results.errors.push({ type: 'artist', slug: artist.slug, error: String(err) });
      }
    }

    for (const venue of venuesToCreate) {
      try {
        await github.createFile(
          `venue/${venue.slug}.html`,
          generateVenuePageHtml(venue.slug),
          `Auto-add venue page: ${venue.name} [${venue.source}]`
        );
        results.newVenues.push({ slug: venue.slug, name: venue.name, city: venue.city, source: venue.source });
        knownVenues.add(venue.slug);
      } catch (err) {
        results.errors.push({ type: 'venue', slug: venue.slug, error: String(err) });
      }
    }

    // Update concert.js with new artist entries
    if (artistsToCreate.length > 0) {
      try {
        await updateArtistDataFile(github, artistsToCreate);
      } catch (err) {
        results.errors.push({ type: 'concert-data-file', error: String(err) });
      }
    }

    // Update venue.js with new venue entries
    if (venuesToCreate.length > 0) {
      try {
        await updateVenueDataFile(github, venuesToCreate);
      } catch (err) {
        results.errors.push({ type: 'venue-data-file', error: String(err) });
      }
    }

    // Save updated known sets to KV
    await kv.put(KNOWN_ARTISTS_KEY, JSON.stringify([...knownArtists]));
    await kv.put(KNOWN_VENUES_KEY,  JSON.stringify([...knownVenues]));

    results.elapsedMs = Date.now() - startTime;
    return json(results, 200);

  } catch (err) {
    console.error('discover-pages error:', err);
    return json({ error: String(err), elapsedMs: Date.now() - startTime }, 500);
  }
}

// ===========================
// Data source fetchers
// ===========================

async function fetchTicketmasterEvents(apiKey) {
  const events = [];
  const seen = new Set();

  for (const sort of ['relevance,desc', 'onSaleStartDate,desc']) {
    const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    tmUrl.searchParams.set('apikey', apiKey);
    tmUrl.searchParams.set('countryCode', 'GB');
    tmUrl.searchParams.set('size', '50');
    tmUrl.searchParams.set('sort', sort);

    try {
      const resp = await fetch(tmUrl.toString());
      const data = await resp.json();
      for (const e of (data?._embedded?.events || [])) {
        if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
      }
    } catch {}
  }

  return events;
}

async function fetchSkiddleEvents() {
  const events = [];
  try {
    const resp = await fetch('http://xml.skiddlecdn.co.uk/xml/affiliates/topsellers.xml');
    if (!resp.ok) return events;
    const xml = await resp.text();
    const blocks = xml.match(/<event[\s\S]*?<\/event>/gi) || [];

    for (const block of blocks.slice(0, 100)) {
      const get = tag => {
        const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : '';
      };
      const name  = get('name') || get('eventname') || get('title');
      const venue = get('venue') || get('venuename');
      if (name) events.push({ name, venue });
    }
  } catch {}
  return events;
}

// ===========================
// GitHub API
// ===========================

class GitHubAPI {
  constructor(token, owner, repo, branch) {
    this.token = token; this.owner = owner;
    this.repo = repo;   this.branch = branch;
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
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`GitHub ${method} ${path} → ${resp.status}: ${err}`);
    }
    return resp.json();
  }

  async getFileSha(path) {
    try {
      const data = await this.request('GET',
        `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`);
      return data.sha;
    } catch { return null; }
  }

  async createFile(path, content, message) {
    const sha  = await this.getFileSha(path);
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: this.branch
    };
    if (sha) body.sha = sha;
    return this.request('PUT', `/repos/${this.owner}/${this.repo}/contents/${path}`, body);
  }
}

// ===========================
// Data file updaters
// ===========================

async function updateArtistDataFile(github, newArtists) {
  const path = 'functions/api/concert.js';
  const current = await github.request('GET',
    `/repos/${github.owner}/${github.repo}/contents/${path}?ref=${github.branch}`);
  const content = decodeURIComponent(escape(atob(current.content)));
  const newEntries = newArtists.map(a =>
    `  { slug: '${a.slug}', name: '${esc(a.name)}', search: '${esc(a.search)}', genre: '${esc(a.genre)}', description: '${esc(a.description)}' },`
  ).join('\n');
  const updated = content.replace(/(\];\s*\nexport default)/, `${newEntries}\n];\nexport default`);
  await github.createFile(path, updated, `Auto-update artists: ${newArtists.map(a => a.name).join(', ')}`);
}

async function updateVenueDataFile(github, newVenues) {
  const path = 'functions/api/venue.js';
  let content = '';
  let isNew = false;
  try {
    const current = await github.request('GET',
      `/repos/${github.owner}/${github.repo}/contents/${path}?ref=${github.branch}`);
    content = decodeURIComponent(escape(atob(current.content)));
  } catch { isNew = true; content = generateBaseVenueJs(); }

  const newEntries = newVenues.map(v =>
    `  { slug: '${v.slug}', name: '${esc(v.name)}', city: '${esc(v.city)}', country: '${esc(v.country)}', venueId: '${v.venueId}', description: '${esc(v.description)}' },`
  ).join('\n');

  const updated = isNew
    ? content.replace('// VENUES_PLACEHOLDER', newEntries)
    : content.replace(/(\];\s*\nexport default)/, `${newEntries}\n];\nexport default`);

  await github.createFile(path, updated, `Auto-update venues: ${newVenues.map(v => v.name).join(', ')}`);
}

// ===========================
// HTML generators
// ===========================

function generateArtistPageHtml(slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loading\u2026</title>
  <script>window.__CONCERT_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body>
  <script>
    async function loadTemplate() {
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
    }
    loadTemplate();
  </script>
</body>
</html>`;
}

function generateVenuePageHtml(slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loading\u2026</title>
  <script>window.__VENUE_SLUG__ = '${slug}';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body>
  <script>
    async function loadTemplate() {
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
    }
    loadTemplate();
  </script>
</body>
</html>`;
}

function generateBaseVenueJs() {
  return `// ===========================
// TicketScout — Venue Data
// Auto-managed by /api/discover-pages
// ===========================

const VENUES = [
// VENUES_PLACEHOLDER
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'slug is required' }, 400);

  const venue = VENUES.find(v => v.slug === slug.toLowerCase());
  if (!venue)  return jsonResponse({ error: 'Venue not found' }, 404);

  const apiKey = env.TM_API_KEY;
  let events = [];

  if (apiKey && venue.venueId) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('venueId', venue.venueId);
      tmUrl.searchParams.set('size', '20');
      tmUrl.searchParams.set('sort', 'date,asc');
      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      events = tmData?._embedded?.events || [];
    } catch (err) { console.error('TM venue events error:', err); }
  }

  return jsonResponse({ venue, events }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
}

export default VENUES;
`;
}

// ===========================
// Content generators
// ===========================

function generateArtistDescription(name, genre) {
  const g = genre.toLowerCase();
  if (g.includes('football') || g.includes('soccer')) {
    return `${name} are a professional football club with a passionate global fanbase. Use TicketScout to compare ticket prices for upcoming ${name} matches across verified sellers.`;
  }
  if (g.includes('rugby')) {
    return `${name} are a professional rugby team known for their competitive performances and loyal supporters. Compare ticket prices for ${name} matches across all verified sellers on TicketScout.`;
  }
  if (g.includes('boxing') || g.includes('mma')) {
    return `${name} is a professional fighter known for exciting bouts and a dedicated global following. Use TicketScout to find and compare tickets for upcoming ${name} events.`;
  }
  if (g.includes('theatre') || g.includes('musical')) {
    return `${name} is a celebrated theatre production known for its captivating performances and widespread critical acclaim. Compare ticket prices across verified sellers on TicketScout.`;
  }
  if (g.includes('rock') || g.includes('metal')) {
    return `${name} are celebrated for their powerful live performances and devoted global fanbase. Their shows consistently sell out major venues and festivals worldwide.`;
  }
  return `${name} are a renowned ${genre} act known for their captivating live performances. Their shows attract fans from around the world and regularly sell out major venues.`;
}

function generateVenueDescription(name, city, country) {
  const location = city || country || 'the UK';
  return `${name} is one of ${location}'s premier live event venues, hosting concerts, sports events, theatre shows and more throughout the year. Compare ticket prices from verified sellers for all upcoming events at ${name} on TicketScout.`;
}

// ===========================
// Genre mappers
// ===========================

function getGenre(event) {
  const sub     = event.classifications?.[0]?.subGenre?.name || '';
  const genre   = event.classifications?.[0]?.genre?.name || '';
  const segment = event.classifications?.[0]?.segment?.name || '';
  if (sub && sub !== 'Undefined')     return sub;
  if (genre && genre !== 'Undefined') return genre;
  return segment || 'Live Music';
}

function awinGenre(merchantCategory, categoryName) {
  const cat = (merchantCategory + ' ' + (categoryName || '')).toLowerCase();
  if (cat.includes('football') || cat.includes('soccer')) return 'Football';
  if (cat.includes('concert') || cat.includes('music'))   return 'Live Music';
  if (cat.includes('theatre') || cat.includes('theater') || cat.includes('musical')) return 'Theatre';
  if (cat.includes('comedy'))  return 'Comedy';
  if (cat.includes('sport'))   return 'Sports';
  return 'Live Events';
}

function se365Genre(eventTypeId) {
  const map = {
    1000: 'Football', 1002: 'Basketball', 1005: 'Baseball',
    1014: 'Boxing',   1019: 'Cricket',    1035: 'MMA',
    1001: 'Tennis',   1006: 'Ice Hockey', 1007: 'American Football',
    1008: 'Rugby',    1009: 'Golf',       1010: 'Motorsport'
  };
  return map[eventTypeId] || 'Sports';
}

// ===========================
// Helpers
// ===========================

function toSlug(name) {
  // Strip bracketed location/edition suffixes e.g. "(NY)", "(London)", "(UK Tour)"
  const cleaned = (name || '').replace(/\s*\([^)]*\)\s*/g, '').trim();
  return cleaned
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
  // Reject pure numeric slugs (e.g. "1536", "2026")
  if (/^\d+$/.test(slug)) return false;
  // Reject generic league/organisation names
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  return true;
}

function isTribute(name) {
  const lower = (name || '').toLowerCase();
  return TRIBUTE_KEYWORDS.some(kw => lower.includes(kw));
}

function esc(str) {
  return (str || '').replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 200);
}

function text(msg) {
  return new Response(msg, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}