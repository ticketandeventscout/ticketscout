// ============================================================================
// TicketScout — mergefragments Diagnostic Reader (read-only, safe, standalone)
// Runs at /api/mergefrag-diag?trigger=1
//
// A fresh mergefragments dry run 524'd even though the registry hadn't grown
// (confirmed: totalRegistered 5981 now vs checked:6085 on the last
// successful run — if anything the registry is SMALLER). entity-lifecycle
// status came back clean at the same time, ruling out general platform
// contention. No confident hypothesis for what's different this time — this
// reads back the checkpoints the instrumented mergefragments phase writes,
// so the next timeout shows exactly how far the scan got instead of a blind
// 524.
//
// Requires binding: GIGSBERG_KV
// Safe to delete once the cause is found and fixed.
// ============================================================================

export async function onRequestGet({ env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const checkpoints = [];
  try {
    const list = await kv.list({ prefix: 'debug:mergefrag:' });
    for (const k of (list?.keys || [])) {
      try {
        const v = await kv.get(k.name);
        if (v) checkpoints.push(JSON.parse(v));
      } catch { checkpoints.push({ step: k.name, error: 'parse failed' }); }
    }
  } catch (err) {
    return json({ error: 'KV list failed', detail: String(err) }, 500);
  }

  checkpoints.sort((a, b) => (a.ms || 0) - (b.ms || 0));

  return json({
    message: 'Read-only diagnostic — no writes performed.',
    note: checkpoints.length
      ? 'Checkpoints from the LAST mergefragments call. stepA = registry loaded (totalSlugs shown). stepB_scanProgress appears every ~250 entities scanned (checked/pctComplete shown) — the LAST one present tells you how far the scan got before it died. stepC_scanComplete only appears if the full scan finished.'
      : 'No checkpoints found — either mergefragments has not been run since this file was deployed, or the checkpoints have expired (1h TTL).',
    checkpointCount: checkpoints.length,
    checkpoints
  }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
