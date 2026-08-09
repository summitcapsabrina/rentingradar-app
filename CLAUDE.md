# RentingRadar – Project Context for Claude Code

## Overview
RentingRadar is a rental arbitrage CRM (Customer Relationship Management) web application. Users analyze properties for short-term rental potential by importing competitor data from AirDNA and Airbnb via a Chrome extension, tracking expenses, and evaluating deal viability.

## Tech Stack
- **Frontend**: Single-page app in `index.html` (vanilla JS, no framework). This is a large file (~12,000+ lines).
- **Hosting**: Firebase Hosting (`firebase deploy --only hosting`)
- **Backend (primary)**: Vercel serverless API routes in `api/` (admin actions, meeting invites, token verification, Stripe)
- **Backend (secondary)**: Firebase Cloud Functions in `functions/` (checkout, subscriptions, email preferences, AI enrichment, auth triggers)
- **Auth**: Firebase Authentication (email/password + Google sign-in)
- **Database**: Firebase Firestore
- **Email**: SendGrid (transactional emails, meeting invites with .ics attachments)
- **Payments**: Stripe (subscriptions via checkout sessions)
- **Chrome Extension**: Manifest V3, located in `chrome-extension/`

## Key Files
- `index.html` — The entire CRM frontend (SPA). All tabs, modals, and logic live here.
- `functions/index.js` — Firebase Cloud Functions (Stripe, email, AI enrichment, auth triggers)
- `api/` — Vercel serverless API routes
- `api/adminFinancials.js` — Admin-only Stripe financial dashboard data (balance, revenue, MRR, payouts, subscriptions)
- `api/adminCancelSubscription.js` — Admin-only subscription cancellation with SendGrid cancellation email to user
- `api/verifyToken.js` — Shared Firebase token verification (uses Google public certs, not Admin SDK)
- `api/sendMeetingInvite.js` — Meeting invite emails with .ics attachments (uses SendGrid)
- `firebase.json` — Hosting config and Cloud Function rewrites
- `vercel.json` — Vercel API route configuration
- `chrome-extension/manifest.json` — Extension manifest (currently v1.15.0)
- `chrome-extension/content/airdna-scraper.js` — Scrapes AirDNA listing pages for competitor data
- `chrome-extension/content/airbnb-scraper.js` — Scrapes Airbnb listing pages for property details
- `chrome-extension/content/listing-scraper.js` — Scrapes rental listing sites (Zillow, Apartments.com, HotPads, etc.)
- `chrome-extension/service-worker.js` — Extension background script, coordinates scraping
- `deploy.sh` — Push to GitHub + `npx vercel --prod` in one command

## Architecture Notes
- The CRM is a single HTML file with tab-based navigation. Tabs include: Dashboard, Contacts, Notifications, Plan, Tutorial, Settings, and admin-only Users view.
- The Chrome extension scrapes listing sites and sends data to the CRM via `window.postMessage`. The CRM detects the extension via `ARBFLOW_EXTENSION_READY` / `ARBFLOW_HEALTH_RESPONSE` messages.
- Competitor data is imported from AirDNA (financial metrics, occupancy, days available) and enriched with Airbnb data (host name, guests, beds, baths).
- Expenses tab and Competitor Analysis tab are synced — changes in expenses immediately re-render the analysis tab.

## Admin System
- **Admin emails**: `help@rentingradar.com` (hardcoded in API routes and Firestore rules)
- **Admin Users panel**: Available in sidebar for admin users. Shows user list with donut charts (Status, Payment, Tier), financial dashboard (Stripe data), and user edit modal.
- **Admin tier**: `admin` tier in TIERS object — free, auto-sets `manualOverride`, purple gradient pill (`#a855f7` → `#6366f1`)
- **Tier hierarchy**: `{ basic:0, standard:1, pro:2, admin:3 }` used in `requireTier()`
- **Financial dashboard**: Calls `api/adminFinancials.js` (Vercel) for Stripe balance, revenue (monthly/yearly/MRR), fees, refunds, payouts, subscriptions
- **Cancel subscription**: `api/adminCancelSubscription.js` cancels via Stripe at period end and sends cancellation email via SendGrid
- **User edit modal**: Tier/status dropdowns, manual override checkbox, Cancel Subscription button (routes through Stripe API), quick actions (View as User, Copy UID, Reset to No Plan)
- **Firestore rules**: Admin email (`help@rentingradar.com`) can read/write all user docs and subcollections

## Email System (SendGrid)
- **FROM_EMAIL**: `help@rentingradar.com` / "RentingRadar"
- **Domain auth**: SPF/DKIM via em93.rentingradar.com
- **Email wrapper**: Dark-themed HTML template in `functions/index.js` (`emailWrapper()` function) — all emails use this
- **Existing email triggers in `functions/index.js`**:
  - `exports.onUserCreated` — `auth.user().onCreate()` trigger: sends welcome email to new user AND admin notification to `help@rentingradar.com`
  - `exports.testAdminNotification` — HTTP endpoint to test admin new-user notification email
  - `exports.sendWelcomeEmail` — HTTP endpoint for welcome email (called by frontend)
  - `exports.onUserDeleted` — `auth.user().onDelete()` trigger
  - `exports.weeklyUpgradeNudge` — Pub/Sub scheduled function
  - `exports.dailyTrialReminders` — Pub/Sub scheduled function
  - `exports.sendAnalysisLimitEmail` — Callable function for analysis limit notifications
- **Cancellation email**: Sent from `api/adminCancelSubscription.js` (Vercel, not Firebase) using SendGrid directly
- **sendEmail() helper**: In `functions/index.js` — `async function sendEmail(to, subject, htmlContent, options)` with support for unsubscribe headers, categories

