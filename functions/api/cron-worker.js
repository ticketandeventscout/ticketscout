// ============================================================================
// TicketScout Cron Worker — replaces cron-job.org
// ============================================================================
// A standalone Cloudflare Worker (NOT a Pages Function) whose only job is to
// call TicketScout's existing ?trigger=1 endpoints on a schedule, with
// failure logging to KV so missed runs are visible.
//
// ── HOW TO DEPLOY (no terminal needed — all in the Cloudflare dashboard) ──
// 1. Cloudflare dashboard → Workers & Pages → Create → Create Worker
// 2. Name it: ticketscout-cron → Deploy (accept the hello-world default)
// 3. Click "Edit code" → delete everything → paste THIS ENTIRE FILE → Deploy
// 4. Go to the worker's Settings → Triggers → Cron Triggers → Add:
//        0 */6 * * *      (every 6 hours — feed caches)
//        15 0 * * 1       (Monday 00:15 — SE365 participants)
//        20 0 * * 1       (Monday 00:20 — discovery sweep)
//        40 0 * * 1       (Monday 00:40 — commit new pages)
// 5. Settings → Bindings → Add → KV namespace:
//        Variable name: GIGSBERG_KV → select your existing GIGSBERG_KV namespace
//        (used only for failure logging — safe)
// 6. Delete the jobs at cron-job.org once you see runs in the worker's logs.
//
// Costs: free tier covers this many times over.
// ============================================================================

const BASE = 'https://ticketscout.co.uk';

// Job definitions — which endpoints fire on which schedule
const SCHEDULES = {
  // Every 6 hours: refresh the affiliate feed caches
  '0 */6 * * *': [
    { name: 'awin-category-cache', url: `${BASE}/api/awin-category-cache?trigger=1` },
    { name: 'vividseats-cache',    url: `${BASE}/api/vividseats-cache?trigger=1` },
    { name: 'ticketnetwork-cache', url: `${BASE}/api/ticketnetwork-cache?trigger=1` },
  ],
  // Monday 00:15: SE365 participant cache (weekly)
  '15 0 * * 1': [
    { name: 'sportsevents365-cache', url: `${BASE}/api/sportsevents365-cache?trigger=1` },
    { name: 'ticombo-cache',         url: `${BASE}/api/ticombo-cache?trigger=1` },
  ],
  // Monday 00:20: discovery sweep (TM cursor + queues from feeds)
  '20 0 * * 1': [
    { name: 'discover-scan', url: `${BASE}/api/discover-pages?trigger=1` },
  ],
  // Monday 00:40: commit whatever the sweep queued (Trees API batch)
  '40 0 * * 1': [
    { name: 'discover-commit', url: `${BASE}/api/discover-pages?trigger=1&phase=commit` },
  ],
};

export default {
  async scheduled(event, env, ctx) {
    const jobs = SCHEDULES[event.cron] || [];
    if (jobs.length === 0) {
      console.log(`No jobs mapped for cron pattern: ${event.cron}`);
      return;
    }

    for (const job of jobs) {
      ctx.waitUntil(runJob(job, env));
    }
  },

  // Optional: visiting the worker URL shows recent job outcomes
  async fetch(request, env) {
    const logs = {};
    const jobNames = Object.values(SCHEDULES).flat().map(j => j.name);
    for (const name of jobNames) {
      try {
        const ok   = await env.GIGSBERG_KV?.get(`cron:ok:${name}`);
        const fail = await env.GIGSBERG_KV?.get(`cron:fail:${name}`);
        logs[name] = { lastSuccess: ok || null, lastFailure: fail ? JSON.parse(fail) : null };
      } catch { logs[name] = { error: 'kv read failed' }; }
    }
    return new Response(JSON.stringify({ worker: 'ticketscout-cron', jobs: logs }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function runJob(job, env) {
  const started = Date.now();
  try {
    const resp = await fetch(job.url, {
      headers: { 'User-Agent': 'TicketScout-Cron-Worker' },
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - started;

    if (resp.ok) {
      console.log(`OK   ${job.name} (${resp.status}, ${ms}ms)`);
      await env.GIGSBERG_KV?.put(`cron:ok:${job.name}`, new Date().toISOString());
      // Clear any stale failure record on success
      await env.GIGSBERG_KV?.delete(`cron:fail:${job.name}`).catch(() => {});
    } else {
      const body = (await resp.text()).slice(0, 500);
      console.error(`FAIL ${job.name} → HTTP ${resp.status}: ${body}`);
      await env.GIGSBERG_KV?.put(`cron:fail:${job.name}`, JSON.stringify({
        at: new Date().toISOString(), status: resp.status, body
      }), { expirationTtl: 14 * 24 * 60 * 60 });
    }
  } catch (err) {
    console.error(`FAIL ${job.name} → ${err}`);
    await env.GIGSBERG_KV?.put(`cron:fail:${job.name}`, JSON.stringify({
      at: new Date().toISOString(), error: String(err)
    }), { expirationTtl: 14 * 24 * 60 * 60 }).catch(() => {});
  }
}
