# Staff Appointment Approval Page

When a customer books, GHL emails a staff member a link to this page. The staff member reviews the appointment and taps **Approve** or **Reject**. The page then updates the appointment's status in GHL directly through the GHL API.

```
Staff email link ──► public/index.html ──POST /api/decision──► api/decision.js ──GHL API──► appointment status
                     (no secrets)                              (holds the GHL token)
```

The GHL token is never sent to the browser. It lives only in Vercel's environment variables. Anyone who opens an approval link can read the page source, so a token there would give full API access to your GHL location.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | The page (inline CSS + JS, no build step). Brand settings are at the top of its `<script>`. |
| `api/decision.js` | Vercel function that checks the request and updates GHL. |
| `vercel.json` | Serves `public/`; adds `noindex` and security headers. |
| `.env` | Local secrets: `ghl_token`, `LINK_KEY`. **Never commit or upload it.** |
| `.env.example` | Template showing which variables exist. |
| `.vercelignore`, `.gitignore` | Keep `.env` out of deployments and git. |

## 1. GHL token

Create the token in **GHL > Settings > Private Integrations** (sub-account level). It needs these scopes:

- `calendars/events.readonly`: read the appointment and check its status
- `calendars/events.write`: change the status
- `contacts.write`: add the audit note and save the rejection reason (optional, see below)

## 2. Deploy to Vercel

1. Push this folder to a GitHub repo (`.gitignore` already excludes `.env`) and import it at vercel.com > **Add New > Project**. Framework preset: **Other**. Leave the build command empty.
   Or use the CLI from this folder: `npm i -g vercel`, then `vercel`, then `vercel --prod`.
2. In **Project > Settings > Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `GHL_TOKEN` | Your `pit-...` token |
   | `LINK_KEY` | The `LINK_KEY` value from your local `.env` (or any long random string) |
   | `PENDING_STATUSES` | Optional. Default `new` (see Troubleshooting) |
   | `REASON_FIELD_ID` | Optional. Contact custom field ID for the rejection reason |
   | `ADD_NOTES` | Optional. `false` turns off the audit note on the contact |

3. Redeploy after adding variables. Your page is at `https://<your-project>.vercel.app/`.

Note: Vercel protects *preview* deployments with a login by default. Use the **production** URL in emails.

## 3. Staff email link

In the GHL workflow that emails staff when an appointment is booked (trigger: **Customer Booked Appointment**), add a button or link:

```
https://<your-project>.vercel.app/?appointmentId={{appointment.id}}&contactId={{contact.id}}&key=<LINK_KEY>&customerName={{contact.name}}&service={{appointment.title}}&date={{appointment.start_date}}&time={{appointment.start_time}}
```

- `appointmentId`, `contactId` and `key` are **required**. `key` is the same `LINK_KEY` you set in Vercel, typed into the link once.
- `customerName`, `service`, `date`, `time`, `staffName`, `phone` and `notes` are optional and only displayed.
- **Verify the merge fields in your account.** Appointment merge-field names vary. In the email editor, open the merge-field picker (the `{ }` / tag icon) under *Appointment*. Then send yourself a test and check that every value fills in. If a field doesn't fill in, the page treats `{{...}}` as missing. A missing required field shows "This link is invalid".
- GHL may not URL-encode merge-field values. A `&` or `#` inside a name or note can cut the link short. Keep free-text fields like `notes` out of the link if your data contains them.

## 4. What the function does

`POST /api/decision` with `{ appointmentId, contactId, action, reason, key }`:

1. Validates the input. IDs must be alphanumeric, and `action` must be `approved` or `rejected`.
2. Checks `key` against `LINK_KEY` and answers **403** if it doesn't match.
3. Loads the appointment from GHL. It must exist (**404** otherwise), and its `contactId` must match the link (**403** otherwise).
4. Checks that the status is still pending (`new` by default). Otherwise it answers **409**, and the page shows "Already handled". This makes double clicks, retries and two staff members on one link safe.
5. If rejecting and `REASON_FIELD_ID` is set, it saves the reason to that contact field first.
6. Sets `appointmentStatus` to **`confirmed`** (approve) or **`cancelled`** (reject).
7. Adds a note to the contact ("Appointment approved/rejected via staff approval page", plus the reason). This step is best effort and never fails the request.

The page shows success only after step 6 succeeds.

## 5. Notify the customer (GHL workflow)

The page no longer triggers a webhook. GHL reacts to the status change instead.

1. Create a workflow with the trigger **Appointment Status**, filtered to your calendar.
2. Add an **If/Else** on the appointment status:
   - **Confirmed**: send the confirmation email/SMS.
   - **Cancelled**: send the "we couldn't book you" message. To include the reason, create a contact custom field (for example *Appointment rejection reason*), put its **ID** in `REASON_FIELD_ID`, and use its merge field in the message. The function saves the reason *before* changing the status, so the field is filled when the workflow runs.

This trigger also fires when someone changes the status manually inside GHL. That is usually what you want.

## 6. Local testing

```
npm i -g vercel
vercel dev
```

`vercel dev` reads `.env` and serves the site at http://localhost:3000. It uses your real GHL account, so **use a dummy contact**.

## 7. Test checklist

Do all of these with a **dummy contact and test appointment** before going live.

- [ ] **Valid link**: all details show, and both buttons work on a phone.
- [ ] **Missing parameters**: remove `appointmentId`, `contactId` or `key`. You should see "This link is invalid", with no buttons.
- [ ] **Wrong key / wrong contact**: change `key` or `contactId`. You should see "This link isn't valid for this appointment", and nothing changes in GHL.
- [ ] **Approve**: the status becomes *Confirmed* in GHL, a note is added, and the customer gets the confirmation.
- [ ] **Reject with reason**: a confirmation step appears first. After it, the status becomes *Cancelled*, the reason appears in the note (and custom field), and the customer message includes it.
- [ ] **Offline error**: turn on airplane mode and tap Approve. You get an error with **Retry** and no success message. Reconnect, tap Retry, and it succeeds.
- [ ] **Refresh after submit**: the final state shows, without buttons.
- [ ] **Two staff, same link**: open the link on two devices (or a normal and a private window). Approve on one, then Reject on the other. The second shows "Already handled", and GHL keeps the first decision.
- [ ] **Merge fields**: the real email's link fills in every value.
- [ ] **Search engines**: the response headers include `X-Robots-Tag: noindex`.

## Troubleshooting

- **Every click says "Already handled"**: your calendar's pending status may not be `new`. Vercel > Logs shows `currentStatus` in the 409 reply. Set `PENDING_STATUSES` to the right value(s), for example `new,booked`.
- **Error 502**: open Vercel > Project > Logs and look for `[decision]` lines. `ghl_auth` means the token is wrong or lacks scopes. `ghl_update_failed` shows GHL's message, for example a slot-validation error when confirming.
- **"This link isn't valid" on a correct link**: `LINK_KEY` in Vercel doesn't match `key` in the link, or GHL returned a different `contactId` (check the logs).

## Security notes

- `LINK_KEY` appears only in staff emails, not in the page source. Anyone with a staff email link can act on *that* appointment while it's pending, so treat these emails as internal. Change `LINK_KEY` if a link leaks. This makes all older links invalid.
- localStorage only remembers the result on one browser. The server's pending check is the real protection against double updates.
- All URL values are shown with `textContent`, never `innerHTML`, so a link can't inject HTML or scripts.
- No tracking or third-party scripts. The referrer is disabled, so appointment IDs aren't sent to the logo host.
