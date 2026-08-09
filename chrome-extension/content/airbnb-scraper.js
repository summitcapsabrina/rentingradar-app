// Content script injected into an Airbnb listing page.
// Extracts: guests, bedrooms, beds, bathrooms, and host name.
// Posts results back to the service worker via SCRAPE_RESULT.

(function () {
  if (window.__rrAirbnbScraperRan) return;
  window.__rrAirbnbScraperRan = true;

  function num(str) {
    if (str == null) return null;
    const m = String(str).replace(/[, ]/g, '').match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isNaN(n) ? null : n;
  }

  function extract() {
    const data = {
      guests: null,
      bedrooms: null,
      beds: null,
      bathrooms: null,
      host: null,
      airbnbUrl: location.href,
      // v1.16.0: Co-Hosting imports need full amenities/details, so we also
      // capture the listing title, description, amenity list, and page text.
      // These are populated best-effort and ignored by the comp-import path.
      title: null,
      description: null,
      amenities: [],
      _fullPageText: null,
      // v1.16.3: approximate listing coordinates (for reverse-geocoding a
      // street-level address) + precise rating. Additive; comps ignore these.
      lat: null,
      lng: null,
      rating: null,
    };

    const body = document.body.innerText || '';

    // ── Strategy 1: Structured summary line ──
    // Airbnb listings typically show a summary like:
    //   "X guests · Y bedrooms · Z beds · W baths"
    //   "X guests · Y bedroom · Z beds · W bath"
    //   "X guests · Studio · Z beds · W bath"
    // Also handles "X guest" (singular) and "X.5 baths"
    const summaryRe = /(\d+)\s*guests?\s*[·•\-]\s*(?:(\d+)\s*bedrooms?|studio)\s*[·•\-]\s*(\d+)\s*beds?\s*[·•\-]\s*(\d+(?:\.\d+)?)\s*baths?/i;
    const summaryMatch = body.match(summaryRe);
    if (summaryMatch) {
      data.guests = parseInt(summaryMatch[1], 10);
      data.bedrooms = summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0; // Studio = 0
      data.beds = parseInt(summaryMatch[3], 10);
      data.bathrooms = parseFloat(summaryMatch[4]);
    }

    // ── Strategy 2: Individual pattern fallbacks ──
    if (data.guests == null) {
      const m = body.match(/(\d+)\s*guests?/i);
      if (m) data.guests = parseInt(m[1], 10);
    }
    if (data.bedrooms == null) {
      const m = body.match(/(\d+)\s*bedrooms?/i);
      if (m) data.bedrooms = parseInt(m[1], 10);
      else if (/\bstudio\b/i.test(body)) data.bedrooms = 0;
    }
    if (data.beds == null) {
      const m = body.match(/(\d+)\s*beds?\b/i);
      if (m) data.beds = parseInt(m[1], 10);
    }
    if (data.bathrooms == null) {
      const m = body.match(/(\d+(?:\.\d+)?)\s*(?:baths?|bathrooms?)/i);
      if (m) data.bathrooms = parseFloat(m[1]);
    }

    // ── Strategy 3: JSON-LD / __NEXT_DATA__ extraction ──
    try {
      const scripts = document.querySelectorAll('script[type="application/json"], script[id="__NEXT_DATA__"]');
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent);
          const str = JSON.stringify(json);

          // Look for personCapacity / guestCapacity
          if (data.guests == null) {
            const gm = str.match(/"(?:personCapacity|guestCapacity|guest_capacity)":\s*(\d+)/);
            if (gm) data.guests = parseInt(gm[1], 10);
          }
          if (data.bedrooms == null) {
            const bm = str.match(/"(?:bedroomCount|bedrooms?)":\s*(\d+)/);
            if (bm) data.bedrooms = parseInt(bm[1], 10);
          }
          if (data.beds == null) {
            const bm = str.match(/"(?:bedCount|beds?)":\s*(\d+)/);
            if (bm) data.beds = parseInt(bm[1], 10);
          }
          if (data.bathrooms == null) {
            const bm = str.match(/"(?:bathroomCount|bathrooms?)":\s*(\d+(?:\.\d+)?)/);
            if (bm) data.bathrooms = parseFloat(bm[1]);
          }
          if (!data.host) {
            // Try multiple key patterns Airbnb uses for the host name
            const hostPatterns = [
              /"(?:hostName|host_name)":\s*"([^"]+)"/,
              /"name":\s*"([^"]+)"[^}]*"(?:isSuperhost|is_superhost)"/,
              /"primaryHost":\s*\{[^}]*"name":\s*"([^"]+)"/,
              /"host":\s*\{[^}]*"name":\s*"([^"]+)"/,
              /"hostProfileName":\s*"([^"]+)"/,
            ];
            for (const re of hostPatterns) {
              const hm = str.match(re);
              if (hm && hm[1]) { data.host = hm[1]; break; }
            }
          }

          // Deep-walk the parsed JSON for host objects
          if (!data.host) {
            (function findHost(obj, depth) {
              if (!obj || depth > 8 || data.host) return;
              if (typeof obj !== 'object') return;
              // Object with a host-like key containing a name
              if (obj.primaryHost && obj.primaryHost.name) { data.host = obj.primaryHost.name; return; }
              if (obj.host && typeof obj.host === 'object' && obj.host.name) { data.host = obj.host.name; return; }
              if (obj.hostName && typeof obj.hostName === 'string') { data.host = obj.hostName; return; }
              if (obj.host_name && typeof obj.host_name === 'string') { data.host = obj.host_name; return; }
              if (obj.hostProfileName && typeof obj.hostProfileName === 'string') { data.host = obj.hostProfileName; return; }
              // Recurse
              const keys = Array.isArray(obj) ? obj : Object.values(obj);
              for (const v of keys) findHost(v, depth + 1);
            })(json, 0);
          }
        } catch (_) {}
      }
    } catch (_) {}

    // ── Host name extraction from visible text ──
    if (!data.host) {
      // Airbnb shows "Hosted by Name" or "Entire rental unit hosted by Name"
      // Handle multi-word names, accented chars, names ending at line breaks or section markers
      const hostPatterns = [
        /[Hh]osted\s+by\s+([\p{L}][\p{L}\s\-'\.]{0,40}?)(?:\n|\r|·|Superhost|Show|Contact|More about|is a |Joined)/u,
        /[Hh]osted\s+by\s+([\p{L}][\p{L}\s\-'\.]{0,40})\s*$/um,
        /Meet your [Hh]ost,?\s+([\p{L}][\p{L}\s\-'\.]{0,40}?)(?:\n|\r|·|Superhost|Joined)/u,
      ];
      for (const re of hostPatterns) {
        const m = body.match(re);
        if (m && m[1] && m[1].trim().length >= 2) {
          data.host = m[1].trim();
          break;
        }
      }
    }
    if (!data.host) {
      // Fallback: look for elements with host-related attributes
      const hostSelectors = [
        '[data-testid*="host-name"]',
        '[data-testid*="host-profile"] [class*="name"]',
        '[class*="host-name"]',
        '[class*="hostName"]',
        'section[aria-label*="Host"] h2',
        'div[data-section-id="HOST_PROFILE"] h2',
        'div[data-section-id="HOST_OVERVIEW"] h2',
      ];
      for (const sel of hostSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            // Extract name: strip "Hosted by " prefix if present
            let txt = el.textContent.trim();
            txt = txt.replace(/^(?:Hosted|hosted)\s+by\s+/i, '').trim();
            if (txt.length >= 2 && txt.length <= 50) {
              data.host = txt;
              break;
            }
          }
        } catch (_) {}
      }
    }
    // Final fallback: Airbnb og:title often contains "hosted by Name"
    if (!data.host) {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
      const m = ogTitle.match(/hosted\s+by\s+([\p{L}][\p{L}\s\-'\.]{0,40})/iu);
      if (m && m[1]) data.host = m[1].trim();
    }

    // ── v1.16.0: Listing title + description (for Co-Hosting imports) ──
    try {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
      data.title = ogTitle.replace(/\s*[-–|]\s*Airbnb.*$/i, '').replace(/\s+hosted by.*$/i, '').trim() || null;
      data.description = (document.querySelector('meta[property="og:description"]')?.content
        || document.querySelector('meta[name="description"]')?.content || '').trim() || null;
    } catch (_) {}

    // ── v1.16.0: Amenities — the "What this place offers" list, pulled from
    // Airbnb's embedded JSON. Airbnb marks each amenity with an "available"
    // boolean; we collect the titles of the ones that are present. ──
    // v1.16.14: EXCLUDE Airbnb's "Safety & property" DISCLOSURES — these are
    // warnings, not amenities. "Pool/hot tub without a gate or lock" does NOT
    // mean the place has a pool/hot tub, and was creating false amenity
    // inconsistencies between listings. We drop any disclosure-style entries.
    try {
      const found = new Set();
      const scripts = document.querySelectorAll('script[type="application/json"], script[id="__NEXT_DATA__"]');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!/amenit/i.test(t)) continue;
        let re = /"title":"([^"]{2,60})"[^{}]*?"available":true/g, m;
        while ((m = re.exec(t))) found.add(m[1]);
        re = /"available":true[^{}]*?"title":"([^"]{2,60})"/g;
        while ((m = re.exec(t))) found.add(m[1]);
      }
      // Disclosure phrasings from Airbnb's "Safety & property" section — never
      // real amenities. (Positive safety amenities like "Smoke alarm" are kept.)
      const SAFETY_RE = /without a gate or lock|must climb stairs|potential for noise|nearby (?:lake|river|beach|body of water)|security cameras?|surveillance|records? (?:audio|video)|pets? live on (?:the )?propert|some spaces are shared|amenity limitations|weapons? on (?:the )?propert|dangerous animals?|no (?:carbon monoxide|smoke) alarm/i;
      const clean = Array.from(found).filter(function (a) { return !SAFETY_RE.test(a); });
      if (clean.length) data.amenities = clean.slice(0, 150);
    } catch (_) {}

    // ── v1.16.0: Full page text (capped) so the service worker's dictionary
    // extractor + AI enrichment can derive structured Property Details. ──
    try { data._fullPageText = (document.body.innerText || '').slice(0, 20000); } catch (_) {}

    // ── v1.16.3: approximate coordinates (Airbnb fuzzes these for privacy) ──
    try {
      const scripts = document.querySelectorAll('script[type="application/json"], script[id="__NEXT_DATA__"]');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (data.lat == null) {
          const m = t.match(/"lat(?:itude)?":\s*(-?\d{1,3}\.\d{3,})/);
          if (m) data.lat = parseFloat(m[1]);
        }
        if (data.lng == null) {
          const m = t.match(/"l(?:ng|ong|ongitude)":\s*(-?\d{1,3}\.\d{3,})/);
          if (m) data.lng = parseFloat(m[1]);
        }
        if (data.lat != null && data.lng != null) break;
      }
    } catch (_) {}

    // ── v1.16.3: precise rating (e.g. 4.97) from og:title or page text ──
    try {
      const ogt = document.querySelector('meta[property="og:title"]')?.content || '';
      let m = ogt.match(/★\s*([\d.]+)/) || ogt.match(/(\d\.\d{1,2})\s*(?:·|·|out of|stars)/i)
           || body.match(/★\s*([\d.]+)/) || body.match(/(\d\.\d{1,2})\s*\(\d+\s*reviews?\)/i);
      if (m) data.rating = parseFloat(m[1]);
    } catch (_) {}

    return data;
  }

  function run(attempt) {
    try {
      const data = extract();
      // Want all key fields: bedrooms, bathrooms, host, and guests
      const hasCore = data.bedrooms != null && data.bathrooms != null;
      const hasHost = !!data.host;
      const hasAny = data.guests != null || data.bedrooms != null ||
                     data.beds != null || data.host;
      // Wait for core fields + host before declaring success.
      // Accept partial data after more attempts, and bail completely at max.
      const isComplete = hasCore && hasHost;
      if (isComplete || (hasAny && attempt >= 10) || attempt >= 15) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 15) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 800);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 500);
  else window.addEventListener('load', () => setTimeout(() => run(0), 500), { once: true });
})();
