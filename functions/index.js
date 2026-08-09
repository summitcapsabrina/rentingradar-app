const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const stripe = require("stripe");
const cors = require("cors")({ origin: true });
const sgMail = require("@sendgrid/mail");
const Busboy = require("busboy");

admin.initializeApp();
const db = admin.firestore();

const getStripe = () => stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================
// SENDGRID SETUP
// ============================================================
function initSendGrid() {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = { email: "help@rentingradar.com", name: "RentingRadar" };
// Single source of truth for admin/system notifications. Change here only.
const ADMIN_EMAIL = "help@rentingradar.com";
const APP_URL = "https://app.rentingradar.com";
const SITE_URL = "https://rentingradar.com";
const PHYSICAL_ADDRESS = "RentingRadar · help@rentingradar.com";

// ============================================================
// EMAIL TEMPLATES — Dark theme matching rentingradar.com
// ============================================================

// Plan feature data (must match website/app exactly)
const PLAN_FEATURES = {
  Basic: [
    'Analyze 1 property per month',
    'Pipeline management',
    'Full-scope property profiles',
    'Follow-up reminders & notifications',
    'Expense tracking'
  ],
  Standard: [
    'Analyze 10 properties per month',
    'Everything in Basic',
    'CSV import & export',
    'Dark mode & 8 color themes'
  ],
  Pro: [
    'Analyze unlimited properties',
    'Everything in Standard',
    'Negotiation Forecasting Tools',
    'Priority feature requests'
  ]
};

// opts.transactional — set true for non-marketing emails (e.g. commission statements,
// receipts). Drops the "Email Preferences" link and the "Unsubscribe from marketing
// emails" line, since CAN-SPAM unsubscribe requirements apply to marketing mail, not
// transactional account/affiliate mail.
function emailWrapper(bodyHtml, preferencesUrl, opts) {
  opts = opts || {};
  const transactional = !!opts.transactional;
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

  <!-- HEADER -->
  <tr><td class="email-header" style="background-color:#0b0d14;padding:28px 40px;text-align:center;border-bottom:1px solid #252a3d">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      ${logoImg}<span class="text-white" style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.3px;vertical-align:middle">RentingRadar</span>
    </td></tr></table>
  </td></tr>

  <!-- BODY -->
  <tr><td class="email-body" style="padding:36px 40px;color:#e2e4eb;font-size:15px;line-height:1.65;background-color:#141726">
    ${bodyHtml}
  </td></tr>

  <!-- FOOTER -->
  <tr><td class="email-footer" style="background-color:#0f1120;padding:24px 40px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #252a3d">
    <p class="text-muted" style="margin:0;color:#6b7280">RentingRadar &middot; help@rentingradar.com</p>
    <p style="margin:8px 0 0">
      ${transactional ? '' : `<a href="${preferencesUrl || (APP_URL + '#settings')}" class="text-accent" style="color:#6381fa;text-decoration:none">Email Preferences</a>
      &nbsp;&middot;&nbsp;`}
      <a href="${SITE_URL}/privacy/" class="text-accent" style="color:#6381fa;text-decoration:none">Privacy Policy</a>
      &nbsp;&middot;&nbsp;
      <a href="${SITE_URL}/terms/" class="text-accent" style="color:#6381fa;text-decoration:none">Terms of Service</a>
    </p>
    ${transactional ? '' : `<p class="text-dim" style="margin:8px 0 0;color:#4b5068;font-size:11px">
      You're receiving this because you have a RentingRadar account.
      <a href="${preferencesUrl || (APP_URL + '#settings')}" class="text-accent" style="color:#6381fa;text-decoration:none">Unsubscribe from marketing emails</a>.
    </p>`}
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

function welcomeEmailHtml(displayName) {
  const firstName = displayName ? displayName.split(" ")[0] : null;

  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">${firstName ? 'Welcome to RentingRadar, ' + firstName + '!' : 'Welcome to RentingRadar!'}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">We're excited to have you on board! To get started, choose a plan and enter your payment details. Every plan comes with a <strong style="color:#34d399">free 7-day trial</strong> — you won't be charged until day 7, and you can cancel anytime before then with one click.</p>

    <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Choose Your Plan</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo · 1 analysis/month</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo · 10 analyses/month</td></tr>
        <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo · Unlimited analyses</td></tr>
      </table>
    </div>

    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Choose a Plan & Start Free Trial</a>
    </p>

    <div style="height:1px;background:#252a3d;margin:24px 0"></div>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Need help?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>. We typically respond within a few hours.</p>
  `);
}

function cancellationEmailHtml(displayName) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">We're sorry to see you go, ${name}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">Your RentingRadar account has been cancelled and your data has been removed from our systems as requested.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">If this was a mistake, or if you'd like to come back, you can create a new account at any time:</p>
    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Return to RentingRadar</a>
    </p>
    <div style="height:1px;background:#252a3d;margin:24px 0"></div>
    <p style="margin:0 0 14px;color:#c8cbd6">We'd love to know how we could have done better. If you have a moment, reply to this email with any feedback — it helps us improve for everyone.</p>
    <p style="font-size:13px;color:#6b7280;margin:0">This is the last email you'll receive from us. If you didn't cancel your account, please contact <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a> immediately.</p>
  `);
}

// Upgrade nudge emails for BASIC tier users (nudging to Standard)
function upgradeNudgeEmailHtml(displayName, weekNumber, unsubscribeUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";

  const subjects = [
    { subject: "🚀 Unlock your full potential", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You're doing great, ${name}!</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">You've been making the most of your Basic plan, and we hope it's been helpful for tracking your rental deals.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">Did you know that with the <strong style="color:#ffffff">Standard</strong> plan ($19.99/mo) you can also:</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Analyze 10 properties per month</strong> (vs. 1 on Basic)</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">CSV import & export</strong> for your data</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Dark mode</strong> & 8 color themes</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">View Plans & Pricing</a>
      </p>
    `},
    { subject: "💡 Are you getting the most out of RentingRadar?", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Quick tip, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Many successful RentingRadar users tell us that having <strong style="color:#ffffff">10 analyses per month</strong> is what really accelerates their deal flow.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">These are available on our <strong style="color:#6381fa">Standard plan</strong> ($19.99/mo), and they've helped users evaluate more deals and close faster.</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0;text-align:center">
        <p style="margin:0 0 4px;font-size:15px;color:#ffffff;font-weight:600">Standard Plan — $19.99/mo</p>
        <p style="margin:0 0 12px;font-size:13px;color:#9298ad">10 analyses/month, CSV import/export, dark mode & themes.</p>
        <a href="${SITE_URL}/#pricing" style="color:#6381fa;font-size:13px;font-weight:600;text-decoration:none">Compare all plans →</a>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Explore Upgrade Options</a>
      </p>
    `},
    { subject: "📈 A smarter way to manage your rentals", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Ready to level up, ${name}?</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your Basic plan is a great starting point, but as your portfolio grows, you'll want tools that scale with you.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">Here's what you're missing:</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#f59e0b;text-transform:uppercase;letter-spacing:.5px">Standard — $19.99/mo</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px">
          <tr><td style="padding:2px 0;font-size:13px;color:#c8cbd6"><span style="color:#34d399;margin-right:6px">✓</span>10 analyses/month, CSV import &amp; export, dark mode &amp; themes</td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Pro — $29.99/mo</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:2px 0;font-size:13px;color:#c8cbd6"><span style="color:#34d399;margin-right:6px">✓</span>Unlimited analyses, negotiation forecasting, priority feature requests</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Upgrade Now</a>
      </p>
    `}
  ];

  const idx = (weekNumber || 0) % subjects.length;
  return { subject: subjects[idx].subject, html: emailWrapper(subjects[idx].body, unsubscribeUrl) };
}

// Upgrade nudge emails for STANDARD tier users (nudging to Pro)
function standardUpgradeNudgeEmailHtml(displayName, weekNumber, unsubscribeUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";

  const subjects = [
    { subject: "🚀 Take your rental game to the next level", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You're crushing it, ${name}!</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">You've been making great use of your Standard plan. Ready to unlock even more powerful tools?</p>
      <p style="margin:0 0 14px;color:#c8cbd6">With the <strong style="color:#6381fa">Pro plan</strong> ($29.99/mo), you get:</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Analyze unlimited properties</strong> (vs. 10/month on Standard)</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Negotiation Forecasting Tools</strong></td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Priority feature requests</strong></td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">View Plans & Pricing</a>
      </p>
    `},
    { subject: "💡 Negotiate smarter with Pro tools", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">A quick thought, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">As a Standard user, you've already got solid tools for managing your pipeline. But our most successful users say <strong style="color:#ffffff">Negotiation Forecasting</strong> is what really sets them apart.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">It shows landlords exactly why a lower rate makes sense for both parties — backed by data. That's available on our <strong style="color:#6381fa">Pro plan</strong> ($29.99/mo).</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0;text-align:center">
        <p style="margin:0 0 4px;font-size:15px;color:#ffffff;font-weight:600">Pro Plan — $29.99/mo</p>
        <p style="margin:0 0 12px;font-size:13px;color:#9298ad">Unlimited analyses, negotiation forecasting tools, and priority feature requests.</p>
        <a href="${SITE_URL}/#pricing" style="color:#6381fa;font-size:13px;font-weight:600;text-decoration:none">Compare all plans →</a>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Explore Pro Features</a>
      </p>
    `},
    { subject: "📈 Unlimited analyses are one click away", body: `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Outgrowing your Standard plan, ${name}?</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">With 10 analyses per month on your Standard plan, you've got a solid setup. But as your portfolio scales, you'll want the freedom of <strong style="color:#ffffff">unlimited analyses</strong> plus advanced negotiation tools.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">Here's what Pro adds on top of Standard:</p>
      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Analyze unlimited properties</strong> — no monthly cap</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Negotiation Forecasting Tools</strong> — data-backed lease negotiations</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Priority feature requests</strong> — shape the product roadmap</td></tr>
        </table>
      </div>
      <p style="text-align:center">
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Upgrade to Pro</a>
      </p>
    `}
  ];

  const idx = (weekNumber || 0) % subjects.length;
  return { subject: subjects[idx].subject, html: emailWrapper(subjects[idx].body, unsubscribeUrl) };
}


// Analysis quota limit email — sent when a Basic or Standard user uses all their analyses for the cycle
function analysisLimitEmailHtml(displayName, userTier, resetDateStr, unsubscribeUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  const isBasicPlan = userTier === "basic";
  const limit = isBasicPlan ? 1 : 10;
  const nextTier = isBasicPlan ? "Standard" : "Pro";
  const nextPrice = isBasicPlan ? "$19.99" : "$29.99";
  const nextLimit = isBasicPlan ? "10 analyses per month" : "unlimited analyses";

  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">You've hit your analysis limit, ${name}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">You've used ${limit === 1 ? "your <strong style=\"color:#ffffff\">1 property analysis</strong>" : "all <strong style=\"color:#ffffff\">" + limit + " property analyses</strong>"} for this 30-day cycle.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">Your analyses will reset on <strong style="color:#ffffff">${resetDateStr}</strong>. In the meantime, you can still view data on properties you've already analyzed.</p>

    <div style="height:1px;background:#252a3d;margin:24px 0"></div>

    <p style="margin:0 0 14px;color:#ffffff;font-weight:600">Don't want to wait?</p>
    <p style="margin:0 0 14px;color:#c8cbd6">Upgrade to <strong style="color:#6381fa">${nextTier}</strong> (${nextPrice}/mo) and get access to <strong style="color:#ffffff">${nextLimit}</strong>:</p>

    <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:16px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${isBasicPlan ? `
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Analyze 10 properties per month</strong> (vs. 1 on Basic)</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">CSV import & export</strong> for your data</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Dark mode</strong> & 8 color themes</td></tr>
        ` : `
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Analyze unlimited properties</strong> — no monthly cap</td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Negotiation Forecasting Tools</strong></td></tr>
          <tr><td style="padding:3px 0;font-size:14px;color:#c8cbd6"><span style="color:#34d399;margin-right:8px">✓</span><strong style="color:#ffffff">Priority feature requests</strong></td></tr>
        `}
      </table>
    </div>
    <p style="text-align:center">
      <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Upgrade Now</a>
    </p>

    <div style="height:1px;background:#252a3d;margin:24px 0"></div>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
  `, unsubscribeUrl);
}


// Upgrade confirmation email — sent when user upgrades from one plan to another
function upgradeConfirmationEmailHtml(displayName, newTier, previousTier) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  const tierDisplay = newTier.charAt(0).toUpperCase() + newTier.slice(1);
  const features = PLAN_FEATURES[tierDisplay] || PLAN_FEATURES.Basic;
  const priceMap = { Basic: "$9.99", Standard: "$19.99", Pro: "$29.99" };
  const price = priceMap[tierDisplay] || "$9.99";

  let introText = "";
  if (!previousTier || previousTier === "none") {
    introText = `You've signed up for <strong style="color:#6381fa">${tierDisplay}</strong> — great decision! Here's everything you now have access to:`;
  } else {
    const prevDisplay = previousTier.charAt(0).toUpperCase() + previousTier.slice(1);
    introText = `You've upgraded from ${prevDisplay} to <strong style="color:#6381fa">${tierDisplay}</strong> — nice move! Here's everything included in your new plan:`;
  }

  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Welcome to ${tierDisplay}, ${name}! 🎉</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">${introText}</p>

    <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">${tierDisplay} Plan — ${price}/mo</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${buildFeatureList(features)}
      </table>
    </div>

    <p style="margin:0 0 14px;color:#c8cbd6">Your new features are available right now. Head to the app to start using them:</p>
    <p style="text-align:center">
      <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Open RentingRadar</a>
    </p>

    <div style="height:1px;background:#252a3d;margin:24px 0"></div>

    <p style="margin:0 0 14px;color:#c8cbd6">You can manage your subscription anytime from <a href="${APP_URL}#settings" style="color:#6381fa;text-decoration:none">Settings → Billing</a>.</p>
    <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
  `);
}


// ============================================================
// TRIAL REMINDER EMAIL TEMPLATES
// ============================================================

function trialReminderEmailHtml(displayName, daysLeft, tierName, unsubscribeUrl) {
  const name = displayName ? displayName.split(" ")[0] : "there";
  const tierDisplay = tierName ? tierName.charAt(0).toUpperCase() + tierName.slice(1) : "your";

  if (daysLeft === 4) {
    // Day 3 email — halfway through trial
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
    `, unsubscribeUrl) };
  }

  if (daysLeft === 2) {
    // Day 5 email — 2 days left
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
    `, unsubscribeUrl) };
  }

  if (daysLeft === 0) {
    // Day 7 email — trial ends today
    return { subject: `🔒 Your ${tierDisplay} trial has ended`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Your trial has ended, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your 7-day ${tierDisplay} free trial has expired. As of today, <strong style="color:#ffffff">your access to RentingRadar has been paused</strong>.</p>
      <p style="margin:0 0 14px;color:#c8cbd6">This means you can no longer log in, view your properties, run analyses, or access any features in the app.</p>
      <p style="margin:0 0 14px;color:#c8cbd6"><strong style="color:#34d399">Your data is safe.</strong> All your properties, pipeline data, expenses, and analyses are preserved. Subscribe to any plan to instantly restore full access to everything.</p>

      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Choose a Plan</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo · 1 analysis/month</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo · 10 analyses/month</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo · Unlimited analyses</td></tr>
        </table>
      </div>

      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe & Restore Access</a>
      </p>

      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `, unsubscribeUrl) };
  }

  if (daysLeft === -7) {
    // 1 week after expiration
    return { subject: `Your RentingRadar data is waiting for you`, html: emailWrapper(`
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">It's been a week, ${name}</h2>
      <p style="margin:0 0 14px;color:#c8cbd6">Your RentingRadar trial ended a week ago, and your account is currently locked. You're missing out on tracking and analyzing rental deals.</p>
      <p style="margin:0 0 14px;color:#c8cbd6"><strong style="color:#34d399">Your data is still here.</strong> Every property, analysis, and pipeline entry you created during your trial is saved and waiting for you. Subscribe to pick up right where you left off.</p>

      <div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#6381fa;text-transform:uppercase;letter-spacing:.5px">Plans start at $9.99/mo</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Basic</strong> — $9.99/mo · 1 analysis/month</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Standard</strong> — $19.99/mo · 10 analyses/month</td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#c8cbd6"><strong style="color:#ffffff">Pro</strong> — $29.99/mo · Unlimited analyses</td></tr>
        </table>
      </div>

      <p style="text-align:center">
        <a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;margin:8px 0 16px">Subscribe & Restore Access</a>
      </p>

      <div style="height:1px;background:#252a3d;margin:24px 0"></div>
      <p style="font-size:13px;color:#6b7280;margin:0"><strong style="color:#9298ad">Questions?</strong> Reply to this email or reach us at <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
    `, unsubscribeUrl) };
  }

  if (daysLeft === -30) {
    // 1 month after expiration — final email
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
    `, unsubscribeUrl) };
  }

  return null;
}


// ============================================================
// EMAIL HELPER: Check preferences before sending marketing email
// ============================================================
async function canSendMarketingEmail(uid) {
  try {
    const prefsDoc = await db.collection("emailPreferences").doc(uid).get();
    if (!prefsDoc.exists) return true; // Default: opted in
    const prefs = prefsDoc.data();
    return prefs.marketingEmails !== false;
  } catch (err) {
    console.error("Error checking email prefs:", err);
    return false; // Fail closed — don't send if we can't check
  }
}

async function canSendProductEmails(uid) {
  try {
    const prefsDoc = await db.collection("emailPreferences").doc(uid).get();
    if (!prefsDoc.exists) return true;
    const prefs = prefsDoc.data();
    return prefs.productEmails !== false;
  } catch (err) {
    console.error("Error checking email prefs:", err);
    return false;
  }
}

// Helper: generate unsubscribe token for a user
function generateUnsubToken(uid, email) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(uid + (email || "")).digest("hex").substring(0, 16);
}

// Helper: build unsubscribe URL
function getUnsubscribeUrl(uid, email, type) {
  const token = generateUnsubToken(uid, email);
  return `${APP_URL}/api/unsubscribe?uid=${encodeURIComponent(uid)}&type=${encodeURIComponent(type || "marketing")}&token=${token}`;
}

// Helper: send an email via SendGrid with error handling
// Includes List-Unsubscribe header for CAN-SPAM / Gmail compliance
async function sendEmail(to, subject, htmlContent, options) {
  initSendGrid();
  const opts = options || {};
  const msg = {
    to: to,
    from: FROM_EMAIL,
    subject: subject,
    html: htmlContent,
  };

  // Add List-Unsubscribe header for marketing emails (CAN-SPAM + Gmail/Yahoo requirement)
  if (opts.unsubscribeUrl) {
    msg.headers = {
      "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  // SendGrid category for analytics
  if (opts.category) {
    msg.categories = [opts.category];
  }

  try {
    await sgMail.send(msg);
    console.log(`Email sent to ${to}: "${subject}"`);
    return true;
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err?.response?.body || err.message);
    return false;
  }
}


// ============================================================
// TEST EMAIL — call this directly to debug SendGrid
// ============================================================
exports.testEmail = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const envKey = process.env.SENDGRID_API_KEY;
    console.log("SENDGRID_API_KEY exists:", !!envKey);
    console.log("SENDGRID_API_KEY starts with:", envKey ? envKey.substring(0, 5) : "UNDEFINED");

    if (!envKey) {
      res.status(500).json({ error: "SENDGRID_API_KEY not found in environment" });
      return;
    }

    try {
      initSendGrid();
      const testHtml = welcomeEmailHtml("Test");
      await sgMail.send({
        to: "sabrina@summitcapllc.com",
        from: FROM_EMAIL,
        subject: "RentingRadar Test Email",
        html: testHtml,
      });
      console.log("Test email sent successfully!");
      res.status(200).json({ success: true, message: "Test email sent to sabrina@summitcapllc.com" });
    } catch (err) {
      console.error("Test email failed:", err?.response?.body || err.message);
      res.status(500).json({ error: err?.response?.body || err.message });
    }
  });
});


// ============================================================
// 4b. TEST ADMIN NEW-USER NOTIFICATION
// ============================================================
exports.testAdminNotification = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (!process.env.SENDGRID_API_KEY) {
      return res.status(500).json({ error: "SENDGRID_API_KEY not found" });
    }
    try {
      initSendGrid();
      const testEmail = "testuser@example.com";
      const testName = "Jane Doe";
      const signupTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
      const adminNotifHtml = emailWrapper(`
        <h2 style="color:#a855f7;margin:0 0 16px">New User Signup</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Name</td>
            <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${testName}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td>
            <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><a href="mailto:${testEmail}" style="color:#818cf8">${testEmail}</a></td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Method</td>
            <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">google.com</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#94a3b8">Signed Up</td>
            <td style="padding:8px 12px;color:#f1f5f9">${signupTime} ET</td>
          </tr>
        </table>
        <div style="margin-top:20px">
          <a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border-radius:8px;text-decoration:none;font-weight:600">View in Admin Panel</a>
        </div>
      `);
      await sendEmail(ADMIN_EMAIL, `New Signup: ${testEmail}`, adminNotifHtml, { category: "admin-new-user" });
      res.status(200).json({ success: true, message: "Test admin notification sent to help@rentingradar.com" });
    } catch (err) {
      console.error("Test admin notification failed:", err?.response?.body || err.message);
      res.status(500).json({ error: err?.response?.body || err.message });
    }
  });
});

// ============================================================
// 4c. TEST ALL EMAILS — fires one of every email type so the user can verify
//     every send path independently. Each send is logged with pass/fail in the
//     response so it's obvious if any specific template is broken.
//     Query params:
//       ?to=email@address.com   (recipient for user-facing emails; defaults to sabrina@summitcapllc.com)
//       ?only=type1,type2       (optional: comma-separated subset to send)
//     Admin notifications always go to ADMIN_EMAIL.
// ============================================================
exports.testAllEmails = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (!process.env.SENDGRID_API_KEY) {
      return res.status(500).json({ error: "SENDGRID_API_KEY not found in environment" });
    }
    initSendGrid();

    const recipient = (req.query.to || "sabrina@summitcapllc.com").toString().trim();
    const onlyFilter = (req.query.only || "").toString().split(",").map(s => s.trim()).filter(Boolean);
    const wantAll = onlyFilter.length === 0;
    const results = {};

    async function tryType(name, target, sendFn) {
      if (!wantAll && onlyFilter.indexOf(name) === -1) return;
      try {
        const ok = await sendFn();
        results[name] = { recipient: target, status: ok ? "✓ sent" : "✗ rejected by SendGrid (see Cloud Logs)" };
      } catch (err) {
        results[name] = { recipient: target, status: "✗ error: " + (err && err.message ? err.message : String(err)) };
      }
    }

    // ─── User-facing emails (go to `recipient`) ───
    await tryType("welcome", recipient, async () => {
      const html = welcomeEmailHtml("Test User");
      return await sendEmail(recipient, "[TEST] 🎉 Welcome to RentingRadar!", html, { category: "test-welcome" });
    });

    await tryType("trial-reminder-day3", recipient, async () => {
      const e = trialReminderEmailHtml("Test User", 4, "standard", APP_URL + "/unsubscribe?token=test");
      return await sendEmail(recipient, "[TEST] " + e.subject, e.html, { category: "test-trial-reminder", unsubscribeUrl: APP_URL + "/unsubscribe?token=test" });
    });

    await tryType("trial-reminder-day5", recipient, async () => {
      const e = trialReminderEmailHtml("Test User", 2, "standard", APP_URL + "/unsubscribe?token=test");
      return await sendEmail(recipient, "[TEST] " + e.subject, e.html, { category: "test-trial-reminder", unsubscribeUrl: APP_URL + "/unsubscribe?token=test" });
    });

    await tryType("trial-reminder-day7", recipient, async () => {
      const e = trialReminderEmailHtml("Test User", 0, "standard", APP_URL + "/unsubscribe?token=test");
      return await sendEmail(recipient, "[TEST] " + e.subject, e.html, { category: "test-trial-reminder", unsubscribeUrl: APP_URL + "/unsubscribe?token=test" });
    });

    await tryType("cancellation", recipient, async () => {
      const html = cancellationEmailHtml("Test User");
      return await sendEmail(recipient, "[TEST] 👋 Your RentingRadar account has been cancelled", html, { category: "test-cancellation" });
    });

    await tryType("upgrade-confirmation", recipient, async () => {
      const html = emailWrapper(`
        <h2 style="margin:0 0 16px;font-size:20px;color:#ffffff">🎉 Welcome to Standard!</h2>
        <p style="margin:0 0 14px;color:#c8cbd6">[TEST] Your upgrade to the Standard plan is confirmed. You now have 10 analyses per month and unlimited property tracking.</p>
        <p style="text-align:center"><a href="${APP_URL}" style="display:inline-block;background:#6381fa;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">Open RentingRadar</a></p>
      `);
      return await sendEmail(recipient, "[TEST] 🎉 Welcome to Standard! Your upgrade is confirmed", html, { category: "test-upgrade-confirmation" });
    });

    await tryType("analysis-limit", recipient, async () => {
      const html = emailWrapper(`
        <h2 style="margin:0 0 16px;font-size:20px;color:#ffffff">[TEST] You've reached your analysis limit</h2>
        <p style="margin:0 0 14px;color:#c8cbd6">You've used all 10 of your monthly analyses on the Standard plan. Upgrade to Pro for unlimited analyses.</p>
      `);
      return await sendEmail(recipient, "[TEST] You've reached your analysis limit", html, { category: "test-analysis-limit" });
    });

    await tryType("upgrade-nudge", recipient, async () => {
      const html = emailWrapper(`
        <h2 style="margin:0 0 16px;font-size:20px;color:#ffffff">[TEST] You're using RentingRadar like a pro</h2>
        <p style="margin:0 0 14px;color:#c8cbd6">Considering an upgrade? Pro gives you unlimited analyses for $29.99/month.</p>
      `);
      return await sendEmail(recipient, "[TEST] You're using RentingRadar like a pro", html, { category: "test-upgrade-nudge", unsubscribeUrl: APP_URL + "/unsubscribe?token=test" });
    });

    // ─── Admin-facing emails (always go to ADMIN_EMAIL) ───
    await tryType("admin-signup", ADMIN_EMAIL, async () => {
      const html = emailWrapper(`
        <h2 style="color:#a855f7;margin:0 0 16px">[TEST] New User Signup</h2>
        <p style="color:#c8cbd6">A new user signed up: <strong>testuser@example.com</strong></p>
        <p style="color:#94a3b8;font-size:13px">This is a test of the admin-signup notification path.</p>
      `);
      return await sendEmail(ADMIN_EMAIL, "[TEST] New Signup: testuser@example.com", html, { category: "test-admin-signup" });
    });

    await tryType("admin-plan-change", ADMIN_EMAIL, async () => {
      const html = emailWrapper(`
        <h2 style="color:#a855f7;margin:0 0 16px">[TEST] Upgrade: Basic → Standard</h2>
        <p style="color:#c8cbd6">User <strong>testuser@example.com</strong> upgraded from Basic to Standard.</p>
        <p style="color:#94a3b8;font-size:13px">This is a test of the admin plan-change notification path.</p>
      `);
      return await sendEmail(ADMIN_EMAIL, "[TEST][Upgrade] testuser@example.com", html, { category: "test-admin-plan-change" });
    });

    await tryType("admin-deletion", ADMIN_EMAIL, async () => {
      const html = emailWrapper(`
        <h2 style="color:#ef4444;margin:0 0 16px">[TEST] Account Deleted</h2>
        <p style="color:#c8cbd6">User <strong>testuser@example.com</strong> deleted their account.</p>
        <p style="color:#94a3b8;font-size:13px">This is a test of the admin account-deletion notification path.</p>
      `);
      return await sendEmail(ADMIN_EMAIL, "[TEST][Account Deleted] testuser@example.com", html, { category: "test-admin-deletion" });
    });

    res.status(200).json({
      sender: FROM_EMAIL.email,
      userRecipient: recipient,
      adminRecipient: ADMIN_EMAIL,
      count: Object.keys(results).length,
      results: results,
      note: "Check both inboxes for [TEST]-prefixed emails. Any '✗' entry means SendGrid rejected — check Cloud Logs for the SendGrid error body."
    });
  });
});


// ============================================================
// 5. WELCOME EMAIL — triggered on new user creation
//    Sends welcome email immediately for all users (Google & email/password).
// ============================================================
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  const { uid, email, displayName } = user;
  console.log(`onUserCreated triggered for ${uid} / ${email}`);
  if (!email) return null;

  // Send welcome email immediately for all users.
  // sendEmail() catches its own errors and returns boolean — DON'T claim success
  // unless it actually returned true. Without this check, logs lie and the real
  // SendGrid error gets buried (a recent debugging cost us hours of confusion).
  try {
    initSendGrid();
    const html = welcomeEmailHtml(displayName);
    console.log("Sending welcome email to", email);
    const ok = await sendEmail(email, "🎉 Welcome to RentingRadar! Here's how to get started", html, { category: "welcome" });
    if (ok) console.log("Welcome email sent successfully to", email);
    else console.error("Welcome email FAILED for", email, "— see SendGrid error above");
  } catch (err) {
    console.error("Failed to send welcome email:", err);
  }

  // Notify admin(s) about new signup
  try {
    const signupMethod = user.providerData && user.providerData.length
      ? user.providerData.map(p => p.providerId).join(", ")
      : "unknown";
    const signupTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    const adminNotifHtml = emailWrapper(`
      <h2 style="color:#a855f7;margin:0 0 16px">New User Signup</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Name</td>
          <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${displayName || "—"}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td>
          <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><a href="mailto:${email}" style="color:#818cf8">${email}</a></td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Method</td>
          <td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${signupMethod}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;color:#94a3b8">Signed Up</td>
          <td style="padding:8px 12px;color:#f1f5f9">${signupTime} ET</td>
        </tr>
      </table>
      <div style="margin-top:20px">
        <a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border-radius:8px;text-decoration:none;font-weight:600">View in Admin Panel</a>
      </div>
    `);
    const adminEmails = [ADMIN_EMAIL];
    let anyOk = false;
    for (const adminEmail of adminEmails) {
      const ok = await sendEmail(adminEmail, `New Signup: ${email}`, adminNotifHtml, { category: "admin-new-user" });
      if (ok) anyOk = true;
    }
    if (anyOk) console.log("Admin notification sent for new user:", email);
    else console.error("Admin notification FAILED for new user:", email, "— see SendGrid error above");
  } catch (err) {
    console.error("Failed to send admin notification:", err);
  }

  try {
    await db.collection("emailLog").add({
      uid: uid,
      email: email,
      type: "welcome",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to log email:", err);
  }

  // Set up email preferences
  try {
    await db.collection("emailPreferences").doc(uid).set({
      email: email,
      marketingEmails: true,
      productEmails: true,
      weeklyDigest: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("Email prefs created for", uid);
  } catch (err) {
    console.error("Failed to create email prefs:", err);
  }

  return null;
});


// ============================================================
// 5b. PLAN CHANGE NOTIFICATION — Firestore onUpdate trigger that
//     catches every tier/subscriptionStatus change regardless of
//     source (Stripe webhook, manual admin override, sync, etc.).
//     Emails the admin so all plan movement is observable in one inbox.
// ============================================================
exports.onUserPlanChanged = functions.firestore
  .document("users/{uid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const beforeTier = before.tier || null;
    const afterTier = after.tier || null;
    const beforeStatus = before.subscriptionStatus || null;
    const afterStatus = after.subscriptionStatus || null;
    const tierChanged = beforeTier !== afterTier;
    const statusChanged = beforeStatus !== afterStatus;
    if (!tierChanged && !statusChanged) return null;

    // Notify admin for events that are actionable or worth tracking:
    //   (a) a new subscription activated (user went from no tier to a tier with
    //       trialing/active status — this is the "first revenue" signal)
    //   (b) an active subscriber's tier actually changed (upgrade/downgrade)
    //   (c) an active subscriber cancelled
    // Trial-to-active conversions and other status drift are suppressed.
    const wasActive = beforeStatus === "active" && !!beforeTier;
    const becameCancelled = (afterStatus === "cancelled" || afterStatus === "canceled");
    const realTierChange = tierChanged && !!beforeTier && !!afterTier && beforeTier !== afterTier;
    const isActiveTierChange = wasActive && realTierChange;
    const isCancellation = wasActive && becameCancelled;
    const isNewSubscription = !beforeTier && !!afterTier && (afterStatus === "trialing" || afterStatus === "active");
    if (!isActiveTierChange && !isCancellation && !isNewSubscription) return null;

    const uid = context.params.uid;
    const email = after.email || before.email || "";
    const name = after.name || before.name || "";

    // Categorize the change so the subject + headline read at a glance
    const tierRank = { basic: 1, standard: 2, pro: 3, admin: 99 };
    let direction;
    if (tierChanged) {
      const beforeRank = tierRank[beforeTier] || 0;
      const afterRank = tierRank[afterTier] || 0;
      if (!beforeTier && afterTier) direction = "New Subscription";
      else if (beforeTier && !afterTier) direction = "Plan Cleared";
      else if (afterRank > beforeRank) direction = "Upgrade";
      else if (afterRank < beforeRank) direction = "Downgrade";
      else direction = "Tier Change";
    } else if (statusChanged) {
      if (afterStatus === "active" && beforeStatus !== "active") direction = "Activated";
      else if (afterStatus === "cancelled" || afterStatus === "canceled") direction = "Cancelled";
      else if (afterStatus === "past_due") direction = "Payment Failed";
      else if (afterStatus === "expired") direction = "Expired";
      else direction = "Status Change";
    }

    const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");
    const niceTier = (t) => (t ? cap(t) : "None");
    const niceStatus = (s) => (s ? cap(String(s).replace(/_/g, " ")) : "None");
    const changeTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    const sourceLabel = after.manualOverride && !before.manualOverride
      ? "Manual admin override"
      : after.stripeSubscriptionId
      ? "Stripe"
      : "Automatic";

    try {
      initSendGrid();
      // Common rows
      const tierRow = tierChanged
        ? `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Tier</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${niceTier(beforeTier)} &rarr; <strong>${niceTier(afterTier)}</strong></td></tr>`
        : "";
      const statusRow = statusChanged
        ? `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Status</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${niceStatus(beforeStatus)} &rarr; <strong>${niceStatus(afterStatus)}</strong></td></tr>`
        : "";
      const stripeRow = after.stripeSubscriptionId
        ? `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Stripe Sub</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155;font-family:monospace;font-size:12px">${after.stripeSubscriptionId}</td></tr>`
        : "";

      // New-subscription emails get a distinct, prominent treatment so they're easy
      // to spot in the inbox and don't read identically to the New Signup email.
      // Plan (Basic/Standard/Pro + Monthly/Yearly) + checkout code are highlighted.
      let html, subject;
      if (isNewSubscription) {
        const planLabel = niceTier(afterTier);
        const intervalRaw = after.billingInterval || "";
        const intervalLabel = intervalRaw === "year" ? "Yearly" : intervalRaw === "month" ? "Monthly" : "";
        const planLine = intervalLabel ? `${planLabel} (${intervalLabel})` : planLabel;
        const discount = (after.discountCode || "").toString().trim();
        const trialEndsRow = after.trialEnd
          ? `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Trial Ends</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${new Date(after.trialEnd).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET</td></tr>`
          : "";
        const discountRow = discount
          ? `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Code Used</td><td style="padding:8px 12px;color:#10b981;border-bottom:1px solid #334155;font-family:monospace;font-weight:700">${discount}</td></tr>`
          : `<tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Code Used</td><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155;font-style:italic">none</td></tr>`;
        html = emailWrapper(`
          <h2 style="color:#10b981;margin:0 0 20px">New User Subscription Activated</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Plan</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><strong>${planLine}</strong></td></tr>
            ${discountRow}
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">User</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${name || "—"}</td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><a href="mailto:${email}" style="color:#818cf8">${email}</a></td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Status</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${niceStatus(afterStatus)}</td></tr>
            ${trialEndsRow}
            ${stripeRow}
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">UID</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155;font-family:monospace;font-size:12px">${uid}</td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8">When</td><td style="padding:8px 12px;color:#f1f5f9">${changeTime} ET</td></tr>
          </table>
          <div style="margin-top:20px">
            <a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open Admin Panel</a>
          </div>
        `);
        subject = "New User Subscription Activated";
      } else {
        html = emailWrapper(`
          <h2 style="color:#a855f7;margin:0 0 16px">${direction}: ${niceTier(beforeTier)} &rarr; ${niceTier(afterTier)}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">User</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${name || "—"}</td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><a href="mailto:${email}" style="color:#818cf8">${email}</a></td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">UID</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155;font-family:monospace;font-size:12px">${uid}</td></tr>
            ${tierRow}
            ${statusRow}
            ${stripeRow}
            <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Source</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${sourceLabel}</td></tr>
            <tr><td style="padding:8px 12px;color:#94a3b8">When</td><td style="padding:8px 12px;color:#f1f5f9">${changeTime} ET</td></tr>
          </table>
          <div style="margin-top:20px">
            <a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open Admin Panel</a>
          </div>
        `);
        subject = `[${direction}] ${email || name || uid}`;
      }
      // sendEmail catches internally and returns boolean — only log success on real success
      const ok = await sendEmail(ADMIN_EMAIL, subject, html, { category: "admin-plan-change" });
      if (ok) console.log("Plan change notification sent:", uid, direction, beforeTier, "->", afterTier, "|", beforeStatus, "->", afterStatus);
      else console.error("Plan change notification FAILED for", uid, "— see SendGrid error above");
    } catch (err) {
      console.error("Failed to send plan change notification:", err);
    }
    return null;
  });


