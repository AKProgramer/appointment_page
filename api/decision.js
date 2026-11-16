/*
 * /api/decision  (Vercel Serverless Function, Node 18+)
 *
 *   GET  ?appointmentId=…&contactId=…         -> appointment details for the page
 *   POST { appointmentId, contactId, action: "approved" | "rejected" }
 *                                               -> sets the booking status in GHL
 *
 * Access check: the request must name an appointment AND the contact who owns
 * it. Both are long random GHL IDs, so they can't realistically be guessed;
 * anyone who has a staff email link can use it, though.
 *
 * Bookings come from GHL's Service Menu. GHL's normal appointment endpoint
 * refuses to change their status ("Calendar is inactive"), so the status is set
 * on the matching *service booking* instead:
 *   1. GET /calendars/events/appointments/{appointmentId}      read the appointment
 *   2. GET /calendars/services/bookings?locationId&startTime&endTime
 *        (dates MUST be epoch milliseconds; max 31 days)       find its booking:
 *        same contact + same start time + same service
 *   3. PUT /calendars/services/bookings/{bookingId}  { status } (no locationId in URL!)
 * GHL keeps the calendar appointment's status in sync automatically.
 *
 * Responses (JSON):
 *   200 GET:  { ok, status, customerName, phone, service, date, time, notes }
 *   200 POST: { ok, action, status }
 *   400 bad_request | 403 forbidden (contact doesn't own it) | 404 not_found
 *   405 method_not_allowed | 409 already_decided { currentStatus }
 *   500 not_configured | 502 GHL error { ghlStatus, ghlMessage } | 504 GHL timeout
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   GHL_TOKEN         required  Private Integration Token (pit-...) with
 *                               calendars.readonly, calendars/events.readonly,
 *                               calendars/events.write. contacts.write is optional
 *                               (adds a note to the contact).
 *   PENDING_STATUSES  optional  Comma list of statuses that count as "pending". Default "new".
 */

"use strict";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-04-15";
const CONTACTS_API_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Page action -> GHL booking status
const STATUS_FOR_ACTION = { approved: "confirmed", rejected: "cancelled" };

// GHL IDs are short alphanumeric strings. Rejecting anything else also stops
// path tricks like "../" from reaching the GHL URL.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Short, safe description of a GHL error reply (never includes the token).
function ghlDetail(r) {
  const d = (r && r.data) || {};
  let msg = d.message || d.error || d.msg || d.raw || "";
  if (Array.isArray(msg)) msg = msg.join("; ");
  return { ghlStatus: r && r.status, ghlMessage: String(msg).slice(0, 300) };
}

// Call the GHL API with a timeout. Never throws on HTTP errors; returns
// { status, ok, data }. Throws only on network failure / timeout.
async function ghl(token, path, { method = "GET", version = API_VERSION, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHL_TIMEOUT_MS);
  try {
    const headers = { Authorization: "Bearer " + token, Version: version, Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(GHL_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

// Turn a failed GHL reply into one of our error responses.
function ghlFailure(r, step) {
  if (r.status === 401 || r.status === 403) {
    console.error("[decision] GHL rejected the token (" + step + "):", r.status, r.data);
    return { code: 502, body: Object.assign({ error: "ghl_auth", step }, ghlDetail(r)) };
  }
  if (r.status === 400 || r.status === 404) return { code: 404, body: { error: "not_found" } };
  console.error("[decision] GHL error (" + step + "):", r.status, r.data);
  return { code: 502, body: Object.assign({ error: "ghl_error", step }, ghlDetail(r)) };
}

/*
 * Load the appointment and its Service Menu booking, and check the contact.
 * Returns { appt, booking } or { fail: { code, body } }.
 */
async function loadBooking(token, appointmentId, contactId) {
  const ev = await ghl(token, "/calendars/events/appointments/" + encodeURIComponent(appointmentId));
  if (!ev.ok) return { fail: ghlFailure(ev, "read appointment") };

  const appt = (ev.data && (ev.data.appointment || ev.data.event)) || ev.data || {};

  // The contact in the link must own this appointment.
  if (appt.contactId !== contactId) {
    console.warn("[decision] contactId mismatch for appointment", appointmentId);
    return { fail: { code: 403, body: { error: "forbidden" } } };
  }

  const start = Date.parse(appt.startTime);
  if (!appt.locationId || isNaN(start)) return { fail: { code: 404, body: { error: "not_found" } } };

  const list = await ghl(token,
    "/calendars/services/bookings?locationId=" + encodeURIComponent(appt.locationId) +
    "&startTime=" + (start - DAY_MS) + "&endTime=" + (start + DAY_MS));
  if (!list.ok) return { fail: ghlFailure(list, "find booking") };

  const booking = ((list.data && list.data.bookings) || []).find((b) =>
    b.contactId === appt.contactId &&
    Date.parse(b.startTime) === start &&
    (!appt.calendarId || (b.services || []).some((s) => s.id === appt.calendarId))
  );
  if (!booking) {
    console.warn("[decision] No service booking matches appointment", appointmentId);
    return { fail: { code: 404, body: { error: "not_found" } } };
  }
  return { appt, booking };
}

// Format a date/time in the booking's own timezone.
function fmt(iso, timeZone, options) {
  try {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone }, options)).format(new Date(iso));
  } catch (e) {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(iso));
  }
}

