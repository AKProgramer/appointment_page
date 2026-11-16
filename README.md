# Staff Appointment Approval Page

When a customer books, GHL emails a staff member a link to this page. The staff member reviews the booking and taps **Approve** or **Reject**. The page updates the booking's status in GHL directly through the GHL API.

```
Staff email link ──► public/index.html ──POST /api/decision──► api/decision.js ──GHL API──► booking status
                     (no secrets)                              (holds the GHL token)
```

Bookings come from GHL's **Service Menu**, so the function uses GHL's *service bookings* API:

- `GET /calendars/events/appointments/{appointmentId}` reads the appointment from the email link.
- `GET /calendars/services/bookings?locationId=…&startTime=<ms>&endTime=<ms>` finds the matching booking: same contact, start time and service. The dates **must be epoch milliseconds**; ISO dates return an empty list.
- `PUT /calendars/services/bookings/{bookingId}` with `{"status": "confirmed" | "cancelled"}` updates it. Do **not** add `locationId` to the URL, or GHL rejects the call.

GHL updates the linked calendar appointment automatically. The regular `/calendars/events/appointments` endpoint refuses Service Menu bookings with "Calendar is inactive", which is why this API is used instead.

The GHL token never reaches the browser. It lives only in Vercel's environment variables.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | The page (inline CSS + JS, no build step). Brand settings are at the top of its `<script>`. |
| `api/decision.js` | Vercel function: checks the request and updates the booking. |
| `vercel.json` | Serves `public/`; adds `noindex` and security headers. |
| `.env` | Local secrets. **Never commit or upload it.** |
| `.env.example` | Which variables exist. |

## 1. Vercel environment variables

In **Project → Settings → Environment Variables**, add these, then **redeploy**:

| Name | Value |
|---|---|
| `GHL_TOKEN` | Your `pit-...` token. Needs `calendars/events.readonly` and `calendars/events.write`. Add `contacts.write` to also get a note on the contact. |
| `LINK_KEY` | Same value as in `.env` and in the staff email links |
| `PENDING_STATUSES` | Optional. Default `new` |

`GHL_WEBHOOK_URL` is no longer used, so you can delete it from Vercel.

## 2. Staff email link

In the workflow that emails staff when a booking is made, add a button/link:

```
https://appointmentpage-sand.vercel.app/?appointmentId={{appointment.id}}&contactId={{contact.id}}&key=<LINK_KEY>&customerName={{contact.name}}&service={{appointment.title}}&date={{appointment.start_date}}&time={{appointment.start_time}}
```

- `appointmentId`, `contactId` and `key` are **required**. If you have the Service Menu booking ID, you can use `bookingId=` instead of `appointmentId=`.
- `customerName`, `service`, `date`, `time`, `staffName`, `phone` and `notes` are display-only.
- **Verify the merge fields** in your account by sending yourself a test. An unfilled `{{...}}` is treated as missing.
- A `&` or `#` inside a value (for example in notes) can break the link, so keep free-text fields out if needed.

## 3. Notify the customer

Create a GHL workflow with the trigger **Appointment Status** (or the booking status trigger, if your account has one):

- **Confirmed** → send the confirmation email/SMS.
- **Cancelled** → send the "we couldn't book you" message.

Each decision also adds a short **note on the contact** (if the token has `contacts.write`) saying the booking was approved or rejected through this page.

## 4. What happens on a click

1. The function validates the input and checks `key` against `LINK_KEY`. A wrong key gets **403**.
2. It finds the booking from the appointment ID, or uses `bookingId` directly. If it doesn't exist: **404**. If its contact doesn't match the link: **403**.
3. If the booking is no longer pending: **409**, and the page shows "Already handled". This covers double clicks and two staff members on one link.
4. It sets the status to `confirmed` or `cancelled` and adds a note to the contact (best effort). The page shows success only when GHL accepts the update.

## 5. Test checklist

Use a **dummy contact** for all of these.

- [ ] **Valid link**: the details show, and the buttons work on a phone.
- [ ] **Missing `appointmentId`, `contactId` or `key`**: "This link is invalid", with no buttons.
- [ ] **Wrong key or contact**: "This link isn't valid for this appointment", and nothing changes in GHL.
- [ ] **Approve**: the booking becomes *Confirmed* in GHL.
- [ ] **Reject**: a "Reject this appointment?" confirmation appears first. After confirming, the booking becomes *Cancelled* in GHL.
- [ ] **Offline** (DevTools → Network → Offline): an error with Retry and no false success.
- [ ] **Refresh after submit**: the final state shows, without buttons.
- [ ] **Two staff, same link**: the second person sees "Already handled".
- [ ] **Merge fields**: the real staff email link fills in every value.

## Troubleshooting

- **Error 502 with "GHL said…"**: the message is GHL's own. Vercel → **Logs** (search `decision`) has the details.
- **Every click says "Already handled"**: the pending status isn't `new`. Set `PENDING_STATUSES`.
- **"This appointment wasn't found"**: the appointment was deleted, or it isn't a Service Menu booking.

## Security notes

- The token lives only on the server. `LINK_KEY` appears only in staff emails, not in the page source. Change `LINK_KEY` if a link leaks; that makes all older links invalid.
- localStorage only remembers results on one browser. The server's "still pending" check is the real protection.
- URL values are shown with `textContent` only, never as HTML. No tracking or third-party scripts.