// ============================================================
// 5c. WELCOME EMAIL — HTTP endpoint called by frontend
//     when user first reaches the dashboard (after user doc creation).
//     Served via Firebase Hosting rewrite (no allUsers IAM needed).
// ============================================================
exports.sendWelcomeEmail = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Verify Firebase Auth token from Authorization header
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(match[1]);
    } catch (err) {
      console.error("Token verification failed:", err);
      return res.status(401).json({ error: "Invalid token" });
    }

    const uid = decoded.uid;
    console.log(`sendWelcomeEmail HTTP called for uid=${uid}`);

    // Get full auth user to check emailVerified
    let authUser;
    try {
      authUser = await admin.auth().getUser(uid);
    } catch (err) {
      console.error("Failed to get auth user:", err);
      return res.status(500).json({ error: "Failed to get user" });
    }

    if (!authUser.emailVerified) {
      console.log(`User ${uid} email not verified, skipping.`);
      return res.status(400).json({ error: "Email not verified" });
    }

    // Check for duplicate welcome email
    const existingLog = await db.collection("emailLog")
      .where("uid", "==", uid)
      .where("type", "==", "welcome")
      .limit(1)
      .get();

    if (!existingLog.empty) {
      console.log(`Welcome email already sent to ${uid}, skipping.`);
      return res.status(200).json({ ok: true, message: "Already sent" });
    }

    // Send the welcome email
    const email = authUser.email;
    const displayName = authUser.displayName;
    try {
      initSendGrid();
      const html = welcomeEmailHtml(displayName);
      console.log("Sending post-verification welcome email to", email);
      await sendEmail(email, "🎉 Welcome to RentingRadar! Here's how to get started", html, { category: "welcome" });
      console.log("Post-verification welcome email sent successfully to", email);
    } catch (err) {
      console.error("Failed to send welcome email:", err);
      return res.status(500).json({ error: "Failed to send email" });
    }

    // Log it
    try {
      await db.collection("emailLog").add({
        uid: uid,
        email: email,
        type: "welcome",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to log welcome email:", err);
    }

    return res.status(200).json({ ok: true });
  });
});


