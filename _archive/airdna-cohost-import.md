# ARCHIVED — AirDNA Co-Hosting import pipeline (parked 2026-06-28)

> **This folder is NOT loaded by the app.** `index.html` never references `_archive/`,
> so nothing here affects runtime, bundle size, or behavior. It exists only so the
> AirDNA-based Co-Hosting import can be re-enabled later. (This repo is not under git,
> so removed code lives here or nowhere.)

## Why this was parked
Co-Hosting was switched to import rental listings from **Zillow / Apartments.com / HotPads**
exactly like Arbitrage (single-source `listing` scrape), instead of importing STR listings
from **AirDNA** (which also chained out to Airbnb / VRBO / Booking.com). The AirDNA path
brought in data the single-source path can't: STR financials, cross-listing inconsistencies,
and an AI guest-sentiment summary. Those CRM features were removed; this archive preserves them.

## What the AirDNA pipeline did (methodology)
1. CRM called `rrScrapeViaExtension(url, 'cohost')`.
2. Extension `scrapeAny()` treated `hint==='cohost'` as `kind='airdna'` **with `wantFullProperty=true`**:
   - Scraped the **AirDNA** detail panel → revenue potential, annual revenue, occupancy, ADR,
     days available, market/submarket, market score, price tier, listing title, AI summary
     (scoped `co*` fields so comp fields stayed untouched).
   - Followed the AirDNA page's **Airbnb** link → `airbnb-scraper.js` for beds/baths/guests/host,
     amenities (from embedded JSON `"available":true`, with a `SAFETY_RE` filter dropping the
     "Safety & property" disclosures like "Pool/hot tub without a gate or lock"), `_fullPageText`.
   - If present, followed **VRBO** (`vrboLink`) and **Booking.com** (`bookingLink`) via the generic
     `vrbo-scraper.js` (amenity-section anchored scrape).
   - Ran `extractPropertyDetailsFromText` + `groundPropertyDetails` over the combined text → `propertyDetails`.
   - `cohostCompareListings({Airbnb, VRBO, 'B.com'})` (using each platform's **scoped amenities list**,
     NOT full page text) → `_inconsistencies` (conflict / mismatch per `COHOST_COMPARE_AMENITIES`),
     plus a consolidated "Listing title" entry when titles differed.
   - Condensed the AirDNA AI summary (Claude in the extension, or a local fallback).
3. CRM `importCohostFromAirDNA()` built the co-host record: `cohost.{annualRevenue,occupancy,
   nightlyRate,daysAvailable,revenuePotential,marketScore,priceTier,amenities[],inconsistencies[]}`,
   `links.{airbnb,vrbo,booking}`, `propertyDetails` (incl. `listingTitle`, `market`, `submarket`),
   and a structured `propertyNote` rendered by `_cohostRenderAiSummary()`.

## Where the code lives now
- **Extension side — STILL PRESENT but DORMANT** (never invoked once the CRM stops sending
  `kind:'cohost'`). No re-publish was done; these still ship in the extension:
  - `chrome-extension/background/service-worker.js` — `scrapeAny` cohost branch (`wantFullProperty`),
    `cohostCompareListings`, `COHOST_COMPARE_AMENITIES`, the VRBO+Booking chain, title comparison.
  - `chrome-extension/content/airbnb-scraper.js` — amenities-from-JSON + `SAFETY_RE`.
  - `chrome-extension/content/vrbo-scraper.js` — generic amenity-section scraper (VRBO + Booking).
  - `chrome-extension/content/airdna-scraper.js` — `findBookingLink`, AI-summary capture.
  - `chrome-extension/manifest.json` — `host_permissions` for airbnb/vrbo/booking/airdna.
- **CRM side — REMOVED from `index.html`, preserved verbatim here:**
  - [`airdna-cohost-import-CRM-code.js.txt`](airdna-cohost-import-CRM-code.js.txt) — the exact functions/constants:
    platform icons (`_ICON_AIRBNB/_VRBO/_AIRDNA/_BOOKING`, `_AIRDNA_BLUE`), `importCohostFromAirDNA`,
    `_condenseAiSummary`, `_cohostShowAddChoice` (AirDNA add UI), `_cohostShowManualForm`,
    `saveCohostManual` (AirDNA-era fields), `_cohostNoteToBullets`, `_cohostRenderAiSummary`,
    `_cohostMetricsStrip`, `_cohostPlatformLink`, and the Listing-Inconsistencies UI
    (`_cohostMergeIncons`, `_cohostIncRow`, `cohostToggleIncShow`, `_cohostSummaryInconsistencies`).

## How to re-enable (later)
1. Paste the functions/constants from the `.js.txt` back into `index.html` (inside the main `<script>`).
2. Restore the AirDNA add UI: have `openCohostAddModal` call the archived `_cohostShowAddChoice`
   (the AirDNA paste variant) instead of the new listing-paste flow.
3. Re-add the profile sections that consumed this data: the **Listing Inconsistencies** card +
   Show checkboxes (in `_cohostDetailsTab`), the **AirDNA metrics strip** (`_cohostMetricsStrip`),
   and the structured **AI summary** Property Note render (`_cohostRenderAiSummary`).
4. Restore the multi-platform link row in the sticky (AirDNA/Airbnb/VRBO/Booking via `_cohostPlatformLink`).
5. The extension already supports `kind:'cohost'` (dormant), so no extension change is needed to re-enable —
   unless a cleanup re-publish has since stripped it. Verify `scrapeAny` still has the cohost branch.

## Co-host record shape under the AirDNA pipeline (for reference)
See the `importCohostFromAirDNA` block in the `.js.txt`. Key extra fields vs the new listing flow:
`cohost.{annualRevenue,occupancy,nightlyRate,daysAvailable,revenuePotential,marketScore,priceTier,
amenities[],inconsistencies[],shownInconsistencies[]}`, `links.{airbnb,vrbo,booking}`,
`propertyDetails.listingTitle`, and an `AirDNA AI`-sourced `propertyNote`.
