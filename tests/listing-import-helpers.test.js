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
  assert.equal(h.isEmptyImport({ price: 1900 }), true, 'a price alone is not a listing');
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

test('isBlankImportedRecord: stand-in name, no street, no beds, baths or sq ft', () => {
  const blank = { property: 'New Property', link: 'https://www.apartments.com/x/y/', addressParts: { street: '' }, propertyDetails: {} };
  assert.equal(h.isBlankImportedRecord(blank), true);
  assert.equal(h.isBlankImportedRecord({ ...blank, property: '12 Main St' }), false, 'real name');
  assert.equal(h.isBlankImportedRecord({ ...blank, addressParts: { street: '12 Main St' } }), false, 'has a street');
  assert.equal(h.isBlankImportedRecord({ ...blank, propertyDetails: { bedrooms: 0 } }), false, 'a studio has data');
  assert.equal(h.isBlankImportedRecord({ ...blank, propertyDetails: { sqft: 900 } }), false);
  ['https://www.zillow.com/a', 'https://hotpads.com/a', 'https://www.facebook.com/marketplace/item/1', 'https://sfbay.craigslist.org/a'].forEach((link) => {
    assert.equal(h.isBlankImportedRecord({ ...blank, link }), true, link);
  });
});

test('a rent alone or a missing link no longer keeps a record out of cleanup', () => {
  const junk = { property: 'Apartments for Rent in Dallas TX | Apartments.com', link: 'https://www.apartments.com/dallas-tx/', addressParts: { street: '' }, propertyDetails: { monthlyRent: 500, propertyType: 'Apartment' } };
  assert.equal(h.isBlankImportedRecord(junk), true, 'rent 500 + apartments link');
  assert.equal(h.blankImportSourceLink(junk), 'https://www.apartments.com/dallas-tx/');
  const noLink = { property: 'New Property', propertyDetails: {} };
  assert.equal(h.isBlankImportedRecord(noLink), true, 'no link');
  assert.equal(h.blankImportSourceLink(noLink), '');
  assert.equal(h.blankImportSourceLink({ ...noLink, link: 'https://evil-zillow.example/x' }), '', 'not a listing link');
  assert.equal(h.blankImportSourceLink({ ...noLink, _aiSourceUrl: 'https://www.zillow.com/a' }), 'https://www.zillow.com/a');
  assert.equal(h.isBlankImportedRecord({ ...junk, propertyDetails: { monthlyRent: 1900, bedrooms: 2 } }), false, 'a real record with beds');
});

test('cleanup never lists a property someone named by hand', () => {
  const blank = (r) => h.isBlankImportedRecord(r);
  assert.equal(blank({ property: 'Smith Duplex', propertyDetails: {} }), false, 'Smith Duplex, no link');
  assert.equal(blank({ property: 'New Property', propertyDetails: {}, notes: [], propertyNotes: [], note: '' }), true, 'New Property, no link, no notes');
  assert.equal(blank({ property: '', propertyDetails: {} }), true, 'empty name, no link');
  assert.equal(blank({ property: 'New Property', propertyDetails: {}, note: 'Call the owner Tuesday' }), false, 'a note');
  assert.equal(blank({ property: 'New Property', propertyDetails: {}, notes: [{ text: 'x' }] }), false, 'an activity note');
  assert.equal(blank({ property: 'New Property', propertyDetails: {}, propertyNotes: [{ text: 'x' }] }), false, 'a property note');
  assert.equal(blank({ property: 'New Property', propertyDetails: {}, propertyNote: { text: 'x' } }), false, 'the property note');
  for (const k of ['name', 'phone', 'email']) {
    assert.equal(blank({ property: 'New Property', propertyDetails: {}, [k]: 'x' }), false, 'contact ' + k);
  }
  assert.equal(blank({ property: 'Bulevar Apartments', link: 'https://www.apartments.com/x/', propertyDetails: {} }), true, 'Bulevar Apartments + apartments.com link');
  assert.equal(blank({ property: 'Smith Duplex', link: 'https://www.zillow.com/a', propertyDetails: { monthlyRent: 500 }, note: 'x' }), true, 'rent 500 + link');
  assert.equal(blank({ property: 'Smith Duplex', link: 'https://example.com/a', propertyDetails: {} }), false, 'a link that is not a listing site');
});

