// Content script injected into an AirDNA page to extract market/submarket
// names from the page navigation, breadcrumbs, or URL structure.
// Posts { type:'SCRAPE_RESULT', payload: { market, submarket, _type:'market-lookup' } }

(function () {
  if (window.__rrAirDnaMarketScraperRan) return;
  window.__rrAirDnaMarketScraperRan = true;

  function extract() {
    const body = document.body ? document.body.innerText || '' : '';
    const url = location.href;
    let market = null;
    let submarket = null;

    // ── 1. Login / paywall detection ──
    if (/auth\.airdna/i.test(url)) {
      return { market: null, submarket: null, _type: 'market-lookup', _loginRequired: true };
    }
    const bodyLower = body.toLowerCase();
    if (!bodyLower.includes('overview') && !bodyLower.includes('rentalizer') && !bodyLower.includes('revenue')) {
      if (/sign in|log in|create your free account/i.test(bodyLower)) {
        return { market: null, submarket: null, _type: 'market-lookup', _loginRequired: true };
      }
    }

    // ── 2. Breadcrumb navigation ──
    // AirDNA typically renders breadcrumbs: United States > Market > Submarket
    const breadcrumbContainers = document.querySelectorAll(
      'nav[aria-label*="breadcrumb"], [class*="breadcrumb"], [class*="Breadcrumb"], [data-testid*="breadcrumb"]'
    );
    for (const container of breadcrumbContainers) {
      const links = container.querySelectorAll('a, span');
      const parts = [];
      for (const el of links) {
        const t = el.textContent.trim();
        if (t && t.length > 1 && !/^(home|airdna|data)$/i.test(t)) {
          parts.push(t);
        }
      }
      // Expect [Country, Market, Submarket] or [Market, Submarket]
      if (parts.length >= 2) {
        // Skip "United States" if present
        const filtered = parts.filter(p => !/^united states$/i.test(p));
        if (filtered.length >= 2) {
          market = filtered[0];
          submarket = filtered[1];
        } else if (filtered.length === 1) {
          market = filtered[0];
        }
      }
    }

    // ── 3. Page title parsing ──
    // Titles often: "Submarket Short-Term Rental Data | Market | AirDNA"
    // or "Market Short-Term Rental Data | AirDNA"
    if (!market) {
      const title = document.title || '';
      const titleParts = title.split('|').map(p => p.trim());
      if (titleParts.length >= 3) {
        // "Chelsea Short-Term Rental Data | New York, NY | AirDNA"
        const cleaned0 = titleParts[0].replace(/\s*(short[- ]?term\s+)?rental\s+data\s*$/i, '').trim();
        const cleaned1 = titleParts[1].replace(/\s*(short[- ]?term\s+)?rental\s+data\s*$/i, '').trim();
        if (cleaned1 && !/^airdna$/i.test(cleaned1)) {
          market = cleaned1;
          submarket = cleaned0 || null;
        } else if (cleaned0) {
          market = cleaned0;
        }
      } else if (titleParts.length === 2) {
        const cleaned0 = titleParts[0].replace(/\s*(short[- ]?term\s+)?rental\s+data\s*$/i, '').trim();
        if (cleaned0 && !/^airdna$/i.test(cleaned0)) {
          market = cleaned0;
        }
      }
    }

    // ── 4. URL path parsing ──
    // URLs: /data/us/<market-slug>/<submarket-slug>/overview
    // Slugs are like "new-york-ny" or "chelsea"
    if (!market) {
      const pathMatch = url.match(/\/data\/us\/([^/?]+)\/([^/?]+)/i);
      if (pathMatch) {
        const slug1 = pathMatch[1].replace(/^airdna-\d+$/, '');
        const slug2 = pathMatch[2].replace(/^airdna-\d+$/, '');
        // If slugs are "airdna-NNN" IDs, we can't extract names
        // But if they're human-readable slugs, convert them
        if (slug1 && !/^airdna-/.test(pathMatch[1])) {
          market = slug1.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
        if (slug2 && !/^airdna-/.test(pathMatch[2])) {
          submarket = slug2.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
      }
    }

    // ── 5. Body text: look for market/submarket in header area ──
    // AirDNA overview pages often show "Market Name" prominently
    if (!market) {
      const headings = document.querySelectorAll('h1, h2, h3');
      for (const h of headings) {
        const t = h.textContent.trim();
        // Match "City, ST" pattern (e.g. "New York, NY")
        const m = t.match(/^([A-Z][\w\s.'-]+),\s*([A-Z]{2})\b/);
        if (m) {
          market = m[1].trim() + ', ' + m[2];
          break;
        }
      }
    }

    // ── 6. Look for submarket in side nav / tabs ──
    if (market && !submarket) {
      // Check for active tab/nav item that might be the submarket
      const activeItems = document.querySelectorAll(
        '[class*="active"] a, [aria-current="page"], [class*="selected"]'
      );
      for (const el of activeItems) {
        const t = el.textContent.trim();
        if (t && t.length > 1 && t.length < 50 && t !== market) {
          submarket = t;
          break;
        }
      }
    }

    return { market, submarket, _type: 'market-lookup' };
  }

  function run(attempt) {
    try {
      const data = extract();
      if (data._loginRequired) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
      if (data.market || attempt >= 6) {
        chrome.runtime.sendMessage({ type: 'SCRAPE_RESULT', payload: data });
        return;
      }
    } catch (e) {
      if (attempt >= 6) {
        chrome.runtime.sendMessage({
          type: 'SCRAPE_RESULT',
          payload: { market: null, submarket: null, _type: 'market-lookup', error: e.message }
        });
        return;
      }
    }
    setTimeout(() => run(attempt + 1), 800);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 500);
  else window.addEventListener('load', () => setTimeout(() => run(0), 500), { once: true });
})();
