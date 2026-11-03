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

const NON_LISTING = { source: 'apartments', title: 'Apartments', address: null, bedrooms: null, bathrooms: null, sqft: null, price: 500, propertyDetails: { propertyType: 'Apartment' }, propertyNoteBullets: [] };

test('a price with no address and no unit numbers returns listing-empty and spends no AI call', async () => {
  const ctx = loadWorker();
  const calls = stub(ctx, NON_LISTING);
  const res = await run(ctx, 'https://www.apartments.com/not-a-listing/');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'listing-empty');
  assert.equal(res.detail, 'The page loaded without listing details. Try again.');
  assert.equal(calls.ai, 0);
});

test('an empty result after the AI step is still listing-empty', async () => {
  const ctx = loadWorker();
  stub(ctx, { source: 'apartments', address: '1625 Bulevar Mayor St, Gulf Breeze FL 32561', price: 500, propertyDetails: {} });
  vm.runInContext(`
    __enrichRan = false;
    enrichWithOllama = async (scraped) => { __enrichRan = true; scraped.address = null; return { propertyDetails: {}, propertyNoteBullets: [], core: {} }; };
  `, ctx);
  const res = await run(ctx, 'https://www.apartments.com/x/');
  assert.equal(ctx.__enrichRan, true, 'the pre-AI check let this one through');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'listing-empty');
});

