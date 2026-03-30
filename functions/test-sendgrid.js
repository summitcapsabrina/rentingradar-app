// Test script: sends all email templates for visual review
// Run with: node test-sendgrid.js

require('dotenv').config();
const sgMail = require('@sendgrid/mail');

const APP_URL = "https://app.rentingradar.com";
const SITE_URL = "https://rentingradar.com";

const PLAN_FEATURES = {
  Free: ['Up to 15 properties','Pipeline view','Contact management','Follow-up reminders & notifications','Expense tracking'],
  Basic: ['Up to 50 properties','Everything in Free','CSV import & export','Dark mode & 8 color themes','Property analysis','ROI calculator'],
  Pro: ['Unlimited properties','Everything in Basic','Negotiation Forecasting Tools','Advanced property analysis','Priority feature requests']
};

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
<!--[if mso]><style>body{background-color:#0b0d14!important}</style><![endif]-->
<div style="display:none;max-height:0;overflow:hidden;color:#0b0d14;font-size:1px">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
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
      <a href="${preferencesUrl || (APP_URL + '#settings')}" class="text-accent" style="color:#6381fa;text-decoration:none">Unsubscribe from marketing emails</a>.
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildFeatureList(features) {
  return features.map(f =>
    `<tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6;line-height:1.5"><span style="color:#34d399;margin-right:8px">✓</span>${f}</td></tr>`
  ).join("");
}

// ---- WELCOME ----
function welcomeEmailHtml(displayName, tierName) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  const tier = tierName || "Free";
  const features = PLAN_FEATURES[tier] || PLAN_FEATURES.Free;
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Welcome to RentingRadar, ${name}!</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">We're excited to have you on board. You've signed up for the <strong style="color:#6381fa">${tier}</strong> plan${tier !== "Free" ? "" : " — free forever, no credit card needed"}.</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Your ${tier} Plan Includes</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${buildFeatureList(features)}</table>
    </div>
    <div class="divider-line" style="height:1px;background-color:#252a3d;margin:24px 0"></div>
    <p style="margin:0 0 8px;color:#ffffff;font-weight:600">Get started in 2 minutes</p>
    <p style="margin:0 0 16px;color:#c8cbd6">Our interactive tutorial walks you through every feature so you can hit the ground running.</p>
    <p style="text-align:center">
      <a href="${APP_URL}/tutorial.html" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Launch Tutorial</a>
    </p>
    ${tier === "Free" ? `<div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:14px;color:#ffffff;font-weight:600">Want more features?</p>
      <p style="margin:0 0 12px;font-size:13px;color:#9298ad">Upgrade to Basic ($9.99/mo) for property analysis & ROI tools, or Pro ($14.99/mo) for unlimited properties & negotiation forecasting.</p>
      <a href="${SITE_URL}/#pricing" style="color:#6381fa;font-size:13px;font-weight:600;text-decoration:none">View Plans →</a>
    </div>` : ""}
    <div class="divider-line" style="height:1px;background-color:#252a3d;margin:24px 0"></div>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Need help?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>. We typically respond within a few hours.</p>
  `);
}

// ---- CANCELLATION ----
function cancellationEmailHtml(displayName) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">We're sorry to see you go, ${name}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">Your RentingRadar account has been cancelled and your data has been removed from our systems as requested.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">If this was a mistake, or if you'd like to come back, you can create a new account at any time:</p>
    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Return to RentingRadar</a>
    </p>
    <div class="divider-line" style="height:1px;background-color:#252a3d;margin:24px 0"></div>
    <p style="margin:0 0 14px;color:#c8cbd6">We'd love to know how we could have done better. If you have a moment, reply to this email with any feedback — it helps us improve for everyone.</p>
    <p style="font-size:13px;color:#6b7280;margin:0">This is the last email you'll receive from us. If you didn't cancel your account, please contact <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a> immediately.</p>
  `);
}

