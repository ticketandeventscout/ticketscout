# TicketScout — Project Summary (updated 05 July 2026 — evening)

**Site:** ticketscout.co.uk — UK ticket price comparison
**Stack:** Static HTML/CSS/JS, hosted on Cloudflare Pages, connected to GitHub (auto-deploys on push)
**Repo:** github.com/ticketandeventscout/ticketscout
**Local workflow:** Edit files locally → GitHub Desktop (commit + push) → Cloudflare Pages auto-deploys

---

## Session handover — always do this before closing

Before ending any session, produce a structured handover note covering:
1. What was built or changed this session (files, functions, fixes)
2. What is confirmed working and what still needs testing
3. Any known bugs or issues left open
4. The next 3–5 priorities in order
5. Any pending actions the human needs to take (deploy files, trigger URLs, apply to programmes)

---

## Architecture

- **Frontend:** Single `index.html` with hash-based router implemented in `events.js`
- **SEO pages:** Static pages at `/concert/[slug]`, `/football/[slug]`, `/theatre/[slug]`, `/venue/[slug]`
- **Backend:** Cloudflare Pages Functions at `functions/api/`
- **API keys/secrets:** Cloudflare dashboard → project → Settings → Variables and secrets
- **Cloudflare plan:** Paid (Workers Standard, $5/month) — required for Awin feed caching

## Current env vars

| Variable | Purpose |
|---|---|
| `TM_API_KEY` | Ticketmaster Discovery API |
| `SEATGEEK_CLIENT_ID` | SeatGeek events API |
| `SKIDDLE_AFFILIATE_TAG` | Skiddle affiliate tracking tag (15734) |
| `VIAGOGO_PARTNERIZE_ID` | Partnerize publisher ID (1110l35929 — lowercase 'l') |
| `AWIN_PUBLISHER_ID` | Awin publisher ID = 2960641 |
| `AWIN_CATEGORY_FEED_URL` | Awin category feed URL (Secret) |
| `SPORTSEVENTS365_AFFILIATE_ID` | SE365 affiliate ID = dvqg90rd8vv1f |

---

## ⚠️ CRITICAL: Static page architecture — read before touching football/theatre pages

### How concert pages work (PROVEN, DO NOT CHANGE)

Concert static files (`concert/coldplay.html` etc) use the **lightweight fetch pattern**:

```html
<head>
  <script>window.__CONCERT_SLUG__ = 'coldplay';</script>
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?..." rel="stylesheet" />
</head>
<body><script>
  (async function() {
    const r = await fetch('/concert.html');
    const html = await r.text();
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);  // GREEDY * not lazy *?
    if (!m) return;
    document.body.innerHTML = m[1];
    document.body.querySelectorAll('script').forEach(function(o) {
      var s = document.createElement('script');
      if (o.src) s.src = o.src; else s.textContent = o.textContent;
      document.body.appendChild(s); o.remove();
    });
  })();
</script></body></html>
```

**This exact pattern is what works.** Key rules:
1. **Greedy regex** `[\s\S]*` NOT lazy `[\s\S]*?` — lazy stops too early in large files
2. **NO separate style copying** — the styles load fine from `/styles.css` and the body's own inline styles (if any) come through with the body content
3. **Scripts appended to `document.body`** not `document.head`
4. **`window.__CONCERT_SLUG__`** set in head BEFORE body injection — persists on window object through innerHTML replacement
5. The slug is also readable from `window.location.pathname` as fallback (getSlug() checks both)

### Football/theatre pages — MUST use identical pattern

Football stubs (`football/brighton.html`) and theatre stubs (`theatre/hamilton.html`) must use **exactly the same pattern** as concert, just with different slug variable and template URL:

```html
<script>window.__FOOTBALL_SLUG__ = 'brighton';</script>
<!-- fetch('/football.html') instead of '/concert.html' -->
```

**DO NOT ADD:**
- Separate style copying (causes blank pages)
- XMLHttpRequest/DOMParser alternatives (too complex, unreliable)
- try/catch wrappers that silently swallow errors
- Functions router `[slug].js` files for football/theatre (causes Error 1101 loops)

### Why the concert/[slug].js function exists but football/theatre don't need one

`functions/concert/[slug].js` serves concert pages **server-side** for slugs without a static file. It fetches `concert.html`, injects the slug, and returns the full HTML. This is needed for auto-discovered concert artists not yet in the static file set.

Football and theatre do NOT have `functions/football/[slug].js` — this was tried and caused a 522 timeout loop because Cloudflare routed `/football.html` itself through the function. Do not recreate these.

