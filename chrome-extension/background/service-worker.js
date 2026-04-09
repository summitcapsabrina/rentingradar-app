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
            data.propertyNoteBullets = enriched.propertyNoteBullets
              .map((s) => String(s || '').trim())
              // Strip any trailing punctuation and redundant prefixes
              .map((s) => s.replace(/^[-•*]\s*/, '').replace(/[.;,]+$/, ''))
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
    "The page text starts with a TITLE / OG_TITLE / OG_DESCRIPTION hero block — " +
    "bedrooms, bathrooms, square footage, and monthly rent are usually stated there. " +
    "You MUST extract bedrooms, bathrooms, and price if they appear anywhere in the text. " +
    "Common phrasings: '3 bd', '3 beds', '3 bedroom', '1 ba', '1 bath', '1.5 bathrooms', '$2,350/mo', '$2,350 per month'. " +
    "A studio counts as bedrooms = 0. Half baths count as .5 (e.g. '1.5 baths'). " +
    "CRITICAL anti-hallucination rule: every fact you output — structured fields AND bullets — " +
    "must appear VERBATIM or as an OBVIOUS paraphrase in the provided page text. " +
    "If a fact is not in the text, OMIT it. Do NOT guess. Do NOT invent. " +
    "Specifically: do NOT output petsAllowed unless the text explicitly discusses pet policy. " +
    "Do NOT output a bullet like 'Small pets allowed', 'Water included', 'Hardwood floors', etc. " +
    "unless those exact concepts are mentioned in the text. When in doubt, omit. " +
    "The 'bullets' field is ALWAYS REQUIRED — always return at least 5 bullet points, but only " +
    "about things the listing actually mentions.";

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

Return this JSON object. bedrooms, bathrooms, and price are REQUIRED if they appear in the text. bullets is ALWAYS REQUIRED.

{
  "bedrooms": <int 0-20>,
  "bathrooms": <number, .5 allowed>,
  "sqft": <int>,
  "price": <int monthly rent in USD>,
  "availableDate": "Now" or "YYYY-MM-DD" or a phrase like "May 1",
  "utilitiesIncluded": [ any of: "Water","Hot Water","Gas","Electric","Trash","Sewer","Recycling","Internet/WiFi","Cable TV","Landscaping/Grounds","Pest Control" ],
  "petsAllowed": one of "Yes - All Pets","Dogs Only","Cats Only","Small Pets Only","Case by Case","Service Animals Only","No Pets",
  "bullets": [ 6 to 12 short fragments summarizing this listing — REQUIRED, never empty ]
}

AVAILABILITY: look for phrases like "Available Now", "Available [date]", "Move-in ready", "Ready [date]", "Available on MM/DD". "Available Now" → "Now". A specific date → "YYYY-MM-DD" or "Month Day".

BULLETS (REQUIRED — always return 8-14 bullets when the listing has enough content):
Bullets are a concise fact list summarizing what the listing actually says. Each bullet should be a descriptive phrase — more substantive than a tag, shorter than a sentence. Target 6-14 words, under 110 characters. Use fragments, not full sentences. Include supporting detail when the listing provides it (e.g. "Updated kitchen with stainless steel appliances and quartz counters" instead of just "Updated kitchen").

YOU MUST cover the NEIGHBORHOOD / LOCATION whenever the listing mentions it. Look for: walk score, transit score, nearby subway/bus stops, parks, schools, shopping, restaurants, landmarks, neighborhood name, distance to downtown/attractions. At least 1-3 of your bullets should be location/neighborhood bullets if the listing provides that information.

Examples of good bullet style (these are STYLE examples only — do NOT copy these facts; use whatever is actually in this particular listing):
  - "Hardwood floors throughout the main living areas"
  - "In-unit washer/dryer and dishwasher included"
  - "Updated kitchen with stainless steel appliances"
  - "Central A/C and forced-air gas heat"
  - "Private rooftop deck with city views"
  - "Two blocks from the 2/3 subway at 125th St"
  - "Walk Score 92 — groceries, cafes, and parks nearby"
  - "Quiet tree-lined residential block in Park Slope"
  - "Close to Prospect Park and Brooklyn Museum"
  - "Building amenities include gym, doorman, and bike storage"
  - "Water, hot water, and trash included in rent"

