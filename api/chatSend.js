// POST /api/chatSend
// Generates an AI reply for a RentingRadar support chat conversation using
// Claude Haiku 4.5. The client persists both the user message AND the returned
// AI message into Firestore — this route is purely the LLM call.
//
// Body:
//   { conversationId: string,
//     userMessage:    string,
//     history:        [{ role: 'user' | 'assistant', content: string }, ...],
//     context:        { tier, subscriptionStatus, userName, page, ... } }
//
// Returns:
//   { reply: string, model: string, stopReason: string, usage: {...} }
//
// Beta gate: only admin users and affiliate-tier users may call this route
// during the Phase 1 rollout. Mirror this with the Firestore rules.

const { verifyFirebaseToken } = require("./verifyToken");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 1024;
// Generous so Sabrina recalls the WHOLE conversation (including any stretch a
// human support rep handled before the AI was re-enabled), not just the recent tail.
const MAX_HISTORY_TURNS = 150;

// Canonical plan pricing (keep in sync with the TIERS object in index.html).
const PLAN_PRICING = {
  basic:    { name: "Basic",    monthly: 9.99,  yearly: 89.99,  analyses: "1 analysis / month",   darkMode: false },
  standard: { name: "Standard", monthly: 19.99, yearly: 199.99, analyses: "10 analyses / month",  darkMode: true },
  pro:      { name: "Pro",      monthly: 29.99, yearly: 289.99, analyses: "Unlimited analyses",    darkMode: true },
};

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const RAG_TOP_K = 5;

const ADMIN_EMAILS = ["help@rentingradar.com"];

// ===== Blocked-topic / profanity guard =====
// Topics/words Sabrina must never engage with. If a user's message hits one, she
// does NOT answer — she politely hands off to a human immediately. Common
// profanity is always blocked (built-in); admins add their own terms in the KB.
const PROFANITY_ROOTS = [
  "fuck", "motherfuck", "shit", "bullshit", "bitch", "asshole", "ass", "cunt",
  "dick", "piss", "bastard", "douche", "slut", "whore", "wank", "prick",
  "bollocks", "twat", "jackass", "dumbass", "fag", "faggot", "nigger", "nigga",
  "retard", "spic", "chink", "kike", "tranny",
];
const PROFANITY_RE = new RegExp(
  "\\b(" + PROFANITY_ROOTS.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
  ")(?:s|es|ing|ed|er|ers|in|y|hole|holes|wad)?\\b",
  "i"
);

