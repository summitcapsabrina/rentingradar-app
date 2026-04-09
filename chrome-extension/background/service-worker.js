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

// Local Ollama AI engine for property-detail enrichment. Requires the user
// to run Ollama on their own machine (http://ollama.com/download) and to
// have pulled the llama3.2 model. The extension never calls any hosted LLM
// API — all inference is local, free, and private.
const OLLAMA_HOST = 'http://127.0.0.1:11434';
// qwen3:8b — newest-generation Qwen text model. ~5.2GB on disk, runs on
// 8GB RAM machines, strict upgrade over qwen2.5:7b at the same RAM tier.
// We pick this over qwen3.5 (which is multimodal) because we never feed
// images and the multimodal overhead would just slow inference. We pick
// the 8B size over 14B/32B so the model runs reliably on 8GB consumer
// hardware without thrashing the user's swap.
// IMPORTANT: Qwen3 ships with a "thinking mode" that prepends
// <think>...</think> blocks to responses. We disable it via the /no_think
// directive in the system prompts so the JSON parser doesn't choke.
// Install: `ollama pull qwen3:8b`
const OLLAMA_MODEL = 'qwen3:8b';
// Generous: cold model loads + long prose prompts can push past 60s on
// the 3B model. 120s gives us real headroom before we fail.
const OLLAMA_TIMEOUT_MS = 120000;

// ------------------------------------------------------------------
// Import cache — keyed by extension version + source URL.
// Re-importing the same listing returns the exact cached payload, which
// means Property Details are byte-for-byte identical across re-imports.
// The cache is bumped automatically whenever the extension updates, so
// improvements to the extraction pipeline invalidate stale entries.
// ------------------------------------------------------------------
const IMPORT_CACHE_VERSION = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '0.0.0';
const IMPORT_CACHE_PREFIX = 'rr_import_cache_' + IMPORT_CACHE_VERSION + '_';
const IMPORT_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    // Drop tracking/session params that don't change the listing identity.
    const drop = /^(utm_|fbclid|gclid|mc_|ref|session|source|tracking)/i;
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!drop.test(k)) keep.push([k, v]);
    }
    u.search = '';
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, v] of keep) u.searchParams.append(k, v);
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(url || '').toLowerCase();
  }
}

async function cacheGet(url) {
  try {
    const key = IMPORT_CACHE_PREFIX + canonicalizeUrl(url);
    const obj = await chrome.storage.local.get(key);
    const entry = obj && obj[key];
    if (!entry || !entry.ts || !entry.data) return null;
    if (Date.now() - entry.ts > IMPORT_CACHE_TTL_MS) {
      try { await chrome.storage.local.remove(key); } catch (_) {}
      return null;
    }
    return entry.data;
  } catch (_) { return null; }
}

