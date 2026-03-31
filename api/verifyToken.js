// Shared helper: Verify Firebase ID tokens WITHOUT Firebase Admin SDK
// Uses Google's public certificates directly

const jwt = require("jsonwebtoken");

const GOOGLE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const PROJECT_ID = "rentingradar";

let cachedCerts = null;
let certsExpiry = 0;

async function fetchCerts() {
  const now = Date.now();
  if (cachedCerts && now < certsExpiry) return cachedCerts;

  const res = await fetch(GOOGLE_CERTS_URL);
  cachedCerts = await res.json();

  // Cache based on Cache-Control header, default 1 hour
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) * 1000 : 3600000;
  certsExpiry = now + maxAge;

  return cachedCerts;
}

async function verifyFirebaseToken(idToken) {
  // Decode header to get kid
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error("Invalid token format");
  }

  const certs = await fetchCerts();
  const cert = certs[decoded.header.kid];
  if (!cert) throw new Error("No matching certificate found for kid: " + decoded.header.kid);

  // Verify the token
  const payload = jwt.verify(idToken, cert, {
    algorithms: ["RS256"],
    audience: PROJECT_ID,
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Token has no valid subject (uid)");
  }

  return {
    uid: payload.sub,
    email: payload.email || "",
  };
}

module.exports = { verifyFirebaseToken };