Topics to draw bullets from (pick whichever ARE mentioned in the listing — do NOT force topics that aren't):
- unit features (flooring, appliances, A/C, heat, laundry, layout)
- building amenities (gym, pool, roof, concierge, elevator)
- location (neighborhood, walk/transit score, nearby subway/highway/attractions)
- utilities included or excluded
- pet policy specifics
- parking
- HOA or short-term-rental policy (if mentioned — important for arbitrage)
- recent renovations or age of unit
- lease terms (length, flexibility)
- furnished status

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
      "You tag rental-listing amenities from raw page text. Return ONLY a JSON object. " +
      "SINGLE-SELECT fields are dropdowns that take exactly ONE value (string). " +
      "MULTI-SELECT fields are checkbox groups that take an array of values. " +
      "Include only values that appear in the allowed list below. " +
      "If you can't confirm any value for a field, omit the field entirely. " +
      "CRITICAL: never contradict yourself. If communityAmenities includes 'Swimming Pool', " +
      "pool cannot be 'None'. If communityAmenities includes 'Community Spa/Hot Tub', " +
      "hotTub cannot be 'None'. If the listing says 'No Pets', do not list a Dog Park.";
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
  const filteredBullets = filterHallucinatedBullets(rawBullets, fullPageText);
  const out = {
    propertyDetails: {},
    propertyNoteBullets: filteredBullets,
    core: {
      bedrooms: passA && passA.bedrooms,
      bathrooms: passA && passA.bathrooms,
      sqft: passA && passA.sqft,
      price: passA && passA.price,
      availableDate: normalizeAvailableDate(passA && passA.availableDate),
    },
  };

  // Utilities + pets from pass A
  if (passA && Array.isArray(passA.utilitiesIncluded) && passA.utilitiesIncluded.length) {
    out.propertyDetails.utilitiesIncluded = passA.utilitiesIncluded
      .filter((s) => OLLAMA_FIELD_OPTIONS.utilitiesIncluded.includes(s));
  }
  if (passA && typeof passA.petsAllowed === 'string' && OLLAMA_FIELD_OPTIONS.petsAllowed.includes(passA.petsAllowed)) {
    // Only honor petsAllowed if the source text actually discusses pets.
    // Small models hallucinate this field from example prompts.
    const sourceDiscussesPets = /\b(pets?|dogs?|cats?|animal|pet-friendly|no pets)\b/i.test(fullPageText);
    if (sourceDiscussesPets) {
      out.propertyDetails.petsAllowed = passA.petsAllowed;
    } else {
      console.log('[RR ext] dropped petsAllowed (source does not discuss pets):', passA.petsAllowed);
    }
  }

  // Pass B: merge amenity arrays/strings, filtering invented labels.
  // Enforce single-select cardinality: if the model returns an array for a
  // single-value field (parking, pool, ac, etc.) we keep only the first
  // allowed value — never render "Attached Garage, Covered Parking" in the
  // same dropdown cell.
  if (passB && typeof passB === 'object') {
    for (const k of Object.keys(OLLAMA_FIELD_OPTIONS)) {
      if (k === 'utilitiesIncluded' || k === 'petsAllowed') continue;
      const allowed = OLLAMA_FIELD_OPTIONS[k];
      const v = passB[k];
      const isSingle = OLLAMA_SINGLE_SELECT_FIELDS.has(k);
      if (Array.isArray(v)) {
        const clean = v.filter((x) => typeof x === 'string' && allowed.includes(x));
        if (!clean.length) continue;
        if (isSingle) {
          // Prefer the most specific value. For parking we prefer
          // garage/carport over generic "Covered Parking". For pool we
          // prefer a specific type over "None".
          out.propertyDetails[k] = pickBestSingleValue(k, clean, fullPageText);
        } else {
          out.propertyDetails[k] = clean;
        }
      } else if (typeof v === 'string' && allowed.includes(v)) {
        out.propertyDetails[k] = v;
      }
    }
  }

  // Resolve contradictions between the dropdowns and the multi-select
  // amenity lists. Example: pool="None" while communityAmenities contains
  // "Swimming Pool". We trust the more specific evidence (the amenity list
  // is built from bullet-by-bullet matches) and upgrade the single-select
  // accordingly.
  resolvePropertyDetailsContradictions(out.propertyDetails);

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
