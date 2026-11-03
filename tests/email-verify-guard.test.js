const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../email-verify-guard.js');

const COOLDOWN = g.VERIFY_EMAIL_COOLDOWN_MS;
const BACKOFF = g.VERIFY_EMAIL_RATE_LIMIT_BACKOFF_MS;

// localStorage's interface over a Map, shared by "tabs" the way the real one is.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}
function fakeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
function fakeSend(result) {
  const s = async () => { s.calls++; if (result) throw result; };
  s.calls = 0;
  return s;
}
const setup = () => {
  const storage = fakeStorage();
  const clock = fakeClock(1_000_000);
  return { storage, clock, sender: g.createVerifyEmailSender({ storage, now: clock.now }) };
};

test('verifyEmailKey is per uid', () => {
  assert.equal(g.verifyEmailKey('abc'), 'rr_verifyEmailSentAt_abc');
});

test('the first trySend sends once and reports sent', async () => {
  const { sender } = setup();
  const send = fakeSend();
  const res = await sender.trySend('u1', send);
  assert.equal(send.calls, 1);
  assert.equal(res.status, 'sent');
  assert.equal(res.waitMs, COOLDOWN);
});

test('a second call within 60 s is a cooldown and does not send', async () => {
  const { sender, clock } = setup();
  const send = fakeSend();
  await sender.trySend('u1', send);
  clock.advance(15000);
  const res = await sender.trySend('u1', send);
  assert.equal(send.calls, 1);
  assert.equal(res.status, 'cooldown');
  assert.equal(res.waitMs, COOLDOWN - 15000);
});

test('two calls in parallel send once; the second is in-flight', async () => {
  const { sender } = setup();
  let release;
  const send = () => { send.calls++; return new Promise((r) => { release = r; }); };
  send.calls = 0;
  const first = sender.trySend('u1', send);
  const second = await sender.trySend('u1', send);
  assert.equal(second.status, 'in-flight');
  assert.equal(send.calls, 1);
  release();
  assert.equal((await first).status, 'sent');
});

test('after 60 s a send is allowed again', async () => {
  const { sender, clock, storage } = setup();
  const send = fakeSend();
  await sender.trySend('u1', send);
  clock.advance(COOLDOWN - 1);
  assert.equal((await sender.trySend('u1', send)).status, 'cooldown');
  clock.advance(1);
  assert.equal(g.verifyEmailWaitMs(storage, 'u1', clock.now()), 0);
  assert.equal((await sender.trySend('u1', send)).status, 'sent');
  assert.equal(send.calls, 2);
});

test('cooldowns are per uid', async () => {
  const { sender } = setup();
  const send = fakeSend();
  assert.equal((await sender.trySend('A', send)).status, 'sent');
  assert.equal((await sender.trySend('B', send)).status, 'sent');
  assert.equal(send.calls, 2);
});

test('auth/too-many-requests is rate-limited and waits the backoff', async () => {
  const { sender, clock, storage } = setup();
  const res = await sender.trySend('u1', fakeSend({ code: 'auth/too-many-requests' }));
  assert.equal(res.status, 'rate-limited');
  assert.equal(res.waitMs, BACKOFF);
  clock.advance(COOLDOWN);
  const send = fakeSend();
  const later = await sender.trySend('u1', send);
  assert.equal(later.status, 'cooldown', 'still waiting after one cooldown');
  assert.equal(later.waitMs, BACKOFF - COOLDOWN);
  assert.equal(send.calls, 0);
  clock.advance(BACKOFF - COOLDOWN);
  assert.equal(g.verifyEmailWaitMs(storage, 'u1', clock.now()), 0);
});

test('any other error clears the cooldown', async () => {
  const { sender, storage, clock } = setup();
  const res = await sender.trySend('u1', fakeSend({ code: 'auth/network-request-failed' }));
  assert.equal(res.status, 'error');
  assert.equal(res.waitMs, 0);
  assert.equal(storage.getItem(g.verifyEmailKey('u1')), null);
  const send = fakeSend();
  assert.equal((await sender.trySend('u1', send)).status, 'sent');
  assert.equal(send.calls, 1);
  assert.ok(clock.now());
});

test('a second sender on the same storage (another tab) sees the cooldown', async () => {
  const { storage, clock, sender } = setup();
  await sender.trySend('u1', fakeSend());
  clock.advance(5000);
  const otherTab = g.createVerifyEmailSender({ storage, now: clock.now });
  const send = fakeSend();
  const res = await otherTab.trySend('u1', send);
  assert.equal(res.status, 'cooldown');
  assert.equal(res.waitMs, COOLDOWN - 5000);
  assert.equal(send.calls, 0);
});

test('the timestamp is stored before send() runs', async () => {
  const { storage, sender, clock } = setup();
  let seen = null;
  await sender.trySend('u1', async () => { seen = storage.getItem(g.verifyEmailKey('u1')); });
  assert.equal(seen, String(clock.now()));
});

test('a broken or missing store never blocks a send', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const sender = g.createVerifyEmailSender({ storage: broken, now: () => 1 });
  const send = fakeSend();
  assert.equal((await sender.trySend('u1', send)).status, 'sent');
  assert.equal(send.calls, 1);
  const store = fakeStorage();
  store.setItem(g.verifyEmailKey('u1'), String(10 ** 15));
  assert.equal(g.verifyEmailWaitMs(store, 'u1', 1), BACKOFF, 'a far-future value waits the backoff at most');
  assert.equal((await sender.trySend('', send)).status, 'error');
});
