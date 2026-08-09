const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

function getTierFromPriceId(priceId) {
  if (priceId === process.env.BASIC_MONTHLY_PRICE || priceId === process.env.BASIC_YEARLY_PRICE) return "basic";
  if (priceId === process.env.STANDARD_MONTHLY_PRICE || priceId === process.env.STANDARD_YEARLY_PRICE) return "standard";
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

  // No Stripe data → no active plan
  if (!stripeSubscriptionId && !stripeCustomerId) {
    return res.status(200).json({ result: { data: { tier: null, subscriptionStatus: "none", changed: false } } });
  }

  try {
    let subscription = null;
    // Expand discounts so the user-facing Settings page can show which promo code
    // is applied (e.g., AIRPRENEURMONTHLY) and the dollar/percent savings. Also expand
    // the latest invoice's discounts so we can fall back to invoice-level when the
    // coupon has `duration: once` (in that case the subscription itself has no discount).
    const expandFields = [
      "discounts.coupon",
      "discounts.promotion_code",
      "latest_invoice.discounts.coupon",
      "latest_invoice.discounts.promotion_code",
    ];

    // Try to retrieve by subscription ID first
    if (stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, { expand: expandFields });
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
          expand: expandFields.map(f => "data." + f),
        });
        if (subs.data.length > 0) subscription = subs.data[0];
      } catch (err) {
        console.warn(`Could not list subscriptions for customer ${stripeCustomerId}:`, err.message);
      }
    }

    // No subscription found → no active plan (locked out)
    if (!subscription) {
      return res.status(200).json({
        result: {
          data: {
            tier: null,
            subscriptionStatus: "none",
            stripeSubscriptionId: null,
            changed: true,
          },
        },
      });
    }

    const priceObj = subscription.items?.data?.[0]?.price || null;
    const priceId = priceObj?.id;
    let tier = getTierFromPriceId(priceId) || subscription.metadata?.tier || null;
    let status = subscription.status;
    // Pull the actual subscribed price + billing interval so Settings can display the
    // accurate plan amount ($29.99/mo or $289.99/yr) regardless of TIERS face values.
    const priceUnitAmount = (priceObj && typeof priceObj.unit_amount === "number") ? priceObj.unit_amount / 100 : null;
    const billingInterval = priceObj?.recurring?.interval || null;  // 'month' | 'year' | 'week' | 'day'

    // Handle trial status
    let trialEnd = null;
    if (status === "trialing" && subscription.trial_end) {
      trialEnd = new Date(subscription.trial_end * 1000).toISOString();
    }

    // Expired/cancelled/unpaid → locked out (no free tier)
    if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
      status = "expired";
    }

    // Extract active discount info (if any) so the Settings page can display the
    // applied coupon, e.g., AIRPRENEURMONTHLY saving $9.99/mo. We look in three places
    // in order — the SUBSCRIPTION's discounts array (newer API), the singular `discount`
    // field (older API), and finally the LATEST INVOICE's discounts (catches coupons
    // with `duration: once` that only attach to the first invoice, not the subscription).
    let discountCode = null, discountAmountOff = null, discountPercentOff = null, discountDuration = null;
    function _extractFromList(list, sourceLabel) {
      if (!Array.isArray(list) || !list.length) return false;
      const disc = list[0];
      // disc may be a string (unexpanded ID) or an object (expanded)
      if (!disc || typeof disc !== "object") {
        console.warn(`[syncSubscription] discount in ${sourceLabel} not expanded:`, disc);
        return false;
      }
      const coupon = disc.coupon || null;
      const promo = disc.promotion_code || null;
      if (coupon && typeof coupon === "object") {
        if (typeof coupon.amount_off === "number") discountAmountOff = coupon.amount_off / 100;
        if (typeof coupon.percent_off === "number") discountPercentOff = coupon.percent_off;
        if (coupon.duration) discountDuration = coupon.duration;
      }
      if (promo && typeof promo === "object" && promo.code) discountCode = promo.code;
      // If the coupon was applied directly (no promotion_code object), use the coupon's
      // human-readable name as a last-resort code — AIRPRENEURYEARLY shows up as the
      // coupon's `name` even when no promotion_code wraps it.
      if (!discountCode && coupon && typeof coupon === "object") {
        if (typeof coupon.name === "string" && coupon.name.trim()) discountCode = coupon.name.trim();
        else if (typeof coupon.id === "string" && coupon.id.trim()) discountCode = coupon.id.trim();
      }
      console.log(`[syncSubscription] extracted discount from ${sourceLabel}:`, { discountCode, discountAmountOff, discountPercentOff, discountDuration });
      return !!(discountCode || discountAmountOff || discountPercentOff);
    }

    // 1) Subscription-level discounts (newer plural array)
    let found = _extractFromList(subscription.discounts, "subscription.discounts");
    // 2) Subscription-level discount (legacy singular)
    if (!found && subscription.discount) {
      found = _extractFromList([subscription.discount], "subscription.discount");
    }
    // 3) Latest invoice — covers duration:once coupons that don't persist on the subscription
    if (!found && subscription.latest_invoice && typeof subscription.latest_invoice === "object") {
      const inv = subscription.latest_invoice;
      found = _extractFromList(inv.discounts, "latest_invoice.discounts");
      if (!found && inv.discount) {
        found = _extractFromList([inv.discount], "latest_invoice.discount");
      }
    }
    // 4) Customer-level discount — promo codes entered at Stripe Checkout sometimes
    // attach to the customer rather than the subscription. Last resort, but common.
    if (!found && subscription.customer) {
      try {
        const custId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        const customer = await stripe.customers.retrieve(custId, {
          expand: ["discount.coupon", "discount.promotion_code"],
        });
        if (customer && customer.discount) {
          found = _extractFromList([customer.discount], "customer.discount");
        } else {
          console.log("[syncSubscription] customer has no discount", custId);
        }
      } catch (err) {
        console.warn("[syncSubscription] customer discount lookup failed:", err.message);
      }
    }
    if (!found) {
      console.log("[syncSubscription] no discount found anywhere for subscription", subscription.id, "customer", subscription.customer);
    }

    res.status(200).json({
      result: {
        data: {
          tier: tier,
          subscriptionStatus: status,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          trialEnd: trialEnd,
          currentPeriodEnd: (status === "active" || status === "trialing")
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          discountCode: discountCode,
          discountAmountOff: discountAmountOff,
          discountPercentOff: discountPercentOff,
          discountDuration: discountDuration,
          priceUnitAmount: priceUnitAmount,
          billingInterval: billingInterval,
        },
      },
    });
  } catch (err) {
    console.error("syncSubscription error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to sync subscription." } });
  }
};
