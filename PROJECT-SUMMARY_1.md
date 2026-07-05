# TicketScout — Project Summary

**Site:** ticketscout.co.uk — UK ticket price comparison
**Stack:** Static HTML/CSS/JS, hosted on Cloudflare Pages, connected to GitHub (auto-deploys on push)
**Repo:** github.com/ticketandeventscout/ticketscout
**Local workflow:** Edit files locally → GitHub Desktop (commit + push) → Cloudflare Pages auto-deploys

---

## Architecture

- **Frontend:** Single `index.html` page with a lightweight hash-based router (`#/`, `#/search/...`, `#/artist/.../...`, `#/event/...`) implemented in `events.js`. No framework, no build step.
- **Backend:** Cloudflare Pages Functions live in `functions/api/` at the repo root. Each file becomes a serverless endpoint automatically.
- **API keys/secrets:** Stored in Cloudflare dashboard → project → Settings → **"Variables and secrets"**.
- **Cloudflare plan:** Paid (Workers Standard, $5/month) — required for Awin feed cache Worker. Do not cancel.
- **Feed caching:** Awin category feed fetched, decompressed, parsed and stored in KV every 6 hours via cron-job.org → `/api/awin-category-cache?trigger=1`. KV TTL is 7 hours.

## Current env vars

| Variable | Purpose |
|---|---|
| `TM_API_KEY` | Ticketmaster Discovery API |
| `SEATGEEK_CLIENT_ID` | SeatGeek events API |
| `SKIDDLE_AFFILIATE_TAG` | Skiddle affiliate tracking tag (15734) |
| `VIAGOGO_PARTNERIZE_ID` | viagogo/StubHub affiliate ID on Partnerize (1110l35929 — note lowercase 'l' not '1') |
| `AWIN_PUBLISHER_ID` | Awin publisher ID = 2960641 |
| `AWIN_CATEGORY_FEED_URL` | Awin category feed URL — gzip CSV, contains API key (Secret) |
| `GIGSBERG_FEED_URL` | Legacy Gigsberg-specific feed URL — can be retired once awin-category confirmed stable |
| `SPORTSEVENTS365_AFFILIATE_ID` | SportsEvents365 affiliate ID = dvqg90rd8vv1f |

## Files and their roles

| File | Purpose |
|---|---|
| `index.html` | Page shell, nav, hero/search bar, category pills, results container, footer |
| `styles.css` | All styling including artist-picker grid, event detail page, inline comparison block |
| `events.js` | Router + all view rendering: home/trending, search, artist picker, artist dates, event detail |
| `compare.js` | Price comparison adapter pattern — orchestrates all sources in parallel, renders comparison block |
| `functions/api/ticketmaster.js` | Proxies Ticketmaster Discovery API (trending, artist search, event lookup, pagination) |
| `functions/api/attractions.js` | Ticketmaster Attractions Search — resolves free-text to artist(s), scores/ranks, flags tribute acts |
| `functions/api/seatgeek.js` | Proxies SeatGeek events API |
| `functions/api/skiddle.js` | Fetches Skiddle XML affiliate feeds (topsellers + festivals), matches by event name, appends `?sktag=15734` |
| `functions/api/awin-category-cache.js` | Cache Worker — fetches Awin category feed (gzip CSV, ~17k rows, categories 586/588/590/592), stream-parses, writes to KV in 2000-row chunks. Triggered every 6 hours by cron-job.org. Requires paid plan. |
| `functions/api/awin-category.js` | Reads pre-parsed Awin category rows from KV, matches by product_name/primary_artist/event_name, returns best match with merchant name |
| `functions/api/gigsberg.js` | Legacy — superseded by awin-category adapter. Remove once stable. |
| `functions/api/gigsberg-cache.js` | Legacy — superseded by awin-category-cache. Remove once stable. |
| `functions/api/viagogo.js` | Stub — implement once Partnerize/viagogo credentials confirmed |
| `functions/api/eventim.js` | Stub — feed-based adapter, implement once Awin feed URL received post-approval |

## How search/navigation works (Phase 1 — completed)

1. User searches → `/api/attractions` resolves to specific artist(s), scored and ranked server-side
2. Exact match → auto-skips picker, goes straight to artist's UK dates
3. Multiple matches → artist picker shown; tribute acts labelled in grey italic
4. No attraction match → falls back to Ticketmaster keyword event search with "Load more" pagination
5. Each event has its own page (`#/event/<id>`) with venue info and inline price comparison
6. Browser back/forward and bookmarking work via hash-based URL state

## Completed so far

