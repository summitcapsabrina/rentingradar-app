// Quick test script to send all 5 trial reminder emails
// Run: cd functions && node test-trial-emails.js

require('dotenv').config();
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const TO_EMAIL = "sabrina@summitcapllc.com";
const FROM_EMAIL = { email: "help@rentingradar.com", name: "RentingRadar" };
const APP_URL = "https://app.rentingradar.com";
const SITE_URL = "https://rentingradar.com";

function emailWrapper(bodyHtml, preferencesUrl) {
  const logoImg = `<img src="${SITE_URL}/logo-email.png" width="30" height="30" alt="RentingRadar" style="vertical-align:middle;margin-right:8px">`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark only">
<meta name="supported-color-schemes" content="dark only">
<style>
  :root{color-scheme:dark only}
  body,table,td,div,p,a,span{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  @media(prefers-color-scheme:light){
    .email-bg{background-color:#0b0d14!important}
    .email-card{background-color:#141726!important}
    .email-header{background-color:#0b0d14!important}
    .email-body{background-color:#141726!important}
    .email-body td,.email-body p,.email-body h2,.email-body span,.email-body strong{color:#e2e4eb!important}
    .email-footer{background-color:#0f1120!important}
    .feat-box{background-color:#1a1e30!important;border-color:#252a3d!important}
    .text-main{color:#e2e4eb!important}
    .text-sub{color:#c8cbd6!important}
    .text-white{color:#ffffff!important}
    .text-muted{color:#6b7280!important}
    .text-dim{color:#4b5068!important}
    .text-accent{color:#6381fa!important}
    .divider-line{background-color:#252a3d!important}
  }
</style>
</head><body class="email-bg" style="margin:0;padding:0;background-color:#0b0d14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e4eb">
<div style="display:none;max-height:0;overflow:hidden;color:#0b0d14;font-size:1px">&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="email-bg" style="background-color:#0b0d14">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" class="email-card" style="max-width:560px;width:100%;background-color:#141726;border-radius:12px;overflow:hidden;border:1px solid #252a3d">
  <tr><td class="email-header" style="background-color:#0b0d14;padding:28px 40px;text-align:center;border-bottom:1px solid #252a3d">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      ${logoImg}<span class="text-white" style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.3px;vertical-align:middle">RentingRadar</span>
    </td></tr></table>
  </td></tr>
  <tr><td class="email-body" style="padding:36px 40px;color:#e2e4eb;font-size:15px;line-height:1.65;background-color:#141726">
    ${bodyHtml}
  </td></tr>
  <tr><td class="email-footer" style="background-color:#0f1120;padding:24px 40px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #252a3d">
    <p class="text-muted" style="margin:0;color:#6b7280">RentingRadar &middot; help@rentingradar.com</p>
    <p style="margin:8px 0 0">
      <a href="${preferencesUrl || (APP_URL + '#settings')}" class="text-accent" style="color:#6381fa;text-decoration:none">Email Preferences</a>
      &nbsp;&middot;&nbsp;
      <a href="${SITE_URL}/privacy/" class="text-accent" style="color:#6381fa;text-decoration:none">Privacy Policy</a>
      &nbsp;&middot;&nbsp;
      <a href="${SITE_URL}/terms/" class="text-accent" style="color:#6381fa;text-decoration:none">Terms of Service</a>
    </p>
    <p class="text-dim" style="margin:8px 0 0;color:#4b5068;font-size:11px">
      You're receiving this because you have a RentingRadar account.
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function trialReminderEmailHtml(displayName, daysLeft, tierName) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  const tierDisplay = tierName ? tierName.charAt(0).toUpperCase() + tierName.slice(1) : "your";

  if (daysLeft === 4) {
    return { subject: `⏳ Your ${tierDisplay} trial is halfway over`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Halfway there, ${name}!</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">You have <strong style="color:#f59e0b">4 days left</strong> on your ${tierDisplay} free trial. We hope you've been enjoying the platform so far.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">When your trial ends, you'll need an active subscription to continue accessing your properties, analyses, and pipeline data. Your data will be saved — it'll be right where you left it once you subscribe.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
        <p style="margin:0 0 4px;font-size:14px;color:#ffffff;font-weight:600">No action needed right now</p>
        <p style="margin:0 0 0;font-size:13px;color:#9298ad">Your trial continues until it expires. You can subscribe anytime from the app.</p>
      </div>
      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Open RentingRadar</a>
      </p>
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `) };
  }

  if (daysLeft === 2) {
    return { subject: `⚠️ 2 days left on your ${tierDisplay} trial`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Your trial ends in 2 days, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Just a heads up — your ${tierDisplay} free trial expires in <strong style="color:#f59e0b">2 days</strong>.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">After your trial ends, you will <strong style="color:#ffffff">lose access to the app</strong>, including your property pipeline, analyses, expense tracking, and all other features. Your data will be preserved, but you won't be able to view or use it until you subscribe.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#f59e0b;text-transform:uppercase;letter-spacing:.5px">What happens when your trial ends</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#ef4444;margin-right:8px">✕</span>You will not be able to log into the app</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#ef4444;margin-right:8px">✕</span>Your properties, analyses, and pipeline will be inaccessible</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span>Your data is preserved — subscribe anytime to restore full access</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe Now</a>
      </p>
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `) };
  }

  if (daysLeft === 0) {
    return { subject: `🔒 Your ${tierDisplay} trial has ended`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Your trial has ended, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your 7-day ${tierDisplay} free trial has expired. As of today, <strong style="color:#ffffff">your access to RentingRadar has been paused</strong>.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">This means you can no longer log in, view your properties, run analyses, or access any features in the app.</p>
      <p style="margin:0 0 14px;color:#c8cbd6"><strong style="color:#34d399">Your data is safe.</strong> All your properties, pipeline data, expenses, and analyses are preserved. Subscribe to any plan to instantly restore full access to everything.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Choose a Plan</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo · 1 analysis/month, 15 properties</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo · 10 analyses/month, 50 properties</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo · Unlimited analyses & properties</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe & Restore Access</a>
      </p>
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `) };
  }

  if (daysLeft === -7) {
    return { subject: `Your RentingRadar data is waiting for you`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">It's been a week, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your RentingRadar trial ended a week ago, and your account is currently locked. You're missing out on tracking and analyzing rental deals.</p>
      <p style="margin:0 0 14px;color:#c8cbd6"><strong style="color:#34d399">Your data is still here.</strong> Every property, analysis, and pipeline entry you created during your trial is saved and waiting for you. Subscribe to pick up right where you left off.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Plans start at $9.99/mo</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo · 1 analysis/month, 15 properties</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo · 10 analyses/month, 50 properties</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo · Unlimited analyses & properties</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe & Restore Access</a>
      </p>
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `) };
  }

  if (daysLeft === -30) {
    return { subject: `Final reminder: your RentingRadar account is locked`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">We'd hate to see your data go unused, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">It's been a month since your RentingRadar trial ended. Your account remains locked, but <strong style="color:#34d399">all your data is still preserved</strong>.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">This is our last reminder. If you'd like to continue using RentingRadar to manage your rental arbitrage pipeline, subscribe to a plan below. If not, no worries — we wish you the best.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Plans start at $9.99/mo</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe & Restore Access</a>
      </p>
      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0">This is the last email we'll send about your trial. <strong style="color:#9298ad">Questions?</strong> <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `) };
  }

  return null;
}

async function sendAll() {
  const emails = [
    trialReminderEmailHtml("Sabrina", 4, "standard"),   // Day 3 — halfway
    trialReminderEmailHtml("Sabrina", 2, "standard"),   // Day 5 — 2 days left
    trialReminderEmailHtml("Sabrina", 0, "standard"),   // Day 7 — expired
    trialReminderEmailHtml("Sabrina", -7, "standard"),  // 1 week after
    trialReminderEmailHtml("Sabrina", -30, "standard"), // 1 month after
  ];

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    const label = ["Day 3 (halfway)", "Day 5 (2 days left)", "Day 7 (expired)", "1 week after", "1 month after (final)"][i];
    try {
      await sgMail.send({
        to: TO_EMAIL,
        from: FROM_EMAIL,
        subject: `[TEST ${i+1}/5] ${e.subject}`,
        html: e.html,
      });
      console.log(`✓ Sent ${label}: ${e.subject}`);
    } catch (err) {
      console.error(`✕ Failed ${label}:`, err?.response?.body || err.message);
    }
  }
  console.log("\nDone! Check your inbox.");
}

sendAll();
