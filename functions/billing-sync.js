// Billing sync for verifyCheckout and syncSubscription (index.js). Reads the
// subscription from Stripe and builds the users/{uid} billing fields, which only
// the server (Admin SDK) and the support admin may write (firestore.rules, T1b).
// Ported from the Vercel api/syncSubscription.js and the old client write in
// index.html _doSyncSubscription, so the stored fields keep the same shape.

// Discounts can sit on the subscription (plural or legacy singular), on the latest
// invoice (duration:once coupons) or on the customer, so expand all of them.
const SUB_EXPAND = [
  "discounts.coupon",
  "discounts.promotion_code",
  "latest_invoice.discounts.coupon",
  "latest_invoice.discounts.promotion_code",
];

function tierFromPriceId(priceId, env) {
  if (!priceId) return null;
  if (priceId === env.BASIC_MONTHLY_PRICE || priceId === env.BASIC_YEARLY_PRICE) return "basic";
  if (priceId === env.STANDARD_MONTHLY_PRICE || priceId === env.STANDARD_YEARLY_PRICE) return "standard";
  if (priceId === env.PRO_MONTHLY_PRICE || priceId === env.PRO_YEARLY_PRICE) return "pro";
  return null;
}

function customerIdOf(subscription) {
  const c = subscription && subscription.customer;
  return typeof c === "string" ? c : (c && c.id) || null;
}

// First discount in a list, or null. Unexpanded (string) entries are skipped.
function discountFrom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const disc = list[0];
  if (!disc || typeof disc !== "object") return null;
  const coupon = disc.coupon && typeof disc.coupon === "object" ? disc.coupon : null;
  const promo = disc.promotion_code && typeof disc.promotion_code === "object" ? disc.promotion_code : null;
  const out = { discountCode: null, discountAmountOff: null, discountPercentOff: null, discountDuration: null };
  if (coupon) {
    if (typeof coupon.amount_off === "number") out.discountAmountOff = coupon.amount_off / 100;
    if (typeof coupon.percent_off === "number") out.discountPercentOff = coupon.percent_off;
    if (coupon.duration) out.discountDuration = coupon.duration;
  }
  if (promo && promo.code) out.discountCode = promo.code;
  // A coupon applied without a promotion code: use its name, then its id.
  if (!out.discountCode && coupon) {
    if (typeof coupon.name === "string" && coupon.name.trim()) out.discountCode = coupon.name.trim();
    else if (typeof coupon.id === "string" && coupon.id.trim()) out.discountCode = coupon.id.trim();
  }
  return (out.discountCode || out.discountAmountOff || out.discountPercentOff) ? out : null;
}

// Subscription → legacy singular → latest invoice → customer. The customer lookup
// only runs when nothing else matched.
async function findDiscount(stripe, subscription) {
  let found = discountFrom(subscription.discounts)
    || (subscription.discount ? discountFrom([subscription.discount]) : null);
  const inv = subscription.latest_invoice;
  if (!found && inv && typeof inv === "object") {
    found = discountFrom(inv.discounts) || (inv.discount ? discountFrom([inv.discount]) : null);
  }
  const custId = customerIdOf(subscription);
  if (!found && custId) {
    try {
      const customer = await stripe.customers.retrieve(custId, { expand: ["discount.coupon", "discount.promotion_code"] });
      if (customer && customer.discount) found = discountFrom([customer.discount]);
    } catch (err) {
      console.warn("[billing-sync] customer discount lookup failed:", err.message);
    }
  }
  return found || { discountCode: null, discountAmountOff: null, discountPercentOff: null, discountDuration: null };
}

// The caller owns the subscription when its metadata.firebaseUID is theirs, or the
// customer's is, or (neither has one: legacy customers found by email at checkout)
// the customer email matches their verified token email. Lookup failures = not owned.
async function ownsSubscription(stripe, subscription, user) {
  const subUid = subscription.metadata && subscription.metadata.firebaseUID;
  if (subUid && subUid === user.uid) return true;
  const custId = customerIdOf(subscription);
  if (!custId) return false;
  let customer;
  try {
    customer = await stripe.customers.retrieve(custId);
  } catch (err) {
    console.warn("[billing-sync] ownership customer lookup failed:", err.message);
    return false;
  }
  if (!customer || customer.deleted) return false;
  const custUid = customer.metadata && customer.metadata.firebaseUID;
  if (custUid && custUid === user.uid) return true;
  if (!subUid && !custUid && user.email_verified === true && user.email && customer.email) {
    return customer.email.toLowerCase() === user.email.toLowerCase();
  }
  return false;
}

