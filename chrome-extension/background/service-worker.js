// RentingRadar extension service worker (MV3 background)
//
// This version is a pure scrape service. It never authenticates to
// Firebase and never touches user credentials. Its only job is:
//
//   1. Listen for SCRAPE_URL messages (from the popup OR from the CRM)
//   2. Open the target URL in a background tab
//   3. Inject the appropriate content script (AirDNA or listing parser)
//   4. Wait for the scraped payload, close the tab
//   5. Return the payload to whoever asked
//
// When the source of the scrape was the popup, we additionally forward
// the payload to any open CRM tab so the CRM can consume it.

const CRM_ORIGIN = 'https://app.rentingradar.com';
const SCRAPE_TIMEOUT_MS = 45000;

// ------------------------------------------------------------------
// v0.10.0: Claude API (Haiku 4.5) — primary AI engine.
// Ollama (Gemma 3 4B) kept as free fallback if no API key is set.
// ------------------------------------------------------------------
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 45000;
async function getClaudeApiKey() {
  try { const obj = await chrome.storage.sync.get('rrClaudeApiKey'); return (obj && obj.rrClaudeApiKey) || null; } catch (_) { return null; }
}
async function setClaudeApiKey(key) { await chrome.storage.sync.set({ rrClaudeApiKey: key || '' }); }

// Ollama — free local fallback when no Claude API key is configured.
const OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'gemma3:4b';
const OLLAMA_TIMEOUT_MS = 30000;
const OLLAMA_KEEP_ALIVE = '60m';

// ------------------------------------------------------------------
// v0.8.0: Import cache REMOVED. Every import runs the full scraper +
// AI enrichment pipeline fresh. This ensures listing data is always
// current and eliminates stale-cache bugs (e.g. unit numbers missing
// because an older scrape was served). With the dictionary extractor
// providing deterministic amenity data and Ollama handling the fuzzy
// parts, re-imports of the same URL will still be highly consistent.
// ------------------------------------------------------------------
// Purge any leftover cache entries from older versions on startup.
(async function purgeAllCacheEntries() {
  try {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter(k => k.startsWith('rr_import_cache_'));
    if (stale.length) {
      await chrome.storage.local.remove(stale);
      console.log('[RR ext] purged', stale.length, 'legacy cache entries');
    }
  } catch (_) { /* best-effort */ }
})();

// Strip dynamic/relative content from page text so the LLM and dictionary
// extractor see a stable surface across re-imports. Zillow/Apartments.com/
// Hotpads all render "X days ago", "Posted 2 hours ago", view counters,
// and relative timestamps that drift between loads and poison caching
// + LLM determinism.
function normalizePageText(text) {
  let t = String(text || '');
  // Relative timestamps
  t = t.replace(/\b\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago\b/gi, '');
  t = t.replace(/\bposted\s+(just now|today|yesterday|\d+\s*(m|h|d|w|mo|y)\b)/gi, '');
  t = t.replace(/\bupdated\s+(just now|today|yesterday|\d+\s*(m|h|d|w|mo|y)\b)/gi, '');
  t = t.replace(/\blisted\s+(just now|today|yesterday|\d+\s*(m|h|d|w|mo|y)\b)/gi, '');
  // View/save counters
  t = t.replace(/\b\d{1,3}(,\d{3})*\s*(views?|saves?|favorites?|watchers?|applicants?)\b/gi, '');
  // Price-drop pill content ("Price reduced on 4/9")
  t = t.replace(/price (reduced|dropped|cut) on [0-9\/]+/gi, '');
  // "Last updated: Apr 9, 2026" — normalize away
  t = t.replace(/\b(last updated|updated on|posted on|listed on):?\s*[a-z]{3,9}\.?\s+\d{1,2},?\s*\d{0,4}/gi, '');
  // Collapse whitespace
  t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// ------------------------------------------------------------------
// Internal message router (popup + content scripts)
// ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'PING':
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
          return;

        case 'HEALTH': {
          // v0.10.0: Report AI engine status.
          const apiKey = await getClaudeApiKey();
          const h = await checkOllamaHealth();
          sendResponse({
            ok: true,
            version: chrome.runtime.getManifest().version,
            claude: { configured: !!apiKey, model: CLAUDE_MODEL },
            ollama: h,
          });
          return;
        }

        case 'SET_API_KEY': {
          // Store Claude API key from CRM settings
          await setClaudeApiKey(msg.key);
          sendResponse({ ok: true });
          return;
        }

        case 'GET_API_KEY': {
          const key = await getClaudeApiKey();
          sendResponse({ ok: true, key: key ? '••••' + key.slice(-4) : null });
          return;
        }

        case 'TEST_AI_PROXY': {
          // Test the AI proxy by asking the CRM to call the callable function
          try {
            const tabs = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
            if (!tabs.length) { sendResponse({ ok: false, error: 'no CRM tab' }); return; }
            let tested = false;
            for (const tab of tabs) {
              try {
                const resp = await chrome.tabs.sendMessage(tab.id, { type: 'TEST_AI_ENRICH' });
                sendResponse({ ok: !!(resp && resp.ok), error: resp && resp.error });
                tested = true;
                break;
              } catch (_) {}
            }
            if (!tested) sendResponse({ ok: false, error: 'CRM not responding' });
          } catch (e) {
            sendResponse({ ok: false, error: (e && e.message) || String(e) });
          }
          return;
        }

        case 'SCRAPE_URL': {
          // From the popup: scrape + forward to CRM tab
          const result = await scrapeAny(msg.url, msg.kind);
          if (result.ok && result.data) {
            await forwardToCrm(result.data);
          }
          sendResponse(result);
          return;
        }

        case 'SCRAPE_RESULT': {
          // Content script reporting back
          resolveScrape(sender.tab && sender.tab.id, msg.payload, msg.error);
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[RR ext] message handler error', e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async
});

// ------------------------------------------------------------------
// External messages (from the CRM page via externally_connectable)
// ------------------------------------------------------------------
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!sender.url || !sender.url.startsWith(CRM_ORIGIN)) {
        sendResponse({ ok: false, error: 'Unauthorized origin' });
        return;
      }
      switch (msg && msg.type) {
        case 'PING':
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
          return;

        case 'HEALTH': {
          // v0.10.0: Report AI engine status.
          const apiKey2 = await getClaudeApiKey();
          const h2 = await checkOllamaHealth();
          sendResponse({
            ok: true,
            version: chrome.runtime.getManifest().version,
            claude: { configured: !!apiKey2, model: CLAUDE_MODEL },
            ollama: h2,
          });
          return;
        }

        case 'SET_API_KEY': {
          await setClaudeApiKey(msg.key);
          sendResponse({ ok: true });
          return;
        }

        case 'GET_API_KEY': {
          const key2 = await getClaudeApiKey();
          sendResponse({ ok: true, key: key2 ? '••••' + key2.slice(-4) : null });
          return;
        }

        case 'TEST_AI_PROXY': {
          try {
            const tabs2 = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
            if (!tabs2.length) { sendResponse({ ok: false, error: 'no CRM tab' }); return; }
            let tested2 = false;
            for (const tab2 of tabs2) {
              try {
                const resp2 = await chrome.tabs.sendMessage(tab2.id, { type: 'TEST_AI_ENRICH' });
                sendResponse({ ok: !!(resp2 && resp2.ok), error: resp2 && resp2.error });
                tested2 = true;
                break;
              } catch (_) {}
            }
            if (!tested2) sendResponse({ ok: false, error: 'CRM not responding' });
          } catch (e2) {
            sendResponse({ ok: false, error: (e2 && e2.message) || String(e2) });
          }
          return;
        }

        case 'SCRAPE_URL': {
          // From the CRM: scrape and return result directly (no forwarding)
          const result = await scrapeAny(msg.url, msg.kind);
          sendResponse(result);
          return;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown external message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

// ------------------------------------------------------------------
// Detect which scraper to use and run it
// ------------------------------------------------------------------
async function scrapeAny(url, hint) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid URL' };
  }
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return { ok: false, error: 'Invalid URL' }; }

  let kind;
  if (hint === 'airdna' || /airdna\.co$/i.test(host)) kind = 'airdna';
  else if (/(zillow|apartments|hotpads)\.com$/i.test(host)) kind = 'listing';
  else if (/facebook\.com$/i.test(host) && /\/marketplace\//i.test(url)) kind = 'listing';
  else if (/craigslist\.org$/i.test(host)) kind = 'listing';
  else return { ok: false, error: 'Unsupported site. Supported: AirDNA, Zillow, Apartments.com, Hotpads, Facebook Marketplace, Craigslist.' };

  // v0.8.0: No import cache — every import runs the full pipeline fresh.
  const file = kind === 'airdna' ? 'content/airdna-scraper.js' : 'content/listing-scraper.js';
  try {
    const data = await scrapeInBackgroundTab(url, file);
    if (!data) return { ok: false, error: 'Could not read details from the page. Make sure you are signed in where required.' };
    // Tag the payload with its kind so the CRM knows how to route it
    data._kind = kind;

    // ----- v0.10.0: AI ENRICHMENT (Claude primary, Ollama fallback) -----
    // Dictionary extractor runs deterministically over the full page text,
    // then Claude/Ollama fills gaps (utilities, pets, bullets, core numbers
    // the scraper missed). All values are source-grounded against page text.
    if (kind === 'listing') {
      const enriched = await enrichWithOllama(data);
      // Merge AI-derived propertyDetails into scraper-provided ones
      const scraperPd = data.propertyDetails || {};
      data.propertyDetails = mergePropertyDetails(scraperPd, enriched.propertyDetails || {});
      // v0.6.4: Run post-merge grounding pass. The scraper's pd came from
      // JSON-LD and state blobs (trusted), but the merge above can introduce
      // LLM values that slipped through. One final groundPropertyDetails
      // sweep catches anything that shouldn't be there.
      // v0.11.0: Use _rawPageText (unfiltered) for grounding so utilities,
      // fees, and policies that were stripped from _fullPageText aren't
      // falsely rejected.
      const groundingText = normalizePageText(data._rawPageText || data._fullPageText || data._pageText || '');
      groundPropertyDetails(data.propertyDetails, groundingText);
      data.propertyNoteBullets = enriched.propertyNoteBullets || [];
      // Overlay AI-extracted core numbers only when the scraper missed them
      const core = enriched.core || {};
      if (core.bedrooms != null && (data.bedrooms == null || data.bedrooms === ''))
        data.bedrooms = core.bedrooms;
      if (core.bathrooms != null && (data.bathrooms == null || data.bathrooms === ''))
        data.bathrooms = core.bathrooms;
      if (core.sqft != null && (data.sqft == null || data.sqft === '' || data.sqft === 0))
        data.sqft = core.sqft;
      // price is NEVER overlaid from AI — scraper price is authoritative
      // Available date: prefer scraper (from JSON-LD / state blob), fall back to AI
      if (!data.propertyDetails.availableDate && core.availableDate) {
        data.propertyDetails.availableDate = core.availableDate;
      }
      data._aiEnriched = !enriched._aiError;
      data._aiModel = enriched._aiModel || 'unknown';
      if (enriched._aiError) data._aiError = enriched._aiError;
      // Strip raw page text from the payload sent to the CRM
      delete data._pageText;
      delete data._fullPageText;
      delete data._rawPageText;
    }

    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || 'Scrape failed.' };
  }
}