test('unit prefixes stack and all normalize to the number', () => {
  const key = (x) => h.addressMatchKey(x).unit;
  for (const a of ['8436 Gulf Blvd #Unit 714, Navarre FL 32566', '8436 Gulf Blvd Unit #714, Navarre FL 32566', '8436 Gulf Blvd #714, Navarre FL 32566',
    '8436 Gulf Blvd Apt 714, Navarre FL 32566', '8436 Gulf Blvd, #Unit 714, Navarre FL 32566', '8436 Gulf Blvd, Unit 714']) {
    assert.equal(key(a), '714', a);
  }
  for (const u of ['#Unit 714', 'Unit 714', '#714', 'Apt 714', 'unit #714', '714']) assert.equal(key({ street: '8436 Gulf Blvd', unit: u }), '714', u);
  assert.equal(h.addressMatchKey('8436 Gulf Blvd #Unit 714, Navarre FL 32566').street, '8436 gulf blvd');
});

test('different units in one building are never duplicates', () => {
  const dup = (a, b) => h.addressKeysMatch(h.addressMatchKey(a), h.addressMatchKey(b));
  assert.equal(dup('8436 Gulf Blvd, #Unit 714', { street: '8436 Gulf Blvd', unit: 'Unit 714' }), true);
  assert.equal(dup('8436 Gulf Blvd, Unit 714', '8436 Gulf Blvd, Unit 715'), false, 'one-line, no zip');
  assert.equal(dup({ street: '8436 Gulf Blvd', unit: '#Unit 714' }, { street: '8436 Gulf Blvd', unit: '714' }), true);
  const rec = { id: 'r714', property: '8436 Gulf Blvd, #Unit 714' };
  assert.equal(h.findImportDuplicate({ name: '8436 Gulf Blvd Unit 714, Navarre FL 32566', addressParts: { street: '8436 Gulf Blvd', unit: 'Unit 714', zip: '32566' } }, [rec]), rec);
  assert.equal(h.findImportDuplicate({ name: '8436 Gulf Blvd, Unit 715' }, [rec]), null);
});

test('importDuplicateCheck matches on any key and reports the key', () => {
  const rec = { id: 'r714', property: '8436 Gulf Blvd #714, Navarre FL 32566' };
  // Geocoding lost the unit, the scraped text still has it.
  const res = h.importDuplicateCheck([
    { name: '8436 Gulf Blvd, Navarre FL 32566', addressParts: { street: '8436 Gulf Blvd', unit: '', zip: '32566' } },
    { name: '8436 Gulf Blvd, Navarre FL 32566' },
    { name: '8436 Gulf Blvd #714, Navarre, FL 32566' },
  ], [rec]);
  assert.equal(res.match, rec);
  assert.equal(res.key, '8436 gulf blvd|714|32566');
  assert.equal(res.kind, 'exact');
  const none = h.importDuplicateCheck([{ name: 'New Property' }, { name: '9 Main St, Navarre FL 32566' }], [rec]);
  assert.deepEqual(none, { match: null, key: '9 main st||32566', kind: null });
  assert.deepEqual(h.importDuplicateCheck([{ name: '' }], [rec]), { match: null, key: '', kind: null });
});

