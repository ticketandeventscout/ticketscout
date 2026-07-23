// /api/backfill-genres — repairs the `genre` field on registry entities.
//
// WHY
// Discovery wrote placeholder genres rather than real ones. Confirmed against
// live KV 23 Jul:
//   concert:artist:1000mods  -> genre "Live Events"
//   concert:artist:zz-top    -> genre "Live Music"
//   theatre:show:oh-mary     -> genre "Theatre"
// These are segment-level labels, so every hub pill collapses to a single
// bucket. They also leak into the generated copy ("1000MODS are a renowned
// Live Events act"), so this repairs ~2,300 descriptions as a side effect.
//
// APPROACH
// One TM attractions lookup per entity, cursor-batched so a run is bounded and
// resumable. Only entities whose genre is a known placeholder are touched, so
// re-running is cheap and hand-curated genres are never overwritten.
//
// SAFETY
// A keyword search can return the wrong attraction, so a result is accepted
// ONLY if the returned name matches the stored name after normalisation.
// Anything else is recorded as unmatched and left alone — a wrong genre is
// worse than a missing one.
//
// Endpoints:
//   ?status=1                     progress, no writes, no TM calls
//   ?trigger=1&section=concert    process the next batch
//   ?trigger=1&...&limit=200      batch size (default 100, max 300)
//   ?trigger=1&...&dry=1          report what would change, write nothing
//   ?reset=1&section=concert      restart the cursor

const SECTIONS = {
  concert: { prefix: 'concert:artist:', expectSegment: 'Music' },
  theatre: { prefix: 'theatre:show:',   expectSegment: 'Arts & Theatre' },
  sports:  { prefix: 'sports:team:',    expectSegment: 'Sports' }
};

// Values that mean "we never actually resolved a genre". Case-insensitive.
const PLACEHOLDER_GENRES = new Set([
  '', 'live events', 'live music', 'theatre', 'undefined', 'other',
  'miscellaneous', 'sport', 'sports', 'music', 'arts & theatre', 'unknown', 'n/a'
]);

const CURSOR_KEY   = s => 'backfill:genre:cursor:' + s;
const MISFILED_KEY = s => 'backfill:genre:misfiled:' + s;
const REPORT_KEY   = s => 'backfill:genre:report:' + s;
const REVIEW_KEY   = s => 'backfill:genre:review:' + s;
const OVERRIDE_KEY = s => 'backfill:genre:override:' + s;

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// Normalisation used purely for match confirmation — deliberately aggressive,
// because TM and our records disagree on punctuation, accents and casing.
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isPlaceholder(g) {
  return PLACEHOLDER_GENRES.has(String(g || '').trim().toLowerCase());
}

// TM nests the useful label inconsistently: genre is sometimes "Undefined"
// with the real value on subGenre, sometimes the reverse.
function pickGenre(cls) {
  if (!cls) return null;
  const g  = cls.genre    && cls.genre.name;
  const sg = cls.subGenre && cls.subGenre.name;
  // Reject segment-level labels too. TM returns genre "Theatre" for most
  // Arts & Theatre acts with the useful value on subGenre — "Oh, Mary!" is
  // genre Theatre / subGenre Comedy — so accepting genre blindly would just
  // re-store the placeholder we are trying to remove.
  const ok = v => v && !isPlaceholder(v);
  if (ok(g))  return g;
  if (ok(sg)) return sg;
  return null;
}

// Words that carry no identifying information in a production title. Dropping
// them is what lets 'Beetlejuice The Musical' match TM's 'Beetlejuice
// (Touring)', and 'Be Like Blippi' match 'Blippi: Be Like Blippi Tour'.
const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at',
  'musical', 'the musical', 'show', 'live', 'tour', 'touring',
  'concert', 'uk', 'london', 'presents', 'experience'
]);

function tokenise(s) {
  return norm(s).split(' ').filter(w => w && !NOISE_WORDS.has(w));
}

// Returns BOTH the full form and the prefix-stripped form, because stripping
// is right for some titles and wrong for others: TM's 'Blippi: Be Like Blippi
// Tour' needs the prefix gone to match 'Be Like Blippi', but 'Beautiful: the
// Carole King Musical' would lose the word 'Beautiful', which is the title.
// Trying both and keeping the best match serves both cases.
function coreVariants(s) {
  const base = String(s || '').replace(/\([^)]*\)/g, ' ');  // drop '(Touring)'
  const out = [tokenise(base)];
  const stripped = base.replace(/^[^:]{1,24}:\s*/, ' ');
  if (stripped !== base) out.push(tokenise(stripped));
  return out.filter(v => v.length);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort().join('|'), sb = [...b].sort().join('|');
  return sa === sb;
}

function isSubset(small, big) {
  const set = new Set(big);
  return small.length > 0 && small.every(w => set.has(w));
}

