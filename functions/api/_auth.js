// ===========================
// TicketScout — admin secret check for write branches
// File location: functions/api/_auth.js
// ===========================
//
// F6 (1 Oct 2026): robots.txt is advisory, not access control. Endpoints
// whose ?confirm=yes branch writes KV/D1 (backfill-redirects,
// duplicate-entities, duplicate-events) were callable by anyone with a GET.
// This helper gates ONLY those write branches; dry runs, scans and inspects
// stay open exactly as before.
//
// Not a route: this file exports no onRequest* handler, so Pages creates
// no /api/_auth endpoint for it. Imported by the handlers that need it.
//
// Secret sources, in order:
//   1. X-Admin-Token request header  (preferred — not logged in URLs)
//   2. ?key=<secret> query parameter (so the owner can run these from a
//      browser address bar, where headers cannot be set)
// Compared against env.ADMIN_SECRET in constant time: both sides are
// SHA-256 hashed to fixed 32-byte digests, then compared with an XOR loop
// that always walks all 32 bytes, so neither content nor length leaks
// through timing.
//
// FAIL-CLOSED: if ADMIN_SECRET is unset or empty, every write is denied.
// The 401 body is identical in every denial case (missing, wrong, or not
// configured) so a caller cannot tell whether the variable exists. The
// supplied value is never echoed, logged or included in any response.

const DENY_BODY = JSON.stringify({ error: 'Unauthorized. This write action requires an admin token.' });

function deny() {
  return new Response(DENY_BODY, {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Returns null when authorised, otherwise a 401 Response to return as-is.
export async function requireAdmin(request, env) {
  try {
    const expected = env && typeof env.ADMIN_SECRET === 'string' ? env.ADMIN_SECRET : '';
    const supplied = request.headers.get('X-Admin-Token')
      || new URL(request.url).searchParams.get('key')
      || '';
    // Always run the comparison (even when one side is empty) so the
    // unconfigured and wrong-secret paths take the same time.
    const match = await constantTimeEqual(supplied, expected);
    if (!expected || !supplied || !match) return deny();
    return null;
  } catch {
    return deny(); // any failure here denies — never fails open
  }
}
