// ===========================
// TicketScout — Hotels.com UK affiliate adapter
// Runs as a Cloudflare Pages Function at /api/hotels
//
// Uses CJ (Commission Junction) deep-linking to Hotels.com UK
// CJ Publisher ID: 101816942
// Advertiser ID: 5275597 (Hotels.com UK)
// Base tracking link: https://www.tkqlhce.com/click-101816942-14474706
// Deep-link format: base?url={ENCODED_HOTELS_SEARCH_URL}
//
// Hotels.com search URL format:
//   https://uk.hotels.com/search.do?q-destination={city}&q-check-in={date}&q-check-out={checkout}
//
// Also supports Trivago UK (CJ Advertiser 7717732)
// Trivago tracking: https://www.jdoqocy.com/click-101816942-17216779
// Trivago deep-link: https://www.trivago.co.uk/en-GB/srl?search={city}
//
// Usage: GET /api/hotels?city=Las+Vegas&date=2026-10-01&nights=1&venue=Sphere
// Returns: { hotels: { url, trivago_url, city, checkin, checkout } }
// ===========================

const HOTELS_CJ_BASE  = 'https://www.tkqlhce.com/click-101816942-14474706';
const TRIVAGO_CJ_BASE = 'https://www.jdoqocy.com/click-101816942-17216779';

export async function onRequestGet({ request, env }) {
  const url     = new URL(request.url);
  const city    = (url.searchParams.get('city')  || '').trim();
  const venue   = (url.searchParams.get('venue') || '').trim();
  const date    = url.searchParams.get('date')   || ''; // YYYY-MM-DD
  const nights  = parseInt(url.searchParams.get('nights') || '1');

  if (!city && !venue) {
    return jsonResponse({ error: 'city or venue is required' }, 400);
  }

  const searchTerm = city || venue;

  // Calculate check-in / check-out dates
  let checkin  = date;
  let checkout = '';
  if (date) {
    const d = new Date(date);
    d.setDate(d.getDate() + nights);
    checkout = d.toISOString().split('T')[0];
  }

  // Build Hotels.com search URL
  const hotelsParams = new URLSearchParams({ 'q-destination': searchTerm });
  if (checkin)  hotelsParams.set('q-check-in',  checkin);
  if (checkout) hotelsParams.set('q-check-out', checkout);
  const hotelsSearchUrl = `https://uk.hotels.com/search.do?${hotelsParams.toString()}`;
  const hotelsAffiliateUrl = `${HOTELS_CJ_BASE}?url=${encodeURIComponent(hotelsSearchUrl)}`;

  // Build Trivago search URL
  const trivagoSearchUrl   = `https://www.trivago.co.uk/en-GB/srl?search=${encodeURIComponent(searchTerm)}${checkin ? `&checkin=${checkin}&checkout=${checkout}` : ''}`;
  const trivagoAffiliateUrl = `${TRIVAGO_CJ_BASE}?url=${encodeURIComponent(trivagoSearchUrl)}`;

  return jsonResponse({
    hotels: {
      city:          searchTerm,
      checkin,
      checkout,
      hotels_url:    hotelsAffiliateUrl,
      trivago_url:   trivagoAffiliateUrl,
    }
  }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
