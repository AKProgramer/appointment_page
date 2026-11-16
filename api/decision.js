/*
 * /api/decision  (Vercel Serverless Function, Node 18+)
 *
 *   GET  ?appointmentId=<id>                    -> booking details for the page
 *   POST { appointmentId: <id>, action: "approved" | "rejected" }
 *                                               -> sets the booking status in GHL
 *
 * <id> can be the Service Menu booking ID or the calendar event ID
 * ({{appointment.id}}); an event ID is mapped to its booking.
 * There is no other access check: the IDs are long and random,
 * but anyone who has a staff email link can use it.
 *
 * Bookings come from GHL's Service Menu:
 *   1. GET /calendars/services/bookings/{bookingId}              read the booking
 *      (if that 404s, the ID is an event ID: GET the event, then find its
 *       booking in GET /calendars/services/bookings?locationId&startTime&endTime)
 *   2. GET /calendars/events?locationId&userId&startTime&endTime  (best effort)
 *        find its calendar event for the customer's phone + notes
 *   3. PUT /calendars/services/bookings/{bookingId}  { status }  (no locationId in URL!)
 * GHL keeps the calendar appointment's status in sync automatically.
 *
 * Responses (JSON):
 *   200 GET:  { ok, status, pending, customerName, phone, service, date, time, notes }
 *   200 POST: { ok, action, status }
 *   400 bad_request | 404 not_found
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

const NOT_FOUND = { fail: { code: 404, body: { error: "not_found" } } };

function ghlFailure(r, step) {
  if (r.status === 401 || r.status === 403) {
    console.error("[decision] GHL rejected the token (" + step + "):", r.status, r.data);
    return { fail: { code: 502, body: Object.assign({ error: "ghl_auth", step }, ghlDetail(r)) } };
  }
  console.error("[decision] GHL error (" + step + "):", r.status, r.data);
  return { fail: { code: 502, body: Object.assign({ error: "ghl_error", step }, ghlDetail(r)) } };
}

/*
 * Load the booking. `id` may be the Service Menu booking ID, or the calendar
 * event ID ({{appointment.id}} in GHL); an event ID is mapped to its booking.
 * Returns { booking } or { fail: { code, body } }.
 */
async function loadBooking(token, id) {
  const r = await ghl(token, "/calendars/services/bookings/" + encodeURIComponent(id));
  if (r.ok) {
    const booking = (r.data && (r.data.booking || r.data)) || {};
    if (!booking.bookingId || booking.deleted) return NOT_FOUND;
    return { booking };
  }
  if (r.status !== 400 && r.status !== 404) return ghlFailure(r, "read booking");
  return bookingFromEvent(token, id);
}

/*
 * Map a calendar event ID to its Service Menu booking: same contact, same
 * start time, same service. The bookings list needs epoch-ms dates (ISO dates
 * silently return nothing) and a range of at most 31 days.
 */
async function bookingFromEvent(token, eventId) {
  const ev = await ghl(token, "/calendars/events/appointments/" + encodeURIComponent(eventId));
  if (ev.status === 400 || ev.status === 404) return NOT_FOUND;
  if (!ev.ok) return ghlFailure(ev, "read appointment");

  const appt = (ev.data && (ev.data.appointment || ev.data.event)) || ev.data || {};
  const start = Date.parse(appt.startTime);
  if (!appt.locationId || isNaN(start)) return NOT_FOUND;

  const list = await ghl(token,
    "/calendars/services/bookings?locationId=" + encodeURIComponent(appt.locationId) +
    "&startTime=" + (start - DAY_MS) + "&endTime=" + (start + DAY_MS));
  if (!list.ok) return ghlFailure(list, "find booking");

  const booking = ((list.data && list.data.bookings) || []).find((b) =>
    !b.deleted &&
    b.contactId === appt.contactId &&
    Date.parse(b.startTime) === start &&
    (!appt.calendarId || (b.services || []).some((s) => s.id === appt.calendarId))
  );
  if (!booking) {
    console.warn("[decision] No service booking matches event", eventId);
    return NOT_FOUND;
  }
  if (!booking.locationId) booking.locationId = appt.locationId;
  return { booking };
}