// ------------------------------------------------------------------
// Ollama health check — reports whether the daemon is running
// and whether the configured model is pulled. The matcher accepts
// the exact tag (e.g. "qwen2.5:7b") OR any tag in the same family
// (e.g. "qwen2.5:latest", "qwen2.5:7b-instruct") so users have some
// flexibility in how they pulled the model.
// ------------------------------------------------------------------
async function checkOllamaHealth() {
  const result = {
    running: false,
    modelInstalled: false,
    model: OLLAMA_MODEL,
    error: null,
    installedModels: [],
    // v0.6.2: when /api/tags aborts or errors but the daemon COULD be up
    // (common when it's mid-inference and tags is queued behind a generate
    // request), we don't know for sure if it's running. We set "unknown"
    // and let the caller try the chat request anyway rather than failing
    // the import with a scary "No response from Ollama" toast.
    unknown: false,
  };
  try {
    const ctrl = new AbortController();
    // v0.6.2: 15s — qwen3:4b can hold the HTTP worker for several seconds
    // while it's generating, so /api/tags queues behind it. Previously 8s
    // caused spurious "No response from Ollama" errors whenever the user
    // triggered a second import back-to-back.
    const t = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(OLLAMA_HOST + '/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) { result.error = 'HTTP ' + resp.status; result.unknown = true; return result; }
    result.running = true;
    const json = await resp.json();
    const models = (json && json.models) || [];
    result.installedModels = models.map((m) => (m && m.name) || '').filter(Boolean);
    // Family name = part before the first colon. e.g. OLLAMA_MODEL = "qwen2.5:7b"
    // → family = "qwen2.5". Accept any tag in that family.
    const family = OLLAMA_MODEL.split(':')[0];
    result.modelInstalled = result.installedModels.some((name) => {
      if (name === OLLAMA_MODEL) return true;
      if (name.startsWith(OLLAMA_MODEL + ':')) return true;
      const otherFamily = name.split(':')[0];
      return otherFamily === family;
    });
  } catch (e) {
    result.error = (e && e.message) || String(e);
    // v0.6.2: a thrown fetch error means one of: (a) daemon isn't running,
    // (b) daemon IS running but /api/tags aborted because the worker was
    // busy, (c) CORS / permission glitch. We can't distinguish. Mark the
    // result "unknown" so enrichWithOllama will try the chat request and
    // surface a real error if it fails.
    result.unknown = true;
  }
  return result;
}

// ------------------------------------------------------------------
// AI extraction — THE AUTHORITATIVE EXTRACTION PATH. The scraper
// provides the raw page text and the minimum structured data it can
// grab from JSON-LD; Claude (or Ollama fallback) reads the full page
// and produces ALL the listing fields including the core numbers
// (beds/baths/sqft/availability — NOT rent, which is scraper-only).
// If no AI is available the import uses the dictionary extractor only.
// ------------------------------------------------------------------
const OLLAMA_FIELD_OPTIONS = {
  propertyType: ['House','Apartment','Condo','Townhouse','Duplex','Triplex','Fourplex','Studio','Loft','Mobile Home','Villa','Cottage','Other'],
  furnished: ['Unfurnished','Furnished','Partially Furnished'],
  flooring: ['Hardwood','Carpet','Tile','Laminate','Vinyl Plank','Concrete','Marble','Stone','Mixed'],
  appliances: ['Dishwasher','Garbage Disposal','Microwave','Oven/Range (Gas)','Oven/Range (Electric)','Refrigerator','Ice Maker','Trash Compactor','Wine Cooler'],
  laundry: ['In-Unit W/D','W/D Hookups','Shared/On-Site','Stacked W/D','None'],
  ac: ['Central A/C','Window Unit','Mini-Split','Evaporative/Swamp Cooler','Portable','None'],
  heating: ['Central (Gas)','Central (Electric)','Baseboard','Radiator','Heat Pump','Space Heater','Fireplace','None'],
  interiorFeatures: ['Fireplace','Ceiling Fans','Walk-In Closets','High Ceilings','Vaulted Ceilings','Open Floor Plan','Natural Light','Crown Molding','Recessed Lighting','Smart Thermostat','Smart Locks','Built-In Shelving','Pantry','Kitchen Island','Breakfast Bar','Stainless Steel Appliances','Double Vanity','Soaking Tub','Walk-In Shower','Separate Tub/Shower','Linen Closet','Storage Unit','Window Blinds','Blackout Curtains'],
  parking: ['Attached Garage','Detached Garage','Carport','Covered Parking','Assigned Spot','Street Only','Driveway','Parking Garage','None'],
  pool: ['Private','Community/Shared','Heated Private','Heated Community','None'],
  outdoor: ['Balcony','Patio','Deck','Porch','Screened Porch','Sunroom','Rooftop','Courtyard','Lanai'],
  exteriorFeatures: ['Fenced Yard','Sprinkler System','Outdoor Lighting','Outdoor Kitchen/BBQ','Fire Pit','Garden Space','Shed/Outbuilding','RV Parking','Boat Parking','EV Charging','Gated Entry','Desert Landscaping','Pool Fence'],
  communityAmenities: ['Gym/Fitness Center','Clubhouse','Business Center','Package Lockers','Dog Park','Playground','Swimming Pool','Community Spa/Hot Tub','Sauna','Elevator','Concierge/Doorman','On-Site Management','On-Site Maintenance','Bike Storage','BBQ/Grill Area','Rooftop Lounge','Tennis Court','Pickleball Court'],
  utilitiesIncluded: ['Water','Hot Water','Gas','Electric','Trash','Sewer','Recycling','Internet/WiFi','Cable TV','Landscaping/Grounds','Pest Control'],
  petsAllowed: ['Cats Allowed','Dogs Allowed','Small Dogs Only','Small Pets Only','Case by Case','Service Animals Only','No Pets'],
  safetyFeatures: ['Smoke Detectors','Carbon Monoxide Detectors','Fire Extinguisher','Security System/Alarm','Gated Entry','Deadbolt Locks','Smart Locks','Security Cameras','24-Hour Security'],
};

// The CRM's Property Details section has two kinds of dropdowns:
//   - single-select (t:'select') → one value only
//   - multi-select (t:'multi')   → array of values
// Ollama returns both as JSON arrays, which causes rendering glitches and
// contradictions (e.g. "Attached Garage" AND "Covered Parking" in one cell).
// We enforce cardinality here when assembling the merged propertyDetails.
// v0.9.0: petsAllowed is now multi-select (e.g. ["Cats Allowed","Dogs Allowed"])
const OLLAMA_SINGLE_SELECT_FIELDS = new Set([
  'propertyType','furnished','laundry','ac','heating','parking','pool'
]);

// Normalize whatever the model returns for availableDate into a value the
// CRM's date picker can consume: either lowercase 'now', or ISO YYYY-MM-DD.
// Anything unrecognizable returns null so we simply don't store the field
// (preventing "undefined NaN" in the Contact & Status edit card).
function normalizeAvailableDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/^(now|available now|immediately|move[\s-]*in ready|ready now|asap|today)$/.test(lower)) {
    return 'now';
  }
  // ISO already: 2026-05-01
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
    return null;
  }
  // US slash: 5/1/2026 or 05/01/26
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    let y = +us[3]; if (y < 100) y += 2000;
    const m = +us[1], d = +us[2];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
    return null;
  }
  // "May 1", "May 1, 2026", "May 1st"
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
  const word = s.toLowerCase().match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
  if (word) {
    const mKey = word[1].slice(0, word[1].startsWith('sept') ? 4 : 3);
    const m = MONTHS[mKey];
    const d = +word[2];
    if (m && d >= 1 && d <= 31) {
      const now = new Date();
      let y = word[3] ? +word[3] : now.getFullYear();
      // If the date has already passed this year, assume next year
      if (!word[3]) {
        const guess = new Date(y, m - 1, d);
        if (guess < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y += 1;
      }
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
  }
  return null;
}

// Drop bullets that reference facts clearly not present in the page text.
// Small models will sometimes parrot the example bullets back ("Small pets
// allowed", "Water & trash included") even when they're not in the listing.
// We verify each bullet by checking that its key tokens actually appear in
// the source text; any bullet that fails the check gets dropped.
function filterHallucinatedBullets(bullets, pageText) {
  if (!Array.isArray(bullets) || !bullets.length) return bullets || [];
  const text = String(pageText || '').toLowerCase();
  if (!text) return bullets;
  const STOP = new Set(['the','a','an','and','or','of','with','to','in','on','at','by','for','is','are','be','has','have','from','as','it','this','that','these','those','per','mo','month','monthly','br','ba','sq','ft','bed','beds','bath','baths','bedroom','bedrooms','bathroom','bathrooms']);
  const out = [];
  for (const raw of bullets) {
    const bullet = String(raw || '').trim();
    if (!bullet) continue;
    // Extract "content" tokens: 4+ letter words, lowercased
    const tokens = (bullet.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [])
      .filter((t) => !STOP.has(t));
    if (!tokens.length) { out.push(bullet); continue; }
    // Count how many of the distinguishing tokens appear in the source.
    // Allow stemming: if "allowed" isn't found, try "allow".
    let hits = 0;
    for (const t of tokens) {
      if (text.includes(t)) { hits++; continue; }
      // crude stem
      const stem = t.replace(/(ing|ed|s|es)$/, '');
      if (stem.length >= 4 && text.includes(stem)) hits++;
    }
    // Keep the bullet if at least half of its distinguishing tokens are
    // sourced. This is loose enough to allow paraphrase ("steel appliances"
    // → "stainless steel kitchen") but tight enough to catch pure
    // hallucinations where NO key token appears in the source.
    const ratio = hits / tokens.length;
    if (ratio >= 0.5) out.push(bullet);
    else console.log('[RR ext] dropped unsourced bullet:', bullet, '(hits', hits, '/', tokens.length, ')');
  }
  return out;
}

// Drop bullets that just restate things already captured in the structured
// Property Details fields. Property Notes are reserved for value the
// dropdowns cannot capture — landmarks, neighborhood character, STR/investor
// angles. Anything that mentions rent, beds/baths, laundry type, A/C type,
// heat, parking, pool, pet policy, utilities, appliances, flooring, etc., is
// duplicate noise and gets dropped here even if the LLM produced it.
const DUPLICATIVE_BULLET_PATTERNS = [
  // Rent / price
  /\$\s*\d/, /\bper\s+(month|mo)\b/i, /\b\/\s*(month|mo)\b/i, /\bmonthly rent\b/i, /\brent (is|of)\b/i,
  // Beds / baths / sqft
  /\b\d+(\.\d+)?\s*(bed|bd|br|bath|ba|bedroom|bathroom)/i, /\bstudio\b/i, /\b\d{3,4}\s*(sq\.?\s*ft|sqft|square feet)\b/i,
  // Laundry
  /\b(washer|dryer|w\/d|laundry)\b/i,
  // A/C and heating
  /\b(central a\/?c|window unit|mini[- ]split|swamp cooler|portable a\/?c)\b/i,
  /\b(forced[- ]air|heat pump|baseboard heat|radiator|gas heat|electric heat|space heater|fireplace)\b/i,
  // Parking
  /\b(attached garage|detached garage|carport|covered parking|driveway|street parking|assigned spot|parking garage)\b/i,
  // Pool / hot tub
  /\b(swimming pool|community pool|private pool|heated pool|hot tub|spa)\b/i,
  // Pets
  /\b(pet|dog|cat|animal|pet[- ]friendly|no pets)\b/i,
  // Utilities included
  /\b(water|gas|electric|trash|sewer|internet|wifi|cable)\s+(included|included in rent|paid)\b/i,
  /\b(includes?|paid)\s+(water|gas|electric|trash|sewer|internet|wifi|cable)/i,
  // Appliances and flooring
  /\b(dishwasher|microwave|refrigerator|oven|range|stainless steel|garbage disposal|ice maker)\b/i,
  /\b(hardwood|carpet|tile|laminate|vinyl plank|concrete|marble|stone)\s*(floor|flooring)?/i,
  // Building amenities (already in communityAmenities)
  /\b(gym|fitness center|clubhouse|business center|package locker|dog park|playground|sauna|elevator|concierge|doorman|bike storage|tennis court|pickleball)\b/i,
  // Furnished status
  /\b(fully furnished|partially furnished|unfurnished|comes furnished)\b/i,
  // Interior/exterior features already captured
  /\b(walk[- ]in closet|vaulted ceiling|crown molding|recessed lighting|smart thermostat|granite|quartz)\b/i,
  /\b(fenced yard|sprinkler|outdoor kitchen|fire pit|ev charging|gated entry)\b/i,
];

// Allowed topic patterns. A bullet must hit at least one of these to be kept
// in Property Notes. This catches the case where the LLM produces something
// that isn't on the forbidden list but still isn't an "interesting" note.
const ALLOWED_BULLET_PATTERNS = [
  // Landmarks / attractions / proximity
  /\b(near|close to|next to|across from|steps from|walking distance|minutes? (?:from|to)|blocks? (?:from|to)|across the street)\b/i,
  /\b(park|beach|downtown|museum|university|college|school|stadium|arena|theater|theatre|district|waterfront|riverfront|lake|harbor|marina)\b/i,
  /\b(restaurants?|shops?|shopping|cafes?|nightlife|dining|bars?|grocery|supermarket|mall|market)\b/i,
  /\b(subway|metro|train station|bus stop|highway|airport|interstate|freeway)\b/i,
  // Neighborhood character
  /\b(neighborhood|community|residential|historic|vibrant|quiet|peaceful|tree[- ]lined|walkable|bustling|tucked away|sought[- ]after)\b/i,
  /\b(view|skyline|mountain|ocean|city|panoramic|sunset|sunrise)\b/i,
  // STR / investor angles
  /\b(short[- ]term rental|str|airbnb|vrbo|hoa|lease|rental rules|investor|renovat|remodel|updated in|built in|year built|new construction|new roof)\b/i,
  /\b(rooftop|terrace|balcony view|deck view)\b/i,
];

// Build a normalized fingerprint for a bullet so we can detect duplicates
// even when the model varies whitespace, punctuation, or trailing words.
// Examples that should collapse to the same fingerprint:
//   "Steps from Prospect Park"
//   "Steps from Prospect Park."
//   "  steps  from prospect park  "
function bulletFingerprint(bullet) {
  return String(bullet || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect "containment duplicates" — one bullet whose fingerprint is a
// substring of another. The longer (more detailed) bullet wins. Example:
//   "Close to Brooklyn College"
//   "Close to Brooklyn College and Prospect Park"
// → keep only the second.
function isContainedDuplicate(fp, allFps) {
  for (const other of allFps) {
    if (other === fp) continue;
    if (other.length > fp.length && other.includes(fp)) return true;
  }
  return false;
}

// v0.9.0: Lightweight dedup — only removes exact/contained duplicates.
// Does NOT filter by topic (the old DUPLICATIVE/ALLOWED pattern lists
// dropped too many valid bullets). The AI prompt already constrains
// bullet topics; we just catch literal duplication here.
function deduplicateBullets(bullets) {
  if (!Array.isArray(bullets) || !bullets.length) return bullets || [];
  const out = [];
  const seen = new Set();
  for (const raw of bullets) {
    const b = String(raw || '').trim();
    if (!b) continue;
    const fp = bulletFingerprint(b);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    out.push(b);
  }
  // Remove contained duplicates
  const allFps = out.map(b => bulletFingerprint(b));
  return out.filter((b, i) => !isContainedDuplicate(allFps[i], allFps));
}

function filterDuplicativeBullets(bullets) {
  if (!Array.isArray(bullets) || !bullets.length) return bullets || [];
  const out = [];
  const seen = new Set();
  for (const raw of bullets) {
    const b = String(raw || '').trim();
    if (!b) continue;
    // Drop if it matches any forbidden topic (already in Property Details)
    let dup = false;
    for (const re of DUPLICATIVE_BULLET_PATTERNS) {
      if (re.test(b)) { dup = true; break; }
    }
    if (dup) {
      console.log('[RR ext] dropped duplicative bullet:', b);
      continue;
    }
    // Require it to hit at least one allowed-topic pattern
    let allowed = false;
    for (const re of ALLOWED_BULLET_PATTERNS) {
      if (re.test(b)) { allowed = true; break; }
    }
    if (!allowed) {
      console.log('[RR ext] dropped off-topic bullet:', b);
      continue;
    }
    // Exact-fingerprint dedup — case/whitespace/punctuation insensitive
    const fp = bulletFingerprint(b);
    if (!fp) continue;
    if (seen.has(fp)) {
      console.log('[RR ext] dropped duplicate bullet:', b);
      continue;
    }
    seen.add(fp);
    out.push({ bullet: b, fp });
  }
  // Second pass: drop any bullet whose fingerprint is fully contained in
  // another bullet's fingerprint (the longer one is more informative).
  const allFps = out.map((o) => o.fp);
  const final = [];
  for (const o of out) {
    if (isContainedDuplicate(o.fp, allFps)) {
      console.log('[RR ext] dropped contained duplicate bullet:', o.bullet);
      continue;
    }
    final.push(o.bullet);
  }
  return final;
}

// Source-grounding for amenity enum values. Each allowed value (e.g.
// "Stainless Steel Appliances", "Attached Garage", "Swimming Pool") has
// a set of trigger phrases. If NONE of those phrases appear in the
// listing's page text, the model invented the value and we drop it.
// This is the strongest anti-hallucination guard we have — the Pass A/B
// prompts request grounding too, but small models still slip, so we
// verify here as a hard filter.
const AMENITY_SOURCE_TRIGGERS = {
  // Interior features
  'Fireplace': ['fireplace','firepl','wood burning','gas fire'],
  'Ceiling Fans': ['ceiling fan'],
  'Walk-In Closets': ['walk-in closet','walk in closet','walkin closet'],
  'High Ceilings': ['high ceiling','tall ceiling','9-foot','10-foot','9 ft ceiling','10 ft ceiling'],
  'Vaulted Ceilings': ['vaulted','cathedral ceiling'],
  'Open Floor Plan': ['open floor plan','open concept','open layout'],
  'Natural Light': ['natural light','sun-drenched','sun drenched','bright','sunlit','large windows','floor-to-ceiling window'],
  'Crown Molding': ['crown molding','crown moulding'],
  'Recessed Lighting': ['recessed light','can light','pot light'],
  'Smart Thermostat': ['smart thermostat','nest thermostat','ecobee'],
  'Smart Locks': ['smart lock','keyless entry'],
  'Built-In Shelving': ['built-in shelv','built in shelv','bookshel'],
  'Pantry': ['pantry'],
  'Kitchen Island': ['kitchen island','island'],
  'Breakfast Bar': ['breakfast bar','breakfast nook'],
  'Stainless Steel Appliances': ['stainless','stainless steel'],
  'Double Vanity': ['double vanity','dual vanity','his and hers'],
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
  'Oven/Range (Electric)': ['electric oven','electric range','electric stove','oven','range','stove','cooktop'],
  'Refrigerator': ['refrigerator','fridge'],
  'Ice Maker': ['ice maker','icemaker'],
  'Trash Compactor': ['trash compactor','compactor'],
  'Wine Cooler': ['wine cooler','wine fridge'],
  // Flooring
  'Hardwood': ['hardwood','wood floor'],
  'Carpet': ['carpet'],
  'Tile': ['tile floor','ceramic tile','porcelain tile','tiled'],
  'Laminate': ['laminate'],
  'Vinyl Plank': ['vinyl plank','lvp','luxury vinyl'],
  'Concrete': ['concrete floor','polished concrete'],
  'Marble': ['marble floor'],
  'Stone': ['stone floor','slate floor','travertine'],
  'Mixed': [],
  // Laundry (single)
  'In-Unit W/D': ['in-unit washer','in unit washer','in-unit w/d','washer/dryer in','washer and dryer in','w/d in unit'],
  'W/D Hookups': ['hookup','w/d hookup','washer hookup','dryer hookup'],
  'Shared/On-Site': ['shared laundry','on-site laundry','on site laundry','laundry room','laundry on site','community laundry'],
  'Stacked W/D': ['stacked washer','stacked w/d'],
  // A/C (single). v0.6.3: "air conditioning" and bare "a/c" now trigger
  // Central A/C as a safe default when no more-specific type is stated.
  // The section-routing in parseApartments takes precedence when the
  // listing's Apartment Features DOM section names the type explicitly.
  'Central A/C': ['central a/c','central ac','central air','air conditioning','air conditioner','air-conditioning','air-conditioned','air conditioned','a/c'],
  'Window Unit': ['window unit','window a/c','window ac'],
  'Mini-Split': ['mini-split','mini split','ductless'],
  'Evaporative/Swamp Cooler': ['swamp cooler','evaporative cooler'],
  'Portable': ['portable a/c','portable ac'],
  // Heating (single)
  'Central (Gas)': ['central heat','gas heat','gas furnace','forced air gas','gas heating','central heating'],
  'Central (Electric)': ['electric heat','electric furnace','heat pump','forced air electric'],
  'Baseboard': ['baseboard heat','baseboard'],
  'Radiator': ['radiator','steam heat'],
  'Heat Pump': ['heat pump'],
  'Space Heater': ['space heater'],
  // Parking (single)
  'Attached Garage': ['attached garage','attached 1-car','attached 2-car','attached two-car'],
  'Detached Garage': ['detached garage'],
  'Carport': ['carport'],
  'Covered Parking': ['covered parking','covered spot','covered space'],
  'Assigned Spot': ['assigned parking','assigned spot','reserved parking','reserved spot'],
  'Street Only': ['street parking','on-street parking','on street parking'],
  'Driveway': ['driveway'],
  'Parking Garage': ['parking garage','garage parking'],
  // Pool (single)
  'Private': ['private pool','own pool','backyard pool','in-ground pool'],
  'Community/Shared': ['community pool','shared pool','pool access','building pool','complex pool'],
  'Heated Private': ['heated pool'],
  'Heated Community': ['heated community pool','heated shared pool'],
  // Outdoor
  'Balcony': ['balcony','balconies'],
  'Patio': ['patio'],
  'Deck': ['deck'],
  'Porch': ['porch'],
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
  'EV Charging': ['ev charg','electric vehicle charg','tesla charg'],
  'Gated Entry': ['gated','gate entry','gated community'],
  'Desert Landscaping': ['desert landscap','xeriscap'],
  'Pool Fence': ['pool fence'],
  // Community amenities
  'Gym/Fitness Center': ['gym','fitness center','fitness room','workout'],
  'Clubhouse': ['clubhouse','club house'],
  'Business Center': ['business center','business lounge'],
  'Package Lockers': ['package locker','parcel locker','amazon locker','luxer'],
  'Dog Park': ['dog park','dog run'],
  'Playground': ['playground','play area'],
  'Swimming Pool': ['pool','swimming'],
  'Community Spa/Hot Tub': ['hot tub','spa','jacuzzi'],
  'Sauna': ['sauna'],
  'Elevator': ['elevator','lift'],
  'Concierge/Doorman': ['concierge','doorman','front desk'],
  'On-Site Management': ['on-site management','on site management','on-site manager'],
  'On-Site Maintenance': ['on-site maintenance','on site maintenance'],
  'Bike Storage': ['bike storage','bicycle storage','bike room'],
  'BBQ/Grill Area': ['bbq','barbecue','grill area','grilling station'],
  'Rooftop Lounge': ['rooftop lounge','rooftop deck','sky lounge','rooftop terrace'],
  'Tennis Court': ['tennis court','tennis'],
  'Pickleball Court': ['pickleball'],
  // Utilities included — triggers include contextual phrases. Bare words
  // like "water" are too loose (match "water heater", "waterfront", other
  // listings' utilities). Use "utilities included" as a section-level trigger.
  'Water': ['water included','includes water','water is included','utilities included'],
  'Hot Water': ['hot water included','includes hot water','hot water is included','hot water'],
  'Gas': ['gas included','includes gas','heat included','heating included','heat and hot water included','includes heat'],
  'Electric': ['electric included','electricity included','includes electric'],
  'Trash': ['trash included','garbage included','includes trash','trash removal'],
  'Sewer': ['sewer included','includes sewer'],
  'Recycling': ['recycling included'],
  'Internet/WiFi': ['internet included','wifi included','wi-fi included','includes wifi'],
  'Cable TV': ['cable included','cable tv included'],
  'Landscaping/Grounds': ['landscaping included','grounds maintenance'],
  'Pest Control': ['pest control included','pest control'],
  // Pets
  // v0.9.0: Pet policy is now multi-select. Each type triggers independently.
  'Cats Allowed': ['cats allowed','cats welcome','cats ok','cats permitted','cat friendly'],
  'Dogs Allowed': ['dogs allowed','dogs welcome','dogs ok','dogs permitted','dog friendly','pets allowed','pets welcome','pet friendly','pet-friendly'],
  'Small Dogs Only': ['small dogs only','small dogs allowed','small dogs'],
  'Small Pets Only': ['small pets','small animal'],
  'Case by Case': ['case by case','case-by-case','upon approval','with approval'],
  'Service Animals Only': ['service animal'],
  'No Pets': ['no pets','pets not allowed','pet free','pet-free'],
  // Safety
  'Smoke Detectors': ['smoke detector','smoke alarm'],
  'Carbon Monoxide Detectors': ['carbon monoxide','co detector'],
  'Fire Extinguisher': ['fire extinguisher'],
  'Security System/Alarm': ['security system','alarm system','burglar alarm'],
  'Deadbolt Locks': ['deadbolt'],
  'Security Cameras': ['security camera','cctv','surveillance'],
  '24-Hour Security': ['24-hour security','24 hour security','24/7 security'],
  // Property type (single-select)
  'House': ['single family','single-family','sfh',' house ','house for rent','home for rent','detached home'],
  'Apartment': ['apartment',' apt '],
  'Condo': ['condo','condominium'],
  'Townhouse': ['townhouse','townhome','town house','town home'],
  'Duplex': ['duplex'],
  'Triplex': ['triplex'],
  'Fourplex': ['fourplex','quadplex','4-plex','four-plex'],
  'Studio': ['studio apartment','studio for rent','studio unit',' studio '],
  'Loft': ['loft'],
  'Mobile Home': ['mobile home','manufactured home'],
  'Villa': ['villa'],
  'Cottage': ['cottage','casita'],
  // Furnished (single-select). Order matters in the extractor below:
  // "partially furnished" and "unfurnished" must be checked BEFORE the
  // bare "furnished" trigger so we don't misclassify them.
  'Partially Furnished': ['partially furnished','partly furnished','semi-furnished','semi furnished'],
  'Unfurnished': ['unfurnished','not furnished'],
  'Furnished': ['fully furnished','comes furnished','furnished '],
};

// ------------------------------------------------------------------
// DETERMINISTIC DICTIONARY EXTRACTOR
// ------------------------------------------------------------------
// This is the foundation of import consistency. Given the same page
// text, it produces the same propertyDetails object EVERY TIME — no
// LLM involvement, no randomness, no drift.
//
// The LLM is still used for the fuzzy parts (core numbers, narrative
// bullets, availability date) where dictionary matching is too brittle,
// but the structured Property Details fields are now decided here.
//
// Field type assumptions (matched to the CRM's PROP_SECTIONS schema):
//   - propertyType, furnished, laundry, ac, heating, parking, pool
//     → single-select (one string value)
//   - flooring, appliances, interiorFeatures, outdoor, exteriorFeatures,
//     communityAmenities, utilitiesIncluded, safetyFeatures, petsAllowed
//     → multi-select (array of values)
//
// Priority lists (reused for single-select tie-breaking) decide which
// value wins when multiple candidates all match the source text.
// ------------------------------------------------------------------
const FIELD_VALUE_PRIORITY = {
  propertyType: ['Studio','Loft','Townhouse','Duplex','Triplex','Fourplex','Condo','Apartment','House','Villa','Cottage','Mobile Home','Other'],
  furnished:    ['Partially Furnished','Furnished','Unfurnished'],
  parking:      ['Attached Garage','Detached Garage','Parking Garage','Carport','Assigned Spot','Driveway','Covered Parking','Street Only','None'],
  pool:         ['Heated Private','Private','Heated Community','Community/Shared','None'],
  laundry:      ['In-Unit W/D','Stacked W/D','W/D Hookups','Shared/On-Site','None'],
  ac:           ['Central A/C','Mini-Split','Window Unit','Portable','Evaporative/Swamp Cooler','None'],
  heating:      ['Central (Gas)','Central (Electric)','Heat Pump','Radiator','Baseboard','Fireplace','Space Heater','None'],
  // petsAllowed is now multi-select — no priority needed
};

// All the fields the extractor owns. The LLM can still suggest values
// for these, but the dictionary result is authoritative.
const EXTRACTOR_FIELDS = [
  // Single-select
  'propertyType','furnished','laundry','ac','heating','parking','pool','petsAllowed',
  // Multi-select
  'flooring','appliances','interiorFeatures','outdoor','exteriorFeatures','communityAmenities','utilitiesIncluded','safetyFeatures',
];

// Full allowed-value list per field. Extends OLLAMA_FIELD_OPTIONS with
// the new propertyType + furnished enums.
const EXTRACTOR_FIELD_OPTIONS = Object.assign({}, OLLAMA_FIELD_OPTIONS, {
  propertyType: ['House','Apartment','Condo','Townhouse','Duplex','Triplex','Fourplex','Studio','Loft','Mobile Home','Villa','Cottage','Other'],
  furnished:    ['Unfurnished','Furnished','Partially Furnished'],
});

// Does any trigger for this value appear in the (lowercased) source text?
function valueInText(value, lowerText) {
  const triggers = AMENITY_SOURCE_TRIGGERS[value];
  if (triggers && triggers.length) {
    for (const t of triggers) if (lowerText.includes(t)) return true;
    return false;
  }
  return false;
}

// Main extractor. Returns a propertyDetails object built purely from
// the page text — no LLM. Identical text → identical output.
function extractPropertyDetailsFromText(fullPageText) {
  const pd = {};
  const text = String(fullPageText || '').toLowerCase();
  if (!text) return pd;

  const SINGLE = OLLAMA_SINGLE_SELECT_FIELDS;

  for (const field of EXTRACTOR_FIELDS) {
    const options = EXTRACTOR_FIELD_OPTIONS[field] || [];
    // Gather every allowed value whose triggers appear in the source.
    const matched = options.filter((v) => valueInText(v, text));

    if (!matched.length) continue;

    if (SINGLE.has(field)) {
      // Pick the highest-priority match
      const priority = FIELD_VALUE_PRIORITY[field];
      let picked = null;
      if (priority) {
        for (const p of priority) if (matched.includes(p)) { picked = p; break; }
      }
      if (!picked) picked = matched[0];
      // Special-case furnished: the bare word "furnished" appears inside
      // "unfurnished" and "partially furnished", so we trust the priority
      // ranking above (Partially Furnished → Furnished → Unfurnished)
      // ONLY if the specific trigger matched. The priority list already
      // handles this correctly — no extra work needed here.
      pd[field] = picked;
    } else {
      pd[field] = matched.slice();
    }
  }

  // v0.9.0: petsAllowed is multi-select — no combo logic needed.
  // Both "Cats Allowed" and "Dogs Allowed" coexist naturally in the array.

  // v0.9.0: Utility false-positive guard. "water included" is a
  // substring of "hot water included", so the Water trigger fires even
  // when only hot water is mentioned. Check if every "water included"
  // occurrence is actually preceded by "hot " — if so, drop Water and
  // keep only Hot Water.
  if (Array.isArray(pd.utilitiesIncluded) &&
      pd.utilitiesIncluded.includes('Water') &&
      pd.utilitiesIncluded.includes('Hot Water')) {
    // Check if "water included" ever appears WITHOUT "hot" before it
    const waterRe = /(?<!hot\s)water\s+included/gi;
    if (!waterRe.test(text)) {
      pd.utilitiesIncluded = pd.utilitiesIncluded.filter(u => u !== 'Water');
    }
  }

  return pd;
}

// Merge LLM-extracted Property Details INTO the dictionary extraction.
// The dictionary is authoritative — LLM values are only added when the
// dictionary didn't find anything for that field, and every LLM value
// must itself pass the source-grounding check.
function mergeLlmIntoDictionary(dictPd, llmPd, lowerText) {
  if (!llmPd || typeof llmPd !== 'object') return dictPd;
  const SINGLE = OLLAMA_SINGLE_SELECT_FIELDS;
  for (const k of Object.keys(llmPd)) {
    const llmVal = llmPd[k];
    if (llmVal == null || llmVal === '' || (Array.isArray(llmVal) && !llmVal.length)) continue;
    if (SINGLE.has(k)) {
      // Dictionary wins for single-select
      if (dictPd[k]) continue;
      if (typeof llmVal === 'string' && valueInText(llmVal, lowerText)) {
        dictPd[k] = llmVal;
      }
    } else {
      // Multi-select: union dictionary + LLM values.
      // v0.9.0: For values WITH triggers (predefined), require grounding.
      // For values WITHOUT triggers (custom from AI), use a lenient check:
      // at least one content word must appear in the source text.
      const existing = Array.isArray(dictPd[k]) ? dictPd[k] : [];
      const addition = Array.isArray(llmVal) ? llmVal : [llmVal];
      // Case-insensitive dedup: prefer the existing (predefined) casing
      const existingLower = new Set(existing.map(v => String(v).toLowerCase()));
      const deduped = existing.concat(addition.filter(v => !existingLower.has(String(v).toLowerCase())));
      const merged = deduped
        .filter((v) => {
          if (valueInText(v, lowerText)) return true;
          // Lenient fallback for custom values: any 4+ letter word present?
          if (!AMENITY_SOURCE_TRIGGERS[v]) {
            const words = String(v).toLowerCase().replace(/[/()-]/g, ' ').match(/[a-z]{4,}/g) || [];
            return words.length === 0 || words.some(w => lowerText.includes(w));
          }
          return false;
        });
      if (merged.length) dictPd[k] = merged;
    }
  }
  return dictPd;
}

// Verify a single amenity value is grounded in the listing text. Returns
// true if any of its triggers appear. Values we don't have triggers for
// fall back to a generic "key word appears in text" check.
function isAmenityInSource(value, text) {
  if (typeof value !== 'string' || !value) return false;
  if (!text) return false;
  const triggers = AMENITY_SOURCE_TRIGGERS[value];
  if (triggers && triggers.length) {
    for (const t of triggers) if (text.includes(t)) return true;
    return false;
  }
  // v0.6.4: TIGHTENED fallback. Previously required only ONE 4-letter word
  // from the value label to appear in the source, which let through false
  // positives like "Elevator" matching "elevator pitch" in a description,
  // or "Swimming Pool" matching "pool" in a "carpool" mention. Now:
  //   - "None" always passes (it's an absence assertion)
  //   - Values with 1 content word: that word must appear as a whole word
  //     (bounded by non-alpha) in the source, not just as a substring
  //   - Values with 2+ content words: at least 2 must appear in the source
  // This dramatically reduces false positives from incidental word matches
  // in navigation, footer, and "similar listings" text.
  if (value === 'None') return true;
  const words = value.toLowerCase().replace(/[/()-]/g, ' ').match(/[a-z]{3,}/g) || [];
  if (!words.length) return true;
  if (words.length === 1) {
    // Single-word value: require whole-word match to avoid substring false positives
    const re = new RegExp('\\b' + words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return re.test(text);
  }
  // Multi-word value: require at least 2 words present
  const hits = words.filter((w) => text.includes(w));
  return hits.length >= 2;
}

// Strip any values from the merged propertyDetails that aren't traceable
// to the listing's page text. This is applied to Pass A + Pass B outputs.
function groundPropertyDetails(pd, fullPageText) {
  const text = String(fullPageText || '').toLowerCase();
  if (!text || !pd || typeof pd !== 'object') return;
  // availableDate + numeric fields are handled elsewhere; petsAllowed is
  // now multi-select (array) and grounded via the array path below.
  const SKIP = new Set(['availableDate','latitude','longitude']);
  // v0.11.0: If the page has a "utilities included" section, trust utility
  // values from the AI without requiring each one to pass individual
  // grounding — the section heading is sufficient context.
  const hasUtilitiesSection = /utilities?\s*included/i.test(text);
  for (const k of Object.keys(pd)) {
    if (SKIP.has(k)) continue;
    // Trust utilities if the page has a "utilities included" section
    if (k === 'utilitiesIncluded' && hasUtilitiesSection) continue;
    const v = pd[k];
    if (Array.isArray(v)) {
      const kept = v.filter((x) => isAmenityInSource(x, text));
      if (kept.length) pd[k] = kept;
      else { delete pd[k]; console.log('[RR ext] grounded: dropped empty', k); }
      const dropped = v.filter((x) => !kept.includes(x));
      if (dropped.length) console.log('[RR ext] grounded: dropped', k, dropped);
    } else if (typeof v === 'string') {
      // Only apply to known amenity fields
      if (OLLAMA_FIELD_OPTIONS[k] || k === 'pool' || k === 'parking' || k === 'laundry' || k === 'ac' || k === 'heating' || k === 'hotTub') {
        if (!isAmenityInSource(v, text)) {
          delete pd[k];
          console.log('[RR ext] grounded: dropped', k, '=', v);
        }
      }
    }
  }
}

// For single-select fields, when the model hands us multiple candidates,
// pick the one that's (a) most specific and (b) actually mentioned in the
// source text. Falls back to the first allowed value.
function pickBestSingleValue(field, candidates, pageText) {
  const text = String(pageText || '').toLowerCase();
  // Per-field priority: more specific values come first.
  const PRIORITY = {
    parking: ['Attached Garage','Detached Garage','Parking Garage','Carport','Assigned Spot','Driveway','Covered Parking','Street Only','None'],
    pool:    ['Heated Private','Private','Heated Community','Community/Shared','None'],
    laundry: ['In-Unit W/D','Stacked W/D','W/D Hookups','Shared/On-Site','None'],
    ac:      ['Central A/C','Mini-Split','Window Unit','Portable','Evaporative/Swamp Cooler','None'],
    heating: ['Central (Gas)','Central (Electric)','Heat Pump','Radiator','Baseboard','Fireplace','Space Heater','None'],
  };
  // Prefer candidates whose text actually appears in the source.
  const sourced = candidates.filter((c) => {
    const firstWord = c.toLowerCase().split(/[\s(/]/)[0];
    return firstWord && text.includes(firstWord);
  });
  const pool = sourced.length ? sourced : candidates;
  const ranking = PRIORITY[field];
  if (ranking) {
    for (const v of ranking) if (pool.includes(v)) return v;
  }
  return pool[0];
}

// Cross-check single-select dropdowns against multi-select amenity lists
// and correct the obvious contradictions. This keeps the Property Details
// UI from showing "Pool: None" next to a "Swimming Pool" chip in the
// Community Amenities list.
function resolvePropertyDetailsContradictions(pd) {
  if (!pd || typeof pd !== 'object') return;
  const comm = Array.isArray(pd.communityAmenities) ? pd.communityAmenities : [];
  const ext  = Array.isArray(pd.exteriorFeatures) ? pd.exteriorFeatures : [];

  // Pool: community has Swimming Pool → must be Community/Shared (unless already specific/private)
  if (comm.includes('Swimming Pool')) {
    if (!pd.pool || pd.pool === 'None') pd.pool = 'Community/Shared';
  }
  // Hot tub / spa
  if (comm.includes('Community Spa/Hot Tub')) {
    if (!pd.hotTub || pd.hotTub === 'None') pd.hotTub = 'Community/Shared';
  }
  // Parking: if exterior mentions gated entry + community has garage, keep single-select parking as-is.
  // But if parking === 'None' and community has any parking-ish amenity, clear 'None'.
  if (pd.parking === 'None') {
    if (comm.includes('Bike Storage') || /garage|parking/i.test(comm.join(' '))) {
      delete pd.parking; // let the user decide rather than lying
    }
  }
  // Pet policy: if petsAllowed is ["No Pets"] but the amenities mention a dog park, something's wrong — drop the contradictory value.
  if (Array.isArray(pd.petsAllowed) && pd.petsAllowed.length === 1 && pd.petsAllowed[0] === 'No Pets' && comm.includes('Dog Park')) {
    delete pd.petsAllowed;
  }
  // Laundry: community has "On-Site Laundry" and laundry is missing → reflect it
  if (!pd.laundry && comm.includes('On-Site Laundry')) {
    pd.laundry = 'Shared/On-Site';
  }
  // A/C "None" but interior features list mentions "Smart Thermostat" is fine — don't flag.
}

// ------------------------------------------------------------------
// v0.10.0: AI ENRICHMENT — server proxy primary, direct API fallback,
// Ollama last resort.
// ------------------------------------------------------------------
// This function ALWAYS returns a result, never throws. If all AI
// paths fail, the dictionary extractor's output is still returned.

// Server-side proxy: calls the aiEnrich Cloud Function via the CRM page's
// Firebase SDK (httpsCallable). This uses Firebase's onCall protocol which
// handles auth automatically and bypasses IAM invoker restrictions.
// The extension sends a message to the CRM content bridge, which relays
// it to the page, which calls firebase.functions().httpsCallable('aiEnrich').

async function callClaudeProxy(systemPrompt, userPrompt) {
  const tabs = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
  if (!tabs.length) throw new Error('No CRM tab open — cannot call AI proxy');

  // Ask the CRM page to call the Cloud Function via Firebase SDK
  for (const tab of tabs) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: 'CALL_AI_ENRICH',
        data: { systemPrompt, userPrompt },
      });
      if (resp && resp.ok && resp.result) return resp.result;
      if (resp && resp.error) throw new Error('AI proxy: ' + resp.error);
    } catch (e) {
      if (e.message && e.message.includes('AI proxy')) throw e;
      // Tab might not have content script, try next
    }
  }
  throw new Error('No authenticated CRM tab responded');
}

// Direct Claude API call — fallback when user has their own API key
async function callClaude(apiKey, systemPrompt, userPrompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const resp = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('Claude API HTTP ' + resp.status + (body ? ': ' + body.slice(0, 200) : ''));
    }
    const json = await resp.json();
    const content = json && json.content && json.content[0] && json.content[0].text;
    if (!content) throw new Error('Empty response from Claude API');
    try { return JSON.parse(content); }
    catch (_) {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Claude API did not return JSON');
      return JSON.parse(m[0]);
    }
  } finally { clearTimeout(t); }
}