// ---- FREE TIER NUDGE #1 ----
function upgradeNudge1(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You're doing great, ${name}!</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">You've been using RentingRadar's Free plan, and we hope it's been helpful for tracking your rental deals.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">Did you know that with a <strong style="color:#ffffff">Basic</strong> plan ($9.99/mo) you can also:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span>Track up to <strong style="color:#ffffff">50 properties</strong> (vs. 15 on Free)</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Property analysis</strong> & ROI calculator</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">CSV import & export</strong> for your data</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Dark mode</strong> & 8 color themes</td></tr>
      </table>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">View Plans & Pricing</a>
    </p>
  `);
}

// ---- FREE TIER NUDGE #2 ----
function upgradeNudge2(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Quick tip, ${name}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">Many successful RentingRadar users tell us that <strong style="color:#ffffff">Negotiation Forecasting</strong> and <strong style="color:#ffffff">Advanced Property Analysis</strong> are the features that save them the most money.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">These tools are available on our <strong style="color:#6381fa">Pro plan</strong> ($14.99/mo), and they've helped users lock in better lease terms by showing landlords exactly why a lower rate makes sense for both parties.</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:15px;color:#ffffff;font-weight:600">Pro Plan — $14.99/mo</p>
      <p style="margin:0 0 12px;font-size:13px;color:#9298ad">Unlimited properties, negotiation forecasting, advanced analysis, and priority feature requests.</p>
      <a href="${SITE_URL}/#pricing" style="color:#6381fa;font-size:13px;font-weight:600;text-decoration:none">Compare all plans →</a>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Explore Upgrade Options</a>
    </p>
  `);
}

// ---- FREE TIER NUDGE #3 ----
function upgradeNudge3(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Ready to level up, ${name}?</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">Your Free plan is a great starting point, but as your portfolio grows, you'll want tools that scale with you.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">Here's what you're missing:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#f59e0b;text-transform:uppercase;letter-spacing:.5px">Basic — $9.99/mo</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px">
        <tr><td style="padding:2px 0;font-size:13px;color:#c8cbd6"><span style="color:#34d399;margin-right:6px">✓</span>50 properties, property analysis, ROI calculator, CSV import &amp; export</td></tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Pro — $14.99/mo</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:2px 0;font-size:13px;color:#c8cbd6"><span style="color:#34d399;margin-right:6px">✓</span>Unlimited properties, negotiation forecasting, advanced analysis</td></tr>
      </table>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Upgrade Now</a>
    </p>
  `);
}

// ---- UPGRADE CONFIRMATION (Free → Basic) ----
function upgradeConfirmBasicHtml(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Welcome to Basic, ${name}! 🎉</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">You've upgraded from the Free plan to <strong style="color:#6381fa">Basic</strong> — great decision! Here's everything you now have access to:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Basic Plan — $9.99/mo</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${buildFeatureList(PLAN_FEATURES.Basic)}</table>
    </div>
    <p style="margin:0 0 14px;color:#c8cbd6">Your new features are available right now. Head to the app to start using them:</p>
    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Open RentingRadar</a>
    </p>
    <div class="divider-line" style="height:1px;background-color:#252a3d;margin:24px 0"></div>
    <p style="margin:0 0 14px;color:#c8cbd6">You can manage your subscription anytime from <a href="${APP_URL}#settings" style="color:#6381fa;text-decoration:none">Settings → Billing</a>.</p>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
  `);
}

// ---- UPGRADE CONFIRMATION (Basic → Pro) ----
function upgradeConfirmProHtml(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Welcome to Pro, ${name}! 🎉</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">You've upgraded from Basic to <strong style="color:#6381fa">Pro</strong> — nice move! Here's everything included in your new plan:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Pro Plan — $14.99/mo</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${buildFeatureList(PLAN_FEATURES.Pro)}</table>
    </div>
    <p style="margin:0 0 14px;color:#c8cbd6">Your new features are available right now. Head to the app to start using them:</p>
    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Open RentingRadar</a>
    </p>
    <div class="divider-line" style="height:1px;background-color:#252a3d;margin:24px 0"></div>
    <p style="margin:0 0 14px;color:#c8cbd6">You can manage your subscription anytime from <a href="${APP_URL}#settings" style="color:#6381fa;text-decoration:none">Settings → Billing</a>.</p>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
  `);
}

// ---- BASIC TIER NUDGE #1 (→ Pro) ----
function basicNudge1(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You're crushing it, ${name}!</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">You've been making great use of your Basic plan. Ready to unlock even more powerful tools?</p>
    <p style="margin:0 0 14px;color:#c8cbd6">With the <strong style="color:#6381fa">Pro plan</strong> ($14.99/mo), you get:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Unlimited properties</strong> (vs. 50 on Basic)</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Negotiation Forecasting Tools</strong></td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Advanced property analysis</strong></td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Priority feature requests</strong></td></tr>
      </table>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">View Plans & Pricing</a>
    </p>
  `);
}

