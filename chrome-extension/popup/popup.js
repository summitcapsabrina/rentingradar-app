// RentingRadar popup — paste-a-link flow + AI status
//
// The popup never authenticates. It simply forwards the URL to the
// service worker, which opens a background tab, scrapes the page, and
// hands the result to any open CRM tab.

const urlInput = document.getElementById('rrUrlInput');
const importBtn = document.getElementById('rrBtnImport');
const statusEl = document.getElementById('rrStatus');
const aiStatusText = document.getElementById('rrAiStatusText');
const aiTestBtn = document.getElementById('rrAiTestBtn');

// ------------------------------------------------------------------
// AI / Extension status
// ------------------------------------------------------------------
function checkAiStatus() {
  if (aiStatusText) aiStatusText.innerHTML = 'Checking status…';

  chrome.runtime.sendMessage({ type: 'HEALTH' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      if (aiStatusText) {
        aiStatusText.innerHTML = '<span style="color:var(--danger)">✗ Extension error</span>';
      }
      return;
    }
    const parts = [];
    parts.push('<span style="color:var(--success)">✓ Extension v' + (resp.version || '?') + '</span>');
    if (resp.claude && resp.claude.configured) {
      parts.push('<span style="color:var(--text3)">Custom key: active</span>');
    }

    // Test AI server proxy — asks service worker to relay through a CRM tab
    chrome.runtime.sendMessage({ type: 'TEST_AI_PROXY' }, (proxyResp) => {
      if (chrome.runtime.lastError) proxyResp = null;
      if (proxyResp && proxyResp.ok) {
        parts.unshift('<span style="color:var(--success)">✓ AI Server</span>');
      } else {
        const reason = (proxyResp && proxyResp.error) || 'unavailable';
        parts.unshift('<span style="color:var(--warning)">AI: ' + reason + '</span>');
      }
      if (aiStatusText) aiStatusText.innerHTML = parts.join(' <span style="color:var(--text3)">·</span> ');
    });
  });
}

if (aiTestBtn) aiTestBtn.addEventListener('click', checkAiStatus);

// ------------------------------------------------------------------
// Import status helpers
// ------------------------------------------------------------------
function setStatus(msg, kind) {
  statusEl.hidden = false;
  statusEl.className = 'rr-status' + (kind ? ' ' + kind : '');
  statusEl.innerHTML = msg;
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
}

function setBusy(busy) {
  importBtn.disabled = busy;
  urlInput.disabled = busy;
  importBtn.textContent = busy ? 'Importing…' : 'Import';
}

// ------------------------------------------------------------------
// Import flow
// ------------------------------------------------------------------
function detectKind(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (/airdna\.co$/.test(h)) return 'airdna-rejected';
    if (/(zillow|apartments|hotpads)\.com$/.test(h)) return 'listing';
    if (/facebook\.com$/.test(h) && /\/marketplace\//.test(url)) return 'listing';
    if (/craigslist\.org$/.test(h)) return 'listing';
  } catch (_) {}
  return null;
}

async function doImport() {
  clearStatus();
  const url = (urlInput.value || '').trim();
  if (!url) {
    setStatus('Please paste a listing URL.', 'error');
    return;
  }
  const kind = detectKind(url);
  if (kind === 'airdna-rejected') {
    setStatus('AirDNA links belong in the <strong>Competitor Analysis</strong> tab inside the CRM, not here. Open a property in the CRM and paste the AirDNA link into the Loses To / Competes With / Beats section.', 'error');
    return;
  }
  if (!kind) {
    setStatus('That URL isn\'t from a supported site. Supported: Zillow, Apartments.com, Hotpads, Facebook Marketplace, Craigslist.', 'error');
    return;
  }

  setBusy(true);
  setStatus('<span class="rr-spin"></span>Opening the listing and reading details…');

  chrome.runtime.sendMessage({ type: 'SCRAPE_URL', url, kind }, (response) => {
    setBusy(false);
    if (chrome.runtime.lastError) {
      setStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!response || !response.ok) {
      setStatus('Import failed: ' + ((response && response.error) || 'Unknown error'), 'error');
      return;
    }
    const data = response.data || {};
    const title = data.title || data.address || data.host || 'Imported listing';
    setStatus('Property details sent to your CRM. Switch to the CRM tab to see them.', 'success');
    urlInput.value = '';
  });
}

importBtn.addEventListener('click', doImport);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });

// Prefill with the active tab URL if it's a supported site — lets the
// user click Import in one motion while browsing a listing.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const t = tabs && tabs[0];
  if (t && t.url && detectKind(t.url)) {
    urlInput.value = t.url;
  }
});

// Init
checkAiStatus();
