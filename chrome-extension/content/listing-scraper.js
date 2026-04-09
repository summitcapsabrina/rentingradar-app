// Content script for rental listing sites: Zillow, Apartments.com, Hotpads,
// Facebook Marketplace, Craigslist. Dispatches to a per-site parser, then
// posts results back to the service worker.
//
// The output shape the CRM expects:
//   {
//     source, sourceUrl, title, address, price, bedrooms, bathrooms, sqft,
//     description, photoUrl, warning,
//     propertyDetails: { ...PROP_SECTIONS-keyed values }
//   }
//
// The `propertyDetails` sub-object is merged into the CRM's record.propertyDetails
// so that Property Overview, Interior Features, Exterior & Outdoor, Community
// Amenities, Utilities, Pets, Safety, HOA, and STR sections get auto-populated.

(function () {
  if (window.__rrListingScraperRan) return;
  window.__rrListingScraperRan = true;

  const host = location.hostname.replace(/^www\./, '').toLowerCase();

  // ---- utilities ---------------------------------------------------

  function num(str) {
    if (str == null) return null;
    const m = String(str).match(/-?[\d,.]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  function findJsonFromScript(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (_) { return null; }
  }

  function findAllJsonLd() {
    const blocks = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent);
        if (Array.isArray(parsed)) blocks.push(...parsed);
        else blocks.push(parsed);
      } catch (_) {}
    });
    return blocks;
  }

  function deepFind(obj, pred, depth) {
    depth = depth || 0;
    if (depth > 18 || !obj || typeof obj !== 'object') return null;
    if (pred(obj)) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const hit = deepFind(item, pred, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      const hit = deepFind(obj[k], pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // Walk the entire object tree and collect every object where pred() is
  // truthy, then return the one with the highest score. This is much more
  // resilient than deepFind() when multiple candidate objects exist and we
  // want the "richest" one (e.g. Zillow caches stub property objects in
  // several places; the real listing blob is the fattest one).
  function deepFindBest(root, scoreFn) {
    let best = null;
    let bestScore = 0;
    const seen = new WeakSet();
    function walk(obj, depth) {
      if (depth > 20 || !obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      const s = scoreFn(obj) || 0;
      if (s > bestScore) { bestScore = s; best = obj; }
      if (Array.isArray(obj)) { for (const v of obj) walk(v, depth + 1); return; }
      for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
    }
    walk(root, 0);
    return best;
  }

  // Collect all strings in a nested object into a single searchable blob
  function flattenToText(obj, acc, depth) {
    acc = acc || [];
    depth = depth || 0;
    if (depth > 10 || obj == null) return acc;
    if (typeof obj === 'string') { acc.push(obj); return acc; }
    if (typeof obj !== 'object') return acc;
    if (Array.isArray(obj)) { obj.forEach(i => flattenToText(i, acc, depth + 1)); return acc; }
    Object.values(obj).forEach(v => flattenToText(v, acc, depth + 1));
    return acc;
  }

  function base(source) {
    return {
      source,
      sourceUrl: location.href,
      title: null,
      address: null,
      price: null,
      bedrooms: null,
      bathrooms: null,
      sqft: null,
      description: null,
      photoUrl: null,
      propertyDetails: {},
      _pageText: null, // Cleaned page text for Ollama enrichment
    };
  }

  // Capture a cleaned version of the page's visible text for Ollama.
  // Strips nav, footer, script, style, and header elements to focus on
  // the main listing content. Capped at ~20KB before send.
  function capturePageText() {
    try {
      const main = document.querySelector('main, [role="main"], #main, .main, #content, .content') || document.body;
      const clone = main.cloneNode(true);
      clone.querySelectorAll('script, style, nav, header, footer, noscript, iframe, svg').forEach((n) => n.remove());
      const text = (clone.innerText || clone.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return text.slice(0, 20000);
    } catch (e) {
      return (document.body.innerText || '').slice(0, 20000);
    }
  }

  // Assign a value to propertyDetails only if it's non-empty.
  function setPD(pd, key, value) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    pd[key] = value;
  }

  // ---- dictionary-driven amenity matching --------------------------
  // Maps a regex to a PROP_SECTIONS multi-select option label (the exact
  // string the CRM expects). For each listing, we run every regex against
  // the concatenated "amenity blob" and collect matches per field.
  const AMENITY_PATTERNS = {
    appliances: [
      [/dishwasher/i, 'Dishwasher'],
      [/garbage disposal|disposal/i, 'Garbage Disposal'],
      [/microwave/i, 'Microwave'],
      [/gas (oven|range|stove)/i, 'Oven/Range (Gas)'],
      [/electric (oven|range|stove)/i, 'Oven/Range (Electric)'],
      [/\boven\b|\brange\b|\bstove\b/i, 'Oven/Range (Electric)'],
      [/refrigerator|fridge/i, 'Refrigerator'],
      [/ice maker/i, 'Ice Maker'],
      [/trash compactor/i, 'Trash Compactor'],
      [/wine (cooler|fridge)/i, 'Wine Cooler'],
    ],
    flooring: [
      [/hardwood/i, 'Hardwood'],
      [/carpet/i, 'Carpet'],
      [/\btile\b/i, 'Tile'],
      [/laminate/i, 'Laminate'],
      [/vinyl plank|luxury vinyl|lvp/i, 'Vinyl Plank'],
      [/concrete floor/i, 'Concrete'],
      [/marble floor/i, 'Marble'],
      [/stone floor/i, 'Stone'],
    ],
    interiorFeatures: [
      [/fireplace/i, 'Fireplace'],
      [/ceiling fan/i, 'Ceiling Fans'],
      [/walk-?in closet/i, 'Walk-In Closets'],
      [/high ceiling/i, 'High Ceilings'],
      [/vaulted ceiling/i, 'Vaulted Ceilings'],
      [/open floor plan/i, 'Open Floor Plan'],
      [/natural light/i, 'Natural Light'],
      [/crown molding/i, 'Crown Molding'],
      [/recessed lighting/i, 'Recessed Lighting'],
      [/smart thermostat/i, 'Smart Thermostat'],
      [/smart lock/i, 'Smart Locks'],
      [/built-?in shelv/i, 'Built-In Shelving'],
      [/pantry/i, 'Pantry'],
      [/kitchen island/i, 'Kitchen Island'],
      [/breakfast bar/i, 'Breakfast Bar'],
      [/stainless steel/i, 'Stainless Steel Appliances'],
      [/double vanity/i, 'Double Vanity'],
      [/soaking tub/i, 'Soaking Tub'],
      [/walk-?in shower/i, 'Walk-In Shower'],
      [/separate tub/i, 'Separate Tub/Shower'],
      [/linen closet/i, 'Linen Closet'],
      [/storage unit/i, 'Storage Unit'],
      [/blinds/i, 'Window Blinds'],
      [/blackout curtain/i, 'Blackout Curtains'],
    ],
    outdoor: [
      [/balcony/i, 'Balcony'],
      [/patio/i, 'Patio'],
      [/\bdeck\b/i, 'Deck'],
      [/porch/i, 'Porch'],
      [/screened porch/i, 'Screened Porch'],
      [/sunroom/i, 'Sunroom'],
      [/rooftop/i, 'Rooftop'],
      [/courtyard/i, 'Courtyard'],
      [/lanai/i, 'Lanai'],
    ],
    exteriorFeatures: [
      [/fenced yard|privacy fence/i, 'Fenced Yard'],
      [/sprinkler/i, 'Sprinkler System'],
      [/outdoor lighting/i, 'Outdoor Lighting'],
      [/outdoor kitchen|bbq/i, 'Outdoor Kitchen/BBQ'],
      [/fire pit/i, 'Fire Pit'],
      [/garden/i, 'Garden Space'],
      [/shed/i, 'Shed/Outbuilding'],
      [/rv parking/i, 'RV Parking'],
      [/boat parking/i, 'Boat Parking'],
      [/ev charg|electric vehicle charg/i, 'EV Charging'],
      [/gated/i, 'Gated Entry'],
      [/desert landscap|xeriscap/i, 'Desert Landscaping'],
      [/pool fence/i, 'Pool Fence'],
    ],
    communityAmenities: [
      [/gym|fitness/i, 'Gym/Fitness Center'],
      [/yoga|pilates/i, 'Yoga/Pilates Studio'],
      [/clubhouse/i, 'Clubhouse'],
      [/business center/i, 'Business Center'],
      [/co-?working/i, 'Co-Working Space'],
      [/package locker/i, 'Package Lockers'],
      [/bike storage|bicycle storage/i, 'Bike Storage'],
      [/bbq|grill area/i, 'BBQ/Grill Area'],
      [/dog park/i, 'Dog Park'],
      [/pet wash/i, 'Pet Washing Station'],
      [/playground/i, 'Playground'],
      [/tennis court/i, 'Tennis Court'],
      [/basketball court/i, 'Basketball Court'],
      [/volleyball/i, 'Volleyball Court'],
      [/pickleball/i, 'Pickleball Court'],
      [/putting green/i, 'Putting Green'],
      [/swimming pool|community pool/i, 'Swimming Pool'],
      [/community (spa|hot tub)/i, 'Community Spa/Hot Tub'],
      [/sauna/i, 'Sauna'],
      [/game room/i, 'Game Room'],
      [/theater|screening room/i, 'Theater/Screening Room'],
      [/rooftop lounge/i, 'Rooftop Lounge'],
      [/coffee bar/i, 'Coffee Bar'],
      [/car wash/i, 'Car Wash'],
      [/on-?site laundry|laundry room/i, 'On-Site Laundry'],
      [/trash valet/i, 'Trash Valet'],
      [/controlled access|gated access/i, 'Controlled Access/Gated'],
      [/key card|fob entry/i, 'Key Card Entry'],
      [/elevator/i, 'Elevator'],
      [/concierge|doorman/i, 'Concierge/Doorman'],
      [/on-?site management/i, 'On-Site Management'],
      [/on-?site maintenance/i, 'On-Site Maintenance'],
      [/community wifi|wi-?fi lounge/i, 'Community WiFi'],
    ],
    utilitiesIncluded: [
      [/water included/i, 'Water'],
      [/hot water included/i, 'Hot Water'],
      [/gas included/i, 'Gas'],
      [/electric included|electricity included/i, 'Electric'],
      [/trash included/i, 'Trash'],
      [/sewer included/i, 'Sewer'],
      [/recycling included/i, 'Recycling'],
      [/internet included|wifi included/i, 'Internet/WiFi'],
      [/cable (tv )?included/i, 'Cable TV'],
      [/landscaping included/i, 'Landscaping/Grounds'],
      [/pest control included/i, 'Pest Control'],
    ],
    safetyFeatures: [
      [/smoke detector/i, 'Smoke Detectors'],
      [/carbon monoxide/i, 'Carbon Monoxide Detectors'],
      [/fire extinguisher/i, 'Fire Extinguisher'],
      [/fire sprinkler/i, 'Fire Sprinklers'],
      [/security system|alarm system/i, 'Security System/Alarm'],
      [/gated entry/i, 'Gated Entry'],
      [/deadbolt/i, 'Deadbolt Locks'],
      [/smart lock/i, 'Smart Locks'],
      [/security camera/i, 'Security Cameras'],
      [/motion sensor/i, 'Motion Sensor Lights'],
      [/intercom/i, 'Intercom'],
      [/24-?hour security|24\/7 security/i, '24-Hour Security'],
    ],
  };

  function matchAmenities(text) {
    if (!text) return {};
    const out = {};
    for (const field in AMENITY_PATTERNS) {
      const hits = [];
      for (const [re, label] of AMENITY_PATTERNS[field]) {
        if (re.test(text) && !hits.includes(label)) hits.push(label);
      }
      if (hits.length) out[field] = hits;
    }
    return out;
  }

  // ---- Zillow ------------------------------------------------------
  // Zillow embeds a massive state blob in #__NEXT_DATA__. The `property`
  // object (sometimes under `gdp`, sometimes under `property`) contains:
  //   streetAddress, city, state, zipcode, bedrooms, bathrooms, livingArea,
  //   price, yearBuilt, lotSize, homeType, hoaFee, description, atAGlanceFacts,
  //   resoFacts { appliances, flooring, heating, cooling, laundryFeatures,
  //               parkingFeatures, lotFeatures, communityFeatures, interiorFeatures,
  //               exteriorFeatures, poolFeatures, petsAllowed, ... }
  function parseZillow() {
    const out = base('zillow');
    out._debug = { source: 'zillow', url: location.href, steps: [] };
    const log = (msg, extra) => out._debug.steps.push(extra ? (msg + ': ' + JSON.stringify(extra).slice(0, 200)) : msg);

    // Zillow stores its listing state in several places — try them all and
    // pick the object with the richest set of listing-shaped fields.
    const candidates = [];
    const nd = findJsonFromScript('__NEXT_DATA__');
    if (nd) { candidates.push(nd); log('found __NEXT_DATA__'); } else { log('__NEXT_DATA__ missing'); }
    // Some Zillow pages stash data in window.__APOLLO_STATE__ or #hdpApolloPreloadedData
    const apolloEl = document.getElementById('hdpApolloPreloadedData');
    if (apolloEl) {
      try {
        const raw = apolloEl.textContent.trim();
        // This script sometimes contains "!--" wrappers or double-stringified JSON
        const clean = raw.replace(/^<!--/, '').replace(/-->$/, '').trim();
        const parsed = JSON.parse(clean);
        candidates.push(parsed);
        log('found hdpApolloPreloadedData');
      } catch (_) { log('hdpApolloPreloadedData parse failed'); }
    }

    // Score objects by how many listing-ish keys they expose. The fattest
    // match wins — this handles Zillow variants where bedrooms is top-level
    // vs. inside resoFacts vs. inside hdpModel.
    function scoreListing(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
      let score = 0;
      if (v.bedrooms != null) score += 3;
      if (v.bathrooms != null) score += 3;
      if (v.livingArea != null || v.livingAreaValue != null) score += 3;
      if (v.price != null) score += 2;
      if (v.streetAddress) score += 2;
      if (v.zipcode) score += 1;
      if (v.homeType) score += 1;
      if (v.yearBuilt != null) score += 1;
      if (v.resoFacts && typeof v.resoFacts === 'object') score += 5;
      if (v.atAGlanceFacts) score += 1;
      if (v.description) score += 1;
      if (v.hugePhotos || v.photos) score += 1;
      return score;
    }
    let gdp = null;
    for (const root of candidates) {
      const hit = deepFindBest(root, scoreListing);
      if (hit && scoreListing(hit) > scoreListing(gdp)) gdp = hit;
    }
    if (gdp) {
      log('gdp found', { score: scoreListing(gdp), keys: Object.keys(gdp).slice(0, 20) });
    } else {
      log('gdp NOT found');
    }

    if (gdp) {
      // Normalize address fields (some blobs nest them under `address`)
      const streetAddress = gdp.streetAddress || (gdp.address && gdp.address.streetAddress);
      const city = gdp.city || (gdp.address && gdp.address.city);
      const state = gdp.state || (gdp.address && gdp.address.state);
      const zipcode = gdp.zipcode || (gdp.address && gdp.address.zipcode);

      if (streetAddress) {
        const cityState = [city, state].filter(Boolean).join(' ');
        const csz = [cityState, zipcode].filter(Boolean).join(' ').trim();
        out.address = [streetAddress, csz].filter(Boolean).join(', ');
      }

      out.price = num(gdp.price) || num(gdp.monthlyHoaFee ? null : gdp.price);
      // For rentals, rentZestimate or zestimate may be more accurate
      if (!out.price) out.price = num(gdp.rentZestimate) || num(gdp.zestimate);
      out.bedrooms = num(gdp.bedrooms);
      out.bathrooms = num(gdp.bathrooms);
      out.sqft = num(gdp.livingArea) || num(gdp.livingAreaValue);
      out.description = (gdp.description || '').slice(0, 2000) || null;
      out.photoUrl = (gdp.hugePhotos && gdp.hugePhotos[0] && gdp.hugePhotos[0].url) ||
                     (gdp.photos && gdp.photos[0] && gdp.photos[0].url) || null;

      const pd = out.propertyDetails;
      // Property Overview
      if (gdp.homeType) {
        const typeMap = {
          SINGLE_FAMILY: 'House', CONDO: 'Condo', TOWNHOUSE: 'Townhouse',
          MULTI_FAMILY: 'Duplex', APARTMENT: 'Apartment', MANUFACTURED: 'Mobile Home',
          LOT: 'Other',
        };
        setPD(pd, 'propertyType', typeMap[gdp.homeType] || 'House');
      }
      setPD(pd, 'yearBuilt', num(gdp.yearBuilt));
      if (gdp.lotSize || gdp.lotAreaValue) {
        const val = gdp.lotAreaValue || gdp.lotSize;
        const unit = gdp.lotAreaUnits || 'sqft';
        setPD(pd, 'lotSize', val + ' ' + unit);
      }
      // HOA
      if (gdp.hoaFee || gdp.monthlyHoaFee) {
        setPD(pd, 'hoaFee', num(gdp.hoaFee) || num(gdp.monthlyHoaFee));
      }

      // resoFacts has the richest structured amenity data
      const rf = gdp.resoFacts || {};

      // stories
      if (rf.stories != null) {
        const s = num(rf.stories);
        setPD(pd, 'stories', s >= 4 ? '4+' : String(s));
      }

      // appliances (array of strings like "Dishwasher", "Refrigerator", etc.)
      if (Array.isArray(rf.appliances) && rf.appliances.length) {
        const mapped = [];
        rf.appliances.forEach((a) => {
          const s = String(a);
          if (/dishwasher/i.test(s)) mapped.push('Dishwasher');
          if (/disposal/i.test(s)) mapped.push('Garbage Disposal');
          if (/microwave/i.test(s)) mapped.push('Microwave');
          if (/refrigerator|fridge/i.test(s)) mapped.push('Refrigerator');
          if (/gas (oven|range|stove|cooktop)/i.test(s)) mapped.push('Oven/Range (Gas)');
          else if (/electric (oven|range|stove|cooktop)/i.test(s)) mapped.push('Oven/Range (Electric)');
          else if (/oven|range|stove/i.test(s)) mapped.push('Oven/Range (Electric)');
          if (/ice maker/i.test(s)) mapped.push('Ice Maker');
          if (/wine/i.test(s)) mapped.push('Wine Cooler');
        });
        if (mapped.length) setPD(pd, 'appliances', Array.from(new Set(mapped)));
      }

      // flooring
      if (Array.isArray(rf.flooring) && rf.flooring.length) {
        const mapped = [];
        rf.flooring.forEach((f) => {
          const s = String(f);
          if (/hardwood|wood/i.test(s)) mapped.push('Hardwood');
          else if (/carpet/i.test(s)) mapped.push('Carpet');
          else if (/tile/i.test(s)) mapped.push('Tile');
          else if (/laminate/i.test(s)) mapped.push('Laminate');
          else if (/vinyl/i.test(s)) mapped.push('Vinyl Plank');
          else if (/concrete/i.test(s)) mapped.push('Concrete');
          else if (/marble/i.test(s)) mapped.push('Marble');
          else if (/stone/i.test(s)) mapped.push('Stone');
        });
        if (mapped.length) setPD(pd, 'flooring', Array.from(new Set(mapped)));
      }

      // A/C + heating (from heating[] / cooling[] arrays)
      if (Array.isArray(rf.cooling) && rf.cooling.length) {
        const s = rf.cooling.join(' ');
        if (/central/i.test(s)) setPD(pd, 'ac', 'Central A/C');
        else if (/window/i.test(s)) setPD(pd, 'ac', 'Window Unit');
        else if (/mini.?split/i.test(s)) setPD(pd, 'ac', 'Mini-Split');
        else if (/evaporative|swamp/i.test(s)) setPD(pd, 'ac', 'Evaporative/Swamp Cooler');
        else if (/portable/i.test(s)) setPD(pd, 'ac', 'Portable');
        else if (/none/i.test(s)) setPD(pd, 'ac', 'None');
      }
      if (Array.isArray(rf.heating) && rf.heating.length) {
        const s = rf.heating.join(' ');
        if (/gas/i.test(s) && /central|forced/i.test(s)) setPD(pd, 'heating', 'Central (Gas)');
        else if (/central|forced/i.test(s)) setPD(pd, 'heating', 'Central (Electric)');
        else if (/baseboard/i.test(s)) setPD(pd, 'heating', 'Baseboard');
        else if (/radiator/i.test(s)) setPD(pd, 'heating', 'Radiator');
        else if (/heat pump/i.test(s)) setPD(pd, 'heating', 'Heat Pump');
        else if (/fireplace/i.test(s)) setPD(pd, 'heating', 'Fireplace');
        else if (/none/i.test(s)) setPD(pd, 'heating', 'None');
      }

      // laundry
      if (Array.isArray(rf.laundryFeatures) && rf.laundryFeatures.length) {
        const s = rf.laundryFeatures.join(' ');
        if (/in.?unit|in the unit/i.test(s)) setPD(pd, 'laundry', 'In-Unit W/D');
        else if (/hookup/i.test(s)) setPD(pd, 'laundry', 'W/D Hookups');
        else if (/shared|common/i.test(s)) setPD(pd, 'laundry', 'Shared/On-Site');
        else if (/stacked/i.test(s)) setPD(pd, 'laundry', 'Stacked W/D');
        else if (/none/i.test(s)) setPD(pd, 'laundry', 'None');
      }

      // parking
      if (Array.isArray(rf.parkingFeatures) && rf.parkingFeatures.length) {
        const s = rf.parkingFeatures.join(' ');
        if (/attached garage/i.test(s)) setPD(pd, 'parking', 'Attached Garage');
        else if (/detached garage/i.test(s)) setPD(pd, 'parking', 'Detached Garage');
        else if (/carport/i.test(s)) setPD(pd, 'parking', 'Carport');
        else if (/covered/i.test(s)) setPD(pd, 'parking', 'Covered Parking');
        else if (/assigned/i.test(s)) setPD(pd, 'parking', 'Assigned Spot');
        else if (/driveway/i.test(s)) setPD(pd, 'parking', 'Driveway');
        else if (/street/i.test(s)) setPD(pd, 'parking', 'Street Only');
        else if (/garage/i.test(s)) setPD(pd, 'parking', 'Attached Garage');
        else if (/none/i.test(s)) setPD(pd, 'parking', 'None');
      }
      if (rf.garageParkingCapacity != null || rf.parkingCapacity != null) {
        setPD(pd, 'parkingSpaces', num(rf.garageParkingCapacity || rf.parkingCapacity));
      }

      // pool
      if (Array.isArray(rf.poolFeatures) && rf.poolFeatures.length) {
        const s = rf.poolFeatures.join(' ');
        if (/private/i.test(s) && /heat/i.test(s)) setPD(pd, 'pool', 'Heated Private');
        else if (/private/i.test(s)) setPD(pd, 'pool', 'Private');
        else if (/community|shared/i.test(s) && /heat/i.test(s)) setPD(pd, 'pool', 'Heated Community');
        else if (/community|shared/i.test(s)) setPD(pd, 'pool', 'Community/Shared');
        else if (/none/i.test(s)) setPD(pd, 'pool', 'None');
      } else if (gdp.hasPrivatePool) {
        setPD(pd, 'pool', 'Private');
      }

      // pets
      if (rf.petsAllowed != null) {
        const s = Array.isArray(rf.petsAllowed) ? rf.petsAllowed.join(' ') : String(rf.petsAllowed);
        if (/yes|allowed|all/i.test(s)) setPD(pd, 'petsAllowed', 'Yes - All Pets');
        else if (/dog/i.test(s) && !/cat/i.test(s)) setPD(pd, 'petsAllowed', 'Dogs Only');
        else if (/cat/i.test(s) && !/dog/i.test(s)) setPD(pd, 'petsAllowed', 'Cats Only');
        else if (/no pets|no/i.test(s)) setPD(pd, 'petsAllowed', 'No Pets');
      }

      // Build an amenity-blob search over resoFacts for the dictionary patterns
      const amenityBlob = flattenToText([
        rf.interiorFeatures, rf.exteriorFeatures, rf.communityFeatures,
        rf.poolFeatures, rf.lotFeatures, rf.atAGlanceFacts, rf.amenities,
        gdp.description,
      ]).join(' ').toLowerCase();

      const dictMatches = matchAmenities(amenityBlob);
      for (const k in dictMatches) {
        if (pd[k]) {
          // Union with existing if already populated
          const merged = Array.from(new Set((Array.isArray(pd[k]) ? pd[k] : []).concat(dictMatches[k])));
          pd[k] = merged;
        } else {
          pd[k] = dictMatches[k];
        }
      }
    }

    // ---- Fallback 1: meta tags (og:title is "Address · 3 bd · 2 ba · 1,500 sqft · Zillow")
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content
                 || document.querySelector('meta[name="twitter:title"]')?.content || '';
    const ogDesc = document.querySelector('meta[property="og:description"]')?.content
                || document.querySelector('meta[name="description"]')?.content || '';
    const ogBlob = (ogTitle + ' ' + ogDesc).trim();
    if (ogBlob) {
      log('og meta present', { len: ogBlob.length });
      if (out.bedrooms == null) out.bedrooms = num(ogBlob.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed(?:room)?s?)/i)?.[1]);
      if (out.bathrooms == null) out.bathrooms = num(ogBlob.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)/i)?.[1]);
      if (out.sqft == null) out.sqft = num(ogBlob.match(/([\d,]+)\s*(?:sq\s*ft|sqft|square feet)/i)?.[1]);
      if (out.price == null) out.price = num(ogBlob.match(/\$([\d,]+)(?:\/mo)?/i)?.[1]);
      // Street address tends to be the first comma-delimited chunk of og:title
      if (!out.address) {
        const addrMatch = ogTitle.split('|')[0].split(/ · |  — /)[0].trim();
        if (/\d/.test(addrMatch) && addrMatch.length < 200) out.address = addrMatch;
      }
    }

    // ---- Fallback 2: JSON-LD (Zillow sometimes emits Residence / House / Apartment)
    const jsonLd = findAllJsonLd();
    jsonLd.forEach((block) => {
      if (!block || typeof block !== 'object') return;
      const t = Array.isArray(block['@type']) ? block['@type'].join(' ') : String(block['@type'] || '');
      if (!/Residence|House|Apartment|Place|Product|Offer/i.test(t)) return;
      if (!out.address && block.address && block.address.streetAddress) {
        const a = block.address;
        const csz = [a.addressLocality, a.addressRegion].filter(Boolean).join(' ') + (a.postalCode ? ' ' + a.postalCode : '');
        out.address = [a.streetAddress, csz.trim()].filter(Boolean).join(', ');
      }
      if (out.bedrooms == null && block.numberOfBedrooms != null) out.bedrooms = num(block.numberOfBedrooms);
      if (out.bathrooms == null && (block.numberOfBathroomsTotal != null || block.numberOfFullBathrooms != null)) {
        out.bathrooms = num(block.numberOfBathroomsTotal || block.numberOfFullBathrooms);
      }
      if (out.sqft == null && block.floorSize && block.floorSize.value != null) out.sqft = num(block.floorSize.value);
      if (out.price == null && block.offers && (block.offers.price || block.offers.priceSpecification)) {
        out.price = num(block.offers.price || (block.offers.priceSpecification && block.offers.priceSpecification.price));
      }
    });

    // ---- Fallback 3: broad DOM selectors (covers old + new Zillow layouts)
    if (out.price == null) {
      const priceEl = document.querySelector(
        '[data-testid="price"], [data-testid="price-and-monthly-payment"], ' +
        '.summary-container [data-testid="price"], span[data-test="property-card-price"], ' +
        '[class*="summary"] [class*="price"], .ds-summary-row .ds-value'
      );
      if (priceEl) out.price = num(priceEl.textContent);
    }
    const bbsEl = document.querySelector(
      '[data-testid="bed-bath-sqft-fact-container"], [data-testid="bed-bath-beyond"], ' +
      '[data-testid="bed-bath-sqft-text__value"], .ds-bed-bath-living-area, ' +
      '[class*="bed-bath"], [class*="BedBath"]'
    );
    if (bbsEl) {
      const t = bbsEl.textContent;
      if (out.bedrooms == null) out.bedrooms = num(t.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed)/i)?.[1]);
      if (out.bathrooms == null) out.bathrooms = num(t.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i)?.[1]);
      if (out.sqft == null) out.sqft = num(t.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i)?.[1]);
    }

    // ---- Fallback 4: last-resort body text scan
    if (out.bedrooms == null || out.bathrooms == null || out.sqft == null || out.price == null) {
      const body = document.body.innerText || '';
      if (out.bedrooms == null) out.bedrooms = num(body.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed(?:room)?s?)\b/i)?.[1]);
      if (out.bathrooms == null) out.bathrooms = num(body.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)\b/i)?.[1]);
      if (out.sqft == null) out.sqft = num(body.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i)?.[1]);
      if (out.price == null) {
        const pm = body.match(/\$\s*([\d,]+)(?:\s*\/\s*mo)?/i);
        if (pm) out.price = num(pm[1]);
      }
    }

    // ---- Availability (if mentioned anywhere on the page)
    const availMatch = (document.body.innerText || '').match(
      /Available\s+(?:Now|Immediately|on\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)|(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))/i
    );
    if (availMatch) {
      const avail = availMatch[1] || availMatch[2] || 'Now';
      setPD(out.propertyDetails, 'availableDate', avail);
      log('availability: ' + avail);
    }

    out.title = document.title;
    log('final', {
      hasAddress: !!out.address,
      beds: out.bedrooms, baths: out.bathrooms, sqft: out.sqft, price: out.price,
      pdKeys: Object.keys(out.propertyDetails).length,
    });
    return out;
  }

  // ---- Apartments.com ----------------------------------------------
  // Apartments.com is a .NET site, not React/Next, but it embeds rich JSON-LD
  // blocks plus newer server-rendered layouts that changed class names several
  // times. This parser tries, in order:
  //   1. JSON-LD @type Apartment/ApartmentComplex/SingleFamilyResidence/Place
  //   2. og:title / og:description / twitter meta
  //   3. Modern data-tag-* and class*= DOM selectors
  //   4. Legacy selectors
  //   5. Body-text regex last resort
  function parseApartments() {
    const out = base('apartments');
    out._debug = { source: 'apartments', url: location.href, steps: [] };
    const log = (m, x) => out._debug.steps.push(x ? (m + ': ' + JSON.stringify(x).slice(0, 220)) : m);
    const pd = out.propertyDetails;

    // ---- Pass 1: JSON-LD (most reliable when it's present) ----
    const jsonLd = findAllJsonLd();
    log('jsonLd blocks', jsonLd.length);
    // Flatten any @graph arrays so we can iterate uniformly
    const ldBlocks = [];
    jsonLd.forEach((b) => {
      if (!b || typeof b !== 'object') return;
      if (Array.isArray(b['@graph'])) ldBlocks.push(...b['@graph']);
      else ldBlocks.push(b);
    });
    ldBlocks.forEach((block) => {
      if (!block || typeof block !== 'object') return;
      const t = Array.isArray(block['@type']) ? block['@type'].join(' ') : String(block['@type'] || '');
      // Address
      if (!out.address && block.address && typeof block.address === 'object') {
        const a = block.address;
        if (a.streetAddress) {
          const csz = [a.addressLocality, a.addressRegion].filter(Boolean).join(' ') +
                      (a.postalCode ? ' ' + a.postalCode : '');
          out.address = [a.streetAddress, csz.trim()].filter(Boolean).join(', ');
          log('address from JSON-LD ' + t);
        }
      }
      // Name / title
      if (!out.title && block.name && /Apartment|Residence|House|Place/i.test(t)) {
        out.title = String(block.name).slice(0, 300);
      }
      // Description
      if (!out.description && block.description) {
        out.description = String(block.description).slice(0, 2000);
      }
      // Beds/baths/sqft
      if (out.bedrooms == null && block.numberOfBedrooms != null) out.bedrooms = num(block.numberOfBedrooms);
      if (out.bedrooms == null && block.numberOfRooms != null) out.bedrooms = num(block.numberOfRooms);
      if (out.bathrooms == null && (block.numberOfBathroomsTotal != null || block.numberOfFullBathrooms != null)) {
        out.bathrooms = num(block.numberOfBathroomsTotal || block.numberOfFullBathrooms);
      }
      if (out.sqft == null && block.floorSize && block.floorSize.value != null) out.sqft = num(block.floorSize.value);
      // Price — from offers or priceSpecification
      const priceCandidates = [];
      if (block.offers) {
        const offers = Array.isArray(block.offers) ? block.offers : [block.offers];
        offers.forEach((o) => {
          if (o && o.price != null) priceCandidates.push(num(o.price));
          if (o && o.priceSpecification) {
            const ps = Array.isArray(o.priceSpecification) ? o.priceSpecification : [o.priceSpecification];
            ps.forEach((p) => { if (p && p.price != null) priceCandidates.push(num(p.price)); });
          }
          if (o && o.lowPrice != null) priceCandidates.push(num(o.lowPrice));
        });
      }
      const goodPrice = priceCandidates.filter((p) => p != null && p > 0)[0];
      if (out.price == null && goodPrice != null) out.price = goodPrice;
      // Contained places (unit listings under an ApartmentComplex)
      if (Array.isArray(block.containsPlace)) {
        block.containsPlace.forEach((sub) => {
          if (!sub || typeof sub !== 'object') return;
          if (out.bedrooms == null && sub.numberOfBedrooms != null) out.bedrooms = num(sub.numberOfBedrooms);
          if (out.bathrooms == null && (sub.numberOfBathroomsTotal != null || sub.numberOfFullBathrooms != null)) {
            out.bathrooms = num(sub.numberOfBathroomsTotal || sub.numberOfFullBathrooms);
          }
          if (out.sqft == null && sub.floorSize && sub.floorSize.value != null) out.sqft = num(sub.floorSize.value);
        });
      }
      // Photo
      if (!out.photoUrl && block.image) {
        out.photoUrl = Array.isArray(block.image) ? block.image[0] : block.image;
      }
    });
    log('after JSON-LD', { beds: out.bedrooms, baths: out.bathrooms, sqft: out.sqft, price: out.price, addr: !!out.address });

    // ---- Pass 2: og/meta tags ----
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content
                 || document.querySelector('meta[name="twitter:title"]')?.content || '';
    const ogDesc  = document.querySelector('meta[property="og:description"]')?.content
                 || document.querySelector('meta[name="description"]')?.content || '';
    const ogBlob  = (ogTitle + ' ' + ogDesc).trim();
    if (ogBlob) log('og len ' + ogBlob.length);
    if (ogBlob) {
      if (out.bedrooms == null) out.bedrooms = num(ogBlob.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed(?:room)?s?)/i)?.[1]);
      if (out.bathrooms == null) out.bathrooms = num(ogBlob.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)/i)?.[1]);
      if (out.sqft == null) out.sqft = num(ogBlob.match(/([\d,]+)\s*(?:sq\s*ft|sqft|square feet)/i)?.[1]);
      if (out.price == null) out.price = num(ogBlob.match(/\$\s*([\d,]+)(?:\s*\/\s*mo)?/i)?.[1]);
    }

    // ---- Pass 3: modern DOM selectors ----
    // Apartments.com current (2024+) markup uses data-tag-* attributes and
    // semantic class names like .priceBedRangeInfo, .rent-info, etc.
    if (!out.title) {
      out.title = document.querySelector(
        'h1.propertyName, #propertyName, [data-tag="propertyName"], h1[class*="property"], h1'
      )?.textContent?.trim() || document.title;
    }

    if (!out.address) {
      const street = document.querySelector(
        '.propertyAddressContainer .delivery-address, [data-tag="listingAddress"], ' +
        '.propertyAddress span:first-child, [class*="listingAddress"]'
      )?.textContent?.trim() || '';
      const cityEl = document.querySelector(
        '.propertyAddressContainer h2, .propertyAddressContainer .stateZipContainer, ' +
        '[data-tag="cityStateZip"], .propertyAddress span:nth-child(2)'
      );
      let cityBlob = cityEl ? (cityEl.textContent || '').trim() : '';
      cityBlob = cityBlob.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();
      if (street || cityBlob) {
        out.address = [street.replace(/,\s*$/, ''), cityBlob].filter(Boolean).join(', ');
      }
    }

    if (out.price == null || out.bedrooms == null || out.bathrooms == null || out.sqft == null) {
      // Try all likely price/bed/bath containers — newer layouts use flat
      // containers with multiple spans; older ones use .rentInfoDetail.
      const containers = document.querySelectorAll(
        '.priceBedRangeInfo, .priceBedRangeInfoInnerContainer, .rentInfoDetail, ' +
        '[data-tag="pricingBedsRange"], .unitPriceBed, .priceBed, ' +
        '[class*="unitPrice"], [class*="UnitPrice"], [class*="rentRange"], ' +
        '[class*="pricing"], [class*="Pricing"], .rent-info, .unit-info'
      );
      containers.forEach((el) => {
        const t = el.textContent || '';
        if (out.price == null) {
          const p = t.match(/\$\s*([\d,]+)(?:\s*\/\s*mo)?/);
          if (p) out.price = num(p[1]);
        }
        if (out.bedrooms == null) out.bedrooms = num(t.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed)/i)?.[1]);
        if (out.bathrooms == null) out.bathrooms = num(t.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i)?.[1]);
        if (out.sqft == null) out.sqft = num(t.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i)?.[1]);
      });
      log('after DOM containers', { beds: out.bedrooms, baths: out.bathrooms, sqft: out.sqft, price: out.price });
    }

    // ---- Pass 4: body-text last resort ----
    const bodyText = document.body.innerText || '';
    if (out.bedrooms == null || out.bathrooms == null || out.sqft == null || out.price == null) {
      // Apartments.com pages usually render "1 Bed · 1 Bath · 650 Sq Ft" as a
      // single block somewhere in the unit details.
      const unitLine = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed)[^\n]{0,60}?(\d+(?:\.\d+)?)\s*(?:ba|bath)[^\n]{0,60}?(\d[\d,]*)\s*(?:sq\s*ft|sqft)/i);
      if (unitLine) {
        if (out.bedrooms == null) out.bedrooms = num(unitLine[1]);
        if (out.bathrooms == null) out.bathrooms = num(unitLine[2]);
        if (out.sqft == null) out.sqft = num(unitLine[3]);
        log('unitLine matched');
      }
      if (out.bedrooms == null) out.bedrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*(?:bd|bed(?:room)?s?)\b/i)?.[1]);
      if (out.bathrooms == null) out.bathrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)\b/i)?.[1]);
      if (out.sqft == null) out.sqft = num(bodyText.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i)?.[1]);
      if (out.price == null) {
        // Prefer a price near the word "rent" or "/mo"
        const nearRent = bodyText.match(/\$\s*([\d,]+)\s*(?:\/\s*mo|\/\s*month)/i);
        out.price = num((nearRent && nearRent[1]) || bodyText.match(/\$\s*([\d,]+)/)?.[1]);
      }
    }

    // ---- Description + photo fallbacks ----
    if (!out.description) {
      out.description = document.querySelector(
        '#descriptionSection .descriptionContent, [data-tag="description"], ' +
        '.description, [class*="descriptionText"], [class*="DescriptionText"]'
      )?.textContent?.trim()?.slice(0, 2000) || null;
    }
    if (!out.photoUrl) {
      out.photoUrl = document.querySelector(
        '.mainCarouselImage, .carouselContent img, [data-tag="heroImage"] img, [class*="heroImage"] img, meta[property="og:image"]'
      )?.src || document.querySelector('meta[property="og:image"]')?.content || null;
    }

    // ---- Amenity dictionary sweep ----
    const amenityNodes = document.querySelectorAll(
      '#amenitiesSection, .amenitiesSection, .specList, .feesPoliciesSection, ' +
      '#feesAndPolicies, .uniqueFeatures, .propertyAmenities, .communityAmenities, ' +
      '[data-tag="amenities"], [class*="amenit"], [class*="Amenit"], ' +
      '[class*="feature"], [class*="Feature"]'
    );
    const amenityBlob = Array.from(amenityNodes).map((n) => n.textContent).join(' ').toLowerCase();
    const searchBlob = (amenityBlob + ' ' + bodyText).toLowerCase();
    const dictMatches = matchAmenities(searchBlob);
    for (const k in dictMatches) pd[k] = dictMatches[k];
    log('dict match keys', Object.keys(dictMatches));

    // Property type heuristic
    if (!pd.propertyType) {
      if (/condo/i.test(out.title || '')) setPD(pd, 'propertyType', 'Condo');
      else if (/townhouse|townhome/i.test(out.title || '')) setPD(pd, 'propertyType', 'Townhouse');
      else if (/house/i.test(out.title || '')) setPD(pd, 'propertyType', 'House');
      else setPD(pd, 'propertyType', 'Apartment');
    }

    // Pets
    if (/no pets|pets not allowed/i.test(searchBlob)) setPD(pd, 'petsAllowed', 'No Pets');
    else if (/dogs? allowed/i.test(searchBlob) && /cats? allowed/i.test(searchBlob)) setPD(pd, 'petsAllowed', 'Yes - All Pets');
    else if (/dogs? allowed/i.test(searchBlob)) setPD(pd, 'petsAllowed', 'Dogs Only');
    else if (/cats? allowed/i.test(searchBlob)) setPD(pd, 'petsAllowed', 'Cats Only');

    // Parking
    if (/attached garage/i.test(searchBlob)) setPD(pd, 'parking', 'Attached Garage');
    else if (/detached garage/i.test(searchBlob)) setPD(pd, 'parking', 'Detached Garage');
    else if (/garage/i.test(searchBlob)) setPD(pd, 'parking', 'Attached Garage');
    else if (/covered parking/i.test(searchBlob)) setPD(pd, 'parking', 'Covered Parking');
    else if (/carport/i.test(searchBlob)) setPD(pd, 'parking', 'Carport');
    else if (/assigned/i.test(searchBlob)) setPD(pd, 'parking', 'Assigned Spot');
    else if (/street parking/i.test(searchBlob)) setPD(pd, 'parking', 'Street Only');

    // Laundry
    if (/washer.*dryer in unit|in.?unit laundry|w\/d in unit|w\/d in-unit/i.test(searchBlob)) setPD(pd, 'laundry', 'In-Unit W/D');
    else if (/w\/d hookup|washer.*dryer hookup/i.test(searchBlob)) setPD(pd, 'laundry', 'W/D Hookups');
    else if (/laundry room|on-?site laundry/i.test(searchBlob)) setPD(pd, 'laundry', 'Shared/On-Site');

    // A/C
    if (/central (a\/c|air)/i.test(searchBlob)) setPD(pd, 'ac', 'Central A/C');
    else if (/window unit/i.test(searchBlob)) setPD(pd, 'ac', 'Window Unit');
    else if (/mini.?split/i.test(searchBlob)) setPD(pd, 'ac', 'Mini-Split');

    // Availability
    const avail = bodyText.match(/Available\s+(Now|Immediately|on\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)|(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))/i);
    if (avail) setPD(pd, 'availableDate', avail[2] || avail[3] || avail[1] || 'Now');

    log('final', {
      hasAddress: !!out.address,
      beds: out.bedrooms, baths: out.bathrooms, sqft: out.sqft, price: out.price,
      pdKeys: Object.keys(pd).length,
    });

    if (!out.title) out.title = document.title;
    return out;
  }

  // ---- Hotpads -----------------------------------------------------
  function parseHotpads() {
    const out = base('hotpads');
    out.title = document.querySelector('h1')?.textContent?.trim() || document.title;
    out.address = document.querySelector('[class*="address"]')?.textContent?.trim() || null;
    const priceTxt = document.querySelector('[class*="price"]')?.textContent;
    out.price = num(priceTxt);
    const bodyText = document.body.innerText;
    out.bedrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
    out.bathrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
    out.sqft = num(bodyText.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);
    out.photoUrl = document.querySelector('img[class*="photo"], img[class*="Photo"]')?.src || null;

    // Amenity dictionary on body text
    const dictMatches = matchAmenities(bodyText.toLowerCase());
    for (const k in dictMatches) out.propertyDetails[k] = dictMatches[k];
    return out;
  }

  // ---- Facebook Marketplace ----------------------------------------
  function parseFacebook() {
    const out = base('facebook');
    out.title = document.querySelector('h1')?.textContent?.trim() || document.title;
    const bodyText = document.body.innerText;
    const priceMatch = bodyText.match(/\$[\d,]+(?:\.\d{2})?/);
    if (priceMatch) out.price = num(priceMatch[0]);
    out.bedrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
    out.bathrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
    out.sqft = num(bodyText.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);
    out.description = null;
    out.photoUrl = document.querySelector('img[src*="scontent"]')?.src || null;
    out.warning = 'Facebook Marketplace listings have limited auto-fill accuracy. Please verify details.';

    const dictMatches = matchAmenities(bodyText.toLowerCase());
    for (const k in dictMatches) out.propertyDetails[k] = dictMatches[k];
    return out;
  }

  // ---- Craigslist --------------------------------------------------
  function parseCraigslist() {
    const out = base('craigslist');
    out.title = document.querySelector('#titletextonly')?.textContent?.trim()
      || document.querySelector('.postingtitletext')?.textContent?.trim()
      || document.title;
    const priceTxt = document.querySelector('.price')?.textContent;
    out.price = num(priceTxt);

    const attrText = Array.from(document.querySelectorAll('.attrgroup span, .attrgroup'))
      .map((n) => n.textContent || '')
      .join(' | ');
    out.bedrooms = num(attrText.match(/(\d+(?:\.\d+)?)\s*BR/i)?.[1])
      || num(attrText.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
    out.bathrooms = num(attrText.match(/(\d+(?:\.\d+)?)\s*Ba/i)?.[1])
      || num(attrText.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
    out.sqft = num(attrText.match(/([\d,]+)\s*ft2/i)?.[1])
      || num(attrText.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);

    const mapAddr = document.querySelector('.mapaddress')?.textContent?.trim();
    const hood = document.querySelector('.postingtitletext small')?.textContent?.trim()
      ?.replace(/^[()\s]+|[()\s]+$/g, '');
    out.address = mapAddr || hood || null;

    out.description = document.querySelector('#postingbody')?.textContent
      ?.replace(/QR Code Link to This Post/i, '')
      .trim()
      .slice(0, 2000) || null;
    out.photoUrl = document.querySelector('.slide.first img, #thumbs a img, .gallery img')?.src || null;

    // Craigslist property type from attrText
    const pd = out.propertyDetails;
    if (/\bhouse\b/i.test(attrText)) setPD(pd, 'propertyType', 'House');
    else if (/\bapartment\b/i.test(attrText)) setPD(pd, 'propertyType', 'Apartment');
    else if (/\bcondo\b/i.test(attrText)) setPD(pd, 'propertyType', 'Condo');
    else if (/\btownhouse\b/i.test(attrText)) setPD(pd, 'propertyType', 'Townhouse');
    else if (/\bduplex\b/i.test(attrText)) setPD(pd, 'propertyType', 'Duplex');

    // furnished
    if (/\bfurnished\b/i.test(attrText)) setPD(pd, 'furnished', 'Furnished');

    // cats/dogs OK
    if (/cats are OK/i.test(attrText) && /dogs are OK/i.test(attrText)) setPD(pd, 'petsAllowed', 'Yes - All Pets');
    else if (/dogs are OK/i.test(attrText)) setPD(pd, 'petsAllowed', 'Dogs Only');
    else if (/cats are OK/i.test(attrText)) setPD(pd, 'petsAllowed', 'Cats Only');
    else if (/no smoking/i.test(attrText) && /no pets/i.test(attrText)) setPD(pd, 'petsAllowed', 'No Pets');

    // Amenity dictionary on description
    const dictMatches = matchAmenities(((out.description || '') + ' ' + attrText).toLowerCase());
    for (const k in dictMatches) pd[k] = dictMatches[k];
    return out;
  }

  // ---- dispatcher --------------------------------------------------
  function parse() {
    if (host.endsWith('zillow.com')) return parseZillow();
    if (host.endsWith('apartments.com')) return parseApartments();
    if (host.endsWith('hotpads.com')) return parseHotpads();
    if (host.endsWith('facebook.com')) return parseFacebook();
    if (host.endsWith('craigslist.org')) return parseCraigslist();
    throw new Error('Unsupported host: ' + host);
  }

  // A "ready" page must have at least TWO of the four core listing fields
  // populated (or address + one). This prevents us from sending a half-
  // hydrated React page that only has a title like "$2,350" and nothing else.
  function coreFieldCount(d) {
    let n = 0;
    if (d.bedrooms != null) n++;
    if (d.bathrooms != null) n++;
    if (d.sqft != null) n++;
    if (d.price != null) n++;
    return n;
  }

  function run(attempt) {
    try {
      const data = parse();
      const cfc = coreFieldCount(data);
      const hasEnough = cfc >= 2 || (cfc >= 1 && !!data.address);
      // Give React/Apollo pages more time to hydrate (12 attempts × 750ms = ~9s)
      if (hasEnough || attempt >= 12) {
        data._pageText = capturePageText();
        if (data._debug) {
          data._debug.finalAttempt = attempt;
          data._debug.finalCoreFieldCount = cfc;
        }
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 12) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 750);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 400);
  else window.addEventListener('load', () => setTimeout(() => run(0), 400), { once: true });
})();
