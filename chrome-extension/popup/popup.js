// RentingRadar extension popup
// Handles: checking auth state, connecting to CRM, and triggering AirDNA imports.

const $ = (id) => document.getElementById(id);

const ui = {
  account: $('rrAccount'),
  accountDot: $('rrAccountDot'),
  accountLabel: $('rrAccountLabel'),
  stateDisc: $('rrStateDisconnected'),
  stateConn: $('rrStateConnected'),
  btnConnect: $('rrBtnConnect'),
  urlInput: $('rrUrlInput'),
  btnImport: $('rrBtnImport'),
  status: $('rrStatus'),
  recent: $('rrRecent'),
  recentList: $('rrRecentList'),
};

function showState(connected, email) {
  ui.stateDisc.hidden = connected;
  ui.stateConn.hidden = !connected;
  if (connected) {
    ui.account.classList.add('connected');
    ui.accountLabel.textContent = email || 'Connected';
  } else {
    ui.account.classList.remove('connected');
    ui.accountLabel.textContent = 'Not connected';
  }
}

function setStatus(msg, kind) {
  if (!msg) {
    ui.status.hidden = true;
    ui.status.textContent = '';
    ui.status.className = 'rr-status';
    return;
  }
  ui.status.hidden = false;
  ui.status.className = 'rr-status' + (kind ? ' ' + kind : '');
  ui.status.innerHTML = '';
  if (kind === 'loading') {
    const s = document.createElement('span');
    s.className = 'rr-spin';
    ui.status.appendChild(s);
  }
  ui.status.appendChild(document.createTextNode(msg));
}

async function refreshAuth() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
  showState(!!(res && res.signedIn), res && res.email);
  return res;
}

async function renderRecent() {
  const { rrRecent = [] } = await chrome.storage.local.get('rrRecent');
  if (!rrRecent.length) {
    ui.recent.hidden = true;
    return;
  }
  ui.recent.hidden = false;
  ui.recentList.innerHTML = '';
  for (const item of rrRecent.slice(0, 5)) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'rr-recent-title';
    title.textContent = item.title || item.url;
    const time = document.createElement('span');
    time.className = 'rr-recent-time';
    time.textContent = timeAgo(item.importedAt);
    li.appendChild(title);
    li.appendChild(time);
    ui.recentList.appendChild(li);
  }
}

function timeAgo(ts) {
  if (!ts) return '';
  const secs = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return secs + 's ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  return days + 'd ago';
}

ui.btnConnect.addEventListener('click', async () => {
  ui.btnConnect.disabled = true;
  setStatus('Opening RentingRadar to link your account…', 'loading');
  try {
    await chrome.runtime.sendMessage({ type: 'START_CONNECT' });
    // The background worker opens a tab; we poll for auth state every 1s.
    const poll = setInterval(async () => {
      const st = await refreshAuth();
      if (st && st.signedIn) {
        clearInterval(poll);
        setStatus('Connected!', 'success');
        setTimeout(() => setStatus(null), 1500);
      }
    }, 1000);
    // Stop polling after 2 minutes regardless.
    setTimeout(() => clearInterval(poll), 120000);
  } catch (e) {
    setStatus('Could not open RentingRadar: ' + e.message, 'error');
  } finally {
    ui.btnConnect.disabled = false;
  }
});

ui.btnImport.addEventListener('click', async () => {
  const url = (ui.urlInput.value || '').trim();
  if (!url) {
    setStatus('Paste an AirDNA listing URL first.', 'error');
    return;
  }
  if (!/airdna\.co/i.test(url)) {
    setStatus('That doesn\u2019t look like an AirDNA link.', 'error');
    return;
  }
  ui.btnImport.disabled = true;
  setStatus('Opening AirDNA and extracting listing details…', 'loading');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'IMPORT_AIRDNA', url });
    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'Import failed');
    }
    setStatus('Added "' + (res.title || 'listing') + '" to your competitor analysis.', 'success');
    ui.urlInput.value = '';
    renderRecent();
  } catch (e) {
    setStatus(e.message || 'Import failed', 'error');
  } finally {
    ui.btnImport.disabled = false;
  }
});

ui.urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.btnImport.click();
});

// Initial paint
(async function init() {
  await refreshAuth();
  renderRecent();
})();
