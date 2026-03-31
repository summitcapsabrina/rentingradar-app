const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

function getTierFromPriceId(priceId) {
  if (priceId === process.env.BASIC_MONTHLY_PRICE || priceId === process.env.BASIC_YEARLY_PRICE) return "basic";
  if (priceId === process.env.PRO_MONTHLY_PRICE || priceId === process.env.PRO_YEARLY_PRICE) return "pro";
  return null;
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

  const body = req.body.data || req.body;
  const { stripeCustomerId, stripeSubscriptionId } = body;

  // No Stripe data → free user
  if (!stripeSubscriptionId && !stripeCustomerId) {
    return res.status(200).json({ result: { data: { tier: "free", subscriptionStatus: "none", changed: false } } });
  }

  try {
    let subscription = null;

    // Try to retrieve by subscription ID first
    if (stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      } catch (err) {
        console.warn(`Subscription ${stripeSubscriptionId} not found:`, err.message);
      }
    }

    // Fallback: list subscriptions for customer
    if (!subscription && stripeCustomerId) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: "all",
          limit: 1,
        });
        if (subs.data.length > 0) subscription = subs.data[0];
      } catch (err) {
        console.warn(`Could not list subscriptions for customer ${stripeCustomerId}:`, err.message);
      }
    }

    // No subscription found → downgrade to free
    if (!subscription) {
      return res.status(200).json({
        result: {
          data: {
            tier: "free",
            subscriptionStatus: "cancelled",
            stripeSubscriptionId: null,
            changed: true,
          },
        },
      });
    }

    const priceId = subscription.items?.data?.[0]?.price?.id;
    let tier = getTierFromPriceId(priceId) || subscription.metadata?.tier || "free";
    let status = subscription.status;

    if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
      tier = "free";
      status = "cancelled";
    }

    res.status(200).json({
      result: {
        data: {
          tier: tier,
          subscriptionStatus: status,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          currentPeriodEnd: status === "active"
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
        },
      },
    });
  } catch (err) {
    console.error("syncSubscription error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to sync subscription." } });
  }
};
