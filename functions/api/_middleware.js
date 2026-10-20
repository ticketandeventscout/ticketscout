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

//
// R7 (20 Oct 2026): the same middleware also removes fixtures involving
// English / Welsh clubs from the JSON returned by the public list endpoints
// below. Those fixtures are removed from the site (see _excluded-clubs.js);
// registration and the sitemap already skipped them, but these endpoints were
// still returning them to the pages. Filtering here covers every endpoint in
// one place. Only whitelisted GET JSON responses are buffered; everything
// else still streams. A response with nothing to remove is returned
// byte-for-byte as it came. Fail-safe: any error returns the original.
import { stripExcludedFixtures } from './_excluded-clubs.js';

const SKIP_PREFIXES = ['/api/sitemap'];

const FIXTURE_FILTER_PATHS = new Set([
  '/api/awin-events', '/api/awin-category', '/api/sportsevents365',
  '/api/vividseats', '/api/ticombo', '/api/ticketnetwork', '/api/ticketmaster',
  '/api/venue', '/api/football', '/api/attractions', '/api/seatgeek',
  '/api/viagogo', '/api/eventim', '/api/gigsberg', '/api/trending'
]);
const MAX_FILTER_BYTES = 3 * 1024 * 1024;

async function filterFixtures(request, response, path) {
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (!FIXTURE_FILTER_PATHS.has(path)) return response;
  if (!/json/i.test(response.headers.get('Content-Type') || '')) return response;
  const len = Number(response.headers.get('Content-Length') || 0);
  if (len > MAX_FILTER_BYTES) return response;
  try {
    const text = await response.clone().text();
    if (text.length > MAX_FILTER_BYTES) return response;
    const data = JSON.parse(text);
    if (stripExcludedFixtures(data) === 0) return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.delete('ETag');
    return new Response(JSON.stringify(data), {
      status: response.status, statusText: response.statusText, headers
    });
  } catch {
    return response;
  }
}

export async function onRequest(context) {
  let response = await context.next();
  try {
    const path = new URL(context.request.url).pathname;
    if (SKIP_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) {
      return response;
    }
    response = await filterFixtures(context.request, response, path);
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
