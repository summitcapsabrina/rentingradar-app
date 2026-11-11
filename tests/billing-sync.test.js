// T1b: verifyCheckout and syncSubscription in functions/index.js write billing
// fields with the Admin SDK after checking Stripe. Stripe, firebase-admin and
// SendGrid are stubbed: no network, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const TS = { ts: true };
const DEL = { del: true };
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

const TOKENS = {
  alice: { uid: 'alice', email: 'alice@example.com', email_verified: true },
  aliceUnverified: { uid: 'alice', email: 'alice@example.com', email_verified: false },
  bob: { uid: 'bob', email: 'bob@example.com', email_verified: true },
};

function sub(id, customer, extra) {
  return Object.assign({
    id, customer, status: 'active', created: NOW - DAY,
    metadata: {}, discounts: [],
    current_period_end: NOW + 30 * DAY, cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_pro_m', unit_amount: 2999, recurring: { interval: 'month' } } }] },
  }, extra);
}

// A fresh world per test: Stripe objects, Firestore docs, and call logs.
function world() {
  const subs = {
    sub_alice: sub('sub_alice', 'cus_alice', { metadata: { firebaseUID: 'alice', tier: 'pro' } }),
    sub_bob: sub('sub_bob', 'cus_bob', { metadata: { firebaseUID: 'bob', tier: 'pro' } }),
    sub_legacy: sub('sub_legacy', 'cus_legacy', { metadata: { tier: 'basic' } }),
  };
  const customers = {
    cus_alice: { id: 'cus_alice', email: 'alice@example.com', metadata: { firebaseUID: 'alice' } },
    cus_bob: { id: 'cus_bob', email: 'bob@example.com', metadata: { firebaseUID: 'bob' } },
    cus_legacy: { id: 'cus_legacy', email: 'ALICE@example.com', metadata: {} },
  };
  const sessions = {};
  const docs = {
    alice: { name: 'Alice', tier: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_alice', stripeSubscriptionId: 'sub_alice' },
    bob: { name: 'Bob', tier: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_bob', stripeSubscriptionId: 'sub_bob' },
  };
  const log = { writes: [], stripe: [], emails: 0, searchError: null };
  const stripe = {
    subscriptions: {
      retrieve: async (id) => { log.stripe.push('sub.retrieve:' + id); if (!subs[id]) throw new Error('No such subscription'); return subs[id]; },
      list: async ({ customer }) => { log.stripe.push('sub.list:' + customer); return { data: Object.values(subs).filter((s) => s.customer === customer) }; },
      search: async ({ query }) => {
        log.stripe.push('sub.search:' + query);
        if (log.searchError) throw log.searchError;
        const m = query.match(/metadata\['firebaseUID'\]:'([^']+)'/);
        return { data: Object.values(subs).filter((s) => s.metadata.firebaseUID === m[1]) };
      },
    },
    customers: {
      retrieve: async (id) => { log.stripe.push('cus.retrieve:' + id); if (!customers[id]) throw new Error('No such customer'); return customers[id]; },
    },
    checkout: {
      sessions: { retrieve: async (id) => { log.stripe.push('session:' + id); if (!sessions[id]) throw new Error('No such session'); return sessions[id]; } },
    },
  };
  return { subs, customers, sessions, docs, log, stripe };
}

function loadFunctions(w) {
  const chain = () => new Proxy(function () {}, {
    get: (_, k) => (typeof k === 'string' && /^on[A-Z]/.test(k) ? (h) => h : chain()),
    apply: () => chain(),
  });
  const docRef = (id) => ({
    get: async () => ({ exists: id in w.docs, data: () => Object.assign({}, w.docs[id]) }),
    update: async (u) => { if (!(id in w.docs)) throw new Error('NOT_FOUND'); w.log.writes.push({ id, op: 'update', data: u }); Object.assign(w.docs[id], u); },
    set: async (u) => { w.log.writes.push({ id, op: 'set', data: u }); w.docs[id] = Object.assign(w.docs[id] || {}, u); },
  });
  const firestoreFn = () => ({ collection: (c) => ({ doc: (id) => { assert.equal(c, 'users'); return docRef(id); } }) });
  firestoreFn.FieldValue = { serverTimestamp: () => TS, delete: () => DEL };
  firestoreFn.Timestamp = {};
  const fakes = {
    'firebase-functions/v1': chain(),
    'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => '' }) },
    'firebase-admin': {
      initializeApp() {},
      firestore: firestoreFn,
      auth: () => ({ verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; } }),
      messaging: () => ({}),
      storage: () => ({ bucket: () => ({}) }),
    },
    stripe: () => w.stripe,
    cors: () => (req, res, next) => next(),
    '@sendgrid/mail': { setApiKey() {}, send: async () => { w.log.emails++; return [{ statusCode: 202 }]; } },
    busboy: function () {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.apply(this, arguments);
  };
  const file = path.join(__dirname, '..', 'functions', 'index.js');
  delete require.cache[require.resolve(file)];
  delete require.cache[require.resolve('../functions/billing-sync.js')];
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  let exp;
  try { exp = require(file); } finally { Module._load = origLoad; Object.assign(console, quiet); }
  Object.assign(process.env, { PRO_MONTHLY_PRICE: 'price_pro_m', BASIC_MONTHLY_PRICE: 'price_basic_m' });

  const call = (fn, token, data, method) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { Object.assign(console, quiet); resolve({ code: this.statusCode, body: b }); return this; },
      end() { Object.assign(console, quiet); resolve({ code: this.statusCode }); return this; },
    };
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    console.log = () => {}; console.error = () => {}; console.warn = () => {};
    exp[fn]({ method: method || 'POST', headers, body: { data: data || {} } }, res);
  });
  return {
    sync: (token, data, method) => call('syncSubscription', token, data, method),
    verify: (token, data, method) => call('verifyCheckout', token, data, method),
  };
}

