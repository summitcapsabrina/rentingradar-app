window.H = {
  log: { toasts: [], renders: 0, saves: [], softDeletes: [], cohostSaves: [] },
  snapshot: null,
};
H.wait = (ms) => new Promise((r) => setTimeout(r, ms));
H.until = async (fn, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (fn()) return true; await H.wait(25); }
  return !!fn();
};
H.check = (fails, ok, label) => { if (!ok) fails.push(label); };
H.toastHas = (s) => H.log.toasts.some((t) => t.includes(s));

const PLANS = {
  address: '13450 Perdido Key Dr, Pensacola, FL 32507', sourceUrl: 'https://www.apartments.com/altura/', _needsFloorplan: true,
  floorplans: [{ name: 'B3', beds: 2, baths: 2, sqft: 1112, priceMin: 1798 }, { name: 'B3.1', beds: 2, baths: 2, sqft: 1088, priceMin: 2166 }],
  propertyNoteBullets: ['Floor plan B3.1 offers 1,088 sq ft', 'B3 has water views'],
};
const addr = (n) => ({ street: n + ' Gulf Blvd', unit: '', city: 'Navarre', state: 'FL', zip: '32566' });
const single = (n, extra) => Object.assign({ address: n + ' Gulf Blvd, Navarre, FL 32566', sourceUrl: 'https://www.zillow.com/' + n, bedrooms: 2, bathrooms: 2, sqft: 1360, price: 1900 }, extra);
const oldRecord = (n, extra) => Object.assign({ id: 'old_' + n, property: n + ' Gulf Blvd, Navarre FL 32566', addressParts: addr(n), status: 'New', notes: [], propertyDetails: { bedrooms: 9 } }, extra);
H.single = single;

H.init = async function () {
  // Saves and mirror writes are recorded, never sent.
  saveData = function () { H.log.saves.push({ ids: records.map((x) => x.id), softDeletesSoFar: H.log.softDeletes.length, by: (new Error().stack.split('\n')[2] || '').trim().split(' ')[1] }); };
  saveCohostData = function () { H.log.cohostSaves.push({ ids: cohostRecords.map((x) => x.id), softDeletesSoFar: H.log.softDeletes.length }); };
  _softDeleteRecordMirror = function (r, c) { H.log.softDeletes.push({ id: r.id, c, mark: r._mark || null }); };
  _flushSaveWrite = () => Promise.resolve();
  _flushCohostSaveWrite = () => Promise.resolve();
  saveContact = () => Promise.resolve();
  geocodeExistingProperties = () => {};
  checkPropertyLimit = () => true;
  const chain = () => new Proxy(function () {}, {
    get(_, k) {
      if (k === 'get') return async () => ({ exists: false, empty: true, docs: [], data: () => ({}), forEach() {}, metadata: {} });
      if (k === 'set' || k === 'update' || k === 'delete') return async () => {};
      if (k === 'onSnapshot') return (cb) => { (H.snaps = H.snaps || []).push(cb); return () => {}; };
      if (k === 'then') return undefined;
      return chain();
    },
    apply() { return chain(); },
  });
  db.collection = () => chain();
  _currentUid = 'harness';
  // The real snapshot listener, so a remote edit takes the real path.
  await loadDataFromFirestore('harness').catch(() => {});
  H.snapshot = (H.snaps || []).find((cb) => /_lastSavedJson/.test(String(cb)));
  records = [];
  cohostRecords = [];
  _deletedRecordIds.clear();
  _deletedCohostIds.clear();
  const realRender = render;
  render = function () { H.log.renders++; try { return realRender.apply(this, arguments); } catch (e) { console.warn('render threw', e); } };
  const realToast = showToast;
  showToast = function (msg) { H.log.toasts.push(String(msg)); return realToast.apply(this, arguments); };
  rrGeocodeAddress = async (a) => {
    const m = String(a).match(/^(\d+) ([^,]+)/) || [];
    return { lat: 30, lng: -87, street: m[0] || a, unit: '', city: 'Navarre', state: 'FL', zip: '32566', formattedAddress: a };
  };
  H.scrapeWith = (data) => { rrScrapeViaExtension = async () => ({ ok: true, data }); };
};

H.pasteImport = function (data) {
  H.scrapeWith(data);
  document.getElementById('add_choice_url').value = data.sourceUrl;
  importFromChoicePaste();
};
H.startPicker = async function () {
  openAddModal('house');
  H.pasteImport(PLANS);
  return H.until(() => document.querySelector('#detailModal #rrPlanPicker'));
};
H.remoteEdit = function (rec) {
  const edited = Object.assign({}, rec, { note: 'remote edit', _updatedAt: Date.now() + 60000 });
  H.snapshot({ exists: true, metadata: { hasPendingWrites: false }, data: () => ({ data: JSON.stringify([edited]) }) });
};
H.pickerRecovers = async function (fails, label) {
  const t0 = Date.now();
  const done = await H.until(() => !window._rrListingImportInFlight, 2000);
  H.check(fails, done, label + ': import guard released');
  H.check(fails, !done || Date.now() - t0 < 1300, label + ': released within about 1s, took ' + (Date.now() - t0) + 'ms');
  H.check(fails, !document.getElementById('rrPlanPicker'), label + ': picker gone');
  H.check(fails, H.toastHas('Import cancelled'), label + ': cancelled toast');
};
H.nextImportWorks = async function (fails, n) {
  if (!document.getElementById('add_choice_url')) { closeAddModal(true); openAddModal('house'); }
  const before = records.length;
  H.pasteImport(single(n));
  const ok = await H.until(() => records.length === before + 1 && !window._rrListingImportInFlight);
  H.check(fails, ok, 'next import creates a record, not busy');
  H.check(fails, !H.toastHas('still running'), 'next import is not refused as busy');
};

