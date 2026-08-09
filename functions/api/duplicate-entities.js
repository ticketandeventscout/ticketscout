// functions/api/duplicate-entities.js
// =============================================================================
// DUPLICATE ENTITY SCAN — read-only diagnostic.
// =============================================================================
//
// WHY THIS EXISTS
// ----------------
// The registry contains the same real-world club/artist under more than one
// slug. Confirmed examples: nottingham-forest + nottingham-forest-fc, and
// wolves + wolverhampton-wanderers. Each pair is two hub pages competing for
// the same queries, splitting internal links and inbound signals, and each
// listing the same fixtures.
//
// This is NOT what ?phase=mergefragments handles. That targets ticket-type
// FRAGMENTS (day passes, multi-day packs, session numbers) — entities that
// were never real in the first place. These are two legitimate entities that
// happen to be the same thing under different names, which is a different
// detection problem and needs different evidence.
//
// EVIDENCE TIERS — strongest first, and deliberately separated because they
// carry very different false-positive risk:
//
//   A. SAME WIKIDATA ID (or same MusicBrainz ID).
//      Authoritative. enrich-entities.js resolves each entity against
//      Wikidata/MusicBrainz and stores the ID at entity:meta:{cat}:{slug}.
//      Two slugs resolving to the SAME external ID are the same real-world
//      thing — that is what the ID means. This is the only tier that catches
//      wolves + wolverhampton-wanderers, because no string comparison of
//      those two slugs would ever match.
//      Caveat: only covers entities enrich-entities has already processed.
//
//   B. SUFFIX-EQUIVALENT NAMES. nottingham-forest vs nottingham-forest-fc —
//      identical once a club-type suffix (fc/afc/cf/sc/sk/bk/if) is stripped.
//      Low risk, but string-based, so it stays advisory rather than
//      auto-actionable.
//
//   C. PREFIX RELATIONSHIP. One slug is a strict prefix of the other at a
//      word boundary — leeds vs leeds-united.
//      HIGHEST RISK TIER, reported separately and never to be actioned
//      without checking each pair: real distinct clubs share prefixes.
//      bristol-city and bristol-rovers are different clubs; sheffield-united
//      and sheffield-wednesday are different clubs. Tier C exists to produce
//      a short human-reviewable list, not a merge queue.
//
// READ-ONLY. Nothing is written, merged, deleted or redirected. Merging is a
// deliberately separate step, to be scoped once this scan shows the real
// shape and scale — same staging discipline as duplicate-events.js, where
// the scan came first and the merge tool was built against real findings
// rather than assumptions.
//
// USAGE
//   /api/duplicate-entities?scan=1&trigger=1
//   /api/duplicate-entities?scan=1&trigger=1&category=football
//   /api/duplicate-entities?scan=1&trigger=1&tier=A     (A | B | C | all)
// =============================================================================

const CATEGORIES = ['concert', 'football', 'theatre', 'sports', 'venue'];

// Per-category entity record prefix — confirmed from discover-pages.js and
// enrich-entities.js's own PREFIXES maps. Needed for the winner-safety check
// below: the search text sent to EVERY live compare-table adapter
// (Ticketmaster, Awin, SE365, VividSeats, Ticombo, TicketNetwork) comes from
// THIS record's own .search/.name field, not the URL slug — confirmed in
// football.html: `team.search || team.name`. venue has no equivalent
// per-entity search record (venue pages don't drive live keyword search the
// same way), so it is intentionally absent here.
const ENTITY_PREFIX = {
  concert: 'concert:artist:', football: 'football:team:',
  theatre: 'theatre:show:', sports: 'sports:team:'
};

// Club/company type suffixes only. Deliberately NOT including words that
// distinguish real clubs — united, city, rovers, wanderers, town, athletic
// and county are all load-bearing (sheffield-united vs sheffield-wednesday,
// bristol-city vs bristol-rovers). Stripping those would manufacture
// duplicates that do not exist.
const TYPE_SUFFIXES = ['fc', 'afc', 'cf', 'sc', 'ac', 'sk', 'bk', 'if', 'tc', 'rc'];

