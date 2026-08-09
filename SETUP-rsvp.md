# Meeting RSVP Notifications — Setup

Wires invitee RSVPs (accept / decline / tentative / propose-new-time) back to the
meeting owner via email + live in-app status. Code ships with the app; the steps
below are the one-time external setup only you can do.

## How it works

1. Meeting invites list the organizer email as a RentingRadar inbox we receive at
   (`RSVP_ORGANIZER_EMAIL`, e.g. `rsvp@parse.rentingradar.com`), shown under the
   operator's name.
2. When an invitee accepts/declines/etc., their calendar emails the RSVP there.
3. SendGrid **Inbound Parse** delivers that email to the **`inboundRsvp` Cloud
   Function**. (It runs inside Google Cloud, so it writes to Firestore with no
   downloadable key — this is why we moved it off Vercel: the org policy blocks
   key creation.)
4. The function parses the `.ics`, matches the meeting by UID, updates
   `meetingInvites/{meetingId}`, and emails the owner.
5. The meeting's details modal shows each guest's live status.

## One-time setup

### 1. DNS — add an MX record
At your DNS host, for host `parse` (→ `parse.rentingradar.com`):
```
Type: MX   Host: parse   Value: mx.sendgrid.net   Priority: 10
```
(On Cloudflare, set it to "DNS only" / grey cloud.)

### 2. Deploy the Cloud Function first (so the URL exists)
```
cd rentingradar-app/functions
npm install            # picks up busboy
cd ..
firebase deploy --only functions:inboundRsvp
```
After deploy, the function URL is:
```
https://us-central1-rentingradar.cloudfunctions.net/inboundRsvp
```
(If the CLI prints a different region/URL, use what it prints.)

### 3. SendGrid → Inbound Parse
SendGrid dashboard → Settings → **Inbound Parse** → **Add Host & URL**:
- Receiving Domain: `parse.rentingradar.com`
- Destination URL: the function URL from Step 2
- "POST the raw, full MIME message": **unchecked**
- "Check incoming emails for spam": **unchecked**

### 4. Set the organizer address (Vercel env)
`sendMeetingInvite` still runs on Vercel, so this env var goes there:
```
cd rentingradar-app
npx vercel env add RSVP_ORGANIZER_EMAIL production
# value: rsvp@parse.rentingradar.com   (sensitive: N)
```

**No service-account key needed** — the Cloud Function authenticates itself. The
`FIREBASE_SERVICE_ACCOUNT` step from the earlier plan is gone.

### 5. Deploy the rest
```
cd rentingradar-app
npx vercel --prod                         # updated sendMeetingInvite (organizer addr)
firebase deploy --only firestore:rules    # meetingInvites rules
firebase deploy --only hosting            # frontend: meetingInvites write + status UI
```

## Testing
1. Create a meeting, invite a second address you control, send.
2. From that address, **Accept**.
3. Within ~a minute you should get an email: "✅ Accepted: [title]".
4. Open the meeting → details modal → that guest shows "✓ accepted".
5. Try Decline and "propose a new time" too.

## Notes / limits
- Deploy-safe before DNS/Parse are live: meetings still send (organizer falls back
  to `help@rentingradar.com`); RSVPs just won't route back yet.
- Gmail/Outlook RSVP routing is reliable; Apple Calendar is the least predictable.
- Live RSVP inside *your own* calendar grid (no "add to calendar" step) still needs
  the Google/Microsoft OAuth integration — separate, larger build.
