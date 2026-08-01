// ============================================================================
// TicketScout — normaliseFixtureName Live Verification (read-only, safe)
// Runs at /api/normalise-fixture-test?trigger=1
//
// H6 (1 Aug 2026) adds normaliseFixtureName() to ticketmaster.js,
// sportsevents365.js, awin-events.js and awin-category-cache.js so upstream
// feed variants of the SAME fixture converge on the SAME /event/ slug
// instead of minting duplicate pages. Unlike most fixes tonight, this one
// has no user-facing URL to test directly — it only runs when the discovery/
// feed-refresh crons capture NEW events. This endpoint calls the exact same
// function, copied verbatim from the deployed ticketmaster.js, against a
// fixed battery of known cases (the 5 real duplicate clusters the original
// Session 16 audit found, plus non-fixture safety checks) — so you can
// confirm the LIVE deployed code behaves correctly without waiting for a
// real cron cycle to happen to produce a duplicate.
//
// !! MUST MATCH !! the normaliseFixtureName copy in ticketmaster.js,
// sportsevents365.js, awin-events.js, awin-category-cache.js. If this
// endpoint's output ever disagrees with what a live discovery run produces,
// that itself is a signal one of the four copies has drifted out of sync.
//
// No bindings required — pure function test, no KV/D1/GitHub involved.
// Safe to delete once H6 is confirmed working end-to-end on real feed data.
// ============================================================================

// ---- verbatim copy from ticketmaster.js (1 Aug 2026) ----
function normaliseFixtureName(name) {
  let n = String(name || '');
  const COMPETITION_PREFIXES = [
    'pre-season friendly', 'club friendly', 'international friendly', 'friendly',
    'first qualifying round', 'second qualifying round', 'third qualifying round',
    'play-off round', 'group stage', 'quarter-final', 'semi-final', 'final',
    'premier league', 'efl cup', 'carabao cup', 'fa cup',
    'uefa champions league', 'uefa europa league', 'uefa conference league',
    'champions league', 'europa league', 'conference league'
  ];
  for (const p of COMPETITION_PREFIXES) {
    const re = new RegExp('^\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-\u2013\u2014]\\s*', 'i');
    if (re.test(n)) { n = n.replace(re, ''); break; }
  }
  n = n.replace(/^\s*(matchday\s*\d+|round\s+of\s+\d+)\s*[:\-\u2013\u2014]\s*/i, '');
  n = n.replace(/\s+vs?\.?\s+/gi, ' vs ');
  const stripSuffix = (side) => side
    .replace(/\./g, '')
    .replace(/\s+(fc|afc|cf|sc|ac|sk|bk|if|tc)$/i, '')
    .trim();
  const parts = n.split(/\s+vs\s+/i);
  if (parts.length === 2) {
    const sides = [stripSuffix(parts[0]), stripSuffix(parts[1])].sort((a, b) => a.localeCompare(b));
    n = sides[0] + ' vs ' + sides[1];
  }
  return n.trim();
}
function tsEventSlug(category, date, name) {
  if (!category || !date || !name) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const norm = String(name).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
  return norm ? category + '-' + date + '-' + norm : null;
}
// ---- end verbatim copy ----

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return json({ usage: '?trigger=1 — run the fixed test battery' }, 200);
  }

  // The 5 real duplicate clusters the original Session 16 audit found,
  // reconstructed as plausible raw feed name pairs for the same date.
  const cases = [
    { label: 'QPR vs Fiorentina', date: '2026-07-25',
      a: 'Queens Park Rangers vs ACF Fiorentina',
      b: 'Pre-Season Friendly: Queens Park Rangers v ACF Fiorentina' },
    { label: 'Celtic vs Milan', date: '2026-07-25',
      a: 'Celtic FC vs AC Milan',
      b: 'Celtic v AC Milan' },
    { label: 'Chelsea vs W. Sydney', date: '2026-07-28',
      a: 'Chelsea vs Western Sydney Wanderers FC',
      b: 'Chelsea F.C. v Western Sydney Wanderers FC' },
    { label: 'Liverpool vs Sunderland', date: '2026-07-25',
      a: 'Liverpool vs Sunderland',
      b: 'Liverpool vs Sunderland AFC' },
    { label: 'Liverpool vs Wrexham (order drift)', date: '2026-07-29',
      a: 'Liverpool FC v Wrexham AFC',
      b: 'Wrexham vs Liverpool' }
  ];

  const results = cases.map(c => {
    const slugA = tsEventSlug('football', c.date, normaliseFixtureName(c.a));
    const slugB = tsEventSlug('football', c.date, normaliseFixtureName(c.b));
    return {
      label: c.label,
      rawA: c.a, rawB: c.b,
      normalisedA: normaliseFixtureName(c.a),
      normalisedB: normaliseFixtureName(c.b),
      slugA, slugB,
      collapsed: slugA === slugB && slugA !== null
    };
  });

  // Non-fixture safety check — single-act names must pass through untouched,
  // never mistaken for a "vs"-joined fixture.
  const safetyChecks = [
    'Coldplay',
    'AC Milan Legends Charity Concert',
    "Coldplay: Music of the Spheres Tour"
  ].map(name => ({
    name,
    normalised: normaliseFixtureName(name),
    unchanged: normaliseFixtureName(name) === name
  }));

  const allCollapsed = results.every(r => r.collapsed);
  const allSafe = safetyChecks.every(s => s.unchanged);

  return json({
    message: allCollapsed && allSafe
      ? 'PASS — all 5 known duplicate clusters collapse to one slug, all 3 non-fixture names pass through untouched.'
      : 'CHECK NEEDED — see results/safetyChecks for which case failed.',
    allDuplicatesCollapsed: allCollapsed,
    allNonFixtureNamesSafe: allSafe,
    results,
    safetyChecks
  }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