const setup = () => { const w = world(); return Object.assign(w, loadFunctions(w)); };

// ===== shared =====

test('both endpoints: no token 401, bad token 401, GET 405; nothing written', async () => {
  const w = setup();
  for (const fn of [w.sync, w.verify]) {
    assert.equal((await fn(null, {})).code, 401);
    assert.equal((await fn('forged', {})).code, 401);
    assert.equal((await fn('alice', {}, 'GET')).code, 405);
    assert.equal((await fn('alice', {}, 'OPTIONS')).code, 200);
  }
  assert.equal(w.log.writes.length, 0);
  assert.equal(w.log.stripe.length, 0);
});

// ===== verifyCheckout =====

test('verifyCheckout: a session for another uid is 403 and writes nothing', async () => {
  const w = setup();
  w.sessions.cs_bob = { id: 'cs_bob', metadata: { firebaseUID: 'bob', tier: 'pro' }, payment_status: 'paid', customer: 'cus_bob', subscription: w.subs.sub_bob };
  const r = await w.verify('alice', { sessionId: 'cs_bob' });
  assert.equal(r.code, 403);
  assert.equal(r.body.result, undefined);
  assert.equal(w.log.writes.length, 0);
});

test('verifyCheckout: a trial checkout writes trialEnd and the full billing set, sends no email', async () => {
  const w = setup();
  w.docs.carol = { name: 'Carol', tier: null, subscriptionStatus: 'none' };
  TOKENS.carol = { uid: 'carol', email: 'carol@example.com', email_verified: true };
  const trialEnd = NOW + 7 * DAY;
  w.subs.sub_carol = sub('sub_carol', 'cus_carol', {
    status: 'trialing', trial_end: trialEnd, current_period_end: trialEnd,
    metadata: { firebaseUID: 'carol', tier: 'pro' },
    discounts: [{ coupon: { amount_off: 999, duration: 'forever' }, promotion_code: { code: 'AIRPRENEURMONTHLY' } }],
  });
  w.sessions.cs_carol = { id: 'cs_carol', metadata: { firebaseUID: 'carol', tier: 'pro' }, payment_status: 'no_payment_required', customer: 'cus_carol', subscription: w.subs.sub_carol };
  const r = await w.verify('carol', { sessionId: 'cs_carol' });
  assert.equal(r.code, 200);
  const d = r.body.result.data;
  assert.equal(d.status, 'trialing');
  assert.equal(d.tier, 'pro');
  assert.equal(d.trialEnd, new Date(trialEnd * 1000).toISOString());
  assert.equal(w.log.writes.length, 1);
  const wr = w.log.writes[0];
  assert.equal(wr.id, 'carol');
  assert.deepEqual(
    { tier: wr.data.tier, subscriptionStatus: wr.data.subscriptionStatus, stripeCustomerId: wr.data.stripeCustomerId, stripeSubscriptionId: wr.data.stripeSubscriptionId, trialEnd: wr.data.trialEnd, currentPeriodEnd: wr.data.currentPeriodEnd, cancelAtPeriodEnd: wr.data.cancelAtPeriodEnd, priceUnitAmount: wr.data.priceUnitAmount, billingInterval: wr.data.billingInterval, discountCode: wr.data.discountCode, discountAmountOff: wr.data.discountAmountOff, discountDuration: wr.data.discountDuration, referredBy: wr.data.referredBy },
    { tier: 'pro', subscriptionStatus: 'trialing', stripeCustomerId: 'cus_carol', stripeSubscriptionId: 'sub_carol', trialEnd: d.trialEnd, currentPeriodEnd: d.trialEnd, cancelAtPeriodEnd: false, priceUnitAmount: 29.99, billingInterval: 'month', discountCode: 'AIRPRENEURMONTHLY', discountAmountOff: 9.99, discountDuration: 'forever', referredBy: 'AIRPRENEURMONTHLY' }
  );
  assert.equal(wr.data.discountPercentOff, DEL);
  assert.equal(wr.data.updatedAt, TS);
  assert.equal(w.log.emails, 0, 'no upgrade email');
});

