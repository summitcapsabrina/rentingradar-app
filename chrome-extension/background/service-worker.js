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
const SCRAPE_TIMEOUT_MS = 30000;

// Local Ollama AI engine for property-detail enrichment. Requires the user
// to run Ollama on their own machine (http://ollama.com/download) and to
// have pulled the llama3.2 model. The extension never calls any hosted LLM
// API — all inference is local, free, and private.
const OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'llama3.2';
const OLLAMA_TIMEOUT_MS = 45000;

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
          if (enriched.descriptionSummary && !data.description) {
            data.description = enriched.descriptionSummary;
          }
        }
      } catch (e) {
        console.log('[RR ext] Ollama enrichment skipped:', e && e.message);
        data._aiEnriched = false;
      }
      // Strip the raw page text before returning — it's huge and no longer needed
      delete data._pageText;
    }

    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || 'Scrape failed.' };
  }
}

// ------------------------------------------------------------------
// Ollama health check — reports whether the daemon is running
// and whether the llama3.2 model is pulled.
// ------------------------------------------------------------------
async function checkOllamaHealth() {
  const result = { running: false, modelInstalled: false, model: OLLAMA_MODEL, error: null };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const resp = await fetch(OLLAMA_HOST + '/api/tags', { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) { result.error = 'HTTP ' + resp.status; return result; }
    result.running = true;
    const json = await resp.json();
    const models = (json && json.models) || [];
    result.modelInstalled = models.some((m) => {
      const name = (m && m.name) || '';
      // Match "llama3.2", "llama3.2:latest", "llama3.2:3b" etc.
      return name === OLLAMA_MODEL || name.startsWith(OLLAMA_MODEL + ':');
    });
  } catch (e) {
    result.error = (e && e.message) || String(e);
  }
  return result;
}

