const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  // Verify Firebase auth token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "You must be signed in to upgrade." } });
  }

  let user;
  try {
    user = await verifyFirebaseToken(authHeader.split("Bearer ")[1]);
  } catch (err) {
    return res.status(401).json({ error: { message: "Invalid auth token." } });
  }

  const body = req.body.data || req.body;
  const { tier, period, stripeCustomerId } = body;
  if (!tier || !period) return res.status(400).json({ error: { message: "Missing tier or period." } });

  const PRICE_IDS = {
    basic_monthly: process.env.BASIC_MONTHLY_PRICE,
    basic_yearly: process.env.BASIC_YEARLY_PRICE,
    pro_monthly: process.env.PRO_MONTHLY_PRICE,
    pro_yearly: process.env.PRO_YEARLY_PRICE,
  };

  const priceId = PRICE_IDS[`${tier}_${period}`];
  if (!priceId) return res.status(404).json({ error: { message: `No price for ${tier}/${period}.` } });

  try {
    let customerId = stripeCustomerId || null;

    // Verify the customer exists in Stripe, or create one
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch (e) {
        customerId = null; // Customer doesn't exist, create new
      }
    }

    if (!customerId) {
      // Check if customer already exists by email
      const existing = await stripe.customers.list({ email: user.email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { firebaseUID: user.uid },
        });
        customerId = customer.id;
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://app.rentingradar.com?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://app.rentingradar.com?checkout=cancelled",
      subscription_data: {
        metadata: { firebaseUID: user.uid, tier: tier },
      },
      metadata: { firebaseUID: user.uid, tier: tier },
    });

    res.status(200).json({
      result: {
        data: {
          url: session.url,
          stripeCustomerId: customerId,
        },
      },
    });
  } catch (err) {
    console.error("createCheckoutSession error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to create checkout session." } });
  }
};
