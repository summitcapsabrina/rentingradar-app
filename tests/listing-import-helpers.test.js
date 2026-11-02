const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../listing-import-helpers.js');

test('isPlaceholderPropertyName spots stand-ins and titles with no street number', () => {
  ['', null, 'New Property', 'new property ', 'Single Unit', 'Multi Unit', 'New Co-Hosting Property',
    'Altura at Perdido Key | Apartments.com', 'Zillow'].forEach((n) => assert.equal(h.isPlaceholderPropertyName(n), true, String(n)));
  ['8522 Gulf Blvd Apt 4, Navarre FL 32566', '13450 Perdido Key Dr', '12B Main St'].forEach((n) => assert.equal(h.isPlaceholderPropertyName(n), false, n));
});

test('importCoreCount counts present numbers, and zero counts as present', () => {
  assert.equal(h.importCoreCount({}), 0);
  assert.equal(h.importCoreCount(null), 0);
  assert.equal(h.importCoreCount({ bedrooms: 0, bathrooms: '', sqft: null, price: 1900 }), 2);
  assert.equal(h.importCoreCount({ bedrooms: 2, bathrooms: 2, sqft: 900, price: 1900 }), 4);
});

test('isEmptyImport needs no numbers, no real address and nothing to pick', () => {
  assert.equal(h.isEmptyImport({}), true);
  assert.equal(h.isEmptyImport({ address: 'Zillow', title: 'Zillow' }), true);
  assert.equal(h.isEmptyImport({ address: '8436 Gulf Blvd, Navarre FL 32566' }), false);
  assert.equal(h.isEmptyImport({ price: 1900 }), false);
  assert.equal(h.isEmptyImport({ floorplans: [{ name: 'B4' }] }), false);
  assert.equal(h.isEmptyImport({ units: [{ label: 'Unit 714' }] }), false);
});

test('addressMatchKey reads strings and parts the same way', () => {
  const a = h.addressMatchKey('8522 Gulf Blvd APT 4, Navarre FL 32566');
  assert.deepEqual(a, { street: '8522 gulf blvd', unit: '4', zip: '32566' });
  assert.deepEqual(h.addressMatchKey({ street: '8522 Gulf Boulevard', unit: 'Apt 4', zip: '32566' }), a);
  assert.deepEqual(h.addressMatchKey('8522 Gulf Blvd #4, Navarre FL 32566'), a);
  assert.deepEqual(h.addressMatchKey('8522 Gulf Blvd Unit 4, Navarre FL 32566'), a);
  assert.deepEqual(h.addressMatchKey({ street: '8522 Gulf Blvd Apt 4', zip: '32566' }), a);
  assert.equal(h.addressMatchKey('1875 Carter Ave Unit 1s, Bronx NY 10457').unit, '1s');
});

test('addressKeysMatch compares zip only when both sides have one', () => {
  const k = (street, unit, zip) => ({ street, unit, zip });
  assert.equal(h.addressKeysMatch(k('1 a st', '', '32566'), k('1 a st', '', '')), true);
  assert.equal(h.addressKeysMatch(k('1 a st', '', '32566'), k('1 a st', '', '10001')), false);
  assert.equal(h.addressKeysMatch(k('1 a st', '4', ''), k('1 a st', '5', '')), false);
  assert.equal(h.addressKeysMatch(k('', '', ''), k('', '', '')), false);
});

test('a blank New Property never causes or receives a duplicate', () => {
  const blank = { id: 'b', property: 'New Property', link: 'https://www.zillow.com/x' };
  assert.equal(h.findImportDuplicate({ name: 'New Property' }, [blank]), null);
  assert.equal(h.findImportDuplicate({ name: 'Altura at Perdido Key | Apartments.com' }, [{ id: 'x', property: 'Altura at Perdido Key | Apartments.com' }]), null);
  assert.equal(h.findImportDuplicate({ name: '1625 Bulevar Mayor St, Gulf Breeze FL 32561' }, [blank]), null);
});