test('geocodedUnit never doubles a prefix', () => {
  assert.equal(h.geocodedUnit('714', '8436 Gulf Blvd #714, Navarre FL'), '#714');
  assert.equal(h.geocodedUnit('714', '8436 Gulf Blvd Unit 714, Navarre FL'), 'Unit 714');
  assert.equal(h.geocodedUnit('Unit 714', '8436 Gulf Blvd #714, Navarre FL'), 'Unit 714');
  assert.equal(h.geocodedUnit('#714', '8436 Gulf Blvd Unit 714'), '#714');
  assert.equal(h.geocodedUnit('#Unit 714', ''), 'Unit 714');
  assert.equal(h.geocodedUnit('', '8522 Gulf Blvd APT 4, Navarre FL'), 'Apt 4');
  assert.equal(h.geocodedUnit('', '8436 Gulf Blvd #Unit 714, Navarre FL'), 'Unit 714');
  assert.equal(h.geocodedUnit('', '8436 Gulf Blvd, Navarre FL'), '');
  assert.equal(h.geocodedUnit('4B', '1 Main St Ste. 4B'), 'Ste 4B');
  for (const [sub, raw] of [['714', '#Unit 714'], ['Unit 714', '#714'], ['', '#Unit 714'], ['', 'Unit #714'], ['#Unit 714', '#714']]) {
    assert.doesNotMatch(h.geocodedUnit(sub, raw), /#\s*unit/i, sub + ' / ' + raw);
  }
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

test('bullet validator keeps fees, ranges and size lists that fit the unit', () => {
  const core = { bedrooms: 2, bathrooms: 2, sqft: 1360, price: 1900 };
  for (const b of [
    'Resident Benefits Package $50/mo covers filters and pest control',
    'Pet fee $35 monthly',
    'Rents from $1,900 to $2,400 per month',
    'Rents from $1,600 to $1,900 per month',
    'Choose from 1, 2 and 3 bedroom plans',
    'Studio and 1 bedroom units also available',
    'Studio to 3 bedroom floor plans',
    '1-3 bedroom apartments',
    'One, two or three bedroom homes',
    '1 bedroom and 3 bedroom units',
    'Other units have 3 bedrooms and 3 baths',
    '$1,500 security deposit',
    '$1,000 administrative fee due at move-in',
    '$75 monthly parking',
  ]) {
    assert.deepEqual(h.filterBulletsAgainstCore([b], core), [b], b);
  }
});

test('bullet validator still drops real contradictions', () => {
  const drop = (b, core) => assert.deepEqual(h.filterBulletsAgainstCore([b], core), [], b);
  drop('T2 Townhome 3 bed/2 bath, 1,982 sq ft', { bedrooms: 2, bathrooms: 2, sqft: 1193 });
  drop('Rent is $2,650 per month', { price: 1991 });
  drop('Rent of $2,650 includes all utilities', { price: 1991 });
  drop('Rent is $2,650 per month, pet fee $35', { price: 1991 });
  drop('Rents from $2,100 to $2,400 per month', { price: 1900 });
  drop('Unit 4 - 3 bedroom corner home', { bedrooms: 2 });
  drop('Built 2019, 3 bedroom layout', { bedrooms: 2 });
});

test('a $ figure outside half to double the final rent is not the rent', () => {
  const core = { price: 2000 };
  const keep = (b) => h.filterBulletsAgainstCore([b], core).length === 1;
  assert.equal(keep('Trash service $25 per month'), true);
  assert.equal(keep('Monthly rent $999'), true);
  assert.equal(keep('Monthly rent $1,000'), false, 'exactly half is in the band');
  assert.equal(keep('Monthly rent $4,000'), false, 'exactly double is in the band');
  assert.equal(keep('Monthly rent $4,001'), true);
  assert.equal(keep('Monthly rent $2,000'), true);
});

test('with no plan chosen, fees and size lists are not unit numbers', () => {
  const opts = { blankUnit: true };
  for (const b of [
    'Resident Benefits Package $50/mo covers filters and pest control',
    'Pet fee $35 monthly',
    'Choose from 1, 2 and 3 bedroom plans',
    'Studio and 1 bedroom units also available',
  ]) {
    assert.deepEqual(h.filterBulletsAgainstCore([b], {}, opts), [b], b);
  }
  for (const b of ['Rents from $1,900 to $2,400 per month', 'Rent is $2,650 per month', '3 bed/2 bath', '1,982 sq ft home']) {
    assert.deepEqual(h.filterBulletsAgainstCore([b], {}, opts), [], b);
  }
});

test('bulletFigures reports each rent claim whole', () => {
  assert.deepEqual(h.bulletFigures('Rents from $1,900 to $2,400 per month').rent, [[1900, 2400]]);
  assert.deepEqual(h.bulletFigures('Rent $1,900-$2,400').rent, [[1900, 2400]]);
  assert.deepEqual(h.bulletFigures('Rent is $2,650 per month').rent, [[2650]]);
  assert.deepEqual(h.bulletFigures('Pet fee $35 monthly').rent, []);
  assert.deepEqual(h.bulletFigures('Choose from 1, 2 and 3 bedroom plans').beds, []);
  assert.deepEqual(h.bulletFigures('Spacious 3 bedroom').beds, [3]);
});

test('picking B3.1 keeps bullets that name it when B3 is another plan', () => {
  const core = { bedrooms: 2, bathrooms: 2, sqft: 1088, price: 2166 };
  const opts = { otherPlanNames: ['B3', 'B4'], chosenPlanName: 'B3.1' };
  const b31 = 'Floor plan B3.1 offers 1,088 sq ft';
  assert.deepEqual(h.filterBulletsAgainstCore([b31], core, opts), [b31]);
  assert.deepEqual(h.filterBulletsAgainstCore([b31], core, { otherPlanNames: ['B3', 'B4'] }), [b31], 'the lookahead holds without the chosen name');
  assert.deepEqual(h.filterBulletsAgainstCore(['B3 has water views', 'B4 is the largest', 'Plan B3. Water views'], core, opts), []);
});

test('a plan named inside the chosen plan\'s own name is not another plan', () => {
  const opts = { otherPlanNames: ['T2', 'B3'], chosenPlanName: 'T2 - Townhome' };
  assert.deepEqual(h.filterBulletsAgainstCore(['T2 - Townhome end unit', 'T2 flat upstairs'], {}, opts), ['T2 - Townhome end unit']);
});

test('applyPlanToListing records the chosen name for the validator', () => {
  const b31 = { name: 'B3.1', beds: 2, baths: 2, sqft: 1088, priceMin: 2166 };
  const out = h.applyPlanToListing({ address: 'x', _needsFloorplan: true, floorplans: [{ name: 'B3' }, b31, { name: 'B4' }] }, b31);
  assert.equal(out._chosenPlanName, 'B3.1');
  assert.deepEqual(out._otherPlanNames, ['B3', 'B4']);
});

test('hosting never publishes log files', () => {
  const firebase = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'firebase.json'), 'utf8'));
  assert.ok(firebase.hosting.ignore.includes('*.log'));
});

