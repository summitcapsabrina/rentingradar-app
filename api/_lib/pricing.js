// Canonical plan pricing (keep in sync with the TIERS object in index.html).
const PLAN_PRICING = {
  basic:    { name: "Basic",    monthly: 9.99,  yearly: 89.99,  analyses: "1 analysis / month",   darkMode: false },
  standard: { name: "Standard", monthly: 19.99, yearly: 199.99, analyses: "10 analyses / month",  darkMode: true },
  pro:      { name: "Pro",      monthly: 29.99, yearly: 289.99, analyses: "Unlimited analyses",    darkMode: true },
};

module.exports = { PLAN_PRICING };
