# TicketScout — Project Summary & Handover
# Last updated: 07 July 2026 (end of session 3)

## Site
ticketscout.co.uk — UK ticket price comparison
Stack: Static HTML/CSS/JS on Cloudflare Pages, GitHub auto-deploy
Repo: github.com/ticketandeventscout/ticketscout

---

## 📋 CHANGELOG
All file changes are tracked in `CHANGELOG.md` (repo root).
Update it at the end of every session before closing.
To diagnose when a bug was introduced: check CHANGELOG for the deploy date and correlate with when the error first appeared.

---

## 🚨 WORKING FILES RULE — READ FIRST EVERY SESSION
**NEVER read from `/mnt/project/` files to diagnose or patch code.**
The project files are READ-ONLY snapshots that are NEVER updated during a session.
All edits happen in `/home/claude/` (working copies).

**Correct workflow:**
1. At session start: `cp /mnt/project/[file] /home/claude/[file]` to get a fresh working copy
2. All reads, patches, and verification use `/home/claude/[file]`
3. Output goes to `/mnt/user-data/outputs/[file]` for Rt to deploy
4. The project file at `/mnt/project/` will NOT reflect deployed changes until next session

**If you catch yourself doing `grep -n "..." /mnt/project/...` to verify a fix — STOP.**
That file is stale. Use `/home/claude/` instead.

---

## ⚠️ NO GUESSWORK RULE
Before ANY fix, get console evidence first:
- Browser console error message
- Network tab HTTP status
- fetch().then(r=>console.log(r.status)) test
Never fix based on assumption.

---

## CRITICAL ARCHITECTURE — READ BEFORE TOUCHING PAGES

### Stub pattern (football/, theatre/, concert/, venue/)
All static pages are ~1KB stubs that fetch the category template at runtime.
ALL stubs must include the style-copy step (this was missing from concert/venue stubs — now fixed):
```html
<head>
  <script>window.__CONCERT_SLUG__ = 'metallica';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body><script>
  (async function() {
    try {
      const r = await fetch('/concert.html');
      const html = await r.text();
      const headStyleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);  // lazy — style only
      if (headStyleMatch) {
        const st = document.createElement('style');
        st.textContent = headStyleMatch[1];
        document.head.appendChild(st);
      }
      const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);  // GREEDY — full body
      if (!m) return;
      document.body.innerHTML = m[1];
      document.body.querySelectorAll('script').forEach(function(o) {
        var s = document.createElement('script');
        if (o.src) s.src = o.src; else s.textContent = o.textContent;
        document.body.appendChild(s); o.remove();
      });
    } catch(e) { console.error('Failed to load template:', e); }
  })();
</script></body></html>
```
Rules: greedy regex for body, lazy for style, scripts to body not head, try/catch wrapper.

### Template dependency
Stubs fetch their template at runtime. Fix the template → all stubs inherit the fix.

### The _redirects loop trap
/football → /football.html in _redirects causes 522 because stubs do fetch('/football.html').
Current _redirects: only /concerts → /concert.html. Never add football/theatre/venue rules.

### setEl() helper — MANDATORY for head elements
Templates use setEl() because head elements don't exist when loaded via stub:
```js
function setEl(id, attr, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (attr) el.setAttribute(attr, val); else el.textContent = val;
}
```
NEVER use direct document.getElementById('page-title').textContent = ... in templates.

### safeJson() pattern — MANDATORY for all API fetches in templates
API calls must guard against HTML error pages being returned instead of JSON:
```js
const safeJson = r => {
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('application/json')) return Promise.resolve(null);
  return r.json().catch(() => null);
};
// Usage:
fetch('/api/ticketmaster?...').then(safeJson).catch(() => null)
```
Without this, an HTML 404 page returned as JSON causes SyntaxError that kills the whole page.

### Search routing (150-char threshold)
All handleSearch() and runSearch() check 3 APIs in parallel:
- isRichFootball = description.length > 150 → /football/[slug]
- isRichTheatre  = description.length > 150 → /theatre/[slug]
- else → /concert/[slug]
Hardcoded entries have 200-350 char descriptions. Synthesised fallbacks are 50-90 chars.

