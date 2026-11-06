// The welcome email: never at sign-up, once after verification. Runs the real
// functions/index.js handlers under node with firebase-functions, firebase-admin,
// SendGrid and friends replaced by in-memory fakes, so nothing leaves this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const welcome = require('../functions/welcome-email.js');

const WELCOME_SUBJECT = "🎉 Welcome to RentingRadar! Here's how to get started";
const AFTER = new Date(welcome.WELCOME_AFTER_VERIFY_SINCE + 60 * 60 * 1000).toUTCString();
const BEFORE = new Date(welcome.WELCOME_AFTER_VERIFY_SINCE - 24 * 60 * 60 * 1000).toUTCString();

// ---- fakes -----------------------------------------------------------------
const DELETE = { __delete: true };
function fakeFirestore() {
  const docs = new Map();
  const collections = new Map();
  let txQueue = Promise.resolve();
  const apply = (p, data, merge) => {
    const next = merge || data.__update ? Object.assign({}, docs.get(p) || {}) : {};
    for (const [k, v] of Object.entries(data)) {
      if (k === '__update') continue;
      if (v === DELETE) delete next[k]; else next[k] = v;
    }
    docs.set(p, next);
  };
  const docRef = (p) => ({
    path: p,
    get: async () => ({ exists: docs.has(p), data: () => (docs.has(p) ? { ...docs.get(p) } : undefined) }),
    set: async (data, opts) => apply(p, data, opts && opts.merge),
    update: async (data) => { if (!docs.has(p)) throw new Error('NOT_FOUND ' + p); apply(p, { ...data, __update: true }); },
    collection: (c) => coll(p + '/' + c),
  });
  const query = (name, filters) => ({
    where: (f, op, v) => query(name, filters.concat([[f, v]])),
    orderBy: () => query(name, filters),
    limit: () => query(name, filters),
    get: async () => {
      const rows = (collections.get(name) || []).filter((r) => filters.every(([f, v]) => r[f] === v));
      return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ data: () => r })), forEach: (fn) => rows.forEach((r) => fn({ data: () => r })) };
    },
  });
  const coll = (name) => Object.assign(query(name, []), {
    doc: (id) => docRef(name + '/' + id),
    add: async (data) => { if (!collections.has(name)) collections.set(name, []); collections.get(name).push({ ...data }); return { id: 'x' }; },
  });
  // One transaction at a time, like Firestore's serializable transactions.
  const runTransaction = (fn) => {
    const run = txQueue.then(() => fn({
      get: (ref) => ref.get(),
      update: (ref, data) => apply(ref.path, { ...data, __update: true }),
      set: (ref, data, opts) => apply(ref.path, data, opts && opts.merge),
    }));
    txQueue = run.catch(() => {});
    return run;
  };
  return { db: { collection: coll, runTransaction, batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }) }, docs, collections };
}

