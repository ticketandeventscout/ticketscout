// ===========================
// TicketScout — Automated affiliate conversions sync (Phase 6.3 automation)
// Runs as a Cloudflare Pages Function at /api/affiliate-conversions
//
// Replaces the manual weekly D1 entry: pulls the last N days of transactions
// from each network's reporting API and UPSERTS per-day conversion counts
// into merchant_daily. Idempotent — re-runs overwrite the same days with
// fresh totals (SET, not increment), so late-tracking conversions and
// status changes self-correct on the next run.
//
// Networks:
//   awin       — GET api.awin.com/publishers/{id}/transactions (Bearer token)
//   impact     — GET api.impact.com/Mediapartners/{SID}/Actions (Basic auth)
//   partnerize — GET api.performancehorizon.com conversions (Basic auth)
//   (CJ hotels/trivago and SE365-direct stay manual — negligible volume now;
//    CJ's GraphQL commissions API can be added when hotel volume justifies it)
//
// SECRETS (Pages project → Settings → Environment variables). Any that are
// missing simply skip that network with a note — nothing fails:
//   AWIN_API_TOKEN            — Awin dashboard → API credentials (publisher 2960641)
//   IMPACT_ACCOUNT_SID        — Impact → Settings → API (publisher 7443544)
//   IMPACT_AUTH_TOKEN         —   "
//   PARTNERIZE_API_KEY        — Partnerize account (publisher 1110l36128)
//   PARTNERIZE_USER_KEY       —   "
//
// MERCHANT MAPPING — one-time KV config, key `affiliate:advertiser-map`:
//   { "awin":   { "<advertiserId>": "gigsberg", "<advertiserId>": "ftn", ... },
//     "impact": { "<campaignId>": "vividseats", "<campaignId>": "ticketnetwork" },
//     "partnerize": { "<campaignId>": "ticombo" } }
// Advertiser/campaign IDs appear in each network dashboard. Any transaction
// from an UNMAPPED id is reported in the response under `unmapped` so the
// map can be extended — nothing is silently dropped.
//
// Usage:
//   ?trigger=1                    — sync all configured networks, last 10 days
//   ?trigger=1&network=awin       — one network only
//   ?trigger=1&days=30            — wider window (e.g. first backfill)
//   &dry=1                        — fetch + aggregate, no D1 writes
//
// Cron: Monday 01:30 via the cron worker (after the 00:xx discovery chain).
// ===========================

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.searchParams.get('trigger') !== '1') {
    return json({ usage: '?trigger=1 [&network=awin|impact|partnerize] [&days=10] [&dry=1]' }, 200);
  }

  const db = env.PRICE_DB;
  const kv = env.GIGSBERG_KV;
  if (!db) return json({ error: 'Missing PRICE_DB binding' }, 500);

  const dryRun = url.searchParams.get('dry') === '1';
  const only   = url.searchParams.get('network');
  const days   = Math.min(parseInt(url.searchParams.get('days') || '10', 10) || 10, 90);
  const since  = new Date(Date.now() - days * 86400000);
  const sinceISO = since.toISOString().slice(0, 10);
  const untilISO = new Date().toISOString().slice(0, 10);

  // Advertiser/campaign → merchant id map from KV
  let advMap = { awin: {}, impact: {}, partnerize: {} };
  try {
    const raw = await kv?.get('affiliate:advertiser-map');
    if (raw) advMap = { ...advMap, ...JSON.parse(raw) };
  } catch {}

  const report = { window: `${sinceISO}..${untilISO}`, networks: {}, unmapped: {}, dryRun };
  // counts[merchantId][day] = conversions
  const counts = {};
  const bump = (merchant, day) => {
    if (!counts[merchant]) counts[merchant] = {};
    counts[merchant][day] = (counts[merchant][day] || 0) + 1;
  };
  const noteUnmapped = (network, id, name) => {
    if (!report.unmapped[network]) report.unmapped[network] = {};
    const key = `${id}${name ? ` (${name})` : ''}`;
    report.unmapped[network][key] = (report.unmapped[network][key] || 0) + 1;
  };

  // ── AWIN — Gigsberg, FTN, TTD, Eventim UK/PL ──────────────────────────
  if ((!only || only === 'awin')) {
    if (!env.AWIN_API_TOKEN) {
      report.networks.awin = { skipped: 'AWIN_API_TOKEN not set' };
    } else try {
      const u = `https://api.awin.com/publishers/2960641/transactions/` +
        `?startDate=${sinceISO}T00:00:00&endDate=${untilISO}T23:59:59&timezone=UTC`;
      const r = await fetch(u, { headers: { 'Authorization': `Bearer ${env.AWIN_API_TOKEN}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const txns = await r.json();
      let used = 0;
      for (const t of (Array.isArray(txns) ? txns : [])) {
        if (t.commissionStatus === 'declined') continue;   // count pending + approved
        const merchant = advMap.awin[String(t.advertiserId)];
        const day = (t.transactionDate || '').slice(0, 10);
        if (!merchant) { noteUnmapped('awin', t.advertiserId, t.advertiserName); continue; }
        if (!day) continue;
        bump(merchant, day); used++;
      }
      report.networks.awin = { transactions: (txns || []).length, counted: used };
    } catch (err) { report.networks.awin = { error: String(err) }; }
  }

  // ── IMPACT — Vivid Seats, TicketNetwork ───────────────────────────────
  if ((!only || only === 'impact')) {
    if (!env.IMPACT_ACCOUNT_SID || !env.IMPACT_AUTH_TOKEN) {
      report.networks.impact = { skipped: 'IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN not set' };
    } else try {
      const auth = 'Basic ' + btoa(`${env.IMPACT_ACCOUNT_SID}:${env.IMPACT_AUTH_TOKEN}`);
      const u = `https://api.impact.com/Mediapartners/${env.IMPACT_ACCOUNT_SID}/Actions` +
        `?StartDate=${sinceISO}T00:00:00Z&EndDate=${untilISO}T23:59:59Z&PageSize=1000`;
      const r = await fetch(u, { headers: { 'Authorization': auth, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      const actions = data.Actions || [];
      let used = 0;
      for (const a of actions) {
        if ((a.State || '').toUpperCase() === 'REVERSED') continue;
        const merchant = advMap.impact[String(a.CampaignId)];
        const day = (a.EventDate || a.CreationDate || '').slice(0, 10);
        if (!merchant) { noteUnmapped('impact', a.CampaignId, a.CampaignName); continue; }
        if (!day) continue;
        bump(merchant, day); used++;
      }
      report.networks.impact = { actions: actions.length, counted: used };
    } catch (err) { report.networks.impact = { error: String(err) }; }
  }

  // ── PARTNERIZE — Ticombo ──────────────────────────────────────────────
  if ((!only || only === 'partnerize')) {
    if (!env.PARTNERIZE_API_KEY || !env.PARTNERIZE_USER_KEY) {
      report.networks.partnerize = { skipped: 'PARTNERIZE_API_KEY / PARTNERIZE_USER_KEY not set' };
    } else try {
      const auth = 'Basic ' + btoa(`${env.PARTNERIZE_API_KEY}:${env.PARTNERIZE_USER_KEY}`);
      const u = `https://api.performancehorizon.com/reporting/report_publisher/publisher/1110l36128/conversion.json` +
        `?start_date=${encodeURIComponent(sinceISO + ' 00:00:00')}&end_date=${encodeURIComponent(untilISO + ' 23:59:59')}`;
      const r = await fetch(u, { headers: { 'Authorization': auth } });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      const convs = data.conversions || [];
      let used = 0;
      for (const wrap of convs) {
        const c = wrap.conversion_data || wrap;
        const status = (c.conversion_status || c.status || '').toLowerCase();
        if (status === 'rejected') continue;
        const merchant = advMap.partnerize[String(c.campaign_id)] || 'ticombo'; // single-programme account
        const day = (c.conversion_time || c.created || '').slice(0, 10);
        if (!day) continue;
        bump(merchant, day); used++;
      }
      report.networks.partnerize = { conversions: convs.length, counted: used };
    } catch (err) { report.networks.partnerize = { error: String(err) }; }
  }

  // ── Write to merchant_daily (idempotent SET per merchant-day) ─────────
  let writes = 0;
  if (!dryRun) {
    for (const [merchant, byDay] of Object.entries(counts)) {
      for (const [day, n] of Object.entries(byDay)) {
        try {
          await db.prepare(
            `INSERT INTO merchant_daily (merchant_id, day, conversions) VALUES (?, ?, ?)
             ON CONFLICT(merchant_id, day) DO UPDATE SET conversions = excluded.conversions`
          ).bind(merchant, day, n).run();
          writes++;
        } catch (err) {
          report.dbError = String(err);
        }
      }
    }
  }
  report.counts = counts;
  report.rowsWritten = writes;
  report.note = Object.keys(report.unmapped).length
    ? 'Unmapped advertiser/campaign IDs found — add them to KV affiliate:advertiser-map'
    : undefined;

  return json(report, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}