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
const OLLAMA_MODEL = 'llama3.2';
// Generous: cold model loads + long prose prompts can push past 60s on
// the 3B model. 120s gives us real headroom before we fail.
const OLLAMA_TIMEOUT_MS = 120000;

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
              if (!data.propertyDetails.availableDate) {
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
            data.propertyNoteBullets = enriched.propertyNoteBullets
              .map((s) => String(s || '').trim())
              .filter((s) => s && s.length > 2 && s.length < 300)
              .slice(0, 20);
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
    result.modelInstalled = result.installedModels.some((name) => {
      // Match "llama3.2", "llama3.2:latest", "llama3.2:3b", "llama3.2:1b", etc.
      return name === OLLAMA_MODEL || name.startsWith(OLLAMA_MODEL + ':');
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

  const fullPageText = scraped._pageText || '';
  // 6KB is plenty — listings rarely have more than that in the useful area.
  const pageText = fullPageText.slice(0, 6000);
  const scraperHints = {
    source: scraped.source || '',
    address: scraped.address || '',
    beds: scraped.bedrooms,
    baths: scraped.bathrooms,
    sqft: scraped.sqft,
    price: scraped.price,
  };

  const systemPromptA =
    "You extract structured rental-listing data from raw page text. " +
    "Return ONLY a JSON object. No prose, no markdown, no code fences. " +
    "Never guess. If a value is not stated in the page text, omit the field.";

  // NOTE: small models handle FLAT schemas much better than nested ones,
  // and they handle short prompts much better than long ones. Keep this tight.
  const userPromptA =
`Source: ${scraperHints.source}
Scraper guesses (verify against the page; they may be wrong):
${JSON.stringify(scraperHints)}

Page text:
"""
${pageText}
"""

Return this JSON object (omit any field you can't confirm):

{
  "bedrooms": <int 0-20>,
  "bathrooms": <number, .5 allowed>,
  "sqft": <int>,
  "price": <int monthly rent in USD>,
  "availableDate": "Now" or "YYYY-MM-DD" or a phrase like "May 1",
  "utilitiesIncluded": [ any of: "Water","Hot Water","Gas","Electric","Trash","Sewer","Recycling","Internet/WiFi","Cable TV","Landscaping/Grounds","Pest Control" ],
  "petsAllowed": one of "Yes - All Pets","Dogs Only","Cats Only","Small Pets Only","Case by Case","Service Animals Only","No Pets",
  "bullets": [ 5 to 12 short factual bullet points (<= 120 chars each) summarizing this listing for a short-term-rental arbitrage investor ]
}

Bullet guidance: call out neighborhood / walk / transit scores, parking, HOA or STR policy, recent renovations, unit quirks, pet policy specifics, utilities included, furnished status, lease flexibility, proximity to attractions. No marketing fluff ("charming", "must see"). Numbers and specifics only.

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
          options: { temperature: 0.1, num_ctx: 4096 },
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
      try { return JSON.parse(content); }
      catch (_) {
        const m = content.match(/\{[\s\S]*\}/);
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

  // ---------- Pass B (optional — amenity enums) ----------
  // Only attempt this if pass A succeeded. If it fails we just move on.
  let passB = null;
  try {
    const systemPromptB =
      "You tag rental-listing amenities from raw page text. Return ONLY a JSON object. " +
      "Each field is an array. Include only values that appear in the allowed list below. " +
      "If you can't confirm any value for a field, omit the field entirely.";
    const enumLines = Object.keys(OLLAMA_FIELD_OPTIONS)
      .filter((k) => !['utilitiesIncluded', 'petsAllowed'].includes(k)) // already done in pass A
      .map((k) => '  "' + k + '": [' + OLLAMA_FIELD_OPTIONS[k].map((s) => '"' + s + '"').join(', ') + ']')
      .join(',\n');
    const userPromptB =
`Page text:
"""
${pageText}
"""

Return this JSON (omit fields with no confirmable values):

{
${enumLines}
}

Only use values from the lists above. No invented labels.`;
    passB = await callOllama(systemPromptB, userPromptB, Math.floor(OLLAMA_TIMEOUT_MS * 0.8));
  } catch (e) {
    console.log('[RR ext] Ollama pass B (amenities) skipped:', (e && e.message) || e);
  }

  // ---------- Assemble result ----------
  const out = {
    propertyDetails: {},
    propertyNoteBullets: Array.isArray(passA && passA.bullets) ? passA.bullets : [],
    core: {
      bedrooms: passA && passA.bedrooms,
      bathrooms: passA && passA.bathrooms,
      sqft: passA && passA.sqft,
      price: passA && passA.price,
      availableDate: passA && passA.availableDate,
    },
  };

  // Utilities + pets from pass A
  if (passA && Array.isArray(passA.utilitiesIncluded) && passA.utilitiesIncluded.length) {
    out.propertyDetails.utilitiesIncluded = passA.utilitiesIncluded
      .filter((s) => OLLAMA_FIELD_OPTIONS.utilitiesIncluded.includes(s));
  }
  if (passA && typeof passA.petsAllowed === 'string' && OLLAMA_FIELD_OPTIONS.petsAllowed.includes(passA.petsAllowed)) {
    out.propertyDetails.petsAllowed = passA.petsAllowed;
  }

  // Pass B: merge amenity arrays/strings, filtering invented labels
  if (passB && typeof passB === 'object') {
    for (const k of Object.keys(OLLAMA_FIELD_OPTIONS)) {
      if (k === 'utilitiesIncluded' || k === 'petsAllowed') continue;
      const allowed = OLLAMA_FIELD_OPTIONS[k];
      const v = passB[k];
      if (Array.isArray(v)) {
        const clean = v.filter((x) => allowed.includes(x));
        if (clean.length) out.propertyDetails[k] = clean;
      } else if (typeof v === 'string' && allowed.includes(v)) {
        out.propertyDetails[k] = v;
      }
    }
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