test('the same real address twice is still a duplicate', () => {
  const r = { id: 'r1', property: '8522 Gulf Blvd Apt 4, Navarre FL 32566', addressParts: { street: '8522 Gulf Blvd', unit: 'Apt 4', city: 'Navarre', state: 'FL', zip: '32566' } };
  const same = { name: '8522 Gulf Blvd #4, Navarre FL 32566', addressParts: { street: '8522 Gulf Blvd', unit: '#4', zip: '32566' } };
  assert.equal(h.findImportDuplicate(same, [r]), r);
  const otherUnit = { name: '8522 Gulf Blvd #5, Navarre FL 32566', addressParts: { street: '8522 Gulf Blvd', unit: '#5', zip: '32566' } };
  assert.equal(h.findImportDuplicate(otherUnit, [r]), null);
  assert.equal(h.findImportDuplicate({ name: '8522 Gulf Blvd Apt 4, Navarre FL 32566' }, [{ id: 'old', property: '8522 Gulf Blvd Apt 4, Navarre FL 32566' }]).id, 'old');
});

test('isBlankImportedRecord needs all four conditions', () => {
  const blank = { property: 'New Property', link: 'https://www.apartments.com/x/y/', addressParts: { street: '' }, propertyDetails: {} };
  assert.equal(h.isBlankImportedRecord(blank), true);
  assert.equal(h.isBlankImportedRecord({ ...blank, link: '' }), false, 'no import link');
  assert.equal(h.isBlankImportedRecord({ ...blank, link: 'https://evil-zillow.example/x' }), false);
  assert.equal(h.isBlankImportedRecord({ ...blank, property: '12 Main St' }), false, 'real name');
  assert.equal(h.isBlankImportedRecord({ ...blank, addressParts: { street: '12 Main St' } }), false, 'has a street');
  assert.equal(h.isBlankImportedRecord({ ...blank, propertyDetails: { bedrooms: 0 } }), false, 'a studio has data');
  assert.equal(h.isBlankImportedRecord({ ...blank, propertyDetails: { monthlyRent: 1900 } }), false);
  ['https://www.zillow.com/a', 'https://hotpads.com/a', 'https://www.facebook.com/marketplace/item/1', 'https://sfbay.craigslist.org/a'].forEach((link) => {
    assert.equal(h.isBlankImportedRecord({ ...blank, link }), true, link);
  });
});

test('formatPlanLabel', () => {
  assert.equal(h.formatPlanLabel({ name: 'B4', beds: 2, baths: 2, sqft: 1193, priceMin: 1991, priceMax: 2200, priceFrom: true }), 'B4 · 2 bd · 2 ba · 1,193 sf · from $1,991');
  assert.equal(h.formatPlanLabel({ name: 'A2', beds: 1, baths: 1, sqft: 696, priceMin: 1596, priceMax: 1596, priceFrom: false }), 'A2 · 1 bd · 1 ba · 696 sf · $1,596');
  assert.equal(h.formatPlanLabel({ label: 'Unit 714', beds: 2, baths: 2, sqft: 863, priceMin: 2000, priceMax: 2000 }), 'Unit 714 · 2 bd · 2 ba · 863 sf · $2,000');
  assert.equal(h.formatPlanLabel({ name: 'S1', beds: 0, baths: 1 }), 'S1 · Studio · 1 ba');
});

