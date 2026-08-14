// functions/concert-hub-test.js   ← REPO DESTINATION (disposable — delete after use)
// Binds to /concert-hub-test ONLY. Does not touch /concert.
// =============================================================================
// Standing rule from Session 18 (HANDOVER_NOTES-SESSION-18-CONTINUED.md §9):
// "for any routing or serving-behaviour change, either test the actual
// failure path directly, or say plainly that a specific piece is inference
// rather than proof — rather than presenting reasoning as verification."
//
// The one unproven piece in functions/concert.js / theatre.js / sports.js:
// whether env.ASSETS.fetch(new URL('/concert', request.url)) — a CLEAN-URL
// path with no file extension, but NOT "/" — behaves like the homepage's
// proven "/" case (clean 200, real HTML) or like its "/index.html" case
// (unfollowed 308 redirect). Reasoning says it should match the "/" case
// (same shape: no extension, already the canonical indexed URL) — but that
// is inference, not proof, and this exact path has never been called this
// way before.
//
// DEPLOY THIS FIRST. Visit /concert-hub-test. Expect a JSON diagnostic. Read
// it. Only once `assetFetchOk: true` and `htmlLooksReal: true` are confirmed
// should functions/concert.js (and the theatre/sports siblings, same
// mechanism, same Cloudflare Pages project — very low incremental risk once
// this one is confirmed, but still worth a quick post-deploy check per the
// "every routing change gets a live check regardless of how proven the
// pattern is" rule) be deployed to their real routes.
//
// Deliberately makes NO changes to any live page — reads env.ASSETS only,
// returns a JSON report, nothing is written anywhere.
// =============================================================================

export async function onRequestGet({ request, env }) {
  const report = {
    hasAssetsBinding: !!(env.ASSETS && typeof env.ASSETS.fetch === 'function'),
    testedPath: '/concert',
    assetFetchOk: false,
    assetFetchStatus: null,
    assetFetchRedirected: null,
    htmlLooksReal: false,
    htmlLength: null,
    htmlSnippet: null,
    conclusion: null
  };

  if (!report.hasAssetsBinding) {
    report.conclusion = 'env.ASSETS binding is not available in this environment — cannot proceed with the hub SSR mechanism as designed.';
    return json(report);
  }

  try {
    const assetUrl = new URL('/concert', request.url);
    const resp = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    report.assetFetchStatus = resp.status;
    report.assetFetchRedirected = resp.redirected ?? null;
    report.assetFetchOk = resp.ok;

    if (resp.ok) {
      const html = await resp.text();
      report.htmlLength = html.length;
      report.htmlSnippet = html.slice(0, 300);
      // Real concert.html contains this exact id regardless of hub vs entity
      // mode — a reliable "this is genuinely the template, not an error page
      // or a redirect stub" signal.
      report.htmlLooksReal = html.includes('id="events-container"') && html.includes('artist-hero');
    }

    report.conclusion = report.assetFetchOk && report.htmlLooksReal
      ? 'CONFIRMED: env.ASSETS.fetch(new URL("/concert", request.url)) returns the real static template with a clean 200, same as "/" did for the homepage. Safe to deploy functions/concert.js (and the theatre/sports siblings) to their real routes.'
      : report.assetFetchStatus && report.assetFetchStatus >= 300 && report.assetFetchStatus < 400
        ? `NOT CONFIRMED: got a ${report.assetFetchStatus} redirect, the SAME failure mode Round 3 of the homepage fix hit for "/index.html". Do NOT deploy functions/concert.js as-is — the canonical path assumption for this route is wrong and needs its own fix before promoting.`
        : 'NOT CONFIRMED: fetch did not return a usable 200 with real template content. Do NOT deploy functions/concert.js as-is — investigate this report before proceeding.';
  } catch (e) {
    report.error = String(e);
    report.conclusion = 'env.ASSETS.fetch threw — do NOT deploy functions/concert.js as-is.';
  }

  return json(report);
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
