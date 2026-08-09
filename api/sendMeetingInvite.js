const sgMail = require("@sendgrid/mail");
const { verifyFirebaseToken } = require("./verifyToken");

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  const body = req.body.data || req.body;
  const meetingDate = body.meetingDate || "";
  const meetingTime = body.meetingTime || "";
  const contactName = body.contactName || "";
  const propertyAddress = body.propertyAddress || "";
  // User-set meeting title → calendar SUMMARY + email subject. Falls back to a
  // generic label. Never includes the contact's name automatically.
  const meetingTitle = (typeof body.meetingTitle === "string" && body.meetingTitle.trim()) ? body.meetingTitle.trim() : "Meeting";
  // The signed-in user IS the meeting organizer. Their name (for display) +
  // their email (from the verified token) make them the ORGANIZER so RSVPs
  // route back to them, not to RentingRadar.
  const organizerName = (typeof body.organizerName === "string" && body.organizerName.trim()) ? body.organizerName.trim() : (user.email ? user.email.split("@")[0] : "Organizer");
  // The note shown on the invite is the meeting's OWN note. Property notes are
  // intentionally NOT accepted/sent — they may contain sensitive material.
  const meetingNote = typeof body.meetingNote === "string" ? body.meetingNote.trim() : "";
  const durationMinutes = body.durationMinutes || 60;
  const timezone = body.timezone || "America/New_York";

  // Option A (update-in-place) + B (attendees) params:
  const method = body.method === "CANCEL" ? "CANCEL" : "REQUEST";
  const sequence = Number.isFinite(body.sequence) ? Math.max(0, Math.floor(body.sequence)) : 0;
  // Stable per-meeting UID so updates/cancels modify the existing event instead
  // of creating duplicates. Fall back to a unique UID if the client didn't send one.
  const meetingUid = (typeof body.meetingUid === "string" && body.meetingUid)
    ? body.meetingUid
    : ("rr-meeting-" + user.uid + "-" + Date.now() + "@rentingradar.com");
  // Attendees (emails). Validate lightly and dedupe against the organizer.
  const attendeesRaw = Array.isArray(body.attendees) ? body.attendees : [];
  const attendees = attendeesRaw
    .filter(function (e) { return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()); })
    .map(function (e) { return e.trim(); })
    .filter(function (e, i, a) { return a.indexOf(e) === i && e.toLowerCase() !== user.email.toLowerCase(); });

  if (!meetingDate || !meetingTime) {
    return res.status(400).json({ error: { message: "Meeting date and time are required." } });
  }

  if (!user.email) {
    return res.status(400).json({ error: { message: "No email on file." } });
  }

  try {
    // Parse date parts manually to avoid timezone issues
    var dateParts = meetingDate.split("-");
    var timeParts = meetingTime.split(":");
    var yr = dateParts[0], mo = dateParts[1], dy = dateParts[2];
    var hr = timeParts[0], mn = timeParts[1] || "00";

    // Convert the meeting's wall-clock time (in its IANA timezone) to a precise
    // UTC instant, then emit the .ics in UTC (DTSTART:...Z). This avoids needing
    // a VTIMEZONE block — incomplete VTIMEZONE is what makes Google's "Add to
    // Calendar" fail with "Something went wrong." Every client converts the UTC
    // instant to the viewer's local time, which is the correct behavior.
    function wallClockToUTC(Y, Mo, D, H, Mi, tz) {
      var asUTC = Date.UTC(Y, Mo - 1, D, H, Mi, 0);
      var dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
      var map = {};
      dtf.formatToParts(new Date(asUTC)).forEach(function (p) { map[p.type] = p.value; });
      var h24 = map.hour === "24" ? "00" : map.hour; // some envs emit 24 for midnight
      var tzWallAsUTC = Date.UTC(+map.year, (+map.month) - 1, +map.day, +h24, +map.minute, +map.second);
      var offset = tzWallAsUTC - asUTC; // how far ahead of UTC the tz is at that instant
      return new Date(asUTC - offset);
    }
    function pad2(n) { return String(n).padStart(2, "0"); }
    function fmtUTC(d) {
      return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
        "T" + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + "00Z";
    }
    var startUTCDate = wallClockToUTC(parseInt(yr, 10), parseInt(mo, 10), parseInt(dy, 10), parseInt(hr, 10), parseInt(mn, 10), timezone);
    var endUTCDate = new Date(startUTCDate.getTime() + durationMinutes * 60000);
    var icsStartUTC = fmtUTC(startUTCDate);
    var icsEndUTC = fmtUTC(endUTCDate);
    var icsStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    // Human-readable date/time
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var dtObj = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy));
    var dayName = dayNames[dtObj.getDay()];
    var monthName = months[parseInt(mo) - 1];
    var meetingDateFmt = dayName + ", " + monthName + " " + parseInt(dy) + ", " + yr;

    // Format 24h to 12h (start time, in the meeting's wall-clock terms)
    var h = parseInt(hr, 10);
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    var meetingTimeFmt = h12 + ":" + mn + ampm.toLowerCase();
    // End time = start + duration, kept in the same wall-clock day for display.
    var endTotalMin = parseInt(hr, 10) * 60 + parseInt(mn, 10) + durationMinutes;
    var ehRaw = Math.floor(endTotalMin / 60) % 24;
    var emRaw = endTotalMin % 60;
    var eampm = ehRaw >= 12 ? "PM" : "AM";
    var eh12 = ehRaw === 0 ? 12 : ehRaw > 12 ? ehRaw - 12 : ehRaw;
    var endTimeFmt = eh12 + ":" + pad2(emRaw) + eampm.toLowerCase();

    // Get timezone abbreviation (e.g. "PST", "EST", "CST")
    var tzAbbr = "";
    try {
      var sample = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy), h, parseInt(mn));
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(sample);
      var tzPart = parts.find(function(p) { return p.type === "timeZoneName"; });
      if (tzPart) tzAbbr = tzPart.value;
    } catch(e) { tzAbbr = ""; }

    var contact = contactName || "the landlord/property manager";
    var loc = propertyAddress || "";
    var isCancel = method === "CANCEL";

    // Build .ics description from the MEETING note only (no property notes).
    // Escape commas/semicolons/newlines per the iCalendar spec.
    function icsEscape(s){
      return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    }
    var icsDesc = "";
    if (propertyAddress) icsDesc += "Property: " + propertyAddress;
    if (meetingNote) icsDesc += (icsDesc ? "\\n\\n" : "") + icsEscape(meetingNote);
    icsDesc += (icsDesc ? "\\n\\n" : "") + "Scheduled via RentingRadar CRM";

    // ORGANIZER display name = the signed-in user, but the organizer EMAIL is a
    // RentingRadar inbox we actually receive at (RSVP_ORGANIZER_EMAIL). That's
    // what makes attendee RSVP replies land somewhere we can parse + forward —
    // a "spoofed" user-as-organizer gets its replies suppressed by providers.
    // The inboundRsvp webhook matches the reply to the meeting by UID and emails
    // the real owner. SENT-BY records that RentingRadar manages it.
    var rsvpOrganizerEmail = process.env.RSVP_ORGANIZER_EMAIL || "help@rentingradar.com";
    var organizerLine = 'ORGANIZER;CN=' + organizerName + ';SENT-BY="mailto:help@rentingradar.com":mailto:' + rsvpOrganizerEmail;

    // ATTENDEE lines: the organizer first (auto-accepted, role CHAIR), then each
    // invitee (RSVP requested). Invitees' accept/decline replies go to ORGANIZER.
    var attendeeLines = ["ATTENDEE;CN=" + organizerName + ";ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:" + user.email];
    attendees.forEach(function (em) {
      attendeeLines.push("ATTENDEE;CN=" + em.split("@")[0] + ";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:" + em);
    });

    // Alarms only make sense on a live event, not a cancellation.
    var alarmLines = isCancel ? [] : [
      "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Meeting with " + contact + " in 30 minutes", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Meeting with " + contact + " in 10 minutes", "END:VALARM"
    ];

    // Build the .ics for a given METHOD. Times are UTC (no VTIMEZONE) for max
    // compatibility. Same UID + higher SEQUENCE = calendars update in place.
    //  - REQUEST (attendees): RSVP buttons; replies route to the organizer.
    //  - PUBLISH (organizer's own copy): a clean "Add to Calendar" event with NO
    //    ORGANIZER/ATTENDEE lines — Gmail can't render/import a REQUEST where the
    //    recipient is the organizer, and chokes on organizer-RSVP semantics in a
    //    PUBLISH, so we keep the PUBLISH event minimal. Same UID so it reconciles.
    //  - CANCEL: removes the event for everyone.
    function makeIcs(icsMethod){
      var cancel = icsMethod === "CANCEL";
      var isPublish = icsMethod === "PUBLISH";
      var lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//RentingRadar//CRM//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:" + icsMethod,
        "BEGIN:VEVENT",
        "DTSTART:" + icsStartUTC,
        "DTEND:" + icsEndUTC,
        "DTSTAMP:" + icsStamp,
        "UID:" + meetingUid,
        "SEQUENCE:" + sequence
      ];
      if(!isPublish){
        lines.push(organizerLine);
        lines = lines.concat(attendeeLines);
      }
      lines.push("SUMMARY:" + (cancel ? "Cancelled: " : "") + icsEscape(meetingTitle));
      lines.push("LOCATION:" + loc);
      lines.push("DESCRIPTION:" + icsDesc);
      lines.push("STATUS:" + (cancel ? "CANCELLED" : "CONFIRMED"));
      if(!cancel) lines = lines.concat(alarmLines);
      lines.push("END:VEVENT", "END:VCALENDAR");
      return lines.join("\r\n");
    }

    // Build email HTML (dark theme matching RentingRadar)
    var locationRow = "";
    if (propertyAddress) {
      locationRow = '<tr><td style="padding:0">' +
        '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Location</p>' +
        '<p style="margin:0;font-size:15px;color:#e2e4eb">' + escHtml(propertyAddress) + '</p>' +
        '</td></tr>';
    }

    var notesHtml = "";
    if (meetingNote) {
      notesHtml = '<tr><td style="padding:20px 30px 0">' +
        '<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#9399b2">Note</p>' +
        '<div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:12px 16px">' +
        '<p style="margin:0;font-size:13px;color:#9399b2;white-space:pre-wrap">' + escHtml(meetingNote) + '</p>' +
        '</div></td></tr>';
    }
    var attendeesHtml = "";
    if (attendees.length > 0) {
      attendeesHtml = '<tr><td style="padding:14px 30px 0">' +
        '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Also Invited</p>' +
        '<p style="margin:0;font-size:14px;color:#e2e4eb">' + attendees.map(escHtml).join(", ") + '</p>' +
        '</td></tr>';
    }

    var htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="margin:0;padding:0;background:#0d1017;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1017;padding:40px 20px"><tr><td align="center">' +
      '<table width="600" cellpadding="0" cellspacing="0" style="background:#141824;border-radius:12px;overflow:hidden">' +
      '<tr><td style="padding:30px 30px 0;text-align:center">' +
        '<div style="font-size:42px;margin-bottom:12px">' + (isCancel ? '&#10060;' : '&#128197;') + '</div>' +
        '<h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#e2e4eb">' + (isCancel ? 'Meeting Cancelled' : (sequence > 0 ? 'Meeting Updated' : 'Meeting Scheduled')) + '</h2>' +
        '<p style="margin:0;font-size:14px;color:#9399b2">' + (isCancel ? 'This meeting has been cancelled and removed from your calendar.' : 'A calendar invite is attached to this email.') + '</p>' +
      '</td></tr>' +
      '<tr><td style="padding:24px 30px 0">' +
        '<div style="background:#1a1e30;border:1px solid #252a3d;border-radius:10px;padding:20px 24px">' +
          '<table width="100%" cellpadding="0" cellspacing="0">' +
            '<tr><td style="padding:0 0 12px">' +
              '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Meeting</p>' +
              '<p style="margin:0;font-size:16px;font-weight:600;color:#e2e4eb">' + escHtml(meetingTitle) + '</p>' +
            '</td></tr>' +
            '<tr><td style="padding:0 0 12px">' +
              '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Date &amp; Time</p>' +
              '<p style="margin:0;font-size:15px;color:#e2e4eb">' + meetingDateFmt + '</p>' +
              '<p style="margin:2px 0 0;font-size:14px;color:#9399b2">' + meetingTimeFmt + ' - ' + endTimeFmt + (tzAbbr ? ' ' + tzAbbr : '') + '</p>' +
            '</td></tr>' +
            locationRow +
          '</table>' +
        '</div>' +
      '</td></tr>' +
      notesHtml +
      attendeesHtml +
      '<tr><td style="padding:24px 30px 30px;text-align:center">' +
        '<p style="margin:0;font-size:13px;color:#9399b2">' + (isCancel ? 'Open the attached <strong>.ics</strong> file to remove this from your calendar.' : 'Open the attached <strong>.ics</strong> file or accept the invite in your email client to add this to your calendar.') + '</p>' +
      '</td></tr>' +
      '<tr><td style="padding:20px 30px;border-top:1px solid #252a3d;text-align:center">' +
        '<p style="margin:0;font-size:12px;color:#4b5068">RentingRadar &middot; help@rentingradar.com</p>' +
      '</td></tr>' +
      '</table></td></tr></table></body></html>';

    var subjectPrefix = isCancel ? "Cancelled: " : "\uD83D\uDCC5 ";
    var subject = subjectPrefix + meetingTitle + " - " + meetingDateFmt + " at " + meetingTimeFmt + (tzAbbr ? " " + tzAbbr : "");
    var fromObj = { email: "help@rentingradar.com", name: organizerName || "RentingRadar" };

    function buildMessage(toList, icsMethod){
      return {
        to: toList,
        from: fromObj,
        replyTo: { email: user.email, name: organizerName || undefined },
        subject: subject,
        html: htmlContent,
        attachments: [
          {
            content: Buffer.from(makeIcs(icsMethod)).toString("base64"),
            filename: (icsMethod === "CANCEL") ? "cancel.ics" : "meeting.ics",
            type: "text/calendar; method=" + icsMethod,
            disposition: "attachment"
          }
        ],
        categories: ["meeting_invite"]
      };
    }

    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    if (isCancel) {
      // Cancellations go to everyone (organizer + attendees) as CANCEL.
      var cancelTo = [user.email].concat(attendees);
      await sgMail.send(buildMessage(cancelTo, "CANCEL"));
      console.log("Meeting CANCEL (seq " + sequence + ") sent to " + cancelTo.join(", "));
    } else {
      // Attendees get a REQUEST (RSVP buttons; replies route to the organizer).
      if (attendees.length) {
        await sgMail.send(buildMessage(attendees, "REQUEST"));
      }
      // The organizer gets a PUBLISH copy so Gmail renders an "Add to Calendar"
      // card instead of "Unable to load event" (which happens when the recipient
      // is the organizer of a REQUEST). Same UID keeps RSVPs reconciled.
      await sgMail.send(buildMessage([user.email], "PUBLISH"));
      console.log("Meeting invite (seq " + sequence + ") \u2014 REQUEST to [" + attendees.join(", ") + "], PUBLISH to organizer " + user.email);
    }
    res.status(200).json({ result: { data: { sent: true } } });
  } catch (err) {
    console.error("sendMeetingInvite error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to send calendar invite." } });
  }
};