### The inline style myth

Football.html and theatre.html have a large `<style>` block in `<head>` (lines 23-412). You might think this needs copying into the stub. **It does not.** Concert.html also has a `<style>` block and concert stubs work without copying it. The browser renders the body content correctly because:
- The body's rendered HTML includes any inline styles on elements
- The `/styles.css` link in the stub head loads all shared styles
- The large `<style>` block in the template head covers page-specific layout — and since the body innerHTML includes elements styled by it, the browser applies those styles from the already-injected `<style>` tag (which was appended to head via the style copy in some versions, but this caused MORE problems than it solved)

**Conclusion: use the exact concert stub pattern. No style copying.**

---

## Files and their roles

| File | Purpose |
|---|---|
| `index.html` | Homepage shell — nav, hero, search, category pills, footer |
| `styles.css` | All shared styling |
| `events.js` | Hash router + all homepage view rendering. Routes searches to /football/, /theatre/, /concert/ |
| `concert.html` | Concert template — fetched by concert stubs at runtime |
| `football.html` | Football template — fetched by football stubs at runtime |
| `theatre.html` | Theatre template — fetched by theatre stubs at runtime |
| `venue.html` | Venue template |
| `autocomplete.js` | Search dropdown — shared across all pages |
| `functions/api/concert.js` | Returns artist data + TM attraction ID. Synthesises from slug for hyphenated unknown slugs. |
| `functions/api/football.js` | Returns team data + TM attraction ID. Synthesises for ALL slugs (football clubs are often single words). **Never returns 404 for valid slugs.** |
| `functions/api/theatre.js` | Returns show data + TM attraction ID. Synthesises from slug. |
| `functions/api/ticketmaster.js` | Proxies TM Discovery API. Always sets startDateTime=now. |
| `functions/api/awin-events.js` | Searches Awin KV cache. Debug tools — keep until significant traffic. |
| `functions/api/awin-category-cache.js` | Fetches Awin feed, stores in KV every 6 hours. |
| `functions/api/discover-pages.js` | Auto-discovery pipeline — finds new artists/teams, commits stubs to GitHub |
| `functions/concert/[slug].js` | Server-side concert router for slugs without static files |
| `concert__slug_.js` | Local copy of above (deployed as `functions/concert/[slug].js`) |
| `llms.txt` | AI crawler instructions |
| `sitemap.xml` | XML sitemap — 145 URLs |
| `robots.txt` | Crawl rules — whitelists AI bots |
| `_headers` | Cloudflare Pages headers for content types |

---

## ⚠️ KEY DEPENDENCY: football.html must be deployed for stubs to work

**The stubs fetch `/football.html` at runtime.** If `football.html` has not been deployed with the latest fixes, ALL football stubs will load the old broken template. This is why Crystal Palace showed Gary Numan — the deployed `football.html` still had the old Awin event fetch.

**Always check:** when fixing football.html, the fix only takes effect when both:
1. `football.html` is deployed to repo root
2. The stubs remain unchanged (they always fetch the latest `football.html`)

Same applies to `theatre.html` and `concert.html`.

---

## Search routing — how events.js decides where to send a search

`runSearch()` is called when user types and hits Search. It checks all three APIs in parallel:

```js
const [footballResp, theatreResp, concertResp] = await Promise.all([...]);
const isRichFootball = (footballResp?.team?.description?.length || 0) > 80;
const isRichTheatre  = (theatreResp?.show?.description?.length || 0) > 80;
if (isRichFootball) { redirect to /football/[slug] }
if (isRichTheatre)  { redirect to /theatre/[slug] }
if (concertResp)    { redirect to /concert/[slug] }
```

**The 80-char description check is critical:** `football.js` synthesises a short (~50 char) description for unknown slugs. Only hardcoded teams have descriptions >80 chars. Without this check, searching "crystal-palace" would match a synthesised football entry and route incorrectly.

`showArtistEvents()` uses the same logic for autocomplete clicks.

---

## Routing architecture

```
_redirects (critical rules):
/concerts  /concert.html  200
/football  /football.html 200
/theatre   /theatre.html  200

NEVER add /football/* catch-all — breaks static routing (Error 1101)
```

Static HTML files served directly by Cloudflare Pages:
- `concert/coldplay.html` → `/concert/coldplay`
- `football/arsenal.html` → `/football/arsenal`
- `theatre/hamilton.html` → `/theatre/hamilton`

---

## Auto-discovery pipeline — current state

