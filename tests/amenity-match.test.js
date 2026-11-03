const test = require('node:test');
const assert = require('node:assert/strict');
const { AMENITY_SOURCE_TRIGGERS, valueInText, matchAmenities, rowMatches } = require('../chrome-extension/lib/amenity-match.js');

const FALSE_TEXT = 'Fully furnished, spacious, Move-In Concierge, carpool lane, fire sprinkler system, tenant pays electricity';

test('the false-positive sentence triggers none of the wrong values in the service worker table', () => {
  ['Shed/Outbuilding', 'Community Spa/Hot Tub', 'Swimming Pool', 'Concierge/Doorman', 'Sprinkler System', 'Electric'].forEach((v) => {
    assert.equal(valueInText(v, FALSE_TEXT), false, v);
  });
});

test('the false-positive sentence triggers none of the wrong values in the scraper dictionary', () => {
  const m = matchAmenities(FALSE_TEXT.toLowerCase());
  const all = Object.values(m).flat();
  ['Shed/Outbuilding', 'Community Spa/Hot Tub', 'Swimming Pool', 'Concierge/Doorman', 'Sprinkler System', 'Electric'].forEach((v) => {
    assert.ok(!all.includes(v), v);
  });
  assert.ok(all.includes('Fire Sprinklers'), 'a fire sprinkler is still a safety feature');
});

test('real triggers still match', () => {
  [
    ['Swimming Pool', 'community pool'],
    ['Swimming Pool', 'resort-style saltwater pool'],
    ['Community Spa/Hot Tub', 'hot tub'],
    ['Community Spa/Hot Tub', 'heated pool and spa'],
    ['Shed/Outbuilding', 'storage shed'],
    ['Concierge/Doorman', '24-hour concierge'],
    ['Concierge/Doorman', 'Package room\nConcierge\nElevator'],
    ['Electric', 'electricity included'],
    ['Walk-In Closets', 'two walk-in closets'],
    ['Ceiling Fans', 'Ceiling fans throughout'],
    ['Street Only', 'Parking\n\nStreet'.replace('\n\n', ' ') && 'parking\n\nstreet'],
    ['EV Charging', 'EV charging stations'],
    ['Recessed Lighting', 'recessed lighting'],
    ['Furnished', 'comes furnished.'],
    ['Furnished', 'Furnished'],
    ['Unfurnished', 'not furnished'],
    ['No Pets', 'no pets'],
  ].forEach(([v, t]) => assert.equal(valueInText(v, t), true, v + ' <- ' + t));
});

// Every candidate from the T5 audit, with the verdict recorded in the PR table.
test('audited false positives stay rejected', () => {
  [
    ['Community Spa/Hot Tub', 'thoughtfully designed space'],
    ['Community Spa/Hot Tub', 'spa-like primary bath'],
    ['Swimming Pool', 'whirlpool tub'],
    ['Swimming Pool', 'billiards and pool table'],
    ['Elevator', 'uplift your stay'],
    ['Shed/Outbuilding', 'finished and refreshed'],
    ['Deck', 'deck of cards'],
    ['Tennis Court', 'near the tennis club'],
    ['Gym/Fitness Center', 'gym membership included nearby'],
    ['Garden Space', 'garden-style community near Hampton Garden Inn'],
    ['Gated Entry', 'easily navigated floor plan'],
    ['Sprinkler System', 'fire sprinkler system'],
    ['Heat', 'heat pump'],
    ['Electric', 'tenant pays electricity'],
    ['Hot Water', 'new hot water heater'],
    ['Pest Control', 'tenant responsible for pest control'],
    ['Case by Case', 'lease with approval of credit'],
    ['Security Cameras', 'under surveillance by the HOA board'],
    ['Gym/Fitness Center', 'great workout trails'],
    ['Swimming Pool', 'swimming nearby at the beach'],
    ['Garbage Disposal', 'tools at your disposal'],
    ['Fireplace', 'no fireplace'],
    ['Rooftop', 'rooftop solar'],
    ['Kitchen Island', 'Gulf Island Condominiums'],
    ['Oven/Range (Electric)', 'wide price range'],
    ['Baseboard', 'painted baseboards'],
    ['W/D Hookups', 'cable hookup'],
    ['Service Animals Only', 'service animals welcome'],
    ['Concierge/Doorman', 'concierge move-in service'],
    ['Concierge/Doorman', 'download the resident concierge app'],
    ['Swimming Pool', 'no pool on site'],
  ].forEach(([v, t]) => assert.equal(valueInText(v, t), false, v + ' <- ' + t));
});

test('the scraper dictionary uses word boundaries', () => {
  const hits = (t) => Object.values(matchAmenities(t)).flat();
  assert.ok(!hits('fully furnished').includes('Shed/Outbuilding'));
  assert.ok(hits('storage shed').includes('Shed/Outbuilding'));
  assert.ok(!hits('at your disposal').includes('Garbage Disposal'));
  assert.ok(hits('garbage disposal').includes('Garbage Disposal'));
  assert.ok(!hits('no fireplace').includes('Fireplace'));
  assert.ok(hits('gas fireplace').includes('Fireplace'));
  assert.ok(!hits('rooftop solar').includes('Rooftop'));
  assert.ok(!hits('near a fitness trail').includes('Gym/Fitness Center'));
  assert.ok(hits('fitness center').includes('Gym/Fitness Center'));
  assert.ok(!hits('hot water included').includes('Water'));
  assert.deepEqual(matchAmenities('no pets. dogs allowed elsewhere').petsAllowed, ['No Pets']);
  assert.ok(!hits('Move-In Concierge').includes('Concierge/Doorman'));
});

test('section rows ignore excluded phrases', () => {
  assert.equal(rowMatches(/\bconcierge\b/, 'Concierge/Doorman', 'move-in concierge'), false);
  assert.equal(rowMatches(/\bconcierge\b/, 'Concierge/Doorman', 'concierge'), true);
});

test('every trigger is a usable string', () => {
  Object.entries(AMENITY_SOURCE_TRIGGERS).forEach(([k, list]) => {
    list.forEach((t) => {
      assert.equal(typeof t, 'string', k);
      assert.equal(t, t.trim(), k + ' has a trigger that relies on spaces: "' + t + '"');
    });
  });
});
