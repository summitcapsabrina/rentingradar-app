const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ============================================================
// CONFIGURATION — uses .env file in the functions/ directory
// Create functions/.env with:
//   STRIPE_SECRET_KEY=sk_live_...
//   BASIC_MONTHLY_PRICE=price_xxx
//   BASIC_YEARLY_PRICE=price_xxx
//   PRO_MONTHLY_PRICE=price_xxx
//   PRO_YEARLY_PRICE=price_xxx
// ============================================================
const getStripe = () => stripe(process.env.STRIPE_SECRET_KEY);

function getTierFromPriceId(priceId) {
  if (priceId === process.env.BASIC_MONTHLY_PRICE || priceId === process.env.BASIC_YEARLY_PRICE) return "basic";
  if (priceId === process.env.PRO_MONTHLY_PRICE || priceId === process.env.PRO_YEARLY_PRICE) return "pro";
  return null;
}


// ============================================================
// 1. CREATE CHECKOUT SESSION
//    Called from the app when a user clicks Upgrade.
//    Expects: { tier: "basic"|"pro", period: "monthly"|"yearly" }
//    Returns: { url: "https://checkout.stripe.com/..." }
// ============================================================
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to upgrade.");
  }

  const { tier, period } = data;
  if (!tier || !period) {
    throw new functions.https.HttpsError("invalid-argument", "Missing tier or period.");
  }

  const PRICE_IDS = {
    basic_monthly: process.env.BASIC_MONTHLY_PRICE,
    basic_yearly: process.env.BASIC_YEARLY_PRICE,
    pro_monthly: process.env.PRO_MONTHLY_PRICE,
    pro_yearly: process.env.PRO_YEARLY_PRICE,
  };

  const priceKey = `${tier}_${period}`;
  const priceId = PRICE_IDS[priceKey];

  if (!priceId) {
    throw new functions.https.HttpsError("not-found", `No Stripe price configured for ${tier}/${period}.`);
  }

  const stripeClient = getStripe();
  const uid = context.auth.uid;
  const email = context.auth.token.email || "";

  // Check if user already has a Stripe customer ID
  const userDoc = await db.collection("users").doc(uid).get();
  let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

  // Create or retrieve the Stripe customer
  if (!customerId) {
    const customer = await stripeClient.customers.create({
      email: email,
      metadata: { firebaseUID: uid },
    });
    customerId = customer.id;
    await db.collection("users").doc(uid).update({ stripeCustomerId: customerId });
  }

  // Create the Checkout Session
  const session = await stripeClient.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://app.rentingradar.com?checkout=success&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://app.rentingradar.com?checkout=cancelled",
    subscription_data: {
      metadata: { firebaseUID: uid, tier: tier },
    },
    metadata: { firebaseUID: uid, tier: tier },
  });

  return { url: session.url };
});


// ============================================================
// 2. CREATE PORTAL SESSION
//    Called from the app when user clicks "Open Stripe Portal".
//    Returns: { url: "https://billing.stripe.com/session/..." }
// ============================================================
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }

  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();

  if (!userDoc.exists || !userDoc.data().stripeCustomerId) {
    throw new functions.https.HttpsError("not-found", "No billing account found. Subscribe to a paid plan first.");
  }

  const stripeClient = getStripe();
  const session = await stripeClient.billingPortal.sessions.create({
    customer: userDoc.data().stripeCustomerId,
    return_url: "https://app.rentingradar.com#settings",
  });

  return { url: session.url };
});


// ============================================================
// 3. VERIFY CHECKOUT
//    Called from the app after user returns from Stripe Checkout.
//    Verifies the session with Stripe and updates Firestore.
//    Expects: { sessionId: "cs_..." }
// ============================================================
exports.verifyCheckout = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }

  const { sessionId } = data;
  if (!sessionId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing session ID.");
  }

  const stripeClient = getStripe();
  const uid = context.auth.uid;

  // Retrieve the checkout session from Stripe
  const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });

  // Verify this session belongs to this user
  if (session.metadata?.firebaseUID !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Session does not belong to this user.");
  }

  // Verify payment was successful
  if (session.payment_status !== "paid") {
    throw new functions.https.HttpsError("failed-precondition", "Payment not completed.");
  }

  const tier = session.metadata?.tier;
  if (!tier) {
    throw new functions.https.HttpsError("internal", "No tier found in session metadata.");
  }

  // Update Firestore with the verified payment info
  await db.collection("users").doc(uid).update({
    tier: tier,
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription?.id || session.subscription,
    subscriptionStatus: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`User ${uid} verified and upgraded to ${tier}`);
  return { tier: tier, status: "active" };
});