function loadFunctions() {
  const fs = fakeFirestore();
  const sent = [];
  const authUsers = new Map();
  const state = { sendgridFails: false };
  const chain = () => new Proxy(function () {}, {
    get: (_, k) => (typeof k === 'string' && /^on[A-Z]/.test(k) ? (h) => h : chain()),
    apply: () => chain(),
  });
  const firestoreFn = () => fs.db;
  firestoreFn.FieldValue = { delete: () => DELETE, serverTimestamp: () => 'SERVER_TS', increment: (n) => n, arrayUnion: (...a) => a, arrayRemove: () => [] };
  firestoreFn.Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => Date.now() }) };
  const fakes = {
    'firebase-functions/v1': chain(),
    'firebase-admin': {
      initializeApp() {},
      firestore: firestoreFn,
      auth: () => ({
        getUser: async (uid) => { if (!authUsers.has(uid)) throw new Error('no user'); return authUsers.get(uid); },
        verifyIdToken: async (t) => ({ uid: t }),
      }),
      messaging: () => ({ sendEachForMulticast: async () => ({ responses: [] }) }),
      storage: () => ({ bucket: () => ({}) }),
    },
    stripe: () => ({}),
    cors: () => (req, res, next) => next(),
    '@sendgrid/mail': {
      setApiKey() {},
      send: async (msg) => { if (state.sendgridFails && msg.subject === WELCOME_SUBJECT) throw new Error('sendgrid down'); sent.push(msg); return [{ statusCode: 202 }]; },
    },
    busboy: function () {},
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.apply(this, arguments);
  };
  const file = path.join(__dirname, '..', 'functions', 'index.js');
  delete require.cache[require.resolve(file)];
  delete require.cache[require.resolve('../functions/welcome-email.js')];
  let exp;
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  try { exp = require(file); } finally { Module._load = origLoad; }
  const restore = () => Object.assign(console, quiet);
  const welcomes = (email) => sent.filter((m) => m.subject === WELCOME_SUBJECT && m.to === email).length;
  const addUser = (uid, u) => {
    authUsers.set(uid, { uid, email: uid + '@example.com', displayName: 'Test ' + uid, emailVerified: true, metadata: { creationTime: AFTER }, providerData: [], ...u });
  };
  // What index.html writes when it creates the user doc, then the trigger.
  const createDoc = async (uid) => {
    await fs.db.collection('users').doc(uid).set({ name: 'Test', email: uid + '@example.com', tier: null });
    return exp.onUserDocCreated({ data: () => ({}) }, { params: { uid } });
  };
  const http = (uid) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); return this; } };
    exp.sendWelcomeEmail({ method: 'POST', headers: { authorization: 'Bearer ' + uid } }, res);
  });
  return { exp, fs, sent, state, welcomes, addUser, createDoc, http, restore };
}

// ---- tests -----------------------------------------------------------------
test('sign-up sends no welcome email (only the admin notice)', async () => {
  const f = loadFunctions();
  try {
    f.addUser('alice', { emailVerified: false });
    await f.exp.onUserCreated({ uid: 'alice', email: 'alice@example.com', displayName: 'Alice', providerData: [{ providerId: 'password' }] });
    assert.equal(f.welcomes('alice@example.com'), 0);
    assert.ok(f.sent.some((m) => m.to === 'help@rentingradar.com'), 'admin notice still sent');
  } finally { f.restore(); }
});

test('exactly one welcome after verification, however often it runs', async () => {
  const f = loadFunctions();
  try {
    f.addUser('bob');
    await f.createDoc('bob');
    await f.exp.onUserDocCreated({}, { params: { uid: 'bob' } });
    await Promise.all([f.exp.onUserDocCreated({}, { params: { uid: 'bob' } }), f.http('bob'), f.http('bob')]);
    assert.equal(f.welcomes('bob@example.com'), 1);
    const doc = f.fs.docs.get('users/bob');
    assert.ok(doc.welcomeEmailSentAt, 'welcomeEmailSentAt written');
    assert.equal(doc.welcomeEmailClaimedAt, undefined, 'claim cleared');
    assert.equal(f.fs.collections.get('emailLog').filter((r) => r.uid === 'bob' && r.type === 'welcome').length, 1);
    assert.equal(doc.name, 'Test', 'the app\'s fields are untouched');
  } finally { f.restore(); }
});

test('parallel runs send one welcome', async () => {
  const f = loadFunctions();
  try {
    f.addUser('carl');
    await f.fs.db.collection('users').doc('carl').set({ name: 'Carl' });
    await Promise.all(Array.from({ length: 5 }, () => f.exp.onUserDocCreated({}, { params: { uid: 'carl' } })));
    assert.equal(f.welcomes('carl@example.com'), 1);
  } finally { f.restore(); }
});

test('a Google sign-in user (verified at creation) gets exactly one', async () => {
  const f = loadFunctions();
  try {
    f.addUser('gina', { providerData: [{ providerId: 'google.com' }], emailVerified: true });
    await f.exp.onUserCreated({ uid: 'gina', email: 'gina@example.com', displayName: 'Gina', providerData: [{ providerId: 'google.com' }] });
    assert.equal(f.welcomes('gina@example.com'), 0, 'not at auth creation');
    await f.createDoc('gina');
    await f.http('gina');
    assert.equal(f.welcomes('gina@example.com'), 1);
  } finally { f.restore(); }
});