### concert.js artist resolution — no longer requires hardcoded list
Lookup order: hardcoded ARTISTS → KV (concert:artist:[slug]) → Awin feed → slug synthesis.
Slug synthesis now works for ALL slugs (single-word AND hyphenated). The hardcoded ARTISTS
list is a fast-path for popular artists only — not required for correctness. Any slug that
reaches /api/concert came from a real stub page and must never 404.

---

## DATA SOURCES PER CATEGORY

| Category | Sources |
|---|---|
| Football | TM + Awin (category filter: football/soccer/sport) + SE365 (pending credentials) |
| Theatre | TM + Awin (all merchants — Theatre Tickets Direct) |
| Concert | TM + Awin (all — Gigsberg main source) |
| Venue | TM (venueId lookup) |

### SE365 Integration Status — OUTSTANDING
- Code: Complete and deployed (sportsevents365.js, sportsevents365-cache.js, football.html)
- Affiliate param: a_aid=dvqg90rd8vv1f (confirmed by Nir)
- SE365_HTTP_SOURCE: Sent as "Source" header in all requests
- SE365_PROD: Checks both string 'true' and boolean true
- **Status: HTTP 401 — Rt has emailed Nir, awaiting credential confirmation**
- **Action: Re-trigger /api/sportsevents365-cache?trigger=1 after Nir responds**

---

## FILES AND ROLES

| File | Purpose |
|---|---|
| index.html | Homepage |
| events.js | Hash router + homepage. runSearch() checks all 3 APIs |
| autocomplete.js | Search dropdown — IIFE pattern (not DOMContentLoaded) |
| football.html | Football template — setEl, SE365 fetch, clean landing page JS |
| theatre.html | Theatre template — setEl, decodeHtmlEntities, cross-category handleSearch |
| concert.html | Concert template — setEl, safeJson API fetches, dynamic artist images sidebar |
| venue.html | Venue template — setEl in updateMeta (no crash on stub context) |
| functions/api/football.js | Team data API — slug normalisation, synthesises unknowns |
| functions/api/theatre.js | Show data API |
| functions/api/concert.js | Artist data API — synthesises ALL slugs (no single-word 404) |
| functions/api/venue.js | Venue data + TM events |
| functions/api/awin-events.js | Awin KV search |
| functions/api/sportsevents365.js | SE365 events — a_aid param, Source header |
| functions/api/sportsevents365-cache.js | SE365 participant cache |
| functions/api/discover-pages.js | Auto-discovery pipeline — concert+venue stubs now include style-copy |
| functions/concert/[slug].js | Server-side router for unknown concert slugs |
| functions/venue/[slug].js | Server-side router for venue pages |

---

## CONFIRMED WORKING (07 Jul 2026 — session 3)

✅ Football pages — loads correctly (Arsenal etc)
✅ Football landing page — club grid renders
✅ Theatre pages — loads correctly
✅ Concert pages — loads correctly (metallica, coldplay etc)
✅ Venue page (wembley-stadium) — hero, events list, sidebar fully styled
✅ Popular artists sidebar — Oasis and The Killers now show images (added to ARTISTS array)
✅ Oasis/Killers images — concert.js now synthesises all slugs so no artist 404s
✅ Concerts nav link — triggers filterCategory correctly
✅ Theatre nav link — triggers filterCategory correctly
✅ Comedy nav link — navigates to / correctly
✅ Compare prices link — goes to correct event (no 522)
✅ Phantom of the Opera redirect — football stub → theatre page
✅ Cross-category search — works in all directions
✅ Autocomplete dropdown — visible above hero section
✅ Date filter + "Show all dates" clear link
✅ Load more + page indicator
✅ Contact form
✅ Mobile layout
✅ Footer links
✅ Awin debug tools removed from /api/awin-events

---

## OUTSTANDING BUGS / IN PROGRESS

