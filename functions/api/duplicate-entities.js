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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('scan') !== '1' || url.searchParams.get('trigger') !== '1') {
    return jsonResponse({
      error: 'Pass ?scan=1&trigger=1 to run (read-only). Optional: &category=X, &tier=A|B|C|all'
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

    // ── Tier A: authoritative external-ID collisions ────────────────────
    // One KV read per entity. Chunked concurrently — the same pattern used
    // in entity-lifecycle.js and concert.js after sequential per-entity KV
    // reads were found to be the cause of repeated cron timeouts.
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
          // enrich-entities.js stores { slug, category, facts: {...},
          // aboutText, source, licence, fetchedAt } — the external IDs live
          // under .facts, NOT at the top level. Reading meta.wikidataId
          // directly returns undefined for every entity, which is exactly
          // why the first run of this scan reported tierA: 0 against 856
          // enriched entities: not "no duplicates found", but "the field was
          // never read". Kept tolerant of both shapes so a future refactor
          // of the meta envelope cannot silently zero this tier again.
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
    out.totals.enrichedChecked += enriched;

    const tierA = [];
    const tierAVariantSuspect = [];
    for (const [id, group] of byExternalId) {
      if (group.length <= 1) continue;
      // RESERVE/VARIANT GUARD (added after the first successful live run).
      // Tier A is authoritative about what enrich-entities RESOLVED to — not
      // necessarily about what the entity actually is. enrich-entities looks
      // Wikidata up by NAME, so "Espanyol B" returns RCD Espanyol's ID and
      // "Celta de Vigo B" returns Celta's. Both were reported as Tier A
      // duplicates on the live run, and merging either would have destroyed
      // a legitimate separate page: a reserve side is a real distinct team
      // with its own fixtures.
      // Same applies to -women, -legends, -u21 and -ii suffixes: real
      // separate entities that share a name root with the senior side.
      // These are split out rather than dropped — the ID collision is still
      // worth knowing about, it just means the ENRICHMENT is wrong, which is
      // its own finding.
      const hasVariant = group.some(s => /-(b|ii|iii|legends|women|reserves|u\d{2})$/.test(s));
      (hasVariant ? tierAVariantSuspect : tierA).push({ externalId: id, slugs: group.sort() });
    }

    // Pairs already explained by Tier A are not re-reported as B or C —
    // the authoritative evidence supersedes the string heuristics.
    const explained = new Set();
    for (const g of tierA) for (const s of g.slugs) explained.add(s);
    for (const g of tierAVariantSuspect) for (const s of g.slugs) explained.add(s);

    // ── Tier B: suffix-equivalent names ─────────────────────────────────
    const byStripped = new Map();
    for (const slug of slugs) {
      const key = stripTypeSuffix(slug);
      if (key === slug && !TYPE_SUFFIXES.some(sfx => slug.endsWith('-' + sfx) || slug.startsWith(sfx + '-'))) {
        // no suffix to strip — still index it so a bare name can pair with
        // its suffixed twin
      }
      if (!byStripped.has(key)) byStripped.set(key, []);
      byStripped.get(key).push(slug);
    }
    const tierB = [];
    const tierBRisky = [];
    for (const [key, group] of byStripped) {
      if (group.length < 2) continue;
      if (group.every(s => explained.has(s))) continue;
      // If the group still holds together when ONLY trailing markers are
      // stripped, the match does not depend on the risky leading-strip and
      // is the safer set. Otherwise it only matched because a leading
      // marker was removed — quarantine it for review.
      const trailingKeys = new Set(group.map(stripTrailingOnly));
      (trailingKeys.size === 1 ? tierB : tierBRisky).push({
        normalised: key,
        slugs: group.sort()
      });
    }
    for (const g of tierB) for (const s of g.slugs) explained.add(s);
    for (const g of tierBRisky) for (const s of g.slugs) explained.add(s);

    // ── Tier C: prefix relationships (REVIEW ONLY) ──────────────────────
    // Word-boundary prefixes only, so 'leeds' pairs with 'leeds-united' but
    // 'lee' does not. Still expect real false positives here by design —
    // see the header. Capped so a big section cannot produce an unreadable
    // list; this tier is meant to be skimmed by a human.
    const tierC = [];
    const sorted = [...slugs].sort();
    for (let i = 0; i < sorted.length && tierC.length < 100; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length && tierC.length < 100; j++) {
        const b = sorted[j];
        if (!b.startsWith(a + '-')) continue;         // strict word-boundary prefix
        if (explained.has(a) && explained.has(b)) continue;
        tierC.push({ shorter: a, longer: b });
      }
    }

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
  out.notes.push('READ-ONLY — nothing merged, deleted or redirected. Merging is a separate step, to be scoped against these findings.');

  return jsonResponse(out, 200);
}