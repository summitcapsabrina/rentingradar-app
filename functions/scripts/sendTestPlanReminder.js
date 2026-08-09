/*
 * One-off TEST script — sends the two "pick a plan" reminder drafts to
 * help@rentingradar.com so Dave can review the copy before we send to real
 * prospects or wire up the scheduled function.
 *
 * Self-contained on purpose: it reproduces emailWrapper() styling and reads the
 * SendGrid key straight from functions/.env, so it does NOT load firebase-admin
 * (which would need Firestore credentials we don't have locally right now).
 *
 * Run:  node functions/scripts/sendTestPlanReminder.js
 * Once the copy is approved, the finalized template moves into index.js and the
 * scheduled noPlanReminders function becomes the single source of truth.
 */
const fs = require("fs");
const path = require("path");
const sgMail = require("../node_modules/@sendgrid/mail");

// --- load SENDGRID_API_KEY from functions/.env (no dotenv dependency) ---
const envPath = path.join(__dirname, "..", ".env");
const envText = fs.readFileSync(envPath, "utf8");
const keyLine = envText.split(/\r?\n/).find((l) => l.startsWith("SENDGRID_API_KEY="));
if (!keyLine) throw new Error("SENDGRID_API_KEY not found in functions/.env");
const SENDGRID_API_KEY = keyLine.slice("SENDGRID_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
sgMail.setApiKey(SENDGRID_API_KEY);

const FROM_EMAIL = { email: "help@rentingradar.com", name: "RentingRadar" };
const APP_URL = "https://app.rentingradar.com";
const SITE_URL = "https://rentingradar.com";
const TEST_TO = "help@rentingradar.com";

// --- brand wrapper (copied verbatim from functions/index.js emailWrapper) ---
function emailWrapper(bodyHtml, preferencesUrl) {
  const logoImg = `<img src="${SITE_URL}/logo-email.png" width="30" height="30" alt="RentingRadar" style="vertical-align:middle;margin-right:8px">`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark only"><meta name="supported-color-schemes" content="dark only">
</head><body style="margin:0;padding:0;background-color:#0b0d14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e4eb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0d14">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#141726;border-radius:12px;overflow:hidden;border:1px solid #252a3d">
  <tr><td style="background-color:#0b0d14;padding:28px 40px;text-align:center;border-bottom:1px solid #252a3d">
    ${logoImg}<span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.3px;vertical-align:middle">RentingRadar</span>
  </td></tr>
  <tr><td style="padding:36px 40px;color:#e2e4eb;font-size:15px;line-height:1.65;background-color:#141726">
    ${bodyHtml}
  </td></tr>
  <tr><td style="background-color:#0f1120;padding:24px 40px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #252a3d">
    <p style="margin:0;color:#6b7280">RentingRadar &middot; help@rentingradar.com</p>
    <p style="margin:8px 0 0">
      <a href="${preferencesUrl || (APP_URL + '#settings')}" style="color:#6381fa;text-decoration:none">Email Preferences</a>
      &nbsp;&middot;&nbsp;<a href="${SITE_URL}/privacy/" style="color:#6381fa;text-decoration:none">Privacy Policy</a>
      &nbsp;&middot;&nbsp;<a href="${SITE_URL}/terms/" style="color:#6381fa;text-decoration:none">Terms of Service</a>
    </p>
    <p style="margin:8px 0 0;color:#4b5068;font-size:11px">
      You're receiving this because you created a RentingRadar account.
      <a href="${preferencesUrl || (APP_URL + '#settings')}" style="color:#6381fa;text-decoration:none">Unsubscribe</a>.
    </p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

const planBox = `
  <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
    <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Choose Your Plan</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:7px 0;font-size:14px;color:#c8cbd6;border-bottom:1px solid #252a3d"><strong style="color:#ffffff">Basic</strong> — $9.99/mo<br><span style="font-size:13px;color:#9298ad">manage <strong style="color:#34d399">1 property</strong> in Operations · <strong style="color:#34d399">1 analysis</strong>/month</span></td></tr>
      <tr><td style="padding:7px 0;font-size:14px;color:#c8cbd6;border-bottom:1px solid #252a3d"><strong style="color:#ffffff">Standard</strong> — $19.99/mo<br><span style="font-size:13px;color:#9298ad">manage up to <strong style="color:#34d399">5 properties</strong> in Operations · <strong style="color:#34d399">10 analyses</strong>/month</span></td></tr>
      <tr><td style="padding:7px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo<br><span style="font-size:13px;color:#9298ad">manage <strong style="color:#34d399">unlimited properties</strong> in Operations · <strong style="color:#34d399">unlimited analyses</strong></span></td></tr>
    </table>
  </div>`;

const ctaBtn = (label) => `
  <p style="text-align:center">
    <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">${label}</a>
  </p>`;

// STAGE 1 — ~2 business days after signup (gentle first nudge)
function planReminderFirst(displayName, preferencesUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  return {
    subject: "Your RentingRadar free trial is waiting ⏳",
    html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You're almost set up, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Welcome to RentingRadar! We noticed you created your account but haven't picked a plan yet — so your <strong style="color:#34d399">free 7-day trial</strong> hasn't started.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">Choose any plan to unlock the app. You won't be charged until day 7, and you can cancel anytime before then with one click. From there you can start organizing your <strong style="color:#ffffff">Rental Arbitrage</strong> and <strong style="color:#ffffff">Co-Hosting</strong> prospecting and operations right away.</p>
      ${planBox}
      ${ctaBtn("Choose a Plan &amp; Start Free Trial")}
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Just reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>. We're happy to help you get started.</p>
    `, preferencesUrl),
  };
}

// STAGE 2 — ~7 business days after signup (value-focused follow-up)
function planReminderSecond(displayName, preferencesUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  return {
    subject: "Still deciding? Your free trial — and your deals — are waiting",
    html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Ready when you are, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your RentingRadar account is set up, but you haven't started your <strong style="color:#34d399">free 7-day trial</strong> yet. The moment you pick a plan, you can put it to work:</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span>Analyze <strong style="color:#ffffff">Rental Arbitrage &amp; Co-Hosting</strong> deals with real competitor data</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span>Track prospects and deals in one organized pipeline</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span>Manage expenses and day-to-day operations in one place</td></tr>
        </table>
      </div>
      <p style="margin:0 0 14px;color:#c8cbd6">Every plan starts with a free 7-day trial — no charge until day 7, cancel anytime.</p>
      ${planBox}
      ${ctaBtn("Start My Free Trial")}
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0">Not the right time? No problem — reply and let us know if there's anything we can help with, or if you'd rather not hear from us.</p>
    `, preferencesUrl),
  };
}

async function main() {
  // Use "[User]" as the first-name placeholder in TEST sends so Dave can verify
  // the merge lands correctly. Real emails use the user's actual first name (no brackets).
  const drafts = [
    { tag: "STAGE 1 · 2 biz days", data: planReminderFirst("[User]") },
    { tag: "STAGE 2 · 7 biz days", data: planReminderSecond("[User]") },
  ];
  for (const d of drafts) {
    const msg = {
      to: TEST_TO,
      from: FROM_EMAIL,
      subject: `[TEST — ${d.tag}] ${d.data.subject}`,
      html: d.data.html,
      categories: ["test-plan-reminder"],
    };
    try {
      await sgMail.send(msg);
      console.log(`✓ Sent test (${d.tag}) to ${TEST_TO}: "${msg.subject}"`);
    } catch (err) {
      console.error(`✗ Failed (${d.tag}):`, err?.response?.body || err.message);
      process.exitCode = 1;
    }
  }
}

main();
