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

    // Grab a generous chunk of text containing the selected listing's detail.
    // AirDNA's layout sometimes inserts extra UI elements between metrics,
    // so we read 1500 chars to capture all 5 metric pairs reliably.
    const chunk = body.substring(overviewIdx, overviewIdx + 1500);
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
      // ── v1.17.0 Co-Hosting extras (ADDITIVE ONLY) ──
      // These are NEW fields read ONLY by the Co-Hosting import. The comp
      // (Arbitrage) import ignores them entirely, so they cannot affect it.
      // All populated inside extractCohostExtras() under its own try/catch so
      // a failure here can never touch the comp-critical fields above.
      listingTitle: null,
      marketScore: null,
      priceTier: null,
      airdnaType: null,
      market: null,
      submarket: null,
      vrboLink: null,
      bookingLink: null,
      lat: null,
      lng: null,
      // Co-Hosting financials, SCOPED to the listing-detail panel (so they
      // never pick up the search-results listings elsewhere on the page).
      // Kept under co* names so they can't collide with the comp-critical
      // fields (annualRevenue/occupancy/nightlyRate/daysAvailable) above.
      coRevenuePotential: null,
      coAnnualRevenue: null,
      coOccupancy: null,
      coADR: null,
      coDaysAvailable: null,
      coRating: null,
      coReviews: null,
      aiSummary: null,
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

    // ── Fallback: broader body-text sweep for financial metrics ──
    // If the scoped extraction missed revenue/rate/occupancy/days,
    // sweep the full page text for value→label patterns.
    if (data.annualRevenue == null) {
      const m = body.match(/(\$[\d,.]+[kKmM]?)\s*\n?\s*(?:Annual\s+)?Revenue(?!\s*Potential)/i);
      if (m) data.annualRevenue = money(m[1]);
    }
    if (data.nightlyRate == null) {
      const m = body.match(/(\$[\d,.]+)\s*\n?\s*(?:Average\s+)?Daily\s*Rate/i);
      if (m) data.nightlyRate = money(m[1]);
    }
    if (data.occupancy == null) {
      const m = body.match(/([\d.]+%?)\s*\n?\s*Occupancy/i);
      if (m) data.occupancy = num(m[1]);
    }
    if (data.daysAvailable == null) {
      const m = body.match(/(\d+)\s*\n?\s*Days?\s*Available/i);
      if (m) data.daysAvailable = num(m[1]);
    }

    // ── Fallback: DOM element scan for metric cards ──
    // AirDNA renders metrics in card-like elements. Scan all small
    // text containers for label/value pairs we may have missed.
    try {
      const allEls = document.querySelectorAll('div, span, p, td');
      for (const el of allEls) {
        const txt = (el.textContent || '').trim();
        if (txt.length > 50 || txt.length === 0) continue;
        const lower = txt.toLowerCase();
        if (data.annualRevenue == null && /^annual\s*revenue$/i.test(lower)) {
          const prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
          if (prev) { const v = money(prev.textContent); if (v) data.annualRevenue = v; }
        }
        if (data.nightlyRate == null && /^(?:average\s+)?daily\s*rate$/i.test(lower)) {
          const prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
          if (prev) { const v = money(prev.textContent); if (v) data.nightlyRate = v; }
        }
        if (data.occupancy == null && /^occupancy$/i.test(lower)) {
          const prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
          if (prev) { const v = num(prev.textContent); if (v) data.occupancy = v; }
        }
        if (data.daysAvailable == null && /^days?\s*available$/i.test(lower)) {
          const prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
          if (prev) { const v = num(prev.textContent); if (v) data.daysAvailable = v; }
        }
      }
    } catch (_) {}

    // ── v1.17.0: Co-Hosting extras — runs LAST and fully wrapped so it can
    // NEVER affect the comp-critical fields above (Arbitrage isolation). ──
    try { extractCohostExtras(data); } catch (_) {}

    return data;
  }

  // Find the TARGET listing's VRBO link. The source-link icons (Airbnb +
  // VRBO) sit together in the top-left of the hero photo, so we locate the
  // Airbnb icon that matches the URL's listing_id and look for a VRBO anchor
  // in the SAME container — never a random competitor's VRBO link.
  function findVrboLink() {
    try {
      const params = new URLSearchParams(location.search);
      const roomId = (params.get('listing_id') || '').replace(/^abnb_/, '');
      if (/^\d+$/.test(roomId)) {
        const anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="airbnb.com/rooms/"]'));
        const abnb = anchors.find(function (a) { return a.href.indexOf(roomId) !== -1; });
        if (abnb) {
          let node = abnb;
          for (let i = 0; i < 5 && node; i++) {
            const v = node.querySelector && node.querySelector('a[href*="vrbo.com/"], a[href*="homeaway."]');
            if (v) return v.href;
            node = node.parentElement;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // Booking.com link for the target listing — same co-located approach as
  // findVrboLink (scoped near this listing's Airbnb anchor so it never grabs a
  // booking.com link from a different listing on the page).
  function findBookingLink() {
    try {
      const params = new URLSearchParams(location.search);
      const roomId = (params.get('listing_id') || '').replace(/^abnb_/, '');
      if (/^\d+$/.test(roomId)) {
        const anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="airbnb.com/rooms/"]'));
        const abnb = anchors.find(function (a) { return a.href.indexOf(roomId) !== -1; });
        if (abnb) {
          let node = abnb;
          for (let i = 0; i < 5 && node; i++) {
            const b = node.querySelector && node.querySelector('a[href*="booking.com/"]');
            if (b) return b.href;
            node = node.parentElement;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // ADDITIVE-ONLY extractor for Co-Hosting. Reads NEW fields, SCOPED to the
  // listing-detail panel so values never bleed in from the search-results
  // listings elsewhere on the page. Every pull is independently guarded;
  // nothing here writes to a comp-critical field.
  function extractCohostExtras(data) {
    const body = document.body.innerText || '';

    // lat/lng from the URL
    try {
      const u = new URLSearchParams(location.search);
      const la = parseFloat(u.get('lat')), ln = parseFloat(u.get('lng'));
      if (!isNaN(la)) data.lat = la;
      if (!isNaN(ln)) data.lng = ln;
    } catch (_) {}

    // ── Descriptor block — Market / Market Score / Type / Price Tier appear
    // CONSECUTIVELY only in the detail panel. One anchored match yields all
    // four AND marks where the detail panel starts (detailIdx). ──
    let detailIdx = -1;
    try {
      const m = body.match(/Market:\s+([^\n]+?)\s+Market Score:\s+(\d{1,3})\s+Type:\s+([A-Za-z\/ ]+?)\s+Price Tier:\s+([A-Za-z ]+?)(?:\s*\n|$)/i);
      if (m) {
        detailIdx = m.index;
        data.market = m[1].trim();
        const sc = parseInt(m[2], 10); if (sc >= 0 && sc <= 100) data.marketScore = sc;
        data.airdnaType = m[3].trim();
        data.priceTier = m[4].trim();
      }
    } catch (_) {}

    // Listing title — robust: the first text line right after the standalone
    // "Listing Overview" label (before the detail block). Falls back to the
    // bed-row-anchored regex. Never grabs "Listing Overview" / a number.
    try {
      const searchArea = detailIdx >= 0 ? body.slice(0, detailIdx) : body;
      const lo = searchArea.lastIndexOf('Listing Overview');
      if (lo >= 0) {
        const tail = searchArea.slice(lo + 'Listing Overview'.length).split('\n')
          .map(function (s) { return s.trim(); }).filter(Boolean);
        const cand = tail.find(function (s) {
          return /[a-z]/i.test(s) && !/^\d/.test(s) && s.length >= 3 && s.length <= 90
            && !/^(market\b|market score|type\b|price tier|connect|short-term)/i.test(s);
        });
        if (cand) data.listingTitle = cand;
      }
      if (!data.listingTitle) {
        const m = body.match(/\n([^\n]{3,90})\s*\n\s*\d+\s*\n\s*[\d.]+\s*\n\s*\d+\s*\n\s*[\d.]+\s*\(\d+\)\s*\n\s*Market:/i);
        if (m && !/^\d/.test(m[1].trim())) data.listingTitle = m[1].trim();
      }
    } catch (_) {}

    // Listing rating from the detail bed/bath row ("5\n3\n10\n5 (64)") — the
    // value right before "Market:". Airbnb's more-precise rating (if scraped)
    // takes precedence later in the service worker.
    try {
      const m = body.match(/\n\s*([\d.]+)\s*\((\d+)\)\s*\n\s*Market:/i);
      if (m) { data.coRating = parseFloat(m[1]); data.coReviews = parseInt(m[2], 10); }
    } catch (_) {}

    // ── Financials — SCOPED to the detail panel. The panel uniquely uses
    // "Annual Revenue" + "Avg. Daily Rate" (search results use bare
    // "Revenue"/"Daily Rate"), and "Revenue Potential" here is the target's. ──
    try {
      const scope = detailIdx >= 0 ? body.slice(detailIdx, detailIdx + 1400) : body;
      let m;
      if ((m = scope.match(/(\$[\d.,]+\s*[kKmM]?)\s*\n\s*Revenue Potential/i))) data.coRevenuePotential = money(m[1]);
      if ((m = scope.match(/(\d[\d,]*)\s*\n\s*Days Available/i)))               data.coDaysAvailable = num(m[1]);
      if ((m = scope.match(/(\$[\d.,]+\s*[kKmM]?)\s*\n\s*Annual Revenue/i)))     data.coAnnualRevenue = money(m[1]);
      if ((m = scope.match(/([\d.]+)\s*%?\s*\n\s*Occupancy/i)))                  data.coOccupancy = num(m[1]);
      if ((m = scope.match(/(\$[\d.,]+)\s*\n\s*Avg\.?\s*Daily Rate/i)))          data.coADR = money(m[1]);
    } catch (_) {}

    // AI Summary — AirDNA's "What Guests Are Saying" / sentiment insights (the
    // section expanded by clicking "Show AI Summary"; see the click in run()).
    try {
      const aiIdx = body.search(/Hide AI Summary|What Guests Are Saying|Guest Sentiment|AI Summary/i);
      if (aiIdx >= 0) {
        const chunk = body.slice(aiIdx, aiIdx + 3000);
        const em = chunk.search(/What key amenities|How is this listing priced|Top Competitors|Recent Listing|Connect your listing/i);
        let txt = chunk.slice(0, em > 0 ? em : 3000)
          .replace(/Show AI Summary|Hide AI Summary|AI Summary/gi, '')
          .replace(/AI[- ]analyzed[^\n]*/gi, '')
          .replace(/\n{2,}/g, '\n').trim();
        // Keep it only if it has real prose (more than just the sentiment line). Keep the
        // full structured text (Sentiment + What guests like / Areas to improve / Location).
        if (txt.replace(/sentiment[^\n]*/i, '').trim().length > 30) data.aiSummary = txt.slice(0, 2800);
      }
    } catch (_) {}

    // VRBO link (co-located with the target's Airbnb icon)
    try { const v = findVrboLink(); if (v) data.vrboLink = v; } catch (_) {}
    try { const bk = findBookingLink(); if (bk) data.bookingLink = bk; } catch (_) {}

    // Amenities — the "What key amenities does this listing offer?" list,
    // up to the "Show More/Less Amenities" toggle. These are clean names
    // (Pool, Air Conditioning, Pet-Friendly, …) shown with icons on AirDNA.
    try {
      const start = body.search(/What key amenities does this listing offer\?/i);
      if (start >= 0) {
        const after = body.slice(start + 1);
        const endRe = /Show (Less|More) Amenities|How is this listing priced|Top Competitors|Recent Listing/i;
        const em = after.match(endRe);
        const chunk = after.slice(after.indexOf('\n'), em ? em.index : 700);
        const lines = chunk.split(/\n/).map(function (l) { return l.trim(); })
          .filter(function (l) { return l.length >= 2 && l.length <= 40 && /[a-z]/i.test(l) && !/^show |amenit|^how is/i.test(l); });
        if (lines.length) data.amenities = lines.slice(0, 40);
      }
    } catch (_) {}
  }

  function run(attempt) {
    // Expand AirDNA's "Show AI Summary" on the first few passes so its prose
    // is in the DOM by the time extractCohostExtras reads it. (Co-Hosting only
    // consumes data.aiSummary; harmless for comp scrapes.)
    if (attempt < 10) {
      try {
        const clickers = document.querySelectorAll('button, [role="button"], a');
        for (const b of clickers) {
          // Once expanded the label flips to "Hide AI Summary", so this only fires
          // while it's still collapsed.
          if (/show ai summary/i.test((b.textContent || '').trim())) { b.click(); break; }
        }
      } catch (_) {}
    }
    try {
      const data = extract();
      // If login/paywall detected, return immediately
      if (data._loginRequired) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
      // Key financial metrics we need for a complete import
      const hasFinancials = data.annualRevenue != null || data.nightlyRate != null;
      const hasOccupancy = data.occupancy != null || data.daysAvailable != null;
      const hasLink = !!data.link;
      // Co-Hosting imports (flagged via window.__rrWantAiSummary, set by the service
      // worker before injection) wait a few extra passes for AirDNA's "Show AI
      // Summary" dropdown to expand + load before declaring success — otherwise the
      // scrape finishes on the fast-loading financials and the AI summary never makes
      // it in. Plain competitor scrapes don't set the flag, so they're unaffected.
      const wantAi = (window.__rrWantAiSummary === true);
      const aiPending = wantAi && data.aiSummary == null && attempt < 10;
      // Wait for financials + occupancy + Airbnb link before declaring success.
      // Only bail early with partial data after max attempts.
      const isComplete = hasFinancials && hasOccupancy && hasLink && !aiPending;
      const hasAnything = hasLink || data.title || hasFinancials || data.bedrooms != null;
      if (isComplete || (hasAnything && !aiPending && attempt >= 10) || attempt >= 16) {
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