// ============================================================
// 4. SYNC SUBSCRIPTION
//    Called from the app on every page load and after portal return.
//    Checks the user's current subscription status directly with
//    Stripe and updates Firestore accordingly.
//
//    This replaces webhooks by covering all subscription events:
//    - checkout.session.completed  → handled by verifyCheckout above
//    - invoice.paid                → detected via subscription.status = "active"
//    - invoice.payment_failed      → detected via subscription.status = "past_due"
//    - customer.subscription.deleted → detected via subscription.status = "canceled"
//    - customer.subscription.updated → detected via price/tier changes
//
//    Returns: { tier, subscriptionStatus, changed }
// ============================================================
exports.syncSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }

  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();

  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User not found.");
  }

  const userData = userDoc.data();
  const subscriptionId = userData.stripeSubscriptionId;
  const customerId = userData.stripeCustomerId;

  // If no subscription, user is on free tier — nothing to sync
  if (!subscriptionId && !customerId) {
    return { tier: "free", subscriptionStatus: "none", changed: false };
  }

  const stripeClient = getStripe();
  let subscription = null;

  // Try to get the subscription directly
  if (subscriptionId) {
    try {
      subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      // Subscription not found — might have been deleted
      console.warn(`Subscription ${subscriptionId} not found:`, err.message);
    }
  }

  // If no subscription found by ID but we have a customer, check for any active subscriptions
  if (!subscription && customerId) {
    try {
      const subs = await stripeClient.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 1,
      });
      if (subs.data.length > 0) {
        subscription = subs.data[0];
      }
    } catch (err) {
      console.warn(`Could not list subscriptions for customer ${customerId}:`, err.message);
    }
  }

  // No subscription found anywhere — downgrade to free
  if (!subscription) {
    const wasChanged = userData.tier !== "free" || userData.subscriptionStatus !== "cancelled";
    if (wasChanged) {
      await db.collection("users").doc(uid).update({
        tier: "free",
        subscriptionStatus: "cancelled",
        stripeSubscriptionId: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`User ${uid} has no active subscription — downgraded to free`);
    }
    return { tier: "free", subscriptionStatus: "cancelled", changed: wasChanged };
  }

  // Determine tier from the subscription's current price
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const stripeTier = getTierFromPriceId(priceId) || subscription.metadata?.tier || userData.tier;
  const stripeStatus = subscription.status; // active, past_due, canceled, unpaid, trialing, incomplete

  // Map Stripe status to our app's tier and status
  let newTier = stripeTier;
  let newStatus = stripeStatus;

  // If subscription is canceled or unpaid, downgrade to free
  if (stripeStatus === "canceled" || stripeStatus === "unpaid" || stripeStatus === "incomplete_expired") {
    newTier = "free";
    newStatus = "cancelled";
  }

  // Check if anything actually changed
  const changed = userData.tier !== newTier || userData.subscriptionStatus !== newStatus;

  if (changed) {
    const update = {
      tier: newTier,
      subscriptionStatus: newStatus,
      stripeSubscriptionId: subscription.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // If subscription is active, record the current period end for reference
    if (stripeStatus === "active") {
      update.currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
    }

    // If canceled, clear the subscription ID
    if (newTier === "free") {
      update.stripeSubscriptionId = null;
    }

    await db.collection("users").doc(uid).update(update);
    console.log(`Synced user ${uid}: tier=${newTier}, status=${newStatus} (changed=${changed})`);
  }

  return { tier: newTier, subscriptionStatus: newStatus, changed: changed };
});
