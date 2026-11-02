const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stripe, SendGrid and token checks are stubbed, so no key is needed and nothing is sent.
const calls = { sent: [], updated: [], sendError: null, updateError: null, session: null };
const stripeStub = {
  checkout: { sessions: { retrieve: async () => calls.session } },
  subscriptions: {
    update: async (id, body) => {
      if (calls.updateError) throw calls.updateError;
      calls.updated.push({ id, body });
      return {};
    },
  },
  promotionCodes: { retrieve: async (id) => ({ id, code: 'AIRPRENEUR' }) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return () => stripeStub;
  if (request === '@sendgrid/mail') {
    return {
      setApiKey() {},
      send: async (msg) => {
        if (calls.sendError) throw calls.sendError;
        calls.sent.push(msg);
      },
    };
  }
  if (request === './verifyToken') return { verifyFirebaseToken: async () => ({ uid: 'u1', email: 'token@example.com' }) };
  return realLoad.call(this, request, parent, isMain);
};

const { sendTrialStartedEmail, SENT_FLAG } = require('../api/_lib/trialEmail.js');
const verifyCheckout = require('../api/verifyCheckout.js');

// 2026-11-10 03:00 UTC is still Nov 9 in Pacific.
const TRIAL_END = Date.UTC(2026, 10, 10, 3) / 1000;

function sub(overrides) {
  return Object.assign({
    id: 'sub_1',
    status: 'trialing',
    trial_end: TRIAL_END,
    metadata: { tier: 'pro' },
    discount: null,
    items: { data: [{ price: { unit_amount: 2999, recurring: { interval: 'month' } } }] },
  }, overrides);
}

function reset() {
  calls.sent = [];
  calls.updated = [];
  calls.sendError = null;
  calls.updateError = null;
  calls.session = null;
}

function callVerify() {
  const out = {};
  const res = {
    setHeader() {},
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    end() { return this; },
  };
  const req = { method: 'POST', headers: { authorization: 'Bearer t' }, body: { data: { sessionId: 'cs_1' } } };
  return verifyCheckout(req, res).then(() => out);
}

test('trial email states the plan, end date, price, and cancel steps, then sets the flag', async () => {
  reset();
  const r = await sendTrialStartedEmail({ subscription: sub(), email: 'a@example.com', name: 'Dana Lee' });
  assert.deepEqual(r, { sent: true });
  assert.equal(calls.sent.length, 1);
  const m = calls.sent[0];
  assert.equal(m.to, 'a@example.com');
  assert.deepEqual(m.from, { email: 'help@rentingradar.com', name: 'RentingRadar' });
  assert.equal(m.subject, 'Your RentingRadar Pro free trial has started');
  assert.match(m.html, /Hi Dana,/);
  assert.match(m.html, /Pro Monthly/);
  assert.match(m.html, /Your free trial ends <strong[^>]*>November 9, 2026<\/strong>\./);
  assert.match(m.html, /renews automatically at <strong[^>]*>\$29\.99\/mo<\/strong> until you cancel\. \(Pro is \$29\.99\/mo or \$289\.99\/yr\.\)/);
  assert.match(m.html, /https:\/\/app\.rentingradar\.com#settings/);
  assert.match(m.html, /Cancel online anytime before November 9, 2026 and you won't be charged\./);
  assert.match(m.html, /To cancel: Settings &gt; Plan &amp; Billing &gt; Manage Billing &gt; Open Stripe Portal &gt; Cancel subscription\./);
  assert.match(m.html, /Questions\? Reply or email/);
  assert.doesNotMatch(m.html, /Email Preferences/);
  assert.doesNotMatch(m.html, /promo code/);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].id, 'sub_1');
  assert.ok(calls.updated[0].body.metadata[SENT_FLAG]);
});

test('yearly plans quote the yearly price', async () => {
  reset();
  await sendTrialStartedEmail({
    subscription: sub({ metadata: { tier: 'basic' }, items: { data: [{ price: { unit_amount: 8999, recurring: { interval: 'year' } } }] } }),
    email: 'a@example.com',
  });
  assert.match(calls.sent[0].html, /Basic Yearly/);
  assert.match(calls.sent[0].html, /\$89\.99\/yr<\/strong> until you cancel\. \(Basic is \$9\.99\/mo or \$89\.99\/yr\.\)/);
  assert.match(calls.sent[0].html, /Hi,/);
});

test('an applied promo code is named, by lookup when Stripe returns only its ID', async () => {
  reset();
  await sendTrialStartedEmail({ subscription: sub({ discount: { promotion_code: 'promo_1', coupon: { id: 'c1' } } }), email: 'a@example.com' });
  assert.match(calls.sent[0].html, /Your promo code AIRPRENEUR is applied; see Manage Billing for your exact charge\./);
});

test('a discount with no promotion code falls back to the coupon name', async () => {
  reset();
  await sendTrialStartedEmail({ subscription: sub({ discount: { promotion_code: null, coupon: { id: 'c1', name: 'Coach' } } }), email: 'a@example.com' });
  assert.match(calls.sent[0].html, /Your promo code Coach is applied/);
});

test('names are HTML-escaped', async () => {
  reset();
  await sendTrialStartedEmail({ subscription: sub(), email: 'a@example.com', name: '<img>x y' });
  assert.match(calls.sent[0].html, /Hi &lt;img&gt;x,/);
});

test('nothing is sent for a flagged, non-trial, or missing subscription, or with no address', async () => {
  reset();
  const results = [
    await sendTrialStartedEmail({ subscription: sub({ metadata: { tier: 'pro', [SENT_FLAG]: '2026-11-02T00:00:00Z' } }), email: 'a@example.com' }),
    await sendTrialStartedEmail({ subscription: sub({ status: 'active' }), email: 'a@example.com' }),
    await sendTrialStartedEmail({ subscription: 'sub_1', email: 'a@example.com' }),
    await sendTrialStartedEmail({ subscription: null, email: 'a@example.com' }),
    await sendTrialStartedEmail({ subscription: sub(), email: '' }),
  ];
  assert.deepEqual(results.map((r) => r.reason), ['already-sent', 'not-trialing', 'no-subscription', 'no-subscription', 'no-email']);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.updated.length, 0);
});