## Pricing Tiers
```javascript
// App (index.html) TIERS object
basic:    { name:'Basic',    monthly:9.99,  yearly:89.99,  maxProperties:Infinity, darkMode:false }
standard: { name:'Standard', monthly:19.99, yearly:199.99, maxProperties:Infinity, darkMode:true }
pro:      { name:'Pro',      monthly:29.99, yearly:289.99, maxProperties:Infinity, darkMode:true }
admin:    { name:'Admin',    monthly:0,     yearly:0,      maxProperties:Infinity, darkMode:true }
```
- **Analysis limits**: Basic=1/month, Standard=10/month, Pro=Unlimited
- **Feature gating**: Dark mode & themes gated at `standard`+. CSV, Negotiation Forecasting, Operations all available on Basic.
- **No-plan lockout**: `renderLockoutScreen()` shows pricing cards with `auth-signin-prompt lockout` class (960px max-width). Uses `renderPricing({hideHeader:true})` to avoid redundant headers.
- **Manual override**: `manualOverride` flag on user doc prevents Stripe webhook sync from overwriting tier/status

## Important Conventions
- **Label spelling**: "AirBNB" (not "Airbnb") in user-facing UI labels and line items.
- **Phone numbers**: Validated to exactly 10 digits, auto-formatted as `(XXX) XXX-XXXX`, input type="tel" with maxlength="14".
- **Service Fee calculation**: `avgDailyRate × daysOccupied ÷ 12 × 15.5%` where `daysOccupied` comes from comp average `daysAvailable` (NOT `365 × occupancy%`).
- **Average Revenue display**: Uses actual `annualRevenue` field averaged from comps, not re-derived from rate × days × occupancy.
- **Position Score formula**: `(-1 × loses + 0 × competes + 1 × beats) ÷ total comps` → range -1.0 to +1.0
- **Market Percentile formula**: `(beats + 0.5 × competes) ÷ total comps × 100`
- **Position Adjustment formula**: `55 + (positionScore + 1) ÷ 2 × 45` → range 55% to 100%
- **Amenity patterns**: `AMENITY_PATTERNS` dictionary in `listing-scraper.js` supports multi-label entries (one regex → multiple labels). Pet policy uses "No Pets" override logic.
- **Firestore timestamps**: Come as `{seconds, nanoseconds}` plain objects in collection queries, not Timestamp instances. `_adminFormatDate()` handles both via `val.seconds` fallback.

## Deployment
- **CRM (frontend)**: `firebase deploy --only hosting` from project root (deploys to `rentingradar` site → `app.rentingradar.com`)
- **Marketing website**: Separate repo `rentingradar-website/`, deploys via `firebase deploy --only hosting` to `rentingradar-website` site
- **Vercel API**: `npx vercel --prod` (auto-deploy from GitHub is NOT working — must deploy manually)
- **Firebase Functions**: `firebase deploy --only functions` or target specific: `firebase deploy --only functions:onUserCreated`
- **Quick deploy script**: `./deploy.sh` — pushes to GitHub then runs `npx vercel --prod`
- **Chrome Extension**: Zip the `chrome-extension/` folder, upload to Chrome Web Store
- **IMPORTANT**: Vercel auto-deploy from GitHub pushes is broken. Always run `npx vercel --prod` manually after pushing.

## Firebase Hosting Sites
- `rentingradar` → `https://rentingradar.web.app` → `app.rentingradar.com` (the CRM app)
- `rentingradar-website` → `https://rentingradar-website.web.app` → `rentingradar.com` (marketing site)

## Firestore Security Rules
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && (request.auth.uid == userId || request.auth.token.email == "help@rentingradar.com");
      match /{document=**} {
        allow read, write: if request.auth != null && (request.auth.uid == userId || request.auth.token.email == "help@rentingradar.com");
      }
    }
    match /tutorialContent/{doc} {
      allow read: if true;
      allow write: if request.auth != null &&
        (request.auth.token.email == "help@rentingradar.com" ||
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.admin == true);
    }
  }
}
```

## Vercel Environment Variables Required
- `STRIPE_SECRET_KEY` — Stripe API secret key
- `SENDGRID_API_KEY` — SendGrid API key (needed for cancellation emails in `adminCancelSubscription.js`)
- Firebase token verification uses Google public certs (no Firebase Admin SDK env vars needed)

## Current Work / Known Issues (as of May 2026)
- **Vercel auto-deploy broken**: GitHub pushes don't trigger Vercel builds. Must run `npx vercel --prod` manually.
- **Browser cache**: After firebase deploy, users may need hard refresh (Cmd+Shift+R) to see changes.
- **Cancellation email**: `api/adminCancelSubscription.js` sends via SendGrid when admin cancels a user's subscription. Verify `SENDGRID_API_KEY` is set in Vercel env vars.
- **New user signup notification**: `exports.onUserCreated` in `functions/index.js` sends admin notification to `help@rentingradar.com`. Also has `exports.testAdminNotification` HTTP endpoint for testing. Needs `firebase deploy --only functions:onUserCreated,functions:testAdminNotification` to deploy.
- **Operations screenshot**: Website references `screenshots/operations.webp` which needs to be created.
- **Stripe weekly payouts**: Need to configure in Stripe Dashboard → Settings → Payouts → Weekly, Friday.

## Git Notes
- Untracked files to generally ignore: `firebase-debug*.log`, `index 2.html` (backup), `zirjfaRn`, `.fuse_hidden*`, extension zip files
- The `.gitignore` should be reviewed — some generated/temp files are showing as untracked
