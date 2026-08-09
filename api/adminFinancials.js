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
    const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1);
    const endOfLastYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      balance,
      payouts,
      monthCharges,
      yearCharges,
      lastYearCharges,
      lastMonthCharges,
      activeSubs,
      trialingSubsList,
      canceledSubs,
      upcomingInvoices,
    ] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.payouts.list({ limit: 10 }),
      stripe.charges.list({
        created: { gte: Math.floor(startOfMonth.getTime() / 1000) },
        limit: 100,
        expand: ["data.balance_transaction"],
      }),
      stripe.charges.list({
        created: { gte: Math.floor(startOfYear.getTime() / 1000) },
        limit: 100,
        // Expand balance_transaction so per-month fees can be computed for any
        // period the dashboard's period selector covers, not just the current month.
        expand: ["data.balance_transaction"],
      }),
      // Last full calendar year — lets the period selector's "Last Year" option
      // show real per-month bars instead of all $0.
      stripe.charges.list({
        created: {
          gte: Math.floor(startOfLastYear.getTime() / 1000),
          lte: Math.floor(endOfLastYear.getTime() / 1000),
        },
        limit: 100,
        expand: ["data.balance_transaction"],
      }),
      stripe.charges.list({
        created: {
          gte: Math.floor(startOfLastMonth.getTime() / 1000),
          lte: Math.floor(endOfLastMonth.getTime() / 1000),
        },
        limit: 100,
      }),
      stripe.subscriptions.list({ status: "active", limit: 100 }),
      // Trialing subs are a SEPARATE status in Stripe — not returned by status:"active".
      // Previously the code listed status:"active" then filtered for status==="trialing",
      // which always returned []. That bug zeroed the "In Trial" KPI on the dashboard.
      stripe.subscriptions.list({ status: "trialing", limit: 100 }),
      stripe.subscriptions.list({
        status: "canceled",
        created: { gte: Math.floor(Date.now() / 1000) - 30 * 86400 },
        limit: 100,
      }),
      stripe.invoices.list({ status: "open", limit: 100 }),
    ]);

    const availableBalance = balance.available.reduce((sum, b) => sum + b.amount, 0);
    const pendingBalance = balance.pending.reduce((sum, b) => sum + b.amount, 0);

    const monthlyRevenue = monthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);

    const monthlyFees = monthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded && c.balance_transaction)
      .reduce((sum, c) => {
        const bt = c.balance_transaction;
        return sum + (bt && typeof bt === "object" ? bt.fee || 0 : 0);
      }, 0);

    const monthlyRefunds = monthCharges.data
      .filter((c) => c.refunded || c.amount_refunded > 0)
      .reduce((sum, c) => sum + (c.amount_refunded || 0), 0);

    // Per-month revenue (gross & net) keyed "YYYY-MM" for both this year + last year.
    // The client uses this to populate the Monthly Revenue / Profit chart instead of
    // synthesizing from current user state. Net = gross − fees − refunds for that month.
    const revenueByMonthGross = {};
    const revenueByMonthFees = {};
    const revenueByMonthRefunds = {};
    function _bucketKey(unixSeconds) {
      const d = new Date(unixSeconds * 1000);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    }
    function _accumulateCharges(charges, includeFees) {
      charges.forEach((c) => {
        const k = _bucketKey(c.created);
        if (c.status === "succeeded" && !c.refunded) {
          revenueByMonthGross[k] = (revenueByMonthGross[k] || 0) + c.amount;
          if (includeFees && c.balance_transaction && typeof c.balance_transaction === "object") {
            revenueByMonthFees[k] = (revenueByMonthFees[k] || 0) + (c.balance_transaction.fee || 0);
          }
        }
        if (c.refunded || c.amount_refunded > 0) {
          revenueByMonthRefunds[k] = (revenueByMonthRefunds[k] || 0) + (c.amount_refunded || 0);
        }
      });
    }

    let yearlyRevenue = yearCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);
    _accumulateCharges(yearCharges.data, true);

    let hasMore = yearCharges.has_more;
    let lastId = yearCharges.data.length ? yearCharges.data[yearCharges.data.length - 1].id : null;
    while (hasMore && lastId) {
      const more = await stripe.charges.list({
        created: { gte: Math.floor(startOfYear.getTime() / 1000) },
        limit: 100,
        starting_after: lastId,
        expand: ["data.balance_transaction"],
      });
      yearlyRevenue += more.data
        .filter((c) => c.status === "succeeded" && !c.refunded)
        .reduce((sum, c) => sum + c.amount, 0);
      _accumulateCharges(more.data, true);
      hasMore = more.has_more;
      lastId = more.data.length ? more.data[more.data.length - 1].id : null;
    }

    // Same for last year — paginate through it too so the "Last Year" period is complete.
    _accumulateCharges(lastYearCharges.data, true);
    let lyHasMore = lastYearCharges.has_more;
    let lyLastId = lastYearCharges.data.length ? lastYearCharges.data[lastYearCharges.data.length - 1].id : null;
    while (lyHasMore && lyLastId) {
      const more = await stripe.charges.list({
        created: {
          gte: Math.floor(startOfLastYear.getTime() / 1000),
          lte: Math.floor(endOfLastYear.getTime() / 1000),
        },
        limit: 100,
        starting_after: lyLastId,
        expand: ["data.balance_transaction"],
      });
      _accumulateCharges(more.data, true);
      lyHasMore = more.has_more;
      lyLastId = more.data.length ? more.data[more.data.length - 1].id : null;
    }

    // Note: monthCharges is intentionally NOT accumulated into revenueByMonth — its
    // data is already a subset of yearCharges (both fetch from year start, monthCharges
    // is just a window). Accumulating both would double-count current-month charges.
    // monthCharges remains used for the standalone monthlyRevenue/Fees/Refunds totals
    // surfaced above for the "real-time current month" Stripe metrics.

    // Build the final per-month structure: { "YYYY-MM": { gross, net } }
    const revenueByMonth = {};
    const allKeys = new Set([
      ...Object.keys(revenueByMonthGross),
      ...Object.keys(revenueByMonthFees),
      ...Object.keys(revenueByMonthRefunds),
    ]);
    allKeys.forEach((k) => {
      const gross = revenueByMonthGross[k] || 0;
      const fees = revenueByMonthFees[k] || 0;
      const refunds = revenueByMonthRefunds[k] || 0;
      revenueByMonth[k] = { gross, net: gross - fees - refunds, fees, refunds };
    });

    const lastMonthRevenue = lastMonthCharges.data
      .filter((c) => c.status === "succeeded" && !c.refunded)
      .reduce((sum, c) => sum + c.amount, 0);

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

    // status:"trialing" comes from its own list call now (see Promise.all above).
    const trialingSubs = trialingSubsList.data;

    const recentPayouts = payouts.data.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
      created: new Date(p.created * 1000).toISOString(),
    }));

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
            // Per-month gross/net/fees/refunds keyed "YYYY-MM" (UTC). Covers this
            // year + last year so the period selector can populate accurately.
            byMonth: revenueByMonth,
          },
          subscriptions: {
            // activeSubs is now pure "active" (Stripe doesn't include trialing in this list).
            active: activeSubs.data.length,
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
