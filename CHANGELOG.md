# TicketScout — Code Change Log

Track every file deployed to production.
To diagnose when a bug was introduced: find the deploy date, check what changed.

Format per entry:
## [DATE] — Session [N]
### Deployed
- `path/to/file` — what changed and why
### Notes / Incidents

---

## 2026-07-07 — Session 1

### Deployed
- `football.html` — Fixed JS syntax error (Python f-string backtick escaping). Clubs grid, landing page JS.
- `concert.html` — Popular artist sidebar via /api/concert. Page indicator added.
- `theatre.html` — Synced with other templates.
- `venue.html` — try/catch around updateMeta/renderEvents.
- `index.html` — Comedy/Concerts/Theatre nav links fixed to call filterCategory().
- `functions/api/awin-events.js` — Scan variable reference error removed.
- `functions/api/sportsevents365.js` — SE365_HTTP_SOURCE sent as "Source" header; SE365_PROD checks both string+boolean.
- `functions/api/sportsevents365-cache.js` — Same SE365 fixes.
- `functions/venue/[slug].js` — New file. Server-side router for venue pages.
- `football/the-phantom-of-the-opera.html` — Redirect stub → theatre.
- `football/grease.html` — Redirect stub.
- `football/oliver.html` — Redirect stub.

---

## 2026-07-07 — Session 2

### Deployed
- `functions/api/concert.js` — Added Oasis + The Killers to ARTISTS. Removed single-word slug 404 restriction — all slugs now synthesise.
- `venue/wembley-stadium.html` — Fixed stub: added style-copy step (was missing → unstyled page).
- `functions/api/discover-pages.js` — Style-copy step added to concert+venue stub generators.

---

## 2026-07-07 — Session 3 (Part 1 — Bug fixes)

### Deployed
- `concert.html` — safeJson() added to all third-party API fetches (TM+Awin Promise.all, date filter, load-more). Version: safeJson-v3.
- `theatre.html` — Same safeJson() fixes. Date filter + pagination already present ✅
- `football.html` — Same safeJson() fixes. Date filter + pagination already present ✅
- `venue.html` — Full rewrite. Date filter, pagination, load-more, safeJson, setEl() added. Matches other templates.
- `functions/api/venue.js` — Fetch size 20→50. Returns totalElements from TM page metadata.
- `functions/api/ticketmaster.js` — Added venueId param support. Removes countryCode filter for venue lookups.
- `functions/api/discover-pages.js` — Cache-bust ?v=20260707c added to concert+venue stub fetch URLs.
- `venue/wembley-stadium.html` — Cache-bust param added to stub fetch URL.
- `_headers` — New file. Cache-Control: no-store on all four template HTML files.
- `concert/index.html` — Fixed stub: style-copy step added (was missing → unstyled /concert/ landing page).
- `events.js` — Added ?cat= URL param handler so nav links auto-trigger category filter on homepage. CATEGORY_MAP refactored to objects.
- `football.html` — Comedy added to nav (/?cat=comedy). Concerts nav → /?cat=music. Bio/FAQ/events-heading hidden on landing page.
- `theatre.html` — Comedy+Concerts nav links fixed.
- `venue.html` — Comedy+Concerts nav links fixed.
- `concert.html` — Comedy+Concerts nav links fixed. "Browse all concerts →" → /?cat=music.

### ⚠️ Incident: functions/api/concert.js corruption
- File contained discover-pages.js content instead of the correct artist handler.
- Symptom: /api/concert returned "TicketScout page discovery — usage:" with HTTP 200.
- Root cause: Batch commit mapped wrong file to wrong destination in a previous session.
- Detection: Added resp.clone().text() diagnostic log — revealed raw API response.
- Fix: Restored correct concert.js content.
- Prevention: Always verify file content (head -3) before and after batch deploys.

---

## 2026-07-07 — Session 3 (Part 2 — Vivid Seats integration)