// ============================================================
// 6. CANCELLATION EMAIL — triggered on user deletion
// ============================================================
exports.onUserDeleted = functions.auth.user().onDelete(async (user) => {
  const { uid, email, displayName } = user;
  console.log("onUserDeleted triggered for", uid, "/", email);
  if (!email) return null;

  // Send "goodbye" email to the user — honest logging, no fake success.
  try {
    initSendGrid();
    const html = cancellationEmailHtml(displayName);
    console.log("Sending cancellation email to", email);
    const ok = await sendEmail(email, "👋 Your RentingRadar account has been cancelled", html, { category: "cancellation" });
    if (ok) console.log("Cancellation email sent successfully to", email);
    else console.error("Cancellation email FAILED for", email, "— see SendGrid error above");
  } catch (err) {
    console.error("Failed to send cancellation email:", err);
  }

  // Notify admin so deletions are visible in one inbox — same format as onUserCreated.
  try {
    initSendGrid();
    const deletedTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
    const adminHtml = emailWrapper(`
      <h2 style="color:#ef4444;margin:0 0 16px">Account Deleted</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Name</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${displayName || "—"}</td></tr>
        <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">${email}</td></tr>
        <tr><td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">UID</td><td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155;font-family:monospace;font-size:12px">${uid}</td></tr>
        <tr><td style="padding:8px 12px;color:#94a3b8">Deleted</td><td style="padding:8px 12px;color:#f1f5f9">${deletedTime} ET</td></tr>
      </table>
    `);
    const ok = await sendEmail(ADMIN_EMAIL, `[Account Deleted] ${email}`, adminHtml, { category: "admin-account-deleted" });
    if (ok) console.log("Admin deletion notification sent for", email);
    else console.error("Admin deletion notification FAILED for", email, "— see SendGrid error above");
  } catch (err) {
    console.error("Failed to send admin deletion notification:", err);
  }

  // Clean up email preferences
  try {
    await db.collection("emailPreferences").doc(uid).delete();
  } catch (err) {
    console.error("Failed to delete email prefs:", err);
  }

  // Log the email send
  try {
    await db.collection("emailLog").add({
      uid: uid,
      email: email,
      type: "cancellation",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to log email:", err);
  }

  return null;
});


// ============================================================
// 7. MONTHLY UPGRADE NUDGE — runs every Monday at 10 AM EST,
//    but only sends emails once per month (every 4th week)
// ============================================================
exports.weeklyUpgradeNudge = functions.pubsub
  .schedule("every monday 10:00")
  .timeZone("America/New_York")
  .onRun(async (context) => {
    // DISABLED — Stripe handles all billing-related emails now (trial-ending, charge
    // success, charge failure, dunning) via Customer email settings. Keeping the code
    // intact in case we want to re-enable retargeting for cancelled users later. To
    // re-enable, remove this early return.
    console.log("weeklyUpgradeNudge skipped — Stripe handles billing emails now.");
    return null;
    // Calculate week number — only send every 4th week (monthly)
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    if (weekNumber % 4 !== 0) {
      console.log("Skipping upgrade nudge — not a monthly send week. Next send in " + (4 - (weekNumber % 4)) + " week(s).");
      return null;
    }

    console.log("Running monthly upgrade nudge...");

    // Query basic-tier AND standard-tier users (both get upgrade nudges)
    const basicSnapshot = await db.collection("users").where("tier", "==", "basic").get();
    const standardSnapshot = await db.collection("users").where("tier", "==", "standard").get();

    const allUsers = [...basicSnapshot.docs, ...standardSnapshot.docs];

    if (allUsers.length === 0) {
      console.log("No basic or standard tier users found.");
      return null;
    }

    let sent = 0;
    let skipped = 0;

    const batch = [];

    for (const userDoc of allUsers) {
      const userData = userDoc.data();
      const uid = userDoc.id;
      const email = userData.email;
      const displayName = userData.displayName || userData.name;
      const userTier = userData.tier || "basic";

      if (!email) { skipped++; continue; }

      // Check if user has opted out of marketing emails
      const canSend = await canSendMarketingEmail(uid);
      if (!canSend) { skipped++; continue; }

      // Check if we sent an upgrade email to this user in the last 27 days (prevent duplicates)
      try {
        const recentEmail = await db.collection("emailLog")
          .where("uid", "==", uid)
          .where("type", "==", "upgrade_nudge")
          .where("sentAt", ">", new Date(Date.now() - 27 * 24 * 60 * 60 * 1000))
          .limit(1)
          .get();
        if (!recentEmail.empty) { skipped++; continue; }
      } catch (err) {
        console.warn("Could not check recent emails for", uid, err);
      }

      const unsubUrl = getUnsubscribeUrl(uid, email, "marketing");

      // Use the appropriate nudge template based on user's current tier
      let subject, html;
      if (userTier === "standard") {
        ({ subject, html } = standardUpgradeNudgeEmailHtml(displayName, weekNumber, unsubUrl));
      } else {
        ({ subject, html } = upgradeNudgeEmailHtml(displayName, weekNumber, unsubUrl));
      }

      const success = await sendEmail(email, subject, html, { unsubscribeUrl: unsubUrl, category: "upgrade_nudge" });

      if (success) {
        sent++;
        batch.push(db.collection("emailLog").add({
          uid: uid,
          email: email,
          type: "upgrade_nudge",
          subject: subject,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        }));
      }
    }

    // Write all log entries
    await Promise.all(batch);

    console.log(`Monthly nudge complete: ${sent} sent, ${skipped} skipped.`);
    return null;
  });


// ============================================================
// 8. TRIAL REMINDER EMAILS — runs daily at 9 AM EST
//    Sends reminders at day 3, day 5, day 7 (expiration),
//    1 week after expiration, and 1 month after expiration.
//    Skips users who have converted to a paid subscription.
// ============================================================
exports.dailyTrialReminders = functions.pubsub
  .schedule("every day 09:00")
  .timeZone("America/New_York")
  .onRun(async (context) => {
    // DISABLED — Stripe owns trial state now and sends its own trial-ending email
    // ~3 days before charge. Keeping the code intact in case we want to re-add a
    // branded RentingRadar trial-end email via Stripe webhook later. To re-enable,
    // remove this early return.
    console.log("dailyTrialReminders skipped — Stripe handles trial-ending emails now.");
    return null;
    console.log("Running daily trial reminders...");

    const now = Date.now();

    // Trial reminder checkpoints, ordered most-recent-in-time first.
    // Resilient matching: on each run we pick the latest checkpoint the user has reached
    // and that has not been sent yet, so a missed day (deploy gap, scheduler hiccup)
    // still results in the correct email going out the next time the function runs.
    const checkpoints = [
      { daysFromEnd: -30, label: "month_after" },       // 1 month after expiration
      { daysFromEnd: -7,  label: "week_after" },        // 1 week after expiration
      { daysFromEnd:  0,  label: "day7_expired" },      // Trial ends today
      { daysFromEnd:  2,  label: "day5_2days" },        // 2 days left
      { daysFromEnd:  4,  label: "day3_halfway" },      // 4 days left (halfway)
    ];

    // Query all users with a trialEnd set (these are trial users)
    const trialUsersSnapshot = await db.collection("users")
      .where("trialEnd", "!=", null)
      .get();

    if (trialUsersSnapshot.empty) {
      console.log("No trial users found.");
      return null;
    }

    let sent = 0;
    let skipped = 0;
    const logBatch = [];

    for (const userDoc of trialUsersSnapshot.docs) {
      const userData = userDoc.data();
      const uid = userDoc.id;
      const email = userData.email;
      const displayName = userData.displayName || userData.name;
      const trialEnd = userData.trialEnd;
      const subscriptionStatus = userData.subscriptionStatus;
      const tier = userData.tier;

      if (!email || !trialEnd) { skipped++; continue; }

      // Skip users who have converted to a paid plan (active subscription)
      if (subscriptionStatus === "active" && tier) {
        skipped++;
        continue;
      }

      // Calculate days remaining from trial end
      const trialEndDate = new Date(trialEnd);
      const msPerDay = 24 * 60 * 60 * 1000;
      const daysLeft = Math.round((trialEndDate.getTime() - now) / msPerDay);

      // Find the latest checkpoint this user has reached that hasn't been sent yet.
      // checkpoints[] is ordered most-recent-in-time first. We walk it and pick the
      // first one where daysLeft <= cp.daysFromEnd (user has crossed it) AND that
      // specific reminder hasn't already been logged. Stop on the first hit so a
      // single missed day still triggers the right email next run.
      let matchedCheckpoint = null;
      try {
        for (const cp of checkpoints) {
          if (daysLeft > cp.daysFromEnd) continue; // not yet reached
          const existingEmail = await db.collection("emailLog")
            .where("uid", "==", uid)
            .where("type", "==", "trial_reminder_" + cp.label)
            .limit(1)
            .get();
          if (existingEmail.empty) {
            matchedCheckpoint = cp;
          }
          break; // user is at this checkpoint — either we send it now or it's already done
        }
      } catch (err) {
        console.warn("Could not check existing trial emails for", uid, err);
      }

      if (!matchedCheckpoint) { skipped++; continue; }

      // Check email preferences
      const canSend = await canSendProductEmails(uid);
      if (!canSend) { skipped++; continue; }

      const unsubUrl = getUnsubscribeUrl(uid, email, "product");
      const trialTier = tier || userData.trialTier || "basic";
      const emailData = trialReminderEmailHtml(displayName, matchedCheckpoint.daysFromEnd, trialTier, unsubUrl);

      if (!emailData) { skipped++; continue; }

      const success = await sendEmail(email, emailData.subject, emailData.html, {
        unsubscribeUrl: unsubUrl,
        category: "trial_reminder",
      });

      if (success) {
        sent++;
        logBatch.push(db.collection("emailLog").add({
          uid: uid,
          email: email,
          type: "trial_reminder_" + matchedCheckpoint.label,
          subject: emailData.subject,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        }));
      }
    }

    await Promise.all(logBatch);
    console.log(`Trial reminders complete: ${sent} sent, ${skipped} skipped.`);
    return null;
  });


// ============================================================
// 7c. NO-PLAN REMINDERS — nudges users who signed up but never picked a plan
//     (so they never started a trial, which means Stripe never emails them —
//     a gap the disabled dailyTrialReminders/weeklyUpgradeNudge don't cover).
//
//     Two-stage sequence, both at 6:30am Pacific:
//       Stage 1 — 2 business days after signup
//       Stage 2 — 7 business days after signup (5 business days after Stage 1)
//
//     Scope: FORWARD-LOOKING only. The automation ignores anyone who signed up
//     before AUTOMATION_START so it never retroactively blasts old accounts.
//     The two pre-existing prospects are handled as explicit ONE_OFF_REMINDERS
//     on fixed dates. Everything de-dupes via emailLog and honors productEmails
//     opt-out + unsubscribe, same as the trial reminders above.
// ============================================================

// Only signups at/after this instant are picked up by the signup-relative
// automation. Set to the deploy day (Pacific) so historical no-plan users are
// left to the one-off list below, not mass-emailed on first run.
const NO_PLAN_AUTOMATION_START = new Date("2026-07-09T00:00:00-07:00");

// Explicit one-off sends for the two existing no-plan prospects. Dates are
// Pacific calendar days (YYYY-MM-DD). Stage 1 this Friday, Stage 2 five
// business days later. These users are excluded from the automation below.
const NO_PLAN_ONE_OFFS = [
  { email: "g.ibragimova.gi@gmail.com", stage: 1, sendOn: "2026-07-10" },
  { email: "g.ibragimova.gi@gmail.com", stage: 2, sendOn: "2026-07-17" },
  { email: "akouvi87@gmail.com",        stage: 1, sendOn: "2026-07-10" },
  { email: "akouvi87@gmail.com",        stage: 2, sendOn: "2026-07-17" },
];
const NO_PLAN_ONE_OFF_EMAILS = new Set(NO_PLAN_ONE_OFFS.map(o => o.email.toLowerCase()));

// Pacific calendar date (YYYY-MM-DD) for a given Date — DST-safe.
function _pacificYmd(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// Business days (Mon–Fri) strictly after startYmd, up to and including endYmd.
// Note: does not skip US federal holidays — Mon–Fri only.
function _businessDaysBetween(startYmd, endYmd) {
  const d = new Date(startYmd + "T12:00:00Z");
  const end = new Date(endYmd + "T12:00:00Z");
  let count = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) count++;
  }
  return count;
}

// Normalize the various shapes createdAt can take (Admin Timestamp, plain
// {seconds}, ISO string, Date) into a JS Date, or null.
function _toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
  if (typeof v === "string") return new Date(v);
  if (v instanceof Date) return v;
  return null;
}

// True if the user has effectively picked/started a plan (so we should NOT nudge).
function _hasPlan(u) {
  if (u.stripeSubscriptionId) return true;
  const status = String(u.subscriptionStatus || "").toLowerCase();
  if (["active", "trialing", "past_due"].includes(status)) return true;
  const tier = String(u.tier || "").toLowerCase();
  if (tier && tier !== "none") return true; // basic/standard/pro/affiliate/admin
  return false;
}

// "Pick a plan" reminder email. stage 1 = gentle 2-day nudge, stage 2 = value
// follow-up. Returns { subject, html }. displayName → real first name.
function planReminderEmailHtml(displayName, stage, unsubscribeUrl) {
  const name = displayName ? String(displayName).split(" ")[0] : "there";
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

  if (stage === 2) {
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
      `, unsubscribeUrl),
    };
  }

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
    `, unsubscribeUrl),
  };
}

