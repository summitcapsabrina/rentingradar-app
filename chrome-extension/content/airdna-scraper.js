// Content script injected into an AirDNA listing page.
// Extracts listing details and posts them back to the service worker.
// The service worker will resolve the pending scrape promise keyed by tab id.

(function () {
  if (window.__rrAirDnaScraperRan) return;
  window.__rrAirDnaScraperRan = true;

  function text(sel) {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : null;
  }

  function num(str) {
    if (str == null) return null;
    const m = String(str).match(/-?[\d,.]+/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  function pct(str) {
    const n = num(str);
    if (n == null) return null;
    return n > 1 ? n / 100 : n;
  }

  function extract() {
    // AirDNA's listing page structure changes frequently. We try several
    // selectors and fall back to looking for labeled metric tiles.
    const result = {
      title: text('h1') || document.title,
      address: text('[data-testid="listing-address"]') || text('[class*="address"]'),
      bedrooms: null,
      bathrooms: null,
      adr: null,
      occupancy: null,
      revenue: null,
      raw: {},
    };

    // Look for metric cards by label text
    const cards = document.querySelectorAll('[class*="metric"], [class*="stat"], [data-testid*="metric"]');
    cards.forEach((card) => {
      const label = (card.querySelector('[class*="label"], [class*="title"], dt') || {}).textContent;
      const value = (card.querySelector('[class*="value"], [class*="amount"], dd') || {}).textContent;
      if (!label || !value) return;
      const L = label.trim().toLowerCase();
      result.raw[L] = value.trim();
      if (/revenue/.test(L) && result.revenue == null) result.revenue = num(value);
      else if (/adr|daily rate/.test(L) && result.adr == null) result.adr = num(value);
      else if (/occupancy/.test(L) && result.occupancy == null) result.occupancy = pct(value);
      else if (/bedroom/.test(L) && result.bedrooms == null) result.bedrooms = num(value);
      else if (/bathroom/.test(L) && result.bathrooms == null) result.bathrooms = num(value);
    });

    // Fallback: search the whole document text for patterns like "3 bed" / "2 bath"
    if (result.bedrooms == null) {
      const bedMatch = document.body.innerText.match(/(\d+(?:\.\d+)?)\s*(?:bed|br|bedroom)/i);
      if (bedMatch) result.bedrooms = parseFloat(bedMatch[1]);
    }
    if (result.bathrooms == null) {
      const bathMatch = document.body.innerText.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba|bathroom)/i);
      if (bathMatch) result.bathrooms = parseFloat(bathMatch[1]);
    }

    return result;
  }

  function run(attempt) {
    try {
      const data = extract();
      // Consider the scrape successful if we got at least a title OR one metric
      const hasContent = data.title || data.adr != null || data.revenue != null || data.bedrooms != null;
      if (hasContent || attempt >= 6) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 6) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', error: e.message });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 750);
  }

  // AirDNA is a SPA; wait a beat for hydration.
  if (document.readyState === 'complete') setTimeout(() => run(0), 400);
  else window.addEventListener('load', () => setTimeout(() => run(0), 400), { once: true });
})();