test('an address and a price is still a partial import', async () => {
  const ctx = loadWorker();
  stub(ctx, { source: 'apartments', address: '1625 Bulevar Mayor St, Gulf Breeze FL 32561', price: 2750, propertyDetails: {} }, { bullets: [] });
  const res = await run(ctx, 'https://www.apartments.com/x/');
  assert.equal(res.ok, true);
  assert.equal(res.data.price, 2750);
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

// ---- AirDNA market cache ----------------------------------------------------
// The worker's real tab path runs against a fake chrome: every tab "loads", the
// market scraper "answers" with the next queued result, and tabs are counted.
function marketWorker(answers) {
  const ctx = loadWorker();
  const store = {};
  const tabListeners = [];
  const logs = [];
  let nextId = 100;
  const counts = { tabs: 0 };
  ctx.console = { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} };
  ctx.chrome.storage.local = {
    get: async (k) => (k == null ? { ...store } : { [k]: store[k] }),
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    remove: async () => {},
  };
  ctx.chrome.tabs = {
    create: async () => { counts.tabs++; const id = nextId++; setTimeout(() => tabListeners.slice().forEach((l) => l(id, { status: 'complete' })), 0); return { id }; },
    remove: async () => {},
    onUpdated: { addListener: (l) => tabListeners.push(l), removeListener: (l) => { const i = tabListeners.indexOf(l); if (i >= 0) tabListeners.splice(i, 1); } },
    onRemoved: { addListener() {} },
    query: async () => [],
  };
  ctx.chrome.scripting = {
    executeScript: async ({ target }) => {
      const answer = answers.length ? answers.shift() : { _type: 'market-lookup', market: 'Example Market, FL', submarket: 'Example Beach' };
      setTimeout(() => { const p = vm.runInContext('pendingScrapes', ctx).get(target.tabId); if (p) p.resolve(answer); }, 0);
      return [];
    },
  };
  const lookup = (lat, lng) => { ctx.__ll = [lat, lng]; return vm.runInContext('lookupMarketViaAirDNA(__ll[0], __ll[1])', ctx); };
  return { ctx, store, counts, logs, lookup };
}
const DAY = 24 * 60 * 60 * 1000;

test('market cache: a hit within 30 days opens no tab', async () => {
  const w = marketWorker([]);
  const first = await w.lookup(30.3812, -87.0791);
  assert.equal(first.market, 'Example Market, FL');
  assert.equal(w.counts.tabs, 1);
  const entry = w.store.rrMarketCache['30.38,-87.08'];
  assert.equal(entry.market, 'Example Market, FL');
  assert.equal(entry.submarket, 'Example Beach');
  assert.equal(typeof entry.at, 'number');
  const again = await w.lookup(30.3812, -87.0791);
  assert.deepEqual({ ...again }, { market: 'Example Market, FL', submarket: 'Example Beach' });
  assert.equal(w.counts.tabs, 1, 'no second tab');
  assert.ok(w.logs.includes('[RR ext] market cache hit 30.38,-87.08'), w.logs.join('\n'));
});

test('market cache: an entry older than 30 days misses', async () => {
  const w = marketWorker([]);
  w.store.rrMarketCache = { '30.38,-87.08': { market: 'Old Market', submarket: null, at: Date.now() - 31 * DAY } };
  const res = await w.lookup(30.38, -87.08);
  assert.equal(res.market, 'Example Market, FL');
  assert.equal(w.counts.tabs, 1);
  assert.equal(w.store.rrMarketCache['30.38,-87.08'].market, 'Example Market, FL', 'refreshed');
  w.store.rrMarketCache['30.38,-87.08'].at = Date.now() - 29 * DAY;
  await w.lookup(30.38, -87.08);
  assert.equal(w.counts.tabs, 1, '29 days old still hits');
});

test('market cache: a login wall, a failed scrape or a null answer is never cached', async () => {
  const w = marketWorker([{ _type: 'market-lookup', _loginRequired: true }, { _type: 'something-else' }]);
  assert.equal(await w.lookup(30.38, -87.08), null);
  assert.equal(await w.lookup(30.38, -87.08), null);
  assert.equal(w.counts.tabs, 2);
  assert.equal(w.store.rrMarketCache, undefined);
  // The timeout path resolves null too; stub the tab step to answer that way at once.
  vm.runInContext('_lookupMarketViaAirDNATab = async () => null', w.ctx);
  assert.equal(await w.lookup(30.38, -87.08), null);
  assert.equal(w.store.rrMarketCache, undefined);
});

test('market cache: two lookups for the same key at once open one tab', async () => {
  const w = marketWorker([]);
  const [a, b] = await Promise.all([w.lookup(30.381, -87.081), w.lookup(30.379, -87.084)]);
  assert.equal(w.counts.tabs, 1);
  assert.equal(a.market, 'Example Market, FL');
  assert.equal(b.market, 'Example Market, FL');
});

test('market cache: nearby coordinates share an entry, farther ones do not', async () => {
  const w = marketWorker([]);
  assert.equal(vm.runInContext('marketCacheKey(30.3812, -87.0791)', w.ctx), vm.runInContext('marketCacheKey(30.3849, -87.0751)', w.ctx));
  assert.equal(vm.runInContext('marketCacheKey(-0.001, 0)', w.ctx), '0.00,0.00');
  assert.equal(vm.runInContext('marketCacheKey(null, 1)', w.ctx), null);
  await w.lookup(30.3812, -87.0791);
  await w.lookup(30.3849, -87.0751);
  assert.equal(w.counts.tabs, 1, 'same rounded key');
  await w.lookup(30.40, -87.08);
  assert.equal(w.counts.tabs, 2, 'about 2 km away');
});

test('market cache: a failed read never overwrites the cache', async () => {
  const w = marketWorker([]);
  let sets = 0;
  w.ctx.chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  w.ctx.chrome.storage.local.set = async () => { sets++; };
  const res = await w.lookup(30.38, -87.08);
  assert.equal(res.market, 'Example Market, FL', 'the lookup still answers');
  assert.equal(w.counts.tabs, 1);
  assert.equal(sets, 0, 'no write');
});

test('market cache: an entry dated more than a day ahead is a miss', () => {
  const w = marketWorker([]);
  const now = Date.now();
  const lookup = (at) => vm.runInContext('(c, k, n) => marketCacheLookup(c, k, n)', w.ctx)({ k: { market: 'M', submarket: null, at } }, 'k', now);
  assert.equal(lookup(now + 2 * DAY), null);
  assert.equal(lookup(now + 2 * 60 * 60 * 1000).market, 'M', 'a few hours of clock skew is fine');
  assert.equal(lookup(now - DAY).market, 'M');
});

test('market cache: the cap drops the oldest entries', () => {
  const w = marketWorker([]);
  const store = vm.runInContext('(c, k, v, t) => marketCacheStore(c, k, v, t)', w.ctx);
  const cache = {};
  for (let i = 0; i < 500; i++) cache['k' + i] = { market: 'M' + i, submarket: null, at: 1000 + i };
  const next = store(cache, 'new', { market: 'N', submarket: 'S' }, 5000);
  assert.equal(Object.keys(next).length, 500);
  assert.equal(next.k0, undefined, 'oldest dropped');
  assert.ok(next.k1 && next.new);
  assert.equal(Object.keys(cache).length, 500, 'input untouched');
  assert.equal(vm.runInContext('MARKET_CACHE_MAX', w.ctx), 500);
});
