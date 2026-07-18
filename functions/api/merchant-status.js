// ===========================
// TicketScout — /api/merchant-status (Phase 6.3 consumption side)
//
// One small JSON read that compare.js fetches once per compare render:
//   { suspended: ['gigsberg'], badges: ['se365'], scores: { se365: 0.87, ... } }
//
// - suspended: merchants with a merchant:suspend:{id} KV key — compare.js
//   skips their adapters entirely (and /api/go bounces any stale clicks)
// - badges: trust ≥ 0.8 with ≥ 60 days of data (computed nightly by
//   price-rollup, stored in merchant:scores) → "Trusted Seller ✓" in the UI
// - scores: raw trust numbers for the future F1 value sort — NOT for display
//
// Edge-cached 5 minutes: the kill-switch propagates to browsers in ≤5 min,
// while /api/go enforces it instantly server-side for clicks.
// ===========================

const MERCHANT_IDS = [
  'tm', 'gigsberg', 'ftn', 'ttd', 'eventim_uk', 'eventim_pl',
  'se365', 'vividseats', 'ticketnetwork', 'ticombo', 'skiddle', 'seatgeek'
];

export async function onRequestGet({ env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ suspended: [], badges: [], scores: {} });

  // Suspensions — read individually (rare keys, cheap)
  const suspended = [];
  await Promise.all(MERCHANT_IDS.map(async id => {
    try { if (await kv.get(`merchant:suspend:${id}`)) suspended.push(id); } catch {}
  }));

  // Scores + badges — single combined key written by the nightly rollup
  let scores = {}, badges = [];
  try {
    const raw = await kv.get('merchant:scores');
    if (raw) {
      const data = JSON.parse(raw);
      scores = data.scores || {};
      badges = data.badges || [];
    }
  } catch {}

  return json({ suspended, badges, scores });
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