// By stored ID first, then the customer's most recent subscription.
async function findSubscription(stripe, subscriptionId, customerId) {
  if (subscriptionId) {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId, { expand: SUB_EXPAND });
    } catch (err) {
      console.warn(`[billing-sync] subscription ${subscriptionId} not found:`, err.message);
    }
  }
  if (customerId) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: customerId, status: "all", limit: 1, expand: SUB_EXPAND.map((f) => "data." + f),
      });
      if (subs.data.length > 0) return subs.data[0];
    } catch (err) {
      console.warn(`[billing-sync] could not list subscriptions for ${customerId}:`, err.message);
    }
  }
  return null;
}

// Paid-but-never-redirected fallback: every checkout tags the subscription with
// metadata.firebaseUID. Newest first. Errors (incl. rate limits) are the caller's.
async function searchSubscriptionByUid(stripe, uid) {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return null;
  const found = await stripe.subscriptions.search({
    query: `metadata['firebaseUID']:'${uid}'`,
    limit: 10,
    expand: SUB_EXPAND.map((f) => "data." + f),
  });
  const subs = (found && found.data) || [];
  if (!subs.length) return null;
  return subs.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0];
}

// The billing fields for a subscription, same shape the Vercel route returns.
// opts.tier overrides the price/metadata tier (verifyCheckout uses the session's).
async function readBilling(stripe, subscription, env, opts) {
  const priceObj = (subscription.items && subscription.items.data && subscription.items.data[0] && subscription.items.data[0].price) || null;
  const tier = (opts && opts.tier) || tierFromPriceId(priceObj && priceObj.id, env) || (subscription.metadata && subscription.metadata.tier) || null;
  let status = subscription.status;
  let trialEnd = null;
  if (status === "trialing" && subscription.trial_end) trialEnd = new Date(subscription.trial_end * 1000).toISOString();
  // Expired/cancelled/unpaid → locked out (no free tier)
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") status = "expired";
  const live = status === "active" || status === "trialing";
  const discount = await findDiscount(stripe, subscription);
  return Object.assign({
    tier: tier,
    subscriptionStatus: status,
    stripeCustomerId: customerIdOf(subscription),
    stripeSubscriptionId: subscription.id,
    trialEnd: trialEnd,
    currentPeriodEnd: live && subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    // Set to end (admin cancel, Billing Portal cancel, or a scheduled cancel_at).
    cancelAtPeriodEnd: live ? !!(subscription.cancel_at_period_end || subscription.cancel_at) : false,
  }, discount, {
    priceUnitAmount: (priceObj && typeof priceObj.unit_amount === "number") ? priceObj.unit_amount / 100 : null,
    billingInterval: (priceObj && priceObj.recurring && priceObj.recurring.interval) || null,
  });
}

// What a sync that found no subscription reports (and stores).
function noSubscriptionBilling() {
  return { tier: null, subscriptionStatus: "none", stripeSubscriptionId: null };
}

// The users/{uid} update, field for field what index.html used to write itself.
// Cleared discounts/price are deleted. referredBy is backfilled from the promo code
// only when the user has none (it can be admin-managed).
function firestoreUpdate(billing, userData, FieldValue) {
  const d = billing;
  const u = {
    tier: d.tier,
    subscriptionStatus: d.subscriptionStatus,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (d.stripeCustomerId) u.stripeCustomerId = d.stripeCustomerId;
  if (d.stripeSubscriptionId) u.stripeSubscriptionId = d.stripeSubscriptionId;
  else if (d.stripeSubscriptionId === null) u.stripeSubscriptionId = null;
  if (d.currentPeriodEnd) u.currentPeriodEnd = d.currentPeriodEnd;
  u.cancelAtPeriodEnd = !!d.cancelAtPeriodEnd;
  if (d.trialEnd) u.trialEnd = d.trialEnd;
  u.discountCode = d.discountCode || FieldValue.delete();
  u.discountAmountOff = (typeof d.discountAmountOff === "number") ? d.discountAmountOff : FieldValue.delete();
  u.discountPercentOff = (typeof d.discountPercentOff === "number") ? d.discountPercentOff : FieldValue.delete();
  u.discountDuration = d.discountDuration || FieldValue.delete();
  u.priceUnitAmount = (typeof d.priceUnitAmount === "number") ? d.priceUnitAmount : FieldValue.delete();
  u.billingInterval = d.billingInterval || FieldValue.delete();
  if (d.discountCode && !((userData && userData.referredBy) || "")) {
    u.referredBy = String(d.discountCode).toUpperCase().trim();
  }
  return u;
}

module.exports = {
  SUB_EXPAND,
  tierFromPriceId,
  customerIdOf,
  discountFrom,
  findDiscount,
  ownsSubscription,
  findSubscription,
  searchSubscriptionByUid,
  readBilling,
  noSubscriptionBilling,
  firestoreUpdate,
};
