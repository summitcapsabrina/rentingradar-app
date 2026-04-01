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
  const propertyNotes = Array.isArray(body.propertyNotes) ? body.propertyNotes.filter(function(n) { return typeof n === "string" && n.length > 0; }) : [];
  const durationMinutes = body.durationMinutes || 60;

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

    // .ics local time (no Z) so calendar apps use user's timezone
    var icsStart = yr + mo + dy + "T" + hr + mn + "00";
    var endHour = parseInt(hr, 10) + Math.floor(durationMinutes / 60);
    var endMin = parseInt(mn, 10) + (durationMinutes % 60);
    var finalHour = String(endHour + Math.floor(endMin / 60)).padStart(2, "0");
    var finalMin = String(endMin % 60).padStart(2, "0");
    var icsEnd = yr + mo + dy + "T" + finalHour + finalMin + "00";
    var icsStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    // Human-readable date/time
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var dtObj = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy));
    var dayName = dayNames[dtObj.getDay()];
    var monthName = months[parseInt(mo) - 1];
    var meetingDateFmt = dayName + ", " + monthName + " " + parseInt(dy) + ", " + yr;

    // Format 24h to 12h
    var h = parseInt(hr, 10);
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    var meetingTimeFmt = h12 + ":" + mn + " " + ampm;
    var eh = parseInt(finalHour, 10);
    var eampm = eh >= 12 ? "PM" : "AM";
    var eh12 = eh === 0 ? 12 : eh > 12 ? eh - 12 : eh;
    var endTimeFmt = eh12 + ":" + finalMin + " " + eampm;

    var contact = contactName || "the landlord/property manager";
    var loc = propertyAddress || "";

    // Build .ics description
    var icsDesc = "Meeting with " + contact;
    if (propertyAddress) icsDesc += "\\nProperty: " + propertyAddress;
    if (propertyNotes.length > 0) {
      icsDesc += "\\n\\nProperty Notes:\\n" + propertyNotes.map(function(n) { return "- " + n; }).join("\\n");
    }
    icsDesc += "\\n\\nScheduled via RentingRadar CRM";

    var eventUID = "rr-meeting-" + user.uid + "-" + Date.now() + "@rentingradar.com";

    // Build .ics file
    var icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//RentingRadar//CRM//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "DTSTART:" + icsStart,
      "DTEND:" + icsEnd,
      "DTSTAMP:" + icsStamp,
      "UID:" + eventUID,
      "ORGANIZER;CN=RentingRadar:mailto:help@rentingradar.com",
      "ATTENDEE;CN=" + (user.email.split("@")[0]) + ";RSVP=TRUE:mailto:" + user.email,
      "SUMMARY:Meeting with " + contact,
      "LOCATION:" + loc,
      "DESCRIPTION:" + icsDesc,
      "STATUS:CONFIRMED",
      "BEGIN:VALARM",
      "TRIGGER:-PT30M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Meeting with " + contact + " in 30 minutes",
      "END:VALARM",
      "BEGIN:VALARM",
      "TRIGGER:-PT10M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Meeting with " + contact + " in 10 minutes",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    // Build email HTML (dark theme matching RentingRadar)
    var locationRow = "";
    if (propertyAddress) {
      locationRow = '<tr><td style="padding:0">' +
        '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Location</p>' +
        '<p style="margin:0;font-size:15px;color:#e2e4eb">' + escHtml(propertyAddress) + '</p>' +
        '</td></tr>';
    }

    var notesHtml = "";
    if (propertyNotes.length > 0) {
      notesHtml = '<tr><td style="padding:20px 30px 0">' +
        '<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#9399b2">Property Notes</p>' +
        '<div style="background:#1a1e30;border:1px solid #252a3d;border-radius:8px;padding:12px 16px">' +
        propertyNotes.map(function(n) { return '<p style="margin:0 0 4px;font-size:13px;color:#9399b2">&bull; ' + escHtml(n) + '</p>'; }).join("") +
        '</div></td></tr>';
    }

    var htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="margin:0;padding:0;background:#0d1017;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1017;padding:40px 20px"><tr><td align="center">' +
      '<table width="600" cellpadding="0" cellspacing="0" style="background:#141824;border-radius:12px;overflow:hidden">' +
      '<tr><td style="padding:30px 30px 0;text-align:center">' +
        '<div style="font-size:42px;margin-bottom:12px">&#128197;</div>' +
        '<h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#e2e4eb">Meeting Scheduled</h2>' +
        '<p style="margin:0;font-size:14px;color:#9399b2">A calendar invite is attached to this email.</p>' +
      '</td></tr>' +
      '<tr><td style="padding:24px 30px 0">' +
        '<div style="background:#1a1e30;border:1px solid #252a3d;border-radius:10px;padding:20px 24px">' +
          '<table width="100%" cellpadding="0" cellspacing="0">' +
            '<tr><td style="padding:0 0 12px">' +
              '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Meeting</p>' +
              '<p style="margin:0;font-size:16px;font-weight:600;color:#e2e4eb">Meeting with ' + escHtml(contact) + '</p>' +
            '</td></tr>' +
            '<tr><td style="padding:0 0 12px">' +
              '<p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#4b5068">Date &amp; Time</p>' +
              '<p style="margin:0;font-size:15px;color:#e2e4eb">' + meetingDateFmt + '</p>' +
              '<p style="margin:2px 0 0;font-size:14px;color:#9399b2">' + meetingTimeFmt + ' - ' + endTimeFmt + '</p>' +
            '</td></tr>' +
            locationRow +
          '</table>' +
        '</div>' +
      '</td></tr>' +
      notesHtml +
      '<tr><td style="padding:24px 30px 30px;text-align:center">' +
        '<p style="margin:0;font-size:13px;color:#9399b2">Open the attached <strong>.ics</strong> file or accept the invite in your email client to add this to your calendar.</p>' +
      '</td></tr>' +
      '<tr><td style="padding:20px 30px;border-top:1px solid #252a3d;text-align:center">' +
        '<p style="margin:0;font-size:12px;color:#4b5068">RentingRadar &middot; help@rentingradar.com</p>' +
      '</td></tr>' +
      '</table></td></tr></table></body></html>';

    // Send via SendGrid
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: user.email,
      from: { email: "help@rentingradar.com", name: "RentingRadar" },
      subject: "Meeting with " + contact + " - " + meetingDateFmt,
      html: htmlContent,
      attachments: [
        {
          content: Buffer.from(icsContent).toString("base64"),
          filename: "meeting.ics",
          type: "text/calendar; method=REQUEST",
          disposition: "attachment"
        }
      ],
      categories: ["meeting_invite"]
    });

    console.log("Meeting invite sent to " + user.email + " for " + meetingDate + " " + meetingTime);
    res.status(200).json({ result: { data: { sent: true } } });
  } catch (err) {
    console.error("sendMeetingInvite error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to send calendar invite." } });
  }
};