test('an account created before the cutoff gets none', async () => {
  const f = loadFunctions();
  try {
    f.addUser('old', { metadata: { creationTime: BEFORE } });
    await f.createDoc('old');
    const r = await f.http('old');
    assert.equal(f.welcomes('old@example.com'), 0);
    assert.equal(r.body.message, 'pre-cutoff');
    assert.equal(f.fs.docs.get('users/old').welcomeEmailSentAt, undefined);
  } finally { f.restore(); }
});

test('an unverified user gets none, and the HTTP endpoint says so', async () => {
  const f = loadFunctions();
  try {
    f.addUser('una', { emailVerified: false });
    await f.createDoc('una');
    const r = await f.http('una');
    assert.equal(r.code, 400);
    assert.equal(f.welcomes('una@example.com'), 0);
  } finally { f.restore(); }
});

test('a failed send leaves no marker, so a later run can send it', async () => {
  const f = loadFunctions();
  try {
    f.addUser('fay');
    f.state.sendgridFails = true;
    await f.createDoc('fay');
    assert.equal(f.welcomes('fay@example.com'), 0);
    const doc = f.fs.docs.get('users/fay');
    assert.equal(doc.welcomeEmailSentAt, undefined);
    assert.equal(doc.welcomeEmailClaimedAt, undefined, 'claim released');
    f.state.sendgridFails = false;
    const r = await f.http('fay');
    assert.equal(r.code, 200);
    assert.equal(f.welcomes('fay@example.com'), 1);
  } finally { f.restore(); }
});

test('sign-up no longer logs a welcome, so it can\'t block the real one', async () => {
  const f = loadFunctions();
  try {
    f.addUser('dan');
    await f.exp.onUserCreated({ uid: 'dan', email: 'dan@example.com', displayName: 'Dan', providerData: [{ providerId: 'password' }] });
    assert.equal((f.fs.collections.get('emailLog') || []).filter((r) => r.uid === 'dan').length, 0);
  } finally { f.restore(); }
});

test('an existing emailLog entry counts as sent, even if the user doc was recreated', async () => {
  const f = loadFunctions();
  try {
    f.addUser('rex');
    await f.fs.db.collection('emailLog').add({ uid: 'rex', email: 'rex@example.com', type: 'welcome' });
    await f.createDoc('rex');
    assert.equal(f.welcomes('rex@example.com'), 0);
  } finally { f.restore(); }
});

test('the endpoint never creates a user doc', async () => {
  const f = loadFunctions();
  try {
    f.addUser('nodoc');
    const r = await f.http('nodoc');
    assert.equal(r.body.message, 'no-user-doc');
    assert.equal(f.fs.docs.has('users/nodoc'), false);
    assert.equal(f.welcomes('nodoc@example.com'), 0);
  } finally { f.restore(); }
});

test('welcomeClaimDecision', () => {
  const now = 1_000_000_000;
  assert.equal(welcome.welcomeClaimDecision({}, false, now), 'claim');
  assert.equal(welcome.welcomeClaimDecision(null, false, now), 'no-user-doc');
  assert.equal(welcome.welcomeClaimDecision({}, true, now), 'already-sent');
  assert.equal(welcome.welcomeClaimDecision({ welcomeEmailSentAt: 'x' }, false, now), 'already-sent');
  assert.equal(welcome.welcomeClaimDecision({ welcomeEmailClaimedAt: now - 1000 }, false, now), 'in-progress');
  assert.equal(welcome.welcomeClaimDecision({ welcomeEmailClaimedAt: now - welcome.WELCOME_CLAIM_TTL_MS }, false, now), 'claim', 'a stale claim');
  assert.equal(welcome.welcomeClaimDecision({ welcomeEmailClaimedAt: { toMillis: () => now - 5 } }, false, now), 'in-progress');
});
