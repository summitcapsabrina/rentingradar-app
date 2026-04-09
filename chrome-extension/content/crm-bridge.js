// CRM bridge — runs on app.rentingradar.com
//
// Listens for CRM_DELIVER messages from the extension service worker
// and forwards the payload to the page via window.postMessage so the
// CRM's in-page script can consume it.

(function () {
  if (window.__rrCrmBridgeLoaded) return;
  window.__rrCrmBridgeLoaded = true;

  // Announce extension presence to the page so the CRM can hide any
  // "install the extension" banner.
  try {
    window.postMessage({ rrExtension: true, type: 'READY' }, location.origin);
  } catch (_) {}

  console.log('[RR bridge] content script loaded on', location.href);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log('[RR bridge] received message', msg && msg.type);
    if (!msg) return;

    // Initial scrape result (popup-driven flow).
    if (msg.type === 'CRM_DELIVER') {
      const data = msg.data || {};
      const kind = data._kind === 'airdna' ? 'COMP_IMPORTED' : 'LISTING_IMPORTED';
      try {
        console.log('[RR bridge] posting to page as', kind);
        window.postMessage({ rrExtension: true, type: kind, data }, location.origin);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[RR bridge] postMessage failed', e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
      return true;
    }

    // Async LLM enrichment patch — arrives 5-15s after the initial
    // CRM_DELIVER (or after rrScrapeViaExtension's promise resolves) and
    // contains Property Note bullets + any LLM-only fields. CRM patches
    // the open record in place.
    if (msg.type === 'CRM_ENRICHMENT') {
      const patch = msg.patch || {};
      try {
        console.log('[RR bridge] posting LISTING_ENRICHMENT for', patch.sourceUrl);
        window.postMessage({ rrExtension: true, type: 'LISTING_ENRICHMENT', patch }, location.origin);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[RR bridge] postMessage failed', e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
      return true;
    }
  });
})();