### Concert page JSON SyntaxError — FIXED (deploy concert.html)
**Error:** `SyntaxError: Unexpected token 'T', "TicketScou"... is not valid JSON` at concert.html:883
**Root cause:** /api/ticketmaster or /api/awin-events occasionally returns the TicketScout HTML
error page instead of JSON. `.then(r => r.json())` then throws a SyntaxError which bubbles to
the outer catch, showing "Unable to load events" and killing artist name/bio rendering.
**Fix:** safeJson() helper checks Content-Type header before parsing. Returns null if not JSON.
Downstream code already uses optional chaining (?.) so null is handled safely.
**File to deploy:** concert.html → repo root

### SE365 HTTP 401 — WAITING ON NIR
Rt has emailed Nir. Re-trigger cache after credentials confirmed.

---

## NEXT PRIORITIES (in order)

1. **Deploy concert.html** (JSON SyntaxError fix — safeJson pattern)
2. **SE365 activation** — once Nir confirms credentials, trigger cache, verify football pages
3. **Partnerize / Ticombo integration** — see affiliate section below
4. **Trivago integration** — hotel placement on site needed (see affiliate section)
5. **Hotels.com (CJ) integration** — hotel placement needed alongside Trivago
6. **Google Search Console** — verify domain, submit sitemap (manual — Rt to do)
7. **Bing Webmaster Tools** — import from GSC (manual — Rt to do)
8. **Multilingual assessment** — Eventim PL approval triggers need to assess language expansion strategy
9. **Stub style validation test** — add to test checklist: visit a newly auto-generated concert stub and venue stub to confirm styles apply correctly (hero gradient, event cards, sidebar)
10. **Gigsberg ES (Awin)** — new merchant ID to add to Awin feed (see Awin section below)
11. **Sitemap regeneration** — current sitemap doesn't include all auto-generated pages
12. **Sidebar expansion** — football and theatre pages show only 6 clubs/shows; expand to full lists

---

## AFFILIATE STATUS & INTEGRATION TRACKER

### Awin
| Merchant | Commission | Status | Notes |
|---|---|---|---|
| Gigsberg UK | 5% | ✅ Live | Primary concert source |
| Gigsberg ES | 5% | ⚠️ Approved — needs adding to feed | See Awin feed section below |
| Theatre Tickets Direct | TBC | ✅ Live | |
| Football TicketNet UK | 3.86% | ✅ Live | |
| Eventim PL | TBC | ✅ Approved | Primary ticket source for Poland. Triggers multilingual assessment — see priorities |
| Tiqets US | TBC | ⏳ Re-applied | Rejected (no URL provided). Rt re-applied with correct details |

### Partnerize
| Merchant | Commission | Status | Notes |
|---|---|---|---|
| Ticombo UK | TBC | ✅ Live | camref:1100l5P9x2 |
| Ticombo US | TBC | ✅ Live | camref:1100l5P9x3 |
| Ticombo Europe | TBC | ✅ Live | camref:1100l5P9wQ |
| Ticombo Germany | TBC | ✅ Live | camref:1100l5P9wR |
| Ticombo Spain | TBC | ✅ Live | camref:1100l5P9wT |
| Ticombo Singapore | TBC | ✅ Live | camref:1100l5P9wS |
| Ticombo Mexico | TBC | ✅ Live | camref:1100l5P9wN |
| Ticombo APAC | TBC | ✅ Live | camref:1100l5P9wP |
| Ticombo LATAM | TBC | ✅ Live | camref:1100l5P9wM |

**Ticombo tracking format:** `https://ticombo.prf.hn/click/camref:{CAMREF}/destination:{ENCODED_URL}`
**Region detection:** CF-IPCountry header routes to correct regional camref automatically
**Commission:** 7% on all sales (confirmed via Partnerize API)
**Publisher ID:** 1110l36128 (account: ticketandeventscoutpartnerize)
**API base:** https://api.performancehorizon.com (legacy domain — api.partnerize.com returns 404)
**Product feed:** 5 feeds available (Europe, Germany, Singapore, Spain, UK) — NOT yet processed
  Feed URLs confirmed from Partnerize dashboard (all share hash a1f3f49c2e6d13ca6d33d24088acc238)
  Partnerize shows "feed available within 4 hours" — new account, feeds not yet generated
  ⚠️ ACTION REQUIRED: Check feeds again after 4-24 hours, then run /api/ticombo-cache?trigger=1&test=1
  Once feeds are available: run /api/ticombo-cache?trigger=1 to build KV index
  ticombo-cache.js is already built with all 5 feed URLs and ready to deploy