test('verifyCheckout: unpaid session is 400 and writes nothing', async () => {
  const w = setup();
  w.sessions.cs_open = { id: 'cs_open', metadata: { firebaseUID: 'alice', tier: 'pro' }, payment_status: 'unpaid', customer: 'cus_alice', subscription: w.subs.sub_alice };
  assert.equal((await w.verify('alice', { sessionId: 'cs_open' })).code, 400);
  assert.equal((await w.verify('alice', {})).code, 400);
  assert.equal(w.log.writes.length, 0);
});

// ===== syncSubscription =====

test('sync: uses the caller doc only, ignores IDs in the body, writes only the caller', async () => {
  const w = setup();
  w.subs.sub_alice.status = 'past_due';
  const r = await w.sync('alice', { stripeCustomerId: 'cus_bob', stripeSubscriptionId: 'sub_bob' });
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_alice');
  assert.equal(r.body.result.data.subscriptionStatus, 'past_due');
  assert.equal(r.body.result.data.changed, true);
  assert.deepEqual(w.log.writes.map((x) => x.id), ['alice']);
  assert.ok(!w.log.stripe.some((s) => s.includes('bob')), 'never touched bob: ' + w.log.stripe.join());
  assert.equal(w.docs.bob.subscriptionStatus, 'active');
});

test('sync: a foreign subscription stored on the caller doc is 403, no write, no data', async () => {
  const w = setup();
  w.docs.alice.stripeSubscriptionId = 'sub_bob';
  w.docs.alice.stripeCustomerId = 'cus_bob';
  const r = await w.sync('alice', {});
  assert.equal(r.code, 403);
  assert.deepEqual(r.body, { error: { message: 'Subscription does not belong to this user.' } });
  assert.equal(w.log.writes.length, 0);
});

test('sync: legacy customer passes on a verified email match, fails when unverified', async () => {
  const w = setup();
  w.docs.alice.stripeSubscriptionId = 'sub_legacy';
  w.docs.alice.stripeCustomerId = 'cus_legacy';
  assert.equal((await w.sync('aliceUnverified', {})).code, 403);
  assert.equal(w.log.writes.length, 0);
  const r = await w.sync('alice', {});
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_legacy');
  assert.equal(r.body.result.data.tier, 'pro', 'price mapping wins over metadata.tier');
});

test('sync: canceled maps to expired, keeps the tier, writes no period end', async () => {
  const w = setup();
  w.subs.sub_alice.status = 'canceled';
  const r = await w.sync('alice', {});
  assert.equal(r.code, 200);
  const wr = w.log.writes[0].data;
  assert.equal(wr.subscriptionStatus, 'expired');
  assert.equal(wr.tier, 'pro');
  assert.equal(wr.cancelAtPeriodEnd, false);
  assert.ok(!('currentPeriodEnd' in wr));
  assert.equal(r.body.result.data.currentPeriodEnd, null);
});

test('sync: manualOverride users are skipped with no Stripe call and no write', async () => {
  const w = setup();
  w.docs.alice.manualOverride = true;
  w.docs.alice.tier = 'admin';
  const r = await w.sync('alice', { search: true });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.result.data, { tier: 'admin', subscriptionStatus: 'active', changed: false, skipped: 'manualOverride' });
  assert.equal(w.log.stripe.length, 0);
  assert.equal(w.log.writes.length, 0);
});

