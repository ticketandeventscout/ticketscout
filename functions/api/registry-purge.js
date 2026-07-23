// /api/registry-purge — removes entities from the sitemap registry and KV.
//
// WHY
// Discovery registered things that are not events: London restaurants
// (Bella Italia, Masala Zone, The Delaunay), attractions (High Roller Wheel,
// Fly LINQ Zipline, Eiffel Tower Viewing Deck), a football club in the
// theatre section (sheffield-wednesday), and a slug literally called 'index'.
// Observed in the 23 Jul theatre dump.
//
// SCOPE NOTE: this removes NON-EVENTS ONLY. Non-UK entities are deliberately
// kept — Camp Nou, the Bernabeu and San Siro are wanted for event detail
// pages. The UK constraint belongs on the trending grid (countryCode=GB under
// a "in the UK" heading), not on discovery.
//
// SAFETY
// Removing an entity removes a live URL, so nothing happens without an
// explicit slug list AND ?trigger=1. Every removal is written to an audit log
// with the full record, so a mistake can be reconstructed.
//
// Endpoints:
//   ?junk=1&section=theatre                 suggest candidates, no writes
//   ?remove=a,b,c&section=theatre&dry=1     preview exactly what would go
//   ?remove=a,b,c&section=theatre&trigger=1 perform the removal
//   ?log=1&section=theatre                  audit log of past removals
//   ?restore=slug&section=theatre&trigger=1 put one back from the audit log

const SECTIONS = {
  concert: 'concert:artist:',
  theatre: 'theatre:show:',
  sports:  'sports:team:',
  football:'football:team:',
  venue:   'venue:'
};

const LOG_KEY = s => 'registry:purged:' + s;

// Heuristics for SUGGESTING junk. Deliberately suggestion-only — nothing is
// ever removed on the strength of a pattern match alone.
const JUNK_PATTERNS = [
  ['reserved-slug',  /^(index|home|default|test|null|undefined)$/i],
  ['restaurant',     /\b(brasserie|bistro|trattoria|osteria|grill|kitchen|dining|restaurant|cafe|bar and|tapas)\b/i],
  ['known-chain',    /\b(bella italia|masala zone|las iguanas|gaucho|cabana|inamo|banana tree|the delaunay|manzis|wagamama|nandos|zizzi|pizza express|cote)\b/i],
  ['attraction',     /\b(zipline|wheel|viewing deck|observation|tomb|aquarium|dungeon|madame tussauds|sea life|zoo|museum)\b/i],
  ['experience',     /\b(petanque|ptanque|crazy golf|bowling|escape room|mini golf)\b/i]
];