**Current approach:** Search deep-link fallback (isFallback:true) — earns 7% on any purchase
  Shows "Check site" in compare table until feed cache is built
**Env vars required:** PARTNERIZE_API_KEY, PARTNERIZE_USER_KEY, PARTNERIZE_PUBLISHER_ID
**Logo:** public/logos/ticombo.svg

| Region | Campaign ID | Camref |
|---|---|---|
| UK | 1100l6335 | 1100l5P9x2 |
| US | 1011l6397 | 1100l5P9x3 |
| Europe | 1011l6399 | 1100l5P9wQ |
| Germany | 1011l6400 | 1100l5P9wR |
| Spain | 1100l6336 | 1100l5P9wT |
| Singapore | 1101l6348 | 1100l5P9wS |
| Mexico | 1110l49 | 1100l5P9wN |
| APAC | 1011l6398 | 1100l5P9wP |
| LATAM | 1100l6567 | 1100l5P9wM |

### Commission Junction (CJ)
| Merchant | Commission | Status | Notes |
|---|---|---|---|
| TicketSmarter | 3% | ⏳ Pending | |
| SOLDOUT.COM | TBC | ⏳ Pending | |
| TicketLiquidator | TBC | ⏳ Pending | |
| Trivago UK | TBC | ✅ Approved | Hotel comparison — needs site placement. See compliance notes |
| Hotels.com | TBC | ✅ Approved | Hotel placement needed alongside Trivago |

### Impact
| Merchant | Commission | Status | Notes |
|---|---|---|---|
| StubHub International | 9% | ⏳ Pending | |
| Vivid Seats | 6% | ✅ Live (affiliate) | Campaign 12730, Catalog 7904, 131k events. KV cache approach — see FILE-DEPENDENCY-MAP.md |

### Direct / Other
| Merchant | Commission | Status | Notes |
|---|---|---|---|
| Skiddle | 30% of fee | ✅ Live | |
| SportsEvents365 | 7% | ⏳ Awaiting Nir | HTTP 401 — credentials issue |
| See Tickets | TBC | ❌ Rejected x2 | |
| Ticketmaster UK | ~1% | ❌ Rejected | |

---

## TRIVAGO — COMPLIANCE NOTES (do not violate)
Forbidden activities confirmed in approval terms:
- ❌ SEM: No paid/organic search ads in trivago's name on any engine
- ❌ GDN/GSP: No Google Display Network or Gmail Sponsored Promotions
- ❌ Incentives: No cashback, points, rewards, or game-based traffic
- ❌ Adware: No toolbars or link overrides
- ❌ Real-time bidding
- ❌ Coupon/discount codes
- ❌ Remarketing/retargeting
- ❌ Email without prior opt-in proof and database source disclosure
- ❌ Bots, automation, fake frames, misleading redirects
- ✅ Standard editorial content placement is fine (what we do)

---

## AWIN FEED MANAGEMENT

### Current merchants in feed
Gigsberg UK, Theatre Tickets Direct, Football TicketNet UK

### Adding new Awin merchants
Currently requires recreating the whole feed when a new merchant is added — this is a known
pain point. **Proposed solution (to implement):** The awin-category-cache.js function should
accept the merchant list from a KV key (`awin:merchants`) rather than a hardcoded list.
To add a new merchant you would then only need to update that KV value with the new merchant ID.
**Status: To-do — not yet implemented. Gigsberg ES merchant ID needed from Rt to proceed.**

### Gigsberg ES — action needed
- Rt to provide the Awin merchant ID for Gigsberg ES
- Then we can add it to the feed (either manually now, or via the KV-driven approach above)

