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

  // v0.6.1: recursively flatten @graph arrays AND mainEntity / subjectOf /
  // itemReviewed containers so callers see every candidate real-estate
  // block as a top-level entry — regardless of how deeply the site nested
  // its schema.org wrappers. Apartments.com wraps units in:
  //   { @type: [Product, RealEstateListing], mainEntity: { @type: ApartmentComplex, numberOfBedrooms: 3, ... } }
  // Previously we only expanded @graph, so the beds/baths on the inner
  // mainEntity were never reached and every Apartments.com listing with
  // this wrapper silently dropped core numbers.
  function findAllJsonLd() {
    const blocks = [];
    const seen = new WeakSet();
    function push(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      if (Array.isArray(obj)) { obj.forEach(push); return; }
      blocks.push(obj);
      // Recurse into container fields that commonly wrap the real entity.
      if (obj['@graph']) push(obj['@graph']);
      if (obj.mainEntity) push(obj.mainEntity);
      if (obj.subjectOf) push(obj.subjectOf);
      if (obj.itemReviewed) push(obj.itemReviewed);
      if (obj.about) push(obj.about);
      // containsPlace is already handled by per-site parsers for unit lists,
      // but flattening it here makes the data available to anyone who just
      // iterates findAllJsonLd() output.
      if (Array.isArray(obj.containsPlace)) obj.containsPlace.forEach(push);
    }
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { push(JSON.parse(s.textContent)); } catch (_) {}
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
      _pageText: null,      // Tight description-only snippet (≤4KB) for the LLM
      _fullPageText: null,  // Broad cleaned main-content (≤20KB) for the dictionary regex pass
    };
  }

  // Capture a cleaned version of the page's visible text for Ollama.
  // Strips nav, footer, script, style, and header elements to focus on
  // the main listing content. Capped at ~20KB before send.
  // Best-effort: click any "Show more" / "See all amenities" disclosure
  // toggles in the live DOM before we clone it. Many listing sites collapse
  // long amenity lists behind a button, which means our cloned snapshot
  // would otherwise miss the bottom half of every list. We open them in
  // place — synchronously, no waiting — and revert nothing because the
  // reopen leaves the user's view unchanged when the page already loaded
  // the content into the DOM.
  function expandDisclosures() {
    try {
      const candidates = Array.from(document.querySelectorAll(
        'button, a, [role="button"], summary, [aria-expanded]'
      ));
      let opened = 0;
      for (const el of candidates) {
        if (opened > 40) break; // safety cap
        const t = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
        if (!t || t.length > 60) continue;
        if (!/show (more|all)|see (more|all)|view (more|all)|read more|expand|all amenities|all features/i.test(t)) continue;
        // Don't click anything that looks like a navigation link to a new page
        if (el.tagName === 'A' && el.href && !el.href.startsWith(location.origin + location.pathname)) continue;
        try {
          const wasExpanded = el.getAttribute('aria-expanded');
          if (wasExpanded === 'true') continue;
          el.click();
          opened++;
        } catch (_) {}
      }
      // <details> elements are toggled differently
      document.querySelectorAll('details:not([open])').forEach((d) => { try { d.open = true; } catch (_) {} });
    } catch (_) {}
  }

  // v0.6.0: capture a TIGHT, description-focused snippet (≤4KB) instead of
  // a 20KB main-content dump. Local LLM prompt-eval is ~150-300 tok/s on
  // qwen3:4b, so every 1KB of input adds 1-2 seconds of wall time. By
  // narrowing to the actual listing description / about / amenities blocks
  // we cut prompt-eval from 5-13s down to 1-3s. The dictionary regex pass
  // still operates on the FULL page text (it's sub-millisecond and benefits
  // from seeing everything), so this only affects what the LLM sees.
  //
  // We keep two separate strings on the scraper output:
  //   _pageText      — the tight LLM snippet (≤4KB, description-focused)
  //   _fullPageText  — the broad dictionary blob (≤20KB, regex amenity search)
  function captureFullPageText() {
    try {
      const main = document.querySelector('main, [role="main"], #main, .main, #content, .content') || document.body;
      const clone = main.cloneNode(true);
      clone.querySelectorAll('script, style, nav, footer, noscript, iframe, svg').forEach((n) => n.remove());
      clone.querySelectorAll(
        '[class*="similar"], [class*="Similar"], [class*="nearby"], [class*="Nearby"], ' +
        '[class*="recommend"], [class*="Recommend"], [class*="carousel"], [class*="Carousel"], ' +
        // Hotpads SEO footer: "Apartments for rent in...", "Townhomes for rent in..."
        // Wrapped in <article> not <footer>, so the nav/footer strip above misses it.
        '[class*="SeoFooter"], [class*="seoFooter"], [class*="seo-footer"]'
      ).forEach((n) => n.remove());
      // Strip "Pricing comparison" and "Nearby schools" sections — they
      // contain market-rate prices (e.g. "$1,499") and other noise that
      // confuses both the AI and the dictionary extractor.
      clone.querySelectorAll('article, section, div').forEach((el) => {
        const h = el.querySelector('h1, h2, h3, h4');
        if (h && /pricing comparison|nearby schools|find similar/i.test(h.textContent)) {
          el.remove();
        }
      });
      const txt = (clone.innerText || clone.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return txt.slice(0, 20000);
    } catch (e) {
      return (document.body.innerText || '').slice(0, 20000);
    }
  }

  // Pull a tight listing-focused snippet for the LLM. Targets:
  //   1. og:title / og:description / meta description (the "hero" — already
  //      contains beds/baths/price on Zillow + Apartments.com)
  //   2. h1 + h2 next to it (listing headline)
  //   3. The first matching "description" container — common selectors:
  //      [data-testid*="description"], [class*="description"], [class*="Description"],
  //      [class*="overview"], [class*="Overview"], [id*="description"],
  //      [class*="about"], [class*="About"], #description, .description.
  //      We take the LARGEST match (longest text content) so we don't grab a
  //      tiny "view description" link.
  //   4. The first matching "highlights" / "features" / "amenities" block.
  // All concatenated, deduped, capped at 4KB. If we can't find any of those
  // selectors (uncommon site / Craigslist), we fall back to the first
  // 4KB of meaningful main content.
  function captureListingSnippet() {
    try {
      expandDisclosures();

      const parts = [];
      const seen = new Set();
      const push = (label, text) => {
        if (!text) return;
        const t = String(text).replace(/\s+/g, ' ').trim();
        if (!t || t.length < 4) return;
        const key = t.slice(0, 200);
        if (seen.has(key)) return;
        seen.add(key);
        parts.push(label ? label + ': ' + t : t);
      };

      // 1) Hero (title + meta tags)
      const title = (document.querySelector('h1')?.innerText || document.title || '').trim();
      push('TITLE', title);
      push('OG_TITLE', document.querySelector('meta[property="og:title"]')?.content);
      push('OG_DESCRIPTION', document.querySelector('meta[property="og:description"]')?.content);
      push('META_DESCRIPTION', document.querySelector('meta[name="description"]')?.content);
      push('TWITTER_DESCRIPTION', document.querySelector('meta[name="twitter:description"]')?.content);

      // 2) Description blocks. Pick the LARGEST node that matches each
      //    pattern — we want the actual prose, not a tiny "View description" link.
      function biggest(selector) {
        const nodes = document.querySelectorAll(selector);
        let best = null;
        let bestLen = 0;
        for (const n of nodes) {
          const txt = (n.innerText || n.textContent || '').trim();
          if (txt.length > bestLen && txt.length < 8000) { // skip giant containers
            best = txt;
            bestLen = txt.length;
          }
        }
        return best;
      }

      push('DESCRIPTION', biggest(
        '[data-testid*="description" i], [data-test*="description" i], ' +
        '[class*="description" i]:not([class*="similar" i]):not([class*="nearby" i]), ' +
        '[id*="description" i], #description, .description, ' +
        '[class*="about-this" i], [class*="aboutThis" i], [data-testid*="about" i]'
      ));
      push('OVERVIEW', biggest(
        '[data-testid*="overview" i], [class*="overview" i], [class*="Overview"], #overview'
      ));
      push('HIGHLIGHTS', biggest(
        '[data-testid*="highlight" i], [class*="highlight" i], [class*="Highlight"]'
      ));
      push('FEATURES', biggest(
        '[data-testid*="features" i], [class*="features" i]:not([class*="similar" i]):not([class*="nearby" i]), [class*="Features"]'
      ));
      push('AMENITIES', biggest(
        '[data-testid*="amenit" i], [class*="amenit" i]:not([class*="similar" i]), [class*="Amenit"]'
      ));
      push('NEIGHBORHOOD', biggest(
        '[data-testid*="neighborhood" i], [class*="neighborhood" i], [class*="Neighborhood"]'
      ));

      // 3) Stats block (beds/baths/sqft on Zillow lives in a header summary)
      push('STATS', biggest(
        '[data-testid*="bed-bath" i], [data-testid*="facts" i], [class*="summary" i]:not([class*="similar" i]), [class*="Summary"]:not([class*="similar" i])'
      ));

      let snippet = parts.join('\n\n');

      // Fallback: if we got almost nothing, fall back to the first 4KB of
      // cleaned main content. This catches Craigslist and other unsupported
      // sites that don't use any of the standard description selectors.
      if (snippet.length < 400) {
        const main = document.querySelector('main, [role="main"], #main, .main, #content, .content') || document.body;
        const clone = main.cloneNode(true);
        clone.querySelectorAll('script, style, nav, footer, noscript, iframe, svg, header').forEach((n) => n.remove());
        clone.querySelectorAll(
          '[class*="similar" i], [class*="nearby" i], [class*="recommend" i], [class*="carousel" i]'
        ).forEach((n) => n.remove());
        const fallback = (clone.innerText || clone.textContent || '')
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        snippet = (snippet ? snippet + '\n\n---\n\n' : '') + fallback;
      }

      return snippet.slice(0, 4000);
    } catch (e) {
      return (document.body.innerText || '').slice(0, 4000);
    }
  }

  // Backwards-compat shim. The service worker still reads scraped._pageText.
  // We now point _pageText at the tight snippet and add _fullPageText for the
  // dictionary regex pass.
  function capturePageText() {
    return captureListingSnippet();
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

  // v0.6.2: Generic labeled-list extractor. Walks the DOM looking for a
  // heading (h1-h6, or any element with "header"/"label" in its class name)
  // whose visible text matches `labelRegex`, then collects the values from
  // the nearest descendant list (li / [class*=column] / [class*=Column]).
  // This rescues bare-value labeled blocks that the free-text dictionary
  // regexes miss — e.g. Apartments.com's "Utilities Included" section which
  // just lists "Water" under a heading, with no "included" verb anywhere on
  // the page. Returns an array of trimmed strings (may be empty).
  function extractLabeledList(labelRegex) {
    const items = [];
    const seen = new Set();
    const headingSel =
      'h1, h2, h3, h4, h5, h6, ' +
      '[class*="header"], [class*="Header"], [class*="label"], [class*="Label"]';
    const headings = document.querySelectorAll(headingSel);
    for (const h of headings) {
      const t = ((h.innerText || h.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!t || !labelRegex.test(t)) continue;
      // Walk up a few levels looking for a sibling/descendant list of values.
      let container = h.parentElement;
      for (let depth = 0; depth < 5 && container; depth++) {
        const cells = container.querySelectorAll(
          'li, [class*="column"]:not([class*="header"]), [class*="Column"]:not([class*="Header"])'
        );
        let foundAny = false;
        for (const c of cells) {
          // Skip cells that still contain the heading itself.
          if (c.contains(h)) continue;
          const v = ((c.innerText || c.textContent || '') + '').replace(/\s+/g, ' ').trim();
          if (!v || v.length > 80) continue;
          if (v.toLowerCase() === t.toLowerCase()) continue;
          if (seen.has(v)) continue;
          seen.add(v);
          items.push(v);
          foundAny = true;
        }
        if (foundAny) break;
        container = container.parentElement;
      }
    }
    return items;
  }

  // v0.6.3: Extract ALL labeled sections on the page. Returns an object
  // keyed by heading text, with each value a deduped array of cell values
  // under that heading. This is the comprehensive version of
  // extractLabeledList — instead of looking for one label, it grabs every
  // heading-with-list block on the page in a single pass. parseApartments
  // then routes each section's values to the correct pd field AND appends
  // them to the searchBlob so the existing dictionary regexes fire against
  // bare-value DOM content.
  function extractAllLabeledSections() {
    const sections = {};
    const headingSel =
      'h1, h2, h3, h4, h5, h6, ' +
      '[class*="header-column"], [class*="HeaderColumn"]';
    const headings = document.querySelectorAll(headingSel);
    for (const h of headings) {
      const t = ((h.innerText || h.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 60) continue;
      let container = h.parentElement;
      for (let depth = 0; depth < 5 && container; depth++) {
        const cells = container.querySelectorAll(
          'li, [class*="column"]:not([class*="header"]):not([class*="Header"])'
        );
        const found = [];
        for (const c of cells) {
          if (c.contains(h)) continue;
          const v = ((c.innerText || c.textContent || '') + '').replace(/\s+/g, ' ').trim();
          if (!v || v.length > 100) continue;
          if (v.toLowerCase() === t.toLowerCase()) continue;
          if (found.includes(v)) continue;
          found.push(v);
        }
        if (found.length) {
          sections[t] = (sections[t] || []).concat(found);
          break;
        }
        container = container.parentElement;
      }
    }
    return sections;
  }

  // v0.6.2: Normalize a raw utility label ("Water", "hot water", "electric",
  // "garbage", etc.) to the canonical value the CRM expects. Returns null if
  // the input doesn't match any known utility.
  function normalizeUtility(raw) {
    const s = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (/\bhot\s*water\b/.test(s)) return 'Hot Water';
    if (/\bwater\b/.test(s)) return 'Water';
    if (/\bsewer\b/.test(s)) return 'Sewer';
    if (/\btrash|garbage|refuse\b/.test(s)) return 'Trash';
    if (/\brecycl/.test(s)) return 'Recycling';
    if (/\belectric(ity)?\b/.test(s)) return 'Electric';
    if (/\bgas\b/.test(s)) return 'Gas';
    if (/\b(internet|wi-?fi|wifi)\b/.test(s)) return 'Internet/WiFi';
    if (/\bcable\b/.test(s)) return 'Cable TV';
    if (/\bheat\b/.test(s)) return 'Heat';
    if (/\bpest\b/.test(s)) return 'Pest Control';
    if (/\blandscap|grounds\b/.test(s)) return 'Landscaping/Grounds';
    return null;
  }

  // ---- shared structured-data helpers ------------------------------
  // Both Zillow and Hotpads are Zillow Group properties and share the same
  // listing-shape schema in their state blobs (the "gdp" object — short for
  // "Get Data Page", Zillow's internal name for it). Apartments.com is a
  // CoStar property and uses a different shape, but its __NEXT_DATA__ blob
  // also contains a fat object with most of the same fields under different
  // names. We score and map both with these helpers to keep parsers DRY.

  function gdpScore(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
    let score = 0;
    if (v.bedrooms != null) score += 3;
    if (v.bathrooms != null) score += 3;
    if (v.livingArea != null || v.livingAreaValue != null) score += 3;
    if (v.price != null) score += 2;
    if (v.streetAddress) score += 2;
    if (v.unitNumber || v.unit) score += 1;
    if (v.zipcode) score += 1;
    if (v.homeType) score += 1;
    if (v.yearBuilt != null) score += 1;
    if (v.resoFacts && typeof v.resoFacts === 'object') score += 5;
    if (v.atAGlanceFacts) score += 1;
    if (v.description) score += 1;
    if (v.hugePhotos || v.photos) score += 1;
    return score;
  }

  // Map a "gdp" object (Zillow / Hotpads listing blob) into the supplied
  // `out` (top-level scraped fields) and `pd` (propertyDetails). Mutates
  // both. Returns nothing. Safe to call with a partial gdp.
  function applyGdpToOut(gdp, out, pd) {
    if (!gdp || typeof gdp !== 'object') return;

    // Address — and CRITICALLY: pull the unit number out of the gdp blob
    // and append it to the street address with the "#" shorthand. Zillow's
    // gdp.streetAddress is just "2010 Ocean Ave" with the unit stored
    // separately in gdp.unitNumber / gdp.unit / gdp.address.unitNumber.
    // If we don't include it here, the CRM's geocoder calls Google Places
    // with no unit reference, then falls back to defaulting the prefix to
    // "Unit" — which is wrong for any listing that uses #, Apt, Ste, etc.
    const streetAddress = gdp.streetAddress || (gdp.address && gdp.address.streetAddress);
    const unitNumber = gdp.unitNumber || gdp.unit
                    || (gdp.address && (gdp.address.unitNumber || gdp.address.unit))
                    || null;
    const city = gdp.city || (gdp.address && gdp.address.city);
    const state = gdp.state || (gdp.address && gdp.address.state);
    const zipcode = gdp.zipcode || (gdp.address && gdp.address.zipcode);
    if (!out.address && streetAddress) {
      // If the unit isn't already baked into streetAddress, append it as
      // "#<unit>" — that's the universal shorthand the CRM's prefix detector
      // recognizes and that matches how listing sites display the unit.
      let street = streetAddress;
      if (unitNumber && !/(#|\b(?:unit|ste|suite|apt|apartment|bldg|building)\b)/i.test(street)) {
        street = street.trim().replace(/,\s*$/, '') + ' #' + String(unitNumber).trim();
      }
      const cityState = [city, state].filter(Boolean).join(' ');
      const csz = [cityState, zipcode].filter(Boolean).join(' ').trim();
      out.address = [street, csz].filter(Boolean).join(', ');
    }

    // Price / beds / baths / sqft / description / photo
    if (out.price == null) {
      out.price = num(gdp.price) || num(gdp.rentZestimate) || num(gdp.zestimate)
                || num(gdp.askingPrice) || num(gdp.monthlyRent);
    }
    if (out.bedrooms == null) out.bedrooms = num(gdp.bedrooms);
    if (out.bathrooms == null) out.bathrooms = num(gdp.bathrooms);
    if (out.sqft == null) out.sqft = num(gdp.livingArea) || num(gdp.livingAreaValue) || num(gdp.area);
    if (!out.description && gdp.description) out.description = String(gdp.description).slice(0, 2000);
    if (!out.photoUrl) {
      out.photoUrl = (gdp.hugePhotos && gdp.hugePhotos[0] && gdp.hugePhotos[0].url) ||
                     (gdp.photos && gdp.photos[0] && (gdp.photos[0].url || gdp.photos[0].href)) || null;
    }

    // Property type
    if (gdp.homeType && !pd.propertyType) {
      const typeMap = {
        SINGLE_FAMILY: 'House', CONDO: 'Condo', TOWNHOUSE: 'Townhouse',
        MULTI_FAMILY: 'Duplex', APARTMENT: 'Apartment', MANUFACTURED: 'Mobile Home',
        LOT: 'Other',
      };
      setPD(pd, 'propertyType', typeMap[gdp.homeType] || 'House');
    }
    if (gdp.yearBuilt != null) setPD(pd, 'yearBuilt', num(gdp.yearBuilt));
    if (gdp.lotSize || gdp.lotAreaValue) {
      const val = gdp.lotAreaValue || gdp.lotSize;
      const unit = gdp.lotAreaUnits || 'sqft';
      setPD(pd, 'lotSize', val + ' ' + unit);
    }
    if (gdp.hoaFee || gdp.monthlyHoaFee) {
      setPD(pd, 'hoaFee', num(gdp.hoaFee) || num(gdp.monthlyHoaFee));
    }

    // Days on market / market context (informational only — useful for
    // STR investor analysis later but not part of the structured form)
    if (gdp.daysOnZillow != null) setPD(pd, 'daysOnMarket', num(gdp.daysOnZillow));
    if (gdp.timeOnZillow) setPD(pd, 'timeOnMarket', String(gdp.timeOnZillow));

    // resoFacts has the rich structured amenity data
    const rf = gdp.resoFacts || {};

    if (rf.stories != null) {
      const s = num(rf.stories);
      if (s != null) setPD(pd, 'stories', s >= 4 ? '4+' : String(s));
    }

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

    if (Array.isArray(rf.laundryFeatures) && rf.laundryFeatures.length) {
      const s = rf.laundryFeatures.join(' ');
      if (/in.?unit|in the unit/i.test(s)) setPD(pd, 'laundry', 'In-Unit W/D');
      else if (/hookup/i.test(s)) setPD(pd, 'laundry', 'W/D Hookups');
      else if (/shared|common/i.test(s)) setPD(pd, 'laundry', 'Shared/On-Site');
      else if (/stacked/i.test(s)) setPD(pd, 'laundry', 'Stacked W/D');
      else if (/none/i.test(s)) setPD(pd, 'laundry', 'None');
    }

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

    if (rf.petsAllowed != null) {
      const s = Array.isArray(rf.petsAllowed) ? rf.petsAllowed.join(' ') : String(rf.petsAllowed);
      if (/no pets|^no$/i.test(s)) setPD(pd, 'petsAllowed', ['No Pets']);
      else {
        const pets = [];
        if (/cat/i.test(s)) pets.push('Cats Allowed');
        if (/dog/i.test(s)) pets.push('Dogs Allowed');
        if (!pets.length && /yes|allowed|all|ok/i.test(s)) { pets.push('Cats Allowed'); pets.push('Dogs Allowed'); }
        if (pets.length) setPD(pd, 'petsAllowed', pets);
      }
    }

    // Furnished status — useful STR/short-term-rental signal
    if (rf.furnished === true || /furnished/i.test(rf.furnished || '')) {
      setPD(pd, 'furnished', 'Furnished');
    } else if (rf.furnished === false) {
      setPD(pd, 'furnished', 'Unfurnished');
    }

    // View — Zillow exposes a `view` array on resoFacts
    if (Array.isArray(rf.view) && rf.view.length) {
      const v = rf.view.join(' ').toLowerCase();
      const views = [];
      if (/water|ocean|lake|river|bay/.test(v)) views.push('Water View');
      if (/mountain/.test(v)) views.push('Mountain View');
      if (/city|skyline/.test(v)) views.push('City View');
      if (/park/.test(v)) views.push('Park View');
      if (views.length) setPD(pd, 'views', views);
    }

    // HOA fee includes
    if (rf.associationFeeIncludes && Array.isArray(rf.associationFeeIncludes)) {
      const inc = rf.associationFeeIncludes.join(' ').toLowerCase();
      const items = [];
      if (/water/.test(inc)) items.push('Water');
      if (/sewer/.test(inc)) items.push('Sewer');
      if (/trash|garbage/.test(inc)) items.push('Trash');
      if (/gas/.test(inc)) items.push('Gas');
      if (/electric/.test(inc)) items.push('Electric');
      if (/internet|cable/.test(inc)) items.push('Internet/Cable');
      if (items.length) setPD(pd, 'hoaIncludes', items);
    }

    // Sweep the long-form feature lists with the dictionary
    const amenityBlob = flattenToText([
      rf.interiorFeatures, rf.exteriorFeatures, rf.communityFeatures,
      rf.poolFeatures, rf.lotFeatures, rf.atAGlanceFacts, rf.amenities,
      gdp.description,
    ]).join(' ').toLowerCase();
    const dictMatches = matchAmenities(amenityBlob);
    for (const k in dictMatches) {
      if (pd[k]) {
        const merged = Array.from(new Set((Array.isArray(pd[k]) ? pd[k] : []).concat(dictMatches[k])));
        pd[k] = merged;
      } else {
        pd[k] = dictMatches[k];
      }
    }
  }

  // Walk window-level state caches that Next.js / Apollo / Redux apps stash
  // listing data in. Returns an array of root objects to feed deepFindBest.
  function collectStateBlobs() {
    const roots = [];
    const nd = findJsonFromScript('__NEXT_DATA__');
    if (nd) roots.push(nd);
    const apolloEl = document.getElementById('hdpApolloPreloadedData');
    if (apolloEl) {
      try {
        const raw = apolloEl.textContent.trim().replace(/^<!--/, '').replace(/-->$/, '').trim();
        roots.push(JSON.parse(raw));
      } catch (_) {}
    }
    // Hotpads / some apartments pages stash state in inline scripts that
    // assign to window.__INITIAL_STATE__ or window.__data
    document.querySelectorAll('script:not([src])').forEach((s) => {
      const txt = s.textContent || '';
      if (txt.length < 200 || txt.length > 2000000) return;
      // Find the assignment, then extract the JSON from "= {" to the end.
      // The old regex-based approach (\{[\s\S]+?\}) was broken for large
      // JSON blobs — the lazy quantifier stopped at the first "}" that
      // matched the optional trailing pattern, truncating the JSON.
      const stateVarMatch = txt.match(/window\.__(?:INITIAL_STATE|PRELOADED_STATE|APP_STATE|data)__\s*=\s*\{/);
      if (stateVarMatch) {
        const braceIdx = txt.indexOf('{', stateVarMatch.index);
        if (braceIdx >= 0) {
          let jsonStr = txt.substring(braceIdx).trim();
          // Strip trailing semicolons and whitespace
          jsonStr = jsonStr.replace(/\s*;?\s*$/, '');
          try { roots.push(JSON.parse(jsonStr)); } catch (_) {}
        }
      }
      // Hotpads in particular often does:  HotPads.serverState = {...}
      const hpMatch = txt.match(/HotPads\.(?:serverState|preloadedState)\s*=\s*\{/);
      if (hpMatch) {
        const braceIdx = txt.indexOf('{', hpMatch.index);
        if (braceIdx >= 0) {
          let jsonStr = txt.substring(braceIdx).trim();
          jsonStr = jsonStr.replace(/\s*;?\s*$/, '');
          try { roots.push(JSON.parse(jsonStr)); } catch (_) {}
        }
      }
    });
    return roots;
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
    const candidates = collectStateBlobs();
    log('state blobs found', candidates.length);
    let gdp = null;
    for (const root of candidates) {
      const hit = deepFindBest(root, gdpScore);
      if (hit && gdpScore(hit) > gdpScore(gdp)) gdp = hit;
    }
    if (gdp) {
      log('gdp found', { score: gdpScore(gdp), keys: Object.keys(gdp).slice(0, 20) });
    } else {
      log('gdp NOT found');
    }

    if (gdp) {
      applyGdpToOut(gdp, out, out.propertyDetails);
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

    // NOTE: beds/baths are NO LONGER extracted via body-text regex here.
    // That approach hits "3 bed" strings inside "similar listings" widgets
    // and nearby-home carousels, poisoning the numbers. Ollama sees the
    // full page text downstream and extracts the authoritative values.
    // We still allow price/sqft body fallback as a convenience.
    if (out.sqft == null || out.price == null) {
      const body = document.body.innerText || '';
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

    // Sanity-guard beds/baths (same rules as Apartments)
    if (out.bedrooms != null && (out.bedrooms < 0 || out.bedrooms > 20)) out.bedrooms = null;
    if (out.bathrooms != null && (out.bathrooms <= 0 || out.bathrooms > 15)) out.bathrooms = null;

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

    // ---- Pass 0: __NEXT_DATA__ / state blobs ----
    // Apartments.com is a CoStar product (not Next.js across the board), but
    // newer property pages do ship a Next.js bundle that includes a state
    // blob with the listing under various keys. We try the same scoring
    // function we use for Zillow/Hotpads — if a fat listing object is in
    // there, this is the highest-fidelity source. If not, we fall through
    // to the JSON-LD pass below, which has been the workhorse to date.
    try {
      const blobs = collectStateBlobs();
      if (blobs.length) {
        log('state blobs', blobs.length);

        // ---- Hotpads-specific: extract directly from known state paths ----
        // Hotpads __PRELOADED_STATE__ has a well-defined structure. Extract
        // price, beds, baths, sqft, address from known paths FIRST before
        // falling back to the generic gdpScore scorer (which often picks
        // the wrong object like the search filter).
        for (const root of blobs) {
          const cl = root.currentListingDetails?.currentListing;
          if (cl) {
            log('hotpads currentListing found');
            // Price — ALWAYS from modelsAndPricing, never from comparison
            if (out.price == null && cl.modelsAndPricing && cl.modelsAndPricing.length) {
              out.price = num(cl.modelsAndPricing[0].lowPrice) || num(cl.modelsAndPricing[0].highPrice);
              if (out.price) log('price from hotpads state', out.price);
            }
            if (out.bedrooms == null) out.bedrooms = num(cl.beds);
            if (out.bathrooms == null) out.bathrooms = num(cl.baths);
            if (out.sqft == null) out.sqft = num(cl.sqft);
            if (!out.title && cl.displayAddress) out.title = String(cl.displayAddress).slice(0, 300);
            if (!out.description && cl.description) out.description = String(cl.description).slice(0, 2000);
            // Address
            if (!out.address) {
              const addr = cl.address;
              if (addr && typeof addr === 'object') {
                const parts = [addr.streetAddress, addr.city, addr.state, addr.zipcode].filter(Boolean);
                if (parts.length >= 2) out.address = parts.join(', ');
              }
            }
            break; // found the listing, stop
          }
        }

        // Generic gdpScore fallback for non-Hotpads sites
        let gdp = null;
        for (const root of blobs) {
          const hit = deepFindBest(root, gdpScore);
          if (hit && gdpScore(hit) > gdpScore(gdp)) gdp = hit;
        }
        if (gdp) {
          log('apartments gdp', { score: gdpScore(gdp), keys: Object.keys(gdp).slice(0, 20) });
          applyGdpToOut(gdp, out, pd);
        }
      }
    } catch (e) { log('state-blob pass error: ' + e.message); }

    // ---- Pass 1: JSON-LD (most reliable when it's present) ----
    const jsonLd = findAllJsonLd();
    log('jsonLd blocks', jsonLd.length);
    // Flatten any @graph arrays AND unwrap nested `about` objects so we
    // can iterate uniformly. Hotpads wraps listings as
    //   { @type: "ItemPage", about: { @type: "Product", offers: {…} } }
    // — without unwrapping, the price in `about.offers` is missed.
    const ldBlocks = [];
    jsonLd.forEach((b) => {
      if (!b || typeof b !== 'object') return;
      if (Array.isArray(b['@graph'])) ldBlocks.push(...b['@graph']);
      else ldBlocks.push(b);
    });
    // Second pass: unwrap `about` and `mainEntity` nested objects
    const extras = [];
    ldBlocks.forEach((b) => {
      if (b.about && typeof b.about === 'object') extras.push(b.about);
      if (b.mainEntity && typeof b.mainEntity === 'object') extras.push(b.mainEntity);
    });
    ldBlocks.push(...extras);
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
      // Beds/baths/sqft — IMPORTANT: do NOT fall back to numberOfRooms.
      // In schema.org, numberOfRooms is total rooms (living + kitchen + beds),
      // not bedroom count. Using it as a bedroom fallback caused 1-bed units
      // to be reported as "3 beds".
      if (out.bedrooms == null && block.numberOfBedrooms != null) out.bedrooms = num(block.numberOfBedrooms);
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

    // NOTE: Previously this block ran regex-based bed/bath extraction
    // against DOM containers and whole-page text. That approach kept
    // mis-reading "nearby listings" widgets and reporting the wrong
    // unit's beds/baths. Now Ollama extracts beds/baths/sqft from the
    // captured page text downstream, and we only attempt simple sqft /
    // price fallbacks here from clearly-scoped hero containers.
    if (out.price == null || out.sqft == null) {
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
        if (out.sqft == null) out.sqft = num(t.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i)?.[1]);
      });
      log('after DOM containers', { sqft: out.sqft, price: out.price });
    }

    // ---- Hotpads / Zillow hero price extraction ----
    // Hotpads structure: .Hdp-listing-container has the h1 (address) and
    // a sibling div containing "$2,499" + "1Bed 1Bath 750Sqft". The price
    // element is a leaf div whose ONLY text is "$X,XXX". We walk all
    // descendants of the hero container to find it.
    // This runs BEFORE the body-text fallback so we never accidentally
    // pick up the "Pricing comparison" market rate.
    if (out.price == null) {
      const heroContainer = document.querySelector('.Hdp-listing-container')
        || document.querySelector('[class*="ListingHero"], [class*="listing-hero"]');
      if (heroContainer) {
        // Walk all leaf-ish elements looking for a price-only text node
        const candidates = heroContainer.querySelectorAll('div, span, p');
        for (const el of candidates) {
          const t = (el.textContent || '').trim();
          if (/^\$\s*[\d,]+$/.test(t) && el.children.length === 0) {
            out.price = num(t.replace(/[^0-9]/g, ''));
            if (out.price) { log('price from hero container', out.price); break; }
          }
        }
      }
      // Generic fallback: walk h1 ancestor tree looking for a nearby price
      if (out.price == null) {
        const h1 = document.querySelector('h1');
        if (h1) {
          let ancestor = h1.parentElement;
          for (let depth = 0; depth < 3 && ancestor && !out.price; depth++) {
            ancestor = ancestor.parentElement;
            if (!ancestor) break;
            const leaves = ancestor.querySelectorAll('div, span, p');
            for (const el of leaves) {
              const t = (el.textContent || '').trim();
              if (/^\$\s*[\d,]+$/.test(t) && el.children.length === 0) {
                out.price = num(t.replace(/[^0-9]/g, ''));
                if (out.price) { log('price from h1 ancestor walk', out.price); break; }
              }
            }
          }
        }
      }
    }

    // Grab a cleaned page-text blob for the amenity sweep, availability
    // detection, and the last-resort price fallback below.
    const bodyText = (document.querySelector('main') || document.body).innerText || '';

    // Body-text price fallback REMOVED — too dangerous. Body text includes
    // "Pricing comparison" sections, market rates, deposit amounts, and
    // other dollar figures that are NOT the rent. Price must come from
    // structured data (state blob, JSON-LD, DOM hero block) or not at all.
    // if (out.price == null) { ... }

    // ---- Sanity guard: reject obviously-bogus beds/baths ----
    if (out.bedrooms != null && (out.bedrooms < 0 || out.bedrooms > 20)) {
      log('rejected bogus bedrooms ' + out.bedrooms); out.bedrooms = null;
    }
    if (out.bathrooms != null && (out.bathrooms <= 0 || out.bathrooms > 15)) {
      log('rejected bogus bathrooms ' + out.bathrooms); out.bathrooms = null;
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

    // v0.6.4: The searchBlob no longer includes labeled-section values.
    // v0.6.3 added ALL labeled values (with synthetic verbs) to searchBlob,
    // which caused false positives: navigation menus, footer links, and
    // "similar listings" carousels contain words like "parking", "pool",
    // "elevator" that fired dictionary regexes even when the LISTING didn't
    // have those features. Now: dictionary sweep runs ONLY on amenityNodes
    // + bodyText (scoped to the listing's actual content), and labeled-
    // section values are routed EXCLUSIVELY through section-aware
    // normalizers below. This eliminates false positives while still
    // capturing bare-value lists like "Water" under "Utilities Included".
    let labeledSections = {};
    try {
      labeledSections = extractAllLabeledSections();
      log('labeled sections', Object.keys(labeledSections));
    } catch (e) { log('labeled section sweep error', String(e && e.message || e)); }

    const searchBlob = (amenityBlob + ' ' + bodyText).toLowerCase();
    const dictMatches = matchAmenities(searchBlob);
    for (const k in dictMatches) pd[k] = dictMatches[k];
    log('dict match keys', Object.keys(dictMatches));

    // v0.6.3: Section-specific routing. For headings we can identify with
    // high confidence, route values DIRECTLY to the right pd array,
    // bypassing the free-text dictionary entirely. This guarantees bare
    // "Water" under "Utilities Included" lands in pd.utilitiesIncluded
    // and bare "Pool" under "Community Amenities" lands in
    // pd.communityAmenities, regardless of what AMENITY_PATTERNS says.
    try {
      const addValues = (field, values) => {
        if (!values || !values.length) return;
        const existing = Array.isArray(pd[field]) ? pd[field].slice() : [];
        for (const v of values) if (v && !existing.includes(v)) existing.push(v);
        if (existing.length) pd[field] = existing;
      };

      for (const heading in labeledSections) {
        const values = labeledSections[heading];
        if (!values || !values.length) continue;

        // Utilities Included
        if (/^utilities?\s+included$/i.test(heading) || /^utilities?$/i.test(heading)) {
          addValues('utilitiesIncluded', values.map(normalizeUtility).filter(Boolean));
        }

        // Apartment / Unit features → ac, laundry, appliances, interior
        if (/apartment features|unit features|interior features|^features$/i.test(heading)) {
          const norm = values.map(v => String(v).toLowerCase());
          // A/C
          if (norm.some(v => /\bair.?condition/.test(v))) setPD(pd, 'ac', pd.ac || 'Central A/C');
          if (norm.some(v => /\bwindow unit/.test(v))) setPD(pd, 'ac', 'Window Unit');
          if (norm.some(v => /\bmini.?split/.test(v))) setPD(pd, 'ac', 'Mini-Split');
          if (norm.some(v => /\bcentral air|central a\/c/.test(v))) setPD(pd, 'ac', 'Central A/C');
          // Laundry
          if (norm.some(v => /washer.*dryer.*(unit|in-?unit)|w\/d in unit/.test(v))) setPD(pd, 'laundry', 'In-Unit W/D');
          if (norm.some(v => /w\/d hookup|washer.*dryer hookup/.test(v))) setPD(pd, 'laundry', pd.laundry || 'W/D Hookups');
          // Heating
          if (norm.some(v => /\bheat(ing)?\b/.test(v))) setPD(pd, 'heating', pd.heating || 'Central (Gas)');
          // Flooring
          if (norm.some(v => /\bhardwood\b/.test(v))) setPD(pd, 'flooring', 'Hardwood');
          else if (norm.some(v => /\btile\b/.test(v))) setPD(pd, 'flooring', 'Tile');
          else if (norm.some(v => /\bcarpet\b/.test(v))) setPD(pd, 'flooring', 'Carpet');
          else if (norm.some(v => /\bvinyl\b/.test(v))) setPD(pd, 'flooring', 'Vinyl Plank');
          else if (norm.some(v => /\blaminate\b/.test(v))) setPD(pd, 'flooring', 'Laminate');
          // Appliances (multi-select)
          const appMap = [
            [/dishwasher/, 'Dishwasher'],
            [/microwave/, 'Microwave'],
            [/refrigerator|fridge/, 'Refrigerator'],
            [/garbage disposal|disposal/, 'Garbage Disposal'],
            [/oven|range|stove/, 'Oven/Range (Electric)'],
            [/ice maker/, 'Ice Maker'],
          ];
          const apps = [];
          for (const v of norm) {
            for (const [re, label] of appMap) {
              if (re.test(v) && !apps.includes(label)) apps.push(label);
            }
          }
          addValues('appliances', apps);
          // Interior features (multi-select)
          const intMap = [
            [/ceiling fan/, 'Ceiling Fans'],
            [/walk-?in closet/, 'Walk-In Closets'],
            [/high ceiling/, 'High Ceilings'],
            [/vaulted ceiling/, 'Vaulted Ceilings'],
            [/fireplace/, 'Fireplace'],
            [/granite|quartz countertop/, 'Stainless Steel Appliances'],
            [/stainless/, 'Stainless Steel Appliances'],
            [/kitchen island/, 'Kitchen Island'],
            [/pantry/, 'Pantry'],
            [/smart thermostat|nest thermostat/, 'Smart Thermostat'],
            [/recessed lighting/, 'Recessed Lighting'],
            [/crown molding/, 'Crown Molding'],
            [/breakfast bar/, 'Breakfast Bar'],
            [/blinds/, 'Window Blinds'],
          ];
          const ints = [];
          for (const v of norm) {
            for (const [re, label] of intMap) {
              if (re.test(v) && !ints.includes(label)) ints.push(label);
            }
          }
          addValues('interiorFeatures', ints);
          // Outdoor
          const outMap = [
            [/\bbalcony\b/, 'Balcony'],
            [/\bpatio\b/, 'Patio'],
            [/\bdeck\b/, 'Deck'],
            [/\bporch\b/, 'Porch'],
            [/\bsunroom\b/, 'Sunroom'],
          ];
          const outs = [];
          for (const v of norm) {
            for (const [re, label] of outMap) {
              if (re.test(v) && !outs.includes(label)) outs.push(label);
            }
          }
          addValues('outdoor', outs);
        }

        // Community amenities / building amenities
        if (/community (amenit|feature)|building (amenit|feature)|complex (amenit|feature)/i.test(heading)) {
          const norm = values.map(v => String(v).toLowerCase());
          const caMap = [
            [/fitness|gym/, 'Gym/Fitness Center'],
            [/clubhouse|community room/, 'Clubhouse'],
            [/business center/, 'Business Center'],
            [/package/, 'Package Lockers'],
            [/dog park|pet park/, 'Dog Park'],
            [/playground/, 'Playground'],
            [/swimming pool|\bpool\b/, 'Swimming Pool'],
            [/hot tub|spa/, 'Community Spa/Hot Tub'],
            [/sauna/, 'Sauna'],
            [/elevator/, 'Elevator'],
            [/concierge|doorman/, 'Concierge/Doorman'],
            [/on-?site management/, 'On-Site Management'],
            [/on-?site maintenance/, 'On-Site Maintenance'],
            [/bike storage/, 'Bike Storage'],
            [/bbq|grill/, 'BBQ/Grill Area'],
            [/rooftop/, 'Rooftop Lounge'],
            [/tennis/, 'Tennis Court'],
            [/pickleball/, 'Pickleball Court'],
            [/controlled access|gated/, 'Controlled Access/Gated'],
          ];
          const cas = [];
          for (const v of norm) {
            for (const [re, label] of caMap) {
              if (re.test(v) && !cas.includes(label)) cas.push(label);
            }
          }
          addValues('communityAmenities', cas);
        }

        // Fees and Policies → pets
        if (/fees?\s+and\s+polic|^pet polic|^pets?$/i.test(heading)) {
          const norm = values.map(v => String(v).toLowerCase());
          if (norm.some(v => /no pets/.test(v))) { setPD(pd, 'petsAllowed', ['No Pets']); }
          else {
            const pets = [];
            if (norm.some(v => /cats? allowed/.test(v))) pets.push('Cats Allowed');
            if (norm.some(v => /dogs? allowed/.test(v))) pets.push('Dogs Allowed');
            if (norm.some(v => /small dogs? only/.test(v))) pets.push('Small Dogs Only');
            if (pets.length) setPD(pd, 'petsAllowed', pets);
          }
        }
      }
    } catch (e) { log('section routing error', String(e && e.message || e)); }

    // Property type heuristic
    if (!pd.propertyType) {
      if (/condo/i.test(out.title || '')) setPD(pd, 'propertyType', 'Condo');
      else if (/townhouse|townhome/i.test(out.title || '')) setPD(pd, 'propertyType', 'Townhouse');
      else if (/house/i.test(out.title || '')) setPD(pd, 'propertyType', 'House');
      else setPD(pd, 'propertyType', 'Apartment');
    }

    // Pets (multi-select)
    if (/no pets|pets not allowed/i.test(searchBlob)) setPD(pd, 'petsAllowed', ['No Pets']);
    else {
      const pets = [];
      if (/cats? allowed/i.test(searchBlob)) pets.push('Cats Allowed');
      if (/dogs? allowed/i.test(searchBlob)) pets.push('Dogs Allowed');
      if (pets.length) setPD(pd, 'petsAllowed', pets);
    }

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

    // A/C — v0.6.3: also match bare "air conditioning" / "a/c" so the
    // Apartments.com "Apartment Features > Air Conditioning" list row
    // sets the field even when no "central"/"window"/"mini-split" qualifier
    // is present anywhere on the page.
    if (!pd.ac) {
      if (/central (a\/c|air)/i.test(searchBlob)) setPD(pd, 'ac', 'Central A/C');
      else if (/window unit/i.test(searchBlob)) setPD(pd, 'ac', 'Window Unit');
      else if (/mini.?split/i.test(searchBlob)) setPD(pd, 'ac', 'Mini-Split');
      else if (/\bair.?condition(ing|er|ed)?\b/i.test(searchBlob)) setPD(pd, 'ac', 'Central A/C');
      else if (/\ba\/c\b/i.test(searchBlob)) setPD(pd, 'ac', 'Central A/C');
    }

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
  // Hotpads is a Zillow Group property and serves a Next.js app whose
  // listing object lives in __NEXT_DATA__ (and sometimes in window.HotPads
  // .serverState). The structured object exposes essentially the same
  // shape as Zillow's gdp blob — bedrooms, bathrooms, price, sqft, address,
  // and a resoFacts sub-object — so we can use the same scoring + mapping
  // helpers we use for Zillow. The previous implementation only ran body-
  // text regexes, which missed every structured field and was the weakest
  // of all the parsers; this brings it up to parity with Zillow.
  function parseHotpads() {
    const out = base('hotpads');
    out._debug = { source: 'hotpads', url: location.href, steps: [] };
    const log = (msg, extra) => out._debug.steps.push(extra ? (msg + ': ' + JSON.stringify(extra).slice(0, 200)) : msg);

    out.title = document.querySelector('h1')?.textContent?.trim() || document.title;

    // ---- Pass 1: state-blob extraction (richest source) ----
    const candidates = collectStateBlobs();
    log('state blobs', candidates.length);

    // Hotpads-specific: extract directly from known __PRELOADED_STATE__
    // paths FIRST. The generic gdpScore picker is broken for Hotpads
    // because it selects the search-filter object instead of the listing.
    for (const root of candidates) {
      const cl = root.currentListingDetails?.currentListing;
      if (cl) {
        log('hotpads currentListing found');
        // Price — ALWAYS from modelsAndPricing, never from comparison data
        if (out.price == null && cl.modelsAndPricing && cl.modelsAndPricing.length) {
          out.price = num(cl.modelsAndPricing[0].lowPrice) || num(cl.modelsAndPricing[0].highPrice);
          if (out.price) log('price from hotpads state', out.price);
        }
        if (out.bedrooms == null) out.bedrooms = num(cl.beds);
        if (out.bathrooms == null) out.bathrooms = num(cl.baths);
        if (out.sqft == null) out.sqft = num(cl.sqft);
        if (!out.description && cl.description) out.description = String(cl.description).slice(0, 2000);
        break;
      }
    }

    // Generic gdpScore fallback
    let gdp = null;
    for (const root of candidates) {
      const hit = deepFindBest(root, gdpScore);
      if (hit && gdpScore(hit) > gdpScore(gdp)) gdp = hit;
    }
    if (gdp) {
      log('gdp found', { score: gdpScore(gdp), keys: Object.keys(gdp).slice(0, 20) });
      applyGdpToOut(gdp, out, out.propertyDetails);
    } else {
      log('no gdp');
    }

    // Address strategy (in priority order):
    //   0) state-blob gdp (already applied above)
    //   1) JSON-LD PostalAddress — most accurate when present
    //   2) DOM selectors for street + city/state/zip blocks, concatenated
    //   3) og:title / og:description
    //   4) document.title
    // The CRM's rrGeocodeAddress() then runs the resulting string through
    // Google Places Text Search, which fills in anything we missed — but
    // it NEEDS at minimum a street + city to disambiguate, so we do our
    // best to hand it a full address string before it gets there.
    let addr = out.address || null;

    // 1) JSON-LD PostalAddress
    if (!addr) try {
      const blocks = findAllJsonLd();
      for (const block of blocks) {
        const postal = deepFind(block, (o) =>
          o && typeof o === 'object' && (o['@type'] === 'PostalAddress' || o.streetAddress || o.addressLocality)
        );
        if (postal && (postal.streetAddress || postal.addressLocality)) {
          const street = postal.streetAddress || '';
          const city = postal.addressLocality || '';
          const region = postal.addressRegion || '';
          const zip = postal.postalCode || '';
          const csz = [city, region].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
          addr = [street, csz].filter((s) => s && s.trim()).join(', ').trim();
          if (addr) break;
        }
      }
    } catch (_) {}

    // 2) DOM: try to assemble "street, city, state zip" from Hotpads'
    //    separate address spans. The page ships the address split across
    //    multiple small elements; grabbing only the first one gave us the
    //    street fragment with no city/state/zip, which then made Places
    //    geocoding fail. We collect ALL address-ish spans and concatenate.
    if (!addr) {
      const addrNodes = Array.from(document.querySelectorAll(
        '[class*="address" i], [class*="Address" i], [class*="streetAddress" i], ' +
        '[class*="cityStateZip" i], [class*="CityStateZip" i], [data-test*="address" i]'
      ));
      const parts = [];
      for (const n of addrNodes) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 200) continue;
        // Dedupe — Hotpads renders the same text in multiple widgets
        if (!parts.some((p) => p === t || p.includes(t) || t.includes(p))) parts.push(t);
      }
      if (parts.length) {
        // Prefer a concatenation that looks like "street, city, ST zip"
        const combined = parts.join(', ').replace(/,\s*,/g, ',');
        if (/,\s*[A-Z]{2}\s*\d{5}/.test(combined) || parts.length >= 2) addr = combined;
        else addr = parts[0];
      }
    }

    // 3) og:title / og:description often include the city
    if (!addr || !/,\s*[A-Z]{2}/.test(addr || '')) {
      const og = document.querySelector('meta[property="og:title"]')?.content || '';
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      const candidate = [og, ogDesc].find((s) => /,\s*[A-Z]{2}/.test(s || ''));
      if (candidate) {
        // Pull the "street, city, ST zip" fragment out
        const m = candidate.match(/[\w\s.#\-]+,\s*[\w\s.\-]+,\s*[A-Z]{2}(?:\s*\d{5})?/);
        if (m) addr = m[0];
      }
    }

    // 4) document.title — Hotpads titles often read
    //    "123 Main St, Brooklyn, NY 11201 | Hotpads"
    if (!addr || !/,\s*[A-Z]{2}/.test(addr || '')) {
      const t = (document.title || '').split('|')[0].trim();
      if (/,\s*[A-Z]{2}/.test(t)) addr = t;
    }

    // v0.7.0: Unit-number rescue. The JSON-LD PostalAddress often omits the
    // unit (streetAddress: "70-25 Park Dr E" with no "#A"), but the h1 and
    // document.title DO include it ("70-25 Park Dr E #A", "...Apt A...").
    // If the address we extracted doesn't contain a unit pattern but the h1
    // or title does, splice it in before the first comma.
    if (addr) {
      const hasUnit = /(#|\b(?:Unit|Ste|Suite|Apt|Apartment|Bldg|Building)\b)\s*[A-Za-z0-9]/i.test(addr);
      if (!hasUnit) {
        const h1Text = document.querySelector('h1')?.textContent?.trim() || '';
        const titleText = (document.title || '').split('|')[0].trim();
        // Try h1 first (has "#A"), then document.title (has "Apt A")
        for (const src of [h1Text, titleText]) {
          const unitMatch = src.match(/(#\s*[A-Za-z0-9][\w-]*|\b(?:Unit|Ste|Suite|Apt|Apartment)\s+[A-Za-z0-9][\w-]*)/i);
          if (unitMatch) {
            const commaIdx = addr.indexOf(',');
            if (commaIdx > 0) {
              addr = addr.slice(0, commaIdx) + ' ' + unitMatch[1].trim() + addr.slice(commaIdx);
            } else {
              addr = addr + ' ' + unitMatch[1].trim();
            }
            log('unit rescued from ' + (src === h1Text ? 'h1' : 'title'), unitMatch[1]);
            break;
          }
        }
      }
    }

    out.address = addr || null;

    // ---- Pass 2: scoped DOM fallbacks for any field the state blob missed ----
    // v0.6.4: Hotpads no longer serves __NEXT_DATA__ or window.HotPads on
    // many listing pages, so the state-blob path often finds nothing. The
    // beds/baths/sqft/price are rendered in the listing header as stacked
    // elements: "1\nBed\n1\nBath\n750\nSqft" right next to the address
    // and price. We use the HERO BLOCK text (first ~500 chars around the
    // h1) to avoid pollution from "similar listings" carousels further
    // down. If no h1 region works, fall back to the first 600 chars of
    // body text which always contains the hero.
    const h1El = document.querySelector('h1');
    let heroText = '';
    if (h1El) {
      // Walk up to a reasonable container (3 levels) to capture siblings
      let heroContainer = h1El.parentElement;
      for (let i = 0; i < 3 && heroContainer; i++) {
        const t = (heroContainer.innerText || heroContainer.textContent || '');
        if (t.length > 200) { heroText = t.slice(0, 800); break; }
        heroContainer = heroContainer.parentElement;
      }
    }
    if (!heroText) heroText = (document.body.innerText || '').slice(0, 600);
    log('heroText length', heroText.length);

    if (out.bedrooms == null) {
      // Match "1\nBed" or "1 Bed" or "1 bed" or "1 BR" — scoped to hero
      const bedM = heroText.match(/(\d+)\s*(?:\n\s*)?(?:bed|br|bedroom)/i);
      if (bedM) { out.bedrooms = num(bedM[1]); log('beds from hero', out.bedrooms); }
    }
    if (out.bathrooms == null) {
      const bathM = heroText.match(/(\d+\.?\d*)\s*(?:\n\s*)?(?:bath|ba|bathroom)/i);
      if (bathM) { out.bathrooms = num(bathM[1]); log('baths from hero', out.bathrooms); }
    }
    if (out.sqft == null) {
      const sqftM = heroText.match(/([\d,]+)\s*(?:\n\s*)?(?:sq\s*ft|sqft)/i);
      if (sqftM) { out.sqft = num(sqftM[1]); log('sqft from hero', out.sqft); }
    }
    // Price fallback: use ONLY the hero container (.Hdp-listing-container)
    // which contains the actual rent next to beds/baths/sqft. NEVER use
    // generic [class*="price"] selectors — they match the "Pricing
    // comparison" section which shows the MARKET RATE, not the rent.
    // NEVER use heroText regex — it includes text from sections below
    // the listing header that contain the wrong price.
    if (out.price == null) {
      const hdpContainer = document.querySelector('.Hdp-listing-container');
      if (hdpContainer) {
        const leaves = hdpContainer.querySelectorAll('div, span, p');
        for (const el of leaves) {
          const t = (el.textContent || '').trim();
          if (/^\$\s*[\d,]+$/.test(t) && el.children.length === 0) {
            out.price = num(t.replace(/[^0-9]/g, ''));
            if (out.price) { log('price from Hdp hero', out.price); break; }
          }
        }
      }
    }
    // JSON-LD fallback (AggregateOffer.lowPrice)
    if (out.price == null) {
      try {
        const blocks = findAllJsonLd();
        for (const b of blocks) {
          const graph = b['@graph'] || [b];
          for (const node of graph) {
            const product = node.about || node.mainEntity || node;
            if (product && product.offers) {
              const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
              for (const o of offers) {
                const p = num(o.price) || num(o.lowPrice);
                if (p) { out.price = p; log('price from JSON-LD', p); break; }
              }
              if (out.price) break;
            }
          }
          if (out.price) break;
        }
      } catch (_) {}
    }
    if (!out.photoUrl) {
      out.photoUrl = document.querySelector('img[class*="photo"], img[class*="Photo"]')?.src
                  || document.querySelector('meta[property="og:image"]')?.content
                  || null;
    }

    // Sanity-guard beds/baths
    if (out.bedrooms != null && (out.bedrooms < 0 || out.bedrooms > 20)) out.bedrooms = null;
    if (out.bathrooms != null && (out.bathrooms <= 0 || out.bathrooms > 15)) out.bathrooms = null;

    // Amenity dictionary on body text — this is belt-and-suspenders:
    // applyGdpToOut() already swept the structured feature lists, but the
    // long-form description on the page often mentions amenities the
    // structured fields missed. We union with anything already populated
    // rather than overwriting.
    const bodyTextLower = (document.body.innerText || '').toLowerCase();
    const dictMatches = matchAmenities(bodyTextLower);
    for (const k in dictMatches) {
      if (out.propertyDetails[k]) {
        const merged = Array.from(new Set(
          (Array.isArray(out.propertyDetails[k]) ? out.propertyDetails[k] : []).concat(dictMatches[k])
        ));
        out.propertyDetails[k] = merged;
      } else {
        out.propertyDetails[k] = dictMatches[k];
      }
    }

    log('final', {
      hasAddress: !!out.address,
      beds: out.bedrooms, baths: out.bathrooms, sqft: out.sqft, price: out.price,
      pdKeys: Object.keys(out.propertyDetails).length,
    });
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

    // cats/dogs OK (multi-select)
    if (/no pets/i.test(attrText)) setPD(pd, 'petsAllowed', ['No Pets']);
    else {
      const pets = [];
      if (/cats are OK/i.test(attrText)) pets.push('Cats Allowed');
      if (/dogs are OK/i.test(attrText)) pets.push('Dogs Allowed');
      if (pets.length) setPD(pd, 'petsAllowed', pets);
    }

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

  // v0.6.0: 7 attempts × 400ms = 2.8s max polling. Most pages are
  // hydrated within 1s. Previous 12×750ms (9s) was a major contributor
  // to the "way too long" wall time.
  function run(attempt) {
    try {
      const data = parse();
      const cfc = coreFieldCount(data);
      // EARLY EXIT: if the per-site parser hit all 4 core fields,
      // there's nothing more to wait for — capture and send immediately.
      const hasAll = cfc >= 4;
      const hasEnough = cfc >= 2 || (cfc >= 1 && !!data.address);
      if (hasAll || hasEnough || attempt >= 7) {
        // v0.8.0: AI enrichment restored — capture page text for the
        // dictionary extractor and Ollama LLM pass.
        data._pageText = capturePageText();
        data._fullPageText = captureFullPageText();
        if (data._debug) {
          data._debug.finalAttempt = attempt;
          data._debug.finalCoreFieldCount = cfc;
        }
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 7) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 400);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 200);
  else window.addEventListener('load', () => setTimeout(() => run(0), 200), { once: true });
})();
