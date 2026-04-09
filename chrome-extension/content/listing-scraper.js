// Content script for rental listing sites: Zillow, Apartments.com, Hotpads, Facebook Marketplace.
// Dispatches to a per-site parser, then posts results back to the service worker.

(function () {
  if (window.__rrListingScraperRan) return;
  window.__rrListingScraperRan = true;

  const host = location.hostname.replace(/^www\./, '').toLowerCase();

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

  // ---- Zillow -----------------------------------------------------
  function parseZillow() {
    const out = base('zillow');
    // Zillow embeds state in #__NEXT_DATA__
    const nd = findJsonFromScript('__NEXT_DATA__');
    if (nd) {
      const gdp = deepFind(nd, (v) => v && typeof v === 'object' && v.price && (v.bedrooms != null || v.bathrooms != null));
      if (gdp) {
        out.price = num(gdp.price);
        out.bedrooms = num(gdp.bedrooms);
        out.bathrooms = num(gdp.bathrooms);
        out.sqft = num(gdp.livingArea);
        out.address = gdp.streetAddress
          ? [gdp.streetAddress, gdp.city, gdp.state, gdp.zipcode].filter(Boolean).join(', ')
          : null;
        out.description = (gdp.description || '').slice(0, 2000) || null;
        out.photoUrl = (gdp.hugePhotos && gdp.hugePhotos[0] && gdp.hugePhotos[0].url) ||
                       (gdp.photos && gdp.photos[0] && gdp.photos[0].url) || null;
      }
    }
    // Fallbacks via DOM
    if (out.price == null) out.price = num(document.querySelector('[data-testid="price"]')?.textContent);
    if (out.bedrooms == null) out.bedrooms = num(document.querySelector('[data-testid="bed-bath-sqft-fact-container"]')?.textContent);
    out.title = document.title;
    return out;
  }

  // ---- Apartments.com --------------------------------------------
  function parseApartments() {
    const out = base('apartments');
    out.title = document.querySelector('#propertyName')?.textContent?.trim() || document.title;
    out.address = [
      document.querySelector('.propertyAddressContainer .delivery-address')?.textContent?.trim(),
      document.querySelector('.propertyAddressContainer h2')?.textContent?.trim(),
    ].filter(Boolean).join(', ') || null;
    // Rent range / bed / bath appear in .priceGridModelWrapper or similar
    const rentEl = document.querySelector('.rentInfoDetail, .priceBedRangeInfoInnerContainer');
    if (rentEl) {
      const txt = rentEl.textContent;
      out.price = num(txt.match(/\$[\d,]+/)?.[0]);
      out.bedrooms = num(txt.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
      out.bathrooms = num(txt.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
      out.sqft = num(txt.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);
    }
    out.description = document.querySelector('#descriptionSection .descriptionContent')?.textContent?.trim()?.slice(0, 2000) || null;
    out.photoUrl = document.querySelector('.mainCarouselImage, .carouselContent img')?.src || null;
    return out;
  }

  // ---- Hotpads ---------------------------------------------------
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
    return out;
  }

  // ---- Facebook Marketplace --------------------------------------
  function parseFacebook() {
    const out = base('facebook');
    out.title = document.querySelector('h1')?.textContent?.trim() || document.title;
    // FB Marketplace is heavily obfuscated; best-effort scrape.
    const bodyText = document.body.innerText;
    const priceMatch = bodyText.match(/\$[\d,]+(?:\.\d{2})?/);
    if (priceMatch) out.price = num(priceMatch[0]);
    out.bedrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
    out.bathrooms = num(bodyText.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
    out.sqft = num(bodyText.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);
    out.description = null;
    out.photoUrl = document.querySelector('img[src*="scontent"]')?.src || null;
    out.warning = 'Facebook Marketplace listings have limited auto-fill accuracy. Please verify details.';
    return out;
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
    };
  }

  function deepFind(obj, pred, depth) {
    depth = depth || 0;
    if (depth > 12 || !obj || typeof obj !== 'object') return null;
    if (pred(obj)) return obj;
    for (const k of Object.keys(obj)) {
      const hit = deepFind(obj[k], pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // ---- Craigslist ------------------------------------------------
  function parseCraigslist() {
    const out = base('craigslist');
    out.title = document.querySelector('#titletextonly')?.textContent?.trim()
      || document.querySelector('.postingtitletext')?.textContent?.trim()
      || document.title;
    const priceTxt = document.querySelector('.price')?.textContent;
    out.price = num(priceTxt);

    // Attributes are in a group of <p class="attrgroup"> blocks
    const attrText = Array.from(document.querySelectorAll('.attrgroup span, .attrgroup'))
      .map((n) => n.textContent || '')
      .join(' | ');
    out.bedrooms = num(attrText.match(/(\d+(?:\.\d+)?)\s*BR/i)?.[1])
      || num(attrText.match(/(\d+(?:\.\d+)?)\s*bed/i)?.[1]);
    out.bathrooms = num(attrText.match(/(\d+(?:\.\d+)?)\s*Ba/i)?.[1])
      || num(attrText.match(/(\d+(?:\.\d+)?)\s*bath/i)?.[1]);
    out.sqft = num(attrText.match(/([\d,]+)\s*ft2/i)?.[1])
      || num(attrText.match(/([\d,]+)\s*sq\s*ft/i)?.[1]);

    // Address / neighborhood
    const mapAddr = document.querySelector('.mapaddress')?.textContent?.trim();
    const hood = document.querySelector('.postingtitletext small')?.textContent?.trim()
      ?.replace(/^[()\s]+|[()\s]+$/g, '');
    out.address = mapAddr || hood || null;

    out.description = document.querySelector('#postingbody')?.textContent
      ?.replace(/QR Code Link to This Post/i, '')
      .trim()
      .slice(0, 2000) || null;
    out.photoUrl = document.querySelector('.slide.first img, #thumbs a img, .gallery img')?.src || null;
    return out;
  }

  function parse() {
    if (host.endsWith('zillow.com')) return parseZillow();
    if (host.endsWith('apartments.com')) return parseApartments();
    if (host.endsWith('hotpads.com')) return parseHotpads();
    if (host.endsWith('facebook.com')) return parseFacebook();
    if (host.endsWith('craigslist.org')) return parseCraigslist();
    throw new Error('Unsupported host: ' + host);
  }

  function run(attempt) {
    try {
      const data = parse();
      const hasContent = data.title || data.price != null || data.bedrooms != null || data.address;
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
    setTimeout(() => run(attempt + 1), 750);
  }

  if (document.readyState === 'complete') setTimeout(() => run(0), 400);
  else window.addEventListener('load', () => setTimeout(() => run(0), 400), { once: true });
})();