---

## PARTNERIZE / TICOMBO — INTEGRATION PLAN

### What's needed from Rt (Partnerize platform)
To build the integration, the following is needed from the Partnerize dashboard:

1. **Campaign ID(s)** — found in Partnerize dashboard → Campaigns → each Ticombo campaign has a unique ID in the URL or campaign details panel
2. **Tracking link base URL** — found under each campaign → "Get Links" or "Tracking Links" section. Will look like `https://ticombo.prf.hn/click/camref:[campaign_ref]/destination:[url]` or similar
3. **API key** (if using their product feed) — Partnerize → Account Settings → API Keys
4. **Feed URL** (if Ticombo provides a product/event feed through Partnerize) — check each campaign under "Feeds" or "Creatives"
5. **Publisher reference** — your Partnerize publisher ID, found under Account → Publisher Details

For now the most practical first step is **deep-linking**: build affiliate URLs to Ticombo event pages using the Partnerize tracking link format, and surface them on relevant concert/event pages alongside existing Awin and SE365 links.

### Validation tests to run after integration
1. Click a generated Ticombo affiliate link → confirm it lands on the correct Ticombo event page
2. Check Partnerize dashboard → Reports → confirm a click was tracked within 10 minutes
3. Verify the tracking link uses the correct campaign ref for the right regional campaign (UK link → Ticombo UK campaign, not US)
4. Confirm affiliate cookie is set in browser after click (check DevTools → Application → Cookies → ticombo.com)

---

## HOTELS / TRIVAGO + HOTELS.COM — SITE PLACEMENT PLAN

Both Trivago and Hotels.com need a placement on the site. The natural fit for a ticket comparison
site is a **"Where to stay"** section on venue pages (e.g. Wembley Stadium → hotels nearby).
Suggested approach:
- Add a "Hotels near [Venue]" sidebar card on venue pages, powered by a Trivago search widget
  or a deep-link to Hotels.com search results for that city
- This is a low-friction addition — no new pages needed, just a sidebar card in venue.html

**Trivago widget:** Trivago provides an embeddable search widget. Check the CJ creative assets
for the widget code or deep-link format.
**Hotels.com:** CJ will have tracking link format under the Hotels.com campaign creatives.

**Status: To-do — not yet implemented**

---

## MULTILINGUAL / INTERNATIONAL EXPANSION — ASSESSMENT NEEDED

Triggered by Eventim PL (Poland) approval.

Options:
1. **Same domain, language path** — ticketscout.co.uk/pl/ — simplest, no DNS changes
2. **Subdomain** — pl.ticketscout.co.uk — moderate complexity
3. **New ccTLD** — ticketscout.pl — strongest local SEO but requires domain purchase + separate Cloudflare setup

**Recommendation (to be assessed):** Start with option 1 (path-based) for Poland as a test
market, given Eventim PL is the only international affiliate so far. Revisit if more EU
affiliates are added.

**Status: Assessment needed — not urgent**

---

## ✅ AFFILIATE TRACKING VERIFICATION CHECKLIST

After adding any new affiliate integration, verify tracking is working:

**For each new affiliate, within 24 hours of go-live:**

1. **Click a live affiliate link** from the compare table on the site
2. **Check the affiliate dashboard** within 10-15 minutes:
   - Awin (Gigsberg, Theatre Tickets Direct, Football TicketNet): awin.com → Reports → Click report
   - Impact (Vivid Seats): impact.com → Reports → Clicks
   - SE365: sportsevents365.com affiliate portal → Reports
   - Partnerize (Ticombo when live): partnerize.com → Reports
3. **Confirm click is recorded** with correct campaign/publisher attribution
4. **Verify affiliate parameter is in the URL:**
   - Awin: `?a_aid=` or `&a_aid=` in deep link
   - Impact/VS: `vivid-seats.pxf.io/c/7443544/` prefix in URL
   - SE365: `?a_aid=dvqg90rd8vv1f` in ticket URL
