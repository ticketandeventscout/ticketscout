# TicketScout — Project Summary (updated 05 July 2026 — late evening)

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
5. Any pending actions the human needs to take

---

## ⚠️ NO GUESSWORK RULE — mandatory before any fix

Before writing any fix, a specific error must be confirmed via one of:
- Browser console error message (e.g. `SyntaxError: missing ) at line 654`)
- Network tab showing specific HTTP status (404, 522, redirect loop)
- Console log output from a `fetch().then(r => console.log(r.status))` test

**Never fix based on assumption.** Every hour lost today came from fixing the wrong layer. Confirmed evidence first, code second.

---

## Architecture

- **Frontend:** Single `index.html` with hash-based router in `events.js`
- **SEO pages:** Static stubs at `/concert/[slug]`, `/football/[slug]`, `/theatre/[slug]`, `/venue/[slug]`
- **Backend:** Cloudflare Pages Functions at `functions/api/`
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

## ⚠️ CRITICAL: Static page architecture

### The stub pattern — DO NOT DEVIATE

All static files in `football/`, `theatre/`, `concert/` are lightweight stubs. They set a slug variable and fetch the category template at runtime. **Every stub must follow this exact pattern:**

```html
<head>
  <script>window.__FOOTBALL_SLUG__ = 'arsenal';</script>  <!-- or THEATRE/CONCERT -->
  <link rel="stylesheet" href="/styles.css" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
</head>
<body><script>
  (async function() {
    const r = await fetch('/football.html');  <!-- or theatre.html / concert.html -->
    const html = await r.text();
    const sm = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    if (sm) { var st = document.createElement('style'); st.textContent = sm[1]; document.head.appendChild(st); }
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);  <!-- GREEDY * not lazy *? -->
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

**Critical rules:**
1. Greedy `[\s\S]*` for body — lazy `[\s\S]*?` stops too early on large files
2. Lazy `[\s\S]*?` for style — only one style tag so both work, but lazy is safer
3. Scripts appended to `document.body` not `document.head`
4. `window.__X_SLUG__` set in head persists through body innerHTML replacement
5. Style block copied from template head — needed for green/purple hero themes
6. **No** try/catch wrappers — they hide errors
7. **No** `functions/football/[slug].js` or `functions/theatre/[slug].js` — causes 522 loops

### The template dependency

**Stubs fetch their template at runtime.** Fixing `football.html` automatically fixes all football stubs. If stubs look broken, check the template first before touching stubs.

### The _redirects loop trap

Having `/football → /football.html` in `_redirects` causes `ERR_TOO_MANY_REDIRECTS` because:
- Stubs do `fetch('/football.html')` 
- Cloudflare matches `/football` rule against `/football.html` path
- Infinite redirect loop results

**Current `_redirects`** only has `/concerts → /concert.html`. Football/theatre landing pages are served by `football/index.html` and `theatre/index.html`.

### Why `functions/concert/[slug].js` exists but football/theatre don't

The concert function (`concert__slug_.js`) serves concert pages server-side for slugs without a static file. Football/theatre functions were tried but caused 522 loops — avoid recreating them.

### DOMContentLoaded fix for autocomplete

`autocomplete.js` uses an IIFE instead of `DOMContentLoaded` so it runs immediately when re-appended by stubs. **Do not revert this to DOMContentLoaded.**

### Safe DOM updates in templates

Templates use `setEl()` helper for head element updates (page-title, canonical, og-tags etc). These elements don't exist when loaded via stub, so direct `.textContent =` or `.setAttribute()` would crash. Always use `setEl()` for head elements, direct assignment for body elements.

---

## Data sources per category

| Category | Sources | Notes |
|---|---|---|
| Football | TM + Awin (category filter: football/soccer/sport) | Category filter captures Gigsberg football AND Football TicketNet rows; excludes Gigsberg concerts |
| Theatre | TM + Awin (all merchants) | Theatre Tickets Direct comes through Awin |
| Concert | TM + Awin (all merchants) | Gigsberg is main Awin source |
| All (future) | + SE365 | 7% commission, approved, awaiting production credentials from Nir |

---

## Search routing — how it works everywhere

Both `runSearch()` (homepage) and `handleSearch()` (category pages) use the same parallel three-API check:

```js
const [footballResp, theatreResp, concertResp] = await Promise.all([...]);
const isRichFootball = (footballResp?.team?.description?.length || 0) > 150;
const isRichTheatre  = (theatreResp?.show?.description?.length || 0) > 150;
if (isRichFootball) redirect to /football/[slug]
if (isRichTheatre)  redirect to /theatre/[slug]
if (concertResp)    redirect to /concert/[slug]
```

**The 150-char threshold** separates hardcoded entries (200-350 chars) from synthesised fallbacks (50-90 chars). This prevents long show/artist names (e.g. "Phantom Of The Opera Movie") from accidentally routing to football because their synthesised description exceeds 80 chars.

---

## Routing architecture

```
_redirects (current — do not add to this carelessly):
/concerts  /concert.html   200

