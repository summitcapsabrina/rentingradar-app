// Email-verified status for the admin Users table. Firestore user docs don't carry
// it; Firebase Auth does. No firebase-admin in here: index.js passes in
// auth.getUsers, so tests/admin-email-verified.test.js can run it under node.

// auth.getUsers() accepts at most 100 identifiers per call.
const GET_USERS_CHUNK = 100;
// Far above today's user count; stops one request from fanning out without bound.
const MAX_UIDS = 10000;

// Returns a deduped uid list from the request body, or null when it's malformed.
function parseUids(body) {
  const uids = body && body.uids;
  if (!Array.isArray(uids) || uids.length > MAX_UIDS) return null;
  if (!uids.every((u) => typeof u === "string" && u.length > 0 && u.length <= 128)) return null;
  return Array.from(new Set(uids));
}

// { uid: emailVerified } for every uid Auth knows. Uids Auth doesn't know are left
// out, so the table shows them blank. Only the boolean leaves this function.
async function lookupEmailVerified(getUsers, uids) {
  const verified = {};
  for (let i = 0; i < uids.length; i += GET_USERS_CHUNK) {
    const chunk = uids.slice(i, i + GET_USERS_CHUNK).map((uid) => ({ uid }));
    const result = await getUsers(chunk);
    (result.users || []).forEach((u) => { verified[u.uid] = u.emailVerified === true; });
  }
  return verified;
}

module.exports = { GET_USERS_CHUNK, MAX_UIDS, parseUids, lookupEmailVerified };