H.scenarios = {
  'S3 Enter manually then Back: cancels, next import starts, remote edit renders': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown in drawer');
    showManualAddForm();
    showAddChoice();
    await H.pickerRecovers(fails, 'after Back');
    await H.nextImportWorks(fails, 8522);
    const rec = records[0];
    await H.until(() => !document.querySelector('#detailModal.open'), 1500);
    closeDetail && closeDetail();
    const renders = H.log.renders;
    if (document.activeElement) document.activeElement.blur();
    H.remoteEdit(rec);
    H.check(fails, records.find((x) => x.id === rec.id).note === 'remote edit', 'remote edit merged');
    H.check(fails, await H.until(() => H.log.renders > renders, 2500), 'remote edit rendered');
    return { fails };
  },
  'S3 Enter manually alone hides the picker: cancels within 1s': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown');
    showManualAddForm();
    await H.pickerRecovers(fails, 'hidden step');
    return { fails };
  },
  'S3 rewriting #detailPanel: cancels within 1s': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown');
    document.getElementById('detailPanel').innerHTML = '<div class="modal-body">something else</div>';
    await H.pickerRecovers(fails, 'panel rewritten');
    return { fails };
  },
  'S3 closing the drawer behind the picker: cancels within 1s': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown');
    document.getElementById('detailModal').classList.remove('open');
    await H.pickerRecovers(fails, 'drawer closed');
    return { fails };
  },
  'S3 a live picker is left alone and still answers': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown');
    await H.wait(1500);
    const host = document.querySelector('#detailModal #rrPlanPicker');
    H.check(fails, !!host && window._rrListingImportInFlight, 'still open after 1.5s');
    if (host) {
      host.querySelectorAll('input[name="rrPlanPick"]')[1].click();
      host.querySelector('[data-plan-action="use"]').click();
    }
    H.check(fails, await H.until(() => records.length === 1 && !window._rrListingImportInFlight), 'picked plan imports');
    const r = records[0];
    H.check(fails, r && r.propertyDetails.sqft === 1088 && r.propertyDetails.monthlyRent === 2166, 'numbers from B3.1');
    const note = r && r.propertyNote && r.propertyNote.text || '';
    H.check(fails, note.includes('B3.1 offers') && !note.includes('water views'), 'S2 bullets end to end: ' + note);
    return { fails };
  },
  'S3 dialog picker (no drawer) stays, then cancels if removed': async () => {
    const fails = [];
    window.postMessage({ rrExtension: true, type: 'LISTING_IMPORTED', data: PLANS }, location.origin);
    const shown = await H.until(() => document.querySelector('.multi-editor-overlay#rrPlanPicker'));
    H.check(fails, shown, 'dialog picker shown');
    await H.wait(1200);
    H.check(fails, !!document.getElementById('rrPlanPicker'), 'dialog survives with no drawer open');
    document.getElementById('rrPlanPicker').remove();
    await H.pickerRecovers(fails, 'dialog removed');
    return { fails };
  },
  'Nit closeAddModal cancels the picker only after the discard is confirmed': async () => {
    const fails = [];
    H.check(fails, await H.startPicker(), 'picker shown');
    const field = document.createElement('input');
    field.id = 'add_name'; field.value = 'typed'; field.type = 'hidden';
    document.getElementById('addStep1').appendChild(field);
    let confirmOpts = null;
    showAppConfirm = (msg, opts) => { confirmOpts = opts; };
    closeAddModal();
    H.check(fails, !!confirmOpts, 'discard confirm shown');
    await H.wait(700);
    H.check(fails, !!document.getElementById('rrPlanPicker') && window._rrListingImportInFlight, 'picker survives an unanswered confirm');
    confirmOpts && confirmOpts.onConfirm();
    await H.pickerRecovers(fails, 'after discard');
    return { fails };
  },

  'S4 Replace Old, forced throw while building: old stays, nothing new': async () => {
    const fails = [];
    const forces = {
      bullets: () => { const k = _rrBulletsForRecord; _rrBulletsForRecord = () => { throw new Error('forced'); }; return () => { _rrBulletsForRecord = k; }; },
      date: () => { const k = rrNormalizeAvailableDate; rrNormalizeAvailableDate = () => { throw new Error('forced'); }; return () => { rrNormalizeAvailableDate = k; }; },
      afterCreate: () => { const k = _afterPropertyCreate; _afterPropertyCreate = () => { throw new Error('forced'); }; return () => { _afterPropertyCreate = k; }; },
    };
    showDuplicateDialog = async () => 'replace';
    for (const [name, force] of Object.entries(forces)) {
      records = [oldRecord(8522)];
      _deletedRecordIds.clear();
      H.log.softDeletes.length = 0; H.log.saves.length = 0; H.log.toasts.length = 0;
      const undo = force();
      const out = await _rrRunListingImport('u', () => handleExtensionListing(single(8522, { propertyDetails: { availableDate: 'Now' } })));
      undo();
      H.check(fails, out === 'failed', name + ': outcome failed, got ' + out);
      H.check(fails, records.length === 1 && records[0].id === 'old_8522', name + ': records are ' + records.map((x) => x.id));
      H.check(fails, !_deletedRecordIds.has('old_8522'), name + ': old not marked deleted');
      H.check(fails, H.log.softDeletes.length === 0, name + ': no soft delete');
      H.check(fails, H.log.saves.length === 0, name + ': no save');
      H.check(fails, H.toastHas('Import failed'), name + ': error toast');
    }
    return { fails };
  },
  'S4 Replace Old succeeds: one step, current object soft-deleted': async () => {
    const fails = [];
    records = [oldRecord(8522), oldRecord(99)];
    // A remote merge lands while the dialog is up and swaps the record objects.
    showDuplicateDialog = async () => { records = records.map((x) => Object.assign({}, x, { _mark: 'merged' })); return 'replace'; };
    const out = await _rrRunListingImport('u', () => handleExtensionListing(single(8522)));
    H.check(fails, out === 'created', 'created, got ' + out);
    H.check(fails, records.length === 2 && records[0].id !== 'old_8522' && !records.some((x) => x.id === 'old_8522'), 'old out, new first: ' + records.map((x) => x.id));
    H.check(fails, _deletedRecordIds.has('old_8522'), 'old marked deleted');
    H.check(fails, H.log.softDeletes.length === 1 && H.log.softDeletes[0].mark === 'merged', 'soft-deleted the current object: ' + JSON.stringify(H.log.softDeletes));
    const save = H.log.saves[0];
    H.check(fails, save.by === 'handleExtensionListing' && save.ids[0] === records[0].id && !save.ids.includes('old_8522') && save.softDeletesSoFar === 1, 'first save is the swap: ' + JSON.stringify(H.log.saves));
    H.check(fails, H.log.saves.slice(1).every((x) => x.by !== 'handleExtensionListing'), 'the import itself saves once: ' + JSON.stringify(H.log.saves));
    return { fails, note: H.log.saves.map((x) => x.by).join(',') };
  },
  'S4 Replace Old when the old record vanished meanwhile: new still lands': async () => {
    const fails = [];
    records = [oldRecord(8522)];
    showDuplicateDialog = async () => { records = []; return 'replace'; };
    const out = await _rrRunListingImport('u', () => handleExtensionListing(single(8522)));
    H.check(fails, out === 'created' && records.length === 1, 'new record landed');
    H.check(fails, H.log.softDeletes.length === 0, 'nothing to soft-delete');
    return { fails };
  },
  'S4 Co-Hosting Replace Old, forced throw: old stays, nothing new': async () => {
    const fails = [];
    showDuplicateDialog = async () => 'replace';
    for (const name of ['_rrBulletsForRecord', '_afterPropertyCreate']) {
      cohostRecords = [oldRecord(8522, { kind: 'cohost' })];
      _deletedCohostIds.clear();
      H.log.softDeletes.length = 0; H.log.cohostSaves.length = 0; H.log.toasts.length = 0;
      const keep = window[name];
      window[name] = () => { throw new Error('forced'); };
      const out = await _rrRunListingImport('u', () => handleCohostListing(single(8522)));
      window[name] = keep;
      H.check(fails, out === 'failed', name + ': outcome failed, got ' + out);
      H.check(fails, cohostRecords.length === 1 && cohostRecords[0].id === 'old_8522', name + ': records are ' + cohostRecords.map((x) => x.id));
      H.check(fails, !_deletedCohostIds.has('old_8522'), name + ': old not marked deleted');
      H.check(fails, H.log.softDeletes.length === 0, name + ': no soft delete');
      H.check(fails, H.log.cohostSaves.length === 0, name + ': no save');
    }
    return { fails };
  },
  'S4 Co-Hosting Replace Old succeeds after the market lookup': async () => {
    const fails = [];
    cohostRecords = [oldRecord(8522, { kind: 'cohost' })];
    showDuplicateDialog = async () => { cohostRecords = cohostRecords.map((x) => Object.assign({}, x, { _mark: 'merged' })); return 'replace'; };
    openCohostProfile = () => {};
    const out = await _rrRunListingImport('u', () => handleCohostListing(single(8522)));
    H.check(fails, out === 'created', 'created, got ' + out);
    H.check(fails, cohostRecords.length === 1 && cohostRecords[0].id !== 'old_8522', 'swapped');
    H.check(fails, _deletedCohostIds.has('old_8522'), 'old marked deleted');
    H.check(fails, H.log.softDeletes.length === 1 && H.log.softDeletes[0].mark === 'merged' && H.log.softDeletes[0].c === 'cohostRecords', 'current object soft-deleted');
    const save = H.log.cohostSaves[0];
    H.check(fails, H.log.cohostSaves.length === 1 && save.ids.length === 1 && save.ids[0] === cohostRecords[0].id && save.softDeletesSoFar === 1, 'one save, after the swap: ' + JSON.stringify(H.log.cohostSaves));
    return { fails };
  },

  'S5 popup import during an import queues one, then runs it': async () => {
    const fails = [];
    let release;
    rrScrapeViaExtension = () => new Promise((r) => { release = r; });
    openAddModal('house');
    document.getElementById('add_choice_url').value = 'https://www.zillow.com/first';
    importFromChoicePaste();
    await H.wait(50);
    const post = (data) => window.postMessage({ rrExtension: true, type: 'LISTING_IMPORTED', data }, location.origin);
    post(single(1000));
    await H.until(() => H.toastHas('Queued'), 500);
    H.check(fails, H.toastHas('Queued — will import when the current one finishes.'), 'queued toast: ' + H.log.toasts);
    H.log.toasts.length = 0;
    post(single(2000));
    await H.until(() => H.toastHas('already queued'), 500);
    H.check(fails, H.toastHas('already queued'), 'a second one is told to re-import: ' + H.log.toasts);
    H.check(fails, records.length === 0, 'nothing saved yet');
    release({ ok: true, data: single(3000) });
    H.check(fails, await H.until(() => records.length === 2 && !window._rrListingImportInFlight), 'current and queued both landed: ' + records.map((x) => x.property));
    await H.wait(200);
    const names = records.map((x) => x.property).join('|');
    H.check(fails, names.includes('3000') && names.includes('1000') && !names.includes('2000'), 'the right two: ' + names);
    return { fails };
  },
  'S5 a failed or cancelled import still runs the queued one': async () => {
    const fails = [];
    for (const res of [{ ok: false, error: 'timeout', detail: 'nope' }, { ok: true, data: {} }]) {
      records = [];
      H.log.toasts.length = 0;
      let release;
      rrScrapeViaExtension = () => new Promise((r) => { release = r; });
      closeAddModal(true);
      openAddModal('house');
      document.getElementById('add_choice_url').value = 'https://www.zillow.com/first';
      importFromChoicePaste();
      await H.wait(50);
      window.postMessage({ rrExtension: true, type: 'LISTING_IMPORTED', data: single(1000) }, location.origin);
      await H.until(() => H.toastHas('Queued'), 500);
      release(res);
      H.check(fails, await H.until(() => records.length === 1 && !window._rrListingImportInFlight), 'queued ran after ' + JSON.stringify(res));
    }
    return { fails };
  },

  'Empty-page guard: a price with no address or unit numbers saves nothing': async () => {
    const fails = [];
    const payload = { address: null, bedrooms: null, bathrooms: null, sqft: null, price: 500, propertyDetails: { propertyType: 'Apartment' }, propertyNoteBullets: [] };
    records = [oldRecord(99)];
    const out = await _rrRunListingImport('u', () => handleExtensionListing(JSON.parse(JSON.stringify(payload))));
    await H.wait(50);
    H.check(fails, out === 'failed', 'outcome failed, got ' + out);
    H.check(fails, H.log.toasts.length === 1 && H.log.toasts[0] === 'Import failed — nothing could be read from this listing.', 'one error toast: ' + JSON.stringify(H.log.toasts));
    H.check(fails, records.length === 1 && records[0].id === 'old_99', 'records unchanged: ' + records.map((x) => x.id));
    H.check(fails, H.log.saves.length === 0, 'no saveData call');
    cohostRecords = [];
    const co = await _rrRunListingImport('u', () => handleCohostListing(JSON.parse(JSON.stringify(payload))));
    H.check(fails, co === 'failed' && cohostRecords.length === 0 && H.log.cohostSaves.length === 0, 'Co-Hosting saves nothing either');
    return { fails };
  },
  'Empty-page guard: an address and a price is still a partial import': async () => {
    const fails = [];
    const out = await _rrRunListingImport('u', () => handleExtensionListing({ address: '1625 Bulevar Mayor St, Gulf Breeze, FL 32561', sourceUrl: 'https://www.apartments.com/x/', price: 2750, propertyDetails: {} }));
    H.check(fails, out === 'created' && records.length === 1, 'created, got ' + out);
    H.check(fails, records[0] && records[0].propertyDetails.monthlyRent === 2750, 'rent kept');
    H.check(fails, H.toastHas('Import partial'), 'partial toast: ' + H.log.toasts);
    return { fails };
  },
  'Drawer close logs its source': async () => {
    const fails = [];
    const seen = [];
    const realInfo = console.info;
    console.info = function (a, b) { if (a === '[RR drawer] close') seen.push(b); return realInfo.apply(console, arguments); };
    try {
      openAddModal('house');
      document.querySelector('#detailModal .modal-close').click();
      openAddModal('house');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      openAddModal('house');
      closeAddModal(true);
    } finally { console.info = realInfo; }
    H.check(fails, seen.join() === 'button,escape,programmatic', 'reasons: ' + seen.join());
    return { fails };
  },
  'T5b duplicate found by the scraped address when geocoding drops the unit': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    let shown = null;
    showDuplicateDialog = async (addr, rec) => { shown = rec.id; return 'cancel'; };
    rrGeocodeAddress = async () => ({ lat: 30, lng: -87, street: '8436 Gulf Blvd', unit: '', city: 'Navarre', state: 'FL', zip: '32566', formattedAddress: '8436 Gulf Blvd' });
    records = [{ id: 'r714', property: '8436 Gulf Blvd #Unit 714, Navarre FL 32566', addressParts: { street: '8436 Gulf Blvd', unit: '#Unit 714', city: 'Navarre', state: 'FL', zip: '32566' }, propertyDetails: {} }];
    try {
      const out = await _rrRunListingImport('u', () => handleExtensionListing(single(8436, { address: '8436 Gulf Blvd Unit 714, Navarre, FL 32566' })));
      H.check(fails, out === 'cancelled' && shown === 'r714', 'matched r714 on the scraped address: ' + out + ' ' + shown);
    } finally { console.log = realLog; }
    H.check(fails, traces.some((t) => /dup check: key=8436 gulf blvd\|714\|32566 records=1 match=r714$/.test(t)), 'trace line: ' + traces.filter((t) => t.includes('dup')));
    return { fails };
  },
  'T5b a record that syncs in during the import is caught before saving': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    let dialogs = 0;
    showDuplicateDialog = async () => { dialogs++; return 'cancel'; };
    const realGeo = rrGeocodeAddress;
    // The other tab's record lands by sync while this import waits on the geocoder.
    rrGeocodeAddress = async (a) => { const g = await realGeo(a); records.push({ id: 'synced', property: '8522 Gulf Blvd, Navarre FL 32566', addressParts: { street: '8522 Gulf Blvd', unit: '', zip: '32566' }, propertyDetails: {} }); return g; };
    records = [];
    try {
      const out = await _rrRunListingImport('u', () => handleExtensionListing(single(8522)));
      H.check(fails, out === 'cancelled' && dialogs === 1 && records.length === 1, 'caught: ' + out + ' dialogs=' + dialogs + ' records=' + records.length);
    } finally { console.log = realLog; }
    // Simulates the sync landing after the first check instead.
    records = [];
    dialogs = 0;
    rrGeocodeAddress = realGeo;
    const realLimit = checkPropertyLimit;
    checkPropertyLimit = () => { records.push({ id: 'late', property: '8522 Gulf Blvd, Navarre FL 32566', propertyDetails: {} }); return true; };
    const out2 = await _rrRunListingImport('u', () => handleExtensionListing(single(8522)));
    checkPropertyLimit = realLimit;
    H.check(fails, out2 === 'cancelled' && dialogs === 1 && records.length === 1 && records[0].id === 'late', 'the second check caught it: ' + out2 + ' dialogs=' + dialogs + ' ' + records.map((x) => x.id));
    H.check(fails, traces.filter((t) => t.includes('dup check')).length >= 1, 'trace lines written');
    return { fails };
  },
  'T5b the duplicate dialog shows the existing record and the new one': async () => {
    const fails = [];
    const p = showDuplicateDialog('8436 Gulf Blvd #714, Navarre FL 32566', { id: 'x', property: '8436 Gulf Blvd Unit 714, Navarre FL 32566', status: 'Contacted', createdAt: new Date().toISOString() });
    const ov = document.getElementById('duplicateDialogOverlay');
    H.check(fails, ov && document.getElementById('dupDialogNewName').textContent === '8436 Gulf Blvd #714, Navarre FL 32566', 'new name shown');
    H.check(fails, ov && document.getElementById('dupDialogExistingName').textContent === '8436 Gulf Blvd Unit 714, Navarre FL 32566', 'existing name shown');
    document.getElementById('dupDialogCancelBtn').click();
    H.check(fails, (await p) === 'cancel', 'still answers');
    return { fails };
  },
  'T5b cleanup lists a rent-only junk profile and one with no link, unchecked': async () => {
    const fails = [];
    records = [
      { id: 'junk', property: 'Apartments for Rent in Dallas TX | Apartments.com', link: 'https://www.apartments.com/dallas-tx/', addressParts: { street: '' }, propertyDetails: { monthlyRent: 500 } },
      { id: 'nolink', property: 'New Property', propertyDetails: {} },
      { id: 'real', property: 'New Property', link: 'https://www.zillow.com/a', propertyDetails: { bedrooms: 2, monthlyRent: 1900 } },
    ];
    openBlankImportCleanupModal();
    const boxes = Array.from(document.querySelectorAll('#blankImportCleanupOverlay input[data-blank-id]'));
    H.check(fails, boxes.map((b) => b.getAttribute('data-blank-id')).join() === 'junk,nolink', 'listed: ' + boxes.map((b) => b.getAttribute('data-blank-id')));
    H.check(fails, boxes.every((b) => !b.checked), 'all unchecked');
    const text = document.getElementById('blankImportCleanupOverlay').textContent;
    H.check(fails, text.includes('no source link') && text.includes('apartments.com/dallas-tx'), 'link or "no source link" shown');
    // The delete-time recheck: the junk profile gains beds by sync after listing.
    boxes.forEach((b) => { b.checked = true; });
    records[0].propertyDetails.bedrooms = 1;
    showAppConfirm = (msg, o) => o.onConfirm();
    _confirmBlankImportCleanup();
    H.check(fails, records.map((r) => r.id).join() === 'junk,real', 'recheck kept the filled-in one: ' + records.map((r) => r.id));
    return { fails };
  },
  'T5b a load that never answers shows Try again, not endless loading': async () => {
    const fails = [];
    const warns = [];
    const realWarn = console.warn;
    console.warn = function (a, b) { if (a === '[RR] account load timed out:') warns.push(b); return realWarn.apply(console, arguments); };
    const realSet = window.setTimeout;
    window.setTimeout = function (fn, ms, ...rest) { return realSet.call(window, fn, ms === 45000 ? 40 : ms, ...rest); };
    const hang = () => new Promise(() => {});
    const user = { uid: 'harness2', email: 'h@example.com', displayName: 'H', emailVerified: true, providerData: [{ providerId: 'google.com' }], getIdToken: async () => 'x' };
    try {
      for (const step of ['user doc', 'records']) {
        db.collection = () => new Proxy(function () {}, {
          get(_, k) {
            if (k === 'then') return undefined;
            if (k === 'get') return () => (step === 'user doc' ? hang() : Promise.resolve({ exists: true, data: () => ({ tier: 'pro', subscriptionStatus: 'active', disclaimerAcknowledged: true }) }));
            if (k === 'set' || k === 'update' || k === 'delete') return async () => {};
            if (k === 'onSnapshot') return () => () => {};
            if (k === 'doc') return (id) => (id === 'records' ? { get: hang, onSnapshot: () => () => {}, set: async () => {} } : db.collection());
            return db.collection();
          },
          apply() { return db.collection(); },
        });
        _currentUid = null; _authDataLoaded = false; _authLoadError = null; records = [{ id: 'keep' }];
        await _handleAuthUser(user);
        await H.wait(50);
        const area = document.getElementById('contentArea').textContent;
        H.check(fails, _authLoadError && _authLoadError._rrLoadTimeout, step + ': _authLoadError set');
        H.check(fails, !_currentUid, step + ': not left half signed in');
        H.check(fails, area.includes("We couldn't load your account") && area.includes('Try again') && area.includes('Loading timed out (' + step + ')'), step + ': Try again screen: ' + area.slice(0, 160));
        H.check(fails, warns.includes(step), step + ': step logged: ' + warns);
      }
    } finally { window.setTimeout = realSet; console.warn = realWarn; }
    return { fails };
  },
  'T5b a slow read shows Try again, then loads by itself when it answers': async () => {
    const fails = [];
    const realSet = window.setTimeout;
    const auth = firebase.auth();
    const user = { uid: 'harness3', email: 'h@example.com', displayName: 'H', emailVerified: true, providerData: [{ providerId: 'google.com' }], getIdToken: async () => 'x' };
    Object.defineProperty(auth, 'currentUser', { get: () => user, configurable: true });
    const lines = [];
    const realLog = console.log;
    console.log = function (a, b) { if (String(a).startsWith('[RR] account load')) lines.push(a + ' ' + b); return realLog.apply(console, arguments); };
    let nullSaves = 0;
    const realSave = saveData;
    saveData = function () { if (!_currentUid) nullSaves++; return realSave.apply(this, arguments); };
    // Test timeout 60 ms; the slow read answers at 90 ms, about 1.5x.
    window.setTimeout = function (fn, ms, ...rest) { return realSet.call(window, fn, ms === 45000 ? 60 : ms, ...rest); };
    const later = (ms, v) => new Promise((r) => realSet.call(window, () => r(v), ms));
    const userDoc = { exists: true, data: () => ({ tier: 'pro', subscriptionStatus: 'active', disclaimerAcknowledged: true }) };
    const recordsDoc = { exists: true, data: () => ({ data: JSON.stringify([{ id: 'r1', property: '1 Main St, Navarre FL 32566', propertyDetails: {} }]) }) };
    try {
      for (const step of ['user doc', 'records']) {
        let slowLeft = 1;
        const read = (doc, isStep) => () => (isStep && slowLeft-- > 0 ? later(90, doc) : Promise.resolve(doc));
        db.collection = () => new Proxy(function () {}, {
          get(_, k) {
            if (k === 'then') return undefined;
            if (k === 'get') return read(userDoc, step === 'user doc');
            if (k === 'set' || k === 'update' || k === 'delete') return async () => {};
            if (k === 'onSnapshot') return () => () => {};
            if (k === 'doc') return (id) => (id === 'records' ? { get: read(recordsDoc, step === 'records'), onSnapshot: () => () => {}, set: async () => {} } : db.collection());
            return db.collection();
          },
          apply() { return db.collection(); },
        });
        _currentUid = null; _authDataLoaded = false; _authLoadError = null; records = []; lines.length = 0; nullSaves = 0;
        await _handleAuthUser(user);
        const area = document.getElementById('contentArea').textContent;
        H.check(fails, area.includes('Try again') && _authLoadError && _authLoadError._rrLoadTimeout, step + ': Try again shown first');
        const loaded = await H.until(() => _currentUid === 'harness3' && _authDataLoaded && records.length > 0, 3000);
        H.check(fails, loaded, step + ': loaded by itself, records=' + records.length + ' uid=' + _currentUid);
        H.check(fails, !_authLoadError, step + ': error cleared');
        H.check(fails, lines.includes('[RR] account load finished late: ' + step), step + ': late line logged: ' + lines);
        H.check(fails, nullSaves === 0, step + ': saves while signed-out state: ' + nullSaves);
      }
    } finally {
      window.setTimeout = realSet; console.log = realLog; saveData = realSave;
      delete auth.currentUser;
    }
    return { fails };
  },
  'T5b a Try again already running wins over the late answer': async () => {
    const fails = [];
    const realSet = window.setTimeout;
    const auth = firebase.auth();
    const user = { uid: 'harness4', email: 'h@example.com', displayName: 'H', emailVerified: true, providerData: [{ providerId: 'google.com' }], getIdToken: async () => 'x' };
    Object.defineProperty(auth, 'currentUser', { get: () => user, configurable: true });
    window.setTimeout = function (fn, ms, ...rest) { return realSet.call(window, fn, ms === 45000 ? 60 : ms, ...rest); };
    const later = (ms, v) => new Promise((r) => realSet.call(window, () => r(v), ms));
    const userDoc = { exists: true, data: () => ({ tier: 'pro', subscriptionStatus: 'active', disclaimerAcknowledged: true }) };
    const recordsDoc = { exists: true, data: () => ({ data: JSON.stringify([{ id: 'r1', property: '1 Main St', propertyDetails: {} }]) }) };
    // First read: answers at 90 ms (after the timeout). Second read (the click): 50 ms.
    const delays = [90, 50];
    db.collection = () => new Proxy(function () {}, {
      get(_, k) {
        if (k === 'then') return undefined;
        if (k === 'get') return () => later(delays.shift() || 0, userDoc);
        if (k === 'set' || k === 'update' || k === 'delete') return async () => {};
        if (k === 'onSnapshot') return () => () => {};
        if (k === 'doc') return (id) => (id === 'records' ? { get: () => Promise.resolve(recordsDoc), onSnapshot: () => () => {}, set: async () => {} } : db.collection());
        return db.collection();
      },
      apply() { return db.collection(); },
    });
    const lines = [];
    const realLog = console.log;
    console.log = function (a, b) { if (String(a).startsWith('[RR] account load')) lines.push(a + ' ' + b); return realLog.apply(console, arguments); };
    let loads = 0;
    const realHandle = _handleAuthUser;
    _handleAuthUser = function () { loads++; return realHandle.apply(this, arguments); };
    try {
      _currentUid = null; _authDataLoaded = false; _authLoadError = null; records = [];
      await realHandle(user);
      H.check(fails, !!_authLoadError, 'timed out first');
      await H.wait(15);
      _retryAccountLoad(); // the click, at about 75 ms; the first read answers at 90 ms
      const loaded = await H.until(() => _authDataLoaded && records.length > 0, 3000);
      await H.wait(150);
      H.check(fails, loaded, 'loaded');
      H.check(fails, loads === 1, 'one load after the click, got ' + loads);
      H.check(fails, lines.includes('[RR] account load finished late: user doc'), 'the late answer arrived and was logged: ' + lines);
    } finally {
      window.setTimeout = realSet; _handleAuthUser = realHandle; console.log = realLog;
      delete auth.currentUser;
    }
    return { fails };
  },
  'T8 a failed Resend ends on an enabled button, not "Sending..."': async () => {
    const fails = [];
    const auth = firebase.auth();
    const user = { uid: 'v1', email: 'v1@example.com', emailVerified: false, reload: async () => {},
      sendEmailVerification: () => Promise.reject(Object.assign(new Error('offline'), { code: 'auth/network-request-failed' })) };
    Object.defineProperty(auth, 'currentUser', { get: () => user, configurable: true });
    try {
      localStorage.removeItem(verifyEmailKey('v1'));
      showEmailVerificationScreen(user);
      const btn = document.getElementById('emailVerifyResendBtn');
      H.check(fails, btn && !btn.disabled, 'Resend starts enabled');
      btn.click();
      H.check(fails, btn.textContent === 'Sending...', 'shows Sending... while it runs: ' + btn.textContent);
      await H.until(() => btn.textContent !== 'Sending...', 2000);
      await H.wait(50);
      H.check(fails, !btn.disabled && btn.textContent === 'Resend Verification Email', 'ends enabled: ' + btn.disabled + ' ' + btn.textContent);
      H.check(fails, /Failed to send email/.test(document.getElementById('emailVerifyMsg').textContent), 'failure message: ' + document.getElementById('emailVerifyMsg').textContent);
      H.check(fails, localStorage.getItem(verifyEmailKey('v1')) === null, 'no stored cooldown');
      await H.wait(1200);
      H.check(fails, !btn.disabled && btn.textContent === 'Resend Verification Email', 'still enabled after the 1 s tick');
    } finally {
      _dismissEmailVerificationScreen();
      delete auth.currentUser;
    }
    return { fails };
  },
  'T8 signup still sends one email when updateProfile fails': async () => {
    const fails = [];
    const auth = firebase.auth();
    let sends = 0;
    const user = { uid: 'v2', email: 'v2@example.com', emailVerified: false, displayName: null, photoURL: null,
      updateProfile: () => Promise.reject(Object.assign(new Error('profile'), { code: 'auth/internal-error' })),
      sendEmailVerification: async () => { sends++; } };
    auth.createUserWithEmailAndPassword = async () => ({ user });
    try {
      localStorage.removeItem(verifyEmailKey('v2'));
      showAuthModal('signup');
      document.getElementById('authName').value = 'V Two';
      document.getElementById('authEmail').value = 'v2@example.com';
      document.getElementById('authPassword').value = 'password1';
      document.getElementById('authPasswordConfirm').value = 'password1';
      handleEmailSignUp();
      await H.until(() => sends > 0, 2000);
      await H.wait(300);
      H.check(fails, sends === 1, 'exactly one send, got ' + sends);
      H.check(fails, !document.getElementById('authModal').classList.contains('open'), 'the auth modal closed');
      const err = document.getElementById('authError');
      H.check(fails, !err || !err.textContent.trim() || err.style.display === 'none', 'no auth error shown: ' + (err && err.textContent));
    } finally {
      delete auth.createUserWithEmailAndPassword;
      localStorage.removeItem(verifyEmailKey('v2'));
    }
    return { fails };
  },
  'Nit race timers are cleared, timeouts leave a trace line': async () => {
    const fails = [];
    const longTimers = new Map();
    const realSet = window.setTimeout, realClear = window.clearTimeout;
    window.setTimeout = function (fn, ms, ...rest) {
      const shrink = ms === 180000 || ms === 15000;
      const id = realSet.call(window, fn, shrink && H.shrink ? 30 : ms, ...rest);
      if (shrink) longTimers.set(id, ms);
      return id;
    };
    window.clearTimeout = function (id) { longTimers.delete(id); return realClear.call(window, id); };
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    try {
      rrScrapeViaExtension = async () => ({ ok: true, data: {} });
      await _rrScrapeListing('u');
      await _rrGeocodeListing('1 Main St, Navarre, FL 32566');
      await H.wait(10);
      H.check(fails, !longTimers.size, 'timers left running: ' + [...longTimers.values()]);
      H.shrink = true;
      rrScrapeViaExtension = () => new Promise(() => {});
      rrGeocodeAddress = () => new Promise(() => {});
      await _rrRunListingImport('u', async () => {
        const s = await _rrScrapeListing('u');
        H.check(fails, s && s.error === 'timeout', 'watchdog result');
        const g = await _rrGeocodeListing('1 Main St, Navarre, FL 32566');
        H.check(fails, g && g.street, 'geocode falls back to the local parse');
        return 'failed';
      });
      H.check(fails, traces.some((t) => t.includes('scrape watchdog timeout')), 'watchdog trace: ' + traces);
      H.check(fails, traces.some((t) => t.includes('geocode timeout')), 'geocode trace: ' + traces);
    } finally {
      window.setTimeout = realSet; window.clearTimeout = realClear; console.log = realLog; H.shrink = false;
    }
    return { fails };
  },
  'Nit the enrichment message no longer touches records': async () => {
    const fails = [];
    records = [oldRecord(8522, { link: 'https://www.zillow.com/8522', propertyDetails: {} })];
    window.postMessage({ rrExtension: true, type: 'LISTING_ENRICHMENT', patch: { sourceUrl: 'https://www.zillow.com/8522', bedrooms: 5 } }, location.origin);
    await H.wait(150);
    H.check(fails, records[0].propertyDetails.bedrooms == null, 'record was patched');
    H.check(fails, typeof handleListingEnrichment === 'undefined', 'handler still defined');
    return { fails };
  },
};

// Runs across a reload, so its log lives in sessionStorage.
H.startQueueThenReload = async function () {
  sessionStorage.removeItem('rrHarnessQueueLog');
  const note = (s) => sessionStorage.setItem('rrHarnessQueueLog', (sessionStorage.getItem('rrHarnessQueueLog') ? sessionStorage.getItem('rrHarnessQueueLog') + ',' : '') + s);
  const real = handleExtensionListing;
  handleExtensionListing = async function (d) { note(d.sourceUrl.endsWith('1000') ? 'queued' : 'first'); await H.wait(100); return real(d); };
  let release;
  rrScrapeViaExtension = () => new Promise((r) => { release = r; });
  openAddModal('house');
  document.getElementById('add_choice_url').value = 'https://www.zillow.com/first';
  importFromChoicePaste();
  await H.wait(50);
  window._rrReloadAfterImport = true;
  window.postMessage({ rrExtension: true, type: 'LISTING_IMPORTED', data: single(1000) }, location.origin);
  await H.wait(50);
  release({ ok: true, data: single(3000) });
};