async function callOllamaLegacy(sysPrompt, userPrompt, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(OLLAMA_HOST + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          // v0.9.0: Gemma 3 4B — slightly warm sampling to avoid EOS traps.
          // Gemma is more stable than Qwen3 at low temps so we can keep this
          // close to deterministic.
          temperature: 0.15, top_k: 30, top_p: 0.95,
          repeat_penalty: 1.0, seed: 20260410,
          // 8192 ctx for Gemma 3 — the model supports up to 128K but 8K
          // is plenty for our ~3K prompt + ~1K response and avoids slow
          // context init on constrained machines.
          num_ctx: 8192, num_predict: 800,
        },
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('Ollama HTTP ' + resp.status + (body ? ': ' + body.slice(0, 200) : ''));
    }
    const json = await resp.json();
    const content = json && json.message && json.message.content;
    if (!content) throw new Error('Empty response from Ollama');
    // Strip any thinking blocks (Qwen3 compat) and markdown fences
    let cleaned = String(content)
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json\s*/gi, '').replace(/```\s*/gi, '')
      .trim();
    try { return JSON.parse(cleaned); }
    catch (_) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Ollama did not return JSON');
      return JSON.parse(m[0]);
    }
  } finally { clearTimeout(t); }
}

async function enrichWithOllama(scraped) {
  const llmSnippet = normalizePageText(scraped._pageText || '');
  const fullPageText = normalizePageText(scraped._fullPageText || scraped._pageText || '');
  const lowerFullText = fullPageText.toLowerCase();
  const earlyDict = () => {
    const pd = extractPropertyDetailsFromText(fullPageText);
    return {
      propertyDetails: pd,
      propertyNoteBullets: [],
      core: { bedrooms: null, bathrooms: null, sqft: null, price: null, availableDate: null },
    };
  };

  // ----- DICTIONARY-FIRST EXTRACTION -----
  const dictPropertyDetails = extractPropertyDetailsFromText(fullPageText);
  console.log('[RR ext] dictionary extractor produced:', Object.keys(dictPropertyDetails));

  const scraperHints = {
    source: scraped.source || '',
    address: scraped.address || '',
    beds: scraped.bedrooms,
    baths: scraped.bathrooms,
    sqft: scraped.sqft,
    price: scraped.price,
  };

  // v0.11.0: Use the raw unfiltered page text so the AI sees EVERYTHING on
  // the listing — utilities, fees, policies, amenities — just like a human
  // reading the page. Falls back to filtered text if raw isn't available.
  const rawPageText = normalizePageText(scraped._rawPageText || '');
  const pageTextFull = (rawPageText || fullPageText || llmSnippet).slice(0, 30000);

  // ----- v0.10.0: CLAUDE-OPTIMIZED EXTRACTION PROMPT -----
  // Structured system prompt for accurate extraction + investor-grade notes.
  // Claude follows instructions precisely — no hallucination guards needed
  // in the prompt itself (post-processing still catches edge cases).
  const systemPrompt =
`You are a rental property data extraction engine for a Rental Arbitrage CRM.
Your user is NOT a renter — they are a short-term rental (STR) investor evaluating properties for Airbnb/VRBO arbitrage potential.

STRICT RULES:
1. Read the ENTIRE listing text from start to finish before extracting. Details like utilities, amenities, and fees often appear in different sections — do not stop reading early.
2. Extract ONLY facts about THIS SPECIFIC PROPERTY. The page text may contain fragments from "Similar Listings", "Nearby Apartments", "Recommended" sections, or other properties — IGNORE ALL OF THOSE. Only extract data that clearly belongs to the primary listing being described.
3. Extract ONLY facts explicitly stated in the listing text. If a detail is not mentioned, OMIT that field entirely.
4. Never infer, assume, or fabricate any detail. "Not mentioned" means OMIT, not guess.
5. Return ONLY a single JSON object — no markdown, no commentary, no explanation.
6. Every value you return must be directly traceable to specific text in the PRIMARY listing — not from nearby/similar/recommended properties.
7. Be EXHAUSTIVE for the primary listing — capture every single detail mentioned. Missing a stated fact is as bad as fabricating one.
8. PAY SPECIAL ATTENTION to pet policy — only include pets allowed/not allowed if the PRIMARY listing explicitly states it. Do not confuse pet policies from other listings on the page.`;

  const userPrompt =
`The scraper already extracted these core facts (use as context, not as source):
${JSON.stringify(scraperHints)}

LISTING TEXT:
"""
${pageTextFull}
"""

Extract all property details into this JSON structure. OMIT any field not mentioned in the listing.

{
  "bedrooms": <int 0-20>,
  "bathrooms": <number, use .5 for half baths>,
  "sqft": <int>,
  "availableDate": "Now" or "YYYY-MM-DD",
  "propertyType": "<one of: ${OLLAMA_FIELD_OPTIONS.propertyType.join(', ')}>",
  "furnished": "<one of: ${OLLAMA_FIELD_OPTIONS.furnished.join(', ')}>",
  "flooring": ["<strings>"],
  "appliances": ["<strings>"],
  "laundry": "<one of: ${OLLAMA_FIELD_OPTIONS.laundry.join(', ')}>",
  "ac": "<one of: ${OLLAMA_FIELD_OPTIONS.ac.join(', ')}>",
  "heating": "<one of: ${OLLAMA_FIELD_OPTIONS.heating.join(', ')}>",
  "interiorFeatures": ["<strings>"],
  "parking": "<one of: ${OLLAMA_FIELD_OPTIONS.parking.join(', ')}>",
  "pool": "<one of: ${OLLAMA_FIELD_OPTIONS.pool.join(', ')}>",
  "outdoor": ["<strings>"],
  "exteriorFeatures": ["<strings>"],
  "communityAmenities": ["<strings>"],
  "utilitiesIncluded": ["<strings>"],
  "petsAllowed": ["<strings>"],
  "safetyFeatures": ["<strings>"],
  "depositAmount": "<string e.g. '$2,499'>",
  "bullets": ["<3-8 strings>"]
}

FIELD RULES:

MULTI-SELECT FIELDS — use these predefined values when they match exactly. If the listing mentions something NOT in these lists, add it as a custom value using the listing's exact wording:
- flooring: ${OLLAMA_FIELD_OPTIONS.flooring.join(', ')}
- appliances: ${OLLAMA_FIELD_OPTIONS.appliances.join(', ')}
- interiorFeatures: ${OLLAMA_FIELD_OPTIONS.interiorFeatures.join(', ')}
- outdoor: ${OLLAMA_FIELD_OPTIONS.outdoor.join(', ')}
- exteriorFeatures: ${OLLAMA_FIELD_OPTIONS.exteriorFeatures.join(', ')}
- communityAmenities: ${OLLAMA_FIELD_OPTIONS.communityAmenities.join(', ')}
- safetyFeatures: ${OLLAMA_FIELD_OPTIONS.safetyFeatures.join(', ')}

UTILITIES: Scan the ENTIRE listing carefully for any mention of included utilities — they often appear in amenity lists, fee sections, "What's Included" sections, or bullet points far down the page. Include utilities explicitly stated as INCLUDED IN RENT (e.g. "heat included", "water included", "utilities included", "gas & electric included"). Do not list utilities the tenant pays separately. Preferred values: ${OLLAMA_FIELD_OPTIONS.utilitiesIncluded.join(', ')}. If the listing uses different wording (e.g. "Heat" instead of "Gas"), use the listing's wording. Common included utilities to watch for: Water, Sewer, Trash, Heat, Gas, Electric, Hot Water, Internet, Cable.

PETS: Array of all that apply. Preferred: ${OLLAMA_FIELD_OPTIONS.petsAllowed.join(', ')}. Example: ["Cats Allowed","Dogs Allowed"].

BULLETS — These are Property Notes for a Rental Arbitrage investor, NOT a renter. Write from an investor's analytical perspective:
- Location intelligence: proximity to transit, highways, parks, universities, hospitals, tourist areas, downtown districts, airports
- Neighborhood context: walkability, demand drivers, guest appeal factors, area character
- Deal structure: no broker fee, flexible lease terms, ground floor (ADA/accessibility), recent renovation, year built
- STR viability signals: doorman/concierge (guest check-in), package lockers, furnished status, short lease available
- Each bullet: one specific fact from the listing, 8-20 words, written as a concise observation
- NEVER repeat information already captured in the structured fields above (no appliances, no amenities, no utilities, no pet policy, no parking, no flooring, etc.)
- NEVER include fees, deposits, application costs, or broker fees in bullets — those go in depositAmount only
- NEVER use filler language: no "perfect for", "provides easy access", "ideal for investors", "great opportunity", "well-maintained"
- If the listing is bare with no notable location/deal details, return an empty array []

Return ONLY the JSON object.`;

  // ----- v0.10.0: SERVER PROXY → DIRECT API → OLLAMA -----
  let aiResult = null;
  let aiError = null;
  let aiModel = null;

  // 1. Primary: Server-side proxy (shared API key, no user config needed)
  try {
    console.log('[RR ext] Trying server-side AI proxy...');
    aiResult = await callClaudeProxy(systemPrompt, userPrompt);
    aiModel = CLAUDE_MODEL + ' (proxy)';
    console.log('[RR ext] Server proxy success');
  } catch (e) {
    console.log('[RR ext] Server proxy unavailable:', (e && e.message) || e);
    aiError = (e && e.message) || String(e);
  }

  // 2. Fallback: Direct Claude API (user's own key from Settings)
  if (!aiResult) {
    const apiKey = await getClaudeApiKey();
    if (apiKey) {
      try {
        console.log('[RR ext] Trying direct Claude API...');
        aiResult = await callClaude(apiKey, systemPrompt, userPrompt);
        aiModel = CLAUDE_MODEL;
        aiError = null;
        console.log('[RR ext] Direct Claude API success');
      } catch (e) {
        console.warn('[RR ext] Direct Claude API failed:', (e && e.message) || e);
        aiError = (e && e.message) || String(e);
      }
    }
  }

  // 3. Last resort: Ollama (Gemma 3 4B — free, local, less accurate)
  if (!aiResult) {
    try {
      const health = await checkOllamaHealth();
      if (health.running || health.unknown) {
        console.log('[RR ext] Falling back to Ollama (' + OLLAMA_MODEL + ')...');
        aiResult = await callOllamaLegacy(systemPrompt, userPrompt, OLLAMA_TIMEOUT_MS);
        aiModel = OLLAMA_MODEL;
        aiError = null;
        console.log('[RR ext] Ollama success');
      } else {
        aiError = (aiError || '') + ' | Ollama not running';
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log('[RR ext] Ollama failed:', msg);
      if (!aiError) aiError = msg;
    }
  }

  if (!aiResult) {
    const out = earlyDict();
    out._aiError = aiError || 'No AI available';
    return out;
  }

  const passA = aiResult;

  // ---------- Assemble result ----------
  // v0.9.0: Bullets are now lightly filtered. The old aggressive filters
  // (DUPLICATIVE_BULLET_PATTERNS + ALLOWED_BULLET_PATTERNS) dropped too
  // many valid bullets. Now we only drop hallucinated bullets (not grounded
  // in source text) and exact duplicates.
  const rawBullets = Array.isArray(passA.bullets) ? passA.bullets : [];
  const sourcedBullets = filterHallucinatedBullets(rawBullets, fullPageText);
  // Skip the aggressive duplicative/topic filter — keep all sourced bullets
  const dedupedBullets = deduplicateBullets(sourcedBullets);

  // v0.9.0: Strip bullets about fees/deposits (captured in structured fields)
  // and remove fluff phrases that add no factual value.
  const BULLET_BLOCK_RE = /\b(deposit|broker fee|application fee|security deposit|pet fee|pet deposit|move-?in cost|first month|last month)\b/i;
  const FLUFF_PHRASES = [
    /,?\s*(?:provides?|offering|ensuring|making it)\s+(?:a\s+)?(?:safe|convenient|easy|perfect|ideal|excellent|great|well-maintained|comfortable|tranquil|peaceful)\s+[\w\s]*(?:access|environment|living|lifestyle|experience|opportunity|investment|rental|choice|option)/gi,
    /,?\s*(?:perfect|ideal|great|excellent)\s+for\s+[\w\s]*(?:relaxation|entertaining|investment|rental|living)/gi,
    /,?\s*(?:provides?|offers?|ensures?)\s+(?:peace of mind|convenience|comfort|easy access|a\s+\w+\s+living)/gi,
    /\s*—\s*(?:a\s+)?(?:great|excellent|ideal|perfect|key|major)\s+[\w\s]*(?:for investors?|for renters?|selling point|draw|advantage|benefit)/gi,
    /,?\s*(?:providing|ensuring|offering)\s+(?:a\s+)?(?:safe and well-maintained|convenient and accessible|comfortable and modern)\s+[\w\s]*/gi,
  ];
  const filteredBullets = dedupedBullets
    .filter(b => !BULLET_BLOCK_RE.test(b))
    .map(b => {
      let cleaned = b;
      for (const re of FLUFF_PHRASES) cleaned = cleaned.replace(re, '');
      return cleaned.replace(/[,\s]+$/, '').trim();
    })
    .filter(b => b.length >= 10); // drop anything that became too short

  const out = {
    propertyDetails: Object.assign({}, dictPropertyDetails),
    propertyNoteBullets: filteredBullets,
    core: {
      bedrooms: passA.bedrooms,
      bathrooms: passA.bathrooms,
      sqft: passA.sqft,
      // price is NEVER from AI — scraper-only to prevent wrong rent
      availableDate: normalizeAvailableDate(passA.availableDate),
    },
  };

  // v0.9.0: Merge AI-extracted fields into dictionary output.
  // HYBRID approach: for single-select fields, only accept predefined values.
  // For multi-select fields, accept BOTH predefined AND custom values from
  // the AI — custom values are passed through as-is (no filtering against
  // predefined lists). This lets the AI add "Heat", "Private Outdoor Space",
  // "On-Site Security" etc. even though they're not predefined options.
  const llmPd = {};
  const ALL_MULTI_KEYS = new Set(EXTRACTOR_FIELDS.filter(k => !OLLAMA_SINGLE_SELECT_FIELDS.has(k)));
  // Add utilitiesIncluded to the multi-select set
  ALL_MULTI_KEYS.add('utilitiesIncluded');

  for (const k of Object.keys(passA)) {
    // Skip non-property-detail keys
    if (['bedrooms','bathrooms','sqft','price','availableDate','bullets','depositAmount'].includes(k)) continue;
    const v = passA[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;

    if (ALL_MULTI_KEYS.has(k)) {
      // Multi-select: accept all string values (predefined + custom)
      if (Array.isArray(v)) {
        const clean = v.filter(x => typeof x === 'string' && x.trim());
        if (clean.length) llmPd[k] = clean;
      }
    } else if (OLLAMA_SINGLE_SELECT_FIELDS.has(k)) {
      // Single-select: only accept predefined values
      const allowed = EXTRACTOR_FIELD_OPTIONS[k] || OLLAMA_FIELD_OPTIONS[k] || [];
      if (typeof v === 'string' && allowed.includes(v)) llmPd[k] = v;
    } else if (typeof v === 'string' && v.trim()) {
      // Other string fields (petDetails, depositAmount, etc.)
      llmPd[k] = v;
    } else if (Array.isArray(v)) {
      const clean = v.filter(x => typeof x === 'string' && x.trim());
      if (clean.length) llmPd[k] = clean;
    }
  }

  // Pet policy: only honor if source discusses pets
  if (llmPd.petsAllowed) {
    const sourceDiscussesPets = /\b(pets?|dogs?|cats?|animal|pet-friendly|no pets|allowed)\b/i.test(fullPageText);
    if (!sourceDiscussesPets) delete llmPd.petsAllowed;
    // Normalize: if AI returned a string instead of array, wrap it
    if (typeof llmPd.petsAllowed === 'string') {
      llmPd.petsAllowed = [llmPd.petsAllowed];
    }
  }

  mergeLlmIntoDictionary(out.propertyDetails, llmPd, lowerFullText);

  // Anti-hallucination grounding — only applies to PREDEFINED values.
  // Custom values bypass grounding (they're already verbatim from the AI
  // which was instructed to only extract what it sees).
  groundPropertyDetails(out.propertyDetails, fullPageText);
  resolvePropertyDetailsContradictions(out.propertyDetails);
  groundPropertyDetails(out.propertyDetails, fullPageText);

  // Store deposit amount if AI extracted it
  if (passA.depositAmount) out.depositAmount = passA.depositAmount;
  // Store petDetails for the multi-select pet types field
  if (Array.isArray(passA.petDetails) && passA.petDetails.length) {
    out.propertyDetails.petDetails = passA.petDetails.filter(x => typeof x === 'string');
  }

  // Validate core numbers
  const core = out.core;
  if (core.bedrooms != null) {
    const n = Number(core.bedrooms);
    core.bedrooms = (Number.isFinite(n) && n >= 0 && n <= 20) ? n : null;
  }
  if (core.bathrooms != null) {
    const n = Number(core.bathrooms);
    core.bathrooms = (Number.isFinite(n) && n > 0 && n <= 15) ? n : null;
  }
  if (core.sqft != null) {
    const n = Number(core.sqft);
    core.sqft = (Number.isFinite(n) && n >= 50 && n <= 50000) ? n : null;
  }
  // price intentionally omitted — scraper-only, never from AI
  if (aiError) out._aiError = aiError;
  out._aiModel = aiModel;
  return out;
}

// Merge AI-enriched propertyDetails into structured-scrape propertyDetails.
// Structured data wins for single-value fields (more reliable), but we
// union array fields so AI can add amenities the scraper missed.
function mergePropertyDetails(base, ai) {
  const out = Object.assign({}, base);
  for (const k in ai) {
    if (!Object.prototype.hasOwnProperty.call(ai, k)) continue;
    const v = ai[k];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) {
      const existing = Array.isArray(out[k]) ? out[k] : [];
      // Case-insensitive dedup: prefer existing (predefined) casing
      const lc = new Set(existing.map(x => String(x).toLowerCase()));
      out[k] = existing.concat(v.filter(x => !lc.has(String(x).toLowerCase())));
    } else if (out[k] == null || out[k] === '' || out[k] === 0) {
      out[k] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Forward scraped data to any open CRM tab
// ------------------------------------------------------------------
async function forwardToCrm(data) {
  try {
    console.log('[RR ext] forwardToCrm: looking for CRM tabs', CRM_ORIGIN);
    const tabs = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
    console.log('[RR ext] forwardToCrm: found', tabs.length, 'CRM tab(s)');
    if (!tabs.length) {
      // No CRM open yet — open it. The content script will buffer
      // until the page is ready.
      await chrome.tabs.create({ url: CRM_ORIGIN + '/', active: true });
      // Give the new tab a moment to initialize the content script
      await new Promise(r => setTimeout(r, 1500));
      const retryTabs = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
      for (const t of retryTabs) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'CRM_DELIVER', data }); } catch (_) {}
      }
      return;
    }
    // Prefer an active CRM tab if any
    const active = tabs.find(t => t.active) || tabs[0];
    console.log('[RR ext] forwardToCrm: delivering to tab', active.id, active.url);
    try {
      await chrome.tabs.sendMessage(active.id, { type: 'CRM_DELIVER', data });
      console.log('[RR ext] forwardToCrm: delivered OK');
    } catch (err) {
      console.warn('[RR ext] forwardToCrm: active tab send failed, broadcasting', err);
      // Fall back to broadcasting
      for (const t of tabs) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'CRM_DELIVER', data }); } catch (_) {}
      }
    }
    // Bring the CRM tab to the front so the user sees the result land
    try { await chrome.tabs.update(active.id, { active: true }); } catch (_) {}
    try { await chrome.windows.update(active.windowId, { focused: true }); } catch (_) {}
  } catch (e) {
    console.error('[RR ext] forwardToCrm failed', e);
  }
}

// ------------------------------------------------------------------
// Background-tab scrape helper
// ------------------------------------------------------------------
const pendingScrapes = new Map(); // tabId -> { resolve, reject, timer }

function resolveScrape(tabId, payload, error) {
  if (!tabId) return;
  const entry = pendingScrapes.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingScrapes.delete(tabId);
  try { chrome.tabs.remove(tabId); } catch (_) {}
  if (error) entry.reject(new Error(error));
  else entry.resolve(payload);
}

async function scrapeInBackgroundTab(url, contentScriptPath) {
  const tab = await chrome.tabs.create({ url, active: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScrapes.delete(tab.id);
      try { chrome.tabs.remove(tab.id); } catch (_) {}
      reject(new Error('Timed out waiting for page to load.'));
    }, SCRAPE_TIMEOUT_MS);

    pendingScrapes.set(tab.id, { resolve, reject, timer });

    const listener = (tabId, changeInfo) => {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [contentScriptPath],
      }).catch((e) => {
        pendingScrapes.delete(tab.id);
        clearTimeout(timer);
        try { chrome.tabs.remove(tab.id); } catch (_) {}
        reject(e);
      });
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ------------------------------------------------------------------
// First-install hook — open a "welcome" CRM tab if installed fresh
// ------------------------------------------------------------------
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: CRM_ORIGIN + '/' });
  }
  // Pre-warm the model on install/update so the very first import
  // doesn't pay the cold-load penalty.
  prewarmOllama();
});

// Also pre-warm whenever the service worker boots (browser launch,
// MV3 worker wake-up, etc.). This is the difference between the user
// waiting ~25s for a warm import vs ~90s for a cold one.
chrome.runtime.onStartup.addListener(() => { prewarmOllama(); });

// Fire-and-forget pre-warm: send a 1-token request that loads the model
// into RAM and primes Ollama's keep_alive timer. We don't await this and
// we swallow all errors — if Ollama isn't running yet, the next user
// import will retry through the normal health check.
async function prewarmOllama() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // /api/tags is enough to trigger Ollama to wake up; then a tiny chat
    // request loads the actual model into RAM with our keep_alive window.
    const tags = await fetch(OLLAMA_HOST + '/api/tags', { signal: ctrl.signal })
      .catch(() => null);
    clearTimeout(t);
    if (!tags || !tags.ok) return;
    // Tiny load request — 1 token, deterministic, sets the keep_alive window.
    fetch(OLLAMA_HOST + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: 1, temperature: 0 },
        messages: [{ role: 'user', content: 'ok' }],
      }),
    }).then(() => {
      console.log('[RR ext] Ollama pre-warm complete (' + OLLAMA_MODEL + ' loaded)');
    }).catch(() => { /* swallow — we'll retry on first real request */ });
  } catch (_) { /* pre-warm is best-effort */ }
}

// Run pre-warm immediately on script eval too. The MV3 service worker
// runs this top-level code each time it spins up, so this catches every
// activation path (install, browser start, message-triggered wake).
prewarmOllama();