// Build the details shown on the page.
async function describe(token, appt, booking) {
  const form = (appt.appointmentMeta && appt.appointmentMeta.defaultFormDetails) || {};
  const titleParts = String(appt.title || booking.title || "").split(" - ");
  const customerName = [form.firstName, form.lastName].filter(Boolean).join(" ") || titleParts[0] || "";

  // Service name + duration from the Service Menu (falls back to the title).
  let service = titleParts.slice(1).join(" - ");
  const serviceId = appt.calendarId || (booking.services && booking.services[0] && booking.services[0].id);
  if (serviceId) {
    const s = await ghl(token, "/calendars/services?locationId=" + encodeURIComponent(appt.locationId));
    const match = ((s.data && s.data.services) || []).find((x) => (x._id || x.id) === serviceId);
    if (match) {
      service = match.name + (match.serviceDuration ? " · " + match.serviceDuration + " " + (match.serviceDurationUnit || "mins") : "");
    }
  }

  const tz = booking.timezone || "America/New_York";
  const start = booking.startTime || appt.startTime;
  const end = booking.endTime || appt.endTime;
  const timeOpts = { hour: "numeric", minute: "2-digit" };

  return {
    customerName,
    phone: form.phone || "",
    service,
    date: fmt(start, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    time: fmt(start, tz, timeOpts) + (end ? " – " + fmt(end, tz, Object.assign({ timeZoneName: "short" }, timeOpts)) : ""),
    notes: appt.notes || ""
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  // `ghl_token` is accepted too, so a local .env written that way works with `vercel dev`.
  const token = process.env.GHL_TOKEN || process.env.ghl_token;
  if (!token) {
    console.error("[decision] Missing GHL_TOKEN environment variable.");
    return sendJson(res, 500, { error: "not_configured" });
  }

  // ---- 1. Read + validate input (query string for GET, JSON body for POST) ----
  let input;
  if (req.method === "GET") {
    input = req.query || Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  } else {
    input = req.body;
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch (e) { input = null; }
    }
  }
  if (!input || typeof input !== "object") return sendJson(res, 400, { error: "bad_request" });

  const appointmentId = String(input.appointmentId || "");
  const contactId = String(input.contactId || "");
  const action = String(input.action || "");

  if (!ID_PATTERN.test(appointmentId) || !ID_PATTERN.test(contactId) ||
      (req.method === "POST" && !STATUS_FOR_ACTION[action])) {
    return sendJson(res, 400, { error: "bad_request" });
  }

  const pending = (process.env.PENDING_STATUSES || "new")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  try {
    // ---- 2. Load the appointment + booking (checks the contact owns it) ----
    const loaded = await loadBooking(token, appointmentId, contactId);
    if (loaded.fail) return sendJson(res, loaded.fail.code, loaded.fail.body);
    const { appt, booking } = loaded;
    const currentStatus = String(booking.status || "").toLowerCase();

    // ---- GET: return details for the page ----
    if (req.method === "GET") {
      const details = await describe(token, appt, booking);
      return sendJson(res, 200, Object.assign({ ok: true, status: currentStatus, pending: pending.includes(currentStatus) }, details));
    }

    // ---- POST 3. Only act on bookings that are still pending ----
    // This is what makes double clicks and two staff members on one link safe.
    if (!pending.includes(currentStatus)) {
      return sendJson(res, 409, { error: "already_decided", currentStatus });
    }

    // ---- POST 4. Update the status ----
    const newStatus = STATUS_FOR_ACTION[action];
    const update = await ghl(token, "/calendars/services/bookings/" + encodeURIComponent(booking.bookingId), {
      method: "PUT",
      body: { status: newStatus }
    });
    if (!update.ok) {
      console.error("[decision] GHL update failed:", update.status, update.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_update_failed", step: "update status" }, ghlDetail(update)));
    }

    // ---- POST 5. Audit note on the contact (best effort; needs contacts.write) ----
    const note = (action === "approved" ? "Booking approved" : "Booking rejected") +
      " via staff approval page (" + (appt.title || "booking") + ", " + (appt.startTime || "") + ").";
    const n = await ghl(token, "/contacts/" + encodeURIComponent(appt.contactId) + "/notes", {
      method: "POST", version: CONTACTS_API_VERSION, body: { body: note }
    }).catch(() => ({ ok: false }));
    if (!n.ok) console.warn("[decision] Note not added (token may lack contacts.write):", n.status);

    return sendJson(res, 200, { ok: true, action, status: newStatus });
  } catch (err) {
    if (err && err.name === "AbortError") {
      // The update may or may not have gone through. A retry is safe: if it
      // did, the pending check answers 409 "already decided".
      console.error("[decision] GHL request timed out");
      return sendJson(res, 504, { error: "ghl_timeout" });
    }
    console.error("[decision] Unexpected error:", err);
    return sendJson(res, 502, { error: "server_error" });
  }
};