test('applyPlanToListing takes every number from the one plan', () => {
  const b4 = { name: 'B4', beds: 2, baths: 2, sqft: 1193, priceMin: 1991 };
  const data = { address: '13450 Perdido Key Dr, Pensacola FL 32507', _needsFloorplan: true, floorplans: [b4, { name: 'T2 - Townhome', beds: 3, baths: 2, sqft: 1982, priceMin: 3110 }], sourceUrl: 'https://a/' };
  const out = h.applyPlanToListing(data, b4);
  assert.deepEqual([out.bedrooms, out.bathrooms, out.sqft, out.price], [2, 2, 1193, 1991]);
  assert.equal(out.address, data.address);
  assert.equal(out.sourceUrl, 'https://a/');
  assert.deepEqual(out._otherPlanNames, ['T2 - Townhome']);
  assert.equal(out._needsFloorplan, undefined);
  assert.equal(out.floorplans, undefined);
});

test('applyPlanToListing gives a Zillow unit its number and link', () => {
  const u714 = { label: 'Unit 714', beds: 2, baths: 2, sqft: 863, priceMin: 2000, url: 'https://www.zillow.com/homedetails/x/2103599459_zpid/' };
  const out = h.applyPlanToListing({ address: '8436 Gulf Blvd, Navarre FL 32566', _needsUnit: true, units: [u714, { label: 'Unit 432' }] }, u714);
  assert.deepEqual([out.bedrooms, out.bathrooms, out.sqft, out.price], [2, 2, 863, 2000]);
  assert.equal(out.address, '8436 Gulf Blvd #714, Navarre FL 32566');
  assert.equal(out.sourceUrl, u714.url);
  assert.equal(out._needsUnit, undefined);
});

test('skipPlanForListing leaves the unit fields blank', () => {
  const out = h.skipPlanForListing({ address: 'x', bedrooms: 3, sqft: 1, floorplans: [{ name: 'B4' }], _needsFloorplan: true });
  assert.deepEqual([out.bedrooms, out.bathrooms, out.sqft, out.price], [null, null, null, null]);
  assert.equal(out._planSkipped, true);
  assert.deepEqual(out._otherPlanNames, ['B4']);
});

test('bullet validator drops figures that contradict the final numbers', () => {
  const core = { bedrooms: 2, bathrooms: 2, sqft: 1193, price: 1991 };
  const keep = (b, opts) => h.filterBulletsAgainstCore([b], core, opts).length === 1;
  assert.equal(keep('T2 Townhome with 3 bed/2 bath, 1,982 sq ft'), false);
  assert.equal(keep('Spacious 2 bed, 2 bath with 1,193 sq ft'), true);
  assert.equal(keep('Three-bedroom layout near the beach'), false);
  assert.equal(keep('Rent starts at $3,110 per month'), false);
  assert.equal(keep('Rent starts at $1,991 per month'), true);
  assert.equal(keep('1-bath layout'), false);
  assert.equal(keep('1,192 sqft of living space'), true, 'within rounding');
  assert.equal(keep('Half a mile from the beach and 10 minutes from the airport'), true);
  assert.equal(keep('$500 gift card at move-in'), true, 'not a rent figure');
  assert.equal(keep('5,000 sq ft fitness center on site'), true, 'not the unit');
});

test('bullet validator drops mentions of plans that were not chosen', () => {
  const opts = { otherPlanNames: ['T2 - Townhome', 'T2', 'B3'] };
  const list = ['T2 Townhome end unit', 'B3 has water views', 'Right on Perdido Key', 'A B34 route passes nearby'];
  assert.deepEqual(h.filterBulletsAgainstCore(list, { bedrooms: 2 }, opts), ['Right on Perdido Key', 'A B34 route passes nearby']);
});

test('bullet validator states no unit numbers when no plan was chosen', () => {
  const list = ['3 bed/2 bath with 1,982 sq ft', 'From $1,596 per month', 'Steps from the Gulf'];
  assert.deepEqual(h.filterBulletsAgainstCore(list, {}, { blankUnit: true }), ['Steps from the Gulf']);
  assert.deepEqual(h.filterBulletsAgainstCore(list, {}, {}), list, 'with nothing to compare, nothing contradicts');
  assert.deepEqual(h.filterBulletsAgainstCore(undefined, {}), []);
});
