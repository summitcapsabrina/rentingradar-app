const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const stripe = require("stripe");
const cors = require("cors")({ origin: true });
const sgMail = require("@sendgrid/mail");

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

function welcomeEmailHtml(displayName) {
  const firstName = displayName ? displayName.split(" ")[0] : null;

  return emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">${firstName ? 'Welcome to RentingRadar, ' + firstName + '!' : 'Welcome to RentingRadar!'}</h2>
    <p style="margin:0 0 14px;color:#c8cbd6">We're excited to have you on board! To get started, choose a plan that fits your needs. Every plan comes with a <strong style="color:#34d399">free 7-day trial</strong> — no charge until your trial ends.</p>

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

    <p style="margin:0 0 8px;color:#ffffff;font-weight:600">Get started in 2 minutes</p>
    <p style="margin:0 0 16px;color:#c8cbd6">Once you've picked a plan, our interactive tutorial walks you through every feature so you can hit the ground running.</p>

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
      await sendEmail("help@rentingradar.com", `New Signup: ${testEmail}`, adminNotifHtml, { category: "admin-new-user" });
      res.status(200).json({ success: true, message: "Test admin notification sent to help@rentingradar.com" });
    } catch (err) {
      console.error("Test admin notification failed:", err?.response?.body || err.message);
      res.status(500).json({ error: err?.response?.body || err.message });
    }
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

  // Send welcome email immediately for all users
  try {
    initSendGrid();
    const html = welcomeEmailHtml(displayName);
    console.log("Sending welcome email to", email);
    await sendEmail(email, "🎉 Welcome to RentingRadar! Here's how to get started", html, { category: "welcome" });
    console.log("Welcome email sent successfully to", email);
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
    const adminEmails = ["help@rentingradar.com"];
    for (const adminEmail of adminEmails) {
      await sendEmail(adminEmail, `New Signup: ${email}`, adminNotifHtml, { category: "admin-new-user" });
    }
    console.log("Admin notification sent for new user:", email);
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
// 5b. WELCOME EMAIL — HTTP endpoint called by frontend
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
  if (!email) return null;

  const html = cancellationEmailHtml(displayName);
  await sendEmail(email, "👋 Your RentingRadar account has been cancelled", html);

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
    console.log("Running daily trial reminders...");

    const now = Date.now();

    // Target days: check users whose trialEnd falls on specific milestones
    // daysLeft > 0 means trial is still active, <= 0 means expired
    const checkpoints = [
      { daysFromEnd: 4, label: "day3_halfway" },       // 4 days left (sent on day 3)
      { daysFromEnd: 2, label: "day5_2days" },          // 2 days left (sent on day 5)
      { daysFromEnd: 0, label: "day7_expired" },        // Trial ends today
      { daysFromEnd: -7, label: "week_after" },         // 1 week after expiration
      { daysFromEnd: -30, label: "month_after" },       // 1 month after expiration
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

      // Check if this user hits any checkpoint today (±0.5 day tolerance)
      let matchedCheckpoint = null;
      for (const cp of checkpoints) {
        if (Math.abs(daysLeft - cp.daysFromEnd) < 1) {
          matchedCheckpoint = cp;
          break;
        }
      }

      if (!matchedCheckpoint) { continue; }

      // Check if we already sent this specific reminder
      try {
        const existingEmail = await db.collection("emailLog")
          .where("uid", "==", uid)
          .where("type", "==", "trial_reminder_" + matchedCheckpoint.label)
          .limit(1)
          .get();
        if (!existingEmail.empty) { skipped++; continue; }
      } catch (err) {
        console.warn("Could not check existing trial emails for", uid, err);
      }

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

      const session = await stripeClient.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: "https://app.rentingradar.com?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://app.rentingradar.com?checkout=cancelled",
        subscription_data: {
          trial_period_days: 7,
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