football/index.html  → serves /football/ landing page
theatre/index.html   → serves /theatre/ landing page
concert/index.html   → serves /concert/ landing page

NEVER add /football/* catch-all — breaks static routing (Error 1101)
NEVER add /football → /football.html — causes ERR_TOO_MANY_REDIRECTS
```

---

## Auto-discovery pipeline

`discover-pages.js` routes new pages correctly:
- `genreToCategory()` maps genre → folder: football/soccer → `football/`, theatre/musical/opera → `theatre/`, everything else → `concert/`
- Commit path: `` `${category}/${slug}.html` ``
- Generators use correct stub pattern with style copy
- New pages auto-committed by pipeline inherit template fixes automatically

**Outstanding:** ~200 concert pages auto-committed before genre routing was fixed — all correctly sit in `concert/` folder. These work fine since concert stubs fetch `concert.html` at runtime.

---

## Files and their roles

| File | Purpose |
|---|---|
| `index.html` | Homepage — WebSite + SearchAction schema |
| `styles.css` | All shared styling |
| `events.js` | Hash router + homepage rendering. `runSearch()` checks all 3 APIs with 150-char threshold |
| `autocomplete.js` | Search dropdown — IIFE pattern, works on stub pages |
| `concert.html` | Concert template — setEl() for head, decodeHtmlEntities(), cross-category handleSearch() |
| `football.html` | Football template — Awin filtered by category (football/soccer/sport), cross-category handleSearch() |
| `theatre.html` | Theatre template — setEl() for head, decodeHtmlEntities(), cross-category handleSearch() |
| `venue.html` | Venue template |
| `football/index.html` | Football landing page stub |
| `theatre/index.html` | Theatre landing page stub |
| `concert/index.html` | Concert landing page stub |
| `functions/api/concert.js` | Artist data + TM attraction ID. Synthesises from hyphenated slugs. |
| `functions/api/football.js` | Team data + TM attraction ID. Normalises -fc/-afc suffixes. Synthesises for ALL slugs. |
| `functions/api/theatre.js` | Show data + TM attraction ID. Synthesises from slug. |
| `functions/api/ticketmaster.js` | Proxies TM API. Always sets startDateTime=now. |
| `functions/api/awin-events.js` | Searches Awin KV. Returns category field for merchant filtering. |
| `functions/api/awin-category-cache.js` | Fetches Awin feed every 6h, stores in KV. Sets category + genre on queued artists. |
| `functions/api/discover-pages.js` | Auto-discovery pipeline. Genre routing active. |
| `functions/concert/[slug].js` (= `concert__slug_.js`) | Server-side concert router for unknown slugs |
| `llms.txt` | AI crawler instructions |
| `sitemap.xml` | 145 URLs |
| `robots.txt` | AI bot whitelist (Cloudflare managed robots.txt disabled) |
| `_headers` | Content-Type headers for static files |
| `_redirects` | Only `/concerts → /concert.html`. No football/theatre rules. |

---

## Confirmed working (05 Jul 2026 evening)

✅ Football pages — green theme, hero image, fixtures from TM + Awin (football category filter)
✅ Theatre pages — purple theme, hero image, performances from TM + Awin
✅ Concert pages — blue theme, hero image, events from TM + Awin
✅ Cross-category search from any page (football → concert → theatre and back)
✅ Search autocomplete dropdown on all pages
✅ Brighton & Hove Albion — loads correctly
✅ HTML entity decode in descriptions (&mdash; → —)
✅ Homepage category pills (Sports, Concerts, Theatre, Comedy) load filtered events
✅ robots.txt clean, sitemap.xml live, llms.txt live
✅ Cloudflare managed robots.txt disabled — AI crawlers allowed
✅ Schema markup on all templates (FAQPage, BreadcrumbList, MusicEvent/SportsEvent/TheaterEvent)

---

## Affiliate status

| Programme | Network | Commission | Status |
|---|---|---|---|
| Skiddle | Direct | 30% of fee | ✅ Live |
| Gigsberg UK | Awin | 5% | ✅ Live |
| Theatre Tickets Direct | Awin | TBC | ✅ Live |
| Football TicketNet UK | Awin | 3.86% EPC | ✅ Live |
| Football TicketNet DE/US | Awin | TBC | ✅ In feed |
| SportsEvents365 | Direct | 7% | ✅ Approved. Awaiting SE365_PROD=true from Nir |
| StubHub International | Impact | 9% | Pending |
| StubHub/viagogo | Partnerize | 3.5-4% | Pending |
| Eventim UK | Awin | 1.5% | Pending |
| See Tickets | Awin | TBC | ❌ Rejected twice |
| Ticketmaster UK | Impact | ~1% | ❌ Declined |
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

## Roadmap — next session priorities (in order)

### Can be done by Claude without you present

1. **Full site functionality audit** — systematic check of every page, feature, and user flow. Covers: nav links, search flow, event cards, compare block, footer links, mobile responsiveness, all three category pages. Output: structured list of what works, what's broken, what's missing.

2. **Sidebar links expansion** — football and theatre pages show 6 popular links in the sidebar. Extend to full lists: all 31 football clubs, all theatre shows. Simple HTML change in `football.html` and `theatre.html`.

3. **Sitemap regeneration** — current sitemap has 145 URLs but doesn't include all the static pages now committed. Generate a comprehensive sitemap covering all `football/`, `theatre/`, `concert/` stubs.

4. **SE365 integration prep** — once Nir sends production credentials, add SE365 event fetch to `football.html` alongside TM. Draft the code so it's ready to drop in with just the credentials.

5. **Affiliate approval check** — search for status updates on Rakuten, CJ, Impact programmes applied 05 Jul. Draft outreach emails if any have been pending >2 weeks.

6. **Competitor price check** — compare a sample of TicketScout event prices against FanSeats and SeatPick for the same events. Identify any systematic gaps in coverage.

### Requires you to be present (manual steps)

7. **Google Search Console** — verify domain, submit sitemap. Instructions in previous summary.
8. **Bing Webmaster Tools** — import from GSC after GSC verified.
9. **SE365 production activation** — set `SE365_PROD=true` in Cloudflare Variables once Nir sends credentials, then trigger `/api/sportsevents365-cache?trigger=1`.
10. **Affiliate approvals** — log into Rakuten, CJ, Impact dashboards to check status.

---

## Working notes / gotchas

- **Stub pattern:** Style copy uses lazy `[\s\S]*?`, body uses greedy `[\s\S]*`. Never swap these.
- **Template dependency:** Stubs fetch template at runtime — fix the template, all stubs inherit it.
- **_redirects:** Only `/concerts → /concert.html`. Never add football/theatre rules here.
- **150-char threshold:** Separates real hardcoded entries from slug-synthesised fallbacks in routing.
- **Awin football filter:** `category.includes('football') || category.includes('soccer') || category.includes('sport')` — captures Gigsberg football AND Football TicketNet, excludes Gigsberg concerts.
- **setEl() helper:** Always use for head element updates — elements don't exist when loaded via stub.
- **autocomplete.js:** IIFE pattern — never revert to DOMContentLoaded.
- **No football/theatre [slug].js functions:** Causes 522 loops. The concert function is the only one that works.
- **Cloudflare managed robots.txt:** Disabled via Security → Bots → AI Crawl Control → Robots.txt.
- **AI crawlers to unblock:** ClaudeBot, GPTBot, CCBot, Google-CloudVertexBot, Claude-User, Cloudflare Crawler.
- **KV namespace:** `bc766f3f7b284869a0b249a590eb4fcf` (bound as `GIGSBERG_KV`)
- **SE365 sandbox:** HTTP Username `ticketscout`, Password `0eMPcY5v3j5z`, API Key `17ce93e26c2dcf97a9f499b847037bc2`
- **Partnerize publisher ID:** `1110l35929` — lowercase 'l' not '1'
- **Awin feed:** Content-Type `application/gzip` but no Content-Encoding header — must manually pipe through `DecompressionStream('gzip')`
- **Feed column mismatch:** Gigsberg=86 cols, Football TicketNet=60 cols. `in_stock` filter only applied when `fields.length >= 55`
- **Debug tools in awin-events.js:** `?merchants=1`, `?dates=1`, `?scan=`, `?chunk=N` — remove before significant traffic