// Send one reminder stage to a user, with de-dupe (emailLog), prefs check, and
// unsubscribe. Returns true only if an email actually went out.
async function sendPlanReminder(uid, userData, stage) {
  const type = "no_plan_reminder_" + stage;
  const email = userData.email;
  if (!email) return false;

  const existing = await db.collection("emailLog")
    .where("uid", "==", uid).where("type", "==", type).limit(1).get();
  if (!existing.empty) return false; // already sent this stage

  if (!(await canSendProductEmails(uid))) return false;

  const unsubUrl = getUnsubscribeUrl(uid, email, "product");
  const emailData = planReminderEmailHtml(userData.displayName || userData.name, stage, unsubUrl);
  const ok = await sendEmail(email, emailData.subject, emailData.html, {
    unsubscribeUrl: unsubUrl,
    category: "plan_reminder",
  });
  if (!ok) return false;

  await db.collection("emailLog").add({
    uid: uid,
    email: email,
    type: type,
    subject: emailData.subject,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return true;
}

exports.noPlanReminders = functions.pubsub
  .schedule("30 6 * * 1-5")           // 6:30am, Mon–Fri
  .timeZone("America/Los_Angeles")     // 6:30 local Pacific (auto DST)
  .onRun(async (context) => {
    const todayPT = _pacificYmd(new Date());
    console.log(`Running noPlanReminders for Pacific date ${todayPT}...`);
    let sent = 0, skipped = 0;

    // --- 1) One-off scheduled sends for the two pre-existing prospects ---
    for (const oo of NO_PLAN_ONE_OFFS) {
      if (oo.sendOn !== todayPT) continue;
      try {
        const snap = await db.collection("users").where("email", "==", oo.email).limit(1).get();
        if (snap.empty) { console.warn(`One-off: user not found for ${oo.email}`); skipped++; continue; }
        const doc = snap.docs[0];
        const u = doc.data();
        if (_hasPlan(u)) { console.log(`One-off: ${oo.email} now has a plan — skipping stage ${oo.stage}`); skipped++; continue; }
        const did = await sendPlanReminder(doc.id, u, oo.stage);
        if (did) { sent++; console.log(`One-off: sent stage ${oo.stage} to ${oo.email}`); }
        else skipped++;
      } catch (err) {
        console.error(`One-off send failed for ${oo.email}:`, err);
        skipped++;
      }
    }

    // --- 2) Forward-looking automation for new signups (2 & 7 business days) ---
    const usersSnap = await db.collection("users").get();
    for (const doc of usersSnap.docs) {
      const u = doc.data();
      const uid = doc.id;
      if (!u.email) { continue; }
      if (NO_PLAN_ONE_OFF_EMAILS.has(String(u.email).toLowerCase())) continue; // handled above
      if (_hasPlan(u)) { continue; }

      const createdAt = _toDate(u.createdAt);
      if (!createdAt || createdAt < NO_PLAN_AUTOMATION_START) continue; // forward-looking only

      const elapsed = _businessDaysBetween(_pacificYmd(createdAt), todayPT);
      if (elapsed < 2) continue; // too early for stage 1

      try {
        const s1 = await db.collection("emailLog")
          .where("uid", "==", uid).where("type", "==", "no_plan_reminder_1").limit(1).get();
        if (s1.empty) {
          // Stage 1 not yet sent — send it now (elapsed >= 2)
          const did = await sendPlanReminder(uid, u, 1);
          if (did) { sent++; console.log(`Auto: sent stage 1 to ${u.email} (${elapsed} biz days)`); } else skipped++;
        } else if (elapsed >= 7) {
          // Stage 1 already sent and we're at/past the 7-business-day mark
          const did = await sendPlanReminder(uid, u, 2);
          if (did) { sent++; console.log(`Auto: sent stage 2 to ${u.email} (${elapsed} biz days)`); } else skipped++;
        }
      } catch (err) {
        console.error(`Auto reminder failed for ${u.email}:`, err);
        skipped++;
      }
    }

    console.log(`noPlanReminders complete: ${sent} sent, ${skipped} skipped.`);
    return null;
  });


// ============================================================
// 8b. MONTHLY COMMISSION REPORT — runs on the 1st of every month at 9 AM ET.
//     Pulls actual paid Stripe revenue from the previous month for each user
//     with a referredBy code, groups by referrer, applies the contract
//     formula (max($125 floor, $2/user) operating expense, 50% commission),
//     and emails a report to ADMIN_EMAIL.
//     This gives Owner the exact commission owed for the prior month based
//     on real settlement data (not the dashboard's face-value estimates).
// ============================================================
const _COMMISSION_PER_USER_EXPENSE = 3.00;
const _COMMISSION_RATE = 0.50;

// Shared helper. Generates and sends the commission report. Called by both:
//   (a) the scheduled cron trigger (monthly on the 1st), and
//   (b) the admin-only HTTP trigger `triggerCommissionReport` for mid-month re-sends + testing.
// Options:
//   targetAffiliateEmail — if set, ONLY the affiliate matching this email receives a
//                          statement. Use for testing a single affiliate's email format.
//   previewToAdmin        — with targetAffiliateEmail: send that affiliate's EXACT
//                          statement to ADMIN_EMAIL instead of the affiliate, with a
//                          "[PREVIEW for <email>]" subject. Lets the admin see precisely
//                          what the affiliate would receive before actually sending it.
//   skipAdmin             — skip the overall admin email (help@rentingradar.com).
//   skipAffiliates        — skip all per-affiliate statements.
//   No options            — full run: admin + every affiliate (same as cron behavior).

// Coerce a Firestore-serialized timestamp (Timestamp instance OR {seconds,nanoseconds}
// plain object) to millis. Returns 0 for falsy/unparseable input.
function _ts(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (typeof val.seconds === "number") return val.seconds * 1000;
  if (typeof val._seconds === "number") return val._seconds * 1000;
  // currentPeriodEnd / trialEnd are persisted as ISO strings by syncSubscription
  // (see new Date(...).toISOString() at line ~2363). Parse those too — otherwise
  // every trialing user fails the forecast cutoff and gets silently skipped.
  if (typeof val === "string") {
    const ms = Date.parse(val);
    return isNaN(ms) ? 0 : ms;
  }
  if (val instanceof Date) return val.getTime();
  return 0;
}

// Backend mirror of _affEstMonthlyRevenue in index.html. Computes a user's projected
// monthly revenue from cached Firestore fields — no Stripe API call required.
// Used for current-month MTD forecasts so the email matches the Referrals dashboard.
function _projectedMonthlyRevenue(u) {
  if (!u || u.manualOverride) return 0;
  if (u.subscriptionStatus !== "active" && u.subscriptionStatus !== "trialing") return 0;
  const tier = u.tier;
  const FACE = { basic: 9.99, standard: 19.99, pro: 29.99 };
  const YEARLY_FACE_MO = { basic: 89.99 / 12, standard: 199.99 / 12, pro: 200 / 12 };
  if (!tier || !FACE[tier]) return 0;

  // Determine billing interval. Prefer the actual subscription period span; fall back
  // to the suffix of the referral code (AIRPRENEURMONTHLY/AIRPRENEURYEARLY).
  let isYearly = false;
  const startMs = _ts(u.currentPeriodStart);
  const endMs = _ts(u.currentPeriodEnd);
  if (startMs && endMs && endMs > startMs) {
    isYearly = (endMs - startMs) / (24 * 60 * 60 * 1000) > 60;
  } else if (u.referredBy) {
    const up = String(u.referredBy).toUpperCase();
    isYearly = up.endsWith("YEARLY") || up.endsWith("YEAR") || up.endsWith("ANNUAL");
  }

  // Pro-tier referred users get the AIRPRENEUR discount: $20/mo monthly, $16.67/mo yearly.
  if (tier === "pro" && u.referredBy) {
    return isYearly ? 16.67 : 20.00;
  }
  return isYearly ? YEARLY_FACE_MO[tier] : FACE[tier];
}

// Dual-axis daily activity LINE chart for the commission emails — emulates the
// Chart.js line chart in the Financials → Affiliate section, but as an email-safe
// PNG rendered by QuickChart (Chart.js server-side). Purple line = sign-ups (left
// axis), green line = payments (right axis), x-axis = day of month. signupsByDay /
// paymentsByDay are objects keyed by day-of-month (1..daysInMonth) → count.
function _commissionActivityChart(signupsByDay, paymentsByDay, daysInMonth, periodLabel, subtitle) {
  const labels = [], signupArr = [], payArr = [];
  let totalS = 0, totalP = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const s = signupsByDay[d] || 0, p = paymentsByDay[d] || 0;
    labels.push(d);
    signupArr.push(s);
    payArr.push(p);
    totalS += s; totalP += p;
  }
  if (totalS === 0 && totalP === 0) {
    return `<div style="background:#141824;border:1px solid #252a3d;border-radius:10px;padding:16px 18px;margin:20px 0">
      <p style="margin:0 0 2px;color:#e2e4eb;font-size:14px;font-weight:700">Daily activity &mdash; ${periodLabel}</p>
      <p style="margin:0;font-size:12px;color:#6b7280">No sign-ups or payments to chart for this period.</p>
    </div>`;
  }
  // Chart.js v4 config (dual y-axis line chart), rendered by QuickChart.
  const cfg = {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: "Sign-ups", data: signupArr, yAxisID: "ySignups", borderColor: "#a855f7", backgroundColor: "rgba(168,85,247,0.15)", tension: 0.3, borderWidth: 2, pointRadius: 2, pointBackgroundColor: "#a855f7", fill: false },
        { label: "Payments", data: payArr, yAxisID: "yPayments", borderColor: "#10b981", backgroundColor: "rgba(16,185,129,0.15)", tension: 0.3, borderWidth: 2, pointRadius: 3, pointBackgroundColor: "#10b981", fill: false }
      ]
    },
    options: {
      plugins: { legend: { labels: { color: "#c8cbd6", usePointStyle: true, boxWidth: 8, font: { size: 12 } } } },
      layout: { padding: 6 },
      scales: {
        x: { title: { display: true, text: "Day of " + periodLabel, color: "#8b90a0", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#8b90a0", maxTicksLimit: 10, font: { size: 10 } } },
        ySignups: { type: "linear", position: "left", beginAtZero: true, title: { display: true, text: "Sign-ups", color: "#a855f7", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#a855f7", precision: 0, font: { size: 10 } } },
        yPayments: { type: "linear", position: "right", beginAtZero: true, title: { display: true, text: "Payments", color: "#10b981", font: { size: 11 } }, grid: { drawOnChartArea: false }, ticks: { color: "#10b981", precision: 0, font: { size: 10 } } }
      }
    }
  };
  const url = "https://quickchart.io/chart?v=4&w=560&h=280&bkg=" + encodeURIComponent("#141824") + "&c=" + encodeURIComponent(JSON.stringify(cfg));
  return `<div style="background:#141824;border:1px solid #252a3d;border-radius:10px;padding:16px 18px 12px;margin:20px 0">
    <p style="margin:0 0 2px;color:#e2e4eb;font-size:14px;font-weight:700">Daily activity &mdash; ${periodLabel}</p>
    <p style="margin:0 0 12px;font-size:11px;color:#6b7280">
      <span style="display:inline-block;width:14px;height:3px;border-radius:2px;background:#a855f7;vertical-align:middle"></span><span style="vertical-align:middle">&nbsp;Sign-ups (left) &mdash; ${totalS}</span>
      &nbsp;&nbsp;&nbsp;
      <span style="display:inline-block;width:14px;height:3px;border-radius:2px;background:#10b981;vertical-align:middle"></span><span style="vertical-align:middle">&nbsp;Payments (right) &mdash; ${totalP}</span>
    </p>
    <img src="${url}" width="560" alt="Daily sign-ups and payments for ${periodLabel}" style="display:block;width:100%;max-width:560px;height:auto;border-radius:6px">
    ${subtitle ? `<p style="margin:10px 0 0;font-size:10px;color:#4b5068;line-height:1.4">${subtitle}</p>` : ""}
  </div>`;
}

async function _runCommissionReport(opts = {}) {
  console.log("Running commission report...", JSON.stringify({
    targetAffiliateEmail: opts.targetAffiliateEmail || null,
    previewToAdmin: !!opts.previewToAdmin,
    skipAdmin: !!opts.skipAdmin,
    skipAffiliates: !!opts.skipAffiliates,
    periodYear: opts.periodYear || null,
    periodMonth: opts.periodMonth || null
  }));
  const stripeClient = getStripe();
  const now = new Date();
  // Reporting period selection:
  //   - If opts.periodYear (YYYY) + opts.periodMonth (1-12) provided, report on that exact month.
  //     "Current" month = month-to-date through `now`; "previous" or older months = full calendar month.
  //   - Otherwise default to the previous calendar month (original cron behavior).
  let periodStart, periodEnd;
  if (opts.periodYear && opts.periodMonth >= 1 && opts.periodMonth <= 12) {
    periodStart = new Date(opts.periodYear, opts.periodMonth - 1, 1);
    const monthEnd = new Date(opts.periodYear, opts.periodMonth, 1);
    // For the current (in-progress) month, cap the window at "now" so we don't double-count
    // subscriptions that started after the report is generated.
    periodEnd = monthEnd > now ? now : monthEnd;
  } else {
    periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  }
  const isCurrentMonth = periodStart.getFullYear() === now.getFullYear() && periodStart.getMonth() === now.getMonth();
  // The just-ended month = the calendar month immediately before the current one
  // (what the cron reports when it fires on the 1st). Because RentingRadar runs 7-day
  // trials, most of a month's conversions actually settle right around the month
  // boundary — so a pure calendar-settled Stripe query for the just-ended month reads
  // ~$0 while those exact users already show as active/paying on the Users + Referrals
  // dashboards (and in the current-month MTD view). To make the report AGREE with the
  // dashboards, compute revenue from the SAME cached/projected basis for both the
  // current month AND the just-ended month. Older months still use authoritative
  // settled-Stripe (accurate historical re-runs).
  const _curIdx = now.getFullYear() * 12 + now.getMonth();
  const _perIdx = periodStart.getFullYear() * 12 + periodStart.getMonth();
  const isJustEndedMonth = (_curIdx - _perIdx) === 1;
  const useProjected = isCurrentMonth || isJustEndedMonth;
  const periodLabel = periodStart.toLocaleString("en-US", { month: "long", year: "numeric" }) + (isCurrentMonth ? " (month-to-date)" : "");
  // Number of calendar days in the reporting month — x-axis span for the email chart.
  const daysInMonth = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0).getDate();
  // Payment deadline = 15th of the month following the report period.
  // e.g., May 2026 report → "June 15, 2026"; June 2026 report → "July 15, 2026".
  const paymentDate = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 15);
  const paymentDateLabel = paymentDate.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const gteSec = Math.floor(periodStart.getTime() / 1000);
    const ltSec = Math.floor(periodEnd.getTime() / 1000);

    // 1. Pull every user with a referredBy code. We fetch all users and filter in
    //    JS rather than using a Firestore `where('referredBy', '!=', null)` query —
    //    the `!=` operator requires a single-field index that excludes docs without
    //    the field, which can fail intermittently on small collections. A full read
    //    of `users` is cheap given the size of the customer base.
    let referredUsers = [];
    try {
      const snap = await db.collection("users").get();
      snap.forEach(doc => {
        const d = doc.data() || {};
        if (d.referredBy && String(d.referredBy).trim()) {
          referredUsers.push(Object.assign({ uid: doc.id }, d));
        }
      });
    } catch (err) {
      console.error("Failed to load referred users:", err && err.message, err);
      return null;
    }
    console.log("Found", referredUsers.length, "users with referredBy");
    // Do NOT early-return on empty data. Per contract Section 4.3, each affiliate is owed
    // a monthly statement even if it's $0 / 0 users — establishes a paper trail and
    // confirms the reporting pipeline is alive. The admin email also runs regardless.

    // 2. Group by referrer code; for each user, compute the AMORTIZED MONTHLY revenue
    //    from any subscription that was active during the reporting period.
    //
    //    Why amortized: per Agreement Section 4.5, Pro Yearly revenue is spread evenly
    //    across the 12 months of the subscription, not booked as a lump sum in the month
    //    Stripe collected the payment. This keeps Adam's monthly commission steady for
    //    yearly subscribers (~$7.875/mo per Pro Yearly user) instead of a one-month spike.
    //
    //    Approach: list each user's subscriptions, filter to those active at any point
    //    during the period, and convert their actual paid amount (latest invoice — already
    //    reflects any subscription discount) to a monthly equivalent based on the price's
    //    recurring interval (year → /12, month → as-is).
    const periodStartMs = periodStart.getTime();
    const periodEndMs = periodEnd.getTime();
    // For current-month (in-progress) reports, periodEnd is capped at `now` so we don't
    // count subscriptions starting after the snapshot. monthEnd is the actual end-of-month
    // boundary used to decide whether a trial will convert WITHIN this month (forecast)
    // or roll into next month's report.
    const monthEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
    const monthEndMs = monthEnd.getTime();
    const groups = {}; // code -> { signups, payingUsersList:[], totalRevenue, forecastRevenue, signupsByDay:{}, paymentsByDay:{} }
    for (const u of referredUsers) {
      const code = String(u.referredBy).toUpperCase();
      if (!groups[code]) groups[code] = { signups: 0, payingUsersList: [], totalRevenue: 0, forecastRevenue: 0, signupsByDay: {}, paymentsByDay: {} };
      groups[code].signups++;

      // SIGN-UPS series for the email chart: new referred users by signup date
      // (createdAt), keyed by day-of-month.
      const _cAtMs = _ts(u.createdAt);
      if (_cAtMs >= periodStartMs && _cAtMs < monthEndMs) {
        const dS = new Date(_cAtMs).getDate();
        groups[code].signupsByDay[dS] = (groups[code].signupsByDay[dS] || 0) + 1;
      }

      // PAYMENTS series is derived AFTER the loop from each group's payingUsersList,
      // so the chart's payment total ALWAYS matches the per-user list shown in the
      // email. Stamp each paying user with the day their payment actually PROCESSED so
      // the green line sits on real charge dates (NOT signup dates — otherwise it hides
      // under the purple sign-ups line). Best estimate of the last charge date = the
      // subscription's current period END minus one billing interval; with RentingRadar's
      // 7-day trial this lands on the post-trial conversion charge (≈ signup + 7d), which
      // is distinct from the sign-up date. Fall back to trial end / period start / signup.
      let _payMs = 0;
      const _cpEnd = _ts(u.currentPeriodEnd);
      if (_cpEnd) {
        const _bi = u.billingInterval ? String(u.billingInterval).toLowerCase() : "";
        const _isYearly = _bi ? (_bi.charAt(0) === "y") : /(?:YEARLY|YEAR|ANNUAL)$/.test(String(u.referredBy || "").toUpperCase());
        const _d = new Date(_cpEnd);
        if (_isYearly) _d.setFullYear(_d.getFullYear() - 1); else _d.setMonth(_d.getMonth() - 1);
        _payMs = _d.getTime();
      }
      if (!_payMs) _payMs = _ts(u.trialEnd) || _ts(u.currentPeriodStart) || _ts(u.createdAt) || periodStartMs;
      // Clamp into the reporting month so a boundary/prior charge still lands on the axis.
      if (_payMs < periodStartMs) _payMs = periodStartMs;
      if (_payMs >= monthEndMs) _payMs = monthEndMs - 1;
      const _payDayMs = _payMs;

      if (useProjected) {
        // Current or just-ended month: use cached Firestore fields (matches the Referrals
        // dashboard's _affEstMonthlyRevenue exactly — no Stripe API call needed). Trialing
        // users count only if their trial ends within this calendar month.
        const dbg = { uid: u.uid, email: u.email, code, tier: u.tier, status: u.subscriptionStatus, manualOverride: !!u.manualOverride, currentPeriodEnd: u.currentPeriodEnd, referredBy: u.referredBy };
        if (u.manualOverride) { console.log("[forecast] skip — manualOverride", dbg); continue; }
        if (u.subscriptionStatus !== "active" && u.subscriptionStatus !== "trialing") {
          console.log("[forecast] skip — status not active/trialing", dbg);
          continue;
        }

        let isForecast = false;
        if (u.subscriptionStatus === "trialing") {
          // For trialing subs, currentPeriodEnd === trial_end. Only count if it falls
          // inside this calendar month; otherwise the user will appear in a future report.
          const trialEndMs = _ts(u.currentPeriodEnd);
          if (!trialEndMs) { console.log("[forecast] skip — trialing but currentPeriodEnd unparseable", dbg); continue; }
          if (trialEndMs >= monthEndMs) {
            console.log("[forecast] skip — trial ends after this month", Object.assign({ trialEnd: new Date(trialEndMs).toISOString(), monthEnd: new Date(monthEndMs).toISOString() }, dbg));
            continue;
          }
          // Only the CURRENT month treats a trial-ending-this-month user as a forecast.
          // For the just-ended month the trial already resolved, so they're a realized
          // payer (isForecast:false) — and the "Forecasted" list only renders for the
          // current month, so this also keeps them visible in the Paid list.
          isForecast = isCurrentMonth;
        }

        const monthlyRevenue = _projectedMonthlyRevenue(u);
        if (monthlyRevenue <= 0) {
          console.log("[forecast] skip — projectedMonthlyRevenue=0", dbg);
          continue;
        }

        console.log("[forecast] INCLUDE", Object.assign({ revenue: monthlyRevenue, isForecast }, dbg));
        groups[code].payingUsersList.push({ name: u.displayName || u.name || "", email: u.email || u.uid, revenue: monthlyRevenue, isForecast, payDayMs: _payDayMs });
        groups[code].totalRevenue += monthlyRevenue;
        if (isForecast) groups[code].forecastRevenue += monthlyRevenue;
        continue;
      }

      // Past month: query Stripe for actual settled revenue.
      const pdbg = { uid: u.uid, email: u.email || null, code, tier: u.tier, status: u.subscriptionStatus, stripeCustomerId: u.stripeCustomerId || null };

      // Resolve the Stripe customer id. Prefer the cached field; if it's blank —
      // e.g. attribution was set MANUALLY via the Admin → Users editor (which writes
      // tier/referredBy but never runs a Stripe sync, so stripeCustomerId stays
      // empty) — look the customer up by email so the user isn't silently dropped
      // from the settled report. (This is exactly why such a user still shows on the
      // Users/Referrals dashboards, which read cached fields, yet was missing here.)
      let custId = u.stripeCustomerId || null;
      if (!custId && u.email) {
        try {
          const found = await stripeClient.customers.list({ email: String(u.email).toLowerCase().trim(), limit: 10 });
          for (const c of (found.data || [])) {
            const cs = await stripeClient.subscriptions.list({ customer: c.id, status: "all", limit: 1 });
            if (cs.data && cs.data.length) { custId = c.id; break; }
          }
          if (!custId && found.data && found.data.length) custId = found.data[0].id;
          if (custId) console.log("[commission] resolved missing stripeCustomerId by email", Object.assign({ resolved: custId }, pdbg));
        } catch (err) {
          console.warn("[commission] customer lookup by email failed:", err && err.message, pdbg);
        }
      }

      if (!custId) {
        // No Stripe customer we can query at all. Don't silently drop an ACTIVE
        // referred user — credit the cached monthly projection (the same figure the
        // dashboards show) and mark the row (estimated) so it's verified before pay.
        // Trialing/other statuses have no settled charge for a past month, so they
        // contribute nothing here.
        const proj = (u.subscriptionStatus === "active" && !u.manualOverride) ? _projectedMonthlyRevenue(u) : 0;
        if (proj > 0) {
          console.log("[commission] INCLUDE (ESTIMATED — no Stripe customer to query)", Object.assign({ revenue: proj }, pdbg));
          groups[code].payingUsersList.push({ name: u.displayName || u.name || "", email: u.email || u.uid, revenue: proj, isForecast: false, isEstimated: true, payDayMs: _payDayMs });
          groups[code].totalRevenue += proj;
        } else {
          console.log("[commission] skip — no stripeCustomerId and not active", pdbg);
        }
        continue;
      }

      try {
        const subs = await stripeClient.subscriptions.list({
          customer: custId,
          status: "all",
          limit: 100,
          expand: ["data.latest_invoice", "data.items.data.price"]
        });
        let userMonthlyRevenue = 0;
        const skipReasons = [];
        for (const sub of subs.data) {
          // Skip if the subscription wasn't active at any point during the reporting period.
          const subStartMs = (sub.start_date || 0) * 1000;
          const subEndedMs = sub.ended_at ? sub.ended_at * 1000 : (sub.canceled_at ? sub.canceled_at * 1000 : null);
          const startedBeforePeriodEnd = subStartMs < periodEndMs;
          const stillActiveAtPeriodStart = !subEndedMs || subEndedMs > periodStartMs;
          if (!startedBeforePeriodEnd || !stillActiveAtPeriodStart) { skipReasons.push(sub.id + ":outside-period"); continue; }

          // Trialing subs that didn't convert within the period contribute nothing for
          // past-month reporting — their conversion charge appears in a LATER month.
          // This is the "signed up in June but the 7-day trial converts in July" case:
          // the user belongs on July's statement, not June's.
          if (sub.status === "trialing") {
            const trialEndMs = (sub.trial_end || 0) * 1000;
            if (!trialEndMs || trialEndMs > periodEndMs) { skipReasons.push(sub.id + ":trial-converts-after-period"); continue; }
          }

          const latestInvoice = sub.latest_invoice;
          const item = sub.items && sub.items.data && sub.items.data[0];
          if (!item || !item.price || !item.price.recurring) { skipReasons.push(sub.id + ":no-recurring-price"); continue; }

          let actualAmount;
          if (latestInvoice && latestInvoice.amount_paid > 0) {
            actualAmount = latestInvoice.amount_paid / 100;
          } else if (item.price.unit_amount) {
            actualAmount = (item.price.unit_amount * (item.quantity || 1)) / 100;
          } else {
            skipReasons.push(sub.id + ":zero-amount");
            continue;
          }

          const interval = item.price.recurring.interval;
          const intervalCount = item.price.recurring.interval_count || 1;
          let monthlyEquivalent = 0;
          if (interval === "year") {
            monthlyEquivalent = actualAmount / (12 * intervalCount);
          } else if (interval === "month") {
            monthlyEquivalent = actualAmount / intervalCount;
          } else if (interval === "week") {
            monthlyEquivalent = (actualAmount * 4.333) / intervalCount;
          } else if (interval === "day") {
            monthlyEquivalent = (actualAmount * 30) / intervalCount;
          }
          userMonthlyRevenue += monthlyEquivalent;
        }

        if (userMonthlyRevenue > 0) {
          console.log("[commission] INCLUDE (settled)", Object.assign({ revenue: Number(userMonthlyRevenue.toFixed(2)) }, pdbg));
          groups[code].payingUsersList.push({ name: u.displayName || u.name || "", email: u.email || u.uid, revenue: userMonthlyRevenue, isForecast: false, payDayMs: _payDayMs });
          groups[code].totalRevenue += userMonthlyRevenue;
        } else {
          // We successfully queried Stripe and found no in-period settlement. That's
          // authoritative — the user did NOT pay in this month (don't fabricate from
          // stale cache). Log the reasons so a missing user is diagnosable from logs.
          console.log("[commission] $0 settled in period (not counted)", Object.assign({ skipReasons }, pdbg));
        }
      } catch (err) {
        console.error("[commission] Stripe subscription fetch failed for user", u.uid, err);
      }
    }

    // Derive the PAYMENTS chart series from each group's paying-user list, so the
    // chart's payment total exactly matches the per-user list shown in the email.
    Object.keys(groups).forEach(c => {
      const g = groups[c];
      g.paymentsByDay = {};
      g.payingUsersList.forEach(pu => {
        if (pu.payDayMs != null) {
          const d = new Date(pu.payDayMs).getDate();
          g.paymentsByDay[d] = (g.paymentsByDay[d] || 0) + 1;
        }
      });
    });

    // 3. Compute per-referrer commission per contract formula
    const codes = Object.keys(groups).sort();
    const reportRows = [];
    let totalCommission = 0;
    let totalRevenue = 0;
    let totalPaying = 0;
    codes.forEach(code => {
      const g = groups[code];
      const payingCount = g.payingUsersList.length;
      const opExpense = _COMMISSION_PER_USER_EXPENSE * payingCount;
      const netRevenue = Math.max(0, g.totalRevenue - opExpense);
      const commission = netRevenue * _COMMISSION_RATE;
      reportRows.push({ code, signups: g.signups, payingCount, gross: g.totalRevenue, opExpense, netRevenue, commission, payingUsersList: g.payingUsersList });
      totalCommission += commission;
      totalRevenue += g.totalRevenue;
      totalPaying += payingCount;
    });

    // 4. Build report email
    const fmtMoney = function(n){ return "$" + Number(n).toFixed(2); };
    let rowsHtml = "";
    // Flatten all paying users across all referrers into two lists for the consolidated
    // card below the table: settled vs forecasted. Each entry carries its referral code
    // so the admin can see which affiliate attributed each user.
    const adminPaidUsers = [];
    const adminForecastUsers = [];
    reportRows.forEach(r => {
      rowsHtml += `<tr style="border-bottom:1px solid #334155">
        <td style="padding:10px 12px"><span style="background:rgba(99,129,250,.2);color:#818cf8;padding:3px 9px;border-radius:5px;font-family:monospace;font-weight:700;font-size:13px">${r.code}</span></td>
        <td style="padding:10px 12px;color:#f1f5f9;text-align:center">${r.signups}</td>
        <td style="padding:10px 12px;color:#10b981;text-align:center;font-weight:700">${r.payingCount}</td>
        <td style="padding:10px 12px;color:#f1f5f9;text-align:right">${fmtMoney(r.gross)}</td>
        <td style="padding:10px 12px;color:#94a3b8;text-align:right">${fmtMoney(r.opExpense)}</td>
        <td style="padding:10px 12px;color:#f1f5f9;text-align:right">${fmtMoney(r.netRevenue)}</td>
        <td style="padding:10px 12px;color:#10b981;text-align:right;font-weight:700;font-size:15px">${fmtMoney(r.commission)}</td>
      </tr>`;
      r.payingUsersList.forEach(u => {
        const enriched = Object.assign({ code: r.code }, u);
        if (u.isForecast) adminForecastUsers.push(enriched);
        else adminPaidUsers.push(enriched);
      });
    });

    // Helper: render one user row in the admin paid/forecast cards
    const adminUserRow = function(u) {
      const label = u.name ? `${u.name} <span style="color:#6b7280">(${u.email})</span>` : u.email;
      const codeChip = `<span style="background:rgba(99,129,250,.15);color:#818cf8;padding:2px 7px;border-radius:4px;font-family:monospace;font-weight:600;font-size:11px;margin-left:6px">${u.code}</span>`;
      const estTag = u.isEstimated ? ` <em style="color:#f59e0b;font-size:11px;font-style:normal">(estimated)</em>` : "";
      return `<tr><td style="padding:8px 14px;color:#c8cbd6;font-size:13px;border-bottom:1px solid #252a3d">${label}${codeChip}${estTag}</td><td style="padding:8px 14px;color:#c8cbd6;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">${fmtMoney(u.revenue)}</td></tr>`;
    };
    const anyAdminEstimated = adminPaidUsers.some(u => u.isEstimated);

    const renderAdminUserList = function(title, list, accentColor) {
      const rowsInner = list.length
        ? list.map(adminUserRow).join("")
        : `<tr><td colspan="2" style="padding:14px;color:#6b7280;font-size:13px;font-style:italic;text-align:center">None this month.</td></tr>`;
      return `
        <p style="margin:0 0 8px;color:${accentColor};font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${title} (${list.length})</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:18px">
          ${rowsInner}
        </table>`;
    };

    const adminUsersCardHtml = `
      <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:18px 18px 4px;margin-bottom:16px">
        ${renderAdminUserList("Paid This Month", adminPaidUsers, "#10b981")}
        ${isCurrentMonth ? renderAdminUserList("Forecasted to Pay This Month", adminForecastUsers, "#818cf8") : ""}
        ${anyAdminEstimated ? `<p style="margin:0 0 12px;color:#f59e0b;font-size:12px;line-height:1.5"><strong>(estimated)</strong> rows had no Stripe customer to query — usually attribution set manually via the Users editor without a Stripe sync. They're credited from the user's cached plan price; <strong>verify against Stripe before paying</strong>, and run a subscription sync on that user so future reports settle exactly.</p>` : ""}
      </div>`;

    const forecastNoteHtml = isCurrentMonth ? `
      <div style="background:rgba(99,129,250,.08);border:1px solid rgba(99,129,250,.25);border-radius:6px;padding:12px 14px;margin-top:12px">
        <p style="margin:0;color:#818cf8;font-size:13px;font-weight:600">Month-to-date includes trial forecasts</p>
        <p style="margin:6px 0 0;color:#c8cbd6;font-size:13px;line-height:1.5">Users currently in a 7-day trial whose trial ends within this calendar month are forecast as paying-this-month at the discounted post-trial price. Trials that extend into next month will be attributed to next month's report instead. Forecasted rows are marked <em>(forecast)</em>.</p>
      </div>` : '';

    // Aggregate daily activity across ALL referrers for the admin chart.
    const adminSignupsByDay = {}, adminPaymentsByDay = {};
    Object.keys(groups).forEach(c => {
      const g = groups[c];
      for (const d in g.signupsByDay) adminSignupsByDay[d] = (adminSignupsByDay[d] || 0) + g.signupsByDay[d];
      for (const d in g.paymentsByDay) adminPaymentsByDay[d] = (adminPaymentsByDay[d] || 0) + g.paymentsByDay[d];
    });
    const adminChartHtml = _commissionActivityChart(adminSignupsByDay, adminPaymentsByDay, daysInMonth, periodLabel, "Purple = new sign-ups, by signup date. Green = payments, by the date each was processed (totals match the paying-user list above). Across all referrers.");

    const html = emailWrapper(`
      <h2 style="color:#a855f7;margin:0 0 8px;font-size:22px">Monthly Commission Report</h2>
      <p style="margin:0 0 4px;color:#c8cbd6">Reporting period: <strong>${periodLabel}</strong></p>
      <p style="margin:0 0 18px;color:#94a3b8;font-size:13px">${isCurrentMonth ? 'Month-to-date estimate including trial-conversion forecasts. ' : (useProjected ? 'Based on your referred subscribers active as of this report — matching the Users &amp; Referrals dashboards. ' : 'Calculated from actual Stripe paid-invoice settlements. ')}Formula per contract: $${_COMMISSION_PER_USER_EXPENSE.toFixed(2)}/paying user as operating expense; ${Math.round(_COMMISSION_RATE * 100)}% of net.</p>

      <table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,.02);border-radius:8px;overflow:hidden;margin-bottom:16px">
        <thead><tr style="background:rgba(255,255,255,.04)">
          <th style="text-align:left;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Referrer</th>
          <th style="text-align:center;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Signups</th>
          <th style="text-align:center;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Paying This Month</th>
          <th style="text-align:right;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Gross Rev</th>
          <th style="text-align:right;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Op. Expense</th>
          <th style="text-align:right;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Net</th>
          <th style="text-align:right;padding:10px 12px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Commission</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr style="background:rgba(99,129,250,.1);font-weight:700">
          <td style="padding:12px;color:#f1f5f9">TOTAL</td>
          <td style="padding:12px;color:#f1f5f9;text-align:center">${reportRows.reduce((s,r)=>s+r.signups,0)}</td>
          <td style="padding:12px;color:#10b981;text-align:center">${totalPaying}</td>
          <td style="padding:12px;color:#f1f5f9;text-align:right">${fmtMoney(totalRevenue)}</td>
          <td style="padding:12px;color:#94a3b8;text-align:right">&mdash;</td>
          <td style="padding:12px;color:#94a3b8;text-align:right">&mdash;</td>
          <td style="padding:12px;color:#10b981;text-align:right;font-size:17px">${fmtMoney(totalCommission)}</td>
        </tr></tfoot>
      </table>

      ${adminChartHtml}

      ${adminUsersCardHtml}

      ${forecastNoteHtml}

      <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:12px 14px;margin-top:12px">
        <p style="margin:0;color:#f59e0b;font-size:13px;font-weight:600">${isCurrentMonth ? 'Preview only — do not pay against this report' : 'Action required: review and issue payments'}</p>
        <p style="margin:6px 0 0;color:#c8cbd6;font-size:13px;line-height:1.5">${isCurrentMonth ? 'This is a month-to-date preview of ' + periodLabel + ' including forecasted trial conversions. Final payable totals will appear in the report sent on the 1st of next month.' : (useProjected ? 'This report reflects your referred subscribers active as of today (matching the Users &amp; Referrals dashboards) for ' + periodLabel + ' — trials generally convert around the month boundary, so this basis captures them where a calendar-settled query would miss them. Verify the per-referrer totals before issuing ACH transfers (typically by the 15th of this month per contract Section 4.2).' : 'This report reflects actual Stripe-settled revenue from ' + periodLabel + '. Verify the per-referrer commission totals match your records before issuing ACH transfers (typically by the 15th of this month per contract Section 4.2).')}</p>
      </div>

      <p style="margin:20px 0 0;color:#6b7280;font-size:11px">Generated automatically by RentingRadar. Source: Stripe invoices with status=paid, created between ${periodStart.toISOString().slice(0,10)} and ${periodEnd.toISOString().slice(0,10)} UTC.${isCurrentMonth ? ' Forecasted trials based on Stripe subscription discounts.' : ''}</p>
    `);
    const subject = `[Commission Report] ${periodLabel} — Total: ${fmtMoney(totalCommission)}`;

    if (!opts.skipAdmin) {
      try {
        initSendGrid();
        const ok = await sendEmail(ADMIN_EMAIL, subject, html, { category: "admin-commission-report" });
        if (ok) console.log("Commission report sent for", periodLabel, "total:", fmtMoney(totalCommission));
        else console.error("Commission report FAILED to send — see SendGrid error above");
      } catch (err) {
        console.error("Failed to send commission report:", err);
      }
    } else {
      console.log("Skipping admin commission report (skipAdmin=true)");
    }

    // ─── Per-affiliate statements ───
    // Each affiliate gets their own scoped statement (per contract Section 4.3) showing
    // ONLY their own users and numbers — never another affiliate's data. Sums across all
    // referral codes the affiliate owns (e.g., AIRPRENEURMONTHLY + AIRPRENEURYEARLY).
    // Always sends, even with zero referred users, to satisfy the contractual obligation
    // to provide a monthly statement.
    if (opts.skipAffiliates) {
      console.log("Skipping per-affiliate statements (skipAffiliates=true)");
    } else try {
      const affSnap = await db.collection("users").where("tier", "==", "affiliate").get();
      const affiliates = affSnap.docs.map(d => Object.assign({ uid: d.id }, d.data()));
      for (const aff of affiliates) {
        // Test-mode filter: only send to the specified target email
        if (opts.targetAffiliateEmail && (aff.email || "").toLowerCase() !== opts.targetAffiliateEmail.toLowerCase()) {
          continue;
        }
        const affCodes = Array.isArray(aff.referralCodes) && aff.referralCodes.length
          ? aff.referralCodes.map(c => String(c || "").toUpperCase().trim()).filter(Boolean)
          : (aff.referralCode ? [String(aff.referralCode).toUpperCase().trim()] : []);
        if (!affCodes.length) {
          console.log("Affiliate", aff.uid, "has no referral codes — skipping statement.");
          continue;
        }
        if (!aff.email) {
          console.warn("Affiliate", aff.uid, "has no email — skipping statement.");
          continue;
        }

        // Aggregate across all codes this affiliate owns
        let affSignups = 0, affPaying = 0, affGross = 0;
        let affPayingUsers = [];
        for (const code of affCodes) {
          const g = groups[code];
          if (!g) continue;
          affSignups += g.signups;
          affPaying += g.payingUsersList.length;
          affGross += g.totalRevenue;
          affPayingUsers = affPayingUsers.concat(g.payingUsersList);
        }
        const affOpsExp = _COMMISSION_PER_USER_EXPENSE * affPaying;
        const affNet = Math.max(0, affGross - affOpsExp);
        const affCommission = affNet * _COMMISSION_RATE;

        const firstName = (aff.name || "").trim().split(/\s+/)[0] || "there";
        const affHasForecasts = affPayingUsers.some(u => u.isForecast);
        const affPaidList = affPayingUsers.filter(u => !u.isForecast);
        const affForecastList = affPayingUsers.filter(u => u.isForecast);

        const affAnyEstimated = affPaidList.some(u => u.isEstimated);
        const affUserRow = function(u) {
          const label = u.name ? `${u.name} <span style="color:#6b7280">(${u.email})</span>` : u.email;
          const estTag = u.isEstimated ? ` <em style="color:#f59e0b;font-size:11px;font-style:normal">(estimated)</em>` : "";
          return `<tr><td style="padding:8px 14px;color:#c8cbd6;font-size:13px;border-bottom:1px solid #252a3d">${label}${estTag}</td><td style="padding:8px 14px;color:#c8cbd6;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">${fmtMoney(u.revenue)}</td></tr>`;
        };
        const renderAffSection = function(title, list, accentColor) {
          const rowsInner = list.length
            ? list.map(affUserRow).join("")
            : `<tr><td colspan="2" style="padding:14px;color:#6b7280;font-size:13px;font-style:italic;text-align:center">None this month.</td></tr>`;
          return `
            <p style="margin:0 0 8px;color:${accentColor};font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${title} (${list.length})</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:18px">
              ${rowsInner}
            </table>`;
        };
        const affUsersCardHtml = `
          <div style="background:#141824;border-radius:10px;padding:18px 18px 4px;margin-bottom:20px">
            ${renderAffSection("Paid This Month", affPaidList, "#10b981")}
            ${isCurrentMonth ? renderAffSection("Forecasted to Pay This Month", affForecastList, "#818cf8") : ""}
            ${affAnyEstimated ? `<p style="margin:0 0 12px;color:#94a3b8;font-size:12px;line-height:1.5">Rows marked <em style="color:#f59e0b;font-style:normal">(estimated)</em> are credited from the user's latest known plan price while we reconcile the exact Stripe-settled amount; your payment reflects the final settled figure.</p>` : ""}
          </div>`;

        const affForecastNote = isCurrentMonth ? `
          <div style="background:rgba(99,129,250,.08);border:1px solid rgba(99,129,250,.25);border-radius:8px;padding:14px 16px;margin-bottom:20px">
            <p style="margin:0 0 6px;color:#818cf8;font-size:13px;font-weight:600">How this month-to-date statement works</p>
            <p style="margin:0;color:#c8cbd6;font-size:12px;line-height:1.6">This is a <strong>preview</strong> of ${periodLabel}, not a payable statement. Users currently in their 7-day trial whose trial ends within this month are forecast as paying-this-month at their discounted post-trial price (marked <em>(forecast)</em>). Trials that extend into next month will appear on next month's statement instead. Final numbers — and the actual payment — go out on the 1st of next month.</p>
          </div>` : '';

        const affHtml = emailWrapper(`
          <h2 style="margin:0 0 8px;color:#ffffff;font-size:22px">Commission Statement &mdash; ${periodLabel}</h2>
          <p style="margin:0 0 18px;color:#94a3b8;font-size:14px">Hi ${firstName}, here's your ${isCurrentMonth ? 'month-to-date preview' : 'monthly commission statement'}:</p>

          ${affForecastNote}

          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#141824;border-radius:10px;overflow:hidden;margin-bottom:20px">
            <tr><td style="padding:12px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #252a3d">Paying This Month${affHasForecasts ? ' <span style="color:#6b7280;font-size:11px">(incl. trial forecasts)</span>' : ''}</td><td style="padding:12px 16px;color:#f1f5f9;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">${affPaying}</td></tr>
            <tr><td style="padding:12px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #252a3d">Gross Revenue</td><td style="padding:12px 16px;color:#f1f5f9;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">${fmtMoney(affGross)}</td></tr>
            <tr><td style="padding:12px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #252a3d">Operating Expenses <span style="color:#6b7280">(${affPaying} &times; $${_COMMISSION_PER_USER_EXPENSE.toFixed(2)})</span></td><td style="padding:12px 16px;color:#f1f5f9;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">&minus;${fmtMoney(affOpsExp)}</td></tr>
            <tr><td style="padding:12px 16px;color:#94a3b8;font-size:13px;border-bottom:1px solid #252a3d">Net Attributed Revenue</td><td style="padding:12px 16px;color:#f1f5f9;font-size:13px;text-align:right;border-bottom:1px solid #252a3d;font-weight:600">${fmtMoney(affNet)}</td></tr>
            <tr><td style="padding:14px 16px;color:#10b981;font-size:14px;font-weight:700">${isCurrentMonth ? 'Projected Commission' : 'Commission'} (${Math.round(_COMMISSION_RATE * 100)}%)</td><td style="padding:14px 16px;color:#10b981;font-size:18px;text-align:right;font-weight:700">${fmtMoney(affCommission)}</td></tr>
          </table>

          ${affUsersCardHtml}

          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6">${isCurrentMonth ? 'Numbers above are a snapshot of ' + periodLabel + ' as of today and may change before the month closes. Commission payments for users who paid in ' + periodLabel + ' will be issued by ' + paymentDateLabel + ' via the method you designated.' : (useProjected ? 'Commission payments for your referred subscribers active in ' + periodLabel + ' will be issued by ' + paymentDateLabel + ' via the method you designated. This statement reflects your active referred subscribers for ' + periodLabel + ', with yearly subscriptions amortized to a monthly equivalent.' : 'Commission payments for users who paid in ' + periodLabel + ' will be issued by ' + paymentDateLabel + ' via the method you designated. This statement reflects actual Stripe-settled revenue for ' + periodLabel + ', with yearly subscriptions amortized to a monthly equivalent.')} Questions? Reply to this email.</p>
        `, null, { transactional: true });

        // Preview mode: redirect this affiliate's EXACT statement (identical body) to
        // the admin address with a clear subject prefix, so the admin sees precisely
        // what the affiliate would receive without the affiliate getting anything.
        const affRecipient = opts.previewToAdmin ? ADMIN_EMAIL : aff.email;
        const affSubject = opts.previewToAdmin
          ? `[PREVIEW for ${aff.email}] [Commission] ${periodLabel} — ${fmtMoney(affCommission)}`
          : `[Commission] ${periodLabel} — ${fmtMoney(affCommission)}`;
        try {
          const okA = await sendEmail(affRecipient, affSubject, affHtml, { category: "affiliate-commission-statement" });
          if (okA) console.log("Affiliate statement sent to", affRecipient, opts.previewToAdmin ? "(PREVIEW of " + aff.email + ")" : "", "amount:", fmtMoney(affCommission));
          else console.error("Affiliate statement FAILED for", affRecipient);
        } catch (err) {
          console.error("Failed to send affiliate statement to", affRecipient, err);
        }
      }
    } catch (err) {
      console.error("Failed to gather/send affiliate statements:", err);
    }

    return null;
}

// Cron trigger — runs at 9 AM ET on the 1st of every month. Full default behavior:
// admin overall report + every affiliate's own scoped statement.
exports.monthlyCommissionReport = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("0 9 1 * *") // minute hour day-of-month month day-of-week
  .timeZone("America/New_York")
  .onRun(async () => _runCommissionReport({}));

// Admin-only HTTP trigger — for mid-month re-sends and testing. Requires a Firebase
// ID token in `Authorization: Bearer <token>` and the user's email must match
// ADMIN_EMAIL. Query params:
//   ?affiliateEmail=adam@example.com  — only that affiliate gets a statement (test mode)
//   ?affiliateEmail=…&previewToAdmin=1 — that affiliate's exact statement goes to the
//                                        admin email instead (preview before sending)
//   ?adminOnly=1                       — send only the admin overall report
//   ?affiliatesOnly=1                  — send only per-affiliate statements
//   (no params)                        — full run, same as the cron
exports.triggerCommissionReport = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method === "OPTIONS") return res.status(200).end();
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: { message: "Bearer token required" } });
    }
    let user;
    try {
      const idToken = authHeader.slice(7);
      user = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: { message: "Invalid auth token" } });
    }
    if (!user.email || user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: { message: "Admin only" } });
    }
    const body = req.body && (req.body.data || req.body) || {};
    const targetEmail = (req.query.affiliateEmail || body.affiliateEmail || "").toString().trim().toLowerCase();
    const previewToAdmin = req.query.previewToAdmin === "1" || body.previewToAdmin === true;
    const adminOnly = req.query.adminOnly === "1" || body.adminOnly === true;
    const affiliatesOnly = req.query.affiliatesOnly === "1" || body.affiliatesOnly === true;
    const periodYear = parseInt(req.query.periodYear || body.periodYear || "0", 10);
    const periodMonth = parseInt(req.query.periodMonth || body.periodMonth || "0", 10);
    const opts = {};
    if (periodYear && periodMonth >= 1 && periodMonth <= 12) {
      opts.periodYear = periodYear;
      opts.periodMonth = periodMonth;
    }
    if (targetEmail) {
      opts.targetAffiliateEmail = targetEmail;
      opts.skipAdmin = true; // test-mode: only the named affiliate receives anything
      if (previewToAdmin) opts.previewToAdmin = true; // …but redirect that statement to admin
    } else {
      if (adminOnly) opts.skipAffiliates = true;
      if (affiliatesOnly) opts.skipAdmin = true;
    }
    try {
      await _runCommissionReport(opts);
      res.status(200).json({ result: { data: { ok: true, ranWith: opts } } });
    } catch (err) {
      console.error("triggerCommissionReport failed:", err);
      res.status(500).json({ error: { message: err.message || "Failed to generate report" } });
    }
  });
});


// ============================================================
// 9. ANALYSIS QUOTA LIMIT EMAIL — triggered from client when user
//    exhausts their monthly analyses (Basic or Standard)
// ============================================================
exports.sendAnalysisLimitEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");
  }

  const uid = context.auth.uid;
  const resetDateStr = data.resetDate || "your next cycle";

  // Get user data
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User not found.");
  }

  const userData = userDoc.data();
  const email = userData.email;
  const displayName = userData.displayName || userData.name;
  const userTier = userData.tier || "basic";

  if (!email) {
    throw new functions.https.HttpsError("failed-precondition", "No email on file.");
  }

  // Pro users should never hit a limit
  if (userTier === "pro") {
    return { sent: false, reason: "Pro users have unlimited analyses." };
  }

  // Check if user has opted out of product emails
  const canSend = await canSendProductEmails(uid);
  if (!canSend) {
    return { sent: false, reason: "User opted out of product emails." };
  }

  // Prevent duplicate: don't send if we already sent one in the last 25 days
  try {
    const recentEmail = await db.collection("emailLog")
      .where("uid", "==", uid)
      .where("type", "==", "analysis_limit")
      .where("sentAt", ">", new Date(Date.now() - 25 * 24 * 60 * 60 * 1000))
      .limit(1)
      .get();
    if (!recentEmail.empty) {
      return { sent: false, reason: "Already sent this cycle." };
    }
  } catch (err) {
    console.warn("Could not check recent analysis limit emails for", uid, err);
  }

  const unsubUrl = getUnsubscribeUrl(uid, email, "product");
  const htmlContent = analysisLimitEmailHtml(displayName, userTier, resetDateStr, unsubUrl);

  const subject = userTier === "basic"
    ? "📊 You've used your analysis for this month"
    : "📊 You've used all 10 analyses for this month";

  const success = await sendEmail(email, subject, htmlContent, {
    unsubscribeUrl: unsubUrl,
    category: "analysis_limit",
  });

  if (success) {
    await db.collection("emailLog").add({
      uid: uid,
      email: email,
      type: "analysis_limit",
      subject: subject,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { sent: success };
});


// ============================================================
// 9. EMAIL PREFERENCES — HTTP endpoint for managing opt-in/out
// ============================================================
exports.emailPreferences = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // GET: retrieve current preferences
    if (req.method === "GET") {
      const user = await verifyAuth(req);
      if (!user) return sendError(res, 401, "You must be signed in.");

      try {
        const prefsDoc = await db.collection("emailPreferences").doc(user.uid).get();
        if (!prefsDoc.exists) {
          return sendSuccess(res, {
            marketingEmails: true,
            productEmails: true,
            weeklyDigest: true,
          });
        }
        const prefs = prefsDoc.data();
        sendSuccess(res, {
          marketingEmails: prefs.marketingEmails !== false,
          productEmails: prefs.productEmails !== false,
          weeklyDigest: prefs.weeklyDigest !== false,
        });
      } catch (err) {
        sendError(res, 500, "Failed to get preferences.");
      }
      return;
    }

    // POST: update preferences
    if (req.method === "POST") {
      const user = await verifyAuth(req);
      if (!user) return sendError(res, 401, "You must be signed in.");

      const body = req.body.data || req.body;
      const { marketingEmails, productEmails, weeklyDigest } = body;

      try {
        await db.collection("emailPreferences").doc(user.uid).set({
          email: user.email || "",
          marketingEmails: marketingEmails !== false,
          productEmails: productEmails !== false,
          weeklyDigest: weeklyDigest !== false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        sendSuccess(res, { updated: true });
      } catch (err) {
        sendError(res, 500, "Failed to update preferences.");
      }
      return;
    }

    sendError(res, 405, "Method not allowed.");
  });
});


// ============================================================
// 9. ONE-CLICK UNSUBSCRIBE — public endpoint (no auth required)
//    CAN-SPAM compliant: works via unique token in email links
// ============================================================
exports.unsubscribe = functions.https.onRequest(async (req, res) => {
  const uid = req.query.uid;
  const type = req.query.type || "marketing"; // "marketing", "product", "all"
  const token = req.query.token;

  if (!uid) {
    res.status(400).send(unsubscribePageHtml("Invalid unsubscribe link.", false));
    return;
  }

  // Verify the unsubscribe token matches what we stored
  try {
    const prefsDoc = await db.collection("emailPreferences").doc(uid).get();
    if (!prefsDoc.exists) {
      res.status(404).send(unsubscribePageHtml("Account not found.", false));
      return;
    }

    const prefs = prefsDoc.data();

    // Simple token verification: hash of uid + email
    const crypto = require("crypto");
    const expectedToken = crypto
      .createHash("sha256")
      .update(uid + (prefs.email || ""))
      .digest("hex")
      .substring(0, 16);

    if (token !== expectedToken) {
      res.status(403).send(unsubscribePageHtml("Invalid unsubscribe link.", false));
      return;
    }

    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (type === "all") {
      update.marketingEmails = false;
      update.productEmails = false;
      update.weeklyDigest = false;
    } else if (type === "product") {
      update.productEmails = false;
    } else {
      update.marketingEmails = false;
      update.weeklyDigest = false;
    }

    await db.collection("emailPreferences").doc(uid).update(update);

    res.status(200).send(unsubscribePageHtml("You've been unsubscribed successfully.", true));
  } catch (err) {
    console.error("Unsubscribe error:", err);
    res.status(500).send(unsubscribePageHtml("Something went wrong. Please try again or contact help@rentingradar.com.", false));
  }
});

function unsubscribePageHtml(message, success) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RentingRadar — Email Preferences</title>
<style>
body{margin:0;padding:40px 20px;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.icon{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 12px;color:#1a1a2e}
p{font-size:15px;color:#6b7280;line-height:1.6;margin:0 0 20px}
a{color:#6381fa;text-decoration:none;font-weight:500}
</style></head><body>
<div class="card">
  <div class="icon">${success ? "✅" : "⚠️"}</div>
  <h1>${success ? "Unsubscribed" : "Oops"}</h1>
  <p>${message}</p>
  ${success ? '<p>You can update your preferences anytime in your <a href="https://app.rentingradar.com#settings">account settings</a>.</p>' : ""}
  <p><a href="https://rentingradar.com">← Back to RentingRadar</a></p>
</div>
</body></html>`;
}

function getTierFromPriceId(priceId) {
  if (priceId === process.env.BASIC_MONTHLY_PRICE || priceId === process.env.BASIC_YEARLY_PRICE) return "basic";
  if (priceId === process.env.STANDARD_MONTHLY_PRICE || priceId === process.env.STANDARD_YEARLY_PRICE) return "standard";
  if (priceId === process.env.PRO_MONTHLY_PRICE || priceId === process.env.PRO_YEARLY_PRICE) return "pro";
  return null;
}

// Helper: verify Firebase ID token from Authorization header
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  try {
    const token = authHeader.split("Bearer ")[1];
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.error("Auth verification failed:", err.message);
    return null;
  }
}

// Helper: send JSON response
function sendSuccess(res, data) {
  res.status(200).json({ result: { data: data } });
}
function sendError(res, status, message) {
  res.status(status).json({ error: { message: message } });
}


// ============================================================
// 1. CREATE CHECKOUT SESSION
// ============================================================
exports.createCheckoutSession = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const user = await verifyAuth(req);
    if (!user) return sendError(res, 401, "You must be signed in to upgrade.");

    const body = req.body.data || req.body;
    const { tier, period } = body;
    if (!tier || !period) return sendError(res, 400, "Missing tier or period.");

    const PRICE_IDS = {
      basic_monthly: process.env.BASIC_MONTHLY_PRICE,
      basic_yearly: process.env.BASIC_YEARLY_PRICE,
      standard_monthly: process.env.STANDARD_MONTHLY_PRICE,
      standard_yearly: process.env.STANDARD_YEARLY_PRICE,
      pro_monthly: process.env.PRO_MONTHLY_PRICE,
      pro_yearly: process.env.PRO_YEARLY_PRICE,
    };

    const priceKey = `${tier}_${period}`;
    const priceId = PRICE_IDS[priceKey];
    if (!priceId) return sendError(res, 404, `No Stripe price configured for ${tier}/${period}.`);

    try {
      const stripeClient = getStripe();
      const uid = user.uid;
      const email = user.email || "";

      const userDoc = await db.collection("users").doc(uid).get();
      let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

      if (!customerId) {
        const customer = await stripeClient.customers.create({
          email: email,
          metadata: { firebaseUID: uid },
        });
        customerId = customer.id;
        await db.collection("users").doc(uid).update({ stripeCustomerId: customerId });
      }

      // Don't grant a new trial if this customer has had any prior subscription.
      // Guards against the case where a past_due/expired user starts a new checkout
      // and would otherwise receive a second free trial.
      let hasHadSubscription = false;
      try {
        const prevSubs = await stripeClient.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 1,
        });
        hasHadSubscription = prevSubs.data.length > 0;
      } catch (err) {
        console.warn("Could not check prior subscriptions for trial eligibility:", err.message);
      }

      const session = await stripeClient.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: "https://app.rentingradar.com?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://app.rentingradar.com?checkout=cancelled",
        subscription_data: {
          ...(hasHadSubscription ? {} : { trial_period_days: 7 }),
          metadata: { firebaseUID: uid, tier: tier },
        },
        metadata: { firebaseUID: uid, tier: tier },
      });

      sendSuccess(res, { url: session.url });
    } catch (err) {
      console.error("createCheckoutSession error:", err);
      sendError(res, 500, err.message || "Failed to create checkout session.");
    }
  });
});