async function cacheSet(url, data) {
  try {
    const key = IMPORT_CACHE_PREFIX + canonicalizeUrl(url);
    await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
  } catch (_) { /* storage full or unavailable — cache is best-effort */ }
}

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
          // Returns extension version + Ollama install/model status
          const ollama = await checkOllamaHealth();
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ollama });
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
          const ollama = await checkOllamaHealth();
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ollama });
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

  // Cache check — re-importing the same listing returns the exact same
  // payload, so Property Details are guaranteed byte-for-byte consistent.
  if (kind === 'listing') {
    try {
      const cached = await cacheGet(url);
      if (cached) {
        console.log('[RR ext] cache hit for', url);
        const clone = JSON.parse(JSON.stringify(cached));
        clone._cached = true;
        return { ok: true, data: clone };
      }
    } catch (_) {}
  }

  const file = kind === 'airdna' ? 'content/airdna-scraper.js' : 'content/listing-scraper.js';
  try {
    const data = await scrapeInBackgroundTab(url, file);
    if (!data) return { ok: false, error: 'Could not read details from the page. Make sure you are signed in where required.' };
    // Tag the payload with its kind so the CRM knows how to route it
    data._kind = kind;

    // AI enrichment (listings only — AirDNA already has everything in metric cards)
    if (kind === 'listing') {
      try {
        const enriched = await enrichWithOllama(data);
        if (enriched) {
          data.propertyDetails = mergePropertyDetails(data.propertyDetails || {}, enriched.propertyDetails || {});
          data._aiEnriched = true;
          data._aiModel = OLLAMA_MODEL;
          // Ollama is AUTHORITATIVE on the core listing numbers. Fill in
          // anything the scraper couldn't lock down. Since we removed the
          // fragile body-text regex from the scrapers, these values land
          // directly from the model's structured JSON output.
          if (enriched.core) {
            const c = enriched.core;
            if (c.bedrooms != null && data.bedrooms == null) data.bedrooms = c.bedrooms;
            if (c.bathrooms != null && data.bathrooms == null) data.bathrooms = c.bathrooms;
            if (c.sqft != null && data.sqft == null) data.sqft = c.sqft;
            if (c.price != null && data.price == null) {
              data.price = c.price;
              if (data.monthlyRent == null) data.monthlyRent = c.price;
            }
            if (c.availableDate) {
              data.propertyDetails = data.propertyDetails || {};
              // c.availableDate has already been normalized by enrichWithOllama
              // to 'now' or YYYY-MM-DD. We only overwrite if the existing value
              // is missing or isn't in our normalized format.
              const existing = data.propertyDetails.availableDate;
              const existingValid = existing === 'now' || /^\d{4}-\d{2}-\d{2}$/.test(existing || '');
              if (!existingValid) {
                data.propertyDetails.availableDate = c.availableDate;
              }
            }
          }
          if (enriched.descriptionSummary && !data.description) {
            data.description = enriched.descriptionSummary;
          }
          // Bullet-point summary of the listing — the CRM will drop these
          // into the Property Note field.
          if (Array.isArray(enriched.propertyNoteBullets) && enriched.propertyNoteBullets.length) {
            const _bulletSeen = new Set();
            data.propertyNoteBullets = enriched.propertyNoteBullets
              .map((s) => String(s || '').trim())
              // Strip any trailing punctuation and redundant prefixes
              .map((s) => s.replace(/^[-•*]\s*/, '').replace(/[.;,]+$/, ''))
              // Final dedupe pass at the boundary — fingerprint is the
              // bullet text lowercased with all non-alphanum collapsed.
              .filter((s) => {
                const fp = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
                if (!fp || _bulletSeen.has(fp)) return false;
                _bulletSeen.add(fp);
                return true;
              })
              // Hard cap at 120 chars. Earlier we capped at 70 which made the
              // bullets feel too terse (user feedback: "It was nicely detailed,
              // but the sentences were just too long"). 120 gives room for one
              // descriptive phrase with supporting detail while still forcing
              // fragments — no full paragraphs.
              .map((s) => {
                if (s.length <= 120) return s;
                const cut = s.slice(0, 120);
                const lastSpace = cut.lastIndexOf(' ');
                return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[.;,]+$/, '');
              })
              .filter((s) => s && s.length > 2)
              .slice(0, 14);
          }
        }
      } catch (e) {
        const reason = (e && e.message) || String(e);
        console.log('[RR ext] Ollama enrichment skipped:', reason);
        data._aiEnriched = false;
        data._aiError = reason; // surface the reason to the CRM console
      }
      // Strip the raw page text before returning — it's huge and no longer needed
      delete data._pageText;
    }

    // Cache the fully-enriched payload so subsequent re-imports of the
    // same URL return identical data.
    if (kind === 'listing') {
      try { await cacheSet(url, data); } catch (_) {}
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
  const result = { running: false, modelInstalled: false, model: OLLAMA_MODEL, error: null, installedModels: [] };
  try {
    const ctrl = new AbortController();
    // 8s — on a cold laptop Ollama's first response can take a few seconds
    // because it's just started up or just woke from sleep.
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(OLLAMA_HOST + '/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) { result.error = 'HTTP ' + resp.status; return result; }
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
  }
  return result;
}

// ------------------------------------------------------------------
// Ollama extraction — THE AUTHORITATIVE EXTRACTION PATH. The scraper
// provides the raw page text and the minimum structured data it can
// grab from JSON-LD; Ollama reads the full page and produces ALL the
// listing fields including the core numbers (beds/baths/sqft/rent/
// availability). If Ollama is unavailable the import is flagged as
// incomplete and the scraper's partial data is still returned.
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
  petsAllowed: ['Yes - All Pets','Dogs Only','Cats Only','Small Pets Only','Case by Case','Service Animals Only','No Pets'],
  safetyFeatures: ['Smoke Detectors','Carbon Monoxide Detectors','Fire Extinguisher','Security System/Alarm','Gated Entry','Deadbolt Locks','Smart Locks','Security Cameras','24-Hour Security'],
};

