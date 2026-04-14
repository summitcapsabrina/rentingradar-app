// Content script injected into an AirDNA listing page.
// Extracts listing details (including the underlying Airbnb link) and
// posts them back to the service worker.

(function () {
  if (window.__rrAirDnaScraperRan) return;
  window.__rrAirDnaScraperRan = true;

  function text(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? el.textContent.trim() : null;
  }

  // Parse a number, handling K/M suffixes (e.g. "$206.1K" → 206100)
  function num(str) {
    if (str == null) return null;
    const s = String(str).replace(/[,$\s€£]/g, '');
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*([kKmM])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    if (m[2] && /k/i.test(m[2])) n *= 1000;
    if (m[2] && /m/i.test(m[2])) n *= 1000000;
    return n;
  }

  function money(str) {
    if (str == null) return null;
    return num(String(str).replace(/[$€£]/g, ''));
  }

  function pct(str) {
    const n = num(str);
    if (n == null) return null;
    return n > 1 ? n / 100 : n;
  }

  // Look for a link to the underlying Airbnb listing.
  function findAirbnbLink() {
    // If the URL contains a listing_id, use it to find the exact Airbnb link
    const urlParams = new URLSearchParams(location.search);
    const listingId = urlParams.get('listing_id');
    if (listingId) {
      // listing_id format: "abnb_1035961933887794067" → airbnb room ID is the numeric part
      const roomId = listingId.replace(/^abnb_/, '');
      if (/^\d+$/.test(roomId)) {
        // Look for an anchor with this specific room ID first
        const anchors = document.querySelectorAll('a[href*="airbnb"]');
        for (const a of anchors) {
          if (a.href.includes(roomId)) return a.href;
        }
        // Construct the link if not found in DOM
        return 'https://www.airbnb.com/rooms/' + roomId;
      }
    }

    // Fallback: scan all anchors
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (/airbnb\.com\/rooms\//i.test(href)) return href;
      if (/airbnb\.[a-z.]+\/rooms\//i.test(href)) return href;
    }
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (/airbnb/i.test(href) && /\/rooms?\//i.test(href)) return href;
    }
    return null;
  }

  function shortLink(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch (_) { return url; }
  }

  // Detect if AirDNA is showing a login wall or paywall.
  function detectLoginWall() {
    const url = location.href.toLowerCase();
    const body = (document.body.innerText || '').toLowerCase();
    const title = (document.title || '').toLowerCase();

    // URL-based: redirected to auth/login/signup pages
    if (/auth\.airdna/i.test(url) && /\/(login|signin|sign-in|signup|sign-up|oauth2|register)\b/i.test(url)) {
      return 'login-redirect';
    }

    // Page text signals — but only if listing data is NOT also present
    // (AirDNA sometimes shows a login modal over listing data)
    const hasData = /annual revenue|daily rate|occupancy/i.test(body);
    if (!hasData) {
      if (/sign in to (your account|airdna|continue)/i.test(body)) return 'login-page';
      if (/log\s*in to (your account|airdna|continue)/i.test(body)) return 'login-page';
      if (/create your free account/i.test(body)) return 'signup-page';
      if (/subscribe to (view|access|unlock)/i.test(body)) return 'paywall';
      if (/start your free trial/i.test(body)) return 'paywall';
    }

    // Title-based
    if (/log\s*in|sign\s*in|sign\s*up/i.test(title) && !/listing|property|rental|airdna/i.test(title)) return 'login-page';

    return null;
  }

  // ── Primary extraction: body text scoped to the selected listing ──
  // The AirDNA listing detail page shows "Short-term Rental Listing Overview"
  // followed by the listing title, metadata, and metrics in a predictable
  // value→label line pattern. We scope extraction to the text after this
  // header to avoid picking up metrics from other listings on the page.
  function extractFromScopedText(data) {
    const body = document.body.innerText || '';
    const overviewIdx = body.indexOf('Short-term Rental Listing Overview');
    if (overviewIdx < 0) return false;

    // Grab a chunk of text containing the selected listing's detail
    // (600 chars is enough for header + all 5 metric pairs)
    const chunk = body.substring(overviewIdx, overviewIdx + 800);
    const lines = chunk.split(/\n/).map(l => l.trim()).filter(Boolean);

    // Extract header info: beds, baths, guests, rating
    // Lines after "Short-term Rental Listing Overview" are: beds, baths, guests, "rating (reviews)"
    // e.g. ["Short-term...", "2", "2", "6", "4.7 (122)", "Chelsea Beautiful..."]
    if (lines.length >= 5) {
      const n1 = parseInt(lines[1], 10);
      const n2 = parseInt(lines[2], 10);
      const n3 = parseInt(lines[3], 10);
      const ratingMatch = lines[4].match(/^(\d+(?:\.\d+)?)\s*\(\d+\)/);
      if (!isNaN(n1)) data.bedrooms = n1;
      if (!isNaN(n2)) data.bathrooms = n2;
      if (!isNaN(n3)) data.guests = n3;
      if (ratingMatch) data.rating = parseFloat(ratingMatch[1]);
    }

    // Extract listing title (first line that starts with uppercase and is > 5 chars)
    for (let i = 4; i < Math.min(lines.length, 10); i++) {
      const l = lines[i];
      if (/^[A-Z]/.test(l) && l.length > 5 && !/^(Market|Type|Price|Connect|Get )/.test(l)) {
        if (!data.title || data.title === document.title) data.title = l;
        break;
      }
    }

    // Extract value→label metric pairs
    // Pattern: line[i] = value (e.g. "$206.1K"), line[i+1] = label (e.g. "Annual Revenue")
    for (let i = 0; i < lines.length - 1; i++) {
      const value = lines[i];
      const label = lines[i + 1];

      // "Annual Revenue" or "Revenue" — but NOT "Revenue Potential"
      if (/^(?:Annual\s+)?Revenue$/i.test(label) && data.annualRevenue == null) {
        data.annualRevenue = money(value);
      }
      else if (/^(?:Average\s+)?Daily\s*Rate$/i.test(label) && data.nightlyRate == null) {
        data.nightlyRate = money(value);
      }
      else if (/^Occupancy$/i.test(label) && data.occupancy == null) {
        data.occupancy = num(value);
      }
      else if (/^Days?\s*Available$/i.test(label) && data.daysAvailable == null) {
        data.daysAvailable = num(value);
      }
    }

    return data.annualRevenue != null || data.nightlyRate != null;
  }

  function extract() {
    const data = {
      title: text('h1') || document.title || null,
      address: text('[data-testid="listing-address"]') || text('[class*="ddress"]') || null,
      airdnaUrl: location.href,
      link: null,
      linkShort: null,
      annualRevenue: null,
      daysAvailable: null,
      occupancy: null,
      nightlyRate: null,
      guests: null,
      bedrooms: null,
      beds: null,
      bathrooms: null,
      host: null,
      rating: null,
      notes: null,
      raw: {},
      _loginRequired: null,
    };

    // Check for login/paywall before scraping
    const loginCheck = detectLoginWall();
    if (loginCheck) {
      data._loginRequired = loginCheck;
      return data;
    }

    // Airbnb link
    const abnb = findAirbnbLink();
    if (abnb) {
      data.link = abnb;
      data.linkShort = shortLink(abnb);
    }

    // Primary: scoped body text extraction (reliable for app.airdna.co)
    extractFromScopedText(data);

    // Fallback: body-text regex for beds/baths/guests if still missing
    const body = document.body.innerText || '';
    if (data.bedrooms == null) {
      const m = body.match(/(\d+)\s*(?:bedrooms?|br)\b/i);
      if (m) data.bedrooms = parseInt(m[1], 10);
    }
    if (data.bathrooms == null) {
      const m = body.match(/(\d+(?:\.\d+)?)\s*(?:bathrooms?|ba)\b/i);
      if (m) data.bathrooms = parseFloat(m[1]);
    }
    if (data.guests == null) {
      const m = body.match(/(\d+)\s*guests?\b/i);
      if (m) data.guests = parseInt(m[1], 10);
    }

    return data;
  }

  function run(attempt) {
    try {
      const data = extract();
      // If login/paywall detected, return immediately
      if (data._loginRequired) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
      const hasContent =
        data.link || data.title || data.annualRevenue != null ||
        data.nightlyRate != null || data.occupancy != null ||
        data.bedrooms != null;
      if (hasContent || attempt >= 8) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 8) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 800);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 500);
  else window.addEventListener('load', () => setTimeout(() => run(0), 500), { once: true });
})();
