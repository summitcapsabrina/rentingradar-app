# RentingRadar Chrome Extension

Thin companion extension for the RentingRadar CRM. Imports AirDNA listings into
competitor analysis and auto-fills property profiles from rental listing sites
(Zillow, Apartments.com, Hotpads, Facebook Marketplace).

## Folder layout

```
chrome-extension/
  manifest.json           MV3 manifest
  background/
    service-worker.js     Message router, auth, scrape orchestration
  popup/
    popup.html            Extension popup UI
    popup.css             Dark-mode styles matching the CRM
    popup.js              Popup logic
  content/
    airdna-scraper.js     Injected into airdna.co tabs
    listing-scraper.js    Injected into Zillow/Apartments/Hotpads/FB tabs
  lib/
    firebase.js           Thin wrapper around the bundled Firebase SDK
    firebase-bundle.js    (to be generated) Firebase v10 modular bundle
  icons/                  Extension icons (16/32/48/128 png)
```

## Build steps (before loading unpacked)

1. Fill in `lib/firebase.js` with the real RentingRadar Firebase web config.
2. Bundle the Firebase modular SDK into `lib/firebase-bundle.js`:

   ```bash
   cd chrome-extension
   npm init -y
   npm install firebase esbuild
   npx esbuild lib/firebase-entry.js --bundle --format=esm --outfile=lib/firebase-bundle.js
   ```

   Where `lib/firebase-entry.js` re-exports the pieces we use:

   ```js
   export { initializeApp } from 'firebase/app';
   export {
     getAuth, signInWithCustomToken, onAuthStateChanged,
     signOut, setPersistence, indexedDBLocalPersistence,
   } from 'firebase/auth';
   export {
     getFirestore, collection, addDoc, serverTimestamp,
   } from 'firebase/firestore';
   ```

3. Generate PNG icons at 16, 32, 48, and 128 px and save into `icons/`.
4. Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → select
   the `chrome-extension/` folder.

## Auth bridge

When the user clicks "Connect account" in the popup:

1. Service worker opens `https://rentingradar.app/#/extension-link` in a new tab.
2. The CRM's extension-link page checks that the user is signed in, calls the
   `mintExtensionToken` Cloud Function, and sends the custom token to the
   extension via `chrome.runtime.sendMessage` (allowed by `externally_connectable`).
3. The service worker calls `signInWithCustomToken` and persists the session in
   IndexedDB so it survives service worker restarts.

## CRM-to-extension bridge

The CRM's property form (in `index.html`) detects the extension via a `PING`
message, then for listing URLs calls `chrome.runtime.sendMessage(EXTENSION_ID, {
type: 'SCRAPE_LISTING', url })`. The extension opens the listing URL in a
background tab, runs the matching parser, and returns the scraped payload.

## Trader account / Chrome Web Store

The Web Store now requires every paid-SaaS developer to declare trader status,
which publishes a contact address. Use a virtual mailbox (iPostal1, Earth Class
Mail, Anytime Mailbox, etc.) rather than a home address.