// ------------------------------------------------------------------
// Ollama enrichment — feed the scraped structured data + page text
// into llama3.2 and ask it to return a JSON object keyed by the
// CRM's PROP_SECTIONS fields.
// ------------------------------------------------------------------
async function enrichWithOllama(scraped) {
  const health = await checkOllamaHealth();
  if (!health.running || !health.modelInstalled) {
    throw new Error(health.running ? 'Model not installed' : 'Ollama not running');
  }

  const pageText = (scraped._pageText || '').slice(0, 14000); // ~14KB cap
  const knownFields = {
    address: scraped.address,
    price: scraped.price,
    bedrooms: scraped.bedrooms,
    bathrooms: scraped.bathrooms,
    sqft: scraped.sqft,
  };

  const systemPrompt = `You are a real estate data extraction assistant. Given a rental listing page, extract structured property details and return ONLY a single JSON object — no prose, no markdown, no code fences. Use only values that are explicitly stated or clearly implied in the listing. Never invent details. If a field is not mentioned, omit it.`;

  const userPrompt = `SCRAPED (already known) FIELDS:
${JSON.stringify(knownFields, null, 2)}

LISTING PAGE TEXT:
"""
${pageText}
"""

Return a single JSON object with this exact shape (omit any field not clearly mentioned in the listing):

{
  "propertyDetails": {
    "propertyType": "House|Apartment|Condo|Townhouse|Duplex|Triplex|Fourplex|Studio|Loft|Mobile Home|Villa|Cottage|Other",
    "yearBuilt": <number>,
    "stories": "1|2|3|4+",
    "lotSize": "<string like '0.25 acres' or '5000 sqft'>",
    "furnished": "Unfurnished|Furnished|Partially Furnished",
    "view": "City|Mountain|Desert|Pool|Courtyard|Lake|Park|Golf Course|Water|None",
    "architecturalStyle": "Modern|Contemporary|Ranch|Mediterranean|Colonial|Craftsman|Spanish|Victorian|Mid-Century|Southwest|Other",
    "flooring": ["Hardwood","Carpet","Tile","Laminate","Vinyl Plank","Concrete","Marble","Stone","Mixed"],
    "countertops": "Granite|Quartz|Marble|Laminate|Butcher Block|Concrete|Tile|Corian",
    "appliances": ["Dishwasher","Garbage Disposal","Microwave","Oven/Range (Gas)","Oven/Range (Electric)","Refrigerator","Ice Maker","Trash Compactor","Wine Cooler"],
    "laundry": "In-Unit W/D|W/D Hookups|Shared/On-Site|Stacked W/D|None",
    "ac": "Central A/C|Window Unit|Mini-Split|Evaporative/Swamp Cooler|Portable|None",
    "heating": "Central (Gas)|Central (Electric)|Baseboard|Radiator|Heat Pump|Space Heater|Fireplace|None",
    "interiorFeatures": ["Fireplace","Ceiling Fans","Walk-In Closets","High Ceilings","Vaulted Ceilings","Open Floor Plan","Natural Light","Crown Molding","Recessed Lighting","Smart Thermostat","Smart Locks","Built-In Shelving","Pantry","Kitchen Island","Breakfast Bar","Stainless Steel Appliances","Double Vanity","Soaking Tub","Walk-In Shower","Separate Tub/Shower","Linen Closet","Storage Unit","Window Blinds","Blackout Curtains","Ceiling Lighting"],
    "storage": "Walk-In Closet|Standard Closets|Garage Storage|Storage Unit|Attic|Basement|None",
    "parking": "Attached Garage|Detached Garage|Carport|Covered Parking|Assigned Spot|Street Only|Driveway|Parking Garage|None",
    "parkingSpaces": <number>,
    "pool": "Private|Community/Shared|Heated Private|Heated Community|None",
    "hotTub": "Private|Community/Shared|None",
    "outdoor": ["Balcony","Patio","Deck","Porch","Screened Porch","Sunroom","Rooftop","Courtyard","Lanai"],
    "yard": "Private Fenced|Private Unfenced|Shared|None",
    "exteriorFeatures": ["Fenced Yard","Sprinkler System","Outdoor Lighting","Outdoor Kitchen/BBQ","Fire Pit","Garden Space","Shed/Outbuilding","RV Parking","Boat Parking","EV Charging","Gated Entry","Desert Landscaping","Pool Fence"],
    "communityAmenities": ["Gym/Fitness Center","Clubhouse","Business Center","Package Lockers","Dog Park","Playground","Swimming Pool","Community Spa/Hot Tub","Sauna","Elevator","Concierge/Doorman","On-Site Management","On-Site Maintenance"],
    "utilitiesIncluded": ["Water","Hot Water","Gas","Electric","Trash","Sewer","Recycling","Internet/WiFi","Cable TV","Landscaping/Grounds","Pest Control"],
    "petsAllowed": "Yes - All Pets|Dogs Only|Cats Only|Small Pets Only|Case by Case|Service Animals Only|No Pets",
    "petWeightLimit": <number>,
    "maxPets": <number>,
    "breedRestrictions": "<string>",
    "safetyFeatures": ["Smoke Detectors","Carbon Monoxide Detectors","Fire Extinguisher","Security System/Alarm","Gated Entry","Deadbolt Locks","Smart Locks","Security Cameras","24-Hour Security"],
    "hoaFee": <number>,
    "hoaStrPolicy": "Allowed|Allowed with Restrictions|30+ Day Minimum|Not Allowed|Unknown"
  },
  "descriptionSummary": "<optional 2-3 sentence summary of the listing>"
}

Return ONLY the JSON object. No explanation, no markdown, no code fences.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(OLLAMA_HOST + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } finally { clearTimeout(t); }

  if (!resp.ok) throw new Error('Ollama HTTP ' + resp.status);
  const json = await resp.json();
  const content = json && json.message && json.message.content;
  if (!content) throw new Error('Empty response from Ollama');

  let parsed;
  try { parsed = JSON.parse(content); }
  catch (_) {
    // llama3.2 occasionally wraps JSON in a code fence even with format:'json'
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Ollama did not return JSON');
    parsed = JSON.parse(m[0]);
  }
  return parsed;
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
