const sgMail = require("@sendgrid/mail");
const { verifyFirebaseToken } = require("./verifyToken");

const ADMIN_EMAIL = "help@rentingradar.com";
const FROM = { email: "help@rentingradar.com", name: "RentingRadar" };

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  if (!user.email) {
    return res.status(400).json({ error: { message: "No email on token." } });
  }

  const body = req.body && (req.body.data || req.body) || {};
  const name = body.name || "";
  const signupMethod = body.signupMethod || "unknown";
  const referredBy = body.referredBy || null;

  if (!process.env.SENDGRID_API_KEY) {
    return res.status(500).json({ error: { message: "SENDGRID_API_KEY not configured" } });
  }

  const signupTime = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#0d1017;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1017;padding:40px 20px"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#141824;border-radius:12px;overflow:hidden">' +
    '<tr><td style="padding:30px 30px 10px">' +
      '<h2 style="margin:0 0 16px;color:#a855f7;font-size:22px">New User Signup</h2>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155;width:120px">Name</td>' +
          '<td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">' + escHtml(name || "—") + '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Email</td>' +
          '<td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155"><a href="mailto:' + escHtml(user.email) + '" style="color:#818cf8">' + escHtml(user.email) + '</a></td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">UID</td>' +
          '<td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155;font-family:monospace;font-size:12px">' + escHtml(user.uid) + '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Method</td>' +
          '<td style="padding:8px 12px;color:#f1f5f9;border-bottom:1px solid #334155">' + escHtml(signupMethod) + '</td>' +
        '</tr>' +
        (referredBy ? '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8;border-bottom:1px solid #334155">Referred By</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #334155"><span style="background:rgba(99,129,250,.15);color:#818cf8;padding:3px 9px;border-radius:5px;font-family:monospace;font-weight:700;font-size:12px">' + escHtml(referredBy) + '</span></td>' +
        '</tr>' : '') +
        '<tr>' +
          '<td style="padding:8px 12px;color:#94a3b8">Signed Up</td>' +
          '<td style="padding:8px 12px;color:#f1f5f9">' + escHtml(signupTime) + ' ET</td>' +
        '</tr>' +
      '</table>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 30px;border-top:1px solid #252a3d;text-align:center">' +
      '<p style="margin:0;font-size:12px;color:#4b5068">RentingRadar &middot; help@rentingradar.com</p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: ADMIN_EMAIL,
      from: FROM,
      subject: "New Signup: " + user.email,
      html: html,
      categories: ["admin-new-user"],
    });
    console.log("Admin signup notification sent for", user.email);
    return res.status(200).json({ result: { data: { sent: true } } });
  } catch (err) {
    console.error("notifyAdminSignup error:", err && err.response && err.response.body || err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to send admin notification." } });
  }
};
