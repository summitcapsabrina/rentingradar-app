// The welcome email goes out once per user, after their email is verified. No
// firebase-admin in here: index.js passes in the auth lookup, the store and the
// sender, so tests/welcome-email.test.js can run it under node.

// Accounts created before this moment got the welcome email at sign-up from the old
// onUserCreated, so they never get it again. Move it to the deploy time if the
// deploy is much later: an account created between this and the deploy, and still
// unverified at deploy, would get a second welcome after verifying.
const WELCOME_AFTER_VERIFY_SINCE = Date.parse('2026-11-05T00:00:00Z');

// A claim older than this belongs to a send that died midway; another try may proceed.
const WELCOME_CLAIM_TTL_MS = 10 * 60 * 1000;

// What to do with one user's welcome email, given their user doc (or null), whether
// emailLog already records a welcome for them, and the time. Returns 'claim',
// 'already-sent', 'in-progress' or 'no-user-doc'.
function welcomeClaimDecision(userDoc, logged, now) {
  if (logged) return 'already-sent';
  if (!userDoc) return 'no-user-doc';
  if (userDoc.welcomeEmailSentAt) return 'already-sent';
  const claimedAt = toMillis(userDoc.welcomeEmailClaimedAt);
  if (claimedAt && now - claimedAt < WELCOME_CLAIM_TTL_MS) return 'in-progress';
  return 'claim';
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

// deps: getUser(uid) → { email, emailVerified, displayName, metadata.creationTime } or
// null; store.claim(uid, now) → 'claimed' or a welcomeClaimDecision status;
// store.release(uid); store.markSent(uid, now, email); send(user) → true when the
// email went out; now() → ms. Resolves to { status }: 'sent', 'already-sent',
// 'in-progress', 'no-user-doc', 'pre-cutoff', 'not-verified', 'no-email' or 'failed'.
async function sendWelcomeOnce(uid, deps) {
  const since = deps.since != null ? deps.since : WELCOME_AFTER_VERIFY_SINCE;
  const user = await deps.getUser(uid);
  if (!user || !user.email) return { status: 'no-email' };
  // Checked on the server, never taken from the client.
  if (!user.emailVerified) return { status: 'not-verified' };
  const created = Date.parse(user.metadata && user.metadata.creationTime);
  if (Number.isFinite(created) && created < since) return { status: 'pre-cutoff' };
  const claim = await deps.store.claim(uid, deps.now());
  if (claim !== 'claimed') return { status: claim };
  let ok = false;
  try { ok = await deps.send(user); } catch (_) { ok = false; }
  if (!ok) {
    // Let a later attempt try again rather than marking an email that never went out.
    await deps.store.release(uid);
    return { status: 'failed' };
  }
  await deps.store.markSent(uid, deps.now(), user.email);
  return { status: 'sent' };
}

module.exports = {
  WELCOME_AFTER_VERIFY_SINCE,
  WELCOME_CLAIM_TTL_MS,
  welcomeClaimDecision,
  sendWelcomeOnce,
};
