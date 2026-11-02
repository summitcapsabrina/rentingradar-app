const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const sgMail = require("@sendgrid/mail");
const { emailWrapper, FROM_EMAIL, APP_URL } = require("./email");
const { PLAN_PRICING } = require("./pricing");

// Stripe metadata flag, so the email goes out once per subscription. Lives on Stripe because
// users can write their own Firestore doc and Vercel has no Admin SDK.
const SENT_FLAG = "rr_trial_email_sent";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount) {
  return "$" + Number(amount).toFixed(2);
}

// Pacific, not the server's UTC: "cancel before Nov 9" must not read later than the charge for
// a US customer, and a UTC date can land a day after the customer's local charge date.
function formatDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

// subscription.discount is the shape on API 2023-10-16, which stripe-node 14 pins.
async function promoCodeFor(subscription) {
  const discount = subscription.discount;
  if (!discount) return null;
  const promo = discount.promotion_code;
  if (promo && typeof promo === "object" && promo.code) return promo.code;
  if (typeof promo === "string") {
    try {
      return (await stripe.promotionCodes.retrieve(promo)).code;
    } catch (e) {
      console.error("Could not look up promotion code:", e.message);
    }
  }
  return discount.coupon?.name || discount.coupon?.id || "";
}

function buildTrialStartedEmail({ subscription, name, promoCode }) {
  const price = subscription.items.data[0].price;
  const plan = PLAN_PRICING[String(subscription.metadata?.tier || "").toLowerCase()];
  const isYearly = price.recurring?.interval === "year";
  const planLabel = (plan ? plan.name + " " : "") + (isYearly ? "Yearly" : "Monthly");
  const chosenPrice = money(price.unit_amount / 100) + (isYearly ? "/yr" : "/mo");
  const trialEnd = formatDate(subscription.trial_end);
  const firstName = name ? String(name).split(" ")[0] : null;
  const row = "padding:6px 0;font-size:14px";

  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#ffffff">Your free trial has started</h2>
    <p style="margin:0 0 18px;color:#c8cbd6">${firstName ? "Hi " + esc(firstName) + "," : "Hi,"}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1e30;border:1px solid #252a3d;border-radius:10px;margin:20px 0">
      <tr>
        <td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="${row};color:#94a3b8">Plan</td>
              <td style="${row};color:#f1f5f9;text-align:right;font-weight:600">${planLabel}</td>
            </tr>
            <tr>
              <td style="${row};color:#94a3b8">Trial ends</td>
              <td style="${row};color:#f1f5f9;text-align:right;font-weight:600">${trialEnd}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 14px;color:#c8cbd6">Your free trial ends <strong style="color:#e2e4eb">${trialEnd}</strong>.</p>
    <p style="margin:0 0 14px;color:#c8cbd6">After that, your plan renews automatically at <strong style="color:#e2e4eb">${chosenPrice}</strong> until you cancel.${plan ? ` (${plan.name} is ${money(plan.monthly)}/mo or ${money(plan.yearly)}/yr.)` : ""}</p>
    ${promoCode !== null ? `<p style="margin:0 0 14px;color:#c8cbd6">Your promo code${promoCode ? " " + esc(promoCode) : ""} is applied; see Manage Billing for your exact charge.</p>` : ""}

    <div style="text-align:center;margin:28px 0 12px">
      <a href="${APP_URL}#settings" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#6366f1,#6381fa);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Manage Billing</a>
    </div>
    <p style="margin:0 0 18px;color:#c8cbd6;text-align:center">Cancel online anytime before ${trialEnd} and you won't be charged.</p>

    <p style="margin:0 0 18px;color:#c8cbd6">To cancel: Settings &gt; Plan &amp; Billing &gt; Manage Billing &gt; Open Stripe Portal &gt; Cancel subscription.</p>

    <p style="margin:24px 0 0;color:#6b7280;font-size:13px;text-align:center">Questions? Reply or email <a href="mailto:help@rentingradar.com" style="color:#6381fa;text-decoration:none">help@rentingradar.com</a>.</p>
  `, { transactional: true });

  return {
    subject: `Your RentingRadar ${plan ? plan.name + " " : ""}free trial has started`,
    html,
  };
}

// Sends the trial-started confirmation once per subscription. The T1b Stripe webhook should call
// this too, so trials whose buyer closed the tab before verifyCheckout ran still get the email.
// `subscription` must be the full object, not an ID. Throws if the send fails, so the flag stays unset.
async function sendTrialStartedEmail({ subscription, email, name }) {
  if (!subscription || typeof subscription !== "object") return { sent: false, reason: "no-subscription" };
  if (subscription.status !== "trialing") return { sent: false, reason: "not-trialing" };
  if (subscription.metadata?.[SENT_FLAG]) return { sent: false, reason: "already-sent" };
  if (!email) {
    console.error("Trial-started email skipped, no address for subscription", subscription.id);
    return { sent: false, reason: "no-email" };
  }

  const promoCode = await promoCodeFor(subscription);
  const { subject, html } = buildTrialStartedEmail({ subscription, name, promoCode });

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to: email,
    from: FROM_EMAIL,
    subject,
    html,
    categories: ["trial-started"],
  });

  try {
    await stripe.subscriptions.update(subscription.id, {
      metadata: { [SENT_FLAG]: new Date().toISOString() },
    });
  } catch (e) {
    // The email is already out, so report it as sent. Without the flag a later call can resend it.
    console.error("Trial-started email sent but flag not saved for", subscription.id, e.message);
  }
  return { sent: true };
}

module.exports = { sendTrialStartedEmail, buildTrialStartedEmail, SENT_FLAG };
