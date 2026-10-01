// ===========================
// TicketScout — /api/* response middleware
// File location: functions/api/_middleware.js
// ===========================
//
// R1 (1 Oct 2026): noindex every /api/ response at the HTTP layer.
//
// robots.txt deliberately ALLOWS crawling of the read-only data endpoints,
// because the entity templates fetch them at render time to build the page
// body and JSON-LD — blocking them is what caused the empty-schema / soft-404
// problem in August. But "crawlable" is not "indexable": an allowed URL with
// no noindex is eligible to be indexed on its own. Before this file, only
// /api/go sent X-Robots-Tag. This adds it everywhere under /api/ in one
// place instead of 50+ handler files, so a new endpoint is covered by
// default rather than by remembering.
//
// A noindex on a fetched subresource does not stop Google using that
// response to render the page that fetched it — it only stops the /api/
// URL itself appearing in results. Crawl access is unchanged.
//
// Sitemaps are skipped on purpose: they are already never shown in results,
// and leaving their responses byte-for-byte as they were removes any doubt
// about how they are processed.
//
// _headers cannot do this: on Cloudflare Pages, _headers rules apply to
// static asset responses only, not to Pages Functions responses.
//
// Fail-safe: any error here returns the original response untouched.
//
// Matching is on the URL PATHNAME, exact segment only: '/api/sitemap' and
// anything below '/api/sitemap/' are skipped (query strings such as
// ?sec=index or ?sec=event&month=… are not part of the pathname, so every
// sitemap URL is covered). A sibling such as '/api/sitemap-debug' is NOT
// skipped and gets noindex like any other endpoint — deliberate: only real
// sitemaps are exempt. All methods (GET/HEAD/OPTIONS/POST) pass through;
// only a response header is added, the body is streamed, never buffered.

const SKIP_PREFIXES = ['/api/sitemap'];

export async function onRequest(context) {
  const response = await context.next();
  try {
    const path = new URL(context.request.url).pathname;
    if (SKIP_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) {
      return response;
    }
    if (response.headers.has('X-Robots-Tag')) return response; // e.g. /api/go sets its own
    // Responses from fetch()/Response.redirect() can have immutable headers,
    // so re-wrap rather than mutate in place.
    const out = new Response(response.body, response);
    out.headers.set('X-Robots-Tag', 'noindex');
    return out;
  } catch {
    return response;
  }
}