// ============================================================
// 2. CREATE PORTAL SESSION
// ============================================================
exports.createPortalSession = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const user = await verifyAuth(req);
    if (!user) return sendError(res, 401, "You must be signed in.");

    const uid = user.uid;
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists || !userDoc.data().stripeCustomerId) {
      return sendError(res, 404, "No billing account found. Subscribe to a paid plan first.");
    }

    try {
      const stripeClient = getStripe();
      const session = await stripeClient.billingPortal.sessions.create({
        customer: userDoc.data().stripeCustomerId,
        return_url: "https://app.rentingradar.com#settings",
      });
      sendSuccess(res, { url: session.url });
    } catch (err) {
      console.error("createPortalSession error:", err);
      sendError(res, 500, err.message || "Failed to create portal session.");
    }
  });
});


// ============================================================
// 3. VERIFY CHECKOUT
// ============================================================
exports.verifyCheckout = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const user = await verifyAuth(req);
    if (!user) return sendError(res, 401, "You must be signed in.");

    const body = req.body.data || req.body;
    const { sessionId } = body;
    if (!sessionId) return sendError(res, 400, "Missing session ID.");

    try {
      const stripeClient = getStripe();
      const uid = user.uid;

      const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"],
      });

      if (session.metadata?.firebaseUID !== uid) {
        return sendError(res, 403, "Session does not belong to this user.");
      }

      // Trials have payment_status "no_payment_required"; paid subs have "paid"
      if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
        return sendError(res, 400, "Payment not completed.");
      }

      const tier = session.metadata?.tier;
      if (!tier) return sendError(res, 500, "No tier found in session metadata.");

      // Get previous tier before updating
      const userDoc = await db.collection("users").doc(uid).get();
      const previousTier = userDoc.exists ? (userDoc.data().tier || null) : null;

      // Determine subscription status and trial end
      const sub = session.subscription;
      const subStatus = sub?.status || "active";
      let trialEnd = null;
      if (subStatus === "trialing" && sub?.trial_end) {
        trialEnd = new Date(sub.trial_end * 1000).toISOString();
      }

      const updateData = {
        tier: tier,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: sub?.id || sub,
        subscriptionStatus: subStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (trialEnd) {
        updateData.trialEnd = trialEnd;
      }

      await db.collection("users").doc(uid).update(updateData);

      console.log(`User ${uid} verified and upgraded to ${tier}`);

      // Send upgrade confirmation email
      try {
        const email = user.email;
        if (email) {
          const tierDisplay = tier.charAt(0).toUpperCase() + tier.slice(1);
          const html = upgradeConfirmationEmailHtml(user.name || user.email, tier, previousTier);
          await sendEmail(email, `🎉 Welcome to ${tierDisplay}! Your upgrade is confirmed`, html, { category: "upgrade_confirmation" });
          console.log(`Upgrade confirmation email sent to ${email} for ${previousTier} → ${tier}`);
        }
      } catch (emailErr) {
        console.error("Failed to send upgrade confirmation email:", emailErr);
      }

      sendSuccess(res, { tier: tier, status: "active" });
    } catch (err) {
      console.error("verifyCheckout error:", err);
      sendError(res, 500, err.message || "Failed to verify checkout.");
    }
  });
});


