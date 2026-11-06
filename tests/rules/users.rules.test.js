// Firestore rules tests for T1a. Run with `npm run test:rules` (needs a JDK).
// Uses the emulator and a fake demo- project, so it never touches production.
const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
} = require('firebase/firestore');

const ADMIN_EMAIL = 'help@rentingradar.com';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rentingradar',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

const as = (uid) => env.authenticatedContext(uid, { email: uid + '@example.com' }).firestore();
const asAdmin = () => env.authenticatedContext('support', { email: ADMIN_EMAIL }).firestore();
const seed = (path, data) =>
  env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));

// The exact shape index.html writes at sign-up.
const signUpDoc = (extra) =>
  Object.assign(
    {
      name: 'Alice',
      email: 'alice@example.com',
      photo: null,
      tier: null,
      subscriptionStatus: 'none',
      disclaimerAcknowledged: false,
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp(),
    },
    extra
  );

// ===== users/{uid}: owner create =====

test('owner can create own doc with the real sign-up shape', async () => {
  await assertSucceeds(setDoc(doc(as('alice'), 'users/alice'), signUpDoc()));
});

test('owner can create own doc with referredBy', async () => {
  await assertSucceeds(
    setDoc(doc(as('alice'), 'users/alice'), signUpDoc({ referredBy: 'AIRPRENEUR' }))
  );
});

test('owner cannot create own doc with admin or referral grants', async () => {
  const ref = doc(as('alice'), 'users/alice');
  await assertFails(setDoc(ref, signUpDoc({ admin: true })));
  await assertFails(setDoc(ref, signUpDoc({ referralCodes: ['X'] })));
  await assertFails(setDoc(ref, signUpDoc({ referralCode: 'X' })));
});

test('nobody can create a doc for another user', async () => {
  await assertFails(setDoc(doc(as('alice'), 'users/bob'), signUpDoc()));
});

// ===== users/{uid}: owner update =====

test('owner can update ordinary fields', async () => {
  await seed('users/alice', { name: 'Alice' });
  const ref = doc(as('alice'), 'users/alice');
  await assertSucceeds(updateDoc(ref, { lastLogin: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref, { photo: 'https://example.com/a.png' }));
  await assertSucceeds(updateDoc(ref, { tutorialsSeen: ['intro'] }));
  await assertSucceeds(updateDoc(ref, { analysisQuota: { used: 1 } }));
});

// Deliberately still open so subscriptions keep activating. T1b closes this and
// must flip this test.
test('owner can still update billing fields (T1b closes this)', async () => {
  await seed('users/alice', { name: 'Alice' });
  await assertSucceeds(
    updateDoc(doc(as('alice'), 'users/alice'), {
      tier: 'pro',
      subscriptionStatus: 'active',
      manualOverride: true,
      trialEnd: '2030-01-01T00:00:00.000Z',
      stripeCustomerId: 'cus_test',
    })
  );
});

test('owner cannot give themselves admin', async () => {
  await seed('users/alice', { name: 'Alice' });
  const ref = doc(as('alice'), 'users/alice');
  await assertFails(updateDoc(ref, { admin: true }));
  await assertFails(setDoc(ref, { admin: true }, { merge: true }));
  await assertFails(updateDoc(ref, { admin: 'yes' }));
});

test('owner can set admin to false or remove it', async () => {
  await seed('users/alice', { name: 'Alice' });
  await assertSucceeds(updateDoc(doc(as('alice'), 'users/alice'), { admin: false }));

  await seed('users/flagged', { admin: true });
  await assertSucceeds(updateDoc(doc(as('flagged'), 'users/flagged'), { admin: deleteField() }));
});

test('owner cannot add or change referral codes but can remove them', async () => {
  await seed('users/alice', { name: 'Alice' });
  await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { referralCodes: ['STEAL'] }));
  await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { referralCode: 'STEAL' }));

  await seed('users/aff', { referralCodes: ['AFF1'], referralCode: 'OLD' });
  const ref = doc(as('aff'), 'users/aff');
  await assertFails(updateDoc(ref, { referralCodes: ['AFF1', 'STEAL'] }));
  await assertFails(updateDoc(ref, { referralCode: 'STEAL' }));
  await assertSucceeds(updateDoc(ref, { referralCodes: deleteField() }));
  await assertSucceeds(updateDoc(ref, { referralCode: deleteField() }));
});

test('owner cannot create, set, change or remove the welcome-email markers', async () => {
  const ref = doc(as('alice'), 'users/alice');
  await assertFails(setDoc(ref, signUpDoc({ welcomeEmailSentAt: serverTimestamp() })));
  await assertFails(setDoc(ref, signUpDoc({ welcomeEmailClaimedAt: serverTimestamp() })));

  await seed('users/alice', { name: 'Alice' });
  await assertFails(updateDoc(ref, { welcomeEmailSentAt: serverTimestamp() }));
  await assertFails(setDoc(ref, { welcomeEmailClaimedAt: 1 }, { merge: true }));

  await seed('users/bob', { name: 'Bob', welcomeEmailSentAt: 123, welcomeEmailClaimedAt: 456 });
  const bob = doc(as('bob'), 'users/bob');
  await assertFails(updateDoc(bob, { welcomeEmailSentAt: deleteField() }));
  await assertFails(updateDoc(bob, { welcomeEmailSentAt: 999 }));
  await assertFails(updateDoc(bob, { welcomeEmailClaimedAt: deleteField() }));
});

