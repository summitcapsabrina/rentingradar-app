// Amenity trigger table and matcher, shared by the service worker (importScripts),
// the listing scraper (injected before it) and tests/amenity-match.test.js.
// Nothing in this file may touch the DOM or chrome.* APIs.
//
// Trigger syntax:
//   'walk-in closet'  whole words/phrase, optional plural, any whitespace between words
//   'xeriscap*'       prefix: matches xeriscape, xeriscaping
// Exclusions are phrases blanked out of the text before a value's triggers run.
(function (root) {
  // Source-grounding for amenity enum values. Each allowed value (e.g.
  // "Stainless Steel Appliances", "Attached Garage", "Swimming Pool") has
  // a set of trigger phrases. If NONE of those phrases appear in the
  // listing's page text, the model invented the value and we drop it.
  const AMENITY_SOURCE_TRIGGERS = {
    // Interior features
    'Fireplace': ['fireplace','wood burning','wood-burning'],
    'Ceiling Fans': ['ceiling fan'],
    'Walk-In Closets': ['walk-in closet','walk in closet','walkin closet'],
    'High Ceilings': ['high ceiling','tall ceiling','9-foot ceiling','10-foot ceiling','9 foot ceiling','10 foot ceiling','9 ft ceiling','10 ft ceiling'],
    'Vaulted Ceilings': ['vaulted','cathedral ceiling'],
    'Open Floor Plan': ['open floor plan','open concept','open layout'],
    'Natural Light': ['natural light','sun-drenched','sun drenched','bright','sunlit','large windows','floor-to-ceiling window'],
    'Crown Molding': ['crown molding','crown moulding'],
    'Recessed Lighting': ['recessed light*','can light*','pot light*'],
    'Smart Thermostat': ['smart thermostat','nest thermostat','ecobee'],
    'Smart Locks': ['smart lock','keyless entry'],
    'Built-In Shelving': ['built-in shelv*','built in shelv*','bookshel*'],
    'Pantry': ['pantry','pantries'],
    'Kitchen Island': ['kitchen island','island kitchen','center island','granite island','quartz island'],
    'Breakfast Bar': ['breakfast bar','breakfast nook'],
    'Stainless Steel Appliances': ['stainless','stainless steel'],
    'Double Vanity': ['double vanity','double vanities','dual vanity','dual vanities','his and hers'],
    'Soaking Tub': ['soaking tub','clawfoot','deep tub'],
    'Walk-In Shower': ['walk-in shower','walk in shower'],
    'Separate Tub/Shower': ['separate tub','separate shower'],
    'Linen Closet': ['linen closet'],
    'Storage Unit': ['storage unit','storage space','storage locker'],
    'Window Blinds': ['blinds'],
    'Blackout Curtains': ['blackout'],
    // Appliances
    'Dishwasher': ['dishwasher'],
    'Garbage Disposal': ['garbage disposal','disposal'],
    'Microwave': ['microwave'],
    'Oven/Range (Gas)': ['gas oven','gas range','gas stove','gas cooktop'],
    'Oven/Range (Electric)': ['electric oven','electric range','electric stove','oven','oven/range','range/oven','stove','cooktop'],
    'Refrigerator': ['refrigerator','fridge'],
    'Ice Maker': ['ice maker','icemaker'],
    'Trash Compactor': ['trash compactor','compactor'],
    'Wine Cooler': ['wine cooler','wine fridge'],
    // Flooring
    'Hardwood': ['hardwood','wood floor*'],
    'Carpet': ['carpet*'],
    'Tile': ['tile floor*','ceramic tile','porcelain tile','tiled'],
    'Laminate': ['laminate'],
    'Vinyl Plank': ['vinyl plank','lvp','luxury vinyl'],
    'Concrete': ['concrete floor*','polished concrete'],
    'Marble': ['marble floor*'],
    'Stone': ['stone floor*','slate floor*','travertine'],
    'Mixed': [],
    // Laundry (single)
    'In-Unit W/D': ['in-unit washer','in unit washer','in-unit w/d','washer/dryer in','washer and dryer in','w/d in unit'],
    'W/D Hookups': ['w/d hookup','washer hookup','dryer hookup','washer/dryer hookup','washer and dryer hookup'],
    'Shared/On-Site': ['shared laundry','on-site laundry','on site laundry','laundry room','laundry on site','community laundry'],
    'Stacked W/D': ['stacked washer','stacked w/d'],
    // A/C (single). "air conditioning" and bare "a/c" trigger Central A/C as a safe
    // default when no more-specific type is stated. The section routing in
    // parseApartments takes precedence when a Features section names the type.
    'Central A/C': ['central a/c','central ac','central air','air conditioning','air conditioner','air-conditioning','air-conditioned','air conditioned','a/c'],
    'Window Unit': ['window unit','window a/c','window ac'],
    'Mini-Split': ['mini-split','mini split','ductless'],
    'Evaporative/Swamp Cooler': ['swamp cooler','evaporative cooler'],
    'Portable': ['portable a/c','portable ac'],
    // Heating (single)
    'Central (Gas)': ['central heat*','gas heat*','gas furnace','forced air gas'],
    'Central (Electric)': ['electric heat*','electric furnace','heat pump','forced air electric'],
    'Baseboard': ['baseboard heat*'],
    'Radiator': ['radiator','steam heat'],
    'Heat Pump': ['heat pump'],
    'Space Heater': ['space heater'],
    // Parking (single)
    'Attached Garage': ['attached garage','attached 1-car','attached 2-car','attached two-car'],
    'Detached Garage': ['detached garage'],
    'Carport': ['carport'],
    'Covered Parking': ['covered parking','covered spot','covered space','parking covered'],
    'Assigned Spot': ['assigned parking','assigned spot','reserved parking','reserved spot','parking assigned'],
    'Street Only': ['street parking','on-street parking','on street parking','parking street','parking: street'],
    'Driveway': ['driveway','parking driveway'],
    'Open Lot': ['parking lot','open lot','surface lot','parking: lot'],
    'Parking Garage': ['parking garage','garage parking'],
    // Pool (single)
    'Private': ['private pool','own pool','backyard pool','in-ground pool'],
    'Community/Shared': ['community pool','shared pool','pool access','building pool','complex pool'],
    'Heated Private': ['heated pool'],
    'Heated Community': ['heated community pool','heated shared pool'],
    // Outdoor
    'Balcony': ['balcony','balconies'],
    'Patio': ['patio'],
    'Deck': ['deck','sundeck'],
    'Porch': ['porch','porches'],
    'Screened Porch': ['screened porch','screen porch'],
    'Sunroom': ['sunroom','sun room'],
    'Rooftop': ['rooftop','roof deck','roof top','roof terrace'],
    'Courtyard': ['courtyard'],
    'Lanai': ['lanai'],
    // Exterior features
    'Fenced Yard': ['fenced yard','fenced-in yard','fenced backyard','privacy fence'],
    'Sprinkler System': ['sprinkler'],
    'Outdoor Lighting': ['outdoor lighting','landscape lighting'],
    'Outdoor Kitchen/BBQ': ['outdoor kitchen','bbq','barbecue','grill station','built-in grill'],
    'Fire Pit': ['fire pit','firepit'],
    'Garden Space': ['garden','planter'],
    'Shed/Outbuilding': ['shed','outbuilding'],
    'RV Parking': ['rv parking'],
    'Boat Parking': ['boat parking','boat dock'],
    'EV Charging': ['ev charg*','electric vehicle charg*','tesla charg*'],
    'Gated Entry': ['gated','gate entry','gated community'],
    'Desert Landscaping': ['desert landscap*','xeriscap*'],
    'Pool Fence': ['pool fence'],
    // Community amenities
    'Gym/Fitness Center': ['gym','fitness center','fitness room','fitness studio','fitness facility','workout room','workout facility','workout center'],
    'Clubhouse': ['clubhouse','club house'],
    'Business Center': ['business center','business lounge'],
    'Package Lockers': ['package locker','parcel locker','amazon locker','luxer'],
    'Dog Park': ['dog park','dog run'],
    'Playground': ['playground','play area'],
    'Swimming Pool': ['pool','poolside','swimming pool'],
    'Community Spa/Hot Tub': ['hot tub','spa','jacuzzi'],
    'Sauna': ['sauna'],
    'Elevator': ['elevator','passenger lift'],
    // A staffed desk only. A row that says just "Concierge" (amenity lists put one
    // item per line) also counts; see LINE_TRIGGERS.
    'Concierge/Doorman': ['concierge service','24-hour concierge','24 hour concierge','24/7 concierge','on-site concierge','doorman','doormen','front desk'],
    'On-Site Management': ['on-site management','on site management','on-site manager'],
    'On-Site Maintenance': ['on-site maintenance','on site maintenance'],
    'Bike Storage': ['bike storage','bicycle storage','bike room'],
    'BBQ/Grill Area': ['bbq','barbecue','grill area','grilling station'],
    'Rooftop Lounge': ['rooftop lounge','rooftop deck','sky lounge','rooftop terrace'],
    'Tennis Court': ['tennis court'],
    'Pickleball Court': ['pickleball'],
    // Utilities included: contextual phrases only. Bare words like "water" or
    // "electricity" also match "water heater" and "tenant pays electricity".
    'Water': ['water included','includes water','water is included','utilities included'],
    'Hot Water': ['hot water included','includes hot water','hot water is included'],
    'Gas': ['gas included','includes gas'],
    'Electric': ['electric included','electricity included','includes electric','includes electricity','electric is included','electricity is included'],
    'Heat': ['heat included','heating included','heat and hot water included','includes heat','heat is included'],
    'Trash': ['trash included','garbage included','includes trash','trash removal included','trash pickup included'],
    'Sewer': ['sewer included','includes sewer'],
    'Recycling': ['recycling included'],
    'Internet/WiFi': ['internet included','wifi included','wi-fi included','includes wifi','includes internet'],
    'Cable TV': ['cable included','cable tv included'],
    'Landscaping/Grounds': ['landscaping included','grounds maintenance included'],
    'Pest Control': ['pest control included','includes pest control'],
    // Pets. Multi-select: each type triggers independently.
    'Cats Allowed': ['cats allowed','cats welcome','cats ok','cats permitted','cat friendly','cats, dogs ok','cats, dogs allowed','cats and dogs','cats & dogs'],
    'Dogs Allowed': ['dogs allowed','dogs welcome','dogs ok','dogs permitted','dog friendly','cats, dogs ok','cats, dogs allowed','cats and dogs','cats & dogs','dogs, cats ok','dogs, cats allowed'],
    'Small Dogs Only': ['small dogs only','small dogs allowed','small dogs'],
    'Small Pets Only': ['small pets','small animal'],
    'Case by Case': ['case by case','case-by-case','pets with approval','pets upon approval','pets allowed with approval','pets allowed upon approval'],
    'Service Animals Only': ['service animals only','only service animals','except service animals','except for service animals'],
    'No Pets': ['no pets','pets not allowed','pet free','pet-free'],
    // Safety
    'Smoke Detectors': ['smoke detector','smoke alarm'],
    'Carbon Monoxide Detectors': ['carbon monoxide','co detector'],
    'Fire Extinguisher': ['fire extinguisher'],
    'Security System/Alarm': ['security system','alarm system','burglar alarm'],
    'Deadbolt Locks': ['deadbolt'],
    'Security Cameras': ['security camera','cctv','video surveillance','surveillance camera'],
    '24-Hour Security': ['24-hour security','24 hour security','24/7 security'],
    // Property type (single-select)
    'House': ['single family','single-family','sfh','house','house for rent','home for rent','detached home'],
    'Apartment': ['apartment','apt'],
    'Condo': ['condo','condominium'],
    'Townhouse': ['townhouse','townhome','town house','town home'],
    'Duplex': ['duplex'],
    'Triplex': ['triplex'],
    'Fourplex': ['fourplex','quadplex','4-plex','four-plex'],
    'Studio': ['studio apartment','studio for rent','studio unit'],
    'Loft': ['loft'],
    'Mobile Home': ['mobile home','manufactured home'],
    'Villa': ['villa'],
    'Cottage': ['cottage','casita'],
    // Furnished (single-select). The extractor's priority list checks
    // "Partially Furnished" before the bare trigger.
    'Partially Furnished': ['partially furnished','partly furnished','semi-furnished','semi furnished'],
    'Unfurnished': ['unfurnished','not furnished'],
    'Furnished': ['fully furnished','comes furnished','furnished'],
  };

  // Phrases that contain a trigger but don't mean the amenity.
  const AMENITY_TRIGGER_EXCLUSIONS = {
    'Garbage Disposal': ['at your disposal','at the disposal','waste disposal','trash disposal'],
    'Fireplace': [],
    'Rooftop': ['rooftop solar','rooftop solar panel','rooftop panel'],
    'Courtyard': ['courtyard by marriott','courtyard marriott'],
    'Deck': ['deck of cards','on deck'],
    'Sprinkler System': ['fire sprinkler','fire-sprinkler','fire sprinkler system','fire suppression sprinkler'],
    'Garden Space': ['garden-style','garden style','garden apartment','garden level','garden inn','garden city','garden grove','garden district','botanical garden','hilton garden','madison square garden'],
    'Gated Entry': ['non-gated'],
    'Gym/Fitness Center': ['gym membership','gym nearby','nearby gym','local gym'],
    'Swimming Pool': ['pool table','pool hall','motor pool','talent pool','car pool','pool of'],
    'Community Spa/Hot Tub': ['spa-like','spa like','spa-inspired','spa inspired','spa-style','spa style','spa bath','spa shower','day spa','nearby spa'],
    'Elevator': ['elevator pitch'],
    'Outdoor Kitchen/BBQ': ['bbq restaurant','bbq joint'],
    'BBQ/Grill Area': ['bbq restaurant','bbq joint'],
    'Concierge/Doorman': ['move-in concierge','move in concierge','concierge move-in','concierge move in','resident concierge app'],
    'Shed/Outbuilding': ['shed light'],
  };

  // Triggers that only count as a whole line, the shape of an amenity-list row.
  const LINE_TRIGGERS = { 'Concierge/Doorman': ['concierge'] };

  // Values that assert absence, so a "no"/"not" in front of them is expected.
  const NEGATIVE_VALUES = new Set(['No Pets', 'Unfurnished']);

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const NEGATION_BEFORE = '(?<!(?:^|[^a-z0-9])(?:no|not|without|non)[\\s-]+)';

  const compiled = new Map();
  function phraseRe(trigger, opts) {
    const key = trigger + (opts && opts.negatable ? '|n' : '');
    if (compiled.has(key)) return compiled.get(key);
    const isPrefix = trigger.endsWith('*');
    const body = escapeRe(isPrefix ? trigger.slice(0, -1) : trigger).replace(/\s+/g, '\\s+');
    const tail = isPrefix ? '' : '(?:s|es)?(?![a-z0-9])';
    const guard = opts && opts.negatable ? NEGATION_BEFORE : '';
    const re = new RegExp(guard + '(?<![a-z0-9])' + body + tail, 'i');
    compiled.set(key, re);
    return re;
  }

  // The text with this value's excluded phrases blanked out.
  function textForValue(value, text) {
    const excl = AMENITY_TRIGGER_EXCLUSIONS[value];
    if (!excl || !excl.length) return text;
    let out = text;
    for (const phrase of excl) {
      out = out.replace(new RegExp(phraseRe(phrase).source, 'gi'), ' ');
    }
    return out;
  }

  // Does any trigger for this value appear in the source text?
  function valueInText(value, text) {
    const triggers = AMENITY_SOURCE_TRIGGERS[value];
    if (!triggers || !triggers.length) return false;
    const src = textForValue(value, String(text == null ? '' : text));
    const negatable = !NEGATIVE_VALUES.has(value);
    for (const t of triggers) if (phraseRe(t, { negatable }).test(src)) return true;
    for (const t of (LINE_TRIGGERS[value] || [])) {
      if (new RegExp('(?:^|\\n)[ \\t]*' + escapeRe(t) + '[ \\t]*(?:\\n|$)', 'i').test(src)) return true;
    }
    return false;
  }

  // ---- scraper dictionary ----------------------------------------------
  // Maps a regex to the PROP_SECTIONS option label(s) the CRM expects. Every
  // listing runs each regex against its "amenity blob" and collects the labels.
  const AMENITY_PATTERNS = {
    appliances: [
      [/\bdishwashers?\b/i, 'Dishwasher'],
      [/\b(?:garbage )?disposals?\b/i, 'Garbage Disposal'],
      [/\bmicrowaves?\b/i, 'Microwave'],
      [/\bgas (?:oven|range|stove)s?\b/i, 'Oven/Range (Gas)'],
      [/\belectric (?:oven|range|stove)s?\b/i, 'Oven/Range (Electric)'],
      [/\bovens?\b|\bstoves?\b|\boven\/range\b|\brange\/oven\b/i, 'Oven/Range (Electric)'],
      [/\brefrigerators?\b|\bfridges?\b/i, 'Refrigerator'],
      [/\bice makers?\b/i, 'Ice Maker'],
      [/\btrash compactors?\b/i, 'Trash Compactor'],
      [/\bwine (?:cooler|fridge)s?\b/i, 'Wine Cooler'],
    ],
    flooring: [
      [/\bhardwood\b/i, 'Hardwood'],
      [/\bcarpet(?:s|ed|ing)?\b/i, 'Carpet'],
      [/\btiled?\b/i, 'Tile'],
      [/\blaminate\b/i, 'Laminate'],
      [/\bvinyl plank\b|\bluxury vinyl\b|\blvp\b/i, 'Vinyl Plank'],
      [/\bconcrete floors?\b/i, 'Concrete'],
      [/\bmarble floors?\b/i, 'Marble'],
      [/\bstone floors?\b/i, 'Stone'],
    ],
    interiorFeatures: [
      [/\bfireplaces?\b/i, 'Fireplace'],
      [/\bceiling fans?\b/i, 'Ceiling Fans'],
      [/\bwalk-?in closets?\b/i, 'Walk-In Closets'],
      [/\bhigh ceilings?\b/i, 'High Ceilings'],
      [/\bvaulted ceilings?\b/i, 'Vaulted Ceilings'],
      [/\bopen floor plan\b/i, 'Open Floor Plan'],
      [/\bnatural light\b/i, 'Natural Light'],
      [/\bcrown molding\b/i, 'Crown Molding'],
      [/\brecessed lighting\b/i, 'Recessed Lighting'],
      [/\bsmart thermostats?\b/i, 'Smart Thermostat'],
      [/\bsmart locks?\b/i, 'Smart Locks'],
      [/\bbuilt-?in shelv/i, 'Built-In Shelving'],
      [/\bpantry\b|\bpantries\b/i, 'Pantry'],
      [/\bkitchen islands?\b/i, 'Kitchen Island'],
      [/\bbreakfast bars?\b/i, 'Breakfast Bar'],
      [/\bstainless steel\b/i, 'Stainless Steel Appliances'],
      [/\bdouble vanity\b|\bdouble vanities\b/i, 'Double Vanity'],
      [/\bsoaking tubs?\b/i, 'Soaking Tub'],
      [/\bwalk-?in showers?\b/i, 'Walk-In Shower'],
      [/\bseparate tubs?\b/i, 'Separate Tub/Shower'],
      [/\blinen closets?\b/i, 'Linen Closet'],
      [/\bstorage units?\b/i, 'Storage Unit'],
      [/\bblinds\b/i, 'Window Blinds'],
      [/\bblackout curtains?\b/i, 'Blackout Curtains'],
    ],
    outdoor: [
      [/\bbalcony\b|\bbalconies\b/i, 'Balcony'],
      [/\bpatios?\b/i, 'Patio'],
      [/\bdecks?\b/i, 'Deck'],
      [/\bporch(?:es)?\b/i, 'Porch'],
      [/\bscreened porch(?:es)?\b/i, 'Screened Porch'],
      [/\bsunrooms?\b/i, 'Sunroom'],
      [/\brooftops?\b/i, 'Rooftop'],
      [/\bcourtyards?\b/i, 'Courtyard'],
      [/\blanais?\b/i, 'Lanai'],
    ],
    exteriorFeatures: [
      [/\bfenced yards?\b|\bprivacy fences?\b/i, 'Fenced Yard'],
      [/\bsprinklers?\b/i, 'Sprinkler System'],
      [/\boutdoor lighting\b/i, 'Outdoor Lighting'],
      [/\boutdoor kitchens?\b|\bbbq\b/i, 'Outdoor Kitchen/BBQ'],
      [/\bfire pits?\b/i, 'Fire Pit'],
      [/\bgardens?\b/i, 'Garden Space'],
      [/\bsheds?\b/i, 'Shed/Outbuilding'],
      [/\brv parking\b/i, 'RV Parking'],
      [/\bboat parking\b/i, 'Boat Parking'],
      [/\bev charg|\belectric vehicle charg/i, 'EV Charging'],
      [/\bgated\b/i, 'Gated Entry'],
      [/\bdesert landscap|\bxeriscap/i, 'Desert Landscaping'],
      [/\bpool fences?\b/i, 'Pool Fence'],
    ],
    communityAmenities: [
      [/\bgyms?\b|\bfitness (?:center|room|studio|facility)s?\b/i, 'Gym/Fitness Center'],
      [/\byoga\b|\bpilates\b/i, 'Yoga/Pilates Studio'],
      [/\bclubhouses?\b/i, 'Clubhouse'],
      [/\bbusiness centers?\b/i, 'Business Center'],
      [/\bco-?working\b/i, 'Co-Working Space'],
      [/\bpackage lockers?\b/i, 'Package Lockers'],
      [/\bbike storage\b|\bbicycle storage\b/i, 'Bike Storage'],
      [/\bbbq\b|\bgrill areas?\b/i, 'BBQ/Grill Area'],
      [/\bdog parks?\b/i, 'Dog Park'],
      [/\bpet wash/i, 'Pet Washing Station'],
      [/\bplaygrounds?\b/i, 'Playground'],
      [/\btennis courts?\b/i, 'Tennis Court'],
      [/\bbasketball courts?\b/i, 'Basketball Court'],
      [/\bvolleyball\b/i, 'Volleyball Court'],
      [/\bpickleball\b/i, 'Pickleball Court'],
      [/\bputting greens?\b/i, 'Putting Green'],
      [/\bswimming pools?\b|\bcommunity pools?\b/i, 'Swimming Pool'],
      [/\bcommunity (?:spa|hot tub)s?\b/i, 'Community Spa/Hot Tub'],
      [/\bsaunas?\b/i, 'Sauna'],
      [/\bgame rooms?\b/i, 'Game Room'],
      [/\btheaters?\b|\bscreening rooms?\b/i, 'Theater/Screening Room'],
      [/\brooftop lounges?\b/i, 'Rooftop Lounge'],
      [/\bcoffee bars?\b/i, 'Coffee Bar'],
      [/\bcar wash\b/i, 'Car Wash'],
      [/\bon-?site laundry\b|\blaundry rooms?\b/i, 'On-Site Laundry'],
      [/\btrash valet\b|\bvalet trash\b/i, 'Trash Valet'],
      [/\bcontrolled access\b|\bgated access\b/i, 'Controlled Access/Gated'],
      [/\bkey cards?\b|\bfob entry\b/i, 'Key Card Entry'],
      [/\belevators?\b/i, 'Elevator'],
      [/\bconcierge services?\b|\b24[- ]hour concierge\b|\b24\/7 concierge\b|\bon-site concierge\b|\bdoorm[ae]n\b|\bfront desk\b/i, 'Concierge/Doorman'],
      [/\bon-?site management\b/i, 'On-Site Management'],
      [/\bon-?site maintenance\b/i, 'On-Site Maintenance'],
      [/\bcommunity wifi\b|\bwi-?fi lounge\b/i, 'Community WiFi'],
    ],
    utilitiesIncluded: [
      [/(?<!hot )\bwater included\b/i, 'Water'],
      [/\bhot water included\b/i, 'Hot Water'],
      [/\bgas included\b/i, 'Gas'],
      [/\belectric included\b|\belectricity included\b/i, 'Electric'],
      [/\btrash included\b/i, 'Trash'],
      [/\bsewer included\b/i, 'Sewer'],
      [/\brecycling included\b/i, 'Recycling'],
      [/\binternet included\b|\bwifi included\b/i, 'Internet/WiFi'],
      [/\bcable (?:tv )?included\b/i, 'Cable TV'],
      [/\blandscaping included\b/i, 'Landscaping/Grounds'],
      [/\bpest control included\b/i, 'Pest Control'],
    ],
    safetyFeatures: [
      [/\bsmoke detectors?\b/i, 'Smoke Detectors'],
      [/\bcarbon monoxide\b/i, 'Carbon Monoxide Detectors'],
      [/\bfire extinguishers?\b/i, 'Fire Extinguisher'],
      [/\bfire sprinklers?\b/i, 'Fire Sprinklers'],
      [/\bsecurity systems?\b|\balarm systems?\b/i, 'Security System/Alarm'],
      [/\bgated entry\b/i, 'Gated Entry'],
      [/\bdeadbolts?\b/i, 'Deadbolt Locks'],
      [/\bsmart locks?\b/i, 'Smart Locks'],
      [/\bsecurity cameras?\b/i, 'Security Cameras'],
      [/\bmotion sensors?\b/i, 'Motion Sensor Lights'],
      [/\bintercoms?\b/i, 'Intercom'],
      [/\b24-?hour security\b|\b24\/7 security\b/i, '24-Hour Security'],
    ],
    petsAllowed: [
      [/\bno pets\b|\bpets not allowed\b/i, 'No Pets'],
      [/\bcats? allowed\b/i, 'Cats Allowed'],
      [/\bdogs? allowed\b/i, 'Dogs Allowed'],
      [/\bcats? and dogs?\b|\bdogs? and cats?\b/i, 'Cats Allowed', 'Dogs Allowed'],
      [/\bpets? (?:allowed|welcome|friendly|ok\b|okay)/i, 'Cats Allowed', 'Dogs Allowed'],
      [/\bsmall dogs? only\b/i, 'Small Dogs Only'],
    ],
  };

  // True when the regex hits somewhere not preceded by "no"/"not"/"without".
  function affirmedMatch(re, text, skipNegation) {
    if (skipNegation) return re.test(text);
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      if (!/(?:^|[^a-z0-9])(?:no|not|without|non)[\s-]+$/i.test(text.slice(Math.max(0, m.index - 10), m.index))) return true;
      if (m.index === g.lastIndex) g.lastIndex++;
    }
    return false;
  }

  function matchAmenities(text) {
    if (!text) return {};
    const out = {};
    for (const field in AMENITY_PATTERNS) {
      const hits = [];
      for (const entry of AMENITY_PATTERNS[field]) {
        const label = entry[1];
        if (affirmedMatch(entry[0], textForValue(label, text), NEGATIVE_VALUES.has(label))) {
          for (let i = 1; i < entry.length; i++) {
            if (!hits.includes(entry[i])) hits.push(entry[i]);
          }
        }
      }
      if (hits.length) out[field] = hits;
    }
    // "No Pets" overrides any positive pet entries
    if (out.petsAllowed && out.petsAllowed.includes('No Pets')) {
      out.petsAllowed = ['No Pets'];
    }
    return out;
  }

  // One row of a labeled amenity section ("Move-In Concierge", "Pool"): does this
  // regex match the row once the label's excluded phrases are gone?
  function rowMatches(re, label, row) {
    return affirmedMatch(re, textForValue(label, String(row == null ? '' : row)), NEGATIVE_VALUES.has(label));
  }

  const api = { AMENITY_SOURCE_TRIGGERS, AMENITY_TRIGGER_EXCLUSIONS, AMENITY_PATTERNS, valueInText, matchAmenities, rowMatches };
  root.RRAmenityMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