function stripTypeSuffix(slug) {
  const parts = String(slug || '').split('-').filter(Boolean);
  while (parts.length > 1 && TYPE_SUFFIXES.includes(parts[parts.length - 1])) parts.pop();
  // A leading type marker is just as common: fc-barcelona, ac-milan.
  while (parts.length > 1 && TYPE_SUFFIXES.includes(parts[0])) parts.shift();
  return parts.join('-');
}

// Trailing-only variant. Stripping a LEADING marker is materially riskier
// than stripping a trailing one, because the leading marker is often the
// ONLY thing separating two genuinely different clubs that share a city
// name. The first live run proved this, producing two confirmed false
// positives:
//   fc-barcelona + barcelona-sc  -> FC Barcelona (Spain) is not
//                                   Barcelona Sporting Club (Ecuador)
//   afc-toronto  + toronto-fc    -> AFC Toronto (women, NSL) is not
//                                   Toronto FC (MLS)
// Pairs that match on trailing-only stripping are reported separately as
// the safer set, so the risky ones can be reviewed rather than trusted.
function stripTrailingOnly(slug) {
  const parts = String(slug || '').split('-').filter(Boolean);
  while (parts.length > 1 && TYPE_SUFFIXES.includes(parts[parts.length - 1])) parts.pop();
  return parts.join('-');
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// Shared by BOTH scan mode and merge mode, so classification can never drift
// between "what the scan reported" and "what the merge tool actually acts
// on" — extracted after the scan/merge split, deliberately, rather than
// letting merge mode re-derive its own copy of this logic.
async function classifyCategory(kv, cat, slugs) {
  const byExternalId = new Map(); // 'wikidata:Q123' -> [slug, ...]
  let enriched = 0;
  const CHUNK = 25;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (slug) => {
      try {
        const raw = await kv.get(`entity:meta:${cat}:${slug}`);
        if (!raw) return;
        enriched++;
        const meta = JSON.parse(raw);
        const facts = meta.facts || meta;
        const ids = [];
        if (facts.wikidataId) ids.push('wikidata:' + facts.wikidataId);
        if (facts.mbid) ids.push('mbid:' + facts.mbid);
        for (const id of ids) {
          if (!byExternalId.has(id)) byExternalId.set(id, []);
          byExternalId.get(id).push(slug);
        }
      } catch { /* unreadable meta is simply not evidence */ }
    }));
  }

  const tierA = [];
  const tierAVariantSuspect = [];
  for (const [id, group] of byExternalId) {
    if (group.length <= 1) continue;
    const hasVariant = group.some(s => /-(b|ii|iii|legends|women|reserves|u\d{2})$/.test(s));
    (hasVariant ? tierAVariantSuspect : tierA).push({ externalId: id, slugs: group.sort() });
  }

  const explained = new Set();
  for (const g of tierA) for (const s of g.slugs) explained.add(s);
  for (const g of tierAVariantSuspect) for (const s of g.slugs) explained.add(s);

  const byStripped = new Map();
  for (const slug of slugs) {
    const key = stripTypeSuffix(slug);
    if (!byStripped.has(key)) byStripped.set(key, []);
    byStripped.get(key).push(slug);
  }
  const tierB = [];
  const tierBRisky = [];
  for (const [key, group] of byStripped) {
    if (group.length < 2) continue;
    if (group.every(s => explained.has(s))) continue;
    const trailingKeys = new Set(group.map(stripTrailingOnly));
    (trailingKeys.size === 1 ? tierB : tierBRisky).push({ normalised: key, slugs: group.sort() });
  }
  for (const g of tierB) for (const s of g.slugs) explained.add(s);
  for (const g of tierBRisky) for (const s of g.slugs) explained.add(s);

  const tierC = [];
  const sorted = [...slugs].sort();
  for (let i = 0; i < sorted.length && tierC.length < 100; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && tierC.length < 100; j++) {
      const b = sorted[j];
      if (!b.startsWith(a + '-')) continue;
      if (explained.has(a) && explained.has(b)) continue;
      tierC.push({ shorter: a, longer: b });
    }
  }

  return { tierA, tierAVariantSuspect, tierB, tierBRisky, tierC, enriched };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // ── Inspect: raw entity record read, no scoring, no heuristics ─────────
  // Usage: ?inspect=1&trigger=1&category=football&slug=wolves
  if (url.searchParams.get('inspect') === '1' && url.searchParams.get('trigger') === '1') {
    const kv = env.GIGSBERG_KV;
    if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
    const cat = (url.searchParams.get('category') || '').trim().toLowerCase();
    const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
    const prefix = ENTITY_PREFIX[cat];
    if (!prefix || !slug) return jsonResponse({ error: '&category=X and &slug=Y are both required' }, 400);
    try {
      const raw = await kv.get(prefix + slug);
      const metaRaw = await kv.get(`entity:meta:${cat}:${slug}`);
      const redirect = await kv.get(`redirectSlug:${cat}:${slug}`);
      return jsonResponse({
        inspect: true, key: prefix + slug,
        record: raw ? JSON.parse(raw) : null,
        recordExists: !!raw,
        enrichmentMeta: metaRaw ? JSON.parse(metaRaw) : null,
        redirectsTo: redirect || null,
        searchTextThatLiveAdaptersWillUse: raw ? (JSON.parse(raw).search || JSON.parse(raw).name || null) : null
      }, 200);
    } catch (e) { return jsonResponse({ error: 'inspect failed: ' + String(e) }, 500); }
  }

  // ── Audit search text: scan a whole category for the SAME ambiguity ────
  // shape that caused the wolves/Chattanooga Red Wolves SC mismatch — a
  // bare, short, single-word search term that a live keyword search could
  // easily match to an unrelated entity. Read-only. Same heuristic the
  // merge tool's winner-safety check uses, applied here to every entity in
  // the registry, not just merge candidates — wolves was found via a merge
  // attempt, but this class of bug can affect ANY entity, merged or not.
  // Usage: ?auditsearch=1&trigger=1&category=football
  if (url.searchParams.get('auditsearch') === '1' && url.searchParams.get('trigger') === '1') {
    const kv = env.GIGSBERG_KV;
    if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
    const cat = (url.searchParams.get('category') || '').trim().toLowerCase();
    const prefix = ENTITY_PREFIX[cat];
    if (!prefix) return jsonResponse({ error: `&category=X required, one of ${Object.keys(ENTITY_PREFIX).join(', ')}` }, 400);

    let registry = null;
    try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); }
    catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }
    if (!registry?.sections) return jsonResponse({ error: 'sitemap:registry not built yet' }, 503);
    const slugs = Object.keys(registry.sections[cat] || {});

    const flagged = [];
    let checked = 0;
    const CHUNK = 25;
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const chunk = slugs.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async (slug) => {
        try {
          const raw = await kv.get(prefix + slug);
          if (!raw) return;
          checked++;
          const rec = JSON.parse(raw);
          const searchText = rec.search || rec.name || '';
          if (searchText && !searchText.includes(' ') && searchText.length < 10) {
            flagged.push({ slug, searchText, storedName: rec.name || null });
          }
        } catch { /* unreadable record — skip, not a finding */ }
      }));
    }

    return jsonResponse({
      auditsearch: true, category: cat,
      entitiesChecked: checked,
      flaggedCount: flagged.length,
      flagged,
      interpretation: flagged.length
        ? `${flagged.length} entities have a bare, single-word search term under 10 characters — the same shape that caused wolves to pull in Chattanooga Red Wolves SC fixtures instead of Wolverhampton Wanderers. Each is WORTH CHECKING, not automatically wrong — a real one-word club/artist name looks identical to a bad one. Use ?inspect=1 on any of these to see the full stored record, and ?fixsearch=1 to correct one once you've confirmed it live (check the actual live compare table for that slug).`
        : 'No entities in this category currently have a bare single-word search term under 10 characters.'
    }, 200);
  }

  // ── Fix search text: correct one entity's .search field ────────────────
  // Deliberately single-entity, explicit-value, confirm-gated — this is a
  // targeted correction after a human has looked at ?inspect=1 output and
  // the live compare table for that slug, not a bulk or automated action.
  // Usage: ?fixsearch=1&trigger=1&category=football&slug=wolves&newSearch=Wolverhampton%20Wanderers&confirm=yes
  if (url.searchParams.get('fixsearch') === '1' && url.searchParams.get('trigger') === '1') {
    const kv = env.GIGSBERG_KV;
    if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
    const cat = (url.searchParams.get('category') || '').trim().toLowerCase();
    const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
    const newSearch = (url.searchParams.get('newSearch') || '').trim();
    const prefix = ENTITY_PREFIX[cat];
    if (!prefix || !slug || !newSearch) return jsonResponse({ error: '&category=X, &slug=Y and &newSearch=... are all required' }, 400);
    const confirm = url.searchParams.get('confirm') === 'yes';

    try {
      const raw = await kv.get(prefix + slug);
      if (!raw) return jsonResponse({ error: `No record at ${prefix}${slug}` }, 404);
      const rec = JSON.parse(raw);
      const before = rec.search || rec.name || null;
      if (!confirm) {
        return jsonResponse({
          fixsearch: true, dryRun: true, key: prefix + slug,
          currentSearchText: before, proposedSearchText: newSearch,
          message: 'Dry run — nothing written. Add &confirm=yes to apply.'
        }, 200);
      }
      rec.search = newSearch;
      await kv.put(prefix + slug, JSON.stringify(rec));
      return jsonResponse({
        fixsearch: true, dryRun: false, key: prefix + slug,
        previousSearchText: before, newSearchText: newSearch,
        message: 'Written. Live compare-table adapters for this entity will use the new search text on their next fetch — no cache to clear, this is read live per page load.'
      }, 200);
    } catch (e) { return jsonResponse({ error: 'fixsearch failed: ' + String(e) }, 500); }
  }

  if (url.searchParams.get('repair') === '1' && url.searchParams.get('trigger') === '1') {
    return runRepair(url, env);
  }

  if (url.searchParams.get('merge') === '1' && url.searchParams.get('trigger') === '1') {
    return runMerge(url, env);
  }

  if (url.searchParams.get('scan') !== '1' || url.searchParams.get('trigger') !== '1') {
    return jsonResponse({
      error: 'Pass ?scan=1&trigger=1 to scan (read-only). Pass ?merge=1&trigger=1 to merge the safe tiers (dry-run by default, &confirm=yes to write). Pass ?repair=1&trigger=1&category=X to restore registry entries removed by a redirect that is not honoured by the router (dry-run by default). Pass ?inspect=1&trigger=1&category=X&slug=Y to read one entity\'s raw stored record. Pass ?auditsearch=1&trigger=1&category=X to scan for ambiguous single-word search text across a category. Pass ?fixsearch=1&trigger=1&category=X&slug=Y&newSearch=... to correct one entity\'s search text (dry-run by default). Optional on scan: &category=X, &tier=A|B|C|all'
    }, 400);
  }

  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const onlyCategory = (url.searchParams.get('category') || '').trim().toLowerCase();
  const tier = (url.searchParams.get('tier') || 'all').trim().toUpperCase();
  const categories = onlyCategory ? [onlyCategory] : CATEGORIES;

  let registry = null;
  try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); }
  catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }
  if (!registry?.sections) return jsonResponse({ error: 'sitemap:registry not built yet' }, 503);

  const out = {
    scan: true,
    categories: {},
    totals: { tierA: 0, tierAVariantSuspect: 0, tierB: 0, tierBRisky: 0, tierC: 0, enrichedChecked: 0, entitiesScanned: 0 },
    notes: []
  };

  for (const cat of categories) {
    const slugs = Object.keys(registry.sections[cat] || {});
    if (!slugs.length) continue;
    out.totals.entitiesScanned += slugs.length;

    const { tierA, tierAVariantSuspect, tierB, tierBRisky, tierC, enriched } =
      await classifyCategory(kv, cat, slugs);
    out.totals.enrichedChecked += enriched;

    out.categories[cat] = {
      entities: slugs.length,
      enrichedWithExternalId: enriched,
      tierA_sameExternalId: tierA,
      tierA_variantSuspect_doNotMerge: tierAVariantSuspect,
      tierB_suffixEquivalent: tierB,
      tierB_riskyLeadingPrefix: tierBRisky,
      tierC_prefixReviewOnly: tierC.slice(0, 50),
      tierC_truncated: tierC.length > 50
    };
    out.totals.tierA += tierA.length;
    out.totals.tierAVariantSuspect += tierAVariantSuspect.length;
    out.totals.tierB += tierB.length;
    out.totals.tierBRisky += tierBRisky.length;
    out.totals.tierC += tierC.length;
  }

  if (tier !== 'ALL') {
    const keep = { A: 'tierA_sameExternalId', B: 'tierB_suffixEquivalent', C: 'tierC_prefixReviewOnly' }[tier];
    if (keep) {
      for (const cat of Object.keys(out.categories)) {
        for (const k of ['tierA_sameExternalId', 'tierB_suffixEquivalent', 'tierC_prefixReviewOnly']) {
          if (k !== keep) delete out.categories[cat][k];
        }
      }
    }
  }

  out.notes.push('Tier A is authoritative (same Wikidata/MusicBrainz ID = same real-world entity) and is the only tier that catches abbreviation pairs like wolves + wolverhampton-wanderers. It only covers entities enrich-entities.js has already processed — check enrichedWithExternalId against entities to see the coverage.');
  out.notes.push('tierA_variantSuspect_doNotMerge: an external-ID collision where one slug is a reserve/variant side (-b, -ii, -women, -legends, -u21). enrich-entities.js looks Wikidata up BY NAME, so "Espanyol B" resolves to RCD Espanyol\'s ID. These are NOT duplicates — a reserve side is a real separate team with its own fixtures. Merging them would delete a legitimate page. The collision instead indicates the ENRICHMENT record is wrong and worth correcting at source.');
  out.notes.push('tierB_riskyLeadingPrefix matched ONLY because a leading fc-/afc-/sc- marker was stripped. That marker is often the only thing separating two real clubs sharing a city name — confirmed live: fc-barcelona vs barcelona-sc (Spain vs Ecuador) and afc-toronto vs toronto-fc (NSL women vs MLS) are DIFFERENT clubs. Review every pair in this list individually; do not bulk-action it.');
  out.notes.push('Tier C WILL contain false positives by design: bristol-city/bristol-rovers and sheffield-united/sheffield-wednesday are real distinct clubs that share a prefix. Review every pair before acting; never bulk-action this tier.');
  out.notes.push('READ-ONLY — nothing merged, deleted or redirected. Use ?merge=1&trigger=1 (dry-run by default) for that, scoped to tierA_sameExternalId + tierB_suffixEquivalent only.');

  return jsonResponse(out, 200);
}