// ============================================================
// 4. SYNC SUBSCRIPTION
// ============================================================
exports.syncSubscription = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const user = await verifyAuth(req);
    if (!user) return sendError(res, 401, "You must be signed in.");

    const uid = user.uid;
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) return sendError(res, 404, "User not found.");

    const userData = userDoc.data();

    // Skip Stripe sync for manually overridden accounts (testers/internal)
    if (userData.manualOverride) {
      return sendSuccess(res, {
        tier: userData.tier,
        subscriptionStatus: userData.subscriptionStatus || "active",
        changed: false,
      });
    }

    const subscriptionId = userData.stripeSubscriptionId;
    const customerId = userData.stripeCustomerId;

    if (!subscriptionId && !customerId) {
      return sendSuccess(res, { tier: null, subscriptionStatus: "none", changed: false });
    }

    try {
      const stripeClient = getStripe();
      let subscription = null;

      if (subscriptionId) {
        try {
          subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
        } catch (err) {
          console.warn(`Subscription ${subscriptionId} not found:`, err.message);
        }
      }

      if (!subscription && customerId) {
        try {
          const subs = await stripeClient.subscriptions.list({
            customer: customerId,
            status: "all",
            limit: 1,
          });
          if (subs.data.length > 0) subscription = subs.data[0];
        } catch (err) {
          console.warn(`Could not list subscriptions for customer ${customerId}:`, err.message);
        }
      }

      if (!subscription) {
        const wasChanged = userData.tier !== null || userData.subscriptionStatus !== "expired";
        if (wasChanged) {
          await db.collection("users").doc(uid).update({
            tier: null,
            subscriptionStatus: "expired",
            stripeSubscriptionId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        return sendSuccess(res, { tier: null, subscriptionStatus: "expired", changed: wasChanged });
      }

      const priceId = subscription.items?.data?.[0]?.price?.id;
      const stripeTier = getTierFromPriceId(priceId) || subscription.metadata?.tier || userData.tier;
      const stripeStatus = subscription.status;

      let newTier = stripeTier;
      let newStatus = stripeStatus;

      // Handle trial status
      let trialEnd = null;
      if (stripeStatus === "trialing" && subscription.trial_end) {
        trialEnd = new Date(subscription.trial_end * 1000).toISOString();
      }

      if (stripeStatus === "canceled" || stripeStatus === "unpaid" || stripeStatus === "incomplete_expired") {
        newTier = null;
        newStatus = "expired";
      }

      const changed = userData.tier !== newTier || userData.subscriptionStatus !== newStatus;

      if (changed) {
        const update = {
          tier: newTier,
          subscriptionStatus: newStatus,
          stripeSubscriptionId: subscription.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (stripeStatus === "active" || stripeStatus === "trialing") {
          update.currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
        }

        if (trialEnd) {
          update.trialEnd = trialEnd;
        }

        if (newTier === null) {
          update.stripeSubscriptionId = null;
        }

        await db.collection("users").doc(uid).update(update);
        console.log(`Synced user ${uid}: tier=${newTier}, status=${newStatus}`);
      }

      sendSuccess(res, { tier: newTier, subscriptionStatus: newStatus, trialEnd: trialEnd, changed: changed });
    } catch (err) {
      console.error("syncSubscription error:", err);
      sendError(res, 500, err.message || "Failed to sync subscription.");
    }
  });
});