/*
 * Best effort: the booking's calendar event holds the customer's form details
 * (name, phone) and notes. Found via the staff member's events at that time.
 * Returns the event, or null.
 */
async function findEvent(token, booking) {
  const svc = (booking.services || [])[0] || {};
  const start = Date.parse(booking.startTime);
  if (!svc.serviceStaffId || isNaN(start)) return null;
  try {
    const r = await ghl(token,
      "/calendars/events?locationId=" + encodeURIComponent(booking.locationId) +
      "&userId=" + encodeURIComponent(svc.serviceStaffId) +
      "&startTime=" + (start - 1) + "&endTime=" + (Date.parse(booking.endTime) || start + 1));
    return ((r.ok && r.data && r.data.events) || []).find((e) =>
      e.contactId === booking.contactId &&
      Date.parse(e.startTime) === start &&
      (!svc.id || e.calendarId === svc.id)
    ) || null;
  } catch (e) {
    return null;
  }
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
async function describe(token, booking) {
  const event = await findEvent(token, booking);
  const form = (event && event.appointmentMeta && event.appointmentMeta.defaultFormDetails) || {};
  const titleParts = String((event && event.title) || booking.title || "").split(" - ");
  const customerName = [form.firstName, form.lastName].filter(Boolean).join(" ") || titleParts[0] || "";

  // Service name + duration from the Service Menu (falls back to the event title).
  let service = titleParts.slice(1).join(" - ");
  const serviceId = booking.services && booking.services[0] && booking.services[0].id;
  if (serviceId) {
    const s = await ghl(token, "/calendars/services?locationId=" + encodeURIComponent(booking.locationId)).catch(() => ({}));
    const match = ((s.data && s.data.services) || []).find((x) => (x._id || x.id) === serviceId);
    if (match) {
      service = match.name + (match.serviceDuration ? " · " + match.serviceDuration + " " + (match.serviceDurationUnit || "mins") : "");
    }
  }

  const tz = booking.timezone || "America/New_York";
  const timeOpts = { hour: "numeric", minute: "2-digit" };

  return {
    customerName,
    phone: form.phone || "",
    service,
    date: fmt(booking.startTime, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    time: fmt(booking.startTime, tz, timeOpts) +
      (booking.endTime ? " – " + fmt(booking.endTime, tz, Object.assign({ timeZoneName: "short" }, timeOpts)) : ""),
    notes: (event && event.notes) || ""
  };
}

module.exports = async function handler(req, res) {
  // CORS: let the page work when it is opened from another origin (a local
  // file, a GHL custom code element, another domain). Safe to allow any origin:
  // no cookies or secrets are involved, and the API is reachable directly anyway.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
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

  // "appointmentId" in the link: booking ID or calendar event ID.
  const bookingId = String(input.appointmentId || "");
  const action = String(input.action || "");

  if (!ID_PATTERN.test(bookingId) ||
      (req.method === "POST" && !STATUS_FOR_ACTION[action])) {
    return sendJson(res, 400, { error: "bad_request" });
  }

  const pending = (process.env.PENDING_STATUSES || "new")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  try {
    // ---- 2. Load the booking ----
    const loaded = await loadBooking(token, bookingId);
    if (loaded.fail) return sendJson(res, loaded.fail.code, loaded.fail.body);
    const { booking } = loaded;
    const currentStatus = String(booking.status || "").toLowerCase();

    // ---- GET: return details for the page ----
    if (req.method === "GET") {
      const details = await describe(token, booking);
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
      " via staff approval page (" + (booking.title || "booking") + ", " + (booking.startTime || "") + ").";
    const n = booking.contactId && await ghl(token, "/contacts/" + encodeURIComponent(booking.contactId) + "/notes", {
      method: "POST", version: CONTACTS_API_VERSION, body: { body: note }
    }).catch(() => ({ ok: false }));
    if (!n || !n.ok) console.warn("[decision] Note not added (token may lack contacts.write):", n.status);

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