// =============================================================================
// MERGE MODE (added 9 Aug 2026)
// =============================================================================
// Scoped ONLY to tierA_sameExternalId (authoritative, non-variant) and
// tierB_suffixEquivalent (safe, trailing-marker-only). tierA_variantSuspect,
// tierB_riskyLeadingPrefix and tierC are NEVER touched here — those tiers'
// own notes say why (reserve sides, city-sharing clubs, real distinct clubs
// sharing a prefix). If a pair belongs in one of those tiers, it doesn't
// appear in this tool's candidate list at all, not even as a skip — the
// classifier itself never puts it there.
//
// WINNER SELECTION: shorter slug wins, alphabetical as a tie-break. Checked
// against every real pair the live scans produced — aberdeen < aberdeen-fc,
// bournemouth < afc-bournemouth, wolves < wolverhampton, nottingham-forest <
// nottingham-forest-fc — the shorter form was correct in every single case
// seen so far. Only pairs (exactly 2 slugs) are merged in this version;
// a group with 3+ members is skipped and reported, not guessed at.
//
// ACTIONS PER PAIR, using the SAME mechanism discover-pages.js's
// mergefragments phase already writes and functions/venue/[slug].js already
// reads live — no new redirect infrastructure invented:
//   1. kv.put('redirectSlug:{category}:{loserSlug}', '{category}/{winnerSlug}')
//      — the router already checks this key before rendering; existing
//      links/bookmarks/indexed URLs 301 automatically, no further code needed.
//   2. Registry: delete the loser's entry, ensure the winner's entry exists
//      (same delete/set pattern discover-pages.js's own merge phase uses).
//   3. Enrichment fill-in: if the winner has no entity:meta but the loser
//      does, copy the loser's onto the winner — COALESCE, never overwrite an
//      existing winner record.
//
// DELIBERATELY NOT DONE in this version: the loser's own per-entity KV
// record (concert:artist:{slug} etc.) is left in place, orphaned but
// harmless — the redirect fires before that record is ever read, per the
// venue router's own comment ("this check runs first and is the only thing
// that makes a real HTTP 301 happen"). Not deleting it is the more
// conservative choice for a first live run: reversible, costs a few KB of
// unused KV storage, and avoids a second irreversible delete on top of the
// registry change in the same pass.
//
// Usage: ?merge=1&trigger=1                    — dry run, all categories
//        ?merge=1&trigger=1&category=football  — dry run, one category
//        ?merge=1&trigger=1&confirm=yes         — writes
async function runMerge(url, env) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const onlyCategory = (url.searchParams.get('category') || '').trim().toLowerCase();
  const categories = onlyCategory ? [onlyCategory] : CATEGORIES;
  const confirm = url.searchParams.get('confirm') === 'yes';
  const dryRun = !confirm;

  let registry = null;
  try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); }
  catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }
  if (!registry?.sections) return jsonResponse({ error: 'sitemap:registry not built yet' }, 503);

  const today = new Date().toISOString().slice(0, 10);
  const merges = [];
  const skippedGroups = [];
  let registryChanged = false;

  for (const cat of categories) {
    const slugs = Object.keys(registry.sections[cat] || {});
    if (!slugs.length) continue;

    const { tierA, tierB } = await classifyCategory(kv, cat, slugs);
    const candidateGroups = [...tierA.map(g => ({ ...g, evidence: 'tierA_sameExternalId' })),
                              ...tierB.map(g => ({ ...g, evidence: 'tierB_suffixEquivalent' }))];

    for (const g of candidateGroups) {
      if (g.slugs.length !== 2) {
        skippedGroups.push({ category: cat, evidence: g.evidence, slugs: g.slugs, reason: 'group has ' + g.slugs.length + ' members, not 2 — not auto-actioned, review manually' });
        continue;
      }
      const [a, b] = g.slugs;
      const winner = (a.length !== b.length) ? (a.length < b.length ? a : b) : (a < b ? a : b);
      const loser = winner === a ? b : a;

      const plan = { category: cat, evidence: g.evidence, winner, loser, redirectKey: `redirectSlug:${cat}:${loser}`, redirectValue: `${cat}/${winner}` };

      // WINNER-SAFETY CHECK (added 9 Aug 2026, live incident) — first live
      // use of this tool merged wolves + wolverhampton with wolves as
      // winner (shorter slug), and wolves' OWN entity record turned out to
      // hold the bare, ambiguous name "Wolves" — which the live compare
      // table's own adapters (Ticketmaster, Awin, SE365, VividSeats,
      // Ticombo, TicketNetwork) send as the search term, per football.html:
      // `team.search || team.name`. A bare nickname can match an unrelated
      // team of the same name; wolverhampton's fuller stored name did not
      // have this problem. Slug LENGTH says nothing about SEARCH TEXT
      // quality, and the two are independent — this check surfaces the
      // actual stored name/search text for BOTH candidates on every single
      // plan, dry-run or not, specifically so this class of mistake is
      // visible before confirming, not discovered live afterward.
      const prefix = ENTITY_PREFIX[cat];
      if (prefix) {
        try {
          const [winnerRaw, loserRaw] = await Promise.all([
            kv.get(prefix + winner), kv.get(prefix + loser)
          ]);
          const winnerRec = winnerRaw ? JSON.parse(winnerRaw) : null;
          const loserRec  = loserRaw  ? JSON.parse(loserRaw)  : null;
          plan.winnerSearchText = winnerRec ? (winnerRec.search || winnerRec.name || null) : null;
          plan.loserSearchText  = loserRec  ? (loserRec.search  || loserRec.name  || null) : null;
          // Heuristic only, not proof of a real problem: a single-word
          // search text under 10 characters is the SHAPE of the bare
          // nickname that produced the wolves mismatch, not a guarantee —
          // a genuinely one-word artist name looks identical and is
          // completely fine. Because false positives are possible, this
          // BLOCKS the write by default (see below) rather than silently
          // proceeding, and needs &includeAmbiguous=yes to override once
          // manually checked.
          const wst = plan.winnerSearchText || '';
          plan.winnerSearchTextLooksAmbiguous = !!wst && !wst.includes(' ') && wst.length < 10;
        } catch { plan.winnerSearchText = plan.loserSearchText = null; }
      }

      if (!dryRun) {
        if (plan.winnerSearchTextLooksAmbiguous && url.searchParams.get('includeAmbiguous') !== 'yes') {
          plan.applied = false;
          plan.skippedDueToAmbiguousName = true;
          plan.reason = `Winner's stored search text ("${plan.winnerSearchText}") looks like a bare nickname that could match an unrelated entity in a live keyword search — exactly the failure mode found in the wolves/wolverhampton pair. Not written. Re-run with &includeAmbiguous=yes to force it through if you have manually verified this specific pair is fine, or fix the winner's OWN stored search text at the source first (safer) so the flag naturally clears.`;
          merges.push(plan);
          continue;
        }
        try {
          await kv.put(plan.redirectKey, plan.redirectValue);

          if (registry.sections[cat]) {
            delete registry.sections[cat][loser];
            if (!registry.sections[cat][winner]) registry.sections[cat][winner] = today;
            registryChanged = true;
          }

          // Enrichment fill-in: COALESCE, never overwrite an existing winner record.
          try {
            const winnerMetaRaw = await kv.get(`entity:meta:${cat}:${winner}`);
            if (!winnerMetaRaw) {
              const loserMetaRaw = await kv.get(`entity:meta:${cat}:${loser}`);
              if (loserMetaRaw) {
                await kv.put(`entity:meta:${cat}:${winner}`, loserMetaRaw);
                plan.enrichmentCopied = true;
              }
            }
          } catch { /* enrichment fill-in is a nicety, never blocks the merge */ }

          plan.applied = true;
        } catch (e) {
          plan.applied = false;
          plan.error = String(e);
        }
      }
      merges.push(plan);
    }
  }

  if (!dryRun && registryChanged) {
    try { await kv.put('sitemap:registry', JSON.stringify(registry)); }
    catch (e) { return jsonResponse({ error: 'registry write failed after redirects were already written: ' + String(e), merges }, 500); }
  }

  return jsonResponse({
    merge: true,
    dryRun,
    categories,
    eligiblePairs: merges.length,
    skippedGroups: skippedGroups.length,
    skippedGroupsDetail: skippedGroups,
    merges,
    message: dryRun
      ? 'Dry run — nothing written. Review the merges list, then add &confirm=yes to write redirects and update the registry.'
      : 'Merge complete. Existing URLs for every loser slug now 301 to the winner automatically via the redirect check already live in each category router.'
  }, 200);
}