test('hosting never publishes anything under node_modules', () => {
  const root = require('node:path').join(__dirname, '..');
  const firebase = JSON.parse(require('node:fs').readFileSync(require('node:path').join(root, 'firebase.json'), 'utf8'));
  const { listFiles } = require('firebase-tools/lib/listFiles');
  const files = listFiles(root, firebase.hosting.ignore);
  assert.ok(files.includes('index.html'), 'the app itself is listed');
  assert.deepEqual(files.filter((f) => /(^|\/)node_modules\//.test(f)), []);
});

const NON_LISTING = { address: null, bedrooms: null, bathrooms: null, sqft: null, price: 500, propertyDetails: { propertyType: 'Apartment' }, propertyNoteBullets: [] };

test('a page with no address and no unit numbers is empty, whatever its price', () => {
  assert.equal(h.isEmptyImport(NON_LISTING), true);
  assert.equal(h.isEmptyImport({ address: '1625 Bulevar Mayor St, Gulf Breeze FL 32561', price: 2750 }), false);
  assert.equal(h.isEmptyImport({ address: null, bedrooms: 2, price: 1900 }), false);
  assert.equal(h.isEmptyImport({ address: null, bedrooms: 0, price: 1900 }), false, 'a studio has a bedroom count');
  assert.equal(h.isEmptyImport({ address: null, price: 500, floorplans: [{ name: 'B4', beds: 2 }] }), false);
  assert.equal(h.importCoreCount(NON_LISTING), 1, 'the toast count still includes price');
  assert.equal(h.importStructuralCount(NON_LISTING), 0);
});

test('the extension and the app apply the same empty rule', () => {
  const plans = require('../chrome-extension/lib/listing-plans.js');
  for (const d of [NON_LISTING, {}, { price: 1 }, { address: 'Zillow', price: 1 }, { address: '1 Main St, Navarre FL', price: 1 },
    { sqft: 900 }, { bathrooms: 1 }, { bedrooms: 0 }, { units: [{ label: 'Unit 1' }], price: 1 }, { floorplans: [], price: 1 }]) {
    assert.equal(plans.scrapeIsEmpty(d), h.isEmptyImport(d), JSON.stringify(d));
  }
});

// Made-up addresses only.
const SAVED_UNIT = { id: 'unit', property: '400 Example Way #2B, Sampletown FL 32000', addressParts: { street: '400 Example Way', unit: '2B', city: 'Sampletown', state: 'FL', zip: '32000' } };
const SAVED_BUILDING = { id: 'bldg', property: '400 Example Way, Sampletown FL 32000', addressParts: { street: '400 Example Way', unit: '', city: 'Sampletown', state: 'FL', zip: '32000' } };

test('a building listing against a saved unit is a same-building match', () => {
  const res = h.importDuplicateCheck([{ name: '400 Example Way, Sampletown FL 32000', addressParts: { street: '400 Example Way', unit: '', zip: '32000' } }], [SAVED_UNIT]);
  assert.equal(res.match, SAVED_UNIT);
  assert.equal(res.kind, 'same-building');
  assert.equal(res.key, '400 example way||32000');
});

test('a unit listing against a saved building is a same-building match', () => {
  const res = h.importDuplicateCheck([{ name: '400 Example Way Unit 2B, Sampletown FL 32000' }], [SAVED_BUILDING]);
  assert.equal(res.match, SAVED_BUILDING);
  assert.equal(res.kind, 'same-building');
});

test('two different units are never a match of either kind', () => {
  const k = (s) => h.addressMatchKey(s);
  assert.equal(h.addressKeysSameBuilding(k('400 Example Way #714, Sampletown FL 32000'), k('400 Example Way #715, Sampletown FL 32000')), false);
  const res = h.importDuplicateCheck([{ name: '400 Example Way #3C, Sampletown FL 32000' }], [SAVED_UNIT]);
  assert.deepEqual([res.match, res.kind], [null, null]);
});

test('an exact match beats a same-building record listed earlier', () => {
  const res = h.importDuplicateCheck([{ name: '400 Example Way #2B, Sampletown FL 32000' }], [SAVED_BUILDING, SAVED_UNIT]);
  assert.equal(res.match, SAVED_UNIT);
  assert.equal(res.kind, 'exact');
  // and across candidates: a later candidate's exact match beats an earlier one's same-building match
  const res2 = h.importDuplicateCheck([{ name: '400 Example Way, Sampletown FL 32000' }, { name: '400 Example Way #2B, Sampletown FL 32000' }], [SAVED_UNIT]);
  assert.equal(res2.kind, 'exact');
  assert.equal(res2.key, '400 example way|2b|32000');
});

test('the import\'s three candidates: a dropped unit never matches another unit\'s building', () => {
  const saved715 = { id: 'u715', property: '400 Example Way Unit 715, Sampletown FL 32000' };
  const noUnit = { name: '400 Example Way, Sampletown FL 32000', addressParts: { street: '400 Example Way', unit: '', zip: '32000' } };
  const noUnitName = { name: '400 Example Way, Sampletown FL 32000' };
  const check = (scraped) => h.importDuplicateCheck([noUnit, noUnitName, { name: scraped }], [saved715]);
  const a = check('400 Example Way Unit 714, Sampletown, FL 32000');
  assert.deepEqual([a.match, a.kind], [null, null], 'geocoding dropped 714; 715 is not its building');
  const b = check('400 Example Way Unit 715, Sampletown, FL 32000');
  assert.deepEqual([b.match && b.match.id, b.kind], ['u715', 'exact']);
  const c = h.importDuplicateCheck([noUnit, noUnitName, { name: '400 Example Way, Sampletown, FL 32000' }], [saved715]);
  assert.deepEqual([c.match && c.match.id, c.kind], ['u715', 'same-building'], 'a real building listing still asks');
});

test('a different zip is no match of either kind', () => {
  const res = h.importDuplicateCheck([{ name: '400 Example Way, Sampletown FL 32999' }], [SAVED_UNIT]);
  assert.deepEqual([res.match, res.kind], [null, null]);
  assert.equal(h.addressKeysSameBuilding(h.addressMatchKey('400 Example Way, X FL'), h.addressMatchKey('400 Example Way #1, X FL')), true, 'a missing zip is compatible');
});

test('the old exact-only findImportDuplicate is unchanged (no app caller since T10; kept for now)', () => {
  assert.equal(h.findImportDuplicate({ name: '400 Example Way, Sampletown FL 32000' }, [SAVED_UNIT]), null);
  assert.equal(h.findImportDuplicate({ name: '400 Example Way #2B, Sampletown FL 32000' }, [SAVED_UNIT]), SAVED_UNIT);
});

// T10: Co-Hosting import runs importDuplicateCheck with the same three candidates,
// against co-host records only.
test('Co-Hosting records take the same check: same-building asks, 714 vs 715 does not, other stores never count', () => {
  const cohost = (id, property, unit) => ({ id, kind: 'cohost', property, addressParts: { street: '400 Example Way', unit, city: 'Sampletown', state: 'FL', zip: '32000' }, cohost: {} });
  const saved2b = cohost('c2b', '400 Example Way #2B, Sampletown FL 32000', '#2B');
  const saved715 = cohost('c715', '400 Example Way Unit 715, Sampletown FL 32000', 'Unit 715');
  const parts = { street: '400 Example Way', unit: '', city: 'Sampletown', state: 'FL', zip: '32000' };
  const candidates = (scraped) => [{ name: '400 Example Way, Sampletown FL 32000', addressParts: parts }, { name: '400 Example Way, Sampletown FL 32000' }, { name: scraped }];
  const bldg = h.importDuplicateCheck(candidates('400 Example Way, Sampletown, FL 32000'), [saved2b]);
  assert.deepEqual([bldg.match && bldg.match.id, bldg.kind, bldg.key], ['c2b', 'same-building', '400 example way||32000']);
  const exact = h.importDuplicateCheck(candidates('400 Example Way #2B, Sampletown, FL 32000'), [saved2b]);
  assert.deepEqual([exact.match && exact.match.id, exact.kind], ['c2b', 'exact']);
  const other = h.importDuplicateCheck(candidates('400 Example Way Unit 714, Sampletown, FL 32000'), [saved715]);
  assert.deepEqual([other.match, other.kind], [null, null], 'M1: a dropped 714 is not 715\'s building');
  const none = h.importDuplicateCheck(candidates('400 Example Way, Sampletown, FL 32000'), []);
  assert.deepEqual([none.match, none.kind], [null, null], 'arbitrage records are not passed, so they cannot match');
});

test('a blank import whose street is the stand-in name is still blank', () => {
  const r = { property: 'New Property', link: 'https://www.apartments.com/example-building/abc123/',
    addressParts: { street: 'New Property', unit: '', city: '', state: '', zip: '' },
    propertyDetails: { bedrooms: '', bathrooms: '', sqft: '', latitude: 42.33, longitude: -122.87 } };
  assert.equal(h.isBlankImportedRecord(r), true);
  assert.equal(h.isBlankImportedRecord({ ...r, addressParts: { ...r.addressParts, street: '12 Oak St' } }), false, 'a real street');
});

test('isStandInPropertyName only covers the app\'s own stand-ins', () => {
  for (const n of ['', null, 'New Property', ' new property ', 'Single Unit', 'Multi Unit', 'New Co-Hosting Property']) assert.equal(h.isStandInPropertyName(n), true, String(n));
  for (const n of ['Smith Duplex', 'Example Towers', '12 Oak St']) assert.equal(h.isStandInPropertyName(n), false, n);
});
