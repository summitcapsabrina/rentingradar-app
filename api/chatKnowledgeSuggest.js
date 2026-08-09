// POST /api/chatKnowledgeSuggest
// Admin-only. Generates NEW knowledge-base Q&A suggestions to fill gaps —
// covering real user questions that aren't answered yet, natural derivatives,
// and questions users are likely to get stuck on. The client saves the results
// as INACTIVE entries (tagged "ai-suggested") for the admin to review + activate.
//
// Body: { existingQuestions: string[], userQuestions: string[], count?: number }
// Returns: { suggestions: [{ question, answer, tags }] }

const { verifyFirebaseToken } = require("./verifyToken");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const ADMIN_EMAILS = ["help@rentingradar.com"];

// Unwrap a Firestore REST user doc just enough to read the admin flag.
async function isAdminUser(user, idToken) {
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/rentingradar/databases/(default)/documents/users/${user.uid}`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + idToken } });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j.fields && j.fields.admin && j.fields.admin.booleanValue === true);
  } catch (e) {
    return false;
  }
}

// Condensed, verified RentingRadar facts the model must ground answers in.
// Keep in sync with the FACTS section of api/chatSend.js when features change.
const PRODUCT_FACTS = `
RentingRadar is a CRM for short-term rental ARBITRAGE operators (people who lease a property from a landlord and re-list it on Airbnb/Vrbo). Two halves: PROSPECTING (source + analyze deals) and OPERATIONS (manage properties you're actively running).

- Add a property: "+ Add Property" (top-right of Prospecting) OR install the Chrome extension and visit an AirDNA/Airbnb listing to auto-import. The extension scrapes AirDNA (financials/comps) + Airbnb (host, beds, baths, amenities).
- Pipeline statuses: New, No Contact, Messaged, Left Voicemail, Follow Up, Interested, Meeting; closed: HOA Issues, Not Good Fit, Not Interested, Un-Listed. Grouped: New Leads / In Outreach / Qualified / Closed-Lost.
- Importing: CSV, Monday.com XLSX (auto-detects sub-tabs), Custom XLSX (map your own columns). Logged in Import History; undo within 24 hours.
- Analysis: add at least 3 comps tagged Loses To / Competes With / Beats → weighted revenue projection + deal recommendation; ROI shown pessimistic/realistic/optimistic.
- Math: AirBNB service fee = 15.5% of revenue. Position Score = (beats − loses) ÷ total comps. Market Percentile = (beats + ½·competes) ÷ total × 100. Position Adjustment ranges 55–100%.
- Negotiation tools: rent dial, rental concession (free-rent) calculator.
- Operations per property: tasks/follow-ups, meetings (emailed .ics calendar invites with RSVP + time zones), expenses, contracts, maintenance, AirBNB reviews, purchases, contacts.
- Plans (unlimited properties on all): Basic $9.99/mo or $89.99/yr (1 analysis/month, no dark mode); Standard $19.99/mo or $199.99/yr (10 analyses/month, dark mode + themes); Pro $29.99/mo or $289.99/yr (unlimited analyses, dark mode + themes). Yearly saves roughly 2 months.
- Affiliate program: 50% commission on a referred user's subscription minus a flat $3/user/month operating cost; paid via a monthly commission report.
- Payments via Stripe. Settings: profile, theme, email preferences, time zone, password, Chrome-extension status.
- ALWAYS route to a human (email help@rentingradar.com) for: billing changes, cancellations, refunds, account access / sign-in issues, missing data, security, legal.
`.trim();

function buildPrompt(existing, userQs, count) {
  const ex = (existing || []).slice(0, 400).map(q => "- " + q).join("\n") || "(none yet)";
  const uq = (userQs || []).slice(0, 200).map(q => "- " + q).join("\n") || "(none provided)";
  return `You are expanding the FAQ knowledge base for RentingRadar's in-app AI support assistant (Sabrina). Generate NEW question/answer pairs that fill gaps in the existing FAQ so users get help without a human.

RULES:
- Do NOT duplicate or trivially restate any EXISTING question below. A meaningfully different angle is fine; a near-identical rephrase is NOT.
- PRIORITIZE covering the REAL USER QUESTIONS below (from actual chats) that aren't already answered.
- Also add questions you anticipate users getting stuck on, based on the product facts.
- Answers MUST be accurate to the PRODUCT FACTS. Never invent features, button names, menu paths, or prices. If something would need billing/account/human help or you're not certain, make the answer politely direct the user to email help@rentingradar.com and include "escalate" in its tags.
- Voice: warm, friendly, concise (1–3 sentences), like a helpful concierge.
- If linking off-platform is genuinely needed, write the link as markdown [label](https://...).
- Output STRICT JSON ONLY: a JSON array of objects, each {"question": string, "answer": string, "tags": string[]}. No prose, no markdown fences, no commentary. Generate up to ${count} entries (fewer is fine if there aren't that many real gaps).

PRODUCT FACTS:
${PRODUCT_FACTS}

EXISTING QUESTIONS (do NOT duplicate these):
${ex}

REAL USER QUESTIONS FROM CHATS (cover the ones not already answered):
${uq}`;
}

// Pull the first JSON array out of the model's text, tolerating stray prose/fences.
function parseSuggestions(text) {
  if (!text) return [];
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(t.slice(start, end + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(o => o && typeof o.question === "string" && typeof o.answer === "string")
    .map(o => ({
      question: o.question.trim().slice(0, 300),
      answer: o.answer.trim().slice(0, 2000),
      tags: Array.isArray(o.tags) ? o.tags.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 8) : [],
    }))
    .filter(o => o.question && o.answer);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: "Not configured (ANTHROPIC_API_KEY missing)." } });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "You must be signed in." } });
  }
  const idToken = authHeader.split("Bearer ")[1];

  let user;
  try { user = await verifyFirebaseToken(idToken); }
  catch (e) { return res.status(401).json({ error: { message: "Invalid auth token." } }); }

  if (!(await isAdminUser(user, idToken))) {
    return res.status(403).json({ error: { message: "Admin only." } });
  }

  const body = req.body || {};
  const existing = Array.isArray(body.existingQuestions) ? body.existingQuestions.filter(q => typeof q === "string") : [];
  const userQs = Array.isArray(body.userQuestions) ? body.userQuestions.filter(q => typeof q === "string") : [];
  const count = Math.min(20, Math.max(1, parseInt(body.count, 10) || 12));

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: buildPrompt(existing, userQs, count) }],
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("[chatKnowledgeSuggest] Anthropic error", r.status, errBody);
      return res.status(502).json({ error: { message: "Could not generate suggestions right now. Please try again." } });
    }
    const data = await r.json();
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter(p => p && p.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("");
    const suggestions = parseSuggestions(text);
    console.log(`[chatKnowledgeSuggest] uid=${user.uid} existing=${existing.length} userQs=${userQs.length} → ${suggestions.length} suggestions`);
    return res.status(200).json({ suggestions });
  } catch (err) {
    console.error("[chatKnowledgeSuggest] failed", err);
    return res.status(500).json({ error: { message: "Network error reaching AI service." } });
  }
};
