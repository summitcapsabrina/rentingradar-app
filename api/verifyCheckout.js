const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

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
  const { sessionId } = body;
  if (!sessionId) return res.status(400).json({ error: { message: "Missing session ID." } });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if (session.metadata?.firebaseUID !== user.uid) {
      return res.status(403).json({ error: { message: "Session does not belong to this user." } });
    }

    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: { message: "Payment not completed." } });
    }

    const tier = session.metadata?.tier;
    if (!tier) return res.status(500).json({ error: { message: "No tier found in session." } });

    // Return all data needed for the client to update Firestore
    res.status(200).json({
      result: {
        data: {
          tier: tier,
          status: "active",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription?.id || session.subscription,
        },
      },
    });
  } catch (err) {
    console.error("verifyCheckout error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to verify checkout." } });
  }
};