### Deployed
- `functions/api/vividseats.js` — New. Vivid Seats affiliate adapter. Initially used Impact live catalog API (confirmed non-functional for search), later rewritten to use bulk KV cache.
- `functions/api/vividseats-cache.js` — New. Downloads Impact bulk CSV feed (/Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz), parses, stores KV index.
- `functions/api/vividseats-debug.js` — New. Debug endpoint with steps: catalogs, items, rawsearch, ads, links. REMOVE before significant traffic.
- `compare.js` — Vivid Seats adapter added. Currency symbol uses $ for USD.
- `concert.html` — VS fetch added to Promise.all. vsEvents merged into allEvents. buildEventRow handles _vs flag.
- `football.html` — Same VS integration.
- `theatre.html` — Same VS integration.
- `venue.html` — VS fetch added after main venue load. buildEventRow handles _vs/_awin.
- `functions/api/discover-pages.js` — Vivid Seats discovery source added (?trigger=1&source=vividseats).

### Key findings — Vivid Seats API
- Impact catalog API IGNORES Keywords/SearchQuery params entirely — returns same first page regardless.
- Correct approach: use bulk CSV feed at /Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz (131,523 events).
- Catalog ID: 7904. Campaign ID: 12730. Publisher: 7443544.
- Item Url field already contains pre-built affiliate tracking link with prodsku.
- Prices in USD — compare.js now shows $ symbol for VS entries.
- Seat map / interactive seating chart NOT available via Impact affiliate API.
  Requires direct commercial API partnership with Vivid Seats (contact their partnerships team).
  Seatpick.com uses a proprietary data aggregation platform, not the public affiliate API.

### Env vars required
- IMPACT_ACCOUNT_SID: in Cloudflare Pages Settings → Variables
- IMPACT_AUTH_TOKEN: in Cloudflare Pages Settings → Variables

### Cron jobs to add (cron-job.org)
- Mon 00:20 UTC: https://ticketscout.co.uk/api/vividseats-cache?trigger=1
- (piggybacks on existing Mon 00:25 commit cron)

---

## 2026-07-08 — Session 4 (Vivid Seats integration completed)

### Deployed
- `functions/api/vividseats.js` — Rewrote to search chunked KV index. Fallback search link if cache empty.
- `functions/api/vividseats-cache.js` — Rewrote to fetch CSV from GitHub raw URL. Fixed column mapping to match VS CSV headers (NAME, URL, PRICE, VENUE, CITY, CATEGORY, PRODUCTION_EXPIRATION_DATE). Splits index into 20MB KV chunks to stay under 25MB limit.
- `functions/api/vividseats-debug.js` — Debug endpoint for diagnosing catalog API issues.
- `public/vividseats-feed.csv.gz` — Vivid Seats bulk event feed (84k+ events, committed manually first time).
- `.github/workflows/vividseats-feed.yml` — GitHub Action: weekly FTP download from products.impact.com, commits to repo, triggers KV rebuild.
- `concert.html`, `football.html`, `theatre.html`, `venue.html` — VS fetch added to Promise.all. vsEvents merged into allEvents. buildEventRow handles _vs flag.
- `compare.js` — Vivid Seats adapter added with $ currency symbol.
- `functions/api/discover-pages.js` — VS discovery source added.

### Key findings documented
- Impact catalog API ignores Keywords/SearchQuery entirely — confirmed via rawsearch debug
- Impact catalog ItemSearch endpoint also times out (>30s) — not suitable for real-time calls
- products.impact.com is pure FTP, not HTTPS accessible from Cloudflare Workers
- Correct solution: GitHub-hosted CSV feed → worker fetches via HTTPS → chunked KV storage
- VS CSV column names differ from Impact standard: NAME/URL/PRICE/VENUE/CITY/CATEGORY vs CurrentPrice/Text1/Text2/ExpirationDate
- KV 25MB limit exceeded by full index (29.9MB) → split into 2 chunks of 20MB
- 84,307 upcoming events cached, searched in milliseconds

### Env vars added
- IMPACT_FTP_USER: ps-ftp_7443544
- IMPACT_FTP_PASS: (in Cloudflare Pages variables)
- IMPACT_ACCOUNT_SID: IR9mKsCFHL777443544zNqEHFE8tqSZqT1
- IMPACT_AUTH_TOKEN: (in Cloudflare Pages variables)

### GitHub Action secrets added
- IMPACT_FTP_USER, IMPACT_FTP_PASS, CLOUDFLARE_CACHE_URL

### Cron schedule
- Mon 01:00 UTC: GitHub Action downloads VS feed, commits, triggers KV rebuild (automated)

