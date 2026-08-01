// ============================================================================
// TicketScout — One-off backfill for the 27 concert fragments merged tonight
// (1 Aug 2026) BEFORE the routing-Function redirect-lookup fix existed.
//
// Runs at /api/backfill-redirects?trigger=1 (dry run) or &confirm=yes (apply)
//
// Context: functions/concert/[slug].js intercepts every /concert/{slug}
// request regardless of whether a static file exists there, so the two
// mergefragments confirm=yes&createcanonical=yes runs earlier tonight
// correctly wrote redirect-stub .html files and cleaned up the registry/KV,
// but those 27 old URLs were still rendering full independent pages instead
// of redirecting, because nothing had yet written the
// redirectSlug:concert:{oldSlug} KV entries the routing Function now checks.
// This writes exactly those 27 entries directly, using the precise old/new
// pairs from the two actual confirm=yes responses — no guessing, no
// registry scan, just the known list.
//
// Safe to delete once run once and confirmed working.
// ============================================================================

const PAIRS = [
  // Batch 1 (commitSha 3a5f64d9...)
  ['opener-festival-2-day-pass', 'opener-festival'],
  ['opener-festival-4-day-pass', 'opener-festival'],
  ['jarocin-festiwal-2026-parking-dzien-2', 'jarocin-festiwal-2026-parking'],
  ['jarocin-festiwal-2026-parking-dzien-1', 'jarocin-festiwal-2026-parking'],
  ['jarocin-festiwal-2026-parking-dzien-3', 'jarocin-festiwal-2026-parking'],
  ['wyscigi-konne-sopot-2026-bilet-1-dniowy-dzien-2', 'wyscigi-konne-sopot-2026-bilet'],
  ['wyscigi-konne-sopot-2026-bilet-1-dniowy-dzien-1', 'wyscigi-konne-sopot-2026-bilet'],
  ['blue-summer-jazz-festival-dzien-1', 'blue-summer-jazz-festival'],
  ['blue-summer-jazz-festival-dzien-2', 'blue-summer-jazz-festival'],
  ['erste-letnie-brzmienia-2026-krakow-dzien-2', 'erste-letnie-brzmienia-2026-krakow'],
  ['erste-letnie-brzmienia-2026-krakow-dzien-1', 'erste-letnie-brzmienia-2026-krakow'],
  ['jarocin-festiwal-2026-dzien-2', 'jarocin-festiwal-2026'],
  ['jarocin-festiwal-2026-dzien-1', 'jarocin-festiwal-2026'],
  ['jarocin-festiwal-2026-dzien-3', 'jarocin-festiwal-2026'],
  // Batch 2 (commitSha 38cb65bb...)
  ['defender-salt-wave-festival-dzien-2', 'defender-salt-wave-festival'],
  ['defender-salt-wave-festival-dzien-1', 'defender-salt-wave-festival'],
  ['rockowizna-festiwal-2026-dzien-1', 'rockowizna-festiwal-2026'],
  ['rockowizna-festiwal-2026-dzien-3', 'rockowizna-festiwal-2026'],
  ['rockowizna-festiwal-2026-dzien-2', 'rockowizna-festiwal-2026'],
  ['erste-letnie-brzmienia-2026-warszawa-dzien-2', 'erste-letnie-brzmienia-2026-warszawa'],
  ['erste-letnie-brzmienia-2026-warszawa-dzien-1', 'erste-letnie-brzmienia-2026-warszawa'],
  ['erste-letnie-brzmienia-2026-gdansk-dzien-1', 'erste-letnie-brzmienia-2026-gdansk'],
  ['erste-letnie-brzmienia-2026-gdansk-dzien-2', 'erste-letnie-brzmienia-2026-gdansk'],
  ['erste-letnie-brzmienia-2026-poznan-dzien-1', 'erste-letnie-brzmienia-2026-poznan'],
  ['erste-letnie-brzmienia-2026-poznan-dzien-2', 'erste-letnie-brzmienia-2026-poznan'],
  ['erste-letnie-brzmienia-2026-wroclaw-dzien-1', 'erste-letnie-brzmienia-2026-wroclaw'],
  ['erste-letnie-brzmienia-2026-wroclaw-dzien-2', 'erste-letnie-brzmienia-2026-wroclaw'],
];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm') === 'yes';
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  if (!confirm) {
    return json({
      dryRun: true,
      pairCount: PAIRS.length,
      wouldWrite: PAIRS.map(([oldSlug, newSlug]) => ({
        key: `redirectSlug:concert:${oldSlug}`,
        value: `concert/${newSlug}`
      })),
      message: 'Add &confirm=yes to write these 27 entries.'
    }, 200);
  }

  const written = [];
  for (const [oldSlug, newSlug] of PAIRS) {
    try {
      await kv.put(`redirectSlug:concert:${oldSlug}`, `concert/${newSlug}`);
      written.push(`${oldSlug} -> concert/${newSlug}`);
    } catch (err) {
      written.push(`ERROR ${oldSlug}: ${err}`);
    }
  }

  return json({ message: 'Backfill complete.', count: written.length, written }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