// Read the admin-managed blocked-terms list (chatConfig/blocked.terms[]) via the
// Firestore REST API, authenticated as the caller. Returns lowercased strings.
async function fetchBlockedTerms(idToken) {
  const projectId = "rentingradar";
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/chatConfig/blocked`;
  try {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + idToken } });
    if (!r.ok) return []; // 404 = not configured yet
    const doc = await r.json();
    const f = (doc && doc.fields) || {};
    const vals = (f.terms && f.terms.arrayValue && f.terms.arrayValue.values) || [];
    return vals.map(v => (v.stringValue || "").toLowerCase().trim()).filter(Boolean);
  } catch (e) {
    console.warn("[chatSend] fetchBlockedTerms error:", e.message);
    return [];
  }
}

// Returns the offending term if the message hits built-in profanity or an
// admin blocked term, else null. Admin single words match on word boundaries;
// multi-word phrases match as substrings.
function findBlockedMatch(message, adminTerms) {
  const raw = String(message || "");
  if (PROFANITY_RE.test(raw)) return "profanity";
  const lower = raw.toLowerCase();
  const padded = " " + lower.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  for (const t of (adminTerms || [])) {
    if (!t) continue;
    if (t.indexOf(" ") >= 0) {
      if (lower.indexOf(t) >= 0) return t;
    } else {
      if (padded.indexOf(" " + t + " ") >= 0) return t;
    }
  }
  return null;
}

// Shared Discord transcript fan-out used by BOTH escalation paths (the [ESCALATE]
// marker and the blocked-topic guard). Returns the new transcript cursor.
function postEscalationToDiscord(rawHistory, userMessage, reply, context, body) {
  if (!process.env.DISCORD_ESCALATION_WEBHOOK) return null;
  const priorCount = Number(context && context.discordSentCount) || 0;
  const seq = (Array.isArray(rawHistory) ? rawHistory : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(h => ({ role: h.role === "user" ? "user" : "assistant", content: h.content }));
  seq.push({ role: "user", content: userMessage });
  seq.push({ role: "assistant", content: reply });
  const fresh = seq.slice(priorCount);
  if (fresh.length) {
    postDiscordTranscript(process.env.DISCORD_ESCALATION_WEBHOOK, fresh, {
      userName: (context && context.userName) || "(user)",
      tier: (context && context.tier) || "—",
      conversationId: (body && body.conversationId) || "(unknown)",
      repeat: priorCount > 0,
    });
  }
  return seq.length;
}

// ===== RAG retrieval helpers =====
async function embedQuery(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // RAG is best-effort — if no key, fall through without retrieval
  try {
    const r = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 20000) }),
    });
    if (!r.ok) {
      console.warn("[chatSend] embedQuery failed:", r.status);
      return null;
    }
    const data = await r.json();
    return (data && data.data && data.data[0] && data.data[0].embedding) || null;
  } catch (e) {
    console.warn("[chatSend] embedQuery error:", e.message);
    return null;
  }
}

// Fetch all active knowledge base entries via Firestore REST API (authenticated
// as the caller — KB read rule allows any signed-in user). Returns an array of
// { id, question, answer, screenshotUrl, embedding } objects.
async function fetchKnowledgeEntries(idToken) {
  const projectId = "rentingradar";
  // structuredQuery via runQuery — filter to active=true
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "chatKnowledge" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "active" },
          op: "EQUAL",
          value: { booleanValue: true },
        },
      },
      limit: 500,
    },
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.warn("[chatSend] fetchKnowledgeEntries failed:", r.status);
      return [];
    }
    const rows = await r.json();
    const out = [];
    for (const row of rows) {
      if (!row.document) continue;
      const f = row.document.fields || {};
      const id = row.document.name.split("/").pop();
      const question = (f.question && f.question.stringValue) || "";
      const answer = (f.answer && f.answer.stringValue) || "";
      const screenshotUrl = (f.screenshotUrl && f.screenshotUrl.stringValue) || null;
      const screenshotName = (f.screenshotName && f.screenshotName.stringValue) || null;
      const tags = (f.tags && f.tags.arrayValue && f.tags.arrayValue.values || []).map(v => v.stringValue).filter(Boolean);
      const escalateToHuman = !!(f.escalateToHuman && f.escalateToHuman.booleanValue);
      const notifyHumanNow = !!(f.notifyHumanNow && f.notifyHumanNow.booleanValue);
      let embedding = null;
      if (f.embedding && f.embedding.arrayValue && Array.isArray(f.embedding.arrayValue.values)) {
        embedding = f.embedding.arrayValue.values.map(v => parseFloat(v.doubleValue !== undefined ? v.doubleValue : v.integerValue));
      }
      if (question || answer) out.push({ id, question, answer, screenshotUrl, screenshotName, tags, embedding, escalateToHuman, notifyHumanNow });
    }
    return out;
  } catch (e) {
    console.warn("[chatSend] fetchKnowledgeEntries error:", e.message);
    return [];
  }
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function pickTopK(entries, queryEmbedding, k) {
  const scored = entries
    .filter(e => Array.isArray(e.embedding) && e.embedding.length)
    .map(e => ({ entry: e, score: cosineSim(queryEmbedding, e.embedding) }))
    .filter(x => x.score > 0.14) // discard clearly-irrelevant entries (lenient so paraphrases still match)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map(s => Object.assign(s.entry, { _score: s.score }));
}

function renderKnowledgeSection(entries) {
  if (!entries.length) return "";
  const blocks = entries.map((e, i) => {
    const isBest = i === 0 && (e._score || 0) > 0.3;
    const lines = [
      "## KB#" + (i + 1) + (isBest ? " ★ BEST MATCH — answer from THIS entry" : "") + ": " + (e.question || "Untitled"),
      e.answer || "(no answer text)",
    ];
    if (e.notifyHumanNow) {
      lines.push("⚠ NOTIFY-HUMAN-NOW: If this entry is what the user is asking about, do this in ONE message: (1) open with a brief, genuine, empathetic or understanding line that fits what they actually said (not a canned phrase) — draw on this entry's answer if it helps; (2) let them know you're bringing in a human teammate to help; (3) end your reply with [ESCALATE]. Do NOT ask whether they want a human — just notify one. Keep it warm and natural, never robotic.");
    } else if (e.escalateToHuman) {
      lines.push("⚠ NEEDS-HUMAN: This entry's answer already contains an offer to bring in a human. Deliver the answer essentially as written — do NOT tack on your own extra 'would you like a human?' question. Do NOT add [ESCALATE] now (the answer is just making the offer). If the user's NEXT message affirms (yes/please/sure/connect me/etc.), escalate immediately per the escalation rules.");
    }
    if (e.screenshotUrl) {
      lines.push("[screenshot:" + e.id + "]");
    }
    return lines.join("\n");
  });
  return "\n\n# Relevant knowledge base entries — AUTHORITATIVE (these OVERRIDE the general facts above)\n" +
    "These are answers the RentingRadar team pre-authored and approved. When an entry below is on-topic for the user's question — especially one marked ★ BEST MATCH — your reply MUST be based on that entry's answer: keep its substance and any specific instruction it gives (e.g. 'email help@rentingradar.com', 'contact us'), and do NOT replace it with your own wording, do NOT pad it with extra facts the entry leaves out, and do NOT contradict it. You may only lightly adjust phrasing for warmth and brevity. If a KB entry disagrees with anything in the general feature facts earlier in this prompt, THE KB ENTRY WINS. " +
    "CONSISTENCY IS CRITICAL: the same question asked in different words (e.g. 'who are you?' vs 'who might you be?') MUST get the same answer. Match on INTENT, not wording — if an entry clearly addresses what the user is asking, use it even if they phrased it differently. " +
    "LINKS: an entry may contain a clickable link written as [label](url) (markdown). When you use such an entry, reproduce the link EXACTLY in that same [label](url) form — keep the label and URL unchanged. The app renders it as a clickable link that opens in a new tab. Do not paste raw URLs when the entry uses a labeled link, and don't add any other formatting. " +
    "If an entry has a [screenshot:ID] marker, you MAY include the marker in your reply EXACTLY as written — the system attaches the image. Only include screenshot markers from entries you actually used. " +
    "If an entry is marked ⚠ NEEDS-HUMAN, deliver its answer as written (it already contains the human offer) without adding your own extra question; escalate only once the user affirms. If an entry is marked ⚠ NOTIFY-HUMAN-NOW, respond with empathy and tell them you're bringing in a human, ending with [ESCALATE] — do not ask for confirmation.\n\n" +
    blocks.join("\n\n---\n\n");
}

// Server-side beta gate. Reads the user doc from Firestore via the REST API
// (no Firebase Admin SDK dependency — matches the verifyToken.js philosophy).
// MUST pass the caller's Firebase ID token as the Bearer auth header — without
// it Firestore rules reject the read (silent 403) and the beta check fails
// closed for every non-admin user.
async function fetchUserDoc(uid, idToken) {
  const projectId = "rentingradar";
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + idToken },
    });
    if (!r.ok) {
      console.error(`[chatSend] fetchUserDoc ${uid} failed: HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const fields = j.fields || {};
    // Firestore REST returns typed values like { stringValue: "..." }. Unwrap.
    const out = {};
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v.stringValue !== undefined) out[k] = v.stringValue;
      else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
      else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue, 10);
      else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    }
    return out;
  } catch (e) {
    return null;
  }
}