`discover-pages.js` generates stubs using `generateArtistPageHtml()`, `generateFootballPageHtml()`, `generateTheatrePageHtml()`. These now use the correct concert-pattern (greedy regex, no style copying). New pages auto-committed to GitHub deploy correctly.

**⚠️ Problem: ~200 auto-discovered pages in Cloudflare were committed BEFORE the stub fix.** These pages on GitHub/Cloudflare still use the OLD full-embed 36KB pattern and will fail. To fix them all, trigger the discover pipeline's backfill or regenerate manually. See "Regenerating auto-discovered pages" below.

---

## Regenerating auto-discovered pages (safe approach)

Pages auto-committed via discover-pages.js pipeline exist in GitHub but not on your local machine. To fix them:

1. In GitHub Desktop: **Fetch → Pull** to get all committed pages locally
2. You'll see hundreds of files in concert/, football/, theatre/ folders
3. Any 36KB file needs replacing with the correct 1KB stub
4. The stub pattern is identical for all three categories — just the slug variable and template URL differ
5. Safest: trigger `discover-pages?trigger=1&phase=commit` after the backfill — this will re-commit correct stubs for all queued artists

**Alternative (nuclear option):** Delete all files in football/ and theatre/ subfolders from GitHub, let the stubs be regenerated by the discovery pipeline.

---

## Known issues — open as of 05 Jul 2026 evening

| Issue | Status | Notes |
|---|---|---|
| Brighton loading blank | ❌ Open | Identical stub to working clubs. Likely Cloudflare edge cache at Frankfurt. Try purging specifically via Cloudflare dashboard → Caching → Purge → Custom URL. |
| football.html Awin removal | ⚠️ Output ready, not deployed | Output `football.html` has fix. Must be committed to repo root. |
| concert.html entity decode | ⚠️ Output ready, not deployed | Beetlejuice/Phantom descriptions show raw `&lsquo;` etc. Fix in output. |
| theatre.html entity decode | ⚠️ Output ready, not deployed | Same as above. |
| events.js search routing | ⚠️ Output ready, not deployed | runSearch() now checks football/theatre before concert. Fix in output. |
| Auto-discovered pages (36KB) | ❌ Open | ~200 pages on GitHub still use old full-embed pattern. Pull repo locally and replace with stubs. |
| Rich Results Test | ⏳ Pending deploy | Static schema added to templates. Will work after template deploy. |
| Google Search Console | ⏳ Manual step | See setup instructions below. |
| Bing Webmaster Tools | ⏳ Manual step | After GSC. Import from GSC option. |

---

## Files to deploy — current outstanding commit

All of these are in your downloads folder. Deploy in ONE commit:

| File | Destination | What it fixes |
|---|---|---|
| `concert.html` | repo root | Entity decode, z-index, static schema |
| `football.html` | repo root | Awin removal, z-index, static schema |
| `theatre.html` | repo root | Entity decode, z-index, static schema |
| `index.html` | repo root | Static schema (SearchAction) |
| `events.js` | repo root | Search routing — football/theatre before concert |
| `football/brighton.html` | `football/` | Version bump for cache bust |
| `discover-pages.js` | `functions/api/` | Stub generators use correct pattern |
| `football.js` | `functions/api/` | 31 clubs, single-word fallback |
| `concert.js` | `functions/api/` | Hyphenated slug fallback |
| `theatre.js` | `functions/api/` | Slug fallback |
| `sitemap.xml` | repo root | 145 URLs |
| `llms.txt` | repo root | AI crawler instructions |
| `robots.txt` | repo root | AI bot whitelist |
| `_headers` | repo root | Content type headers |

---

## Google Search Console + Bing setup (pending — manual steps)

### Google Search Console
1. Go to **search.google.com/search-console** → sign in with ticketscout Gmail
2. **Add property** → **Domain** → enter `ticketscout.co.uk`
3. Copy the TXT verification record Google gives you
4. Cloudflare → ticketscout.co.uk → **DNS** → Add TXT record: Name=`@`, Value=paste string
5. Back in GSC → **Verify**
6. Go to **Sitemaps** → submit `sitemap.xml`

### Bing Webmaster Tools
1. Go to **bing.com/webmasters** → **Sign in with Google** → use ticketscout Gmail
2. Add site → choose **Auto-verify via Google Search Console** (fastest)
3. Submit `sitemap.xml`

---

## Affiliate status