function junkReasons(slug, name) {
  const hay = (name || '') + ' ' + (slug || '').replace(/-/g, ' ');
  const hits = [];
  for (const [label, re] of JUNK_PATTERNS) {
    // Reserved slugs are anchored patterns, so they must be tested against
    // the bare slug — testing them against the combined haystack never
    // matches, which is how 'index' slipped through.
    const subject = label === 'reserved-slug' ? String(slug || '') : hay;
    if (re.test(subject)) hits.push(label);
  }
  return hits;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const section = (url.searchParams.get('section') || '').toLowerCase();
  const prefix = SECTIONS[section];
  if (!prefix) return json({ error: 'Unknown section. Use: ' + Object.keys(SECTIONS).join(', ') }, 400);

  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'No GIGSBERG_KV binding' }, 500);

  if (url.searchParams.get('log') === '1') {
    let log = [];
    try { log = (await kv.get(LOG_KEY(section), 'json')) || []; } catch {}
    return json({ section, removedCount: log.length, removed: log });
  }

  let registry = null;
  try { registry = await kv.get('sitemap:registry', 'json'); } catch {}
  if (!registry || !registry.sections || !registry.sections[section]) {
    return json({ error: 'registry section not found: ' + section }, 500);
  }
  const slugs = Object.keys(registry.sections[section]).sort();

  // ── Restore ────────────────────────────────────────────────────────────
  const restore = url.searchParams.get('restore');
  if (restore && url.searchParams.get('trigger') === '1') {
    let log = [];
    try { log = (await kv.get(LOG_KEY(section), 'json')) || []; } catch {}
    const entry = log.find(e => e.slug === restore);
    if (!entry) return json({ error: 'No audit entry for ' + restore }, 404);

    registry.sections[section][restore] = entry.lastmod || new Date().toISOString().slice(0, 10);
    await kv.put('sitemap:registry', JSON.stringify(registry));
    if (entry.record) await kv.put(prefix + restore, entry.record);

    const remaining = log.filter(e => e.slug !== restore);
    await kv.put(LOG_KEY(section), JSON.stringify(remaining));
    try { await kv.delete(section + ':hub:index'); } catch {}
    return json({ section, restored: restore, recordRestored: !!entry.record });
  }

  // ── Junk suggestions ───────────────────────────────────────────────────
  if (url.searchParams.get('junk') === '1') {
    const suggestions = [];
    for (const slug of slugs) {
      let name = slug.replace(/-/g, ' ');
      let hasRecord = false;
      try {
        const raw = await kv.get(prefix + slug);
        if (raw) { hasRecord = true; const r = JSON.parse(raw); if (r.name) name = r.name; }
      } catch {}

      const reasons = junkReasons(slug, name);
      if (!hasRecord) reasons.push('no-kv-record');
      if (reasons.length) suggestions.push({ slug, name, reasons });
    }
    return json({
      section,
      totalRegistered: slugs.length,
      suggestedCount: suggestions.length,
      note: 'Suggestions only. Review before removing — nothing here has been changed.',
      removeUrl: '/api/registry-purge?section=' + section + '&dry=1&remove=' +
                 suggestions.map(s => s.slug).join(','),
      suggestions
    });
  }

  // ── Removal ────────────────────────────────────────────────────────────
  const removeParam = url.searchParams.get('remove');
  if (!removeParam) {
    return json({ error: 'Nothing to do. Use ?junk=1, ?remove=a,b,c, ?log=1 or ?restore=slug.' }, 400);
  }

  const targets = removeParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!targets.length) return json({ error: 'Empty remove list' }, 400);

  const dry = url.searchParams.get('dry') === '1' || url.searchParams.get('trigger') !== '1';

  const plan = [];
  for (const slug of targets) {
    const inRegistry = Object.prototype.hasOwnProperty.call(registry.sections[section], slug);
    let record = null;
    try { record = await kv.get(prefix + slug); } catch {}
    plan.push({
      slug,
      inRegistry,
      hasRecord: !!record,
      name: (() => { try { return record ? (JSON.parse(record).name || slug) : slug; } catch { return slug; } })(),
      willRemove: inRegistry || !!record
    });
  }

  if (dry) {
    return json({
      section, dryRun: true,
      requested: targets.length,
      wouldRemove: plan.filter(p => p.willRemove).length,
      notFound: plan.filter(p => !p.willRemove).map(p => p.slug),
      plan,
      confirmUrl: '/api/registry-purge?section=' + section + '&trigger=1&remove=' + targets.join(',')
    });
  }

  let log = [];
  try { log = (await kv.get(LOG_KEY(section), 'json')) || []; } catch {}

  const removed = [];
  for (const p of plan) {
    if (!p.willRemove) continue;
    let record = null;
    try { record = await kv.get(prefix + p.slug); } catch {}

    // Audit BEFORE deleting, so a removal is always reversible.
    log.push({
      slug: p.slug,
      name: p.name,
      lastmod: registry.sections[section][p.slug] || null,
      record,
      removedAt: new Date().toISOString()
    });

    delete registry.sections[section][p.slug];
    try { await kv.delete(prefix + p.slug); } catch {}
    removed.push(p.slug);
  }

  await kv.put('sitemap:registry', JSON.stringify(registry));
  await kv.put(LOG_KEY(section), JSON.stringify(log));
  try { await kv.delete(section + ':hub:index'); } catch {}

  return json({
    section,
    dryRun: false,
    removed,
    removedCount: removed.length,
    remainingInSection: Object.keys(registry.sections[section]).length,
    note: 'Removed from registry and KV. Static stub files in the repo, if any, ' +
          'must be deleted separately via GitHub. Sitemap regenerates from the registry.',
    restoreExample: '/api/registry-purge?section=' + section + '&trigger=1&restore=' + (removed[0] || '')
  });
}