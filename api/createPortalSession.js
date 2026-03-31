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
  const { stripeCustomerId } = body;

  if (!stripeCustomerId) {
    return res.status(400).json({ error: { message: "No billing account found. Subscribe to a paid plan first." } });
  }

  try {
    // Verify customer belongs to this user
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.metadata?.firebaseUID && customer.metadata.firebaseUID !== user.uid) {
      return res.status(403).json({ error: { message: "Customer does not belong to this user." } });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: "https://app.rentingradar.com#settings",
    });

    res.status(200).json({ result: { data: { url: session.url } } });
  } catch (err) {
    console.error("createPortalSession error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to create portal session." } });
  }
};