- ✅ API keys moved server-side into Cloudflare Pages Functions
- ✅ Both Ticketmaster and SeatGeek keys rotated
- ✅ Legal disclaimer added to footer
- ✅ Phase 1 core flow: artist-resolution search, per-event detail pages, inline price comparison
- ✅ Artist disambiguation: exact match auto-skips picker, tribute acts labelled
- ✅ Pagination for venue/festival keyword searches (Load more button)
- ✅ Source adapter pattern in compare.js — parallel orchestration, easy to add new sources
- ✅ SeatGeek adapter wired in
- ✅ Skiddle affiliate integration: XML feed proxy, name matching, affiliate tag on outbound links
- ✅ **Awin category feed adapter** — covers all approved Awin merchants (currently Gigsberg UK + Theatre Tickets Direct); new merchants appear automatically on approval; stream-parsed gzip CSV → KV → comparison block
- ✅ Cron job on cron-job.org: Awin category feed refresh every 6 hours
- ✅ TicketScout logo designed and exported (SVG, PNG, JPG)
- ✅ Affiliate programme guide document produced
- ✅ **Ticketmaster comparison row logic updated** — TM now hidden from comparison block when other sellers show prices and TM has no price; shown only when it has a price alongside others, or when it is the only source available
- ✅ **FAQ page built** (`faq.html`) — 11 questions covering what TicketScout is, sellers compared, pricing accuracy, booking fees, primary vs secondary market explanation, safety, commission transparency, and search. Accordion UI, CTA back to homepage. Scope kept generic (not UK-only) to support international expansion
- ✅ **Privacy Policy built** (`privacy.html`) — UK GDPR and Data (Use and Access) Act 2025 compliant. Covers data collection, lawful basis, cookies and affiliate tracking, data sharing, third-party links, retention, user rights, complaints process (including ICO). Infrastructure and affiliate networks referred to generically — no specific company names disclosed to protect competitive information
- ✅ **Terms of Use built** (`terms.html`) — covers what TicketScout is, affiliate disclosure (legally required under CPUTR 2008), pricing accuracy, primary/secondary market, third-party seller responsibility, no liability clause, IP, acceptable use, governing law
- ✅ **Contact page built** (`contact.html`) — form with name, email, subject dropdown, message. Honeypot spam protection. Submits to `/api/contact` Pages Function which forwards to ticketandeventscout@gmail.com via Resend API. Email address never exposed publicly
- ✅ **Contact form Pages Function built** (`functions/api/contact.js`) — server-side validation, honeypot check, HTML-escaped email body, reply-to set to sender so responses go directly back to them. Requires `RESEND_API_KEY` secret in Cloudflare dashboard
- ✅ **All footer links live** across index, faq, privacy, terms, contact pages — Privacy Policy · Terms of Use · FAQ · Contact

## Competitive Analysis Findings (July 2026)

Sites reviewed: ticket-compare.com, seatpick.com, comparetheticketprice.com, stereoboard.com, viagogo.co.uk, ticombo.com, seatsearch.co, ticketwhiz.com, event-spy.com, comparetheatretickets.com

### Key findings

**Biggest SEO gap — no indexable pages**
Every successful site has dedicated static pages for artists, venues, cities and competitions (e.g. `/concert/metallica`, `/venues/wembley-stadium`, `/cities/london`). These rank for long-tail searches and drive the majority of organic traffic. TicketScout's hash-based routing (`#/event/...`) is invisible to Google — this must be resolved before any other SEO work.

**What works well on competitors (features to adopt):**
- Static artist/venue/city pages with upcoming events (ticket-compare, SeatPick) — SEO critical
- Interactive seat maps with colour-coded price zones (SeatPick) — highest-converting feature
- Price alerts and historical price tracking (event-spy) — strong differentiator, drives return visits
- Email newsletter / "Get notified" capture (ticket-compare claims 70k subscribers)
- Seller review pages (`/reviews/stubhub`, `/reviews/viagogo`) — rank for high-intent searches
- Horizontal scrolling carousels on home page (SeatPick) — more engaging than static grid
- FAQ page — trust + SEO, pure content
- Currency switcher (GBP/EUR/USD) — ticket-compare operates in 10 languages/countries
- "Shows ending soon" section — creates urgency (comparetheatretickets)
- Tour news / editorial content — stereoboard drives traffic via news articles that convert to ticket clicks
- Social proof — real user quotes and fan counts more convincing than static trust bar

**What doesn't work (avoid):**
- Mega-menus with hundreds of links — overwhelming on mobile
- JavaScript-only rendering (event-spy) — invisible to search engines
- Slow single-bundle client-side loading (comparetheticketprice.com)

