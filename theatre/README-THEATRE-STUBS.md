# Theatre Stub Regeneration — 15 files
**12 Jul 2026**

## What these are
These 15 files replace the drifted stubs that were in your sitemap but
had `<title>Loading…</title>` and no canonical tag — meaning Google
could see them but couldn't index them properly.

## What's fixed in every file
- Real `<title>` e.g. "Hamilton Tickets | Compare Prices | TicketScout"
- Real `<meta name="description">`
- `<link rel="canonical">` pointing to apex URL (no www)
- `window.__THEATRE_SLUG__` set correctly
- Fetches `theatre.html?v=20260712a` (current version)
- No www.ticketscout.co.uk anywhere

## Where to put them
Drop all 15 .html files into the ROOT of your repo
(same folder as football.html, concert.html etc — NOT inside a /theatre/ subfolder).
They are already in your repo at root level; these replace them.

## Files
a-midsummer-nights-dream.html    → /theatre/a-midsummer-nights-dream
avenue-q.html                    → /theatre/avenue-q
be-like-blippi.html              → /theatre/be-like-blippi
beetlejuice-the-musical.html     → /theatre/beetlejuice-the-musical
berlin.html                      → /theatre/berlin
big-bad-wolf.html                → /theatre/big-bad-wolf
bill-bailey-vaudevillean.html    → /theatre/bill-bailey-vaudevillean
billy-elliot-the-musical.html    → /theatre/billy-elliot-the-musical
black-is-the-color-of-my-voice.html → /theatre/black-is-the-color-of-my-voice
cabaret.html                     → /theatre/cabaret
dirty-dancing.html               → /theatre/dirty-dancing
hadestown.html                   → /theatre/hadestown
hamilton.html                    → /theatre/hamilton
into-the-woods.html              → /theatre/into-the-woods
les-miserables.html              → /theatre/les-miserables

## Deploy
Copy all 15 files to repo root → commit in GitHub Desktop
("Fix 15 drifted theatre stubs — canonical + real titles")  → push.

## Verify after deploy (pick any 3)
https://ticketscout.co.uk/theatre/hamilton     → title should be "Hamilton Tickets | Compare Prices | TicketScout"
https://ticketscout.co.uk/theatre/les-miserables  → should load the compare table normally
https://ticketscout.co.uk/theatre/hadestown   → should load the compare table normally
