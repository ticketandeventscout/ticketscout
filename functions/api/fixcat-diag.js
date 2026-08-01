// ============================================================================
// TicketScout — fix-categories Diagnostic Reader (read-only, safe, standalone)
// Runs at /api/fixcat-diag?trigger=1
//
// fix-categories&confirm=yes has 524'd twice now — first before the 1 Aug
// parallelization fix, and again after it, both times at ~2.1 minutes. The
// second timeout at an IDENTICAL duration to the first is itself a signal:
// if the two parallelized KV loops were the whole bottleneck, fixing them
// should have changed the failure point or duration. It didn't, which
// points at something the fix didn't touch — most likely the GitHub
// recursive tree-fetch step (stepA), which reads the ENTIRE repo tree and
// was never optimised, only checkpointed.
//
// This lists every debug:fixcat:* checkpoint KV key (two of them have
// dynamic suffixes — item/path counts baked into the key name — so this
// uses KV list() with the prefix rather than guessing exact key strings)
// and returns them sorted by elapsed ms, so we can see exactly how far the
// last confirm=yes attempt got before it died.
//
// Requires binding: GIGSBERG_KV
// Safe to delete once the bottleneck is identified and fixed.
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
      ? 'These are checkpoints from the LAST confirm=yes attempt. The last one present is the last stage that completed before the request died (or the whole thing, if stepF is present).'
      : 'No checkpoints found — either fix-categories&confirm=yes has not been run since this file was deployed, or the checkpoints have expired (1h TTL).',
    checkpointCount: checkpoints.length,
    checkpoints,
    expectedOrder: [
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