// ---- BASIC TIER NUDGE #2 (→ Pro) ----
function basicNudge2(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">A quick thought, ${name}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">As a Basic user, you've already got solid tools for managing your pipeline. But our most successful users say <strong style="color:#ffffff">Negotiation Forecasting</strong> is what really sets them apart.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">It shows landlords exactly why a lower rate makes sense for both parties — backed by data. That's available on our <strong style="color:#6381fa">Pro plan</strong> ($14.99/mo).</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:15px;color:#ffffff;font-weight:600">Pro Plan — $14.99/mo</p>
      <p style="margin:0 0 12px;font-size:13px;color:#9298ad">Unlimited properties, negotiation forecasting, advanced analysis, and priority feature requests.</p>
      <a href="${SITE_URL}/#pricing" style="color:#6381fa;font-size:13px;font-weight:600;text-decoration:none">Compare all plans →</a>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Explore Pro Features</a>
    </p>
  `);
}

// ---- BASIC TIER NUDGE #3 (→ Pro) ----
function basicNudge3(name) {
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Outgrowing your Basic plan, ${name}?</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">With 50 properties on your Basic plan, you've got a solid setup. But as your portfolio scales, you'll want the freedom of <strong style="color:#ffffff">unlimited tracking</strong> plus advanced negotiation tools.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">Here's what Pro adds on top of Basic:</p>
    <div class="feat-box" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Unlimited properties</strong> — no cap on your portfolio</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Negotiation Forecasting Tools</strong> — data-backed lease negotiations</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Advanced property analysis</strong> — deeper deal insights</td></tr>
        <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Priority feature requests</strong> — shape the product roadmap</td></tr>
      </table>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Upgrade to Pro</a>
    </p>
  `);
}

// ---- MAIN ----
const key = process.env.SENDGRID_API_KEY;
console.log('API Key exists:', !!key);
if (!key) { console.error('SENDGRID_API_KEY not found'); process.exit(1); }
sgMail.setApiKey(key);

const TO = 'sabrina@summitcapllc.com';
const FROM = { email: 'help@rentingradar.com', name: 'RentingRadar' };

async function sendAll() {
  const emails = [
    // Core emails
    { subject: "TEST: 🎉 Welcome to RentingRadar! Here's how to get started", html: welcomeEmailHtml('Sabrina', 'Free') },
    { subject: "TEST: 👋 Your RentingRadar account has been cancelled", html: cancellationEmailHtml('Sabrina') },

    // Free tier upgrade nudges
    { subject: "TEST: 🚀 Unlock your full potential", html: upgradeNudge1('Sabrina') },
    { subject: "TEST: 💡 Are you getting the most out of RentingRadar?", html: upgradeNudge2('Sabrina') },
    { subject: "TEST: 📈 A smarter way to manage your rentals", html: upgradeNudge3('Sabrina') },

    // Upgrade confirmations
    { subject: "TEST: 🎉 Welcome to Basic! Your upgrade is confirmed", html: upgradeConfirmBasicHtml('Sabrina') },
    { subject: "TEST: 🎉 Welcome to Pro! Your upgrade is confirmed", html: upgradeConfirmProHtml('Sabrina') },

    // Basic tier upgrade nudges (→ Pro)
    { subject: "TEST: 🚀 Take your rental game to the next level", html: basicNudge1('Sabrina') },
    { subject: "TEST: 💡 Negotiate smarter with Pro tools", html: basicNudge2('Sabrina') },
    { subject: "TEST: 📈 Unlimited properties are one click away", html: basicNudge3('Sabrina') },
  ];

  for (const email of emails) {
    try {
      await sgMail.send({ to: TO, from: FROM, subject: email.subject, html: email.html });
      console.log('✅ Sent:', email.subject);
    } catch (err) {
      console.error('❌ Failed:', email.subject, err?.response?.body || err.message);
    }
  }
  console.log(`\nDone! Check sabrina@summitcapllc.com for all ${emails.length} test emails.`);
}

sendAll();
