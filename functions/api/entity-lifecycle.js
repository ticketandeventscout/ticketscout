// functions/api/entity-lifecycle.js
// =============================================================================
// ENTITY LIFECYCLE SWEEP — the back end of the entity lifecycle.
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// discover-pages.js has a front end to the lifecycle: the liquidity gate and
// the deferred queue decide what is allowed IN. Nothing has ever re-evaluated
// an entity once its page was committed, so the registry could only grow.
//
// The insight this is built on: the difference between an EVENT and an ENTITY
// is not in the name, it is in the dates.
//
//   An ENTITY keeps acquiring new dates.   (Michael Buble always tours again)
//   An EVENT has one date, then ZERO forever. ("Miami Open - Session 4")
//
// So we do not need to classify by name at all. Time does it for us, with no
// patterns, no language knowledge, and no human review. Name-based detection
// (discover-pages.js EVENT_PATTERNS) stays as a cheap first pass, but this is
// the mechanism that actually holds the line — including for junk classes
// nobody has thought of yet.
//
// STATES
// ------
//   active   has priced upcoming offers                -> nothing to do
//   dormant  no offers for DORMANT_AFTER_DAYS          -> delist from sitemap
//   expired  no offers for EXPIRE_AFTER_DAYS, unprotected -> purge (restorable)
//
// PROTECTION (important — read before tuning thresholds)
// ------------------------------------------------------
// Any entity with an enrichment record (a Wikidata or MusicBrainz match) is
// PROTECTED and can never expire — it only goes dormant. A real artist in a
// quiet year, or a football club in the off-season, has no upcoming priced
// offers and would otherwise be deleted. "Spektakl: Genialny pomysl" has no
// Wikidata entry and no future dates, so it expires on its own.
//
// REVERSIBILITY
// -------------
// Expiry writes to registry:purged:{section} using the EXACT entry shape
// registry-purge.js writes, so its existing ?restore={slug} works on anything
// this removes. This endpoint is deliberately not a second implementation of
// removal — it reuses that contract.
//
// Dormancy is fully self-healing: if offers reappear, misses reset to 0 and
// the entity leaves the dormant list on the next sweep. Nothing is lost.
//
// USAGE
// -----
//   ?trigger=1&section=concert[&limit=200]      run a batch (cursor-based)
//   ?trigger=1&section=concert&dry=1            preview, no writes  <-- START HERE
//   ?status=1[&section=concert]                 counts + cursor, read-only
//   ?dormant=1&section=concert                  list currently-dormant slugs
//   ?reset=1&section=concert&trigger=1          clear all state for a section
//
// SAFETY
// ------
//   KV 'lifecycle:enabled' = 'off'   kill-switch, no deploy needed
//   dry=1 is the DEFAULT unless trigger=1 is present.
//   Expiry additionally requires &expire=1 — a sweep will never delete
//   anything on its first run, so thresholds can be observed before they bite.
// =============================================================================

const REGISTRY_KEY = 'sitemap:registry';
const STATE_KEY    = s => `lifecycle:state:${s}`;
const CURSOR_KEY   = s => `lifecycle:cursor:${s}`;
const PURGE_LOG    = s => `registry:purged:${s}`;

// THRESHOLDS ARE TIME-BASED, NOT SWEEP-COUNT-BASED. This matters: the cursor
// means each entity is checked once per FULL CYCLE, and cycle length depends on
// section size. At limit=200 daily, concert (2,401) cycles every 12 days while
// theatre (139) cycles every day. Counting sweeps would have expired theatre
// entities in 12 days and concert entities in 5 months. Elapsed time since the
// FIRST consecutive miss is cadence-independent and survives any later change
// to limit or schedule.
const DORMANT_AFTER_DAYS = 30;
const EXPIRE_AFTER_DAYS  = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// firstMiss is set on the first miss and cleared the moment offers reappear.
function missAgeDays(v, nowMs) {
  if (!v || !v.firstMiss) return 0;
  const ts = Date.parse(v.firstMiss);
  return Number.isFinite(ts) ? (nowMs - ts) / DAY_MS : 0;
}
const isDormant = (v, nowMs) => missAgeDays(v, nowMs) >= DORMANT_AFTER_DAYS;
const isExpired = (v, nowMs) => missAgeDays(v, nowMs) >= EXPIRE_AFTER_DAYS;

const SECTIONS = ['concert', 'football', 'theatre', 'venue', 'sports'];