### Prioritised feature list

**Priority 1 — Foundational:**
1. Static/SEO-indexable artist, venue and city pages — prerequisite for all SEO
2. ~~Email capture / newsletter signup~~ — replaced by social media strategy (see Phase 5)
3. FAQ page — trust + SEO, content only ✅ in progress
4. Browse by city and venue (Phase 4, already planned)

**Priority 2 — UX improvements:**
5. Horizontal carousels on home page (trending, top artists, upcoming)
6. Seller review pages — content-driven, SEO and trust
7. Currency switcher (GBP/EUR/USD)
8. "Shows ending soon / last tickets" section

**Priority 3 — Complex, high value:**
9. Price alerts — email notification when price drops below threshold
10. Historical price chart per event
11. Interactive seat map with price zones
12. Theatre/meal deal bundles (London events)

**Priority 4 — Future:**
13. Multi-language support (separate domains per language, ticket-compare model)
14. Tour announcement news / editorial content

### New affiliates identified from competitor source code

| Merchant | Network | Market | Priority |
|---|---|---|---|
| Ticombo | Direct (own programme) | International secondary | ⭐ High — London office, 1M+ FB |
| Vivid Seats | Impact | US secondary | Medium |
| SportsEvents365 | TBC | International | Medium |
| TicketNetwork | Direct | US secondary | Low |
| viagogo via Impact | Impact | Check if separate from Partnerize | Check first |

## Phase 3 — Affiliate status

| Programme | Network | Commission | Cookie | Status |
|---|---|---|---|---|
| StubHub International | Impact | 9% | 30 days | Accepted invite, pending StubHub confirmation |
| StubHub / viagogo | Partnerize | ~3.5–4% | 30 days | Signed up, awaiting programme approval |
| Eventim UK | Awin | 1.5% | 30 days | Awaiting approval (~130 day payment cycle) |
| Skiddle | Direct | 30% of fee | 30 days | ✅ Approved — live |
| Gigsberg UK | Awin | 5% | 30 days | ✅ Approved — live via Awin category feed |
| Theatre Tickets Direct | Awin | TBC | TBC | ✅ Live via Awin category feed |
| See Tickets | Awin | TBC | TBC | ❌ Rejected twice — revisit when site more complete |
| AXS | Sovrn | TBC | TBC | Pending review |
| Ticketmaster UK | Impact | ~1% | 1 day | ❌ Declined — excludes price comparison sites |
| Ticombo | Partnerize | 6% | 30 days | Pending — applied via join.partnerize.com/ticombo |
| SportsEvents365 | Direct (aff.sportsevents365.com) | 7% | TBC | ✅ Approved — API credentials requested, application form submitted, affiliate ID in Cloudflare |
| Vivid Seats | Impact | 6% | 30 days | Pending — applied. Last click, 30-day cookie, USD payments. No MLB baseball (-50%), no branded/non-branded paid search, no Yahoo referrals. |
| MegaSeats | Impact | 5% | 30 days | Pending — applied. Locks 27 days after month end, paid 20 days after lock. USD. |
| TicketNetwork | Impact | 12.5% (up to 14.5% at $20k+/month) | 30 days | Pending — applied. Excellent tiered structure. USD. Locks 15 days after month end, paid immediately on lock. |
| LiveFootballTickets | Awin | TBC | TBC | Pending existing Awin request |
| Gametime | Direct | TBC | TBC | No affiliate programme found on their own site — skip for now |
| Motorsport Tickets | Awin | TBC | 81.69% approval | Pending |
| adticket.de | Awin | TBC | 100% approval | Pending — has product feed |
| oeticket.com AT | Awin | TBC | 100% approval | Pending — has product feed |
| SuperStar Tickets US | Awin | TBC | 100% approval | Pending — no feed, lower priority |
| Events365 US | Awin | TBC | 87.32% approval | Pending — no feed, lower priority |
| Tiqets FR | Awin | TBC | 94.23% approval | Pending |
| Tiqets DE | Awin | TBC | 88.97% approval | Pending |
| Football TicketNet US | Awin | TBC | 83.63% approval | Pending — has product feed ⭐ |
| Football TicketNet UK | Awin | 3.86% EPC £0.70 | 85.89% approval | Pending — has product feed ⭐ |
| eventim DE | Awin | TBC | 99.12% approval | Pending |
| VivaTicket IT | Awin | TBC | 98.29% approval | Pending |
| Ticketone IT | Awin | TBC | 97.06% approval | Pending — has product feed |

