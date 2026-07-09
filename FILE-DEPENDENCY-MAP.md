# TicketScout — File Dependency Map
# Last updated: 07 Jul 2026
# Purpose: Before changing any file, check this map to know what else will be affected.

---

## RULE: Read this before editing any file.
If file X appears in the "Impacts" column of another file, you must check
whether your change to X will break that other file.

---

## STATIC HTML TEMPLATES (repo root)

### concert.html
**Role:** Concert artist page template. All /concert/* stubs fetch and inject this at runtime.
**Reads from:**
- `/api/concert?slug=` — artist metadata, attractionId, TM image
- `/api/ticketmaster?attractionId=` — TM events (Promise.all + date filter + load-more)
- `/api/awin-events?name=` — Awin events (Promise.all)
- `/api/vividseats?q=` — Vivid Seats events (Promise.all)
- `/api/football?slug=`, `/api/theatre?slug=`, `/api/concert?slug=` — cross-category search
- `/autocomplete.js` — search dropdown (script tag)
**Impacts:**
- ALL concert/* stubs — they fetch and re-execute this file at runtime
- `functions/concert/[slug].js` — fetches this server-side to inject OG meta
**Critical patterns:**
- MUST use `setEl()` for head element updates (getElementById crashes in stub context)
- MUST use `safeJson()` for all third-party API fetches (TM, Awin, VS)
- Template literal `${}` expressions inside Python-generated strings → double-nesting bug
- Style block uses lazy regex `<style[^>]*>([\s\S]*?)<\/style>`; body uses greedy `<body[^>]*>([\s\S]*)<\/body>`

### football.html
**Role:** Football team page template. All /football/* stubs fetch this.
**Reads from:**
- `/api/football?slug=` — team metadata, attractionId
- `/api/ticketmaster?attractionId=` — TM events
- `/api/awin-events?name=` — Awin events
- `/api/sportsevents365?q=` — SE365 events (currently 401 pending Nir)
- `/api/vividseats?q=` — Vivid Seats events
- `/autocomplete.js`
**Impacts:** ALL football/* stubs, `functions/football/[slug].js` (if it exists — DO NOT CREATE)
**Critical patterns:** Same safeJson/setEl rules. Landing page branch (/football/) hides bio/FAQ/events-heading.

### theatre.html
**Role:** Theatre show page template.
**Reads from:** `/api/theatre?slug=`, `/api/ticketmaster?attractionId=`, `/api/awin-events?name=`, `/api/vividseats?q=`, `/autocomplete.js`
**Impacts:** ALL theatre/* stubs

### venue.html
**Role:** Venue page template.
**Reads from:** `/api/venue?slug=` (returns venue + events), `/api/ticketmaster?venueId=` (load-more), `/api/vividseats?q=`, `/autocomplete.js`
**Impacts:** ALL venue/* stubs (e.g. venue/wembley-stadium.html)

### index.html
**Role:** Homepage. Loads events.js which drives the hash router + category filters.
**Reads from:** `/api/ticketmaster` (via events.js fetchEvents), `/autocomplete.js`, `/compare.js`, `/events.js`
**Impacts:** Homepage behaviour only. Does NOT affect category template pages.
**Critical:** Nav links use `filterCategory()` defined in events.js — only works on homepage.
  From category pages, Comedy → /?cat=comedy, Concerts → /?cat=music (handled by events.js DOMContentLoaded).

---

## JAVASCRIPT FILES (repo root)

### events.js
**Role:** Homepage hash router + category filter + search orchestration.
**Reads from:** `/api/ticketmaster` (fetchEvents), inline CATEGORY_MAP
**Impacts:**
- Homepage (index.html) — all category filtering, search, event display
- Nav links from category pages that use `?cat=` params
**Critical:** CATEGORY_MAP uses object format `{ segment, genreId?, keyword? }`.
  Breaking this breaks ALL homepage category filters simultaneously.

### compare.js
**Role:** Price comparison table on event detail pages (/#/event/...).
**Reads from:**
- `/api/awin-category?q=` — Gigsberg + Theatre Tickets Direct (returns `{matches:[]}`)
- `/api/skiddle` — Skiddle
- `/api/seatgeek` — SeatGeek (broken — params bug in buildUrl, never returns results)
- `/api/sportsevents365` — SE365 (pending credentials)
- `/api/vividseats` — Vivid Seats (reads from vs:catalog KV chunks)
**Impacts:** Event detail page only (loaded via `<script src="/compare.js">` in index.html)
**Critical patterns:**
- `extractPerformerName()` MUST strip TM subtitles before passing to adapters
  ("Metallica: Life Burns Faster" → "Metallica", "Arsenal vs Chelsea" → kept as-is)
- Currency symbol: $ for USD sources (Vivid Seats), £ for GBP sources (Gigsberg, Skiddle)
- Each adapter: `buildUrl(performerName, venueCity, eventDate, venueName)` + `normalise(data, performerName)`
- DO NOT use `/api/awin-events` or `/api/gigsberg` — use `/api/awin-category` for Gigsberg
- `awin-category` returns `{matches:[]}`, `awin-events` returns `{events:[]}` — different shapes!
- Logos use favicon URLs with abbr badge fallback via onerror handler

### THREE Awin endpoints — critical distinction
| Endpoint | Cache key | Returns | Used by |
|---|---|---|---|
| `/api/awin-events` | `awin:category:latest` | `{events:[]}` | Event list pages (concert/football/theatre) |
| `/api/awin-category` | `awin:category:latest` | `{matches:[]}` | compare.js |
| `/api/gigsberg` | `gigsberg:feed:latest` | `{match:null}` | SEPARATE — not used in compare |

Same KV cache, different response formats. Never swap these endpoints.

### autocomplete.js
**Role:** Search dropdown — shared across ALL pages.
**Reads from:** `/api/concert?slug=` (pre-check), `/api/ticketmaster` (attraction search + images)
**Impacts:** Search box on ALL pages (concert, football, theatre, venue, index)
**Critical:** Uses IIFE pattern — DOMContentLoaded never fires on stub-re-executed scripts.
  Never convert to DOMContentLoaded wrapper.

---

## CLOUDFLARE PAGES FUNCTIONS (functions/api/)

### concert.js → /api/concert
**Reads from:** KV (concert:artist:slug), Awin feed (via awin-events.js indirectly), TM attraction API
**Impacts:** concert.html (primary artist data source), functions/concert/[slug].js (OG meta)
**Critical:** Was once overwritten with discover-pages.js content. Always verify with `head -3`.
  Synthesises ALL slugs now — single-word slugs no longer 404.

### football.js → /api/football
**Reads from:** KV (football:team:slug), TM attraction API
**Impacts:** football.html

### theatre.js → /api/theatre
**Reads from:** KV, TM
**Impacts:** theatre.html

### venue.js → /api/venue
**Reads from:** TM venueId lookup (events.json), venue KV data
**Impacts:** venue.html
**Returns:** { venue, events, totalElements } — totalElements drives load-more button visibility

### ticketmaster.js → /api/ticketmaster
**Role:** Proxy to TM Discovery API. Passes through: attractionId, venueId, segmentName, genreId, keyword, size, page, sort, startDateTime, endDateTime, countryCode (omitted for venueId requests).
**Impacts:** concert.html, football.html, theatre.html, venue.html, events.js (homepage), compare.js (via other adapters)
**Critical:** venueId removes countryCode filter. Any new param must be explicitly forwarded.

### awin-events.js → /api/awin-events
**Role:** Searches Awin KV feed cache by event name.
**Reads from:** KV (awin:events:*) populated by awin-category-cache.js
**Impacts:** concert.html, football.html, theatre.html (all use ?name= param)
**Debug params:** ?merchants=1, ?dates=1, ?scan=, ?chunk=N, ?debug=1 — KEEP until significant traffic

### awin-category-cache.js → /api/awin-category-cache
**Role:** Downloads and caches Awin event feed in KV. Runs on cron.
**Impacts:** awin-events.js (its data source). Also triggers auto-discovery of new pages.
**Cron:** Weekly (Mon 00:00 UTC)

### sportsevents365.js → /api/sportsevents365
**Role:** SE365 event lookup by team/artist name.
**Reads from:** KV participant cache (vs:se365:participant:*) built by sportsevents365-cache.js
**Impacts:** football.html (3rd source in Promise.all)
**Status:** HTTP 401 — awaiting Nir credentials

### sportsevents365-cache.js → /api/sportsevents365-cache
**Role:** Builds SE365 participant name→ID KV lookup.
**Cron:** Mon 00:15 UTC (prod only, SE365_PROD=true)

### vividseats.js → /api/vividseats
**Role:** Searches Vivid Seats KV cache by event/artist name.
**Reads from:** KV key `vs:catalog:index` built by vividseats-cache.js
**Impacts:** concert.html, football.html, theatre.html, venue.html, compare.js
**Returns:** { match: { name, url, price, currency, date, venue, city } } or { match: null }
**Note:** Prices in USD. Impact live catalog API ignores search params — KV cache is required.

### vividseats-cache.js → /api/vividseats-cache
**Role:** Downloads Vivid Seats bulk CSV from Impact FTP, parses, stores KV index.
**Reads from:** https://api.impact.com/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz (auth: IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN)
**Impacts:** vividseats.js (its only data source)
**Cron:** Mon 00:20 UTC — ADD THIS to cron-job.org

### vividseats-debug.js → /api/vividseats-debug
**Role:** Debug endpoint. Steps: catalogs, items, rawsearch, ads, links.
**REMOVE before significant traffic.**

### discover-pages.js → /api/discover-pages
**Role:** Auto-discovery pipeline. Fetches events from TM/SE365/Vivid Seats, generates stub pages.
**Sources:** ?source=ticketmaster, ?source=se365, ?source=vividseats, ?phase=commit, ?phase=backfill
**Impacts:**
- Generates concert/* and venue/* stub HTML files (committed to GitHub)
- Stub generator functions include style-copy step (added session 2)
- Stub fetch URLs use ?v=20260707c cache-bust param
**Cron schedule:**
- Mon 00:00 — source=ticketmaster
- Mon 00:10 — phase=commit
- Mon 00:15 — source=se365 (prod only)
- Mon 00:20 — source=vividseats (NEW — add to cron-job.org)

### gigsberg-cache.js → (no direct API route)
**Role:** Caches Gigsberg event data in KV. Piggybacked onto weekly awin cache refresh.
**Impacts:** gigsberg.js (search adapter)

---

## FUNCTIONS ROUTERS

### functions/concert/[slug].js
**Role:** Server-side router for /concert/* URLs. Fetches concert.html, injects OG meta + slug.
**Reads from:** concert.html (server-side fetch), hardcoded ARTISTS array for OG meta
**Impacts:** ALL /concert/* page loads — this is what Cloudflare serves first
**Critical:** Has its own ARTISTS array separate from functions/api/concert.js — OG meta for new artists
  will show generic text until this array is updated.
  Cache-Control: public, max-age=300 — Cloudflare caches the rendered HTML for 5 minutes.

### functions/venue/[slug].js
**Role:** Server-side router for /venue/* URLs.
**Reads from:** venue.html (server-side fetch)
**Impacts:** ALL /venue/* page loads

---

## STUB FILES (generated by discover-pages.js)

### concert/[slug].html (e.g. concert/metallica.html)
**Role:** Lightweight stub. Sets window.__CONCERT_SLUG__, fetches concert.html at runtime.
**Reads from:** /concert.html?v=20260707c
**Critical:** Must include style-copy step. If stale cache persists, bump ?v= param.
  Generated by discover-pages.js → generateArtistPageHtml()

### venue/[slug].html (e.g. venue/wembley-stadium.html)
**Role:** Same as concert stubs but for venues.
**Reads from:** /venue.html?v=20260707c
**Generated by:** discover-pages.js → generateVenuePageHtml()

### football/[slug].html and theatre/[slug].html
**Role:** Same stub pattern but use FULL-EMBED pattern (complete HTML with slug in head).
**DO NOT use stub pattern** for football/theatre — they use a different architecture.

---

## ENVIRONMENT VARIABLES (Cloudflare Pages → Settings → Variables)

| Variable | Used by | Purpose |
|---|---|---|
| TM_API_KEY | ticketmaster.js | Ticketmaster Discovery API |
| AWIN_API_KEY | awin-category-cache.js, awin-events.js | Awin feed access |
| GIGSBERG_KV | Most functions | KV namespace binding |
| SE365_HTTP_SOURCE | sportsevents365.js, sportsevents365-cache.js | SE365 "Source" header |
| SE365_PROD | sportsevents365-cache.js | Enable SE365 in production |
| GITHUB_TOKEN | discover-pages.js | Commit pages to GitHub |
| GITHUB_REPO | discover-pages.js | Repo name |
| GITHUB_OWNER | discover-pages.js | GitHub username |
| IMPACT_ACCOUNT_SID | vividseats.js, vividseats-cache.js | Impact/Vivid Seats auth |
| IMPACT_AUTH_TOKEN | vividseats.js, vividseats-cache.js | Impact/Vivid Seats auth |

---

## INTEGRATION CHECKLIST — Adding a new affiliate/data source

Follow this for EVERY new integration:

### Step 1 — Create the API adapter (functions/api/[source].js)
- Returns: `{ match: { name, url, price, currency, date, venue } }` or `{ match: null }`
- Use `safeJson()` pattern for all external fetches
- Handle null gracefully throughout

### Step 2 — Add to all four category templates
Files: `concert.html`, `football.html`, `theatre.html`, `venue.html`
For each:
- Add fetch to `Promise.all` (concert/theatre: 2-way → 3-way; football: 3-way → 4-way)
- Update destructuring: `const [tmData, awinData, vsData, newData] = await Promise.all([...])`
- Add event normalisation block after Promise.all
- Add `_new: true` flag to normalised events
- Add `|| e._new` to `buildEventRow()` condition
- **Watch for Python-generated template literals** — `${entityName}` must not become `${${entityName}}`

### Step 3 — Add to compare.js
- Add adapter object with `source`, `buildUrl(eventName, venueCity, eventDate, venueName)`, `normalise(data, eventName)`
- Place before `// ── Future adapters go here` comment
- Set correct currency symbol ($ vs £)

### Step 4 — Add to discover-pages.js (if source has its own event catalog)
- Add `if (source === 'newsource')` block
- Queue new artists/venues via `newArtists.set(slug, {...})`
- Add to cron-job.org schedule

### Step 5 — Add env vars to Cloudflare Pages
- Settings → Variables and secrets
- Add to the env vars table in this file

### Step 6 — Deploy order
1. New `functions/api/[source].js` first
2. Updated `concert.html`, `football.html`, `theatre.html`, `venue.html`
3. Updated `compare.js`
4. Updated `discover-pages.js`
5. Verify with debug endpoint or browser console

### Step 7 — Test checklist
- `/api/[source]?q=Metallica` → returns match with url
- `/concert/metallica` → new source card appears in event list
- `/football/arsenal` → same
- `/theatre/phantom-of-the-opera` → same
- Event detail page (/#/event/...) → new source row in comparison table
- Console — no SyntaxErrors, no uncaught exceptions
- Impact/affiliate dashboard → click tracked within 10 mins

---

## COMMON BUG PATTERNS

| Symptom | Likely cause | Where to look |
|---|---|---|
| Compare table shows 0 sellers | Awin cache expired (7hr TTL was too short, now 8 days) | Run /api/awin-category-cache?trigger=1 |
| Gigsberg returns null in compare | Wrong endpoint — must use /api/awin-category not /api/awin-events | compare.js buildUrl |
| TM returns 0 events for artist | countryCode=GB filter excludes non-UK tours | ticketmaster.js — remove countryCode for attractionId searches |
| VS shows wrong event | KV cache match scored wrong date | /api/vividseats?q=X&date=YYYY-MM-DD to test |
|---|---|---|
| "Loading..." never resolves | SyntaxError in template | Browser console, check for `${${}}`  |
| API returns HTML instead of JSON | Wrong function handling route | Add `resp.clone().text()` log, check file content with `head -3` |
| Styles missing on category page | Style-copy step missing in stub | stub file, generateArtistPageHtml() |
| New affiliate not showing | safeJson returns null silently | Add console.log after Promise.all, check API response |
| VS search returns null | KV cache empty | Run /api/vividseats-cache?trigger=1 |
| SE365 returns 401 | Bad credentials | Chase Nir, check SE365_HTTP_SOURCE header |
| Comedy shows theatre events | CATEGORY_MAP genreId wrong | events.js CATEGORY_MAP |
| Concerts nav goes to /concert/ | Old href="/concerts" | Check nav-links in template, should be /?cat=music |
| Page template cached stale | Browser cached /concert.html | _headers file, bump ?v= param in stubs |
| compare.js shows no rows | API returning null | Check buildUrl returns valid /api/... path |