test('a failed send throws and leaves the flag unset, so a later call can retry', async () => {
  reset();
  calls.sendError = new Error('sendgrid down');
  await assert.rejects(sendTrialStartedEmail({ subscription: sub(), email: 'a@example.com' }), /sendgrid down/);
  assert.equal(calls.updated.length, 0);
});

test('a failed flag write still counts as sent', async () => {
  reset();
  calls.updateError = new Error('stripe down');
  const r = await sendTrialStartedEmail({ subscription: sub(), email: 'a@example.com' });
  assert.deepEqual(r, { sent: true });
  assert.equal(calls.sent.length, 1);
});

function session(overrides) {
  return Object.assign({
    metadata: { firebaseUID: 'u1', tier: 'pro' },
    payment_status: 'paid',
    customer: 'cus_1',
    customer_details: { email: 'buyer@example.com', name: 'Dana Lee' },
    subscription: sub(),
  }, overrides);
}

test('verifyCheckout emails the buyer on a trial and keeps its response unchanged', async () => {
  reset();
  calls.session = session();
  const out = await callVerify();
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { result: { data: { tier: 'pro', status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' } } });
  assert.equal(calls.sent[0].to, 'buyer@example.com');
});

test('verifyCheckout falls back to the signed-in email', async () => {
  reset();
  calls.session = session({ customer_details: null });
  await callVerify();
  assert.equal(calls.sent[0].to, 'token@example.com');
});

test('verifyCheckout does not fail when the email fails', async () => {
  reset();
  calls.session = session();
  calls.sendError = new Error('sendgrid down');
  const out = await callVerify();
  assert.equal(out.status, 200);
  assert.equal(out.body.result.data.status, 'active');
});

test('verifyCheckout sends nothing for a paid non-trial checkout or for another user', async () => {
  reset();
  calls.session = session({ subscription: sub({ status: 'active' }) });
  assert.equal((await callVerify()).status, 200);
  calls.session = session({ metadata: { firebaseUID: 'someone-else', tier: 'pro' } });
  assert.equal((await callVerify()).status, 403);
  assert.equal(calls.sent.length, 0);
});

test('the email still goes out if Stripe reports no_payment_required for a trial', async () => {
  reset();
  calls.session = session({ payment_status: 'no_payment_required' });
  const out = await callVerify();
  assert.equal(calls.sent.length, 1);
  assert.equal(out.status, 400); // existing behavior, unchanged here
});
