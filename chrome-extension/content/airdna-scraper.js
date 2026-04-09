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

  function num(str) {
    if (str == null) return null;
    const m = String(str).replace(/[, ]/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isNaN(n) ? null : n;
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

  // Find a metric value by scanning for a label anywhere on the page.
  function findMetric(labelRegex) {
    const nodes = document.querySelectorAll('div,span,p,dt,dd,li,section');
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 80) continue;
      if (!labelRegex.test(t)) continue;
      // Look at sibling / parent for the value
      const candidates = [
        n.nextElementSibling,
        n.previousElementSibling,
        n.parentElement && n.parentElement.querySelector('[class*="value"],[class*="amount"],strong,b,dd'),
      ].filter(Boolean);
      for (const c of candidates) {
        const v = (c.textContent || '').trim();
        if (v && /\d/.test(v) && v.length < 40) return v;
      }
    }
    return null;
  }

  // Look for a link to the underlying Airbnb listing. AirDNA usually
  // renders a "View on Airbnb" button / anchor.
  function findAirbnbLink() {
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (/airbnb\.com\/rooms\//i.test(href)) return href;
      if (/airbnb\.[a-z.]+\/rooms\//i.test(href)) return href;
    }
    // Sometimes AirDNA uses an outbound redirect; grab anything mentioning airbnb
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

  function extract() {
    const data = {
      title: text('h1') || document.title || null,
      address: text('[data-testid="listing-address"]') || text('[class*="ddress"]') || null,
      airdnaUrl: location.href,
      link: null,         // Airbnb listing link
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
    };

    // Try to find the Airbnb link
    const abnb = findAirbnbLink();
    if (abnb) {
      data.link = abnb;
      data.linkShort = shortLink(abnb);
    }

    // Metric cards — walk generic stat containers
    const cards = document.querySelectorAll('[class*="metric"],[class*="Metric"],[class*="stat"],[class*="Stat"],[data-testid*="metric"]');
    cards.forEach((card) => {
      const labelEl = card.querySelector('[class*="label"],[class*="Label"],[class*="title"],dt');
      const valueEl = card.querySelector('[class*="value"],[class*="Value"],[class*="amount"],dd,strong');
      if (!labelEl || !valueEl) return;
      const L = (labelEl.textContent || '').trim().toLowerCase();
      const V = (valueEl.textContent || '').trim();
      if (!L || !V) return;
      data.raw[L] = V;
      if (/revenue/.test(L) && data.annualRevenue == null) data.annualRevenue = money(V);
      else if (/adr|daily rate|nightly/.test(L) && data.nightlyRate == null) data.nightlyRate = money(V);
      else if (/occupancy/.test(L) && data.occupancy == null) data.occupancy = pct(V);
      else if (/days? (available|booked)/.test(L) && data.daysAvailable == null) data.daysAvailable = num(V);
      else if (/bedroom/.test(L) && data.bedrooms == null) data.bedrooms = num(V);
      else if (/bathroom/.test(L) && data.bathrooms == null) data.bathrooms = num(V);
      else if (/guest/.test(L) && data.guests == null) data.guests = num(V);
      else if (/\bbeds?\b/.test(L) && data.beds == null) data.beds = num(V);
      else if (/rating/.test(L) && data.rating == null) data.rating = num(V);
      else if (/host/.test(L) && !data.host) data.host = V;
    });

    // Targeted fallbacks by label text
    if (data.annualRevenue == null) data.annualRevenue = money(findMetric(/annual\s*revenue/i));
    if (data.nightlyRate == null) data.nightlyRate = money(findMetric(/average\s*daily\s*rate|\badr\b|nightly\s*rate/i));
    if (data.occupancy == null) data.occupancy = pct(findMetric(/occupancy/i));
    if (data.daysAvailable == null) data.daysAvailable = num(findMetric(/days?\s*(available|booked)/i));
    if (data.rating == null) data.rating = num(findMetric(/overall\s*rating|rating/i));

    // Body-text fallbacks
    const body = document.body.innerText || '';
    if (data.bedrooms == null) {
      const m = body.match(/(\d+(?:\.\d+)?)\s*(?:bed|br|bedroom)/i);
      if (m) data.bedrooms = parseFloat(m[1]);
    }
    if (data.bathrooms == null) {
      const m = body.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba|bathroom)/i);
      if (m) data.bathrooms = parseFloat(m[1]);
    }
    if (data.guests == null) {
      const m = body.match(/(\d+)\s*guests?/i);
      if (m) data.guests = parseInt(m[1], 10);
    }

    return data;
  }

  function run(attempt) {
    try {
      const data = extract();
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