// NOTE: The former mintExtensionToken Cloud Function has been removed.
// The Chrome extension no longer authenticates to Firebase directly —
// instead it scrapes listing data and forwards the result to an already
// authenticated CRM tab which writes to Firestore on the user's behalf.
// This sidesteps Google's IAM restrictions on new Cloud Functions and
// makes the extension simpler (no auth state to manage).

// ============================================================
// AI ENRICHMENT PROXY — Claude API (Haiku 4.5)
// ============================================================
// The extension sends listing text to this endpoint; we call Claude
// with our server-side API key and return the structured JSON result.
// This keeps the API key private and lets all users share one key.
// The user must be authenticated (Firebase ID token) to use this.
//
// Environment variable required: CLAUDE_API_KEY
// Set via: firebase functions:secrets:set CLAUDE_API_KEY
// ============================================================
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_MAX_TOKENS = 2048;

exports.aiEnrich = functions
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      // Only accept POST
      if (req.method !== "POST") {
        return sendError(res, 405, "Method not allowed");
      }

      // Verify Firebase Auth token
      const user = await verifyAuth(req);
      if (!user) {
        return sendError(res, 401, "Must be logged in.");
      }

      // Support both onCall-style { data: {...} } and direct body
      const body = req.body.data || req.body;
      const { systemPrompt, userPrompt } = body || {};
      if (!systemPrompt || !userPrompt) {
        return res.status(400).json({ error: { message: "Missing systemPrompt or userPrompt" }, model: CLAUDE_MODEL });
      }

      // Rate limit: simple per-user throttle via Firestore
      const uid = user.uid;
      const todayKey = new Date().toISOString().slice(0, 10);
      const usageRef = db.collection("aiUsage").doc(`${uid}_${todayKey}`);
      try {
        const usageSnap = await usageRef.get();
        const currentCount = usageSnap.exists ? (usageSnap.data().count || 0) : 0;
        const DAILY_LIMIT = 200;
        if (currentCount >= DAILY_LIMIT) {
          return sendError(res, 429, `Daily AI enrichment limit reached (${DAILY_LIMIT}/day). Resets at midnight UTC.`);
        }
        await usageRef.set({ count: currentCount + 1, uid, date: todayKey }, { merge: true });
      } catch (usageErr) {
        console.warn("AI usage tracking error (non-fatal):", usageErr.message);
      }

      // Get API key from environment
      const apiKey = process.env.CLAUDE_API_KEY;
      if (!apiKey) {
        console.error("CLAUDE_API_KEY not set in environment");
        return sendError(res, 500, "AI service not configured. Contact support.");
      }

      // Call Claude API
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 50000);

        const claudeResp = await fetch(CLAUDE_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: CLAUDE_MAX_TOKENS,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
        });
        clearTimeout(timeout);

        if (!claudeResp.ok) {
          const errBody = await claudeResp.text().catch(() => "");
          console.error("Claude API error:", claudeResp.status, errBody.slice(0, 300));
          return sendError(res, 502, "AI service error (HTTP " + claudeResp.status + ")");
        }

        const claudeJson = await claudeResp.json();
        const content = claudeJson && claudeJson.content && claudeJson.content[0] && claudeJson.content[0].text;
        if (!content) {
          return sendError(res, 500, "Empty response from AI service");
        }

        // Parse the JSON from Claude's response
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (_) {
          const m = content.match(/\{[\s\S]*\}/);
          if (!m) {
            return sendError(res, 500, "AI service did not return valid JSON");
          }
          parsed = JSON.parse(m[0]);
        }

        return sendSuccess(res, { result: parsed, model: CLAUDE_MODEL });
      } catch (err) {
        console.error("aiEnrich error:", err.message || err);
        if (err.name === "AbortError") {
          return sendError(res, 504, "AI service timed out");
        }
        return sendError(res, 500, "AI enrichment failed: " + (err.message || "Unknown error"));
      }
    });
  });

// ============================================================
// MEETING RSVP INBOUND WEBHOOK (SendGrid Inbound Parse)
// ============================================================
// Receives the RSVP emails invitees' calendar apps send to the meeting organizer
// address (rsvp@parse.rentingradar.com). Parses the .ics REPLY/COUNTER, matches
// the meeting by UID, records each attendee's response on meetingInvites/{id},
// and emails the meeting owner. Runs as a Cloud Function so it authenticates to
// Firestore via the runtime service account — no downloadable key needed.
//
// SendGrid Inbound Parse → Destination URL:
//   https://us-central1-rentingradar.cloudfunctions.net/inboundRsvp

function _rsvpUnfold(s) {
  return String(s || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}
function _rsvpGetLine(ics, prop) {
  const m = ics.match(new RegExp("^" + prop + "[;:].*$", "mi"));
  return m ? m[0] : "";
}
function _rsvpGetAll(ics, prop) {
  return ics.match(new RegExp("^" + prop + "[;:].*$", "gmi")) || [];
}
function _rsvpValue(line) {
  const i = line.indexOf(":");
  return i >= 0 ? line.slice(i + 1).trim() : "";
}
function _rsvpParam(line, param) {
  const m = line.match(new RegExp("[;]" + param + "=([^;:]+)", "i"));
  return m ? m[1] : "";
}
function _rsvpEsc(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const _RSVP_LABEL = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentative", "NEEDS-ACTION": "invited" };

// Convert a wall-clock time in an IANA tz to a UTC Date (DST-aware).
function _rsvpWallToUTC(Y, Mo, D, H, Mi, tz) {
  const asUTC = Date.UTC(Y, Mo - 1, D, H, Mi, 0);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const map = {};
  dtf.formatToParts(new Date(asUTC)).forEach((p) => { map[p.type] = p.value; });
  const h24 = map.hour === "24" ? "00" : map.hour;
  const tzWallAsUTC = Date.UTC(+map.year, (+map.month) - 1, +map.day, +h24, +map.minute, +map.second);
  return new Date(asUTC - (tzWallAsUTC - asUTC));
}
// Parse a COUNTER's DTSTART line into a UTC Date. Handles ...Z (UTC),
// ;TZID=Zone: (local in zone), and bare local (treated as the given tz).
function _rsvpParseDt(dtLine, fallbackTz) {
  const val = _rsvpValue(dtLine);
  const m = val.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], z = m[7];
  if (z === "Z") return new Date(Date.UTC(Y, Mo - 1, D, H, Mi, 0));
  const tzid = _rsvpParam(dtLine, "TZID") || fallbackTz;
  if (tzid) { try { return _rsvpWallToUTC(Y, Mo, D, H, Mi, tzid); } catch (e) { /* fall through */ } }
  return new Date(Date.UTC(Y, Mo - 1, D, H, Mi, 0));
}
function _rsvpFmtWhen(date, tz) {
  if (!date || isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/New_York", dateStyle: "medium", timeStyle: "short", timeZoneName: "short" }).format(date);
  } catch (e) { return date.toISOString(); }
}

function _parseInbound(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers }); }
    catch (e) { return reject(e); }
    const fields = {};
    const files = [];
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => files.push({
        filename: (info && info.filename) || "",
        mimeType: (info && info.mimeType) || "",
        content: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    bb.on("close", () => resolve({ fields, files }));
    bb.on("finish", () => resolve({ fields, files }));
    bb.on("error", reject);
    // Cloud Functions has already buffered the body into req.rawBody.
    bb.end(req.rawBody);
  });
}

exports.inboundRsvp = functions
  .runWith({ timeoutSeconds: 30, memory: "256MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

    let parsed;
    try { parsed = await _parseInbound(req); }
    catch (e) {
      console.error("[inboundRsvp] parse failed", e.message);
      res.status(200).json({ ok: false, reason: "parse_failed" }); return;
    }

    // Locate the .ics (attachment, or inline in a field).
    let icsRaw = "";
    for (const f of parsed.files) {
      if (/text\/calendar/i.test(f.mimeType) || /\.ics$/i.test(f.filename) || /BEGIN:VCALENDAR/i.test(f.content)) {
        icsRaw = f.content; break;
      }
    }
    if (!icsRaw) {
      for (const k of Object.keys(parsed.fields)) {
        if (/BEGIN:VCALENDAR/i.test(parsed.fields[k])) { icsRaw = parsed.fields[k]; break; }
      }
    }
    if (!icsRaw) { res.status(200).json({ ok: false, reason: "no_ics" }); return; }

    const ics = _rsvpUnfold(icsRaw);
    const method = (_rsvpValue(_rsvpGetLine(ics, "METHOD")) || "").toUpperCase();
    const uid = _rsvpValue(_rsvpGetLine(ics, "UID"));
    const mm = uid.match(/rr-meeting-(.+?)@/);
    if (!mm) { res.status(200).json({ ok: false, reason: "foreign_uid" }); return; }
    const meetingId = mm[1];

    let responder = "", partstat = "", responderName = "";
    for (const line of _rsvpGetAll(ics, "ATTENDEE")) {
      const mailto = _rsvpValue(line).replace(/^mailto:/i, "").trim().toLowerCase();
      if (mailto) { responder = mailto; partstat = (_rsvpParam(line, "PARTSTAT") || "").toUpperCase(); responderName = _rsvpParam(line, "CN") || ""; break; }
    }
    // Raw DTSTART line of a COUNTER proposal (parsed to a UTC instant once we
    // know the meeting's timezone, inside the transaction below).
    const proposedDtLine = method === "COUNTER" ? _rsvpGetLine(ics, "DTSTART") : "";
    if (!responder) { res.status(200).json({ ok: false, reason: "no_attendee" }); return; }

    const humanStatus = method === "COUNTER" ? "proposed-new-time" : (_RSVP_LABEL[partstat] || partstat.toLowerCase() || "responded");

    const inviteRef = db.collection("meetingInvites").doc(meetingId);
    let inviteData = null;
    let proposedDate = null;   // UTC Date of the proposed time, for email + storage
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(inviteRef);
        if (!snap.exists) return;
        inviteData = snap.data();
        if (proposedDtLine) proposedDate = _rsvpParseDt(proposedDtLine, inviteData.timezone);
        const proposedISO = proposedDate ? proposedDate.toISOString() : null;
        const attendees = Array.isArray(inviteData.attendees) ? inviteData.attendees.slice() : [];
        const nowIso = new Date().toISOString();
        let found = false;
        for (const a of attendees) {
          if (a && a.email && a.email.toLowerCase() === responder) {
            a.status = humanStatus; a.respondedAt = nowIso;
            a.proposedStartISO = proposedISO;
            found = true; break;
          }
        }
        if (!found) attendees.push({ email: responder, status: humanStatus, respondedAt: nowIso, proposedStartISO: proposedISO });
        tx.update(inviteRef, { attendees: attendees, lastResponseAt: nowIso });
      });
    } catch (e) {
      console.error("[inboundRsvp] firestore tx failed", e.message);
    }
    // If the invite doc had no tz (older meetings), still parse best-effort for email.
    if (method === "COUNTER" && !proposedDate && proposedDtLine) proposedDate = _rsvpParseDt(proposedDtLine, (inviteData && inviteData.timezone) || "America/New_York");

    // Email the owner.
    try {
      if (inviteData && inviteData.ownerEmail) {
        const who = responderName ? (responderName + " (" + responder + ")") : responder;
        const title = inviteData.title || "your meeting";
        let verb, prefix;
        if (method === "COUNTER") { verb = "proposed a new time for"; prefix = "⏰ New time proposed: "; }
        else if (partstat === "ACCEPTED") { verb = "accepted"; prefix = "✅ Accepted: "; }
        else if (partstat === "DECLINED") { verb = "declined"; prefix = "❌ Declined: "; }
        else if (partstat === "TENTATIVE") { verb = "tentatively accepted"; prefix = "🔶 Tentative: "; }
        else { verb = "responded to"; prefix = "📩 Response: "; }
        const proposedWhen = (method === "COUNTER" && proposedDate) ? _rsvpFmtWhen(proposedDate, inviteData.timezone) : "";
        const extra = proposedWhen ? ('<p style="margin:12px 0 0;font-size:15px;color:#e2e4eb"><strong>Proposed new time:</strong> ' + _rsvpEsc(proposedWhen) + '</p><p style="margin:6px 0 0;font-size:13px;color:#9399b2">Open the meeting in RentingRadar to accept this time (updates everyone\'s calendar) or offer another.</p>') : "";
        const html =
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0d1017;padding:32px 20px">' +
          '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
          '<table width="560" cellpadding="0" cellspacing="0" style="background:#141824;border-radius:12px;overflow:hidden">' +
          '<tr><td style="padding:26px 28px">' +
            '<p style="margin:0 0 6px;font-size:13px;color:#4b5068;text-transform:uppercase;letter-spacing:.5px">Meeting response</p>' +
            '<p style="margin:0;font-size:17px;font-weight:700;color:#e2e4eb">' + _rsvpEsc(who) + ' ' + verb + ' &ldquo;' + _rsvpEsc(title) + '&rdquo;</p>' + extra +
            '<p style="margin:16px 0 0;font-size:13px;color:#9399b2">See live guest status on the meeting in RentingRadar.</p>' +
          '</td></tr>' +
          '<tr><td style="padding:16px 28px;border-top:1px solid #252a3d"><p style="margin:0;font-size:12px;color:#4b5068">RentingRadar &middot; help@rentingradar.com</p></td></tr>' +
          '</table></td></tr></table></div>';
        await sendEmail(inviteData.ownerEmail, prefix + title, html, { category: "meeting_rsvp" });
      } else {
        console.warn("[inboundRsvp] no invite doc / ownerEmail for " + meetingId);
      }
    } catch (e) {
      console.error("[inboundRsvp] owner email failed", e.message);
    }

    res.status(200).json({ ok: true });
  });

