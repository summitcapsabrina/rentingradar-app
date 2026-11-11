// The admin Users table's Verified column: functions/admin-email-verified.js plus the
// adminEmailVerified handler in functions/index.js, run under node with
// firebase-functions, firebase-admin and friends replaced by in-memory fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { GET_USERS_CHUNK, MAX_UIDS, parseUids, lookupEmailVerified } = require('../functions/admin-email-verified.js');

// Auth with `count` users; even-numbered ones are verified.
function fakeAuth(count) {
  const users = new Map();
  for (let i = 0; i < count; i++) users.set('u' + i, { uid: 'u' + i, email: 'u' + i + '@example.com', emailVerified: i % 2 === 0, providerData: [] });
  const calls = [];
  const getUsers = async (ids) => {
    calls.push(ids.length);
    if (ids.length > 100) throw new Error('getUsers takes at most 100 identifiers');
    return { users: ids.map((id) => users.get(id.uid)).filter(Boolean), notFound: ids.filter((id) => !users.has(id.uid)) };
  };
  return { getUsers, calls };
}

test('parseUids accepts uid strings and dedupes them', () => {
  assert.deepEqual(parseUids({ uids: ['a', 'b', 'a'] }), ['a', 'b']);
  assert.deepEqual(parseUids({ uids: [] }), []);
});

test('parseUids rejects anything else', () => {
  assert.equal(parseUids(null), null);
  assert.equal(parseUids({}), null);
  assert.equal(parseUids({ uids: 'a' }), null);
  assert.equal(parseUids({ uids: ['a', 3] }), null);
  assert.equal(parseUids({ uids: [''] }), null);
  assert.equal(parseUids({ uids: ['x'.repeat(129)] }), null);
  assert.equal(parseUids({ uids: Array.from({ length: MAX_UIDS + 1 }, (_, i) => 'u' + i) }), null);
});

test('250 uids are looked up in 3 getUsers calls of at most 100, not one per user', async () => {
  const auth = fakeAuth(250);
  const uids = Array.from({ length: 250 }, (_, i) => 'u' + i);
  const verified = await lookupEmailVerified(auth.getUsers, uids);
  assert.equal(GET_USERS_CHUNK, 100);
  assert.deepEqual(auth.calls, [100, 100, 50]);
  assert.equal(Object.keys(verified).length, 250);
  assert.equal(verified.u0, true);
  assert.equal(verified.u1, false);
});

test('uids missing from Auth are left out; only booleans come back', async () => {
  const auth = fakeAuth(2);
  const verified = await lookupEmailVerified(auth.getUsers, ['u0', 'u1', 'gone']);
  assert.deepEqual(verified, { u0: true, u1: false });
});

// ---- the HTTP handler in functions/index.js --------------------------------
function loadHandler(authCount) {
  const auth = fakeAuth(authCount);
  // Token string -> decoded token. 'admin' is help@rentingradar.com.
  const tokens = { admin: { uid: 'adm', email: 'help@rentingradar.com' }, ADMINCASE: { uid: 'adm', email: 'Help@RentingRadar.com' }, user: { uid: 'u1', email: 'u1@example.com' }, noemail: { uid: 'p' } };
  const chain = () => new Proxy(function () {}, {
    get: (_, k) => (typeof k === 'string' && /^on[A-Z]/.test(k) ? (h) => h : chain()),
    apply: () => chain(),
  });
  const firestoreFn = () => ({ collection: () => ({}) });
  firestoreFn.FieldValue = {};
  firestoreFn.Timestamp = {};
  const fakes = {
    'firebase-functions/v1': chain(),
    'firebase-admin': {
      initializeApp() {},
      firestore: firestoreFn,
      auth: () => ({
        verifyIdToken: async (t) => { if (!tokens[t]) throw new Error('bad token'); return tokens[t]; },
        getUsers: auth.getUsers,
      }),
      messaging: () => ({}),
      storage: () => ({ bucket: () => ({}) }),
    },
    stripe: () => ({}),
    cors: () => (req, res, next) => next(),
    '@sendgrid/mail': { setApiKey() {}, send: async () => [{ statusCode: 202 }] },
    busboy: function () {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.apply(this, arguments);
  };
  const file = path.join(__dirname, '..', 'functions', 'index.js');
  delete require.cache[require.resolve(file)];
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  let exp;
  try { exp = require(file); } finally { Module._load = origLoad; Object.assign(console, quiet); }
  const call = (token, body, method) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ code: this.statusCode, body: b }); return this; },
      end() { resolve({ code: this.statusCode }); return this; },
    };
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    exp.adminEmailVerified({ method: method || 'POST', headers, body }, res);
  });
  return { call, calls: auth.calls };
}

test('handler: no token → 401, bad token → 401', async () => {
  const h = loadHandler(3);
  assert.equal((await h.call(null, { data: { uids: ['u0'] } })).code, 401);
  assert.equal((await h.call('forged', { data: { uids: ['u0'] } })).code, 401);
  assert.deepEqual(h.calls, []);
});

test('handler: signed-in non-admin → 403 and Auth is never queried', async () => {
  const h = loadHandler(3);
  const r = await h.call('user', { data: { uids: ['u0', 'u1'] } });
  assert.equal(r.code, 403);
  assert.equal(r.body.result, undefined);
  assert.equal((await h.call('noemail', { data: { uids: ['u0'] } })).code, 403);
  assert.deepEqual(h.calls, []);
});

test('handler: admin gets { uid: bool } and nothing else from Auth', async () => {
  const h = loadHandler(3);
  const r = await h.call('admin', { data: { uids: ['u0', 'u1', 'u2', 'gone'] } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { result: { verified: { u0: true, u1: false, u2: true } } });
  assert.equal((await h.call('ADMINCASE', { data: { uids: ['u0'] } })).code, 200, 'email match is case-insensitive, like the other admin tools');
});

test('handler: admin with a malformed body → 400; GET → 405', async () => {
  const h = loadHandler(3);
  assert.equal((await h.call('admin', { data: { uids: 'u0' } })).code, 400);
  assert.equal((await h.call('admin', { data: { uids: ['u0'] } }, 'GET')).code, 405);
});
