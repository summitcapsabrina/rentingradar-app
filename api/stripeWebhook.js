const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Stripe webhook - acknowledges events for logging/monitoring
// Firestore updates are handled client-side via syncSubscription on login

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`Stripe event received: ${event.type}`, JSON.stringify({
    type: event.type,
    id: event.id,
    customer: event.data.object?.customer,
    metadata: event.data.object?.metadata,
  }));

  // Acknowledge receipt — Firestore is updated client-side on next login
  res.status(200).json({ received: true });
};

module.exports.config = {
  api: { bodyParser: false },
};
