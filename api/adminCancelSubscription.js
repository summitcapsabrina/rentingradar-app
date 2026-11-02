const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const sgMail = require("@sendgrid/mail");
const { verifyFirebaseToken } = require("./verifyToken");
const { emailWrapper, FROM_EMAIL, APP_URL } = require("./_lib/email");

// Admin emails that are authorized to perform admin actions
const ADMIN_EMAILS = ["help@rentingradar.com"];

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
