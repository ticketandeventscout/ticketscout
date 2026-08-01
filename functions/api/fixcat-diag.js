// ============================================================================
// TicketScout — fix-categories Diagnostic Reader (read-only, safe, standalone)
// Runs at /api/fixcat-diag?trigger=1
//
// UPDATED 1 Aug 2026 (later same session): a fresh timeout at limit=100
// turned out to be a SEPARATE bottleneck from the one already fixed —
// the DETECTION/scanning loop (finding 100 misfiled entries) was still
// fully sequential and had never been chunked, unlike the apply path. Now
// chunked too, with its own checkpoints ('detectScan_{category}_scanned
// {N}_found{M}' every ~250 slugs, plus 'detectScan_COMPLETE_...' at the
// end) — these use the SAME debug:fixcat: prefix as the apply-path
// checkpoints below, so this reader picks them up with no changes needed.
// If a future timeout's LAST checkpoint is a detectScan_* one, the
// bottleneck is back in scanning; if it's stepA-F, it's back in the apply
// path.
//
// This lists every debug:fixcat:* checkpoint KV key (several have dynamic
// suffixes — item/path counts, scan progress baked into the key name — so
// this uses KV list() with the prefix rather than guessing exact key
// strings) and returns them sorted by elapsed ms, so we can see exactly
// how far the last request got before it died.
//
// Requires binding: GIGSBERG_KV
// Safe to delete once no longer needed for active debugging.
// ============================================================================

export async function onRequestGet({ env }) {
  const kv = env.GIGSBERG_KV;
  if (!kv) return json({ error: 'Missing GIGSBERG_KV binding' }, 500);

  const checkpoints = [];
  try {
    const list = await kv.list({ prefix: 'debug:fixcat:' });
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
      ? 'Checkpoints from the LAST fix-categories request (detection scan + apply path share one timeline now). The LAST one present is the last stage that completed before the request died (or the whole thing finished, if stepF_registrySaved_COMPLETE is present). A run showing only detectScan_* entries means it died during scanning, before reaching the apply path at all.'
      : 'No checkpoints found — either fix-categories has not been run since this file was deployed, or the checkpoints have expired (1h TTL).',
    checkpointCount: checkpoints.length,
    checkpoints,
    expectedOrder: [
      'detectScan_concert_scanned*_found* (repeats every ~250 slugs, per category)',
      'detectScan_football_scanned*_found*', 'detectScan_theatre_scanned*_found*',
      'detectScan_sports_scanned*_found*', 'detectScan_COMPLETE_scanned*_found*',
      'stepA_treeFetch_paths*', 'stepB_preCommitBuild_files*', 'stepC_commitDone',
      'stepD_kvLoopDone_items*', 'stepE_knownKeyDone', 'stepF_registrySaved_COMPLETE'
    ]
  }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
