// Content script injected into a VRBO listing page (Co-Hosting only).
// Grabs the listing title, beds/baths/guests, description, an amenity list,
// and the full page text. The service worker runs the same deterministic
// dictionary extractor over this text (as it does for Airbnb), and compares
// the result against the Airbnb listing to surface inconsistencies.
//
// This is GENERIC (innerText + JSON best-effort) so it needs no VRBO-specific
// selectors, and it is used ONLY for Co-Hosting imports — it never runs for
// Arbitrage comp/listing scrapes.

(function () {
  if (window.__rrVrboScraperRan) return;
  window.__rrVrboScraperRan = true;

  function extract() {
    const data = {
      source: 'vrbo',
      vrboUrl: location.href,
      title: null,
      description: null,
      amenities: [],
      guests: null,
      bedrooms: null,
      bathrooms: null,
      _fullPageText: null,
    };

    const body = document.body.innerText || '';

    // Title + description (og tags)
    try {
      const ogt = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
      data.title = ogt.replace(/\s*[-|–]\s*Vrbo.*$/i, '').replace(/\s*\|\s*Vrbo.*$/i, '').trim() || null;
      data.description = (document.querySelector('meta[property="og:description"]')?.content
        || document.querySelector('meta[name="description"]')?.content || '').trim() || null;
    } catch (_) {}

    // Beds / baths / guests from the listing summary text
    try {
      let m = body.match(/(\d+)\s*bedrooms?/i); if (m) data.bedrooms = parseInt(m[1], 10);
      m = body.match(/(\d+(?:\.\d+)?)\s*bathrooms?/i); if (m) data.bathrooms = parseFloat(m[1]);
      m = body.match(/sleeps\s*(\d+)/i) || body.match(/(\d+)\s*guests?/i); if (m) data.guests = parseInt(m[1], 10);
    } catch (_) {}

    // Amenities — scoped to the platform's amenities section. This list is the
    // SOLE source the cross-listing inconsistency comparison uses, so scope it
    // tightly (full page text wrongly pulled in safety warnings / house rules):
    //   • VRBO     → "Popular amenities"  (then "See all N amenities")
    //   • Booking  → "Amenities of <title>" / "Most popular amenities"
    //   • (generic "Property amenities" / "Amenities" as a last resort)
    try {
      // Prefer the most specific section header so we don't latch onto an
      // "Amenities" jump-link in the page nav that has no list after it.
      const ANCHORS = [
        /Amenities of\b/i, /Facilities of\b/i,
        /Most popular (?:amenities|facilities)/i,
        /Popular amenities/i, /Property amenities/i,
        /\bAmenities\b/i, /\bFacilities\b/i,
      ];
      let start = -1;
      for (let i = 0; i < ANCHORS.length; i++) { const p = body.search(ANCHORS[i]); if (p >= 0) { start = p; break; } }
      if (start >= 0) {
        const after = body.slice(start);
        const nl = after.indexOf('\n');
        const rest = nl >= 0 ? after.slice(nl + 1) : after;
        // Stop at the next major section so we don't swallow reviews/policies.
        const em = rest.search(/See all \d+ amenities|Show all amenities|See availability|House Rules|The fine print|Property surroundings|Guest reviews|Frequently asked|^Reviews\b|^Location\b|^Policies\b|About (?:the|this) (?:host|property|area)/im);
        const chunk = rest.slice(0, em >= 0 ? em : 2600);
        const seen = {}, uniq = [];
        chunk.split(/\n/).map(function (l) { return l.trim(); }).forEach(function (l) {
          if (l.length < 2 || l.length > 45 || !/[a-z]/i.test(l)) return;
          if (/^see all|^show all|^most popular|^popular\b|amenit|facilit/i.test(l)) return; // skip headers/buttons
          const k = l.toLowerCase();
          if (!seen[k]) { seen[k] = true; uniq.push(l); }
        });
        if (uniq.length) data.amenities = uniq.slice(0, 80);
      }
    } catch (_) {}

    // Full page text for the dictionary extractor + the comparison engine
    try { data._fullPageText = (document.body.innerText || '').slice(0, 20000); } catch (_) {}

    return data;
  }

  function run(attempt) {
    try {
      const data = extract();
      const hasAny = !!(data.title || data.bedrooms != null || (data._fullPageText && data._fullPageText.length > 500));
      if (hasAny || attempt >= 12) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 12) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(function () { run(attempt + 1); }, 800);
  }

  if (document.readyState === 'complete') setTimeout(function () { run(0); }, 600);
  else window.addEventListener('load', function () { setTimeout(function () { run(0); }, 600); }, { once: true });
})();
