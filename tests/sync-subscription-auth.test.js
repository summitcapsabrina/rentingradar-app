// api/syncSubscription.js: a signed-in user may only sync their own Stripe
// subscription; the verified admin may sync anyone. Stripe and token
// verification are stubbed, so no network or secrets are needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const TOKENS = {
  admin: { uid: 'admin-uid', email: 'Help@RentingRadar.com', email_verified: true },
  adminUnverified: { uid: 'admin-uid', email: 'help@rentingradar.com', email_verified: false },
  alice: { uid: 'alice-uid', email: 'alice@example.com', email_verified: true },
  aliceUnverified: { uid: 'alice-uid', email: 'alice@example.com', email_verified: false },
};

function sub(id, customer, metadata) {
  return {
    id, customer, metadata: metadata || {}, status: 'active',
    current_period_end: 1800000000, cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_x', unit_amount: 2999, recurring: { interval: 'month' } } }] },
    discounts: [],
  };
}

// Alice's sub/customer carry her uid. Legacy: no firebaseUID anywhere, email matches Alice.
// Bob's belong to someone else.
const SUBS = {
  sub_alice: sub('sub_alice', 'cus_alice', { firebaseUID: 'alice-uid', tier: 'pro' }),
  sub_legacy: sub('sub_legacy', 'cus_legacy', { tier: 'pro' }),
  sub_bob: sub('sub_bob', 'cus_bob', { firebaseUID: 'bob-uid', tier: 'pro' }),
};
const CUSTOMERS = {
  cus_alice: { id: 'cus_alice', email: 'alice@example.com', metadata: { firebaseUID: 'alice-uid' } },
  cus_legacy: { id: 'cus_legacy', email: 'ALICE@example.com', metadata: {} },
  cus_bob: { id: 'cus_bob', email: 'bob@example.com', metadata: { firebaseUID: 'bob-uid' } },
};

function loadHandler() {
  const calls = { custRetrieve: [], discountLookups: 0 };
  const fakeStripe = {
    subscriptions: {
      retrieve: async (id) => { if (!SUBS[id]) throw new Error('No such subscription'); return SUBS[id]; },
      list: async ({ customer }) => ({ data: Object.values(SUBS).filter((s) => s.customer === customer) }),
    },
    customers: {
      retrieve: async (id, opts) => {
        calls.custRetrieve.push(id);
        if (opts && opts.expand) calls.discountLookups++;
        if (!CUSTOMERS[id]) throw new Error('No such customer');
        return CUSTOMERS[id];
      },
    },
  };
  const fakes = {
    stripe: () => fakeStripe,
    './verifyToken': {
      verifyFirebaseToken: async (t) => { if (!TOKENS[t]) throw new Error('bad token'); return TOKENS[t]; },
    },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.apply(this, arguments);
  };
  const file = path.join(__dirname, '..', 'api', 'syncSubscription.js');
  delete require.cache[require.resolve(file)];
  let handler;
  try { handler = require(file); } finally { Module._load = origLoad; }

  const call = async (token, data) => {
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
      return await new Promise((resolve) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          status(c) { this.statusCode = c; return this; },
          json(b) { resolve({ code: this.statusCode, body: b }); return this; },
          end() { resolve({ code: this.statusCode }); return this; },
        };
        const headers = token ? { authorization: 'Bearer ' + token } : {};
        handler({ method: 'POST', headers, body: { data } }, res);
      });
    } finally { Object.assign(console, quiet); }
  };
  return { call, calls };
}

function assertForbidden(r, calls) {
  assert.equal(r.code, 403);
  assert.deepEqual(r.body, { error: { message: 'Subscription does not belong to this user.' } });
  assert.equal(r.body.result, undefined);
  assert.equal(calls.discountLookups, 0, 'discount lookup must not run before ownership passes');
}

test('no token → 401', async () => {
  const { call } = loadHandler();
  const r = await call(null, { stripeSubscriptionId: 'sub_alice' });
  assert.equal(r.code, 401);
  assert.equal(r.body.result, undefined);
});

test('verified admin syncs another user\'s subscription', async () => {
  const { call } = loadHandler();
  const r = await call('admin', { stripeCustomerId: 'cus_bob', stripeSubscriptionId: 'sub_bob' });
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_bob');
  assert.equal(r.body.result.data.stripeCustomerId, 'cus_bob');
  assert.equal(r.body.result.data.tier, 'pro');
});

test('admin email with email_verified false is treated as non-admin', async () => {
  const { call, calls } = loadHandler();
  const r = await call('adminUnverified', { stripeCustomerId: 'cus_bob', stripeSubscriptionId: 'sub_bob' });
  assertForbidden(r, calls);
});

test('user syncs own subscription (subscription firebaseUID match)', async () => {
  const { call, calls } = loadHandler();
  const r = await call('alice', { stripeCustomerId: 'cus_alice', stripeSubscriptionId: 'sub_alice' });
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_alice');
  assert.equal(r.body.result.data.subscriptionStatus, 'active');
  assert.equal(r.body.result.data.billingInterval, 'month');
  assert.equal(r.body.result.data.priceUnitAmount, 29.99);
  // Ownership came from subscription metadata; only the discount lookup hit customers.
  assert.equal(calls.custRetrieve.length, calls.discountLookups);
});

test('user with legacy customer (no firebaseUID, email match) passes', async () => {
  const { call } = loadHandler();
  const r = await call('alice', { stripeCustomerId: 'cus_legacy', stripeSubscriptionId: 'sub_legacy' });
  assert.equal(r.code, 200);
  assert.equal(r.body.result.data.stripeSubscriptionId, 'sub_legacy');
});

test('legacy email match requires email_verified', async () => {
  const { call, calls } = loadHandler();
  const r = await call('aliceUnverified', { stripeCustomerId: 'cus_legacy', stripeSubscriptionId: 'sub_legacy' });
  assertForbidden(r, calls);
});

test('user passing another user\'s subscription ID gets 403 with no data', async () => {
  const { call, calls } = loadHandler();
  const r = await call('alice', { stripeSubscriptionId: 'sub_bob' });
  assertForbidden(r, calls);
});

test('user passing another user\'s customer ID gets 403 with no data', async () => {
  const { call, calls } = loadHandler();
  const r = await call('alice', { stripeCustomerId: 'cus_bob' });
  assertForbidden(r, calls);
});

test('own customer ID does not unlock another user\'s subscription ID', async () => {
  const { call, calls } = loadHandler();
  const r = await call('alice', { stripeCustomerId: 'cus_alice', stripeSubscriptionId: 'sub_bob' });
  assertForbidden(r, calls);
});

test('empty input still returns tier null', async () => {
  const { call, calls } = loadHandler();
  const r = await call('alice', {});
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { result: { data: { tier: null, subscriptionStatus: 'none', changed: false } } });
  assert.equal(calls.custRetrieve.length, 0);
});