// =============================================================================
// REPAIR MODE (added 9 Aug 2026, live incident)
// =============================================================================
// The merge tool above writes TWO things per pair: a redirectSlug KV key,
// and a registry deletion for the loser slug. The registry write does not
// depend on the router at all — it always succeeds. The redirect only takes
// effect if that category's page router actually CHECKS redirectSlug before
// rendering, the way functions/venue/[slug].js is confirmed to (tested live,
// O2 Arena, working). functions/football/[slug].js was never seen or
// verified before this tool was used against it — and a live confirm=yes run
// proved it does NOT check the key: neither wolves nor wolverhampton
// redirects, both still render fully independently, exactly as before.
//
// Net effect for every affected pair: the loser's page is still fully live
// and rendering (its own entity KV record was deliberately never deleted —
// see the merge function's own comment on that), but it is no longer listed
// in sitemap:registry, so it silently dropped out of the sitemap. A live,
// still-crawlable page with no internal link path to it is exactly the
// orphan-page problem this whole audit thread has been trying to PREVENT —
// so this is a real regression, even though (confirmed by testing) nobody
// is being served wrong content on the winner's URL because of it.
//
// This restores the registry side ONLY. It does not touch redirectSlug keys
// (leaving them in place is harmless — they just currently do nothing for
// football) and does not touch any entity KV record.
//
// SIGNAL USED: an entity is a repair candidate when ALL THREE are true —
//   1. its {prefix}{slug} KV record still exists (the page can genuinely
//      still render — nothing to restore a registry entry FOR otherwise)
//   2. redirectSlug:{category}:{slug} ALSO exists (this is the precise part:
//      a real merge-style removal always leaves this key behind, so its
//      presence distinguishes "removed by a merge" from "removed on purpose
//      for some unrelated reason" — which should NOT be resurrected)
//   3. it is currently absent from sitemap:registry.sections[category]
// Deliberately category-general, not football-only — the same risk applies
// to concert/theatre/sports until each one's router is individually
// confirmed the way venue's was.
//
// Usage: ?repair=1&trigger=1&category=football               — dry run
//        ?repair=1&trigger=1&category=football&confirm=yes    — writes
async function runRepair(url, env) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);

  const onlyCategory = (url.searchParams.get('category') || '').trim().toLowerCase();
  if (!onlyCategory) return jsonResponse({ error: '&category=X is required for repair mode — this is a scoped, one-category-at-a-time restore, not a blanket operation' }, 400);
  const prefix = ENTITY_PREFIX[onlyCategory];
  if (!prefix) return jsonResponse({ error: `No entity KV prefix known for category "${onlyCategory}"` }, 400);
  const confirm = url.searchParams.get('confirm') === 'yes';
  const dryRun = !confirm;

  let registry = null;
  try { const r = await kv.get('sitemap:registry'); if (r) registry = JSON.parse(r); }
  catch (e) { return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500); }
  if (!registry?.sections) return jsonResponse({ error: 'sitemap:registry not built yet' }, 503);
  const currentSlugsInRegistry = new Set(Object.keys(registry.sections[onlyCategory] || {}));

  // List every entity KV record for this category. Cloudflare KV list() is
  // paginated (up to 1000 keys per call) — walk the cursor fully rather than
  // assuming one page covers everything; football alone has ~1,600 entities.
  const entityKeys = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) entityKeys.push(k.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const missingFromRegistry = entityKeys.filter(slug => !currentSlugsInRegistry.has(slug));

  const today = new Date().toISOString().slice(0, 10);
  const candidates = [];
  const CHUNK = 25;
  for (let i = 0; i < missingFromRegistry.length; i += CHUNK) {
    const chunk = missingFromRegistry.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (slug) => {
      try {
        const redirect = await kv.get(`redirectSlug:${onlyCategory}:${slug}`);
        if (redirect) candidates.push({ slug, currentRedirectPointsTo: redirect });
      } catch { /* no readable redirect key = not a repair candidate */ }
    }));
  }

  if (!dryRun && candidates.length) {
    for (const c of candidates) registry.sections[onlyCategory][c.slug] = today;
    try { await kv.put('sitemap:registry', JSON.stringify(registry)); }
    catch (e) { return jsonResponse({ error: 'registry write failed: ' + String(e), candidates }, 500); }
  }

  return jsonResponse({
    repair: true, dryRun, category: onlyCategory,
    entityRecordsFound: entityKeys.length,
    currentlyInRegistry: currentSlugsInRegistry.size,
    missingFromRegistry: missingFromRegistry.length,
    repairCandidates: candidates.length,
    candidates,
    message: dryRun
      ? `Dry run — nothing written. ${candidates.length} slug(s) still have a live entity record and an existing redirect key but are missing from the registry — these are the ones a redirect-writing tool removed. Add &confirm=yes to restore them to the registry (does not touch redirectSlug keys or entity records).`
      : `Restored ${candidates.length} slug(s) to sitemap:registry.sections.${onlyCategory}. Their pages were never actually missing — only unlisted. This does NOT fix the underlying issue (the router still doesn't honour the redirect) — it just stops the sitemap regression while that gets fixed properly.`
  }, 200);
}