// ============================================================
// CHAT PUSH NOTIFICATIONS (web push -> admin's phone PWA)
// ============================================================
// Two triggers send DATA-ONLY web-push (no `notification` key, so the service
// worker shows exactly one notification per push — also what iOS requires) to
// every registered admin device token in adminPushTokens/:
//   1. escalationPush  — when a conversation flips to needsHuman:true (Sabrina
//      hands off). Title "Chat Assist: <full name>", no message preview.
//   2. messagePush     — each new CUSTOMER message while the admin has TAKEN
//      OVER (aiEnabled === false) and the chat is still open. Title
//      "<full name>", body = message preview. The client suppresses display
//      when that exact chat is already on screen.
// Tapping any notification deep-links to ?chat=<id>.

// Shared sender: pushes a data payload to all admin device tokens and prunes
// any tokens FCM reports as dead. `tag` is used by the SW to group/replace.
async function pushToAdmins(label, dataObj) {
  let tokenDocs;
  try {
    tokenDocs = await db.collection("adminPushTokens").get();
  } catch (e) {
    console.error("[" + label + "] token read failed", e.message);
    return;
  }
  const tokens = [];
  tokenDocs.forEach((d) => { const t = (d.data() || {}).token || d.id; if (t) tokens.push(t); });
  if (!tokens.length) {
    console.log("[" + label + "] no admin device tokens registered");
    return;
  }

  const message = {
    tokens: tokens,
    data: dataObj,
    webpush: {
      headers: { Urgency: "high", TTL: "1800" },
      // Declared, user-visible notification. iOS web push delivers a message with
      // a `notification` payload FAR more promptly than a data-only one — a
      // data-only push makes iOS wake the service worker to render the UI, which
      // Apple deprioritizes/batches (the cause of the "extremely late" alerts).
      // The SW keeps the app-icon badge in sync via its raw 'push' listener.
      notification: {
        title: dataObj.title || "Chat Assist",
        body: dataObj.body || "",
        tag: dataObj.tag || (dataObj.conversationId ? ("rr-" + dataObj.conversationId) : "rr-chat"),
        icon: "/apple-touch-icon.png",
        badge: "/favicon-32.png",
        renotify: true,
      },
      // NOTE: deliberately NO fcmOptions.link — the SW's own notificationclick
      // handler owns tap routing (focus existing window + deep-link, or open
      // /?chat=<id>). Setting a link here makes FCM's built-in click handler ALSO
      // fire, which can open a duplicate/rootless window.
    },
  };

  let resp;
  try {
    resp = await admin.messaging().sendEachForMulticast(message);
  } catch (e) {
    console.error("[" + label + "] send failed", e.message);
    return;
  }

  const stale = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      console.warn("[" + label + "] send failed code=" + code + " msg=" + (r.error && r.error.message));
      if (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument") {
        stale.push(tokens[i]);
      }
    }
  });
  if (stale.length) {
    const batch = db.batch();
    stale.forEach((t) => batch.delete(db.collection("adminPushTokens").doc(t)));
    try { await batch.commit(); } catch (e) { console.warn("[" + label + "] prune failed", e.message); }
  }

  console.log("[" + label + "] tokens=" + tokens.length + " sent=" + resp.successCount + " failed=" + resp.failureCount + " pruned=" + stale.length);
}

function convIsOpen(c) {
  return c && c.status !== "completed" && c.status !== "resolved" && c.status !== "closed";
}
function _tsMs(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (t._seconds) return t._seconds * 1000;
  if (t.seconds) return t.seconds * 1000;
  return 0;
}
// Current count of open conversations awaiting a human → home-screen app badge.
async function countOpenEscalations() {
  try {
    const esc = await db.collection("chatConversations").where("needsHuman", "==", true).limit(100).get();
    let n = 0;
    esc.forEach((d) => { if (convIsOpen(d.data() || {})) n++; });
    return n;
  } catch (e) { return 0; }
}

// ── Operations cap — BACKEND enforcement ──────────────────────────────────────
// The client gates moves to Operations (Basic 1 · Standard 5 · everyone else
// unlimited), but a determined user could write Firestore directly. This trigger
// makes it airtight: it watches the single records doc and reverts any over-cap
// Operations additions back to Prospecting. Grandfathered: it never forces a user
// below the count they already had — it only undoes NEW additions beyond the cap.
// See [[project-operations-paywall]] in memory. Keep limits in sync with the
// client's OPERATIONS_LIMITS / getOperationsLimit().
function opsLimitForUserData(data) {
  if (!data) return Infinity;
  if (data.manualOverride) return Infinity;          // comped/admin-managed accounts
  if (data.subscriptionStatus === "trialing") return Infinity; // trial = full access
  if (data.tier === "basic") return 1;
  if (data.tier === "standard") return 5;
  return Infinity;                                    // pro / affiliate / admin / null → uncapped
}

exports.enforceOperationsCap = functions.firestore
  .document("users/{uid}/properties/records")
  .onWrite(async (change, context) => {
    const afterSnap = change.after;
    if (!afterSnap.exists) return null;
    const after = afterSnap.data() || {};
    const records = Array.isArray(after.records) ? after.records : null;
    if (!records) return null;

    const isOps = (r) => r && r.stage === "operations";
    const afterOps = records.filter(isOps);
    // Fast path: with the smallest cap being 1, anything <=1 can never violate —
    // skip the user-doc read for the overwhelming majority of saves.
    if (afterOps.length <= 1) return null;

    let userData = null;
    try {
      const u = await db.collection("users").doc(context.params.uid).get();
      userData = u.exists ? u.data() : null;
    } catch (e) {
      console.error("[enforceOperationsCap] user read failed", e.message);
      return null;
    }
    const limit = opsLimitForUserData(userData);
    if (limit === Infinity || afterOps.length <= limit) return null;

    // Grandfather: never force below what they already had — only undo NEW adds.
    const before = change.before.exists ? (change.before.data() || {}) : {};
    const beforeRecords = Array.isArray(before.records) ? before.records : [];
    const beforeOps = beforeRecords.filter(isOps);
    const allowed = Math.max(limit, beforeOps.length);
    if (afterOps.length <= allowed) return null;

    const beforeOpsIds = new Set(beforeOps.map((r) => r.id));
    let toRevert = afterOps.length - allowed;
    let reverted = 0;
    const corrected = records.map((r) => Object.assign({}, r));
    // Revert NEWLY-added ops first (ids not in Operations before), from the end
    // of the array (newest), restoring their prior Prospecting status.
    for (let i = corrected.length - 1; i >= 0 && toRevert > 0; i--) {
      const r = corrected[i];
      if (isOps(r) && !beforeOpsIds.has(r.id)) {
        r.stage = "prospecting";
        if (r._prevProspectingStatus) r.status = r._prevProspectingStatus;
        else if (r.status === "Operating") r.status = "New";
        r._opsCapReverted = true;
        toRevert--;
        reverted++;
      }
    }
    if (reverted === 0) return null; // nothing safe to revert (all grandfathered)
    try {
      await afterSnap.ref.set(Object.assign({}, after, { records: corrected }), { merge: false });
      console.log(`[enforceOperationsCap] uid=${context.params.uid} reverted ${reverted} over-cap Operations addition(s) (limit=${limit}, was ${afterOps.length})`);
    } catch (e) {
      console.error("[enforceOperationsCap] revert write failed", e.message);
    }
    return null;
  });

// 1. Escalation + de-escalation pushes (one onUpdate trigger).
exports.escalationPush = functions.firestore
  .document("chatConversations/{convId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const convId = context.params.convId;
    const fullName = after.userName || after.userEmail || "A customer";

    // Diagnostic: log ONLY when an escalation-relevant field changes (otherwise
    // the high volume of routine conv updates floods out the escalation event).
    if (before.needsHuman !== after.needsHuman ||
        _tsMs(before.needsHumanAt) !== _tsMs(after.needsHumanAt) ||
        _tsMs(before.deEscalatedAt) !== _tsMs(after.deEscalatedAt)) {
      console.log(`[escalationPush] CHANGE conv=${convId} needsHuman ${before.needsHuman}->${after.needsHuman} needsHumanAt ${_tsMs(before.needsHumanAt)}->${_tsMs(after.needsHumanAt)} status=${after.status} humanJoined=${after.humanJoined} deEscAt ${_tsMs(before.deEscalatedAt)}->${_tsMs(after.deEscalatedAt)}`);
    }

    // DE-ESCALATION: the user told Sabrina they no longer need a person
    // (deEscalatedAt newly set) and no human had joined. Tell the admin to
    // disregard, and refresh the badge (which just dropped).
    const deescalated = _tsMs(after.deEscalatedAt) > _tsMs(before.deEscalatedAt) && after.humanJoined !== true;
    if (deescalated) {
      const badge = await countOpenEscalations();
      await pushToAdmins("escalationPush:deescalate", {
        kind: "deescalation",
        title: "Disregard Chat Assist: " + fullName,
        body: "",
        conversationId: convId,
        tag: "rr-escalation-" + convId, // replaces the original "Chat Assist" alert
        url: "/?chat=" + convId,
        badge: String(badge),
      });
      return null;
    }

    // ESCALATION trigger. Fire when the chat needs a human and this update is a
    // genuine escalation EVENT — either the boolean rose false->true, OR a fresh
    // needsHumanAt timestamp was written (covers re-escalations and the case where
    // needsHuman was already true so the boolean edge wouldn't fire).
    // NOTE: we do NOT gate on convIsOpen here. needsHuman:true is an explicit,
    // current "I want a human" signal; a customer can escalate inside a chat that
    // was marked completed (the widget reopens it), and that push is exactly the
    // one we must deliver. The old convIsOpen gate was silently blocking these.
    const roseToNeedsHuman = after.needsHuman === true && before.needsHuman !== true;
    // Trigger purely on needsHumanAt advancing. That field is written ONLY by the
    // two escalation paths, so a newer timestamp == a real escalation event. We do
    // NOT also require after.needsHuman===true: a near-simultaneous take-over write
    // (needsHuman:false, humanJoined:true) can flip the flag before this snapshot
    // is evaluated, which was suppressing the push entirely.
    const needsHumanAtAdvanced = _tsMs(after.needsHumanAt) > _tsMs(before.needsHumanAt);
    if (!roseToNeedsHuman && !needsHumanAtAdvanced) return null;
    console.log(`[escalationPush] FIRING conv=${convId} rose=${roseToNeedsHuman} nhAtAdvanced=${needsHumanAtAdvanced} status=${after.status}`);

    const badge = (await countOpenEscalations()) || 1;
    await pushToAdmins("escalationPush", {
      kind: "escalation",
      title: "Chat Assist: " + fullName,
      body: "",
      conversationId: convId,
      tag: "rr-escalation-" + convId,
      url: "/?chat=" + convId,
      badge: String(badge),
    });

    // RELIABLE BACKUP CHANNEL — email (SendGrid), in addition to web push. iOS
    // web push can be dropped/delayed when the PWA has been closed a while; email
    // always arrives, so an escalation reaches the admin even if the push doesn't.
    try {
      const safeName = String(fullName).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      const html =
        '<div style="font-family:system-ui,Arial,sans-serif;color:#111">' +
        '<p style="font-size:16px"><strong>' + safeName + '</strong> is waiting for a human in RentingRadar support chat.</p>' +
        '<p><a href="https://app.rentingradar.com/?chat=' + convId + '" style="display:inline-block;background:#6381fa;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Open the conversation</a></p>' +
        "</div>";
      await sendEmail("help@rentingradar.com", "Chat needs a human: " + fullName, html, {});
    } catch (e) {
      console.warn("[escalationPush] email backup failed", e.message);
    }
    return null;
  });

// 2. Per-message — a customer replies in a chat the admin has taken over.
exports.messagePush = functions.firestore
  .document("chatConversations/{convId}/messages/{msgId}")
  .onCreate(async (snap, context) => {
    const msg = snap.data() || {};
    // Only customer messages (not admin/ai/system/presence).
    if (msg.senderType !== "user") return null;

    const convId = context.params.convId;
    let conv;
    try {
      const cdoc = await db.collection("chatConversations").doc(convId).get();
      conv = cdoc.exists ? cdoc.data() : null;
    } catch (e) {
      console.error("[messagePush] conv read failed", e.message);
      return null;
    }
    if (!conv) return null;

    // Only while a human has TAKEN OVER (Sabrina disabled) and chat is open.
    // (When Sabrina is still handling it, escalationPush covers the handoff and
    //  Sabrina answers normally — no per-message admin alert wanted.)
    if (conv.aiEnabled !== false || !convIsOpen(conv)) return null;

    const fullName = conv.userName || conv.userEmail || "Customer";
    const preview = String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 140) || "New message";

    await pushToAdmins("messagePush", {
      kind: "message",
      title: fullName,
      body: preview,
      conversationId: convId,
      tag: "rr-msg-" + convId + "-" + context.params.msgId,
      url: "/?chat=" + convId,
    });
    return null;
  });

// ============================================================
// CHAT RE-ENGAGEMENT (no human after a long wait)
// ============================================================
// Runs every minute. Two server-driven transitions (reliable even if the user's
// browser is closed):
//   Stage 1 — escalated & no human for >10 min: Sabrina takes the chat back
//     (aiEnabled:true, de-escalate so the "average wait time" line disappears),
//     marks reengageStage:'prompted', and asks if they'd like to keep waiting.
//   Stage 2 — prompted & user silent for >5 min: Sabrina sends the closing line.
// "Yes, I'll wait" is handled client/LLM-side: it re-escalates (refreshing
// needsHumanAt + clearing reengageStage), which re-fires escalationPush and
// restarts the 10-min cycle. "No" / decline closes it via the client.
exports.chatReengage = functions.pubsub.schedule("every 1 minutes").onRun(async () => {
  const REENGAGE_PROMPT = "Looks like all our team members are busy assisting others at the moment. Would you like to continue to wait?";
  // Silence close (the user never replied) — must NOT open with "Ok!" since
  // there's nothing to acknowledge; it speaks to the lack of a response instead.
  const REENGAGE_CLOSE = "I haven't heard back, so I'll step back for now — but I'm always here whenever you need me, and you can email help@rentingradar.com anytime and we'll assist you as soon as possible.";
  const TEN_MIN = 10 * 60 * 1000;
  const FIVE_MIN = 5 * 60 * 1000;
  const now = Date.now();
  const toMs = (t) => {
    if (!t) return 0;
    if (typeof t === "number") return t;
    if (typeof t.toMillis === "function") return t.toMillis();
    if (t._seconds) return t._seconds * 1000;
    if (t.seconds) return t.seconds * 1000;
    return 0;
  };
  const isOpen = (c) => c.status !== "completed" && c.status !== "resolved" && c.status !== "closed";

  // Two targeted queries (single-field indexes, auto-created) keep reads tiny —
  // only escalated or already-prompted conversations, not the whole collection.
  let stage1Docs = [], stage2Docs = [];
  try {
    const [s1, s2] = await Promise.all([
      db.collection("chatConversations").where("escalated", "==", true).limit(300).get(),
      db.collection("chatConversations").where("reengageStage", "==", "prompted").limit(300).get(),
    ]);
    stage1Docs = s1.docs; stage2Docs = s2.docs;
  } catch (e) {
    console.error("[chatReengage] query failed", e.message);
    return null;
  }

  let acted = 0;
  for (const doc of stage1Docs) {
    const c = doc.data() || {};
    if (!isOpen(c) || c.humanJoined === true) continue;
    const ref = doc.ref;

    // Stage 1 — waited too long with no human, not yet prompted.
    if (c.escalated === true && !c.reengageStage && toMs(c.needsHumanAt) && (now - toMs(c.needsHumanAt) >= TEN_MIN)) {
      try {
        const ts = admin.firestore.FieldValue.serverTimestamp();
        await ref.collection("messages").add({
          conversationId: doc.id, conversationUserId: c.userId || null,
          senderType: "ai", senderName: "Sabrina", content: REENGAGE_PROMPT,
          timestamp: ts, metadata: { reengage: "prompt" },
        });
        await ref.update({
          aiEnabled: true, needsHuman: false, escalated: false,
          reengageStage: "prompted", reengagePromptedAt: ts,
          lastMessageAt: ts, lastMessagePreview: REENGAGE_PROMPT.slice(0, 140),
          lastMessageSender: "ai", unreadByUser: admin.firestore.FieldValue.increment(1),
          updatedAt: ts,
        });
        acted++;
      } catch (e) { console.error("[chatReengage] stage1 failed", doc.id, e.message); }
    }
  }

  for (const doc of stage2Docs) {
    const c = doc.data() || {};
    if (!isOpen(c) || c.humanJoined === true) continue;
    const ref = doc.ref;
    // Stage 2 — prompted, user has been silent past the window.
    if (c.reengageStage === "prompted" && toMs(c.reengagePromptedAt) && (now - toMs(c.reengagePromptedAt) >= FIVE_MIN)) {
      const userReplied = toMs(c.lastUserMessageAt) > toMs(c.reengagePromptedAt);
      if (userReplied) {
        // They answered — the client/LLM handles re-escalate vs. decline; just
        // clear the stage so we don't auto-close on top of their conversation.
        try { await ref.update({ reengageStage: admin.firestore.FieldValue.delete() }); } catch (e) {}
        continue;
      }
      try {
        const ts = admin.firestore.FieldValue.serverTimestamp();
        await ref.collection("messages").add({
          conversationId: doc.id, conversationUserId: c.userId || null,
          senderType: "ai", senderName: "Sabrina", content: REENGAGE_CLOSE,
          timestamp: ts, metadata: { reengage: "close" },
        });
        await ref.update({
          reengageStage: "closed",
          lastMessageAt: ts, lastMessagePreview: REENGAGE_CLOSE.slice(0, 140),
          lastMessageSender: "ai", unreadByUser: admin.firestore.FieldValue.increment(1),
          updatedAt: ts,
        });
        acted++;
      } catch (e) { console.error("[chatReengage] stage2 failed", doc.id, e.message); }
    }
  }
  // Heartbeat every run so we can confirm it's scheduled + see what it sees.
  console.log("[chatReengage] run: escalated=" + stage1Docs.length + " prompted=" + stage2Docs.length + " acted=" + acted);
  return null;
});
