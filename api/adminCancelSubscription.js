const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

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

    res.status(200).json({
      result: {
        data: {
          success: true,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          status: subscription.status,
        },
      },
    });
  } catch (err) {
    console.error("adminCancelSubscription error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to cancel subscription." } });
  }
};
