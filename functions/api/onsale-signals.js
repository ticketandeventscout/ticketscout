// ===========================
// TicketScout — On-sale signal extractor
// Runs as a Cloudflare Pages Function at /api/onsale-signals
//
// SCOPE, DELIBERATELY NARROW: reads an external on-sale-announcement page —
// configured via the SIGNAL_SOURCE_URL environment variable (Cloudflare
// dashboard → Settings → Environment variables), NEVER hardcoded here —
// purely for SIGNAL: which artist, and roughly when tickets go on sale.
// Never their content: never stores or reproduces their descriptive
// sentences, images, or exact phrasing. The only output is a priority-queue
// entry: {slug, category, onSaleDay, onSaleDateText, onSaleTime, onSaleNow}.
// If a name doesn't already match something in OUR OWN registry, it's
// simply not written anywhere — this never introduces a new entity by
// itself, it only re-prioritises entities we already track.
//
// WHY AN ENV VAR AND NOT A CONSTANT: this file lives in a public repo. Env
// vars aren't committed to git — same reason TM_API_KEY / GITHUB_TOKEN are
// never string literals in this codebase. Nothing here names the source.
//
// Usage: GET /api/onsale-signals?trigger=1            (dry run — report only)
//        GET /api/onsale-signals?trigger=1&confirm=yes (write to the queue)
// ===========================

const QUEUE_KEY  = 'priority:queue';
const MAX_QUEUE_SIZE = 200;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return jsonResponse({ error: 'requires ?trigger=1' }, 400);
  }
  const confirm = url.searchParams.get('confirm') === 'yes';
  const kv = env.GIGSBERG_KV;
  if (!kv) return jsonResponse({ error: 'Missing GIGSBERG_KV' }, 500);
  const sourceUrl = env.SIGNAL_SOURCE_URL;
  if (!sourceUrl) {
    return jsonResponse({ error: 'Missing SIGNAL_SOURCE_URL environment variable — set it in the Cloudflare dashboard, not in code.' }, 500);
  }

  let html = '';
  try {
    const resp = await fetch(sourceUrl, { headers: { 'User-Agent': 'TicketScout-SignalBot/1.0' } });
    if (!resp.ok) return jsonResponse({ error: 'fetch failed: HTTP ' + resp.status }, 502);
    html = await resp.text();
  } catch (e) {
    return jsonResponse({ error: 'fetch failed: ' + String(e) }, 502);
  }

  const signals = extractSignals(html);

  // Cross-reference against our OWN registry — this is the only place a
  // signal can turn into an action, and it can only ever match something we
  // already track. Checks all four sections since the source occasionally
  // covers comedy/boxing alongside music, which can land in theatre/sports.
  let registry = null;
  try {
    registry = await kv.get('sitemap:registry', 'json');
  } catch (e) {
    return jsonResponse({ error: 'registry read failed: ' + String(e) }, 500);
  }
  const sections = (registry && registry.sections) || {};
  const CATS = ['concert', 'football', 'theatre', 'sports'];

  const matches = [];
  for (const sig of signals) {
    const slug = toSlug(sig.name);
    if (!slug) continue;
    for (const cat of CATS) {
      if (sections[cat] && Object.prototype.hasOwnProperty.call(sections[cat], slug)) {
        matches.push({
          slug, category: cat,
          onSaleDay: sig.onSaleDay, onSaleDateText: sig.onSaleDateText,
          onSaleTime: sig.onSaleTime, onSaleNow: sig.onSaleNow, onSaleToday: sig.onSaleToday
        });
        break; // one entity shouldn't be queued under two categories
      }
    }
  }

  let queueBefore = 0, queueAfter = 0, queued = [];
  if (confirm && matches.length) {
    let queue = [];
    try {
      const raw = await kv.get(QUEUE_KEY, 'json');
      if (Array.isArray(raw)) queue = raw;
    } catch {}
    queueBefore = queue.length;

    const bySlugCat = new Map(queue.map(q => [q.category + ':' + q.slug, q]));
    for (const m of matches) {
      const key = m.category + ':' + m.slug;
      bySlugCat.set(key, { ...m, queuedAt: new Date().toISOString(), source: 'onsale-signal' });
    }
    queue = [...bySlugCat.values()].slice(-MAX_QUEUE_SIZE); // keep most recent N
    queued = queue.filter(q => matches.some(m => m.slug === q.slug && m.category === q.category));

    try {
      await kv.put(QUEUE_KEY, JSON.stringify(queue));
      queueAfter = queue.length;
    } catch (e) {
      return jsonResponse({ error: 'queue write failed: ' + String(e) }, 500);
    }
  }

  return jsonResponse({
    dryRun: !confirm,
    signalsExtracted: signals.length,
    registryMatches: matches.length,
    matches: matches.slice(0, 50),
    queueBefore, queueAfter,
    note: confirm
      ? 'Matched signals merged into ' + QUEUE_KEY + ' — the registration sweep checks this before its normal cursor.'
      : 'Dry run — nothing written. Add &confirm=yes to queue the matches above.'
  }, 200);
}

