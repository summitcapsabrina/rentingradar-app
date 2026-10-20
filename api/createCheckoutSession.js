const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

// The 7-day trial is for first-time subscribers only. Checks every Stripe customer
// tied to this user (same Firebase UID or same email), since older checkouts could
// create more than one customer per person. Mirrors functions/index.js.
async function hasHadSubscription(customerId, uid, email) {
  const ids = new Set([customerId]);
  try {
    const byUid = await stripe.customers.search({ query: `metadata['firebaseUID']:'${uid}'`, limit: 10 });
    byUid.data.forEach((c) => ids.add(c.id));
  } catch (e) { console.warn("Trial check: customer search by UID failed:", e.message); }
  if (email) {
    const byEmail = await stripe.customers.list({ email, limit: 10 });
    byEmail.data.forEach((c) => ids.add(c.id));
  }
  for (const id of ids) {
    const subs = await stripe.subscriptions.list({ customer: id, status: "all", limit: 1 });
    if (subs.data.length) return true;
  }
  return false;
}

// Checkout requires agreeing to the Terms (consent checkbox). Stripe rejects this
// unless a Terms of Service URL is set in Dashboard > Settings > Public details.
const TOS_CONSENT = {
  consent_collection: { terms_of_service: "required" },
  custom_text: {
    terms_of_service_acceptance: {
      message: "I agree to the [Terms of Service](https://rentingradar.com/terms), including that my plan renews automatically until I cancel.",
    },
  },
};

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
  const { tier, period, stripeCustomerId, referralCode } = body;
  if (!tier || !period) return res.status(400).json({ error: { message: "Missing tier or period." } });

  const PRICE_IDS = {
    basic_monthly: process.env.BASIC_MONTHLY_PRICE,
    basic_yearly: process.env.BASIC_YEARLY_PRICE,
    standard_monthly: process.env.STANDARD_MONTHLY_PRICE,
    standard_yearly: process.env.STANDARD_YEARLY_PRICE,
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

    // Build the customer metadata, optionally including referral attribution.
    const customerMetadata = { firebaseUID: user.uid };
    if (referralCode) customerMetadata.referred_by = referralCode;

    if (!customerId) {
      // Check if customer already exists by email
      const existing = await stripe.customers.list({ email: user.email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
        // Backfill referral metadata if it's missing on an existing customer
        if (referralCode && !(existing.data[0].metadata && existing.data[0].metadata.referred_by)) {
          try { await stripe.customers.update(customerId, { metadata: customerMetadata }); } catch (e) { console.warn("Couldn't backfill customer metadata:", e); }
        }
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: customerMetadata,
        });
        customerId = customer.id;
      }
    }

    // Promotion codes are user-entered at the Stripe Checkout page (allow_promotion_codes
     // below). Referral attribution still happens via ?ref=CODE on signup — that sets
     // referredBy on the user doc and feeds Adam's Affiliate dashboard + commission report.
     // The metadata.referred_by tag carries that attribution onto the Stripe subscription
     // for cross-reference, separate from whatever promo code the user manually applies.
    // No second free trial for anyone who has subscribed before.
    let trialEligible = true;
    try {
      trialEligible = !(await hasHadSubscription(customerId, user.uid, user.email));
    } catch (e) {
      console.warn("Could not check prior subscriptions for trial eligibility:", e.message);
    }

    const sessionConfig = {
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://app.rentingradar.com?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://app.rentingradar.com?checkout=cancelled",
      subscription_data: {
        // Stripe-managed 7-day free trial (first subscription only). Card collected upfront,
        // no charge during the trial, auto-charge at day 7. Stripe handles dunning and retries.
        ...(trialEligible ? { trial_period_days: 7 } : {}),
        metadata: Object.assign({ firebaseUID: user.uid, tier: tier }, referralCode ? { referred_by: referralCode } : {}),
      },
      metadata: Object.assign({ firebaseUID: user.uid, tier: tier }, referralCode ? { referred_by: referralCode } : {}),
    };
    // Show the promotion-code input on Stripe Checkout so users can manually enter
    // AIRPRENEUR / AIRPRENEUR_YEAR or any other active code.
    sessionConfig.allow_promotion_codes = true;

    let session;
    try {
      session = await stripe.checkout.sessions.create(Object.assign({}, sessionConfig, TOS_CONSENT));
    } catch (e) {
      // Don't block checkout if the Terms URL isn't set in Stripe yet; log loudly instead.
      if (!/terms.of.service/i.test(e.message || "")) throw e;
      console.error("Checkout Terms consent rejected (set the Terms URL in Stripe > Settings > Public details). Retrying without it:", e.message);
      session = await stripe.checkout.sessions.create(sessionConfig);
    }

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
