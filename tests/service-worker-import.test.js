// Loads the real service worker in a vm with chrome.* stubbed, the way MV3 runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'chrome-extension');

function loadWorker() {
  const event = { addListener() {} };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, AbortController, fetch: async () => { throw new Error('no network in tests'); },
    chrome: {
      runtime: { onMessage: event, onMessageExternal: event, onInstalled: event, onStartup: event, onConnect: event, getManifest: () => ({ version: 'test' }) },
      storage: { sync: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
      tabs: { onUpdated: event, onRemoved: event, create: async () => ({ id: 1 }), remove: async () => {}, query: async () => [] },
      scripting: { executeScript: async () => [] },
      alarms: { create() {}, onAlarm: event },
    },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // importScripts resolves against the worker's own folder, as it does in Chrome.
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, 'background', f), 'utf8'), ctx));
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background/service-worker.js'), 'utf8'), ctx);
  return ctx;
}

// Replaces the tab scrape and the AI call, recording what the AI was asked.
function stub(ctx, scraped, aiJson) {
  const calls = { ai: 0, prompts: [] };
  ctx.__scraped = scraped;
  ctx.__aiJson = aiJson || { bedrooms: 3, bathrooms: 2, sqft: 1982, bullets: ['Near the Gulf'] };
  ctx.__onAi = (prompt) => { calls.ai++; calls.prompts.push(prompt); };
  vm.runInContext(`
    scrapeInBackgroundTab = async () => JSON.parse(JSON.stringify(__scraped));
    callClaudeProxy = async (sys, user) => { __onAi(user); return JSON.parse(JSON.stringify(__aiJson)); };
  `, ctx);
  return calls;
}

const run = (ctx, url) => { ctx.__url = url; return vm.runInContext(`scrapeAny(__url, 'listing')`, ctx); };
const URL_Z = 'https://www.zillow.com/homedetails/x/1_zpid/';

test('the worker loads, with the shared libraries, as MV3 would run it', () => {
  const ctx = loadWorker();
  assert.equal(typeof vm.runInContext('valueInText', ctx), 'function');
  assert.equal(typeof ctx.RRListingPlans.scrapeIsEmpty, 'function');
});

test('an empty page returns listing-empty and spends no AI call', async () => {
  const ctx = loadWorker();
  const calls = stub(ctx, { source: 'zillow', title: 'Access to this page has been denied', address: null, propertyDetails: {} });
  const res = await run(ctx, URL_Z);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'listing-empty');
  assert.match(res.detail, /Try again/);
  assert.equal(calls.ai, 0);
});

test('an address with no numbers is not empty', async () => {
  const ctx = loadWorker();
  stub(ctx, { source: 'zillow', address: '8436 Gulf Blvd, Navarre FL 32566', propertyDetails: {} });
  assert.equal((await run(ctx, URL_Z)).ok, true);
});

test('the AI cannot fill core numbers when a floor plan must be picked', async () => {
  const ctx = loadWorker();
  const calls = stub(ctx, { source: 'apartments', address: '13450 Perdido Key Dr, Pensacola FL 32507', bedrooms: null, bathrooms: null, sqft: null, price: null, _needsFloorplan: true, floorplans: [{ name: 'B4' }], propertyDetails: {}, _pageText: 'x', _fullPageText: 'near the gulf', _rawPageText: 'near the gulf' });
  const res = await run(ctx, 'https://www.apartments.com/x/y/');
  assert.equal(res.ok, true);
  assert.deepEqual([res.data.bedrooms, res.data.bathrooms, res.data.sqft], [null, null, null]);
  assert.match(calls.prompts[0], /none is chosen\. Do not state beds, baths, sq ft or rent/);
});

test('the AI cannot fill core numbers on a building page', async () => {
  const ctx = loadWorker();
  stub(ctx, { source: 'zillow', address: '8436 Gulf Blvd, Navarre FL 32566', bedrooms: null, bathrooms: null, sqft: null, price: null, _needsUnit: true, propertyDetails: {}, _fullPageText: 'x' });
  const res = await run(ctx, 'https://www.zillow.com/b/x/');
  assert.deepEqual([res.data.bedrooms, res.data.sqft], [null, null]);
});

test('the prompt names a chosen plan, and a normal listing still gets AI numbers', async () => {
  const ctx = loadWorker();
  const calls = stub(ctx, { source: 'apartments', address: '1 A St', bedrooms: 2, bathrooms: 2, sqft: 1193, price: 1991, _chosenPlan: 'B4, 2 bd, 2 ba, 1193 sf', propertyDetails: {}, _fullPageText: 'x' });
  await run(ctx, 'https://www.apartments.com/x/y/');
  assert.match(calls.prompts[0], /Describe ONLY the chosen floor plan: B4, 2 bd/);

  const ctx2 = loadWorker();
  stub(ctx2, { source: 'zillow', address: '1 A St', bedrooms: 2, bathrooms: null, sqft: null, price: 1900, propertyDetails: {}, _fullPageText: 'x' });
  const res = await run(ctx2, URL_Z);
  assert.equal(res.data.bathrooms, 2);
  assert.equal(res.data.sqft, 1982);
  assert.equal(res.data.bedrooms, 2, 'the scraper value wins');
});

test('the dictionary extractor applies the amenity fixes end to end', () => {
  const ctx = loadWorker();
  const pd = vm.runInContext(`extractPropertyDetailsFromText(${JSON.stringify('Fully furnished, spacious, Move-In Concierge, carpool lane, fire sprinkler system, tenant pays electricity, at Gulf Island')})`, ctx);
  const all = JSON.stringify(pd);
  ['Shed/Outbuilding', 'Community Spa/Hot Tub', 'Swimming Pool', 'Concierge/Doorman', 'Sprinkler System', 'Electric', 'Kitchen Island'].forEach((v) => {
    assert.ok(!all.includes(v), v + ' in ' + all);
  });
  assert.equal(pd.furnished, 'Furnished');
});

test('grounding keeps real values and drops substring ones', () => {
  const ctx = loadWorker();
  const out = vm.runInContext(`(() => {
    const pd = { communityAmenities: ['Swimming Pool', 'Community Spa/Hot Tub', 'Concierge/Doorman', 'Some Custom Thing'], parking: 'Street Only' };
    groundPropertyDetails(pd, 'Community pool. Thoughtfully designed space. Move-In Concierge. Custom Thing nearby. Parking\\n\\nStreet');
    return pd;
  })()`, ctx);
  assert.deepEqual(Array.from(out.communityAmenities), ['Swimming Pool', 'Some Custom Thing']);
  assert.equal(out.parking, 'Street Only');
});
