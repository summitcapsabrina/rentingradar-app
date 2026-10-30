// Pure helpers for the AirDNA competitor import. Loaded by index.html as plain
// globals and required by tests/comp-import-helpers.test.js under node --test.
// Nothing in this file may touch the DOM, Firestore, or chrome.* APIs.

// Firestore rejects a document over 1,048,576 bytes, and every property a user
// owns is saved in one shared JSON blob. Stop adding comps a little before that
// so the write that would break saving for the whole account never happens.
const COMP_STORAGE_LIMIT_BYTES = 1000000;

// How long an unfinished import still counts as "interrupted" after a reload.
// Older markers are stale, since the extension's own scrape has long since ended.
const COMP_IMPORT_MARKER_MAX_AGE_MS = 2 * 60 * 1000;

// Returns "abnb_<digits>" for a single-listing AirDNA URL, in either form:
//   https://app.airdna.co/data/listing/abnb_123
//   https://app.airdna.co/data/us/airdna-472/top-listings?...&listing_id=abnb_123
// Returns null for anything else, including a market page with no listing picked.
function parseAirdnaListingId(url) {
  let u;
  try { u = new URL(String(url == null ? '' : url).trim()); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!/(^|\.)airdna\.co$/i.test(u.hostname)) return null;
  const inPath = u.pathname.match(/\/abnb_(\d+)(?:\/|$)/i);
  if (inPath) return 'abnb_' + inPath[1];
  const inQuery = (u.searchParams.get('listing_id') || '').match(/^abnb_(\d+)$/i);
  return inQuery ? 'abnb_' + inQuery[1] : null;
}

// The numeric room id behind an abnb_ listing id.
function listingIdToRoomId(listingId) {
  const m = String(listingId == null ? '' : listingId).match(/^abnb_(\d+)$/i);
  return m ? m[1] : null;
}

function canonicalAirdnaUrl(listingId) {
  const roomId = listingIdToRoomId(listingId);
  return roomId ? 'https://app.airdna.co/data/listing/abnb_' + roomId : null;
}

function canonicalAirbnbUrl(listingId) {
  const roomId = listingIdToRoomId(listingId);
  return roomId ? 'https://www.airbnb.com/rooms/' + roomId : null;
}

// Room id from an Airbnb listing URL on any Airbnb domain (.com, .ca, .co.uk…).
function airbnbRoomIdFromUrl(url) {
  const m = String(url == null ? '' : url).match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*airbnb\.[a-z]{2,3}(?:\.[a-z]{2})?\/rooms\/(\d+)(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

// Does a scrape result refer to the listing we asked for? A field that names no
// listing id proves nothing either way; one that names a different id is a
// mismatch. Returns { ok:true } or { ok:false, reason:'link'|'airdnaUrl' }.
function checkCompListing(expectedListingId, data) {
  const expectedRoom = listingIdToRoomId(expectedListingId);
  if (!expectedRoom || !data) return { ok: false, reason: 'missing' };
  const linkRoom = airbnbRoomIdFromUrl(data.link);
  if (linkRoom && linkRoom !== expectedRoom) return { ok: false, reason: 'link' };
  const urlListing = parseAirdnaListingId(data.airdnaUrl);
  if (urlListing && listingIdToRoomId(urlListing) !== expectedRoom) return { ok: false, reason: 'airdnaUrl' };
  return { ok: true };
}

// Finds an existing comp for the same listing, comparing ids rather than raw
// strings so the short URL, long URL, and Airbnb link all match each other.
// Returns { comp, index } or null.
function findDuplicateComp(comps, listingId) {
  const roomId = listingIdToRoomId(listingId);
  if (!roomId || !Array.isArray(comps)) return null;
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i] || {};
    const airdnaListing = parseAirdnaListingId(c.airdnaUrl);
    if ((airdnaListing && listingIdToRoomId(airdnaListing) === roomId) || airbnbRoomIdFromUrl(c.link) === roomId) {
      return { comp: c, index: i };
    }
  }
  return null;
}

function compCountText(n) {
  return n + (n === 1 ? ' competitor' : ' competitors');
}

// Splits saved pending-import markers into those worth offering a Retry for and
// those to forget. A marker with no usable startedAt counts as stale.
function classifyPendingImports(markers, now) {
  const interrupted = [];
  const stale = [];
  (Array.isArray(markers) ? markers : []).forEach(function (m) {
    const age = m && typeof m.startedAt === 'number' ? now - m.startedAt : Infinity;
    if (age >= 0 && age < COMP_IMPORT_MARKER_MAX_AGE_MS) interrupted.push(m);
    else stale.push(m);
  });
  return { interrupted: interrupted, stale: stale };
}

function compStorageNearLimit(byteSize) {
  return byteSize >= COMP_STORAGE_LIMIT_BYTES;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COMP_STORAGE_LIMIT_BYTES,
    COMP_IMPORT_MARKER_MAX_AGE_MS,
    parseAirdnaListingId,
    listingIdToRoomId,
    canonicalAirdnaUrl,
    canonicalAirbnbUrl,
    airbnbRoomIdFromUrl,
    checkCompListing,
    findDuplicateComp,
    compCountText,
    classifyPendingImports,
    compStorageNearLimit,
  };
}