---

## 2026-07-08 — Session 4 (continued — compare table + VS full integration)

### Deployed
- `functions/api/ticketmaster.js` — Removed countryCode=GB filter when attractionId is set. Previously all artist event searches were restricted to UK only, causing 0 results for artists touring outside UK (e.g. Metallica at Sphere Las Vegas).
- `compare.js` — Complete overhaul:
  - Added extractPerformerName() helper — strips TM subtitles ("Metallica: Life Burns Faster" → "Metallica") before passing to adapters
  - Gigsberg adapter switched from /api/awin-events → /api/awin-category (correct endpoint returning {matches:[]} format)
  - Vivid Seats adapter now shows even without price (Check site fallback)
  - Seller logos added via favicon URLs with abbr badge fallback
  - SOURCE_STYLES map updated with all current sellers
- `functions/api/awin-category-cache.js` — Extended TTL from 7 hours to 8 days to survive missed cron runs
- `concert.html`, `football.html`, `theatre.html` — Awin events now route through compare page (/#/event/awin-[date-name]) instead of linking directly to seller
- `events.js` — Added awin- prefixed event ID handler in showEventDetail() so compare page works for Awin-sourced events

### Key findings — compare table architecture
- THREE different Awin endpoints exist, all reading same KV cache (awin:category:latest):
  - /api/awin-events → { events: [] } — used by event list pages (search by name=)
  - /api/awin-category → { matches: [] } — used by compare table (search by q=)
  - /api/gigsberg → { match: null } — SEPARATE cache (gigsberg:feed:latest), NOT Awin
- compare.js must use /api/awin-category (not awin-events, not gigsberg)
- Awin cache TTL was 7 hours — too short, caused cache to expire between cron runs
- TM countryCode=GB was filtering out all non-UK artist events — e.g. Metallica Las Vegas
- extractPerformerName() is essential: TM event names include subtitles that no other seller uses

### Confirmed working
- Metallica compare page: Gigsberg UK (£755) + Vivid Seats ($636) side by side ✅
- Event list → Compare page flow working for all categories ✅
- Awin cache TTL extended to 8 days ✅

---

## 2026-07-08 — Session 4 (Ticombo/Partnerize integration)

### Deployed
- `functions/api/ticombo.js` — New. Ticombo affiliate adapter via Partnerize.
  Region detection via CF-IPCountry header → routes to correct regional camref.
  9 campaigns: UK, US, Europe, Germany, Spain, Singapore, Mexico, APAC, LATAM.
  Returns search deep-link (isFallback:true) — earns commission on click-through.
- `functions/api/ticombo-debug.js` — New. Tests Partnerize API auth + lists campaigns.
- `compare.js` — Ticombo adapter added. Logo: /public/logos/ticombo.svg.
- `concert.html`, `football.html`, `theatre.html`, `venue.html` — Ticombo fetch added to
  Promise.all. Ticombo search card added to event list when other sources respond.
- `public/logos/ticombo.svg` — New logo badge (indigo #6366f1).
- `functions/api/discover-pages.js` — Ticombo discovery source added (?source=ticombo).
- `PROJECT-SUMMARY_1.md` — Partnerize affiliate table updated with all 9 camrefs.

### Ticombo architecture notes
- Deep-link format: ticombo.prf.hn/click/camref:{CAMREF}/destination:{ENCODED_URL}
- No product feed available yet via Partnerize — using search deep-links
- CF-IPCountry header (automatic from Cloudflare) drives region routing — zero extra cost
- All 9 regional camrefs confirmed from Partnerize dashboard
- Event-specific matching to be added once product feed access confirmed with Ticombo

### Tests to run on return
1. https://ticketscout.co.uk/api/ticombo-debug — confirms Partnerize API auth
2. https://ticketscout.co.uk/api/ticombo?q=Metallica — should return search deep-link
3. /concert/metallica — Ticombo card should appear in event list
4. Click Metallica event → compare table should show Ticombo
5. Click Ticombo link → verify lands on ticombo.com/en/search?q=Metallica
6. Check Partnerize dashboard within 10 mins → confirm click tracked

---

## Template for future sessions

## [YYYY-MM-DD] — Session [N]

### Deployed
- `path/to/file` — reason

### Notes
-
