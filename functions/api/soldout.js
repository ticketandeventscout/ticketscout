// ===========================
// TicketScout — Soldout.com affiliate adapter  (LIVE — deep-link)
// Runs as a Cloudflare Pages Function at /api/soldout
//
// REPO LOCATION: functions/api/soldout.js
//
// Soldout.com is a Commission Junction (CJ) advertiser. It offers embeddable
// tracking links only — NO product feed — so this is a deep-link adapter in
// the Hotels.com / Trivago mould: no KV cache, no cron, no network call. It
// builds a Soldout performer-page URL from the (already performer-stripped)
// event name and wraps it in the CJ click link. Always returns a link,
// never a live price.
//
// CJ details (from the Soldout Links page):
//   Publisher ID:            101816942  (same account as Hotels.com/Trivago)
//   Soldout advertiser link:  17268238
//   Click base:              https://www.tkqlhce.com/click-101816942-17268238
//   Deep-link format:        {click base}?url={ENCODED performer page URL}
//     (identical mechanism to hotels.js — the ?url= param is proven to work
//      with this CJ publisher account and the tkqlhce.com domain, which is
//      already allow-listed in go.js.)
//
// Soldout URL pattern (confirmed live):
//   https://soldout.com/performer/{slug}-tickets   e.g. metallica-tickets
//   The performer slug is the lowercased, hyphenated performer name. Because
//   compare.js passes the performer-stripped name (extractPerformerName), a
//   tour title like "Metallica: Life Burns Faster" arrives here as
//   "Metallica" → /performer/metallica-tickets.
//
// ARCHITECTURE RULE: Soldout is a compare-table seller only — it must NOT be
// added to the event LIST fetches (concert/football/theatre/venue pages use
// TM/Awin/SE365 only). It is registered in compare.js's ADAPTERS array and
// surfaces only in the side-by-side compare table, exactly like VS/TN/Ticombo.
// ===========================

const CJ_CLICK_BASE = 'https://www.tkqlhce.com/click-101816942-17268238';
const SOLDOUT_BASE  = 'https://soldout.com/performer';

export async function onRequestGet(ctx) {
  const { request } = ctx;
  const url  = new URL(request.url);
  const q    = (url.searchParams.get('q') || '').trim();
  const cat  = (url.searchParams.get('cat') || '').trim().toLowerCase();
  const mode = url.searchParams.get('mode') || 'single'; // 'list' | 'single'

  if (!q) return jsonResponse({ error: 'q (performer/event name) is required.' }, 400);

  // Soldout lists UK football clubs as "{Club} FC" (e.g. arsenal-fc-tickets).
  // Append 'fc' for football, UNLESS the name already ends in a club suffix
  // (fc/cf) — foreign clubs like "FC Barcelona"/"Real Madrid CF" keep their
  // own name and are passed through plain (cat won't be 'football' for those
  // via the football pages, but this guards manual/edge calls too).
  let performer = q;
  if (cat === 'football' && !/\b(fc|cf)\b/i.test(q)) {
    performer = `${q} FC`;
  }

  const slug = soldoutSlug(performer);
  if (!slug) return jsonResponse(mode === 'list' ? { matches: [] } : { match: null }, 200);

  const performerUrl = `${SOLDOUT_BASE}/${slug}-tickets`;
  const affiliateUrl = `${CJ_CLICK_BASE}?url=${encodeURIComponent(performerUrl)}`;

  const match = {
    name:       `${q} tickets on Soldout`,
    url:        affiliateUrl,
    price:      null,       // deep-link mode: no per-event price
    currency:   'GBP',
    date:       null,
    venue:      null,
    city:       null,
    isFallback: true        // compare.js/entity list code skips isFallback rows;
                            // this appears in the compare TABLE only, like the
                            // VS/TN search fallbacks.
  };

  return jsonResponse(mode === 'list' ? { matches: [match] } : { match }, 200);
}

// "Metallica" -> "metallica"; "AC/DC" -> "ac-dc"; "Beyoncé" -> "beyonce".
// Mirrors the diacritic/ampersand handling used elsewhere in the codebase.
function soldoutSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
