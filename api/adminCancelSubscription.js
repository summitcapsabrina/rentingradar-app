const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const sgMail = require("@sendgrid/mail");
const { verifyFirebaseToken } = require("./verifyToken");

// Admin emails that are authorized to perform admin actions
const ADMIN_EMAILS = ["help@rentingradar.com"];

const FROM_EMAIL = { email: "help@rentingradar.com", name: "RentingRadar" };
const SITE_URL = "https://rentingradar.com";
const APP_URL = "https://app.rentingradar.com";

function emailWrapper(bodyHtml) {
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
      <a href="${APP_URL}#settings" class="text-accent" style="color:#6381fa;text-decoration:none">Email Preferences</a>
      &nbsp;&middot;&nbsp;
      <a href="${SITE_URL}/privacy/" class="text-accent" style="color:#6381fa;text-decoration:none">Privacy Policy</a>
      &nbsp;&middot;&nbsp;
      <a href="${SITE_URL}/terms/" class="text-accent" style="color:#6381fa;text-decoration:none">Terms of Service</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "You must be signed in." } });
  }

  let user;
  try {
    user = await verifyFirebaseToken(authHeader.split("Bearer ")[1]);
  } catch (err) {
    return res.status(401).json({ error: { message: "Invalid auth token." } });
  }

  // Verify admin
  if (!user.email || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: { message: "Admin access required." } });
  }

  const body = req.body.data || req.body;
  const { stripeSubscriptionId } = body;

  if (!stripeSubscriptionId) {
    return res.status(400).json({ error: { message: "No subscription ID provided." } });
  }

  try {
    // Cancel at end of current billing period
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    const periodEnd = new Date(subscription.current_period_end * 1000);
    const periodEndFormatted = periodEnd.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Calculate days remaining
    const now = new Date();
    const daysRemaining = Math.max(0, Math.ceil((periodEnd - now) / (1000 * 60 * 60 * 24)));

    // Get customer email from Stripe
    let customerEmail = null;
    let customerName = null;
    try {
      const customer = await stripe.customers.retrieve(subscription.customer);
      customerEmail = customer.email;
      customerName = customer.name;
    } catch (e) {
      console.error("Failed to retrieve customer:", e.message);
    }

    // Get plan name
    let planName = "your plan";
    try {
      if (subscription.items && subscription.items.data.length) {
        const price = subscription.items.data[0].price;
        if (price.product) {
          const product = await stripe.products.retrieve(price.product);
          planName = product.name || planName;
        }
      }
    } catch (e) {
      console.error("Failed to retrieve product name:", e.message);
    }

    // Send cancellation email to the user
    if (customerEmail) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        const firstName = customerName ? customerName.split(" ")[0] : null;
        const greeting = firstName ? `Hi ${firstName},` : "Hi,";

        const html = emailWrapper(`
          <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Subscription Cancelled</h2>
          <p style="margin:0 0 18px;color:#c8cbd6">${greeting}</p>
          <p style="margin:0 0 18px;color:#c8cbd6">Your <strong style="color:#e2e4eb">${planName}</strong> subscription has been cancelled. You'll still have full access to all your features until the end of your current billing period.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:10px;margin:20px 0">
            <tr>
              <td style="padding:20px 24px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:6px 0;color:#94a3b8;font-size:14px">Access until</td>
                    <td style="padding:6px 0;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600">${periodEndFormatted}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#94a3b8;font-size:14px">Days remaining</td>
                    <td style="padding:6px 0;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600">${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>

          <p style="margin:0 0 18px;color:#c8cbd6">After <strong style="color:#e2e4eb">${periodEndFormatted}</strong>, you'll no longer have access to your properties and analyses. You can resubscribe at any time to pick up where you left off.</p>

          <div style="text-align:center;margin:28px 0 8px">
            <a href="${APP_URL}#pricing" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6366f1,#6381fa);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Resubscribe</a>
          </div>

          <p style="margin:24px 0 0;color:#6b7280;font-size:13px;text-align:center">Questions? Reply to this email — we're here to help.</p>
        `);

        await sgMail.send({
          to: customerEmail,
          from: FROM_EMAIL,
          subject: "Your RentingRadar subscription has been cancelled",
          html: html,
          categories: ["subscription-cancelled"],
        });
        console.log("Cancellation email sent to", customerEmail);
      } catch (emailErr) {
        console.error("Failed to send cancellation email:", emailErr?.response?.body || emailErr.message);
        // Don't fail the request if email fails — cancellation already happened
      }
    }

    res.status(200).json({
      result: {
        data: {
          success: true,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: periodEnd.toISOString(),
          status: subscription.status,
          emailSent: !!customerEmail,
        },
      },
    });
  } catch (err) {
    console.error("adminCancelSubscription error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to cancel subscription." } });
  }
};
