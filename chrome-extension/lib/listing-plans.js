// Pure helpers for telling a listing's units and floor plans apart. Shared by the
// service worker (importScripts), the listing scraper (injected before it) and
// tests/listing-scraper.test.js. Nothing here may touch the DOM or chrome.* APIs.
(function (root) {
  function toNum(v) {
    if (v == null || v === '') return null;
    const m = String(v).match(/-?[\d,]*\.?\d+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // Zillow: /homedetails/...<zpid>_zpid/ is one unit; /b/... and /apartments/... are
  // buildings. Returns { type:'unit', zpid } | { type:'building' } | { type:'unknown' }.
  function zillowPageType(url) {
    let u;
    try { u = new URL(url); } catch (_) { return { type: 'unknown' }; }
    const zp = u.pathname.match(/\/(\d+)_zpid(?:\/|$)/);
    if (zp) return { type: 'unit', zpid: zp[1] };
    if (/^\/(?:b|apartments)\//i.test(u.pathname)) return { type: 'building' };
    return { type: 'unknown' };
  }

  // A unit id named in a building page's URL, if there is one.
  function zillowSelectedUnitId(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    const q = u.searchParams.get('unitZpid') || u.searchParams.get('zpid') || u.searchParams.get('unit');
    if (q) return String(q);
    const h = u.hash.match(/(\d+)_zpid|^#(?:unit[-=/])?([\w-]+)$/i);
    return h ? (h[1] || h[2]) : null;
  }

  // Zillow's building blob -> [{ label, beds, baths, sqft, priceMin, priceMax, url, id }].
  // Each row's numbers come from that one unit or floor plan.
  function zillowBuildingUnits(building, origin) {
    const b = building || {};
    const abs = (p) => (p && /^\//.test(p) ? (origin || '') + p : (p || null));
    const rows = [];
    (Array.isArray(b.ungroupedUnits) ? b.ungroupedUnits : []).forEach((u) => {
      if (!u || typeof u !== 'object') return;
      const price = toNum(u.price);
      rows.push({
        label: String(u.unitNumber || u.unit || 'Unit').trim(),
        beds: toNum(u.beds), baths: toNum(u.baths), sqft: toNum(u.sqft),
        priceMin: price, priceMax: price, url: abs(u.hdpUrl), id: u.zpid != null ? String(u.zpid) : null,
      });
    });
    (Array.isArray(b.floorPlans) ? b.floorPlans : []).forEach((f) => {
      if (!f || typeof f !== 'object') return;
      rows.push({
        label: String(f.floorPlanName || f.name || 'Floor plan').trim(),
        beds: toNum(f.beds), baths: toNum(f.baths), sqft: toNum(f.sqft),
        priceMin: toNum(f.minPrice != null ? f.minPrice : f.price),
        priceMax: toNum(f.maxPrice != null ? f.maxPrice : f.price),
        url: abs(f.hdpUrl), id: f.zpid != null ? String(f.zpid) : null,
      });
    });
    return rows;
  }

  // One Apartments.com pricing-grid row. "Studio" and "1 Bed 1 Bath 696 Sq Ft" both parse.
  function parseApartmentsPlanRow(row) {
    const details = String((row && row.details) || '').replace(/\s+/g, ' ').trim();
    const rent = String((row && row.rent) || '').replace(/\s+/g, ' ').trim();
    const beds = /\bstudio\b/i.test(details) ? 0 : toNum((details.match(/([\d.]+)\s*(?:bed|bd|br)/i) || [])[1]);
    const baths = toNum((details.match(/([\d.]+)\s*(?:bath|ba)/i) || [])[1]);
    const sqft = toNum((details.match(/([\d,]+)(?:\s*-\s*[\d,]+)?\s*(?:sq\.?\s*ft|sqft)/i) || [])[1]);
    const prices = (rent.match(/\$\s*[\d,]+/g) || []).map(toNum).filter((p) => p != null && p > 0);
    const maxes = ((row && row.maxRents) || []).map(toNum).filter((p) => p != null && p > 0);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const top = Math.max(priceMin || 0, ...prices, ...maxes);
    return {
      name: String((row && row.name) || '').trim(),
      beds, baths, sqft, priceMin,
      priceMax: top > 0 ? top : null,
      priceFrom: /starting|from/i.test(rent) || prices.length > 1,
      unit: (row && row.unit) || null,
      rentalKey: (row && row.rentalKey) || null,
    };
  }

  // The same grid appears under each bedroom tab, so a plan can repeat.
  function dedupePlans(plans) {
    const seen = new Set();
    const out = [];
    (plans || []).forEach((p) => {
      if (!p || !p.name) return;
      const key = p.name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    });
    return out;
  }

  // JSON-LD fallback for when there's no grid. containsPlace names units "<plan>-<unit>"
  // and may nest the numbers under accommodationFloorPlan; group them back into plans.
  function plansFromContainsPlace(places) {
    const byName = new Map();
    (Array.isArray(places) ? places : []).forEach((p) => {
      if (!p || typeof p !== 'object') return;
      const fp = p.accommodationFloorPlan && typeof p.accommodationFloorPlan === 'object' ? p.accommodationFloorPlan : p;
      const beds = toNum(fp.numberOfBedrooms);
      const baths = toNum(fp.numberOfBathroomsTotal != null ? fp.numberOfBathroomsTotal : fp.numberOfFullBathrooms);
      const sqft = fp.floorSize ? toNum(fp.floorSize.value) : null;
      if (beds == null && baths == null && sqft == null) return;
      const raw = String(p.name || '').trim();
      const name = raw.replace(/-[^-]+$/, '').trim() || raw || [beds, baths, sqft].join('/');
      if (!byName.has(name)) byName.set(name, { name, beds, baths, sqft, priceMin: null, priceMax: null, priceFrom: false, unit: null, rentalKey: null });
    });
    return Array.from(byName.values());
  }

  // A plan named by the URL (?floorplan=B4, or a rental key anywhere in it).
  function selectedPlanFromUrl(plans, url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    const named = u.searchParams.get('floorplan') || u.searchParams.get('floorPlan') || u.searchParams.get('plan') || u.searchParams.get('model');
    const hay = (u.search + u.hash).toLowerCase();
    for (const p of plans || []) {
      if (named && p.name.toLowerCase() === named.toLowerCase()) return p;
      if (p.rentalKey && hay.includes(String(p.rentalKey).toLowerCase())) return p;
    }
    return null;
  }

  // An address worth keeping: a street number and some letters, not a page title.
  function isUsableAddress(address) {
    const s = String(address == null ? '' : address).trim();
    return /\d/.test(s) && /[a-z]{2}/i.test(s) && !/^\$/.test(s);
  }

  function coreCount(d) {
    if (!d) return 0;
    return ['bedrooms', 'bathrooms', 'sqft', 'price'].filter((k) => d[k] != null && d[k] !== '').length;
  }

  // A scrape with no address, no numbers and no list of units has nothing to import.
  function scrapeIsEmpty(d) {
    if (!d) return true;
    const hasList = (Array.isArray(d.floorplans) && d.floorplans.length) || (Array.isArray(d.units) && d.units.length);
    return !isUsableAddress(d.address) && coreCount(d) === 0 && !hasList;
  }

  const api = {
    toNum, zillowPageType, zillowSelectedUnitId, zillowBuildingUnits, parseApartmentsPlanRow,
    dedupePlans, plansFromContainsPlace, selectedPlanFromUrl, isUsableAddress, coreCount, scrapeIsEmpty,
  };
  root.RRListingPlans = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
