const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../comp-import-helpers.js');

const ID = 'abnb_1244279999467786702';
const ROOM = '1244279999467786702';
const SHORT = 'https://app.airdna.co/data/listing/' + ID;
const LONG = 'https://app.airdna.co/data/us/airdna-472/top-listings?lat=33.4&lng=-112&listing_id=' + ID + '&tab=x';

test('parseAirdnaListingId reads both URL forms', () => {
  assert.equal(h.parseAirdnaListingId(SHORT), ID);
  assert.equal(h.parseAirdnaListingId(SHORT + '/'), ID);
  assert.equal(h.parseAirdnaListingId(SHORT + '?foo=1#bar'), ID);
  assert.equal(h.parseAirdnaListingId(LONG), ID);
  assert.equal(h.parseAirdnaListingId('  ' + SHORT + '\n'), ID);
  assert.equal(h.parseAirdnaListingId('https://app.airdna.co/data/us/x/top-listings?listing_id=abnb%5F40151369'), 'abnb_40151369');
});

test('parseAirdnaListingId rejects anything that is not a single AirDNA listing', () => {
  [
    'https://app.airdna.co/data/us/airdna-472/top-listings?lat=33.4',
    'https://app.airdna.co/data/listing/vrbo_123',
    'https://app.airdna.co/data/listing/abnb_12x',
    'https://www.airbnb.com/rooms/123',
    'https://evil.example/data/listing/abnb_123',
    'https://notairdna.co/data/listing/abnb_123',
    'ftp://app.airdna.co/data/listing/abnb_123',
    'not a url',
    '',
    null,
    undefined,
  ].forEach((u) => assert.equal(h.parseAirdnaListingId(u), null, String(u)));
});

test('canonical URLs come from the listing id', () => {
  assert.equal(h.canonicalAirdnaUrl(ID), SHORT);
  assert.equal(h.canonicalAirbnbUrl(ID), 'https://www.airbnb.com/rooms/' + ROOM);
  assert.equal(h.canonicalAirdnaUrl('vrbo_1'), null);
  assert.equal(h.canonicalAirbnbUrl(null), null);
});

test('airbnbRoomIdFromUrl handles domains, params, and non-room links', () => {
  assert.equal(h.airbnbRoomIdFromUrl('https://www.airbnb.com/rooms/123?adults=2'), '123');
  assert.equal(h.airbnbRoomIdFromUrl('https://www.airbnb.co.uk/rooms/123/'), '123');
  assert.equal(h.airbnbRoomIdFromUrl('airbnb.com/rooms/123'), '123');
  assert.equal(h.airbnbRoomIdFromUrl('https://www.airbnb.com/h/some-slug'), null);
  assert.equal(h.airbnbRoomIdFromUrl('https://airbnb.evil.example/rooms/123'), null);
  assert.equal(h.airbnbRoomIdFromUrl(''), null);
  assert.equal(h.airbnbRoomIdFromUrl(null), null);
});

test('checkCompListing rejects data that names a different listing', () => {
  const room = 'https://www.airbnb.com/rooms/' + ROOM;
  assert.deepEqual(h.checkCompListing(ID, { link: room, airdnaUrl: SHORT }), { ok: true });
  assert.deepEqual(h.checkCompListing(ID, { link: room, airdnaUrl: LONG }), { ok: true });
  assert.deepEqual(h.checkCompListing(ID, { link: 'https://www.airbnb.com/rooms/999', airdnaUrl: SHORT }), { ok: false, reason: 'link' });
  assert.deepEqual(h.checkCompListing(ID, { link: room, airdnaUrl: 'https://app.airdna.co/data/listing/abnb_999' }), { ok: false, reason: 'airdnaUrl' });
});

test('checkCompListing treats fields with no id as unproven, not as a mismatch', () => {
  assert.deepEqual(h.checkCompListing(ID, { link: null, airdnaUrl: 'https://app.airdna.co/data/us/x/top-listings' }), { ok: true });
  assert.deepEqual(h.checkCompListing(ID, {}), { ok: true });
  assert.deepEqual(h.checkCompListing(ID, null), { ok: false, reason: 'missing' });
  assert.deepEqual(h.checkCompListing(null, {}), { ok: false, reason: 'missing' });
});

test('findDuplicateComp matches across URL forms and Airbnb links', () => {
  const comps = [
    { link: 'https://www.airbnb.com/rooms/1', airdnaUrl: 'https://app.airdna.co/data/listing/abnb_1' },
    { link: '', airdnaUrl: LONG },
    { link: 'https://www.airbnb.ca/rooms/77?x=1', airdnaUrl: '' },
  ];
  assert.equal(h.findDuplicateComp(comps, ID).index, 1);
  assert.equal(h.findDuplicateComp(comps, 'abnb_1').index, 0);
  assert.equal(h.findDuplicateComp(comps, 'abnb_77').index, 2);
  assert.equal(h.findDuplicateComp(comps, 'abnb_2'), null);
  assert.equal(h.findDuplicateComp([], ID), null);
  assert.equal(h.findDuplicateComp(comps, null), null);
  assert.equal(h.findDuplicateComp(undefined, ID), null);
});

test('compCountText has no denominator and pluralizes', () => {
  assert.equal(h.compCountText(0), '0 competitors');
  assert.equal(h.compCountText(1), '1 competitor');
  assert.equal(h.compCountText(3), '3 competitors');
  assert.equal(h.compCountText(137), '137 competitors');
});

test('classifyPendingImports keeps only markers younger than the limit', () => {
  const now = 1000000;
  const fresh = { listingId: ID, startedAt: now - 1000 };
  const edge = { listingId: 'abnb_2', startedAt: now - h.COMP_IMPORT_MARKER_MAX_AGE_MS };
  const old = { listingId: 'abnb_3', startedAt: now - 3600000 };
  const future = { listingId: 'abnb_4', startedAt: now + 5000 };
  const broken = { listingId: 'abnb_5' };
  const out = h.classifyPendingImports([fresh, edge, old, future, broken, null], now);
  assert.deepEqual(out.interrupted, [fresh]);
  assert.equal(out.stale.length, 5);
  assert.deepEqual(h.classifyPendingImports('nope', now), { interrupted: [], stale: [] });
});

test('compStorageNearLimit trips below the Firestore document limit', () => {
  assert.equal(h.compStorageNearLimit(0), false);
  assert.equal(h.compStorageNearLimit(h.COMP_STORAGE_LIMIT_BYTES - 1), false);
  assert.equal(h.compStorageNearLimit(h.COMP_STORAGE_LIMIT_BYTES), true);
  assert.ok(h.COMP_STORAGE_LIMIT_BYTES < 1048576);
});