**Key commission notes:**
- TicketNetwork at 12.5% base (up to 14.5%) is the highest commission rate of any programme applied to — prioritise integration once approved
- SportsEvents365 at 7% is strong — ✅ already approved, discuss next steps
- Ticombo at 6% and Vivid Seats at 6% are solid secondary market rates
- MegaSeats at 5% — lower but worth having for US inventory depth
- All Impact programmes (Vivid Seats, MegaSeats, TicketNetwork) pay in USD — currency conversion applies

**⭐ = highest priority once approved**

**Key notes:**
- All new Awin approvals feed into the Awin category feed automatically — no code changes needed per merchant
- Football TicketNet UK is the most exciting pending approval — strong EPC, UK football focus
- Ticketmaster explicitly excludes price comparison sites — not worth reapplying
- Primary market affiliates want a more complete site — revisit See Tickets when UX improvements are done

## Immediate to-do list

### Bug fixes / UX improvements — completed
1. ✅ **Removed "Ticketmaster" source badge from search result cards** — replaced with "Compare prices →"
2. ✅ **Fixed price matching per event** — now matches on event date extracted from Gigsberg description field, not just artist name across all listings globally
3. ✅ **Logo added to website** — ticket icon + "TicketScout" wordmark + "compare. save. enjoy." tagline in navbar; full logo in footer. Both click through to homepage.
4. ✅ **Impact verification meta tag removed** from `index.html`
5. ✅ **Logo click → homepage** — confirmed working
6. ✅ **Legacy gigsberg.js and gigsberg-cache.js removed** from repo
7. **Fix Gigsberg deep-link specificity** — the Awin affiliate link still goes to the general performer page on Gigsberg rather than a specific event/date. Gigsberg's feed only provides performer-level deep links, not event-level. Options: (a) accept this limitation for now, (b) investigate whether Gigsberg's API or a different feed format provides event-specific URLs, (c) raise with Gigsberg account manager when relationship develops

### Content / legal pages — completed this session
- ✅ FAQ page (11 questions, generic scope, accordion UI)
- ✅ Privacy Policy (UK GDPR + Data Use and Access Act 2025 compliant, no competitive info disclosed)
- ✅ Terms of Use (affiliate disclosure, pricing disclaimer, primary/secondary market, no liability)
- ✅ Contact page with form (honeypot spam protection, email forwarding via Resend)
- ✅ All footer links updated across all pages

### Pending action — Resend setup (required for contact form to work)
1. Sign up free at resend.com
2. Create an API key in the Resend dashboard
3. Add it to Cloudflare Pages → Settings → Variables and secrets as: `RESEND_API_KEY` (mark as Secret)
4. Verify `ticketscout.co.uk` as a sending domain in Resend (adds 2–3 DNS records — Cloudflare makes this straightforward)
5. Once verified, the `FROM_ADDRESS` in `contact.js` (`contact@ticketscout.co.uk`) will work. Until then you can temporarily use Resend's shared test address for initial testing

### Competitive analysis task
- ✅ Completed — 10 sites reviewed (ticket-compare, SeatPick, comparetheticketprice, stereoboard, viagogo, ticombo, seatsearch, ticketwhiz, event-spy, comparetheatretickets)
- Findings and prioritised feature list captured in Competitive Analysis section above

## Roadmap

**Phase 2 — remaining adapter work**
- **SportsEvents365 — PRIORITY NEXT BUILD** — already approved (7% commission), affiliate ID live in Cloudflare (`SPORTSEVENTS365_AFFILIATE_ID = dvqg90rd8vv1f`), API application form submitted to Nir at SportsEvents365. Waiting for API credentials (apiKey + Basic Auth) to be returned before adapter can be built. Once received, build `functions/api/sportsevents365.js` as a real-time REST API adapter (same pattern as SeatGeek/Ticketmaster — no feed caching needed). API docs at `api-v2-docs.sportsevents365.com`. Sports-focused inventory (football, F1, rugby etc.) — fills a gap that Gigsberg and Theatre Tickets Direct don't cover well. This is the most important pending integration.
- Implement viagogo adapter in `functions/api/viagogo.js` once Partnerize programme approved and tracking link format confirmed
- Implement Eventim adapter in `functions/api/eventim.js` once Awin feed URL received
- Wire StubHub International affiliate tracking once Impact approval confirmed
- Clean up legacy gigsberg.js and gigsberg-cache.js from repo

