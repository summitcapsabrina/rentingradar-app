// Limits verification emails per user, across tabs and reloads. Loaded by index.html
// as plain globals and required by tests/email-verify-guard.test.js under node --test.
// Nothing in this file may touch the DOM or Firebase: storage, now() and send() come in.

const VERIFY_EMAIL_COOLDOWN_MS = 60000;
const VERIFY_EMAIL_RATE_LIMIT_BACKOFF_MS = 5 * 60000;

function verifyEmailKey(uid) {
  return 'rr_verifyEmailSentAt_' + uid;
}

function _verifyEmailSentAt(storage, uid) {
  try {
    const at = Number(storage.getItem(verifyEmailKey(uid)));
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch (_) { return 0; }
}

// Milliseconds until another send is allowed, 0 if one is allowed now. Capped at the
// backoff, so a bad stored value or a clock change can't lock the button for good.
function verifyEmailWaitMs(storage, uid, now) {
  const at = _verifyEmailSentAt(storage, uid);
  if (!at) return 0;
  return Math.min(VERIFY_EMAIL_RATE_LIMIT_BACKOFF_MS, Math.max(0, at + VERIFY_EMAIL_COOLDOWN_MS - now));
}

// One send at a time in this tab. Other tabs see the stored timestamp instead.
let _verifyEmailInFlight = false;

// trySend(uid, send) resolves to { status, waitMs, error? }, where status is 'sent',
// 'cooldown', 'in-flight', 'rate-limited' or 'error'. send() is only called for 'sent'
// and the two failures.
function createVerifyEmailSender(opts) {
  const storage = opts.storage;
  const now = opts.now;
  const write = (uid, at) => { try { storage.setItem(verifyEmailKey(uid), String(at)); } catch (_) {} };
  const clear = (uid) => { try { storage.removeItem(verifyEmailKey(uid)); } catch (_) {} };

  async function trySend(uid, send) {
    if (!uid) return { status: 'error', waitMs: 0, error: new Error('No signed-in user') };
    if (_verifyEmailInFlight) return { status: 'in-flight', waitMs: verifyEmailWaitMs(storage, uid, now()) };
    const wait = verifyEmailWaitMs(storage, uid, now());
    if (wait > 0) return { status: 'cooldown', waitMs: wait };
    _verifyEmailInFlight = true;
    // Written before sending, so another tab sees the cooldown at once.
    write(uid, now());
    try {
      await send();
      return { status: 'sent', waitMs: verifyEmailWaitMs(storage, uid, now()) };
    } catch (error) {
      if (error && error.code === 'auth/too-many-requests') {
        // Firebase is refusing: wait the whole backoff, not just the cooldown.
        write(uid, now() + VERIFY_EMAIL_RATE_LIMIT_BACKOFF_MS - VERIFY_EMAIL_COOLDOWN_MS);
        return { status: 'rate-limited', waitMs: verifyEmailWaitMs(storage, uid, now()), error };
      }
      // Nothing went out, so the user may try again straight away.
      clear(uid);
      return { status: 'error', waitMs: 0, error };
    } finally {
      _verifyEmailInFlight = false;
    }
  }

  return { trySend };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VERIFY_EMAIL_COOLDOWN_MS,
    VERIFY_EMAIL_RATE_LIMIT_BACKOFF_MS,
    verifyEmailKey,
    verifyEmailWaitMs,
    createVerifyEmailSender,
  };
}
