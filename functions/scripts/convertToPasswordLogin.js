/*
 * One-off ADMIN script — converts an existing account from Google sign-in to
 * email/password WITHOUT changing the Firebase UID, so all Firestore data
 * (users/{uid}, emailPreferences/{uid}, Stripe links, etc.) is retained.
 *
 * What it does:
 *   1. Looks up the user by email and prints their UID + current providers.
 *   2. Sets a temporary password on that SAME account (adds the `password`
 *      provider alongside google.com — no data touched).
 *   3. Optionally unlinks google.com so they can no longer sign in with Google.
 *
 * The user then signs in with email + temp password and changes it via the
 * app's normal "forgot / change password" flow.
 *
 * Auth: needs Admin credentials. Easiest locally:
 *     gcloud auth application-default login   (once)
 *   OR point at a service-account key:
 *     export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 *
 * Run (dry run — just shows the account, changes nothing):
 *     node functions/scripts/convertToPasswordLogin.js user@example.com
 *
 * Set a temp password:
 *     node functions/scripts/convertToPasswordLogin.js user@example.com 'TempPass123!'
 *
 * Set a temp password AND remove Google login:
 *     node functions/scripts/convertToPasswordLogin.js user@example.com 'TempPass123!' --unlink-google
 */
const admin = require("firebase-admin");

admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC

const EMAIL = process.argv[2];
const TEMP_PASSWORD = process.argv[3];
const UNLINK_GOOGLE = process.argv.includes("--unlink-google");

if (!EMAIL) {
  console.error("Usage: node convertToPasswordLogin.js <email> [tempPassword] [--unlink-google]");
  process.exit(1);
}

(async () => {
  const user = await admin.auth().getUserByEmail(EMAIL);
  const providers = user.providerData.map((p) => p.providerId);
  console.log(`Found account:`);
  console.log(`  UID:        ${user.uid}`);
  console.log(`  email:      ${user.email}`);
  console.log(`  providers:  ${providers.join(", ") || "(none)"}`);
  console.log(`  hasPassword: ${providers.includes("password")}`);

  if (!TEMP_PASSWORD) {
    console.log("\nDry run — no password given, nothing changed.");
    console.log("Re-run with a temp password (min 6 chars) to apply.");
    return;
  }

  await admin.auth().updateUser(user.uid, { password: TEMP_PASSWORD });
  console.log(`\n✓ Temp password set on UID ${user.uid} (data untouched).`);

  if (UNLINK_GOOGLE) {
    if (providers.includes("google.com")) {
      await admin.auth().updateUser(user.uid, { providersToUnlink: ["google.com"] });
      console.log("✓ Unlinked google.com — Google sign-in disabled for this account.");
    } else {
      console.log("• google.com not linked; nothing to unlink.");
    }
  }

  const after = await admin.auth().getUser(user.uid);
  console.log(`\nFinal providers: ${after.providerData.map((p) => p.providerId).join(", ")}`);
  console.log("Done. Give the user the temp password out-of-band; have them reset it after logging in.");
})().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
