const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { verifyFirebaseToken } = require("./verifyToken");

const ADMIN_EMAILS = ["help@rentingradar.com"];

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

  if (!user.email || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: { message: "Admin access required." } });
  }

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // Run all Stripe API calls in parallel
    const [
      balance,
      payouts,
      monthCharges,
      yearCharges,
      lastMonthCharges,
      activeSubs,
      canceledSubs,
      upcomingInvoices,
    ] = await Promise.all([
      // Current balance (available + pending)
      stripe.balance.retrieve(),

      // Recent payouts (last 10)
      stripe.payouts.list({ limit: 10 }),

      // This month's successful charges
      stripe.charges.list({
        created: { gte: Math.floor(startOfMonth.getTime() / 1000) },
        limit: 100,
        expand: ["data.balance_transaction"],
      }),

      // This year's successful charges (paginate in batches)
      stripe.charges.list({
        created: { gte: Math.floor(startOfYear.getTime() / 1000) },
        limit: 100,
      }),

      // Last month's charges (for month-over-month comparison)
      stripe.charges.list({
        created: {
          gte: Math.floor(startOfLastMonth.getTime() / 1000),
          lte: Math.floor(endOfLastMonth.getTime() / 1000),
        },
        limit: 100,
      }),

      // Active subscriptions
      stripe.subscriptions.list({ status: "active", limit: 100 }),

      // Recently canceled subscriptions (last 30 days)
      stripe.subscriptions.list({
        status: "canceled",
        created: { gte: Math.floor(Date.now() / 1000) - 30 * 86400 },
        limit: 100,
      }),

      // Upcoming invoices for MRR approximation
      stripe.invoices.list({
        status: "open",
        limit: 100,
      }),
    ]);

    // Calculate available and pending balance
    const availableBalance = balance.available.reduce((sum, b) => sum + b.amount, 0);
    const pendingBalance = balance.pending.reduce((sum, b) => sum + b.amount, 0);

    // Monthly revenue (successful charges only)
    const monthlyRevenue = monthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);

    // Monthly fees
    const monthlyFees = monthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded && c.balance_transaction)
      .reduce((sum, c) => {
        const bt = c.balance_transaction;
        return sum + (bt && typeof bt === "object" ? bt.fee || 0 : 0);
      }, 0);

    // Monthly refunds
    const monthlyRefunds = monthCharges.data
      .filter((c) => c.refunded || c.amount_refunded > 0)
      .reduce((sum, c) => sum + (c.amount_refunded || 0), 0);

    // Yearly revenue
    let yearlyRevenue = yearCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);

    // If there are more year charges, paginate
    let hasMore = yearCharges.has_more;
    let lastId = yearCharges.data.length ? yearCharges.data[yearCharges.data.length - 1].id : null;
    while (hasMore && lastId) {
      const more = await stripe.charges.list({
        created: { gte: Math.floor(startOfYear.getTime() / 1000) },
        limit: 100,
        starting_after: lastId,
      });
      yearlyRevenue += more.data
        .filter((c) => c.status === "succeeded" && !c.refunded)
        .reduce((sum, c) => sum + c.amount, 0);
      hasMore = more.has_more;
      lastId = more.data.length ? more.data[more.data.length - 1].id : null;
    }

    // Last month revenue for comparison
    const lastMonthRevenue = lastMonthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);

    // MRR from active subscriptions
    const mrr = activeSubs.data.reduce((sum, sub) => {
      if (!sub.items || !sub.items.data.length) return sum;
      return (
        sum +
        sub.items.data.reduce((s, item) => {
          const price = item.price;
          if (!price || !price.unit_amount) return s;
          if (price.recurring && price.recurring.interval === "year") {
            return s + Math.round(price.unit_amount / 12);
          }
          return s + price.unit_amount;
        }, 0)
      );
    }, 0);

    // Active vs trialing subscriptions
    const trialingSubs = activeSubs.data.filter((s) => s.status === "trialing" || (s.trial_end && s.trial_end > Date.now() / 1000));

    // Payout data
    const recentPayouts = payouts.data.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
      created: new Date(p.created * 1000).toISOString(),
    }));

    // Next payout: find the next scheduled one, or estimate from pending balance
    const nextPayout = payouts.data.find((p) => p.status === "in_transit" || p.status === "pending");

    res.status(200).json({
      result: {
        data: {
          balance: {
            available: availableBalance,
            pending: pendingBalance,
          },
          revenue: {
            monthlyGross: monthlyRevenue,
            monthlyFees: monthlyFees,
            monthlyNet: monthlyRevenue - monthlyFees - monthlyRefunds,
            monthlyRefunds: monthlyRefunds,
            lastMonthGross: lastMonthRevenue,
            yearlyGross: yearlyRevenue,
            mrr: mrr,
          },
          subscriptions: {
            active: activeSubs.data.length - trialingSubs.length,
            trialing: trialingSubs.length,
            canceledLast30Days: canceledSubs.data.length,
          },
          payouts: {
            next: nextPayout
              ? {
                  amount: nextPayout.amount,
                  arrivalDate: new Date(nextPayout.arrival_date * 1000).toISOString(),
                  status: nextPayout.status,
                }
              : null,
            pendingAmount: pendingBalance,
            recent: recentPayouts.slice(0, 5),
          },
        },
      },
    });
  } catch (err) {
    console.error("adminFinancials error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to fetch financial data." } });
  }
};