function kvPrefix(section) {
  if (section === 'concert')  return 'concert:artist:';
  if (section === 'football') return 'football:team:';
  if (section === 'theatre')  return 'theatre:show:';
  if (section === 'venue')    return 'venue:venue:';
  if (section === 'sports')   return 'sports:team:';
  return `${section}:`;
}

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const kv  = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'Missing GIGSBERG_KV' }, 500);

  const origin  = url.origin;
  const section = (url.searchParams.get('section') || '').toLowerCase();
  const trigger = url.searchParams.get('trigger') === '1';
  const dry     = url.searchParams.get('dry') === '1' || !trigger;

  // ── STATUS ──────────────────────────────────────────────────────────────
  if (url.searchParams.get('status') === '1') {
    const out = {};
    for (const s of (section ? [section] : SECTIONS)) {
      let state = {}, cursor = 0;
      try { const v = await kv.get(STATE_KEY(s)); if (v) state = JSON.parse(v); } catch {}
      try { const c = await kv.get(CURSOR_KEY(s)); cursor = c ? parseInt(c, 10) || 0 : 0; } catch {}
      const vals = Object.values(state);
      const nowMs = Date.now();
      out[s] = {
        tracked: vals.length,
        active:  vals.filter(v => !v.firstMiss).length,
        warming: vals.filter(v => v.firstMiss && !isDormant(v, nowMs)).length,
        dormant: vals.filter(v => isDormant(v, nowMs)).length,
        atExpiryThreshold: vals.filter(v => isExpired(v, nowMs) && !v.protected).length,
        protectedEntities: vals.filter(v => v.protected).length,
        oldestMissDays: vals.length ? Math.round(Math.max(0, ...vals.map(v => missAgeDays(v, nowMs)))) : 0,
        cursor
      };
    }
    return json({
      status: 'ok', readOnly: true,
      thresholds: { DORMANT_AFTER_DAYS, EXPIRE_AFTER_DAYS },
      sections: out
    });
  }

  // ── DORMANT LIST ────────────────────────────────────────────────────────
  // Intended consumer: sitemap.js, to delist dormant entities.
  if (url.searchParams.get('dormant') === '1') {
    if (!section) return json({ error: 'section required' }, 400);
    let state = {};
    try { const v = await kv.get(STATE_KEY(section)); if (v) state = JSON.parse(v); } catch {}
    const nowMs = Date.now();
    const slugs = Object.entries(state)
      .filter(([, v]) => isDormant(v, nowMs))
      .map(([slug, v]) => ({
        slug, misses: v.misses, firstMiss: v.firstMiss,
        missAgeDays: Math.round(missAgeDays(v, nowMs)), protected: !!v.protected
      }));
    return json({ section, readOnly: true, count: slugs.length, dormant: slugs });
  }

  // ── RESET ───────────────────────────────────────────────────────────────
  if (url.searchParams.get('reset') === '1') {
    if (!section) return json({ error: 'section required' }, 400);
    if (!trigger) return json({ error: 'reset requires &trigger=1' }, 400);
    await kv.delete(STATE_KEY(section)).catch(() => {});
    await kv.delete(CURSOR_KEY(section)).catch(() => {});
    return json({ section, message: 'Lifecycle state and cursor cleared.' });
  }

  // ── SWEEP ───────────────────────────────────────────────────────────────
  if (!section) {
    return json({
      error: 'section required',
      usage: [
        '?trigger=1&section=concert&dry=1   preview a batch (START HERE)',
        '?trigger=1&section=concert         run a batch',
        '?trigger=1&section=concert&expire=1  also purge past-threshold entities',
        '?status=1                          counts, read-only',
        '?dormant=1&section=concert         dormant slugs, read-only'
      ],
      sections: SECTIONS
    }, 400);
  }

  try {
    if ((await kv.get('lifecycle:enabled')) === 'off') {
      return json({ section, message: 'Lifecycle sweep disabled via KV kill-switch.' });
    }
  } catch {}

  const limit      = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 400);
  const allowExpire = url.searchParams.get('expire') === '1';

  let registry = null;
  try { registry = await kv.get(REGISTRY_KEY, 'json'); } catch {}
  if (!registry?.sections?.[section]) {
    return json({ error: `No registry section "${section}"` }, 503);
  }

  const slugs  = Object.keys(registry.sections[section]).sort();
  const prefix = kvPrefix(section);

  let cursor = 0;
  try { const c = await kv.get(CURSOR_KEY(section)); cursor = c ? parseInt(c, 10) || 0 : 0; } catch {}
  if (cursor >= slugs.length) cursor = 0;
  const batch = slugs.slice(cursor, cursor + limit);

  let state = {};
  try { const v = await kv.get(STATE_KEY(section)); if (v) state = JSON.parse(v); } catch {}

  const now = new Date().toISOString();
  const becameDormant = [], recovered = [], toExpire = [];
  let checked = 0, liquidCount = 0, protectedCount = 0;

  for (const slug of batch) {
    checked++;
    const prev = state[slug] || { misses: 0 };

    // Cheap check first — same order as recheck-deferred.
    let liquid = false;
    try { if (await kv.get(`price:summary:entity:${slug}`)) liquid = true; } catch {}

    let rec = null;
    try { const raw = await kv.get(prefix + slug); if (raw) rec = JSON.parse(raw); } catch {}
    const name = rec?.name || slug;

    if (!liquid) {
      try {
        const r = await fetch(`${origin}/api/awin-category?q=${encodeURIComponent(name)}`);
        if (r.ok) { const d = await r.json(); liquid = (d.matches || []).length > 0; }
      } catch {}
    }

    // PROTECTED: an enrichment record means an external source (Wikidata /
    // MusicBrainz) recognises this as a real entity. Dormant, never expired.
    // Key is 'entity:meta:{category}:{slug}' (enrich-entities.js META_PREFIX).
    // An earlier version used 'meta:{section}:{slug}' and silently matched
    // NOTHING — protectedEntities came back 0 on a batch that was fully
    // enriched. With protection broken every entity is expirable, so if this
    // ever reads 0 on an enriched section, treat it as a bug, not a result.
    let isProtected = false;
    try { if (await kv.get(`entity:meta:${section}:${slug}`)) isProtected = true; } catch {}
    if (!isProtected && rec && (rec.wikidataId || rec.mbid)) isProtected = true;
    if (isProtected) protectedCount++;

    const nowMs = Date.parse(now);

    if (liquid) {
      liquidCount++;
      // Recovery clears firstMiss entirely — a returning entity starts clean.
      if (isDormant(prev, nowMs)) recovered.push(slug);
      state[slug] = { misses: 0, firstMiss: null, lastSeen: now, protected: isProtected };
      continue;
    }

    const misses = (prev.misses || 0) + 1;
    const next = {
      misses,
      firstMiss: prev.firstMiss || now,
      lastSeen: prev.lastSeen || null,
      protected: isProtected
    };
    state[slug] = next;

    if (isDormant(next, nowMs) && !isDormant(prev, nowMs)) becameDormant.push({ slug, name });
    if (isExpired(next, nowMs) && !isProtected) {
      toExpire.push({ slug, name, missAgeDays: Math.round(missAgeDays(next, nowMs)) });
    }
  }

  // ── EXPIRY ──────────────────────────────────────────────────────────────
  // Writes registry:purged:{section} in registry-purge.js's exact entry shape,
  // so its ?restore={slug} works unchanged on anything removed here.
  // CIRCUIT BREAKER. If nothing in a whole batch is protected, the protection
  // lookup is far more likely broken than every entity being genuinely
  // unrecognised — that exact bug shipped once already. Refuse to delete.
  const protectionSuspect = checked >= 25 && protectedCount === 0;

  const expired = [];
  if (allowExpire && !dry && !protectionSuspect && toExpire.length) {
    let log = [];
    try { const l = await kv.get(PURGE_LOG(section)); if (l) log = JSON.parse(l); } catch {}
    for (const item of toExpire) {
      let record = null;
      try { record = await kv.get(prefix + item.slug); } catch {}
      log.push({
        slug: item.slug,
        name: item.name,
        lastmod: registry.sections[section][item.slug] || null,
        record,
        removedAt: now,
        removedBy: 'entity-lifecycle',
        reason: `no priced offers for ${EXPIRE_AFTER_DAYS}+ days`
      });
      delete registry.sections[section][item.slug];
      try { await kv.delete(prefix + item.slug); } catch {}
      delete state[item.slug];
      expired.push(item.slug);
    }
    await kv.put(REGISTRY_KEY, JSON.stringify(registry));
    await kv.put(PURGE_LOG(section), JSON.stringify(log));
    try { await kv.delete(`${section}:hub:index`); } catch {}
  }

  const nextCursor = cursor + batch.length;
  const done = nextCursor >= slugs.length;

  if (!dry) {
    await kv.put(STATE_KEY(section), JSON.stringify(state));
    await kv.put(CURSOR_KEY(section), String(done ? 0 : nextCursor));
  }

  return json({
    section,
    dryRun: dry,
    expireEnabled: allowExpire,
    totalInSection: slugs.length,
    batch: { cursor, size: batch.length },
    checked,
    liquid: liquidCount,
    protectedEntities: protectedCount,
    becameDormant: becameDormant.length,
    becameDormantSample: becameDormant.slice(0, 25),
    recoveredFromDormant: recovered.length,
    atExpiryThreshold: toExpire.length,
    expirySample: toExpire.slice(0, 25),
    expired: expired.length,
    expiredSlugs: expired,
    protectionSuspect,
    protectionWarning: protectionSuspect
      ? 'ZERO protected entities in this batch — protection lookup is probably broken. Expiry BLOCKED.'
      : undefined,
    done,
    next: done ? null : `?trigger=1&section=${section}&limit=${limit}${allowExpire ? '&expire=1' : ''}${dry ? '&dry=1' : ''}`,
    message: dry
      ? 'Dry run — no state written, nothing expired.'
      : (allowExpire ? 'Sweep complete.' : 'Sweep complete. Add &expire=1 to purge past-threshold entities.')
  });
}
