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

  'T11 Co-Hosting cap: counts only pipeline records; tier and trial set the limit': async () => {
    const fails = [];
    const saved = { tier: currentTier, sub: _subscriptionStatus };
    cohostRecords = [1, 2, 3, 4, 5].map((n) => oldRecord(9100 + n, { kind: 'cohost' }));
    cohostRecords[0].stage = 'operations'; // moved to Operations: counts there, not here
    currentTier = 'basic'; _subscriptionStatus = 'active';
    H.check(fails, getCohostLimit() === 5, 'basic limit 5, got ' + getCohostLimit());
    H.check(fails, getCohostUsed() === 4, 'ops-stage record excluded, used=' + getCohostUsed());
    H.check(fails, canAddCohost() === true, 'basic with 4 pipeline records can add');
    cohostRecords[0].stage = undefined;
    H.check(fails, getCohostUsed() === 5 && canAddCohost() === false, 'basic at 5 cannot add');
    currentTier = 'standard';
    H.check(fails, getCohostLimit() === 10 && canAddCohost() === true, 'standard limit 10');
    currentTier = 'pro';
    H.check(fails, getCohostLimit() === Infinity, 'pro unlimited');
    currentTier = 'basic'; _subscriptionStatus = 'trialing';
    H.check(fails, getCohostLimit() === Infinity, 'trial unlimited');
    _subscriptionStatus = 'active';
    H.check(fails, /Co-Hosting: 5 of 5 used/.test(renderCohostUsageIndicator()), 'usage indicator shows 5 of 5');
    currentTier = 'pro';
    H.check(fails, renderCohostUsageIndicator() === '', 'no indicator on unlimited tiers');
    currentTier = saved.tier; _subscriptionStatus = saved.sub;
    return { fails };
  },
  'T11 Co-Hosting cap: at the cap an import is refused with the upgrade prompt, Replace still works': async () => {
    const fails = [];
    const saved = { tier: currentTier, sub: _subscriptionStatus, confirm: showAppConfirm };
    const prompts = [];
    showAppConfirm = (msg, opts) => { prompts.push((opts && opts.title) || ''); };
    cohostRecords = [1, 2, 3, 4, 5].map((n) => oldRecord(9200 + n, { kind: 'cohost' }));
    currentTier = 'basic'; _subscriptionStatus = 'active';
    H.log.cohostSaves.length = 0; H.log.softDeletes.length = 0;
    openCohostProfile = () => {};
    // Net-new address: refused.
    const out1 = await _rrRunListingImport('u', () => handleCohostListing(single(9300)));
    H.check(fails, out1 === 'failed', 'net-new import failed, got ' + out1);
    H.check(fails, cohostRecords.length === 5, 'still 5 records');
    H.check(fails, H.log.cohostSaves.length === 0, 'no save');
    H.check(fails, prompts.length === 1 && prompts[0] === 'Co-Hosting limit reached', 'upgrade prompt shown: ' + JSON.stringify(prompts));
    // Exact duplicate with Replace: count stays flat, so it goes through.
    showDuplicateDialog = async () => 'replace';
    const out2 = await _rrRunListingImport('u', () => handleCohostListing(single(9203)));
    H.check(fails, out2 === 'created', 'replace import created, got ' + out2);
    H.check(fails, cohostRecords.length === 5 && !cohostRecords.some((x) => x.id === 'old_9203'), 'swapped, still 5');
    H.check(fails, prompts.length === 1, 'no second prompt');
    // Add menu: prompt instead of the modal. Manual save: prompt, nothing added.
    openCohostAddModal();
    H.check(fails, !document.getElementById('cohostAddBody') && prompts.length === 2, 'add modal replaced by the prompt');
    const inp = document.createElement('input'); inp.id = 'cohost_m_address'; inp.value = '1 Cap St, Navarre, FL 32566'; document.body.appendChild(inp);
    saveCohostManual();
    inp.remove();
    H.check(fails, cohostRecords.length === 5 && prompts.length === 3, 'manual save refused');
    showAppConfirm = saved.confirm; currentTier = saved.tier; _subscriptionStatus = saved.sub;
    return { fails };
  },

  'T11 KB seed: a reworded starter question renames the existing entry in place': async () => {
    const fails = [];
    const saved = { admin: _isAdmin, kb: _kbState, confirm: window.confirm, embed: kbCallEmbeddingApi, col: db.collection };
    const calls = { update: [], add: [], del: [] };
    _isAdmin = true;
    window.confirm = () => true;
    kbCallEmbeddingApi = async () => ({ embedding: [0], model: 'stub' });
    db.collection = (name) => ({
      doc: (id) => ({ update: async (d) => { calls.update.push({ id, d }); }, delete: async () => { calls.del.push(id); } }),
      add: async (d) => { calls.add.push(d); },
    });
    const onlyRenamed = _KB_STARTER_ENTRIES.filter((e) => e.prevQuestions && e.prevQuestions.length);
    H.check(fails, onlyRenamed.length >= 5, 'starter has renamed entries: ' + onlyRenamed.length);
    // Live KB: every starter question already present and in sync, except two seeded
    // under the OLD wording — one active, one inactive.
    const a = onlyRenamed[0], b = onlyRenamed[1];
    _kbState = { entries: _KB_STARTER_ENTRIES.map((e, i) => {
      const old = e === a || e === b;
      return { id: 'e' + i, question: old ? e.prevQuestions[0] : e.question, answer: old ? 'stale' : e.answer, seededAnswer: old ? 'stale' : e.answer, tags: e.tags || [], active: e !== b, seededByScript: true,
        notifyHumanNow: !!e.notifyHumanNow, escalateToHuman: !e.notifyHumanNow && (!!e.escalateToHuman || (e.tags || []).indexOf('escalate') !== -1) };
    }) };
    await kbSeedStarter();
    H.check(fails, calls.add.length === 0, 'no duplicates created, added ' + calls.add.length);
    H.check(fails, calls.del.length === 0, 'old-wording inactive entry not deleted');
    const ua = calls.update.find((u) => u.d.question === a.question);
    const ub = calls.update.find((u) => u.d.question === b.question);
    H.check(fails, ua && ua.d.answer === a.answer && ua.d.reviewPending === true, 'active entry renamed in place and flagged for review');
    H.check(fails, ub && ub.d.answer === b.answer && !('reviewPending' in ub.d), 'inactive entry renamed in place, stays inactive');
    H.check(fails, calls.update.filter((u) => 'answer' in u.d).length === 2, 'only the two stale entries rewritten: ' + calls.update.filter((u) => 'answer' in u.d).length);
    _isAdmin = saved.admin; _kbState = saved.kb; window.confirm = saved.confirm; kbCallEmbeddingApi = saved.embed; db.collection = saved.col;
    return { fails };
  },

  'T12 Co-Hosting: an Airbnb link imports a property with no street and no rent': async () => {
    const fails = [];
    const saved = { health: extensionHealth, rev: rrReverseGeocodeParts, scrape: rrScrapeViaExtension };
    extensionHealth = Object.assign({}, extensionHealth || {}, { extension: true, version: '1.17.0' });
    rrReverseGeocodeParts = async () => ({ city: 'Pensacola', state: 'FL', zip: '32503' });
    const scraped = [];
    rrScrapeViaExtension = async (url) => { scraped.push(url); return { ok: true, data: { source: 'airbnb', _kind: 'str', sourceUrl: url, title: 'Home in Pensacola', address: '', price: null, bedrooms: 3, bathrooms: 2, beds: 4, guests: 8, host: 'Dana', rating: 4.95, lat: 30.41, lng: -87.21, _approxLocation: true, description: 'Walk to the beach.', propertyDetails: { parking: 'Free parking on premises' } } }; };
    openCohostProfile = () => {};
    cohostRecords = []; H.log.toasts.length = 0; H.log.cohostSaves.length = 0;
    _addPropertyChoice('cohost');
    document.getElementById('cohost_paste_url').value = 'https://www.airbnb.com/rooms/53610702?adults=2';
    importCohostFromPaste();
    await H.until(() => cohostRecords.length === 1 && !window._rrListingImportInFlight, 6000);
    const r = cohostRecords[0] || {};
    H.check(fails, scraped.length === 1, 'scraped once: ' + scraped.length);
    H.check(fails, r.property === 'Home in Pensacola', 'name from title (city already in it): ' + r.property);
    H.check(fails, r.addressParts && r.addressParts.zip === '32503', 'zip kept');
    H.check(fails, r.addressParts && r.addressParts.street === '' && r.addressParts.city === 'Pensacola' && r.addressParts.state === 'FL', 'no street, city/state kept: ' + JSON.stringify(r.addressParts));
    H.check(fails, r.links && r.links.airbnb && /rooms\/53610702/.test(r.links.airbnb), 'airbnb link kept');
    H.check(fails, r.cohost && r.cohost.hostName === 'Dana' && r.cohost.askingRent === '', 'host kept, rent blank');
    H.check(fails, r.propertyDetails && r.propertyDetails.bedrooms === 3 && r.propertyDetails.bathrooms === 2 && !r.propertyDetails.monthlyRent, 'beds/baths, no rent');
    H.check(fails, r.propertyDetails && r.propertyDetails.parking === 'Free parking on premises', 'property details carried over');
    H.check(fails, r.propertyNote && /Sleeps 8/.test(r.propertyNote.text) && /approximate/.test(r.propertyNote.text), 'note has guests and the approximate-location warning');
    H.check(fails, r.importSource === 'airbnb' && r._aiPending === false, 'marked airbnb, no AI pending');
    H.check(fails, H.toastHas('Imported from Airbnb'), 'airbnb toast: ' + JSON.stringify(H.log.toasts));
    // Same listing again (different query string): exact duplicate, Replace offered.
    let dupKind = null;
    showDuplicateDialog = async (name, match, o) => { dupKind = o && o.kind; return 'cancel'; };
    closeAddModal(true);
    _addPropertyChoice('cohost');
    document.getElementById('cohost_paste_url').value = 'https://airbnb.com/rooms/53610702';
    importCohostFromPaste();
    await H.until(() => dupKind !== null && !window._rrListingImportInFlight, 6000);
    H.check(fails, dupKind === 'exact' && cohostRecords.length === 1, 'second import is an exact duplicate: ' + dupKind);
    closeAddModal(true);
    extensionHealth = saved.health; rrReverseGeocodeParts = saved.rev; rrScrapeViaExtension = saved.scrape;
    return { fails };
  },
  'T12 Co-Hosting: old extension, VRBO and AirDNA links get a clear message and no scrape': async () => {
    const fails = [];
    const saved = { health: extensionHealth, scrape: rrScrapeViaExtension };
    const scraped = [];
    rrScrapeViaExtension = async (url) => { scraped.push(url); return { ok: false, error: 'Unsupported site. Supported: AirDNA, Zillow, Apartments.com, Hotpads, Facebook Marketplace, Craigslist.' }; };
    const tryUrl = async (url) => {
      _addPropertyChoice('cohost');
      document.getElementById('cohost_paste_url').value = url;
      importCohostFromPaste();
      await H.until(() => !window._rrListingImportInFlight, 4000);
      await H.wait(50);
      const t = (document.getElementById('cohost_paste_status') || {}).textContent || '';
      closeAddModal(true);
      return t;
    };
    extensionHealth = Object.assign({}, extensionHealth || {}, { extension: true, version: '1.16.17' });
    let t = await tryUrl('https://www.airbnb.com/rooms/53610702');
    H.check(fails, /needs RentingRadar extension 1\.17\.0 or newer \(you have 1\.16\.17\)/.test(t), 'old extension message: ' + t);
    t = await tryUrl('https://www.vrbo.com/1234567');
    H.check(fails, /VRBO listings can't be imported yet/.test(t), 'vrbo message: ' + t);
    t = await tryUrl('https://app.airdna.co/data/rentalizer?listing_id=abnb_1');
    H.check(fails, /Market Potential/.test(t), 'airdna message: ' + t);
    H.check(fails, scraped.length === 0, 'none of these scraped: ' + scraped.length);
    // A site the old extension refuses: Co-Hosting wording, not the AirDNA list.
    extensionHealth = Object.assign({}, extensionHealth, { version: '1.17.0' });
    t = await tryUrl('https://www.example.com/listing/1');
    H.check(fails, /Co-Hosting imports an Airbnb listing/.test(t) && !/AirDNA/.test(t), 'unsupported wording: ' + t);
    extensionHealth = saved.health; rrScrapeViaExtension = saved.scrape;
    return { fails };
  },
  'T12 Single Unit: an Airbnb link is refused before scraping and points to Co-Hosting': async () => {
    const fails = [];
    const saved = rrScrapeViaExtension;
    const scraped = [];
    rrScrapeViaExtension = async (url) => { scraped.push(url); return { ok: true, data: {} }; };
    records = []; H.log.toasts.length = 0;
    openAddModal('house');
    document.getElementById('add_choice_url').value = 'https://www.airbnb.com/rooms/53610702';
    importFromChoicePaste();
    await H.until(() => !window._rrListingImportInFlight, 4000);
    await H.wait(50);
    const t = (document.getElementById('add_choice_status') || {}).textContent || '';
    H.check(fails, scraped.length === 0 && records.length === 0, 'nothing scraped or saved');
    H.check(fails, /Airbnb and VRBO links are for Co-Hosting/.test(t) && !/^Could not import/.test(t), 'status points to Co-Hosting: ' + t);
    closeAddModal(true);
    rrScrapeViaExtension = saved;
    return { fails };
  },

  'T13 a scrape timeout explains itself and names the extension fix, in both boxes': async () => {
    const fails = [];
    const saved = rrScrapeViaExtension;
    rrScrapeViaExtension = async () => ({ ok: false, error: 'Timed out waiting for page to load.' });
    _addPropertyChoice('cohost');
    document.getElementById('cohost_paste_url').value = 'https://www.zillow.com/homedetails/8508-Wileyvale-Rd-8508B-Houston-TX-77016/462588840_zpid/';
    importCohostFromPaste();
    await H.until(() => !window._rrListingImportInFlight, 4000); await H.wait(50);
    let t = (document.getElementById('cohost_paste_status') || {}).textContent || '';
    H.check(fails, /took too long to finish loading/.test(t) && /1\.17\.1/.test(t) && !/^Could not import/.test(t), 'cohost: ' + t);
    closeAddModal(true);
    openAddModal('house');
    document.getElementById('add_choice_url').value = 'https://www.zillow.com/homedetails/8508-Wileyvale-Rd-8508B-Houston-TX-77016/462588840_zpid/';
    importFromChoicePaste();
    await H.until(() => !window._rrListingImportInFlight, 4000); await H.wait(50);
    t = (document.getElementById('add_choice_status') || {}).textContent || '';
    H.check(fails, /took too long to finish loading/.test(t), 'single unit: ' + t);
    closeAddModal(true);
    rrScrapeViaExtension = saved;
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
    H.check(fails, traces.some((t) => /dup check: key=8436 gulf blvd\|714\|32566 records=1 match=r714 kind=exact$/.test(t)), 'trace line: ' + traces.filter((t) => t.includes('dup')));
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
  'T5c a building listing against a saved unit asks "same building", no Replace': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    const unit = { id: 'u2b', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, propertyDetails: {} };
    records = [unit];
    try {
      const run = _rrRunListingImport('u', () => handleExtensionListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
      const shown = await H.until(() => document.getElementById('duplicateDialogOverlay'), 4000);
      H.check(fails, shown, 'dialog shown');
      const ov = document.getElementById('duplicateDialogOverlay');
      const text = ov ? ov.textContent : '';
      H.check(fails, text.includes('Possible duplicate: same building'), 'title');
      H.check(fails, text.includes('You already have a unit at this address. Keep both if this is a different unit or the whole building.'), 'line');
      H.check(fails, !!document.getElementById('dupDialogKeepBtn') && !!document.getElementById('dupDialogCancelBtn'), 'Keep Both and Cancel Import offered');
      H.check(fails, !document.getElementById('dupDialogReplaceBtn') && !/Replace Old/.test(document.getElementById('dupDialogChoices').textContent), 'no Replace Old');
      document.getElementById('dupDialogCancelBtn').click();
      const out = await run;
      H.check(fails, out === 'cancelled' && records.length === 1 && records[0].id === 'u2b' && H.log.saves.length === 0, 'Cancel saves nothing: ' + out + ' ' + records.map((r) => r.id) + ' saves=' + H.log.saves.length);
    } finally { console.log = realLog; }
    H.check(fails, traces.some((t) => / dup check: key=400 example way\|\|32566 records=1 match=u2b kind=same-building$/.test(t)), 'trace: ' + traces.filter((t) => t.includes('dup')));
    return { fails };
  },
  'T5c same building: Keep Both saves the new record; an exact match keeps Replace Old': async () => {
    const fails = [];
    const unit = { id: 'u2b', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, propertyDetails: {} };
    records = [unit];
    const run = _rrRunListingImport('u', () => handleExtensionListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
    await H.until(() => document.getElementById('dupDialogKeepBtn'), 4000);
    document.getElementById('dupDialogKeepBtn').click();
    const out = await run;
    H.check(fails, out === 'created' && records.length === 2 && records.some((r) => r.id === 'u2b'), 'kept both: ' + out + ' ' + records.length);
    const p = showDuplicateDialog('400 Example Way #2B', unit, { kind: 'exact' });
    const exact = document.getElementById('duplicateDialogOverlay').textContent;
    H.check(fails, !!document.getElementById('dupDialogReplaceBtn') && exact.includes('Duplicate Detected') && exact.includes('A property with this address already exists.'), 'exact dialog unchanged');
    document.getElementById('dupDialogCancelBtn').click();
    await p;
    return { fails };
  },
  'T5c a stand-in name is never geocoded, and editors keep it out of the street': async () => {
    const fails = [];
    const queries = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('places.googleapis.com')) { queries.push(JSON.parse(opts.body).textQuery); return { json: async () => ({ places: [{ location: { latitude: 1, longitude: 2 } }] }) }; }
      return realFetch(url, opts);
    };
    const realSet = window.setTimeout;
    window.setTimeout = function (fn, ms, ...rest) { return realSet.call(window, fn, ms === 250 ? 0 : ms, ...rest); };
    records = [
      { id: 'blank', property: 'New Property', link: 'https://www.apartments.com/example/', addressParts: { street: '', unit: '', city: '', state: '', zip: '' }, propertyDetails: {} },
      { id: 'real', property: '12 Oak St, Navarre FL 32566', propertyDetails: {} },
    ];
    try {
      await _geocodeExistingPropertiesPass();
    } finally { window.fetch = realFetch; window.setTimeout = realSet; }
    H.check(fails, queries.join('|') === '12 Oak St, Navarre FL 32566', 'geocoded: ' + queries.join('|'));
    H.check(fails, records[0].propertyDetails.latitude == null, 'no lat/lng on the blank record');
    // The address editor opens with an empty street for a stand-in and saving it changes nothing.
    showAddressEditorPopup('blank');
    H.check(fails, document.getElementById('addrEdStreet').value === '', 'editor street prefill: ' + document.getElementById('addrEdStreet').value);
    saveAddressEditor('blank');
    H.check(fails, records[0].property === 'New Property' && records[0].addressParts.street === '', 'saved: ' + records[0].property + ' / ' + records[0].addressParts.street);
    H.check(fails, isBlankImportedRecord(records[0]), 'still listed by cleanup');
    return { fails };
  },
  'T5c both editors start empty for a "New Property" street and save nothing': async () => {
    const fails = [];
    const saved = { street: 'New Property', unit: '', city: '', state: '', zip: '' };
    const parsed = (id) => ({ id, property: 'New Property', status: 'New', link: 'https://www.apartments.com/example/', propertyDetails: {} });
    records = [
      { ...parsed('withParts'), addressParts: { ...saved } },
      parsed('noParts'),
    ];
    for (const id of ['withParts', 'noParts']) {
      const before = JSON.stringify(records.find((r) => r.id === id));
      showAddressEditorPopup(id);
      H.check(fails, document.getElementById('addrEdStreet').value === '', id + ' address editor street: "' + document.getElementById('addrEdStreet').value + '"');
      saveAddressEditor(id);
      H.check(fails, JSON.stringify(records.find((r) => r.id === id)) === before, id + ' address editor save changed the record');
      openCardEditor(id, 'contact');
      const ce = document.getElementById('ce_address');
      H.check(fails, ce && ce.value === '', id + ' contact card street: "' + (ce && ce.value) + '"');
      saveContactCard(id);
      const after = records.find((r) => r.id === id);
      H.check(fails, after.property === 'New Property' && JSON.stringify(after.addressParts) === JSON.stringify(JSON.parse(before).addressParts), id + ' contact save changed name/address: ' + after.property + ' ' + JSON.stringify(after.addressParts));
      document.getElementById('cardEditOverlay')?.remove();
    }
    return { fails };
  },
  // T10: Co-Hosting import runs the same duplicate check as listing import, against
  // cohostRecords only. Made-up addresses.
  'T10 Co-Hosting: a unit-less listing against a saved co-host unit asks "same building", no Replace': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    const unit = { id: 'c2b', kind: 'cohost', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, status: 'New', cohost: {}, propertyDetails: {} };
    cohostRecords = [unit];
    records = [];
    openCohostProfile = () => {};
    try {
      const run = _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
      const shown = await H.until(() => document.getElementById('duplicateDialogOverlay'), 4000);
      H.check(fails, shown, 'dialog shown');
      const ov = document.getElementById('duplicateDialogOverlay');
      const text = ov ? ov.textContent : '';
      H.check(fails, text.includes('Possible duplicate: same building'), 'title');
      H.check(fails, !!document.getElementById('dupDialogKeepBtn') && !!document.getElementById('dupDialogCancelBtn'), 'Keep Both and Cancel Import offered');
      H.check(fails, !document.getElementById('dupDialogReplaceBtn') && !/Replace Old/.test((document.getElementById('dupDialogChoices') || {}).textContent || ''), 'no Replace Old');
      if (document.getElementById('dupDialogCancelBtn')) document.getElementById('dupDialogCancelBtn').click();
      const out = await run;
      H.check(fails, out === 'cancelled', 'Cancel cancels: ' + out);
      H.check(fails, cohostRecords.length === 1 && cohostRecords[0].id === 'c2b' && !_deletedCohostIds.has('c2b'), 'old co-host record untouched: ' + cohostRecords.map((r) => r.id));
      H.check(fails, H.log.cohostSaves.length === 0 && H.log.saves.length === 0 && H.log.softDeletes.length === 0, 'Cancel saves nothing: cohostSaves=' + H.log.cohostSaves.length + ' saves=' + H.log.saves.length);
    } finally { console.log = realLog; }
    H.check(fails, traces.some((t) => / dup check: key=400 example way\|\|32566 records=1 match=c2b kind=same-building$/.test(t)), 'trace: ' + traces.filter((t) => t.includes('dup')));
    return { fails };
  },
  'T10 Co-Hosting same building: Keep Both adds the new record and leaves the old one; a stray replace is ignored': async () => {
    const fails = [];
    const unit = { id: 'c2b', kind: 'cohost', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, status: 'New', cohost: {}, propertyDetails: {} };
    cohostRecords = [unit];
    records = [];
    openCohostProfile = () => {};
    const run = _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
    await H.until(() => document.getElementById('dupDialogKeepBtn'), 4000);
    if (document.getElementById('dupDialogKeepBtn')) document.getElementById('dupDialogKeepBtn').click();
    const out = await run;
    H.check(fails, out === 'created' && cohostRecords.length === 2 && cohostRecords.some((r) => r.id === 'c2b'), 'kept both: ' + out + ' ' + cohostRecords.map((r) => r.id));
    H.check(fails, !_deletedCohostIds.has('c2b') && H.log.softDeletes.length === 0, 'old not deleted');
    H.check(fails, H.log.cohostSaves.length === 1 && H.log.cohostSaves[0].ids.length === 2 && H.log.saves.length === 0, 'one co-host save, no arbitrage save: ' + JSON.stringify(H.log.cohostSaves) + ' saves=' + H.log.saves.length);
    // Belt and braces: a 'replace' answer to a same-building match must not replace.
    cohostRecords = [unit];
    H.log.cohostSaves.length = 0;
    let kind = null;
    showDuplicateDialog = async (addr, rec, opts) => { kind = opts && opts.kind; return 'replace'; };
    const out2 = await _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
    H.check(fails, kind === 'same-building', 'dialog told the kind: ' + kind);
    H.check(fails, out2 === 'created' && cohostRecords.length === 2 && cohostRecords.some((r) => r.id === 'c2b') && !_deletedCohostIds.has('c2b') && H.log.softDeletes.length === 0, 'replace ignored for same-building: ' + out2 + ' ' + cohostRecords.map((r) => r.id));
    return { fails };
  },
  'T10 Co-Hosting exact match still offers Replace Old, and Replace swaps the old co-host record': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    const unit = { id: 'c2b', kind: 'cohost', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, status: 'New', cohost: {}, propertyDetails: {} };
    cohostRecords = [unit];
    records = [];
    openCohostProfile = () => {};
    try {
      // The geocoder stub drops the unit; the scraped text still has it, so this is exact.
      const run = _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way #2B, Navarre, FL 32566' })));
      const shown = await H.until(() => document.getElementById('duplicateDialogOverlay'), 4000);
      H.check(fails, shown, 'dialog shown');
      const ov = document.getElementById('duplicateDialogOverlay');
      const text = ov ? ov.textContent : '';
      H.check(fails, text.includes('Duplicate Detected') && text.includes('A property with this address already exists.'), 'exact dialog');
      H.check(fails, !!document.getElementById('dupDialogReplaceBtn'), 'Replace Old offered');
      if (document.getElementById('dupDialogCancelBtn')) document.getElementById('dupDialogCancelBtn').click();
      const out = await run;
      H.check(fails, out === 'cancelled' && cohostRecords.length === 1 && H.log.cohostSaves.length === 0, 'Cancel saves nothing: ' + out);
    } finally { console.log = realLog; }
    H.check(fails, traces.some((t) => / dup check: key=400 example way\|2b\|32566 records=1 match=c2b kind=exact$/.test(t)), 'trace: ' + traces.filter((t) => t.includes('dup')));
    // Replace Old: the old co-host record goes, the new one is saved.
    let kind = null;
    showDuplicateDialog = async (addr, rec, opts) => { kind = opts && opts.kind; cohostRecords = cohostRecords.map((x) => Object.assign({}, x, { _mark: 'merged' })); return 'replace'; };
    const out2 = await _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way #2B, Navarre, FL 32566' })));
    H.check(fails, kind === 'exact', 'dialog told the kind: ' + kind);
    H.check(fails, out2 === 'created' && cohostRecords.length === 1 && cohostRecords[0].id !== 'c2b', 'swapped: ' + out2 + ' ' + cohostRecords.map((r) => r.id));
    H.check(fails, _deletedCohostIds.has('c2b'), 'old marked deleted');
    H.check(fails, H.log.softDeletes.length === 1 && H.log.softDeletes[0].id === 'c2b' && H.log.softDeletes[0].mark === 'merged' && H.log.softDeletes[0].c === 'cohostRecords', 'current object soft-deleted: ' + JSON.stringify(H.log.softDeletes));
    H.check(fails, H.log.cohostSaves.length === 1 && H.log.cohostSaves[0].ids.length === 1 && H.log.cohostSaves[0].ids[0] === cohostRecords[0].id, 'one save after the swap: ' + JSON.stringify(H.log.cohostSaves));
    return { fails };
  },
  'T10 Co-Hosting: another unit is no match, and Single/Multi Unit records never count': async () => {
    const fails = [];
    const traces = [];
    const realLog = console.log;
    console.log = function (a, b) { if (a === '[RR import trace]') traces.push(String(b)); return realLog.apply(console, arguments); };
    let dialogs = 0;
    showDuplicateDialog = async () => { dialogs++; return 'cancel'; };
    openCohostProfile = () => {};
    const u715 = { id: 'c715', kind: 'cohost', property: '400 Example Way Unit 715, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: 'Unit 715', city: 'Navarre', state: 'FL', zip: '32566' }, status: 'New', cohost: {}, propertyDetails: {} };
    // The geocoder drops the unit, as Places does for many listings (the default stub keeps it in the street).
    rrGeocodeAddress = async () => ({ lat: 30, lng: -87, street: '400 Example Way', unit: '', city: 'Navarre', state: 'FL', zip: '32566', formattedAddress: '400 Example Way' });
    try {
      // M1: the geocoder drops 714, the scraped text keeps it; 715 is not 714's building.
      cohostRecords = [u715];
      records = [];
      const out = await _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way Unit 714, Navarre, FL 32566' })));
      H.check(fails, out === 'created' && dialogs === 0 && cohostRecords.length === 2 && cohostRecords.some((r) => r.id === 'c715'), '714 vs 715: ' + out + ' dialogs=' + dialogs + ' ' + cohostRecords.map((r) => r.id));
      H.check(fails, traces.some((t) => / dup check: key=400 example way\|\|32566 records=1 match=none kind=none$/.test(t)), 'trace: ' + traces.filter((t) => t.includes('dup')));
      // All candidates unit-less against the saved 715: that is the building, so it asks.
      traces.length = 0;
      cohostRecords = [u715];
      const out2 = await _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
      H.check(fails, out2 === 'cancelled' && dialogs === 1, 'building vs 715 asks: ' + out2 + ' dialogs=' + dialogs);
      H.check(fails, traces.some((t) => / dup check: key=400 example way\|\|32566 records=1 match=c715 kind=same-building$/.test(t)), 'trace: ' + traces.filter((t) => t.includes('dup')));
      // A Single Unit / Multi Unit record at the same address is not a co-host duplicate.
      traces.length = 0;
      dialogs = 0;
      cohostRecords = [];
      records = [{ id: 'arb2b', property: '400 Example Way #2B, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '#2B', city: 'Navarre', state: 'FL', zip: '32566' }, propertyDetails: {} },
        { id: 'arbBldg', property: '400 Example Way, Navarre FL 32566', addressParts: { street: '400 Example Way', unit: '', city: 'Navarre', state: 'FL', zip: '32566' }, propertyDetails: {} }];
      const out3 = await _rrRunListingImport('u', () => handleCohostListing(single(400, { address: '400 Example Way, Navarre, FL 32566' })));
      H.check(fails, out3 === 'created' && dialogs === 0 && cohostRecords.length === 1, 'arbitrage records ignored: ' + out3 + ' dialogs=' + dialogs + ' cohost=' + cohostRecords.length);
      H.check(fails, records.length === 2 && records.every((r) => r.id === 'arb2b' || r.id === 'arbBldg') && H.log.saves.length === 0, 'arbitrage records untouched');
      H.check(fails, traces.some((t) => / dup check: key=400 example way\|\|32566 records=0 match=none kind=none$/.test(t)), 'trace counts cohostRecords: ' + traces.filter((t) => t.includes('dup')));
    } finally { console.log = realLog; }
    return { fails };
  },
  'T9 a successful Resend says when the new email went out': async () => {
    const fails = [];
    const auth = firebase.auth();
    let sends = 0;
    const user = { uid: 'v9', email: 'v9@example.com', emailVerified: false, reload: async () => {}, sendEmailVerification: async () => { sends++; } };
    Object.defineProperty(auth, 'currentUser', { get: () => user, configurable: true });
    try {
      localStorage.removeItem(verifyEmailKey('v9'));
      showEmailVerificationScreen(user);
      const msg = document.getElementById('emailVerifyMsg');
      msg.textContent = 'Verification email sent! Check your inbox.';
      document.getElementById('emailVerifyResendBtn').click();
      await H.until(() => /New verification email sent at/.test(msg.textContent), 2000);
      H.check(fails, sends === 1, 'one send, got ' + sends);
      H.check(fails, /^New verification email sent at \d{1,2}:\d{2}\s?[AP]M\. Use the newest email; older links stop working\.$/.test(msg.textContent), 'status: ' + msg.textContent);
      const btn = document.getElementById('emailVerifyResendBtn');
      H.check(fails, btn.disabled && /^Resend in \d+s$/.test(btn.textContent), 'cooldown: ' + btn.textContent);
    } finally {
      _dismissEmailVerificationScreen();
      delete auth.currentUser;
      localStorage.removeItem(verifyEmailKey('v9'));
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