// Extracts ONLY {name, onSaleDay, onSaleDateText, onSaleTime, onSaleNow,
// onSaleToday} per entry — never the surrounding sentence, never images.
// Bounded 600-char lookahead after each bold name keeps this from ever
// accidentally spanning into an unrelated later paragraph.
function extractSignals(html) {
  const signals = [];
  const nameRe = /<(?:strong|b)>\s*([^<]+?),?\s*<\/(?:strong|b)>\s*,?/g;
  let m;
  while ((m = nameRe.exec(html)) !== null) {
    const name = (m[1] || '').trim();
    if (!name || name.length > 80) continue; // guards against a mis-fire on an unrelated long bold block

    // Window ends at the START of the NEXT bold-name tag (or a 600-char cap
    // for the last entry on the page / an unusually long single paragraph).
    // A fixed 600-char lookahead alone bled into the FOLLOWING entry on any
    // paragraph shorter than that — e.g. "Artist, tickets on sale Friday
    // (07 Aug) at 10am" is ~60 chars, so the window reached the next
    // entry's "tickets on sale now" and wrongly tagged THIS entry as
    // on-sale-now too. Caught by testing with realistic back-to-back short
    // entries, not a single isolated fixture.
    const searchFrom = nameRe.lastIndex;
    const nextBoldMatch = /<(?:strong|b)>/i.exec(html.slice(searchFrom));
    const windowEnd = nextBoldMatch
      ? Math.min(searchFrom + nextBoldMatch.index, m.index + 600)
      : m.index + 600;
    const windowText = html.slice(m.index, windowEnd);

    const saleMatch =
      windowText.match(/tickets?\s+on\s+sale\s+(\w+day)\s*\(([^)]+)\)\s*at\s*([\d:.]+\s*[ap]m)/i) ||
      windowText.match(/tickets?\s+on\s+sale\s+(\w+day)\s*\(([^)]+)\)/i);
    const nowMatch        = /tickets?\s+on\s+sale\s+now/i.test(windowText);
    const todayTimeMatch  = windowText.match(/tickets?\s+on\s+sale\s+at\s*([\d:.]+\s*[ap]m)/i);

    let onSaleDay = null, onSaleDateText = null, onSaleTime = null, onSaleNow = false, onSaleToday = false;
    if (saleMatch) {
      onSaleDay = saleMatch[1];
      onSaleDateText = saleMatch[2];
      onSaleTime = saleMatch[3] || null;
    } else if (nowMatch) {
      onSaleNow = true;
    } else if (todayTimeMatch) {
      onSaleToday = true;
      onSaleTime = todayTimeMatch[1];
    }
    if (nowMatch && saleMatch) onSaleNow = true;

    if (!saleMatch && !nowMatch && !todayTimeMatch) continue; // no timing signal — skip
    signals.push({ name, onSaleDay, onSaleDateText, onSaleTime, onSaleNow, onSaleToday });
  }
  return signals;
}

// Same normalisation family as autocomplete.js's normaliseToSlug. Diacritic
// folding is NOT optional here — testing against the real source's actual
// rendering of "JAŸ-Z" (with a diaeresis) showed why: without NFD
// normalisation first, the ÿ is simply DELETED by the character strip below
// (it isn't in [a-z0-9\s-]), producing "ja-z" instead of "jay-z" — a silent
// miss against the registry for exactly the kind of big-name act this
// exists to catch.
function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // ÿ -> y, é -> e, etc.
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
