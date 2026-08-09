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
  // A leading type suffix is just as common: fc-barcelona, ac-milan.
  while (parts.length > 1 && TYPE_SUFFIXES.includes(parts[0])) parts.shift();
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
    totals: { tierA: 0, tierB: 0, tierC: 0, enrichedChecked: 0, entitiesScanned: 0 },
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
          const ids = [];
          if (meta.wikidataId) ids.push('wikidata:' + meta.wikidataId);
          if (meta.mbid) ids.push('mbid:' + meta.mbid);
          for (const id of ids) {
            if (!byExternalId.has(id)) byExternalId.set(id, []);
            byExternalId.get(id).push(slug);
          }
        } catch { /* unreadable meta is simply not evidence */ }
      }));
    }
    out.totals.enrichedChecked += enriched;

    const tierA = [];
    for (const [id, group] of byExternalId) {
      if (group.length > 1) tierA.push({ externalId: id, slugs: group.sort() });
    }

    // Pairs already explained by Tier A are not re-reported as B or C —
    // the authoritative evidence supersedes the string heuristics.
    const explained = new Set();
    for (const g of tierA) for (const s of g.slugs) explained.add(s);

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
    for (const [key, group] of byStripped) {
      if (group.length < 2) continue;
      if (group.every(s => explained.has(s))) continue;
      tierB.push({ normalised: key, slugs: group.sort() });
    }
    for (const g of tierB) for (const s of g.slugs) explained.add(s);

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
      tierB_suffixEquivalent: tierB,
      tierC_prefixReviewOnly: tierC.slice(0, 50),
      tierC_truncated: tierC.length > 50
    };
    out.totals.tierA += tierA.length;
    out.totals.tierB += tierB.length;
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
  out.notes.push('Tier C WILL contain false positives by design: bristol-city/bristol-rovers and sheffield-united/sheffield-wednesday are real distinct clubs that share a prefix. Review every pair before acting; never bulk-action this tier.');
  out.notes.push('READ-ONLY — nothing merged, deleted or redirected. Merging is a separate step, to be scoped against these findings.');

  return jsonResponse(out, 200);
}