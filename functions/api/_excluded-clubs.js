// ===========================
// TicketScout — shared exclusion test for English / Welsh club fixtures
// File location: functions/api/_excluded-clubs.js
// ===========================
//
// R7 (20 Oct 2026): fixtures involving an English or Welsh club are removed
// from the site (business decision, Sept 2026). The earlier work stopped them
// being REGISTERED and listed in the sitemap, but the live list endpoints
// still returned them and already-registered event pages still rendered.
// This module is the single place the API middleware uses to recognise them
// in response bodies.
//
// The club list MUST STAY IN SYNC with EXCLUDED_FOOTBALL_CLUB_PATTERN in
// functions/event/[slug].js (same clubs, same word-boundary rules).
//
// A name is only treated as a fixture when it also has a "vs" / "v" /
// "versus" separator. That keeps club-named non-fixtures (a concert at a
// venue in a club's city, "Reading Festival", "Brighton Pride") untouched.

export const EXCLUDED_FOOTBALL_CLUB_PATTERN = new RegExp(
  '\\b(arsenal|aston\\s+villa|bournemouth|brentford|brighton|burnley|chelsea|' +
  'coventry\\s+city|crystal\\s+palace|everton|fulham|hull\\s+city|' +
  'leeds\\s+united|liverpool|manchester\\s+(?:city|united)|man\\s+(?:city|utd|united)|' +
  'newcastle\\s+united|nottingham\\s+forest|sunderland|tottenham|west\\s+ham|' +
  'wolverhampton|wolves|' +
  'accrington\\s+stanley|afc\\s+wimbledon|barnsley|barrow|birmingham(?:\\s+city)?|' +
  'blackpool|bolton(?:\\s+wanderers)?|boreham\\s+wood|bradford(?:\\s+city)?|' +
  'bristol\\s+(?:city|rovers)|burton\\s+albion|caernarfon|cambridge\\s+united|' +
  'carlisle(?:\\s+united)?|charlton(?:\\s+athletic)?|chesterfield|colchester(?:\\s+united)?|' +
  'connahs?.?\\s+quay|crewe(?:\\s+alexandra)?|dagenham|doncaster(?:\\s+rovers)?|' +
  'exeter(?:\\s+city)?|fleetwood(?:\\s+town)?|forest\\s+green|gillingham|' +
  'harrogate(?:\\s+town)?|haverfordwest|huddersfield(?:\\s+town)?|leyton\\s+orient|' +
  'lincoln\\s+city|mansfield(?:\\s+town)?|milton\\s+keynes|mk\\s+dons|newport\\s+county|' +
  'northampton(?:\\s+town)?|notts\\s+county|oldham(?:\\s+athletic)?|oxford\\s+united|' +
  'penybont|peterborough(?:\\s+united)?|plymouth(?:\\s+argyle)?|port\\s+vale|' +
  'preston(?:\\s+north\\s+end)?|reading(?!\\s*royals)|rotherham(?:\\s+united)?|salford(?:\\s+city)?|' +
  'shrewsbury(?:\\s+town)?|stevenage|sutton\\s+united|swindon(?:\\s+town)?|' +
  'the\\s+new\\s+saints|tranmere(?:\\s+rovers)?|walsall|west\\s+brom(?:wich)?(?:\\s+albion)?|' +
  'wigan(?:\\s+athletic)?|wrexham|wycombe(?:\\s+wanderers)?|yeovil(?:\\s+town)?|' +
  'leicester\\s+city|southampton|ipswich(?:\\s+town)?|sheffield\\s+(?:united|wednesday)|' +
  'middlesbrough|norwich(?:\\s+city)?|stoke(?:\\s+city)?|swansea(?:\\s+city)?|' +
  'cardiff(?:\\s+city)?|blackburn(?:\\s+rovers)?|derby\\s+county|millwall|' +
  'queens\\s+park\\s+rangers|luton(?:\\s+town)?|watford)\\b', 'i'
);

const FIXTURE_SEPARATOR = /\s(?:vs?\.?|versus)\s/i;

export function isExcludedFixtureName(name) {
  const s = String(name || '');
  return FIXTURE_SEPARATOR.test(s) && EXCLUDED_FOOTBALL_CLUB_PATTERN.test(s);
}

// True when an object looks like a fixture record for an excluded club.
// Checks the usual name-bearing keys the upstream feeds use.
export function isExcludedFixtureRecord(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  for (const k of ['name', 'title', 'eventName', 'event_name']) {
    if (typeof o[k] === 'string' && isExcludedFixtureName(o[k])) return true;
  }
  return false;
}

// Recursively drops excluded fixture records from ARRAYS anywhere in a parsed
// JSON value (the feeds nest events differently: events[], _embedded.events[],
// listings[], results[] …). Only array elements are dropped, so a top-level
// entity record such as a team's own page data is never removed. Returns the
// number of records removed.
export function stripExcludedFixtures(node) {
  let removed = 0;
  const walk = (n) => {
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) {
        if (isExcludedFixtureRecord(n[i])) { n.splice(i, 1); removed++; }
        else walk(n[i]);
      }
    } else if (n && typeof n === 'object') {
      for (const k of Object.keys(n)) walk(n[k]);
    }
  };
  walk(node);
  return removed;
}