test('sync: referredBy is backfilled from the promo code only when empty', async () => {
  const w = setup();
  w.subs.sub_alice.discounts = [{ coupon: { percent_off: 100, duration: 'once', name: 'free100' } }];
  await w.sync('alice', {});
  assert.equal(w.log.writes[0].data.referredBy, 'FREE100');
  assert.equal(w.log.writes[0].data.discountPercentOff, 100);

  const w2 = setup();
  w2.docs.alice.referredBy = 'AFF1';
  w2.subs.sub_alice.discounts = [{ coupon: { percent_off: 100, name: 'free100' } }];
  await w2.sync('alice', {});
  assert.ok(!('referredBy' in w2.log.writes[0].data));
  assert.equal(w2.docs.alice.referredBy, 'AFF1');
});

test('sync: discounts fall back to the latest invoice, then the customer', async () => {
  const w = setup();
  w.subs.sub_alice.latest_invoice = { discounts: [{ coupon: { amount_off: 500, duration: 'once' }, promotion_code: { code: 'INV5' } }] };
  await w.sync('alice', {});
  assert.equal(w.log.writes[0].data.discountCode, 'INV5');

  const w2 = setup();
  w2.customers.cus_alice.discount = { coupon: { amount_off: 300, duration: 'forever' }, promotion_code: { code: 'CUS3' } };
  await w2.sync('alice', {});
  assert.equal(w2.log.writes[0].data.discountCode, 'CUS3');
  assert.equal(w2.log.writes[0].data.discountAmountOff, 3);
});

test('sync: stored IDs but no subscription in Stripe → none, cleared sub ID', async () => {
  const w = setup();
  w.docs.alice.stripeSubscriptionId = 'sub_gone';
  w.docs.alice.stripeCustomerId = 'cus_empty';
  const r = await w.sync('alice', {});
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.tier, null);
  assert.equal(r.body.result.data.subscriptionStatus, 'none');
  const wr = w.log.writes[0].data;
  assert.equal(wr.stripeSubscriptionId, null);
  assert.equal(wr.subscriptionStatus, 'none');
});

test('sync: no Stripe IDs and no search flag → none, no Stripe call, no write', async () => {
  const w = setup();
  w.docs.alice = { name: 'Alice', tier: null, subscriptionStatus: 'none' };
  const r = await w.sync('alice', {});
  assert.deepEqual(r.body.result.data, { tier: null, subscriptionStatus: 'none', changed: false });
  assert.equal(w.log.stripe.length, 0);
  assert.equal(w.log.writes.length, 0);
});

test('sync: search fallback finds the caller\'s tagged subscription and writes it', async () => {
  const w = setup();
  w.docs.alice = { name: 'Alice', tier: null, subscriptionStatus: 'none' };
  w.subs.sub_alice_old = sub('sub_alice_old', 'cus_alice', { created: NOW - 400 * DAY, status: 'canceled', metadata: { firebaseUID: 'alice' } });
  w.subs.sub_alice.status = 'trialing';
  w.subs.sub_alice.trial_end = NOW + 5 * DAY;
  const r = await w.sync('alice', { search: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_alice', 'newest wins');
  assert.equal(r.body.result.data.subscriptionStatus, 'trialing');
  assert.ok(w.log.stripe[0].startsWith("sub.search:metadata['firebaseUID']:'alice'"));
  assert.deepEqual(w.log.writes.map((x) => x.id), ['alice']);
  assert.equal(w.docs.alice.stripeCustomerId, 'cus_alice');
});

test('sync: search miss, search error or rate limit → none, no write', async () => {
  const w = setup();
  w.docs.carol = { name: 'Carol', tier: null, subscriptionStatus: 'none' };
  TOKENS.carol = { uid: 'carol', email: 'carol@example.com', email_verified: true };
  const miss = await w.sync('carol', { search: true });
  assert.deepEqual(miss.body.result.data, { tier: null, subscriptionStatus: 'none', changed: false });

  w.docs.alice = { name: 'Alice', tier: null, subscriptionStatus: 'none' };
  w.log.searchError = Object.assign(new Error('Too many requests'), { statusCode: 429 });
  const limited = await w.sync('alice', { search: true });
  assert.equal(limited.code, 200);
  assert.deepEqual(limited.body.result.data, { tier: null, subscriptionStatus: 'none', changed: false });
  assert.equal(w.log.writes.length, 0);
});