// The CRM's Property Details section has two kinds of dropdowns:
//   - single-select (t:'select') → one value only
//   - multi-select (t:'multi')   → array of values
// Ollama returns both as JSON arrays, which causes rendering glitches and
// contradictions (e.g. "Attached Garage" AND "Covered Parking" in one cell).
// We enforce cardinality here when assembling the merged propertyDetails.
const OLLAMA_SINGLE_SELECT_FIELDS = new Set([
  'propertyType','furnished','laundry','ac','heating','parking','pool','petsAllowed'
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
  // A/C (single)
  'Central A/C': ['central a/c','central ac','central air'],
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
  // Utilities included
  'Water': ['water included','includes water','water is included'],
  'Hot Water': ['hot water included','includes hot water'],
  'Gas': ['gas included','includes gas'],
  'Electric': ['electric included','electricity included','includes electric'],
  'Trash': ['trash included','garbage included','includes trash'],
  'Sewer': ['sewer included','includes sewer'],
  'Recycling': ['recycling included'],
  'Internet/WiFi': ['internet included','wifi included','wi-fi included','includes wifi'],
  'Cable TV': ['cable included','cable tv included'],
  'Landscaping/Grounds': ['landscaping included','grounds maintenance'],
  'Pest Control': ['pest control included'],
  // Pets
  'Yes - All Pets': ['pets welcome','pets allowed','pet friendly','pet-friendly'],
  'Dogs Only': ['dogs only','dogs allowed','dogs welcome'],
  'Cats Only': ['cats only','cats allowed','cats welcome'],
  'Small Pets Only': ['small pets','small dogs','small animal'],
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
//   - propertyType, furnished, laundry, ac, heating, parking, pool,
//     petsAllowed  → single-select (one string value)
//   - flooring, appliances, interiorFeatures, outdoor, exteriorFeatures,
//     communityAmenities, utilitiesIncluded, safetyFeatures
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
  petsAllowed:  ['Yes - All Pets','Dogs Only','Cats Only','Small Pets Only','Case by Case','Service Animals Only','No Pets'],
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
      // Multi-select: union dictionary + LLM, keeping only grounded values
      const existing = Array.isArray(dictPd[k]) ? dictPd[k] : [];
      const addition = Array.isArray(llmVal) ? llmVal : [llmVal];
      const merged = Array.from(new Set(existing.concat(addition)))
        .filter((v) => valueInText(v, lowerText));
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
  // Fallback: take the first two "content words" of the value and require
  // at least one in the source. "None" always passes (it's an absence).
  if (value === 'None') return true;
  const words = value.toLowerCase().replace(/[/()-]/g, ' ').match(/[a-z]{4,}/g) || [];
  if (!words.length) return true;
  return words.some((w) => text.includes(w));
}

// Strip any values from the merged propertyDetails that aren't traceable
// to the listing's page text. This is applied to Pass A + Pass B outputs.
function groundPropertyDetails(pd, fullPageText) {
  const text = String(fullPageText || '').toLowerCase();
  if (!text || !pd || typeof pd !== 'object') return;
  // availableDate + petsAllowed + numeric fields are handled elsewhere
  const SKIP = new Set(['availableDate','latitude','longitude']);
  for (const k of Object.keys(pd)) {
    if (SKIP.has(k)) continue;
    const v = pd[k];
    if (Array.isArray(v)) {
      const kept = v.filter((x) => isAmenityInSource(x, text));
      if (kept.length) pd[k] = kept;
      else { delete pd[k]; console.log('[RR ext] grounded: dropped empty', k); }
      const dropped = v.filter((x) => !kept.includes(x));
      if (dropped.length) console.log('[RR ext] grounded: dropped', k, dropped);
    } else if (typeof v === 'string') {
      // Only apply to known amenity fields
      if (OLLAMA_FIELD_OPTIONS[k] || k === 'pool' || k === 'parking' || k === 'laundry' || k === 'ac' || k === 'heating' || k === 'petsAllowed' || k === 'hotTub') {
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
  // Pet policy: if petsAllowed says "No Pets" but the bullets / amenities mention a dog park, something's wrong — drop the contradictory single-select.
  if (pd.petsAllowed === 'No Pets' && comm.includes('Dog Park')) {
    delete pd.petsAllowed;
  }
  // Laundry: community has "On-Site Laundry" and laundry is missing → reflect it
  if (!pd.laundry && comm.includes('On-Site Laundry')) {
    pd.laundry = 'Shared/On-Site';
  }
  // A/C "None" but interior features list mentions "Smart Thermostat" is fine — don't flag.
}

async function enrichWithOllama(scraped) {
  const health = await checkOllamaHealth();
  if (!health.running) {
    throw new Error('Ollama not running (' + (health.error || 'no response from 127.0.0.1:11434') + ')');
  }
  if (!health.modelInstalled) {
    throw new Error('Model ' + OLLAMA_MODEL + ' not installed. Installed: ' + (health.installedModels.join(', ') || 'none'));
  }

  // ---------- Build the prompt ----------
  //
  // Two-pass design:
  //   Pass A: cheap/small — core numbers + availability + utilities + bullets.
  //           This is the ONLY pass we actually depend on; if it succeeds the
  //           import is "successful".
  //   Pass B: OPTIONAL — amenity/feature enum filling. Runs best-effort and
  //           silently drops if it fails. The scraper's dictionary matcher
  //           already fills these fields deterministically, so this is gravy.
  //
  // The previous single-pass prompt embedded the ENTIRE 15-field enum schema
  // (~200 option strings) in one request to a 3B model. Small models drown
  // in that much schema and either time out or produce malformed JSON. The
  // split fixes both problems.

  // Normalize the raw scraped text BEFORE either the dictionary extractor
  // or the LLM sees it. This strips relative timestamps, view counts, and
  // other surface dynamic content that would otherwise cause the same
  // listing to produce different results on re-imports.
  const fullPageText = normalizePageText(scraped._pageText || '');
  // 6KB is plenty — listings rarely have more than that in the useful area.
  const pageText = fullPageText.slice(0, 6000);
  const lowerFullText = fullPageText.toLowerCase();

  // ----- DICTIONARY-FIRST EXTRACTION -----
  // Run the deterministic trigger-dictionary extractor over the full text.
  // This produces propertyDetails with ZERO LLM involvement — identical
  // input always yields identical output. The LLM only fills gaps below.
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

  const systemPromptA =
    // /no_think disables Qwen3's thinking-mode preamble so the response is
    // pure JSON. (No effect on non-Qwen3 models.)
    "/no_think\n" +
    "You extract structured rental-listing data from raw page text. " +
    "Return ONLY a JSON object. No prose, no markdown, no code fences. " +
    "The page text starts with a TITLE / OG_TITLE / OG_DESCRIPTION hero block — " +
    "bedrooms, bathrooms, square footage, and monthly rent are usually stated there. " +
    "You MUST extract bedrooms, bathrooms, and price if they appear anywhere in the text. " +
    "Common phrasings: '3 bd', '3 beds', '3 bedroom', '1 ba', '1 bath', '1.5 bathrooms', '$2,350/mo', '$2,350 per month'. " +
    "A studio counts as bedrooms = 0. Half baths count as .5 (e.g. '1.5 baths'). " +
    "ABSOLUTE ANTI-HALLUCINATION RULE: every fact you output — structured fields AND bullets — " +
    "MUST correspond to text that literally appears in the provided page text. " +
    "If the word or phrase is not in the text, you CANNOT output the value. When in doubt, OMIT. " +
    "It is far better to leave a field empty than to invent a value. " +
    "Do NOT infer. Do NOT assume standard apartment features. Do NOT fill in what you think a typical listing would have. " +
    "Specifically: do NOT output petsAllowed unless the text explicitly discusses pet policy (words like 'pet', 'dog', 'cat', 'animal'). " +
    "Do NOT output utilitiesIncluded values unless the text explicitly says that utility is INCLUDED in rent — 'water included', 'gas included', etc. " +
    "SELF-CHECK before every value: can I point to the exact words in the page text that justify this? If no, remove it. " +
    "The 'bullets' field is OPTIONAL. Return an empty array [] if the listing has nothing interesting beyond beds/baths/rent/amenities. " +
    "Bullets are NOT a feature list — bullets describe things that are NOT already captured in the structured fields above. " +
    "FORBIDDEN BULLET TOPICS (these are already captured in structured fields — do NOT mention them in bullets): " +
    "rent amount, beds, baths, square footage, laundry type, A/C type, heating type, parking type, pool type, " +
    "pet policy, utilities included, appliances list, flooring, interior features, exterior features, community amenities, safety features, furnished status. " +
    "ALLOWED BULLET TOPICS (only include if the listing literally mentions them): " +
    "1) nearby landmarks and attractions — parks, beaches, downtown, museums, restaurants, shopping, sports venues, universities, tourist destinations; " +
    "2) neighborhood character — quiet block, vibrant area, historic district, waterfront, mountain views, walkability to dining; " +
    "3) STR/investor angles — short-term-rental rules, HOA STR policy, lease flexibility, recent renovations, age of building, view quality, rooftop access, unique selling points relevant to a property investor considering Airbnb/VRBO. " +
    "If the listing does not actually mention any of these topics, return bullets: [].";

  // NOTE: small models handle FLAT schemas much better than nested ones,
  // and they handle short prompts much better than long ones. Keep this tight.
  const userPromptA =
`Source: ${scraperHints.source}
Scraper guesses (verify against the page; they may be wrong):
${JSON.stringify(scraperHints)}

Page text (the hero block at the top contains beds/baths/price — read it first):
"""
${pageText}
"""

Return this JSON object. bedrooms, bathrooms, and price are REQUIRED if they appear in the text. bullets is OPTIONAL — return [] if nothing applies.

{
  "bedrooms": <int 0-20>,
  "bathrooms": <number, .5 allowed>,
  "sqft": <int>,
  "price": <int monthly rent in USD>,
  "availableDate": "Now" or "YYYY-MM-DD" or a phrase like "May 1",
  "utilitiesIncluded": [ any of: "Water","Hot Water","Gas","Electric","Trash","Sewer","Recycling","Internet/WiFi","Cable TV","Landscaping/Grounds","Pest Control" ],
  "petsAllowed": one of "Yes - All Pets","Dogs Only","Cats Only","Small Pets Only","Case by Case","Service Animals Only","No Pets",
  "bullets": [ 0-8 short fragments — see strict rules below ]
}

AVAILABILITY: look for phrases like "Available Now", "Available [date]", "Move-in ready", "Ready [date]", "Available on MM/DD". "Available Now" → "Now". A specific date → "YYYY-MM-DD" or "Month Day".

BULLETS — STRICT RULES (the user is an Airbnb/VRBO investor, NOT a renter):
The CRM already has dedicated fields for rent, beds, baths, sqft, laundry, A/C, heat, parking, pool, pets, utilities, appliances, interior features, exterior features, community amenities, and furnished status. Bullets must NEVER restate any of those — that's duplicate noise. Bullets exist only to capture VALUE THE STRUCTURED FIELDS CANNOT.

WHERE TO LOOK FIRST: scan the description for a structured list — sections labeled "Features:", "Highlights:", "About this property:", "What you'll love:", "Property highlights:", "Neighborhood:", "Location:", "Nearby:". These sections almost always contain the highest-quality material for Property Notes. Walk through them line by line and pull every entry that matches the allowed topics below. Each unique entry becomes AT MOST one bullet — never repeat the same fact.

DEDUPLICATION: each bullet must describe a UNIQUE fact. Do not output two bullets that mean the same thing or that share the same key noun phrase (e.g., do NOT output both "Close to Brooklyn College" and "Walking distance to Brooklyn College"). If you find yourself repeating a phrase, stop and pick the single most descriptive version.

Allowed topics (only when the listing literally mentions them):
- Nearby landmarks, attractions, things to do/see — parks, beaches, museums, downtown, restaurants, shopping, universities, sports venues, tourist destinations.
- Neighborhood character — quiet residential, vibrant nightlife, historic district, waterfront, mountain views, walkable to dining/cafes.
- STR/investor angles — short-term-rental rules, HOA STR policy, lease flexibility, recent renovations, age of building, view quality, rooftop access, unique selling points for Airbnb/VRBO use.

Each bullet: 6-14 words, fragment style, under 110 characters, fact-grounded in the listing text.

Examples of GOOD bullets (style only — do NOT copy these facts):
  - "Two blocks from Prospect Park's main entrance"
  - "Quiet tree-lined residential street in historic district"
  - "Walking distance to downtown restaurants and waterfront"
  - "Recently renovated in 2024 with new windows and roof"
  - "HOA permits short-term rentals with 7-night minimum"
  - "Panoramic mountain views from west-facing balcony"
  - "Steps from the Wynwood arts district and Miami Beach"

Examples of FORBIDDEN bullets (these duplicate Property Details — do NOT output):
  - "Rent is $2,350/month"
  - "3 bedrooms and 2 bathrooms"
  - "Cats and dogs allowed"
  - "Shared laundry on site"
  - "Hardwood floors throughout"
  - "Stainless steel appliances"
  - "Central A/C and gas heat"
  - "Attached garage parking"
  - "Building has gym and pool"
  - "Water and trash included"

If the listing has nothing to say about landmarks/neighborhood/STR angles, return bullets: []. An empty bullets array is the CORRECT answer for a sparse listing. Never invent.

Avoid marketing fluff ("charming", "won't last", "must see"). Facts only.

Return ONLY the JSON.`;

  async function callOllama(sysPrompt, userPrompt, timeoutMs) {
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
          format: 'json',
          // num_ctx 4096 is enough for a 6KB prompt + response and does NOT
          // force llama3.2 to reload the model (default ctx is 2048 but most
          // installs already have 4096 loaded from prior runs; either way
          // 4096 is a much lower re-init cost than 8192 was).
          // FULLY DETERMINISTIC sampling: temperature=0 + top_k=1 means
          // greedy decoding (always pick the single most likely token).
          // A fixed seed pins any remaining RNG paths. repeat_penalty=1.0
          // is the neutral value — anything else introduces variance when
          // fields naturally repeat across the output schema.
          // With these settings, identical input → identical output, every
          // single run, on the same model weights.
          options: {
            temperature: 0,
            top_k: 1,
            top_p: 1,
            repeat_penalty: 1.0,
            seed: 20260409,
            num_ctx: 4096,
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
      // Qwen3 reasoning models can emit a <think>...</think> block before
      // the JSON even when /no_think is set. Strip it before parsing.
      const cleaned = String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      try { return JSON.parse(cleaned); }
      catch (_) {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Ollama did not return JSON');
        return JSON.parse(m[0]);
      }
    } finally { clearTimeout(t); }
  }

  // ---------- Pass A (required) ----------
  let passA;
  try {
    passA = await callOllama(systemPromptA, userPromptA, OLLAMA_TIMEOUT_MS);
  } catch (e) {
    // Retry once with a shorter page text slice — catches cold-model timeouts
    // and "context too small" failures on long listings.
    console.log('[RR ext] Ollama pass A failed (' + (e && e.message) + '), retrying with 3KB page text');
    const shortText = fullPageText.slice(0, 3000);
    const shortPrompt = userPromptA.replace(pageText, shortText);
    passA = await callOllama(systemPromptA, shortPrompt, OLLAMA_TIMEOUT_MS);
  }

  // ---------- Pass A' (core rescue) ----------
  // If pass A came back without the core numbers, run a laser-focused
  // second prompt that does NOTHING except extract beds/baths/sqft/price
  // from the hero block. Small models tend to lose numbers when asked
  // to produce bullets + utilities + core all at once.
  const gotCore = passA && passA.bedrooms != null && passA.bathrooms != null;
  if (!gotCore) {
    try {
      const heroSlice = fullPageText.slice(0, 2500);
      const coreSys =
        "/no_think\n" +
        "You extract four numbers from rental-listing text. Return ONLY JSON. " +
        "Never invent values. If a value is truly not present, omit the field.";
      const coreUser =
`Extract these four values from the text below. Look for phrases like "3 bd", "3 beds", "1 ba", "1.5 bath", "1,250 sq ft", "$2,350/mo":

"""
${heroSlice}
"""

Return ONLY:
{ "bedrooms": <int, 0 for studio>, "bathrooms": <number, .5 ok>, "sqft": <int>, "price": <int monthly rent USD>, "availableDate": "Now" or date string }`;
      const coreOnly = await callOllama(coreSys, coreUser, Math.floor(OLLAMA_TIMEOUT_MS * 0.5));
      if (coreOnly && typeof coreOnly === 'object') {
        passA = passA || {};
        if (passA.bedrooms == null && coreOnly.bedrooms != null) passA.bedrooms = coreOnly.bedrooms;
        if (passA.bathrooms == null && coreOnly.bathrooms != null) passA.bathrooms = coreOnly.bathrooms;
        if (passA.sqft == null && coreOnly.sqft != null) passA.sqft = coreOnly.sqft;
        if (passA.price == null && coreOnly.price != null) passA.price = coreOnly.price;
        if (!passA.availableDate && coreOnly.availableDate) passA.availableDate = coreOnly.availableDate;
        console.log('[RR ext] Core rescue pass result:', coreOnly);
      }
    } catch (e) {
      console.log('[RR ext] Core rescue pass failed:', (e && e.message) || e);
    }
  }

  // ---------- Pass B (optional — amenity enums) ----------
  // Only attempt this if pass A succeeded. If it fails we just move on.
  let passB = null;
  try {
    const systemPromptB =
      "/no_think\n" +
      "You tag rental-listing amenities from raw page text. Return ONLY a JSON object.\n" +
      "\n" +
      "ABSOLUTE ANTI-HALLUCINATION RULE: Every value you output MUST correspond to text that literally appears in the page text. If the word or phrase is not in the text, you CANNOT output the value. When in doubt, OMIT. It is far better to leave a field empty than to invent a value.\n" +
      "\n" +
      "SELF-CHECK before outputting each value: ask 'does the page text contain a direct phrase for this?' If no, remove it. Examples of grounding:\n" +
      "  - 'Stainless Steel Appliances' requires 'stainless' in the text\n" +
      "  - 'Attached Garage' requires 'attached garage' (not just 'parking')\n" +
      "  - 'Hardwood' flooring requires 'hardwood' or 'wood floors'\n" +
      "  - 'Swimming Pool' requires 'pool' or 'swimming' in the text\n" +
      "  - 'In-Unit W/D' requires 'in-unit washer/dryer' or similar — NOT just 'laundry'\n" +
      "  - 'Dishwasher' requires the word 'dishwasher'\n" +
      "DO NOT infer. DO NOT assume standard apartment features. If the listing doesn't explicitly mention it, it doesn't exist.\n" +
      "\n" +
      "SINGLE-SELECT fields are dropdowns that take exactly ONE value (a string, not an array). " +
      "MULTI-SELECT fields are checkbox groups that take an array of values. " +
      "Include only values from the allowed list. If you cannot confirm any value for a field, omit the field entirely.\n" +
      "\n" +
      "CONTRADICTION RULE: never contradict yourself. If communityAmenities includes 'Swimming Pool', " +
      "pool cannot be 'None'. If communityAmenities includes 'Community Spa/Hot Tub', hotTub cannot be 'None'. " +
      "If the listing says 'No Pets', do not list a Dog Park.";
    const enumLines = Object.keys(OLLAMA_FIELD_OPTIONS)
      .filter((k) => !['utilitiesIncluded', 'petsAllowed'].includes(k)) // already done in pass A
      .map((k) => {
        const tag = OLLAMA_SINGLE_SELECT_FIELDS.has(k) ? ' (SINGLE — pick ONE)' : ' (MULTI — array)';
        const opts = OLLAMA_FIELD_OPTIONS[k].map((s) => '"' + s + '"').join(', ');
        if (OLLAMA_SINGLE_SELECT_FIELDS.has(k)) {
          return '  "' + k + '": <one of ' + opts + '>' + tag;
        }
        return '  "' + k + '": [ subset of: ' + opts + ' ]' + tag;
      })
      .join(',\n');
    const userPromptB =
`Page text:
"""
${pageText}
"""

Return this JSON. Omit fields you cannot confirm from the text.
SINGLE fields are strings (one value only). MULTI fields are arrays.
Never invent labels. Never create contradictions.

{
${enumLines}
}

If the listing has 'Attached Garage', parking = "Attached Garage" ONLY, not an array.
If the listing has a building pool, pool = "Community/Shared" AND communityAmenities includes "Swimming Pool".
`;
    passB = await callOllama(systemPromptB, userPromptB, Math.floor(OLLAMA_TIMEOUT_MS * 0.8));
  } catch (e) {
    console.log('[RR ext] Ollama pass B (amenities) skipped:', (e && e.message) || e);
  }

  // ---------- Assemble result ----------
  const rawBullets = Array.isArray(passA && passA.bullets) ? passA.bullets : [];
  // Two-stage bullet filter:
  //   1) drop bullets the model invented that aren't grounded in the source
  //   2) drop bullets that just restate Property Details (rent, beds, laundry, etc.)
  //      and require each surviving bullet to hit an allowed STR/landmark/
  //      neighborhood topic pattern. Empty result = empty Property Notes,
  //      which is the correct outcome for a sparse listing.
  const sourcedBullets = filterHallucinatedBullets(rawBullets, fullPageText);
  const filteredBullets = filterDuplicativeBullets(sourcedBullets);
  // Seed propertyDetails with the deterministic dictionary output. The LLM
  // passes will only ADD values that survive source-grounding; they cannot
  // override anything the dictionary already picked. This is what makes
  // re-imports consistent.
  const out = {
    propertyDetails: Object.assign({}, dictPropertyDetails),
    propertyNoteBullets: filteredBullets,
    core: {
      bedrooms: passA && passA.bedrooms,
      bathrooms: passA && passA.bathrooms,
      sqft: passA && passA.sqft,
      price: passA && passA.price,
      availableDate: normalizeAvailableDate(passA && passA.availableDate),
    },
  };

  // Utilities + pets from pass A — routed through the dictionary merge so
  // the dictionary (if it matched anything) always wins on single-selects,
  // and LLM additions are filtered through source-grounding triggers.
  if (passA && typeof passA === 'object') {
    const llmA = {};
    if (Array.isArray(passA.utilitiesIncluded) && passA.utilitiesIncluded.length) {
      llmA.utilitiesIncluded = passA.utilitiesIncluded
        .filter((s) => OLLAMA_FIELD_OPTIONS.utilitiesIncluded.includes(s));
    }
    if (typeof passA.petsAllowed === 'string' && OLLAMA_FIELD_OPTIONS.petsAllowed.includes(passA.petsAllowed)) {
      // Only honor petsAllowed if the source text actually discusses pets.
      const sourceDiscussesPets = /\b(pets?|dogs?|cats?|animal|pet-friendly|no pets)\b/i.test(fullPageText);
      if (sourceDiscussesPets) llmA.petsAllowed = passA.petsAllowed;
      else console.log('[RR ext] dropped petsAllowed (source does not discuss pets):', passA.petsAllowed);
    }
    mergeLlmIntoDictionary(out.propertyDetails, llmA, lowerFullText);
  }

  // Pass B: merge amenity arrays/strings, filtering invented labels.
  // Enforce single-select cardinality: if the model returns an array for a
  // single-value field (parking, pool, ac, etc.) we keep only the first
  // allowed value — never render "Attached Garage, Covered Parking" in the
  // same dropdown cell.
  if (passB && typeof passB === 'object') {
    // Normalize passB into the merge shape, then route through the
    // dictionary merger. Dictionary values are authoritative for any
    // single-select field they already filled; passB can only CONTRIBUTE
    // new values or extend multi-selects with source-grounded entries.
    const llmB = {};
    for (const k of Object.keys(OLLAMA_FIELD_OPTIONS)) {
      if (k === 'utilitiesIncluded' || k === 'petsAllowed') continue;
      const allowed = OLLAMA_FIELD_OPTIONS[k];
      const v = passB[k];
      const isSingle = OLLAMA_SINGLE_SELECT_FIELDS.has(k);
      if (Array.isArray(v)) {
        const clean = v.filter((x) => typeof x === 'string' && allowed.includes(x));
        if (!clean.length) continue;
        if (isSingle) {
          llmB[k] = pickBestSingleValue(k, clean, fullPageText);
        } else {
          llmB[k] = clean;
        }
      } else if (typeof v === 'string' && allowed.includes(v)) {
        llmB[k] = v;
      }
    }
    mergeLlmIntoDictionary(out.propertyDetails, llmB, lowerFullText);
  }

  // HARD anti-hallucination guard: drop any value from propertyDetails that
  // isn't traceable to the listing's source text. This runs BEFORE the
  // contradiction resolver so the resolver only sees grounded facts.
  groundPropertyDetails(out.propertyDetails, fullPageText);

  // Resolve contradictions between the dropdowns and the multi-select
  // amenity lists. Example: pool="None" while communityAmenities contains
  // "Swimming Pool". We trust the more specific evidence (the amenity list
  // is built from bullet-by-bullet matches) and upgrade the single-select
  // accordingly.
  resolvePropertyDetailsContradictions(out.propertyDetails);

  // Run grounding ONCE MORE after contradiction resolution, in case the
  // resolver inferred a value that itself isn't in the source.
  groundPropertyDetails(out.propertyDetails, fullPageText);

  // ---------- Pass C (completion + verification) ----------
  // Final focused pass: identify which fields are STILL empty after all
  // the structured-data + dictionary + LLM pass A/B work, and ask the
  // model one more time, very narrowly, "is there evidence in the source
  // text for any of these specific empty fields?". This catches values
  // the listing genuinely mentions but pass B missed because it was
  // overwhelmed by the full enum surface area. We also use this as a
  // verification pass: any field the model returns must be supported by
  // the source text (groundPropertyDetails enforces this), so a model
  // hallucination here is harmless — it just gets dropped.
  try {
    const emptyFields = Object.keys(OLLAMA_FIELD_OPTIONS).filter((k) => {
      if (k === 'utilitiesIncluded' || k === 'petsAllowed') return false;
      const v = out.propertyDetails[k];
      if (v == null) return true;
      if (Array.isArray(v) && v.length === 0) return true;
      if (v === '') return true;
      return false;
    });
    if (emptyFields.length) {
      const completionLines = emptyFields
        .map((k) => {
          const tag = OLLAMA_SINGLE_SELECT_FIELDS.has(k) ? '(SINGLE)' : '(MULTI)';
          const opts = OLLAMA_FIELD_OPTIONS[k].map((s) => '"' + s + '"').join(', ');
          return '  "' + k + '": ' + tag + ' choose from [' + opts + ']';
        })
        .join('\n');
      const completionSys =
        "/no_think\n" +
        "You verify rental-listing facts. The user has already extracted everything obvious " +
        "from the page text. You ONLY return a value for a field if the listing's text contains " +
        "a direct, explicit phrase that proves it. Otherwise omit the field. Return ONLY JSON.";
      const completionUser =
`These property fields are STILL empty after our first extraction pass. For each one, scan the page text and ONLY return a value if the listing literally mentions it.

Page text:
"""
${pageText}
"""

Empty fields to verify:
${completionLines}

Rules:
- SINGLE fields are strings (one value). MULTI fields are arrays.
- If the listing does NOT explicitly mention a field, OMIT that field. Do NOT guess.
- Output a JSON object with ONLY the fields you can confirm. Empty fields are fine — they will stay empty.
`;
      const completion = await callOllama(completionSys, completionUser, Math.floor(OLLAMA_TIMEOUT_MS * 0.5));
      if (completion && typeof completion === 'object') {
        const llmC = {};
        for (const k of emptyFields) {
          const allowed = OLLAMA_FIELD_OPTIONS[k];
          const v = completion[k];
          const isSingle = OLLAMA_SINGLE_SELECT_FIELDS.has(k);
          if (Array.isArray(v)) {
            const clean = v.filter((x) => typeof x === 'string' && allowed.includes(x));
            if (!clean.length) continue;
            llmC[k] = isSingle ? pickBestSingleValue(k, clean, fullPageText) : clean;
          } else if (typeof v === 'string' && allowed.includes(v)) {
            llmC[k] = v;
          }
        }
        if (Object.keys(llmC).length) {
          mergeLlmIntoDictionary(out.propertyDetails, llmC, lowerFullText);
          // Re-ground anything pass C added — still must be in the source.
          groundPropertyDetails(out.propertyDetails, fullPageText);
          console.log('[RR ext] Pass C completion added:', Object.keys(llmC));
        }
      }
    }
  } catch (e) {
    console.log('[RR ext] Pass C completion skipped:', (e && e.message) || e);
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
  if (core.price != null) {
    const n = Number(core.price);
    core.price = (Number.isFinite(n) && n >= 50 && n <= 200000) ? n : null;
  }
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
      out[k] = Array.from(new Set(existing.concat(v)));
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
});