test('owner can still update other fields when the welcome markers are set', async () => {
  await seed('users/bob', { name: 'Bob', welcomeEmailSentAt: 123 });
  const bob = doc(as('bob'), 'users/bob');
  await assertSucceeds(updateDoc(bob, { lastLogin: serverTimestamp() }));
  await assertSucceeds(setDoc(bob, { photo: 'https://example.com/b.png' }, { merge: true }));
});

test('support admin can write the welcome markers', async () => {
  await seed('users/bob', { name: 'Bob' });
  await assertSucceeds(updateDoc(doc(asAdmin(), 'users/bob'), { welcomeEmailSentAt: serverTimestamp() }));
});

test('affiliate with unchanged codes can update other fields', async () => {
  await seed('users/aff', { referralCodes: ['AFF1'] });
  await assertSucceeds(updateDoc(doc(as('aff'), 'users/aff'), { lastLogin: serverTimestamp() }));
});

// ===== Cross-user reads =====

test('only the matching affiliate can read a referred user', async () => {
  await seed('users/aff', { referralCodes: ['AFF1'] });
  await seed('users/alice', { name: 'Alice' });
  await seed('users/bob', { referredBy: 'AFF1' });
  await assertSucceeds(getDoc(doc(as('aff'), 'users/bob')));
  await assertFails(getDoc(doc(as('alice'), 'users/bob')));
});

test('adding a referral code to yourself fails and grants no read', async () => {
  await seed('users/alice', { name: 'Alice' });
  await seed('users/bob', { referredBy: 'AFF1' });
  const db = as('alice');
  await assertFails(updateDoc(doc(db, 'users/alice'), { referralCodes: ['AFF1'] }));
  await assertFails(getDoc(doc(db, 'users/bob')));
});

// ===== Admin by email =====

test('support admin can write grants on any user', async () => {
  await seed('users/alice', { name: 'Alice' });
  await assertSucceeds(
    updateDoc(doc(asAdmin(), 'users/alice'), {
      admin: true,
      referralCodes: ['AFF1'],
      tier: 'affiliate',
    })
  );
});

test('support admin keeps every admin surface', async () => {
  const db = asAdmin();
  await seed('users/support', { name: 'Support' });
  await seed('chatConversations/c1', { userId: 'alice' });
  await seed('chatConversations/c1/messages/m1', { senderUid: 'alice', senderType: 'user' });
  await seed('sessionEvents/e1', { userId: 'alice' });

  await assertSucceeds(setDoc(doc(db, 'tutorialContent/t1'), { title: 'x' }));
  await assertSucceeds(setDoc(doc(db, 'chatKnowledge/k1'), { text: 'x' }));
  await assertSucceeds(setDoc(doc(db, 'chatConfig/blocked'), { topics: [] }));
  await assertSucceeds(setDoc(doc(db, 'adminPushTokens/tok'), { uid: 'support' }));
  await assertSucceeds(getDoc(doc(db, 'adminPushTokens/tok')));
  await assertSucceeds(getDoc(doc(db, 'chatConversations/c1')));
  await assertSucceeds(getDoc(doc(db, 'chatConversations/c1/messages/m1')));
  await assertSucceeds(updateDoc(doc(db, 'chatConversations/c1/messages/m1'), { edited: true }));
  await assertSucceeds(deleteDoc(doc(db, 'chatConversations/c1/messages/m1')));
  await assertSucceeds(getDoc(doc(db, 'sessionEvents/e1')));
});

// ===== Old admin flag is dead =====

test('a pre-existing admin:true flag grants nothing', async () => {
  await seed('users/mallory', { admin: true });
  await seed('chatConversations/c1', { userId: 'alice' });
  await seed('chatConversations/c1/messages/m1', { senderUid: 'alice', senderType: 'user' });
  await seed('sessionEvents/e1', { userId: 'alice' });
  await seed('adminPushTokens/tok', { uid: 'support' });
  const db = as('mallory');

  await assertFails(setDoc(doc(db, 'tutorialContent/t1'), { title: 'x' }));
  await assertFails(setDoc(doc(db, 'chatKnowledge/k1'), { text: 'x' }));
  await assertFails(setDoc(doc(db, 'chatConfig/blocked'), { topics: [] }));
  await assertFails(setDoc(doc(db, 'adminPushTokens/new'), { uid: 'mallory' }));
  await assertFails(getDoc(doc(db, 'adminPushTokens/tok')));
  await assertFails(getDoc(doc(db, 'chatConversations/c1')));
  await assertFails(getDoc(doc(db, 'chatConversations/c1/messages/m1')));
  await assertFails(getDoc(doc(db, 'sessionEvents/e1')));
});

// ===== Regression =====

test('paid user can start a chat, unpaid user cannot', async () => {
  await seed('users/paid', { subscriptionStatus: 'active' });
  await seed('users/unpaid', { subscriptionStatus: 'none' });

  const paid = as('paid');
  await assertSucceeds(setDoc(doc(paid, 'chatConversations/c1'), { userId: 'paid' }));
  await assertSucceeds(
    setDoc(doc(paid, 'chatConversations/c1/messages/m1'), {
      senderUid: 'paid',
      senderType: 'user',
      text: 'hi',
    })
  );

  await assertFails(setDoc(doc(as('unpaid'), 'chatConversations/c2'), { userId: 'unpaid' }));
});

test('user subcollections stay private to the owner', async () => {
  await seed('users/alice/properties/records', { data: '[]' });
  const owner = doc(as('alice'), 'users/alice/properties/records');
  await assertSucceeds(getDoc(owner));
  await assertSucceeds(setDoc(owner, { data: '[1]' }));

  const other = doc(as('bob'), 'users/alice/properties/records');
  await assertFails(getDoc(other));
  await assertFails(setDoc(other, { data: '[2]' }));
});