5. **Make a test purchase if possible** (or use sandbox mode) to confirm conversion tracking

**Periodic check (monthly):**
- Log into each affiliate dashboard and confirm clicks/conversions are recording
- Cross-reference with site traffic to ensure click-through rate is reasonable
- Flag any affiliate showing 0 clicks despite appearing in compare table

---

## 🖼️ AFFILIATE LOGO STANDARD

Every affiliate in the compare table must have a logo file in `public/logos/`.
Logo files are SVG format — tiny, crisp at any size, no external dependencies.

**When adding a new affiliate:**
1. Create `public/logos/[affiliate-slug].svg` — 36x36 viewBox, rounded rect + abbr text
2. Add entry to `SOURCE_STYLES` in `compare.js`
3. Template SVG:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
  <rect width="36" height="36" rx="6" fill="#BRANDCOLOUR"/>
  <text x="18" y="24" font-family="Arial,sans-serif" font-size="14" font-weight="900" fill="#ffffff" text-anchor="middle">XX</text>
</svg>
```

**Current logos in public/logos/:**
- `gigsberg.svg` — Gigsberg UK (navy #0a1628)
- `vividseats.svg` — Vivid Seats (blue #00a0e9)
- `sportsevents365.svg` — SportsEvents365 (orange #e85d04)
- `ticketmaster.svg` — Ticketmaster (blue #026cdf)
- `skiddle.svg` — Skiddle (teal #00b4b4)
- `theatre-tickets-direct.svg` — Theatre Tickets Direct (purple #7c3aed)
- `football-ticketnet.svg` — Football TicketNet (green #16a34a)

Future: replace SVG text badges with actual brand logos once brand assets are approved.

---

## ⭐ CORE ARCHITECTURE PRINCIPLE — EVENT LIST vs COMPARE PAGE

This is how ALL affiliate integrations must work. Do not deviate from this pattern.

### Event list pages (/concert/metallica, /football/arsenal, /theatre/phantom etc.)
- Show DATED EVENTS only from TM, Awin/Gigsberg, SE365
- Each card = one specific date, one seller source, with price
- Exception: if TM/Awin/SE365 return NO events, show VS/other affiliate as fallback
- Clicking a card → goes to event detail page (/#/event/[id])

### Event detail page (/#/event/[id])
- Shows COMPARE TABLE: all sellers side by side for that ONE specific event
- Every affiliate (Gigsberg, VS, SE365, Skiddle, SeatGeek etc.) appears here
- This is where users make the buying decision
- compare.js handles all adapters: buildUrl() + normalise() per adapter

### What does NOT belong in the event list
- Generic "Search X on Vivid Seats" cards
- Affiliate search links (not event-specific)
- Any card without a specific date

### Adding a new affiliate correctly
1. Add adapter to compare.js (shows in compare table for every event) ← most important
2. If affiliate has event-level data → also add to Promise.all in category templates
   (only if each result has a specific date and price, not search links)
3. If affiliate is search/browse only → compare.js only, never event list

---

## VIVID SEATS INTEGRATION NOTES

### Architecture
- Impact affiliate program (Campaign 12730, Publisher 7443544)
- Catalog ID 7904 — "Ticket Feed" — 131,523 events updated daily
- Impact live catalog API IGNORES Keywords/SearchQuery params — confirmed via debug testing
- Solution: download bulk CSV feed at /Vivid-Seats/Ticket-Feed_CUSTOM.csv.gz weekly → KV index
- KV key: vs:catalog:index (array of {n,u,p,c,d,v,t,g} objects)
- Each catalog item Url is already a pre-built affiliate tracking link with prodsku
- Prices in USD — show $ symbol, not £

### Seat map / interactive seating chart
- NOT available through Impact affiliate API
- Requires direct commercial API partnership with Vivid Seats
- Contact: partnerships@vividseats.com or via their developer portal
- Seatpick.com is a direct technology partner, NOT an Impact affiliate
- Their seating chart is built on proprietary data, not accessible to affiliates

### Env vars required
- IMPACT_ACCOUNT_SID: IR9mKsCFHL777443544zNqEHFE8tqSZqT1
- IMPACT_AUTH_TOKEN: (in Cloudflare Pages variables — regenerate periodically)

### Cron jobs
- Mon 00:20 UTC: /api/vividseats-cache?trigger=1 (add to cron-job.org)

---

## TECHNICAL GOTCHAS (permanent reference)

1. **setEl() for ALL head element updates** — direct getElementById on head elements crashes when loaded via stub
2. **safeJson() for ALL API fetches in templates** — r.json() on HTML error pages throws SyntaxError that kills page
3. **Greedy body regex, lazy style regex** — swap these and pages go blank
4. **Style-copy step in ALL stubs** — missing from concert/venue stubs caused unstyled pages (now fixed in discover-pages.js)
5. **No /football → /football.html in _redirects** — causes 522 loop
6. **No functions/football/[slug].js or functions/theatre/[slug].js** — causes 522 loop
7. **autocomplete.js uses IIFE** — DOMContentLoaded never fires on stub-re-executed scripts
8. **SE365 affiliate param is a_aid= NOT affid=** — confirmed by Nir
9. **SE365_HTTP_SOURCE** — must be sent as "Source" header in all SE365 requests
10. **150-char description threshold** — separates real entries (200+ chars) from synthesised (50-90 chars)
11. **Awin football filter** — filter by category field not merchant name
12. **Python-generated JS** — never use Python f-strings with backtick template literals
13. **concert.js single-word slug** — now synthesises ALL slugs; single-word 404 restriction removed
14. **KV namespace** — GIGSBERG_KV, ID: bc766f3f7b284869a0b249a590eb4fcf
15. **Template caching** — stubs fetch `/concert.html` at runtime. Browsers cache this. Always:
    - `_headers` file must have `Cache-Control: no-store` for all template HTML files
    - Stub fetch URLs use `?v=YYYYMMDD` version param to bust cache after deploys
    - When bumping version, update both `discover-pages.js` stub generators AND existing deployed stubs
16. **Batch deploy file corruption** — during batch commits, files can be mapped to wrong destinations.
    `functions/api/concert.js` was overwritten with `discover-pages.js` content. The file existed
    with the correct name and returned HTTP 200, making diagnosis extremely difficult.
    **Before any batch deploy: verify file content not just filename.**
    Use `head -3 file.js` to confirm the first comment line matches the expected function.
17. **API returning wrong content with 200** — if a fetch returns status 200 but the page breaks,
    always add `resp.clone().text()` diagnostic log to see the raw response before calling `.json()`.
    This immediately reveals whether the wrong function is handling the route.
18. **safeJson() pattern is mandatory** — all third-party API fetches (TM, Awin, SE365) must use
    safeJson() not raw `.json()`. Our own functions (/api/concert, /api/football etc) can use
    plain `.json()` inside a try/catch since they always return application/json.
19. **extractPerformerName() in compare.js** — TM event names include subtitles that no other seller
    uses. Always strip before passing to adapters: "Metallica: Life Burns Faster" → "Metallica".
    Without this, ALL adapters return null and only TM shows in the compare table.
20. **Three Awin endpoints — never swap them:**
    - `/api/awin-events?name=` → `{events:[]}` — event list pages only
    - `/api/awin-category?q=` → `{matches:[]}` — compare.js only
    - `/api/gigsberg?q=` → `{match:}` — SEPARATE cache, not used in compare
21. **TM countryCode=GB must be removed for attractionId searches** — otherwise non-UK tours
    (e.g. Metallica Las Vegas) return 0 results. Only use countryCode for homepage browsing.
22. **Awin cache TTL** — was 7 hours, extended to 8 days. Cache refresh runs every 6 hours via
    cron-job.org. If cache expires, ALL Gigsberg events disappear from event list AND compare table.
    Always extend TTL well beyond the cron interval.
23. **Debug-first rule** — before any fix, add console.log diagnostics, deploy once, read output,
    then fix based on evidence. Never fix based on assumption.