**Phase 4 — Discovery/UX**
- **Use Awin category feed as parallel event discovery source** — surface ALL merchants in the feed (Gigsberg UK, Theatre Tickets Direct, Football TicketNet UK once approved, etc.) as searchable and browsable events alongside Ticketmaster. Currently the feed only surfaces in the comparison block on a Ticketmaster event page — it should also power search results and the home page. International events in the feed (European concerts, sports etc.) should become discoverable even when Ticketmaster has no listing. This significantly expands the catalogue and is a key differentiator.
- **viagogo/StubHub as discovery + comparison source** — once Partnerize programme approved, viagogo's massive international event catalogue should power both event discovery (surfacing events not on Ticketmaster) and price comparison. Largest secondary market inventory globally — major catalogue expansion opportunity.
- **Skiddle discovery section** — surface Skiddle events as "More events you might like" section (club nights, local events not on Ticketmaster)
- **Extend search to multiple sources** — search results currently Ticketmaster-only; pull from Awin feed, viagogo, SeatGeek too
- **Category/city/date filtering** — browse by genre, location, date range
- General UX improvements based on competitive analysis findings

**Long-term discovery source vision:**
- Ticketmaster API — primary UK events
- Awin category feed — all approved merchants, grows automatically with each new approval
- viagogo/StubHub — massive international secondary market catalogue
- Skiddle — UK club nights and smaller venues
- The more discovery sources, the more unique events TicketScout surfaces that no single platform shows — this is the core competitive moat

**Awin Summer 2026 release — relevant to TicketScout:**
- **Campaigns Marketplace** — check Awin dashboard for active bonus commission campaigns from approved merchants (e.g. double commission weekends, festival bonuses). No technical work required — pure revenue opportunity.
- Earnings Widget and Enriched Links are dashboard/UX improvements on Awin's side, not actionable for the codebase.

**Phase 5 — Growth/ops**
- **Full site functionality audit (prerequisite to all Phase 5 work)** — go through every section and feature of the site systematically: what works, what's broken, what's missing, what should be removed. Covers navigation, search flow, event cards, comparison block, footer, mobile responsiveness, and anything else surfaced during the audit. Complete this before SEO or analytics work.
- Google Analytics — add after audit complete
- SEO — add after audit complete
- Move project files off laptop to a backed-up location
- Reapply to See Tickets once UX improvements are complete

**Phase 5 — Social media strategy**
- **Decision:** No email newsletter — GDPR compliance overhead, content commitment, and platform costs make it impractical at this stage. Social media is the better channel for TicketScout right now.
- **Platform:** To be decided — X/Twitter (UK gig/event chat), Instagram (visual event content), and TikTok (high reach, younger audience) are the strongest candidates for a UK ticket/events audience.
- **Content approach:** TicketScout content is highly data-driven (price comparisons, event announcements, deal alerts) which makes AI automation particularly effective. No need for an expensive AI social media tool.
- **Planned stack (£0 additional cost):**
  - **Claude** — generate post content in batches (e.g. "write 10 posts comparing ticket prices for upcoming UK events"). Data-driven format means posts practically write themselves once the event/price data is provided. Use Claude to draft batches covering price comparisons, event spotlights, deal alerts, and affiliate highlights.
  - **Buffer (free tier)** — schedule and publish across up to 3 platforms, 10 posts per channel. Upgrade to paid ($5/month per channel) only if posting volume outgrows the free tier.
- **When to start:** After the site audit is complete and there is a polished, populated site worth promoting. Setting up social accounts before the site is ready risks first impressions working against affiliate approvals.
- **Implementation steps when ready:**
  1. Set up social accounts (platform TBD)
  2. Add social follow links to site footer
  3. Use Claude to generate first batch of posts
  4. Schedule via Buffer free tier
  5. Review performance after 4–6 weeks before investing in paid tools

## Working notes / gotchas

- GitHub Desktop: "Commit to main" button stays inactive until Summary field has text. LF→CRLF warning is informational only.
- Cloudflare Pages Functions auto-deploy on every push — no separate deploy step.
- Set Variables and secrets in both Production and Preview environments.
- Skiddle XML feeds block browser/curl access — work fine from Cloudflare server-side proxy.
- Awin feed: Content-Type is `application/gzip` but Content-Encoding is NOT set — must manually pipe through `DecompressionStream('gzip')`.
- Awin category feed: standard 73-column CSV (unlike Gigsberg merchant feed which was 3-field JSON blob). Column indices hardcoded in `awin-category-cache.js` — if feed columns change, update COL map.
- KV namespace ID: `bc766f3f7b284869a0b249a590eb4fcf` (bound as `GIGSBERG_KV`)
- Cloudflare paid plan is required — do not cancel while Awin feed caching is live.
- Partnerize publisher ID: `1110l35929` — lowercase letter 'l' not number '1', easy to misread.
