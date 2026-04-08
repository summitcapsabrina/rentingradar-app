// RentingRadar extension service worker (MV3 background)
// Responsibilities:
//   1. Hold auth state (Firebase custom token exchanged via CRM)
//   2. Handle messages from popup: GET_AUTH_STATE, START_CONNECT, IMPORT_AIRDNA
//   3. Handle messages from CRM (externally_connectable): SCRAPE_LISTING
//   4. Drive background tabs that run content scripts to scrape AirDNA / listing sites
//
// Firebase is loaded lazily (ES module import from ./firebase.js) the first
// time we need it, to keep the service worker cold start fast.

const CRM_ORIGIN = 'https://app.rentingradar.com';
const CRM_LINK_URL = CRM_ORIGIN + '/?extension=link';
const CONNECT_CHECK_INTERVAL_MS = 1000;
const SCRAPE_TIMEOUT_MS = 30000;

let firebaseModule = null;
async function getFirebase() {
  if (!firebaseModule) {
    firebaseModule = await import('../lib/firebase.js');
    await firebaseModule.ensureReady();
  }
  return firebaseModule;
}

// ------------------------------------------------------------------
// Message router (popup + content scripts)
// ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'GET_AUTH_STATE': {
          const fb = await getFirebase();
          const user = fb.getCurrentUser();
          sendResponse({ signedIn: !!user, email: user ? user.email : null, uid: user ? user.uid : null });
          return;
        }
        case 'START_CONNECT': {
          await openConnectTab();
          sendResponse({ ok: true });
          return;
        }
        case 'SIGN_OUT': {
          const fb = await getFirebase();
          await fb.signOut();
          sendResponse({ ok: true });
          return;
        }
        case 'IMPORT_AIRDNA': {
          const result = await importAirDnaListing(msg.url);
          sendResponse(result);
          return;
        }
        // Content scripts post scraped payloads here
        case 'SCRAPE_RESULT': {
          // Handled via the per-tab promise map below.
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
// External messages (from the CRM page)
// ------------------------------------------------------------------
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Only accept from known CRM origin
      if (!sender.url || !sender.url.startsWith(CRM_ORIGIN)) {
        sendResponse({ ok: false, error: 'Unauthorized origin' });
        return;
      }
      switch (msg && msg.type) {
        case 'PING':
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
          return;
        case 'EXTENSION_TOKEN': {
          // CRM hands us a Firebase custom token
          const fb = await getFirebase();
          await fb.signInWithCustomToken(msg.token);
          sendResponse({ ok: true });
          return;
        }
        case 'SCRAPE_LISTING': {
          // CRM wants us to scrape a Zillow/Apartments/etc URL
          const data = await scrapeListing(msg.url);
          sendResponse({ ok: true, data });
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
// Auth bridge: open CRM in a new tab so user can link
// ------------------------------------------------------------------
async function openConnectTab() {
  const existing = await chrome.tabs.query({ url: CRM_ORIGIN + '/*' });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true, url: CRM_LINK_URL });
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: CRM_LINK_URL, active: true });
  return tab.id;
}

// ------------------------------------------------------------------
// AirDNA import flow
// ------------------------------------------------------------------
async function importAirDnaListing(url) {
  const fb = await getFirebase();
  const user = fb.getCurrentUser();
  if (!user) return { ok: false, error: 'Not connected to RentingRadar. Click Connect first.' };

  if (!/^https?:\/\/(www\.)?airdna\.co\//i.test(url)) {
    return { ok: false, error: 'URL must be an airdna.co link.' };
  }

  // Open the AirDNA page in a background tab so the user's AirDNA cookies come along,
  // inject the scraper, wait for the payload, close the tab.
  const data = await scrapeInBackgroundTab(url, 'content/airdna-scraper.js');
  if (!data) return { ok: false, error: 'Could not read listing details from AirDNA. Are you signed in there?' };

  // Write to Firestore under the current user
  try {
    await fb.addCompetitor(user.uid, {
      source: 'airdna',
      sourceUrl: url,
      title: data.title || null,
      address: data.address || null,
      bedrooms: data.bedrooms || null,
      bathrooms: data.bathrooms || null,
      adr: data.adr || null,
      occupancy: data.occupancy || null,
      revenue: data.revenue || null,
      raw: data.raw || null,
      importedAt: Date.now(),
    });
  } catch (e) {
    // If tier gate rejects, surface a friendly message
    const msg = e && e.message ? e.message : 'Could not save to RentingRadar.';
    if (/quota|limit|permission/i.test(msg)) {
      return { ok: false, error: 'You have reached your monthly analysis limit. Upgrade your plan in RentingRadar.' };
    }
    return { ok: false, error: msg };
  }

  // Update recent-imports cache
  const { rrRecent = [] } = await chrome.storage.local.get('rrRecent');
  rrRecent.unshift({ url, title: data.title || url, importedAt: Date.now() });
  await chrome.storage.local.set({ rrRecent: rrRecent.slice(0, 20) });

  return { ok: true, title: data.title || 'listing' };
}

// ------------------------------------------------------------------
// Listing site scrape (used by CRM via external message)
// ------------------------------------------------------------------
async function scrapeListing(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Invalid URL');
  const host = new URL(url).hostname.toLowerCase();
  const supported = /(zillow|apartments|hotpads|facebook)\.com$/.test(host.replace(/^www\./, '').split('.').slice(-2).join('.')) ||
                    /zillow\.com$|apartments\.com$|hotpads\.com$|facebook\.com$/.test(host);
  if (!supported) throw new Error('Unsupported listing site');
  const data = await scrapeInBackgroundTab(url, 'content/listing-scraper.js');
  if (!data) throw new Error('Could not read listing details.');
  return data;
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

    // Wait for the tab to finish loading, then inject the content script.
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
// First-install hook
// ------------------------------------------------------------------
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: CRM_ORIGIN + '/?extension=welcome' });
  }
});