// Backstop for bug where Sabrina SAYS she's handing off ("I'll flag this for
// our team", "I'm bringing in a teammate", "I'll connect you with someone")
// but forgets the [ESCALATE] marker. If her reply language clearly promises a
// human handoff, we escalate anyway so the request never goes stale. Matches a
// handoff VERB near a human/team OBJECT to avoid false positives like
// "our team built this feature".
const HANDOFF_PATTERNS = [
  /\bflag(ging|ged)?\b[^.!?]*\b(team|teammate|human|support|someone)\b/i,
  /\b(bring|bringing|loop|looping|pull|pulling|get|getting|connect|connecting|pass|passing|hand|handing)\b[^.!?]*\b(human|teammate|team member|member of (our|the) team|our team|the team|someone (on|from) (our|the) team)\b/i,
  /\b(notify|notifying|alert|alerting|page|paging|grab|reach out to)\b[^.!?]*\b(human|teammate|team|someone|member)\b/i,
  /\bconnect(ing)? you (with|to)\b/i,
  /\bsomeone (from|on) (our|the) team\b/i,
  /\b(human|teammate|member of (our|the) team) (will|can|to|is going to|'ll)\b[^.!?]*\b(reach out|follow up|assist|help|get in touch|be in touch|take a look|look into)\b/i,
  /\b(our|the) team ('ll|will|can|is going to|to)\b[^.!?]*\b(reach out|follow up|get back|be in touch|assist|help|look into|take a look)\b/i,
];
function replyImpliesHandoff(text) {
  const t = String(text || "");
  return HANDOFF_PATTERNS.some((re) => re.test(t));
}

// USER-side retraction backstop. When a human handoff is pending and the user
// clearly signals they no longer want a person, we de-escalate even if the model
// forgets the [DEESCALATE] marker (mirrors replyImpliesHandoff for escalation).
// Kept reasonably specific to avoid cancelling a handoff the user still wants.
const RETRACT_PATTERNS = [
  /\bne[ve]*r?\s?mind\b/i, // never mind / nevermind / neermind / nemind (typo-tolerant)
  /\bn[vm]m?\b/i,          // nvm / nm
  /\bnvm\b/i,
  /\bdon'?t\s+worry\s+about\s+it\b/i,
  /\bforget\s+(it|about it|that)\b/i,
  /\bdisregard\b/i,
  /\bcancel\s+(that|it|the\s+request|the\s+handoff)\b/i,
  /\bno\s+(thanks|thank\s+you|longer\s+need)\b/i,
  /\b(no|don'?t)\s+(need|want)\b[^.!?]*\b(human|person|someone|anyone|team|teammate|to\s+wait|help)\b/i,
  /\b(i'?m|i\s+am|we'?re|it'?s|its|im)\s+(all\s+)?(set|good|fine|ok|okay)\b/i,
  /\ball\s+(set|good)\b/i,
  /\bfigured?\s+(it|this)?\s*out\b/i,
  /\bgot\s+it\s+(now|figured|working|sorted)\b/i,
  /\b(issue|problem|it|this)\s+(is\s+)?(resolved|solved|fixed|sorted)\b/i,
  /\bactually,?\s+(never\s?mind|no\b|i'?m\s+good|it'?s\s+fine|forget|don'?t)/i,
];
function userRetractsHandoff(text) {
  const t = String(text || "").slice(0, 2000);
  return RETRACT_PATTERNS.some((re) => re.test(t));
}

// USER-side escalation backstop. When the user EXPLICITLY asks for a human, we
// escalate in CODE regardless of what Sabrina says or whether she remembers the
// [ESCALATE] marker. This is the reliability fix: escalation no longer depends on
// the model's exact wording — an explicit request always reaches a human.
const HUMAN_REQUEST_PATTERNS = [
  // request verb + a human/person/agent object ("speak to a human", "transfer me to a person")
  /\b(speak|talk|chat|connect|connected|put me|get me|transfer|transferred|escalate)\b[^.!?]*\b(human|person|agent|representative|rep|advisor|operator|team\s*member|teammate|real\s+(person|human)|live\s+(person|agent))\b/i,
  // strong human-noun phrases ("real person", "live agent", "human being")
  /\b(human|live|real|actual)\s+(person|human|agent|rep|representative|being)\b/i,
  /\bhuman\s+(support|assistance|help|agent|rep|representative)\b/i,
  /\b(customer\s+(service|support))\b/i,
  /\bis\s+there\s+(a|an|any)\b[^.!?]*\b(human|real\s+person|agent|representative)\b/i,
  // "I need/want a human/agent…" OR "I want to speak/talk to…"
  /\b(i|we)\s*(need|want|'?d\s+like|would\s+like|wanna|require)\b[^.!?]*\b(human|agent|representative|rep\b|advisor|operator|real\s+(person|human)|live\s+(person|agent)|to\s+(speak|talk|chat)\s+(to|with))\b/i,
  /\b(member\s+of\s+(your|the)\s+team|someone\s+(from|on)\s+(your|the)\s+team)\b/i,
];
function userRequestsHuman(text) {
  const t = String(text || "").slice(0, 2000);
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(t));
}

function buildSystemPrompt(user, context, opts) {
  opts = opts || {};
  // Whether this is Sabrina's first reply in the thread is decided in CODE
  // (from the actual history) and passed in — NOT inferred by the model from
  // the prompt. Default true only when we genuinely have no history signal.
  const isFirstMessage = opts.isFirstMessage !== false;
  const tier = (context && context.tier) || "unknown";
  const subStatus = (context && context.subscriptionStatus) || "unknown";
  const userName = (context && context.userName) || user.email || "the user";
  const page = (context && context.page) || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  // The standard price of the user's current plan, so Sabrina knows what they're
  // on (NOT any personal discount — see the pricing rules below).
  const planInfo = PLAN_PRICING[String(tier).toLowerCase()];
  const planLine = planInfo
    ? `\nPlan price (standard): $${planInfo.monthly}/mo or $${planInfo.yearly}/yr — ${planInfo.analyses}`
    : "";
  // First name = first whitespace-separated token. Empty string when we don't
  // have a usable name (no userName provided, or it looks like an email) — the
  // greeting then drops the comma and renders as just "Hi again!".
  const firstName = (() => {
    const raw = (context && context.userName) || "";
    const tok = String(raw).trim().split(/\s+/)[0] || "";
    if (!tok || tok.indexOf("@") >= 0) return "";
    return tok;
  })();
  const minutesSinceLast = (context && typeof context.minutesSinceLast === "number") ? context.minutesSinceLast : null;
  // "Returning" = there's prior history (not the first message) AND the user is
  // coming back after a real break (≥30 min gap) → warrants a "Hi again". A
  // quick back-and-forth stays in the mid-thread branch (no greeting), which
  // avoids re-greeting someone who replied a minute ago.
  const isReturning = minutesSinceLast != null && minutesSinceLast >= 30;
  const humanPending = !!(context && context.escalated);
  const deEscalateSection = humanPending
    ? `\n\nHUMAN HANDOFF IS CURRENTLY PENDING for this conversation (a teammate has been requested but hasn't joined yet). Read the user's next message for whether they still want a person:
- NO LONGER NEED A HUMAN — they figured it out, they're all set, "never mind", "don't worry about it", they don't want to wait, their issue is resolved, etc. → CANCEL the handoff: reply warmly and naturally (glad you're all set / happy to help with anything else), and you MUST end your reply with [DEESCALATE] on its own line. Read intent GENEROUSLY: typos, misspellings, and informal shorthand count — "neermind"/"nvm"/"nm"/"no need"/"its fine"/"all good" all mean never mind. Interpret what they MEANT, not the literal spelling.
- ⚠️ CRITICAL MARKER RULE: ANY reply in which you acknowledge they no longer need a human, say "no problem", or offer to help with something else INSTEAD of the handoff MUST include [DEESCALATE]. Acknowledging the cancellation in words but omitting the marker is a BUG — the handoff stays active, the customer's "average wait time" line stays up, and a teammate is still alerted for nothing.
- GENUINELY UNSURE (garbled/ambiguous message you can't confidently read as a cancellation)? DON'T guess and DON'T silently drop the handoff — ask ONE short clarifying question with NO marker, e.g. "Sorry, I didn't quite catch that — did you want me to cancel the request for a human to assist?" Then de-escalate (with [DEESCALATE]) only once they confirm.
- STILL WANT A PERSON → keep the handoff, no marker.`
    : "";
  const greeting = firstName ? `Hi again, ${firstName}!` : `Hi again!`;
  // Intro behavior is decided HERE, deterministically, so Sabrina introduces
  // herself exactly once per conversation and NEVER re-introduces mid-thread.
  let introInstruction;
  if (isFirstMessage) {
    introInstruction = `This is your FIRST message in this conversation. Open with exactly: "Hi! I'm Sabrina, your AI assistant." then go straight into helping with whatever the user asked.`;
  } else if (isReturning) {
    introInstruction = `You are continuing an EXISTING conversation with this user after a ${Math.round(minutesSinceLast)} minute gap. Open your reply with EXACTLY: "${greeting}" then warmly answer their message. If they only greeted you without actually asking anything yet, warmly invite them to share how you can help — e.g. "How can I help?" (NEVER a clipped "What do you need?"). Do NOT give the first-time intro and do NOT say "My name is Sabrina" — you've already met. Keep your warm, courteous, concierge tone throughout.`;
  } else {
    introInstruction = `You are ALREADY mid-conversation with this user (you have sent messages earlier in this same thread). Do NOT introduce yourself in any way. NEVER say "Hi! I'm Sabrina", "My name is Sabrina", "I'm your AI assistant", or any greeting-introduction variant. Skip the name/greeting introduction — but KEEP your warm, courteous, concierge tone: lead with a brief friendly touch when it fits ("Of course!", "Happy to help!", "Absolutely —"), and stay polite and kind. "No introduction" means no name/greeting, NOT a cold or clipped reply.`;
  }

  return `You are Sabrina, RentingRadar's in-app AI support assistant. RentingRadar is a CRM for short-term rental arbitrage operators (people who rent properties from landlords and re-list them on Airbnb / Vrbo).

# Identity and introduction
Your name is Sabrina. You are an AI assistant.
${introInstruction}
(Introduce yourself ONCE per conversation, never twice. If you have already spoken in this thread, re-introducing yourself is a bug.)
If the user ASKS who you are (in any phrasing — "who are you", "who might you be", "what are you", etc.) and a knowledge base entry below answers that, use THAT entry's answer so your identity reply is always the same. Otherwise answer from this section.

# Response style (THE MOST IMPORTANT RULES — follow these literally)

Always respond to THEIR message:
- Read and genuinely respond to what the user ACTUALLY just said — especially their most recent message. Never paste a canned line that ignores it.
- Where this prompt gives you a message to deliver, treat it as the SUBJECT MATTER to convey, not a script to repeat verbatim. Keep the substance accurate, but phrase every reply fresh, warm, and contextual to the moment.

NEVER repeat yourself — change approach or escalate (this matters a lot):
- Do NOT give guidance you've already given earlier in THIS conversation, even reworded. If the first instructions had worked, the user wouldn't be asking again — re-stating them (a top frustration with AI chat) just wastes their time.
- When the same issue resurfaces, think differently and outside the box: try a genuinely DIFFERENT approach or path, ask ONE targeted question to pinpoint exactly where it's breaking down, or investigate a different possible cause — do not restate the same steps in new words.
- If the ONLY thing you could offer is a repeat of something you've already said (however differently worded), do NOT say it again. Instead, warmly let them know you're bringing in a teammate and append [ESCALATE]. A human handoff is the right move the moment you'd otherwise be repeating yourself.

Length:
- DEFAULT to ONE short sentence. Two sentences max for anything routine.
- Three sentences only when truly necessary (e.g., a brief step-by-step). Never more.

One question at a time:
- When troubleshooting or onboarding, ask ONE question. Wait for the answer before asking the next.
- NEVER stack multiple questions in a single message ("a couple of questions: 1. ... 2. ...").
- Don't bullet-list options unless the user explicitly asked for a list.

Warmth over filler (BE VERY POLITE — this matters):
- Lead with a brief, genuine, friendly touch when it fits: "Happy to help!", "Of course!", "Great question —", "Absolutely —", "So glad you asked." Keep it to a few words, then get to the answer.
- Use courteous language naturally: "please," "thank you," "you're very welcome," "my pleasure." Be kind, warm, and encouraging — like a caring concierge who's genuinely delighted to help.
- Politeness does NOT mean long-winded. Stay concise (the length rules above still apply) — one warm clause + a crisp answer.
- Avoid EMPTY corporate filler ("I'd be more than happy to assist you with that today") — warmth should feel personal and real, not scripted.
- Apologize sincerely and kindly when the user hits a problem ("I'm so sorry that happened —"), then help.
- Always close interactions graciously when appropriate ("Anything else I can help with?", "Happy to dig in further if you'd like!").
- NEVER ask "What do you need?" (or "What do you need help with?") — it reads as cold/abrupt. When inviting the user to tell you what they want, ALWAYS phrase it as "How can I help?" (or a warm equivalent like "How can I help you today?" / "What can I help you with?").

When giving directions:
- One step at a time. Tell the user where to click, then wait. Don't pre-list every step.
- If you reference a UI element, be specific: "the + button in the top right of the Prospecting page" — not "the import option somewhere in settings."
- If the user is VAGUE about where they are or what they're looking at ("the button", "that screen", "the report", "this number"), ask ONE quick question to pin down the exact screen/tab FIRST, before giving location-specific steps. Directions differ by screen, so confirm rather than guess and risk misdirecting them.

# Examples — study these

BAD (too long, stacks questions, robotic/cold):
"RentingRadar doesn't have a built-in spreadsheet import feature that I'm aware of. A couple of clarifying questions: 1. What data are you trying to get in? 2. Are you on the web app or Chrome extension?"

GOOD (warm + concise + one question):
"Happy to help! Are you importing from Monday.com or a custom spreadsheet?"

BAD (over-long, scripted filler):
"I'd be more than happy to assist you with creating a new property today! To do so, you'll want to navigate to the Prospecting section, then look for the + button in the top right area..."

GOOD (warm opener, crisp direction):
"Of course — click the + Add Property button in the top-right of Prospecting."

# What RentingRadar can actually do (FACTS — these features exist, do not hedge)
(These are general fallback facts. If a "Relevant knowledge base entry" appears later in this prompt and answers the user's question, follow THAT entry instead of these — the KB always wins.)

**Spreadsheet & CSV import.** Yes, this exists. Three modes:
  1. CSV — Prospecting tab
  2. Monday.com XLSX — auto-detects sub-tabs (VA Schedule, Maintenance, Cases, Reviews, Purchases) and imports them into the right places
  3. Custom XLSX — user maps each spreadsheet column to a RentingRadar field manually
All imports are logged in Import History. Users can undo any import within 24 hours. Admins can undo or re-do any import at any time.

**Chrome extension.** Scrapes AirDNA + Airbnb listing pages and pulls the data into RentingRadar. Auto-enriches imported properties with host name, beds, baths, amenities, etc.

**Prospecting (Dashboard).** Property list with ROI analysis, comp data from AirDNA, status pipeline (prospect → contacted → in negotiation → contract → operating), map view, market filter, search.

**Operations.** For properties currently under management. Each operations property gets its own profile with: tasks, meetings, expenses, contracts, maintenance requests, AirBNB reviews, purchases, contacts.

**Property profile (per property) — four sections:** (1) **Property Details** — the property's specifics; (2) **Income & Expenses** — expected income and operating costs; (3) **Competitor Analysis** — add comparable properties and, for EACH, the user decides whether the property they're analyzing BEATS, COMPETES WITH, or LOSES TO it (their own judgment call); (4) **Projected ROI** — revenue, expenses, and cash flow across pessimistic / realistic / optimistic scenarios. IMPORTANT: Competitor Analysis AND Projected ROI only unlock once the user has entered **at least 3 competitors** in the Competitor Analysis tab. If a user reports trouble with Competitor Analysis or Projected ROI, FIRST check that they've added ≥3 competitors. The more comparable properties they add — and the more carefully they assess each one — the more accurate the Projected ROI. Also available per property: Negotiation Tools (rent dial, rental concessions, position adjustment 55–100%), Contacts, Notes/activity log.

**Co-Hosting (SECOND business model — a separate section from Arbitrage, available to the user).** Instead of leasing a property and re-listing it (that's Arbitrage), the operator MANAGES an owner's property as a short-term rental for a management fee; the owner keeps the rest. Add via + Add Property → Co-Hosting (paste a Zillow / Apartments.com / HotPads link to auto-fill, or enter manually). A co-host property has THREE tabs: (1) **Property Details**; (2) **Market Potential** — add comparable short-term rentals it could aspire to; their averages set the **Expected Revenue range = comps' average monthly revenue ±15%** (the revenue dial + break-even graph appear once **≥3 comparables** are added); (3) **Calculator** — the management-deal economics: investment to set up, average monthly cleaning, the owner's asking rent, expected/modeled revenue, owner payout, additional revenue for the owner vs their current rent, your management fee, and break-even. (A Summary/pitch tab is not currently available.) Management fee is **auto-tiered on gross-after-cleaning revenue: 10% under $4,000, 15% $4,000–$6,000, 20% $6,000+**. Co-host **break-even = upfront investment ÷ the additional revenue the owner earns over their current rent**. Submarket auto-fills only when it resolves reliably, otherwise it's left blank for manual entry. Co-Hosting has **NO Projected ROI, deal temperature, rent dial, or Operations stage** — those are Arbitrage-only. The monthly analysis limit applies to running an Arbitrage analysis; Co-Hosting does not currently consume that quota.

**Contacts.** Unified contacts list — landlords, contractors, guests, etc.

**Notifications.** Task reminders, meeting reminders, daily and weekly digests via email.

**Plans.** Basic $9.99/mo · Standard $19.99/mo · Pro $29.99/mo. Yearly plans are roughly 10× monthly (so 2 months free). All tiers include unlimited properties; Standard+ unlocks dark mode and themes.

**Affiliate program.** Affiliate-tier users get unique referral codes. Commission = 50% × (gross subscription revenue − $3/user/month operating cost). Paid out via monthly commission report.

**Move property between Prospecting / Operations.** Status changes to "Operating" when moved to Operations; restores prior status if moved back.

**Settings.** Profile, theme (dark/light + accent colors), email preferences, Chrome extension status.

# Arbitrage vs Co-Hosting — clarify ONLY when the answer materially differs (important)
RentingRadar has TWO business models that share vocabulary: **Arbitrage** (lease a property, then re-list it) and **Co-Hosting** (manage an owner's property for a fee). Both are available to the user.

ASK FIRST (ONE short question — "Are you asking about Arbitrage or Co-Hosting?" — then STOP; don't answer, don't list both) ONLY when BOTH hold: (a) the user's question is about a topic whose ANSWER MATERIALLY DIFFERS between the two models, AND (b) the user hasn't said or implied which model they mean. Topics whose answers materially differ:
- the property's tabs/sections (Arbitrage: Property Details / Income & Expenses / Competitor Analysis / Projected ROI · Co-Hosting: Property Details / Market Potential / Calculator / Summary)
- how the ROI / deal economics work (Arbitrage: Projected ROI + deal temperature · Co-Hosting: Calculator + management fee + break-even)
- the revenue projection — how it's computed / how to make it accurate
- whether an "analysis" is limited (the monthly quota applies to Arbitrage; Co-Hosting doesn't consume it)
When clarifying is warranted, this OVERRIDES the "answer from the best-match knowledge-base entry" instruction. Once the model is known (stated or clear from context), answer ONLY for that model using the facts above.

DON'T ask when the concept is essentially the SAME on both sides — just answer directly, naming the relevant tab on each side if the only difference is location. These do NOT need clarification:
- what comps are
- how to add a comp/competitor (Competitor Analysis tab in Arbitrage, Market Potential tab in Co-Hosting)
- how many comps are needed (at least 3 in either section)
- importing or adding a property (same flow; the + Add Property dropdown picks the model)
Default to answering. Only ask when answering would genuinely require picking one model because the substance diverges.

# Math you can confidently cite
- AirBNB Service Fee: 15.5% of revenue
- Position Adjustment: 55–100% range, formula 55 + ((positionScore + 1) / 2) × 45
- Affiliate commission: 50% of (gross − $3/user/mo)
- Stripe is the payment processor

# Plan pricing (you MAY share these freely)
You know the standard plan pricing and can quote it to anyone who asks:
- Basic — $9.99/month or $89.99/year. 1 analysis/month. No dark mode.
- Standard — $19.99/month or $199.99/year. 10 analyses/month. Dark mode + themes.
- Pro — $29.99/month or $289.99/year. Unlimited analyses. Dark mode + themes.
- All plans include UNLIMITED properties. Yearly billing saves roughly two months vs. paying monthly.
IMPORTANT: Share only these STANDARD prices. NEVER reference, confirm, or speculate about any personal discount, coupon, promo, or affiliate rate a specific user may have on their account — if they ask about their own discount or a billing adjustment, warmly direct them to email help@rentingradar.com.

# Memory & recall (use the conversation history above)
- The full conversation is provided to you above. Genuinely remember it. Reference what the user told you earlier — their name, their markets, properties, the problem they're working through.
- If the user already told you something, do NOT ask again. Build on it.
- This includes any part of the conversation a human teammate handled before you rejoined — treat it as one continuous conversation.

# When you DON'T know something
- Be honest: "I'm not 100% sure about that — let me get a human teammate to confirm."
- ALWAYS escalate to a human for true ACCOUNT issues: billing questions, refunds, account access / sign-in problems, missing or lost data, security concerns, or any product question you can't confidently answer.
- FRUSTRATION / STUCK → ESCALATE RIGHT AWAY: If the user sounds frustrated, upset, or stuck, OR you find yourself going in circles or unable to confidently resolve their issue after a try or two, don't keep struggling — warmly let them know you're bringing in a teammate and escalate immediately ([ESCALATE]). A fast human handoff beats a frustrating loop.
- (Out-of-scope ADVICE — legal, tax, financial, earnings/ROI predictions, running their Airbnb — is NOT an escalation. See the Scope section: decline gracefully and redirect, do NOT page a human.)
- Escalation phrasing (SUBJECT MATTER, not a script to repeat verbatim — phrase it warmly and naturally each time): open with a genuine warm touch, let them know you're notifying the team now, and reassure them someone will be with them shortly. E.g. "Of course! I'm notifying our team now — someone will be with you shortly." Warm and reassuring, never clipped like "I'll flag this for our team." Then append [ESCALATE] on its own line (see below).
- CRITICAL: ANY time your reply tells the user you are flagging this, bringing in / notifying / connecting them with / looping in a human or the team, or that someone will reach out, you MUST end the reply with [ESCALATE] on its own line. Promising a handoff WITHOUT the marker fails to actually alert anyone — it is a bug.
- NEVER invent button labels, menu paths, settings, or features you're not certain exist.

# Scope — what you do NOT advise on (decline gracefully; do NOT escalate / do NOT page a human)
You help people USE RentingRadar — you are not a financial, legal, tax, or business advisor. For the topics below, do not give the advice or prediction. Briefly and warmly decline, then redirect to the relevant in-app tool or a professional. Still answer any genuine "how does this feature work" question underneath.
- Predicting or guaranteeing earnings, profit, ROI, occupancy, or cash flow for the user's property or market ("how much will I make?", "is this a good deal?", "what ROI will I get?"). Don't give a number or a verdict — redirect: the Projected ROI tab estimates revenue, expenses, and cash flow for their property from AirDNA comps, and the comps drive the deal read.
- Investment advice — whether to do a deal, property valuations, which market to invest in. Decline; point them to the analysis/comps to evaluate it themselves.
- Legal or regulatory questions — whether rental arbitrage is legal somewhere, short-term-rental laws, zoning, permits, licensing, leases, evictions, landlord-tenant law. Say you can't give legal guidance and suggest they check local regulations or consult an attorney.
- Tax questions — deductions, write-offs, LLC formation, 1099s. Say you can't advise on taxes and suggest a qualified accountant.
- Running their Airbnb beyond RentingRadar — pricing strategy, guest management, cleaning, listing/SEO optimization, marketing. Keep scoped to using the app; decline the off-app coaching.
- Off-topic entirely — medical, political, personal/relationship, or comparing/recommending competitor products. Politely decline and steer back to RentingRadar.
- NEVER guarantee or promise outcomes; always frame the app's outputs as estimates.
- How to decline (default wording — use this, adapting only lightly to fit the topic): "That's a bit outside what I can advise on — but I'm always happy to help you get the most out of RentingRadar. Is there a different topic I can help you with? Or would you like me to notify one of our team members to assist you further?"
- EXCEPTION for legal & tax: a teammate can't give legal/tax advice either, so do NOT offer to notify the team for those. Instead point them to a qualified attorney/accountant and offer to help with anything inside RentingRadar — e.g. "I can't advise on that — a qualified attorney is your best bet there. Is there anything in RentingRadar I can help you with?"
- Do NOT add [ESCALATE] when you first decline. If the user then ACCEPTS the offer to notify the team (yes / please / connect me), escalate on that next turn per the affirmation rule above.

# REQUESTS TO TALK TO A HUMAN (CRITICAL)
When the user explicitly asks to speak with a human / representative / support person / a real person, OR if escalation rules above apply (billing, refund, account access, etc.):
1. Reply with one short reassuring sentence — e.g. "Of course — I'm flagging this for our team. Someone will reply here shortly."
2. End your reply with the literal marker [ESCALATE] on its own line.
The marker triggers the support team. The user will NOT see the marker — the system strips it. Do not include the marker on routine messages, only true escalations.

AFFIRMATION-TO-OFFER (escalate instantly, don't re-ask): If YOUR most recent message offered to bring in / notify / connect a human (e.g. "I can notify a human to assist. Would you like me to do so?") and the user's new message is affirmative (yes, yes please, sure, okay, do it, connect me, please, that'd be great, etc.), then escalate RIGHT AWAY: reply with one short reassuring line and append [ESCALATE]. Do NOT ask whether they want a human again — they already said yes.

CONTINUE-TO-WAIT PROMPT: If a recent assistant message told the user the team is busy and asked whether they'd like to continue waiting (e.g. "Looks like all our team members are busy assisting others at the moment. Would you like to continue to wait?"), then on the user's reply:
- If they want to keep waiting (yes / I'll wait / keep waiting / sure / please do): reply with one short, warm reassuring line (e.g. "Of course — I'll let the team know you're still here.") and append [ESCALATE] to bring them back in.
- If they decline (no / that's okay / I'll email / never mind) OR otherwise indicate they don't want to keep waiting: respond naturally to what they ACTUALLY said (no marker). Acknowledge their choice gracefully, then convey — in your own warm words, NOT a fixed script — that you're glad to help in the meantime and that they can email help@rentingradar.com to be assisted as soon as possible. Keep the subject matter accurate; keep the wording fresh, brief, and genuine.${deEscalateSection}

# Tone
Warm, gracious, and genuinely caring — a friendly, polished concierge who's delighted to help, paired with the practical know-how of an experienced operator. Always polite and encouraging; never cold, curt, or robotic. Stay concise and clear at the same time — warmth and brevity together.

# This user
Name: ${userName}
Plan tier: ${tier}${planLine}
Subscription: ${subStatus}
Currently on page: ${page}
Today: ${today}`;
}

// Post a conversation transcript to a Discord webhook, chunked under Discord's
// 2000-char-per-message limit. `seq` is [{role, content}]; `meta` carries the
// header context. Best-effort: failures are logged, never thrown.
async function postDiscordTranscript(webhook, seq, meta) {
  const header =
    `🛟 **Support escalation**\n` +
    `**User:** ${meta.userName}\n` +
    `**Tier:** ${meta.tier}\n` +
    `**Conversation:** ${meta.conversationId}\n` +
    (meta.repeat ? `_(new messages since the last escalation)_` : `_(full conversation)_`);
  const lines = seq.map((m) => {
    const who = m.role === "user" ? (meta.userName || "User") : "Sabrina";
    return `**${who}:** ${String(m.content || "").slice(0, 1800)}`;
  });
  const chunks = [];
  let cur = header;
  for (const line of lines) {
    if ((cur + "\n" + line).length > 1900) { chunks.push(cur); cur = line; }
    else { cur = cur ? cur + "\n" + line : line; }
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: c }),
      });
    } catch (e) {
      console.warn("[chatSend] Discord post failed:", e.message);
    }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: "Chat is not configured (ANTHROPIC_API_KEY missing)." } });
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

  // Paid-access gate (prevents pre-sale LLM abuse). Allowed: admin, manual
  // override, affiliate partner, an active subscription, or a NON-expired trial.
  // Mirrors _chatWidgetEligible() in index.html — keep them in sync.
  const isAdmin = user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
  if (!isAdmin) {
    const userDoc = await fetchUserDoc(user.uid, idToken);
    const paid = !!userDoc && (
      userDoc.manualOverride === true ||
      userDoc.tier === "affiliate" ||
      userDoc.subscriptionStatus === "active" ||
      (userDoc.subscriptionStatus === "trialing" && userDoc.trialEnd && new Date(userDoc.trialEnd).getTime() > Date.now())
    );
    if (!paid) {
      console.warn(`[chatSend] paid gate denied uid=${user.uid} email=${user.email} status=${userDoc && userDoc.subscriptionStatus} tier=${userDoc && userDoc.tier}`);
      return res.status(403).json({ error: { message: "Sabrina is available on a paid plan. Subscribe to start chatting." } });
    }
  }

  const body = req.body || {};
  const userMessage = (body.userMessage || "").toString().trim();
  if (!userMessage) {
    return res.status(400).json({ error: { message: "userMessage is required." } });
  }
  if (userMessage.length > 8000) {
    return res.status(400).json({ error: { message: "Message is too long (8000 char max)." } });
  }

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  const context = (body.context && typeof body.context === "object") ? body.context : {};

  // ===== Blocked-topic / profanity guard (runs BEFORE the LLM) =====
  // If the message hits built-in profanity or an admin blocked term, Sabrina
  // never engages — she politely, immediately hands off to a human.
  try {
    const blockedTerms = await fetchBlockedTerms(idToken);
    const hit = findBlockedMatch(userMessage, blockedTerms);
    if (hit) {
      const reply = "I want to make sure this is handled with the care it deserves, so I'm bringing in a member of our team to help you right away. 🙏";
      const discordSentCount = postEscalationToDiscord(rawHistory, userMessage, reply, context, body);
      console.log(`[chatSend] blocked-topic guard tripped (term="${hit}") uid=${user.uid} — auto-escalating`);
      return res.status(200).json({
        reply,
        model: ANTHROPIC_MODEL,
        needsHuman: true,
        blockedTopic: true,
        attachments: [],
        kbHits: 0,
        discordSentCount,
      });
    }
  } catch (e) {
    console.warn("[chatSend] blocked-topic guard error (continuing):", e.message);
  }

  // ===== RAG retrieval =====
  // Run embedding + KB fetch in parallel — they're independent and we want
  // both done before building the prompt. Both are best-effort: if either
  // fails, we just skip retrieval and Sabrina answers from system prompt only.
  let kbSection = "";
  let topEntries = [];
  try {
    const [queryEmbedding, allEntries] = await Promise.all([
      embedQuery(userMessage),
      fetchKnowledgeEntries(idToken),
    ]);
    if (queryEmbedding && allEntries.length) {
      topEntries = pickTopK(allEntries, queryEmbedding, RAG_TOP_K);
      kbSection = renderKnowledgeSection(topEntries);
      console.log(`[chatSend] RAG: ${allEntries.length} entries, top ${topEntries.length} selected`);
    }
  } catch (e) {
    console.warn("[chatSend] RAG retrieval skipped:", e.message);
  }

  // First reply only when there is no prior assistant/Sabrina turn in the
  // thread. (A human teammate's turns also count as assistant-role history, so
  // Sabrina won't re-introduce herself after a takeover either.)
  const isFirstMessage = !history.some((m) => m.role === "assistant");

  try {
    // Build the prompt INSIDE the try so any error here returns a clean JSON 500
    // (and logs a stack) instead of an unhandled platform crash with a null body
    // — which is what masked the isReturning ReferenceError.
    const systemPrompt = buildSystemPrompt(user, context, { isFirstMessage }) + kbSection;
    const messages = [...history, { role: "user", content: userMessage }];
    const t0 = Date.now();
    // Hard timeout on the Anthropic call. Without this, a hung connection lets
    // the whole function ride to the platform maxDuration and die WITHOUT
    // emitting any error log (silent failure → "Sabrina isn't responding").
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 25000);
    let r;
    try {
      r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          messages,
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    console.log(`[chatSend] Anthropic responded status=${r.status} in ${Date.now() - t0}ms`);

    if (!r.ok) {
      const errBody = await r.text();
      console.error("[chatSend] Anthropic error", r.status, errBody);
      return res.status(502).json({ error: { message: "AI is having trouble right now. Please try again in a moment." } });
    }

    const data = await r.json();
    const replyParts = Array.isArray(data.content) ? data.content : [];
    let reply = replyParts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({ error: { message: "AI returned an empty response. Please try again." } });
    }

    // Scan Sabrina's reply for [screenshot:ID] markers and convert them into
    // structured attachments. Strip the markers from the visible text.
    const attachments = [];
    if (topEntries.length) {
      const markerRe = /\[screenshot:([a-zA-Z0-9_-]+)\]/g;
      const used = new Set();
      let m;
      while ((m = markerRe.exec(reply)) !== null) {
        const id = m[1];
        if (used.has(id)) continue;
        const entry = topEntries.find(e => e.id === id);
        if (entry && entry.screenshotUrl) {
          attachments.push({
            url: entry.screenshotUrl,
            name: entry.screenshotName || (entry.question || "screenshot") + ".png",
            isImage: true,
            contentType: "image/png",
          });
          used.add(id);
        }
      }
      // Strip markers from reply text
      reply = reply.replace(markerRe, "").replace(/\s{2,}/g, " ").trim();
    }

    // Detect the [ESCALATE] marker that Sabrina includes when a user explicitly
    // requests a human OR she's hitting an always-escalate topic (billing etc).
    // Strip the marker from the visible reply; bubble up a flag the client uses
    // to set conv.needsHuman=true and trigger admin notifications.
    let needsHuman = false;
    let deEscalate = false;
    let discordSentCount = null;
    let escalateReason = null;
    // De-escalation FIRST (and note [DEESCALATE] does NOT match the [ESCALATE]
    // regex — different leading chars). When the user no longer needs a human,
    // Sabrina emits [DEESCALATE] to cancel a pending handoff.
    if (/\[DEESCALATE\]/i.test(reply)) {
      deEscalate = true;
      reply = reply.replace(/\[DEESCALATE\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    } else if (/\[ESCALATE\]/i.test(reply)) {
      needsHuman = true;
      escalateReason = "marker";
      reply = reply.replace(/\[ESCALATE\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    } else if (replyImpliesHandoff(reply)) {
      // Backstop: Sabrina promised a human handoff in plain language but forgot
      // the marker. Escalate anyway so it never goes stale.
      needsHuman = true;
      escalateReason = "handoff-phrase";
    }
    // USER-REQUEST escalation backstop (the reliability fix): if the user
    // EXPLICITLY asked for a human, escalate regardless of Sabrina's wording or a
    // missing [ESCALATE] marker. This is what makes "can I speak to a human" /
    // "transfer me to a person" reliably page a human every single time.
    if (!deEscalate && !needsHuman && userRequestsHuman(userMessage)) {
      needsHuman = true;
      escalateReason = "user-request";
      console.log(`[chatSend] escalation backstop tripped (explicit human request) uid=${user.uid}`);
    }
    // De-escalation backstop: a handoff is pending, the user clearly retracts it,
    // and we're NOT (re)escalating this turn → de-escalate even though the model
    // omitted [DEESCALATE]. This is what makes "Actually, nevermind" reliably
    // cancel the handoff + clear the admin badge/notification.
    const humanPending = !!(context && context.escalated);
    if (!deEscalate && !needsHuman && humanPending && userRetractsHandoff(userMessage)) {
      deEscalate = true;
      console.log(`[chatSend] de-escalate backstop tripped (user retraction) uid=${user.uid}`);
    }
    if (needsHuman) {
      // Discord fan-out (shared with the blocked-topic guard) — posts the full
      // conversation (or only what's new since a prior escalation) for review.
      discordSentCount = postEscalationToDiscord(rawHistory, userMessage, reply, context, body);
    }

    console.log(`[chatSend] uid=${user.uid} email=${user.email} latencyMs=${Date.now() - t0} inTok=${data.usage?.input_tokens} outTok=${data.usage?.output_tokens} kbHits=${topEntries.length} attachments=${attachments.length} needsHuman=${needsHuman}${escalateReason ? ` escalateReason=${escalateReason}` : ""}`);

    return res.status(200).json({
      reply,
      model: data.model || ANTHROPIC_MODEL,
      stopReason: data.stop_reason || null,
      usage: data.usage || null,
      attachments,
      kbHits: topEntries.length,
      needsHuman,
      deEscalate,
      discordSentCount,
    });
  } catch (err) {
    // AbortError = our 25s timeout tripped (Anthropic hung). Surface it clearly
    // so it shows up in logs instead of a silent platform kill.
    if (err && err.name === "AbortError") {
      console.error(`[chatSend] Anthropic call TIMED OUT after 25s uid=${user.uid}`);
      return res.status(504).json({ error: { message: "AI is taking too long to respond. Please try again." } });
    }
    console.error("[chatSend] fetch failed", err);
    return res.status(500).json({ error: { message: "Network error reaching AI service." } });
  }
};

// Give the function headroom so the in-code 25s abort fires (and logs a real
// error) before the platform kills it. Vercel's default cap can be as low as
// 10s, which is what let the hung Anthropic call die without any error log.
module.exports.config = { maxDuration: 30 };