// Tiered confidence. Exact-name matching alone proved insufficient in BOTH
// directions during the 23 Jul dry run: it rejected real matches that differ
// only by a '(Touring)' suffix, AND it accepted 'Back To The Future' against
// a classical film-in-concert listing. So we grade the match and, separately,
// refuse to write when equally-good candidates disagree about the genre.
function classifyMatch(ourName, tmName) {
  if (norm(ourName) === norm(tmName)) return 'exact';
  const oursV = coreVariants(ourName), theirsV = coreVariants(tmName);
  if (!oursV.length || !theirsV.length) return null;
  let best = null;
  for (const ours of oursV) {
    for (const theirs of theirsV) {
      if (sameSet(ours, theirs)) return 'strong';
      if (isSubset(ours, theirs)) best = 'weak';
    }
  }
  return best;
}

const TIER_RANK = { exact: 3, strong: 2, weak: 1 };

async function lookupAttraction(apiKey, name) {
  const u = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
  u.searchParams.set('apikey', apiKey);
  u.searchParams.set('keyword', name);
  u.searchParams.set('size', '10');

  const r = await fetch(u.toString());
  if (!r.ok) return { ok: false, status: r.status };

  const data = await r.json();
  const list = (data._embedded && data._embedded.attractions) || [];

  const matches = [];
  for (const a of list) {
    const tier = classifyMatch(name, a.name);
    if (!tier) continue;
    const cls = (a.classifications && a.classifications[0]) || null;
    matches.push({
      tmName: a.name,
      tier,
      genre: pickGenre(cls),
      segment: (cls && cls.segment && cls.segment.name) || null
    });
  }

  if (!matches.length) {
    return { ok: true, matched: false, candidates: list.slice(0, 3).map(a => a.name) };
  }

  const best = Math.max(...matches.map(m => TIER_RANK[m.tier]));
  const top = matches.filter(m => TIER_RANK[m.tier] === best);

  // Equally-confident candidates disagreeing on genre is the signal that the
  // title is ambiguous — 'Back To The Future' is both a musical and a film
  // score concert. Refuse to guess; queue it for a human.
  const genres = [...new Set(top.map(m => m.genre).filter(Boolean))];
  if (genres.length > 1) {
    return {
      ok: true, matched: true, ambiguous: true,
      tier: top[0].tier,
      options: top.map(m => ({ tmName: m.tmName, genre: m.genre, segment: m.segment }))
    };
  }

  return {
    ok: true, matched: true, ambiguous: false,
    tmName: top[0].tmName,
    tier: top[0].tier,
    genre: top[0].genre,
    segment: top[0].segment
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const section = (url.searchParams.get('section') || 'concert').toLowerCase();
  const cfg = SECTIONS[section];
  if (!cfg) return json({ error: 'Unknown section. Use: ' + Object.keys(SECTIONS).join(', ') }, 400);

  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'No GIGSBERG_KV binding' }, 500);

  let slugs = [];
  try {
    const reg = await kv.get('sitemap:registry', 'json');
    slugs = Object.keys((reg && reg.sections && reg.sections[section]) || {}).sort();
  } catch (e) {
    return json({ error: 'registry read failed: ' + String(e) }, 500);
  }

  const cursor = parseInt(await kv.get(CURSOR_KEY(section)) || '0', 10) || 0;

  if (url.searchParams.get('reset') === '1') {
    await kv.put(CURSOR_KEY(section), '0');
    return json({ section, reset: true, totalRegistered: slugs.length });
  }

  if (url.searchParams.get('status') === '1') {
    let report = null, misfiled = null, review = null, overridesNow = null;
    try { report       = await kv.get(REPORT_KEY(section), 'json'); } catch {}
    try { misfiled     = await kv.get(MISFILED_KEY(section), 'json'); } catch {}
    try { review       = await kv.get(REVIEW_KEY(section), 'json'); } catch {}
    try { overridesNow = await kv.get(OVERRIDE_KEY(section), 'json'); } catch {}
    return json({
      section,
      totalRegistered: slugs.length,
      cursor,
      remaining: Math.max(0, slugs.length - cursor),
      complete: cursor >= slugs.length,
      misfiledCount: (misfiled && misfiled.length) || 0,
      misfiledSample: (misfiled || []).slice(0, 20),
      reviewCount: (review && review.length) || 0,
      reviewSample: (review || []).slice(0, 20),
      overrideCount: Object.keys(overridesNow || {}).length,
      lastRun: report
    });
  }

  if (url.searchParams.get('trigger') !== '1') {
    return json({ error: 'Add ?trigger=1 to run, or ?status=1 to inspect.' }, 400);
  }

  const apiKey = env.TM_API_KEY;
  if (!apiKey) return json({ error: 'Missing TM_API_KEY' }, 500);

  const dry = url.searchParams.get('dry') === '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 300);
  const batch = slugs.slice(cursor, cursor + limit);

  const stats = {
    section, dryRun: dry, batchStart: cursor, batchSize: batch.length,
    updated: 0, alreadyGood: 0, unmatched: 0, noGenre: 0,
    missingRecord: 0, tmErrors: 0, misfiled: 0,
    ambiguous: 0, weakQueued: 0, fromOverride: 0
  };
  const samples = [];
  const misfiledNew = [];
  const reviewNew = [];

  // Manual corrections always win, so a bad automated guess can be fixed
  // once and never regress. Shape: { "back-to-the-future": "Musical" }
  let overrides = {};
  try { overrides = (await kv.get(OVERRIDE_KEY(section), 'json')) || {}; } catch {}

  for (const slug of batch) {
    let rec = null;
    try {
      const raw = await kv.get(cfg.prefix + slug);
      if (!raw) { stats.missingRecord++; continue; }
      rec = JSON.parse(raw);
    } catch { stats.missingRecord++; continue; }

    if (overrides[slug]) {
      stats.fromOverride++;
      if (!dry && rec.genre !== overrides[slug]) {
        rec.genre = overrides[slug];
        try { await kv.put(cfg.prefix + slug, JSON.stringify(rec)); } catch {}
      }
      continue;
    }

    if (!isPlaceholder(rec.genre)) { stats.alreadyGood++; continue; }

    let res;
    try {
      res = await lookupAttraction(apiKey, rec.search || rec.name || slug);
    } catch (e) { stats.tmErrors++; continue; }

    if (!res.ok) { stats.tmErrors++; continue; }

    if (!res.matched) {
      stats.unmatched++;
      if (samples.length < 15) {
        samples.push({ slug, name: rec.name, result: 'unmatched', candidates: res.candidates });
      }
      continue;
    }

    if (res.ambiguous) {
      stats.ambiguous++;
      reviewNew.push({ slug, name: rec.name, reason: 'ambiguous', options: res.options });
      if (samples.length < 15) {
        samples.push({ slug, name: rec.name, result: 'ambiguous', options: res.options });
      }
      continue;
    }

    // Only exact and strong matches are written automatically. Weak matches
    // are a token-subset guess and go to review instead — a wrong genre is
    // worse than a missing one, which the first dry run proved the hard way.
    if (res.tier === 'weak') {
      stats.weakQueued++;
      reviewNew.push({ slug, name: rec.name, reason: 'weak-match',
                       tmName: res.tmName, genre: res.genre, segment: res.segment });
      if (samples.length < 15) {
        samples.push({ slug, name: rec.name, result: 'weak-queued',
                       tmName: res.tmName, wouldBe: res.genre });
      }
      continue;
    }

    // Segment disagreement flags miscategorisation — e.g. "British F1 GP"
    // filed under concert. Recorded for review, never auto-moved: moving a
    // slug changes its URL, which is an SEO decision, not a script's call.
    if (res.segment && res.segment !== cfg.expectSegment) {
      stats.misfiled++;
      misfiledNew.push({ slug, name: rec.name, tmSegment: res.segment, expected: cfg.expectSegment });
    }

    if (!res.genre) {
      stats.noGenre++;
      continue;
    }

    if (samples.length < 15) {
      samples.push({ slug, name: rec.name, from: rec.genre, to: res.genre, tmSegment: res.segment });
    }

    if (!dry) {
      const before = rec.genre;
      rec.genre = res.genre;

      // The generated description embeds the old placeholder verbatim
      // ("... are a renowned Live Events act ..."). Repair it in place rather
      // than leaving copy that contradicts the badge on the page.
      if (before && typeof rec.description === 'string' && rec.description.includes(before)) {
        rec.description = rec.description.split(before).join(res.genre);
      }

      try { await kv.put(cfg.prefix + slug, JSON.stringify(rec)); stats.updated++; }
      catch { stats.tmErrors++; }
    } else {
      stats.updated++;
    }
  }

  const newCursor = Math.min(cursor + batch.length, slugs.length);

  if (!dry) {
    try { await kv.put(CURSOR_KEY(section), String(newCursor)); } catch {}

    if (reviewNew.length) {
      let existing = [];
      try { existing = (await kv.get(REVIEW_KEY(section), 'json')) || []; } catch {}
      const seen = new Set(existing.map(m => m.slug));
      for (const m of reviewNew) if (!seen.has(m.slug)) existing.push(m);
      try { await kv.put(REVIEW_KEY(section), JSON.stringify(existing)); } catch {}
    }

    if (misfiledNew.length) {
      let existing = [];
      try { existing = (await kv.get(MISFILED_KEY(section), 'json')) || []; } catch {}
      const seen = new Set(existing.map(m => m.slug));
      for (const m of misfiledNew) if (!seen.has(m.slug)) existing.push(m);
      try { await kv.put(MISFILED_KEY(section), JSON.stringify(existing)); } catch {}
    }

    // Invalidate the hub index so the repaired genres show up immediately
    // rather than after the 6h TTL.
    try { await kv.delete(section + ':hub:index'); } catch {}
  }

  const report = {
    ...stats,
    cursor: newCursor,
    remaining: Math.max(0, slugs.length - newCursor),
    complete: newCursor >= slugs.length,
    totalRegistered: slugs.length,
    ranAt: new Date().toISOString()
  };

  if (!dry) { try { await kv.put(REPORT_KEY(section), JSON.stringify(report)); } catch {} }

  return json({ ...report, samples });
}
