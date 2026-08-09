// POST /api/chatKnowledgeEmbed
// Computes an OpenAI text-embedding-3-small vector for a piece of text.
// Called by the admin Knowledge Base UI when a new entry is saved or updated.
// Returns { embedding: number[] } (1536 floats by default).
//
// Body: { text: string }
// Auth: admin only (mirrors firestore.rules /chatKnowledge write rule).

const { verifyFirebaseToken } = require("./verifyToken");

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const ADMIN_EMAILS = ["help@rentingradar.com"];

async function fetchUserDoc(uid, idToken) {
  const projectId = "rentingradar";
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + idToken } });
  if (!r.ok) return null;
  const j = await r.json();
  const fields = j.fields || {};
  const out = {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "Embeddings not configured (OPENAI_API_KEY missing in Vercel env)." } });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: { message: "You must be signed in." } });
  }
  const idToken = authHeader.split("Bearer ")[1];

  let user;
  try {
    user = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: { message: "Invalid auth token." } });
  }

  // Admin gate
  const isAdminEmail = user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  let isAdmin = isAdminEmail;
  if (!isAdmin) {
    const userDoc = await fetchUserDoc(user.uid, idToken);
    isAdmin = !!(userDoc && userDoc.admin === true);
  }
  if (!isAdmin) {
    return res.status(403).json({ error: { message: "Admin access required." } });
  }

  const body = req.body || {};
  const text = (body.text || "").toString().trim();
  if (!text) {
    return res.status(400).json({ error: { message: "text is required." } });
  }
  if (text.length > 20000) {
    return res.status(400).json({ error: { message: "Text too long for a single embedding (20k char max)." } });
  }

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("[chatKnowledgeEmbed] OpenAI error", r.status, errBody);
      return res.status(502).json({ error: { message: "Embedding service failed: " + r.status } });
    }
    const data = await r.json();
    const embedding = data && data.data && data.data[0] && data.data[0].embedding;
    if (!Array.isArray(embedding)) {
      return res.status(502).json({ error: { message: "Embedding service returned unexpected payload." } });
    }
    return res.status(200).json({ embedding, model: EMBED_MODEL, dim: embedding.length });
  } catch (err) {
    console.error("[chatKnowledgeEmbed] fetch failed", err);
    return res.status(500).json({ error: { message: "Network error reaching OpenAI." } });
  }
};
