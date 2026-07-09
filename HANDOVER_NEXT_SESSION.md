# TicketScout — Session Handover
# Date: 09 July 2026 — End of Session 5

---

## COMPLETED THIS SESSION

### New affiliates integrated
- **Hotels.com UK** (CJ 5275597) + **Trivago UK** (CJ 7717732) — hotel card on event detail pages
- **TicketNetwork** (Impact campaign 2322) — compare table + event list. 193k events via XML API
- **Ticombo** (Partnerize, 9 campaigns) — compare table, region-aware camref routing

### Architecture improvements  
- Event detail page now shows "Where to stay" hotel card below compare table
- All 31 football stubs regenerated with correct absolute paths
- TicketNetwork XML parser built with &amp; entity decoding and chunked pagination

---

## OUTSTANDING — DO FIRST NEXT SESSION

### 1. TicketNetwork cache — needs 13 runs to complete
Run this until you see "done": true:
```
https://ticketscout.co.uk/api/ticketnetwork-cache?trigger=1
```
Then add to cron-job.org weekly.

### 2. Ticombo feeds — check if now available
Partnerize said "available within 4 hours". Try:
```
https://ticketscout.co.uk/api/ticombo-cache?trigger=1&test=1
```
If feeds return 200, run:
```
https://ticketscout.co.uk/api/ticombo-cache?trigger=1
```

### 3. SE365 cron job
Add to cron-job.org: Mon 00:15 UTC
```
https://ticketscout.co.uk/api/sportsevents365-cache?trigger=1
```

### 4. Affiliate tracking verification
Per the tracking checklist in PROJECT-SUMMARY_1.md:
- Click Hotels.com link from an event detail page → verify in CJ dashboard
- Click TicketNetwork link → verify in Impact dashboard  
- Click Ticombo link → verify in Partnerize dashboard

### 5. Hotels.com imagery
Hotel card shows text buttons only. Add hotel imagery/styling later.

---

## CRON JOBS (cron-job.org) — CURRENT STATE
| Time (UTC) | URL | Status |
|---|---|---|
| Mon 00:00 | /api/awin-category-cache?trigger=1 | ✅ Active |
| Mon 00:10 | /api/discover-pages?trigger=1&phase=commit | ✅ Active |
| Mon 00:15 | /api/sportsevents365-cache?trigger=1 | ⚠️ ADD THIS |
| Mon 00:20 | /api/vividseats-cache?trigger=1 | ✅ Active |
| Every 6hrs | GitHub Action: vividseats-feed.yml | ✅ Active |
| Weekly TBD | /api/ticketnetwork-cache?trigger=1&reset=1 then ?trigger=1 x13 | ⚠️ TO DO |

---

## KEY ENV VARS (all set in Cloudflare Pages)
- SE365_PROD: true ✅
- IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN (rotated today) ✅
- IMPACT_FTP_USER, IMPACT_FTP_PASS ✅
- PARTNERIZE_API_KEY, PARTNERIZE_USER_KEY, PARTNERIZE_PUBLISHER_ID ✅
- SPORTSEVENTS365_AFFILIATE_ID: dvqg90rd8vv1f ✅
- CJ Publisher ID: 101816942 (hardcoded in hotels.js — not an env var) ✅

## WORKING FILES RULE
Always use /home/claude/ working copies.
NEVER read from /mnt/project/ to verify fixes — it's a stale snapshot.