| Programme | Network | Commission | Status |
|---|---|---|---|
| Skiddle | Direct | 30% of fee | ✅ Live |
| Gigsberg UK | Awin | 5% | ✅ Live |
| Theatre Tickets Direct | Awin | TBC | ✅ Live |
| Football TicketNet UK | Awin | 3.86% EPC | ✅ Live |
| Football TicketNet DE/US | Awin | TBC | ✅ In feed |
| SportsEvents365 | Direct | 7% | ✅ Sandbox. Awaiting SE365_PROD=true from Nir |
| StubHub International | Impact | 9% | Pending |
| StubHub/viagogo | Partnerize | 3.5-4% | Pending |
| Eventim UK | Awin | 1.5% | Pending |
| See Tickets | Awin | TBC | ❌ Rejected twice |
| Ticketmaster UK | Impact | ~1% | ❌ Declined (excludes comparison sites) |
| Vivid Seats | Impact | 6% | Pending |
| MegaSeats | Impact | 5% | Pending |
| TicketNetwork | Impact | 12.5% | Pending — highest commission |
| Ticombo | Partnerize | 6% | Pending |
| ATG/LOVEtheatre | Partnerize | TBC | Pending |
| Event Tickets Center | Rakuten | TBC | Pending (applied 05 Jul) |
| TicketNetwork | Rakuten | TBC | Pending (applied 05 Jul) |
| Etickets | Rakuten | TBC | Pending (applied 05 Jul) |
| MoreTickets | Rakuten | TBC | Pending (applied 05 Jul) |
| TicketSmarter | CJ | 3% | Pending (applied 05 Jul) |
| SOLDOUT.COM | CJ | TBC | Pending (applied 05 Jul) |
| TicketLiquidator | CJ | TBC | Pending (applied 05 Jul) |

---

## Roadmap — next session priorities

1. **Deploy the outstanding commit** (all files listed above) — do this first
2. **Pull repo locally** (GitHub Desktop Fetch → Pull) to get auto-discovered pages
3. **Regenerate all 36KB stubs** — replace every file >10KB in football/ and theatre/ with correct 1KB stubs using the concert pattern
4. **Check affiliate approvals** — Rakuten, CJ, Impact applied 05 Jul
5. **Google Search Console + Bing** setup (manual steps above)
6. **Brighton cache investigation** — if still blank after deploy, check Cloudflare Workers logs for that specific URL
7. **SE365 production credentials** — chase Nir, set SE365_PROD=true
8. **Full site audit** — go through every page systematically before scaling traffic

---

## Working notes / gotchas

- **Stub pattern:** Use EXACT concert stub pattern — greedy regex, no style copying, scripts appended to body. Any deviation causes blank pages.
- **football.html dependency:** All football stubs fetch this file at runtime. Fix football.html first, then stubs inherit the fix automatically.
- **theatre.html dependency:** Same as above for theatre stubs.
- **`_redirects` critical rule:** Never add `/football/*` catch-all. Breaks static routing → Error 1101.
- **No football/theatre [slug].js functions:** These were tried and caused 522 timeout loops. The concert function works only because `functions/concert/[slug].js` doesn't match `/concert.html` (root file).
- **Description length check (80 chars):** The football/theatre API synthesises short descriptions for unknown slugs. Only hardcoded entries have >80 char descriptions. The 80-char check in events.js prevents generic words routing to football.
- **Cloudflare managed robots.txt:** Was blocking AI crawlers. Now disabled via Security → Bots → AI Crawl Control → Robots.txt → Disable.
- **AI crawler settings:** ClaudeBot, GPTBot, CCBot, Google-CloudVertexBot, Claude-User, Cloudflare Crawler should be unblocked in AI Crawl Control.
- **KV namespace ID:** `bc766f3f7b284869a0b249a590eb4fcf` (bound as `GIGSBERG_KV`)
- **SE365 sandbox:** HTTP Username `ticketscout`, Password `0eMPcY5v3j5z`, API Key `17ce93e26c2dcf97a9f499b847037bc2`
- **SE365 production:** set `SE365_PROD=true` in Cloudflare Variables and trigger `/api/sportsevents365-cache?trigger=1`
- **Debug tools in awin-events.js:** `?merchants=1`, `?dates=1`, `?scan=`, `?chunk=N` — remove before significant traffic
- **GitHub Desktop:** Commit to main button stays inactive until Summary field has text
- **Awin feed:** `Content-Type: application/gzip` but `Content-Encoding` not set — must manually pipe through `DecompressionStream('gzip')`
- **Feed column mismatch:** Gigsberg=86 cols, Football TicketNet=60 cols. `in_stock` filter only applied when `fields.length >= 55`
