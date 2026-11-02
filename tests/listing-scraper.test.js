// Runs the real listing scraper under jsdom against trimmed copies of the live pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'chrome-extension');
const read = (p) => fs.readFileSync(path.join(EXT, p), 'utf8');
const LIBS = [read('lib/amenity-match.js'), read('lib/listing-plans.js')];
const SCRAPER = read('content/listing-scraper.js');

function scrape(fixture, url, edit) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  const html = edit ? edit(raw) : raw;
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout, so innerText is the closest thing to textContent.
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('scraper never reported')), 8000);
    window.chrome = { runtime: { sendMessage(m) {
      clearTimeout(timer);
      window.close();
      m.error ? reject(new Error(m.error)) : resolve(m.payload);
    } } };
    LIBS.forEach((src) => window.eval(src));
    window.eval(SCRAPER);
  });
}

const ZILLOW_UNIT = 'https://www.zillow.com/homedetails/8522-Gulf-Blvd-APT-4-Navarre-FL-32566/47898545_zpid/';
const ZILLOW_BUILDING = 'https://www.zillow.com/b/gulf-island-condominiums-navarre-fl-Cmp8xV/';
const ALTURA = 'https://www.apartments.com/altura-at-perdido-key-pensacola-fl/s7bek57/';
const BULEVAR = 'https://www.apartments.com/1625-bulevar-mayor-st-gulf-breeze-fl/frmt8ls/';

test('Zillow unit page reads the unit named by the URL zpid, not a nearby home', async () => {
  const d = await scrape('zillow-unit-8522.html', ZILLOW_UNIT);
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [2, 2, 1360, 1900]);
  assert.match(d.address, /^8522 Gulf Blvd APT 4, Navarre FL 32566$/);
  assert.ok(!d._needsUnit);
  assert.ok(!(d.propertyDetails.communityAmenities || []).includes('Concierge/Doorman'), 'Move-In Concierge is not a doorman');
  assert.ok(!(d.propertyDetails.communityAmenities || []).includes('Community Spa/Hot Tub'), '"space" is not a spa');
});

test('Zillow building page leaves unit numbers blank and lists the units', async () => {
  const d = await scrape('zillow-building-gulf-island.html', ZILLOW_BUILDING);
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [null, null, null, null]);
  assert.equal(d._needsUnit, true);
  assert.equal(d.address, '8436 Gulf Blvd, Navarre FL 32566');
  assert.equal(d.buildingName, 'Gulf Island Condominiums');
  assert.equal(d.units.length, 3);
  const u714 = d.units.find((u) => u.label === 'Unit 714');
  assert.deepEqual([u714.beds, u714.baths, u714.sqft, u714.priceMin], [2, 2, 863, 2000]);
  assert.match(u714.url, /^https:\/\/www\.zillow\.com\/homedetails\/.*2103599459_zpid\/$/);
  assert.ok(!JSON.stringify([d.sqft, d.units]).includes('906'), '906 sf belongs to a nearby building');
  assert.ok(!(d.propertyDetails.interiorFeatures || []).includes('Kitchen Island'), '"Gulf Island" is not a kitchen island');
});

test('Zillow building page with a unit in the URL uses only that unit', async () => {
  const d = await scrape('zillow-building-gulf-island.html', ZILLOW_BUILDING + '?unitZpid=2103599459');
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [2, 2, 863, 2000]);
  assert.ok(!d._needsUnit);
  assert.equal(d.address, '8436 Gulf Blvd #714, Navarre FL 32566');
});

test('Apartments.com multi-plan page returns whole plans and no mixed numbers', async () => {
  const d = await scrape('apartments-altura.html', ALTURA);
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [null, null, null, null]);
  assert.equal(d._needsFloorplan, true);
  assert.equal(d.address, '13450 Perdido Key Dr, Pensacola FL 32507');
  assert.equal(d.floorplans.length, 8, 'the bedroom tabs repeat plans; each counts once');
  const byName = Object.fromEntries(d.floorplans.map((p) => [p.name, p]));
  assert.deepEqual([byName.B4.beds, byName.B4.baths, byName.B4.sqft, byName.B4.priceMin], [2, 2, 1193, 1991]);
  assert.deepEqual([byName.B3.beds, byName.B3.baths, byName.B3.sqft, byName.B3.priceMin], [2, 2, 1112, 1798]);
  assert.deepEqual([byName['B3.1'].sqft, byName['B3.1'].priceMin], [1088, 2166]);
  assert.deepEqual([byName['T2 - Townhome'].beds, byName['T2 - Townhome'].sqft], [3, 1982]);
  assert.equal(byName.A2.priceFrom, false);
  assert.equal(byName.B4.priceFrom, true);
  assert.ok(!d.floorplans.some((p) => p.beds === 0), '"yoga studio" is not a studio plan');
});

test('Apartments.com page with a plan in the URL fills from that plan', async () => {
  const d = await scrape('apartments-altura.html', ALTURA + '?floorplan=B4');
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [2, 2, 1193, 1991]);
  assert.ok(!d._needsFloorplan);
  assert.match(d._chosenPlan, /^B4,/);
});

test('Apartments.com single unit still imports its own numbers', async () => {
  const d = await scrape('apartments-bulevar.html', BULEVAR);
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [2, 2, 914, 2750]);
  assert.equal(d.address, '1625 Bulevar Mayor St, Gulf Breeze FL 32561');
  assert.ok(!d._needsFloorplan);
  const exterior = d.propertyDetails.exteriorFeatures || [];
  assert.ok(!exterior.includes('Shed/Outbuilding'), '"furnished" and "refreshed" are not a shed');
});

const planRow = (name, rent) => '<div class="pricingGridItem"><span class="modelName">' + name + '</span><span class="rentLabel">' + rent + '</span><span class="detailsLabel">2 beds, 2 baths, 914 sq ft</span></div>';
const withPlans = (...rows) => (html) => html.replace('</main>', rows.join('') + '</main>');

test('the only plan on a page, with no price of its own, keeps the offers price', async () => {
  const d = await scrape('apartments-bulevar.html', BULEVAR, withPlans(planRow('A1', 'Call for Rent')));
  assert.deepEqual([d.bedrooms, d.bathrooms, d.sqft, d.price], [2, 2, 914, 2750]);
});

test('a plan picked from several, with no price of its own, does not take the offers price', async () => {
  const d = await scrape('apartments-bulevar.html', BULEVAR + '?floorplan=A1', withPlans(planRow('A1', 'Call for Rent'), planRow('B1', '$3,000')));
  assert.match(d._chosenPlan, /^A1,/);
  assert.equal(d.price, null);
});
