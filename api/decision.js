/*
 * POST /api/decision  (Vercel Serverless Function, Node 18+)
 *
 * Called by public/index.html when a staff member taps Approve or Reject.
 * Updates a GHL Service Menu booking's status directly through the GHL API:
 *   GET /calendars/services/bookings/{bookingId}   check it
 *   PUT /calendars/services/bookings/{bookingId}   { "status": "confirmed" | "cancelled" }
 * (GHL keeps the linked calendar appointment in sync automatically.)
 *
 * Request body (JSON):
 *   { bookingId OR appointmentId, contactId, action: "approved" | "rejected", key }
 *
 * Responses (JSON):
 *   200 { ok: true, action, status }                  updated in GHL
 *   400 { error: "bad_request" }                      missing/invalid fields
 *   403 { error: "forbidden" }                        wrong link key, or contact doesn't match
 *   404 { error: "not_found" }                        booking doesn't exist
 *   405 { error: "method_not_allowed" }
 *   409 { error: "already_decided", currentStatus }   booking is no longer pending
 *   500 { error: "not_configured" }                   env vars missing
 *   502 / 504                                         GHL error / GHL timeout
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   GHL_TOKEN         required  Private Integration Token (pit-...) with
 *                               calendars/events.readonly + calendars/events.write.
 *                               contacts.write is optional (adds a note to the contact).
 *   LINK_KEY          required  Long random string, also added as &key=... to the
 *                               link in the staff email.
 *   PENDING_STATUSES  optional  Comma list of statuses that count as "pending". Default "new".
 */

"use strict";

const crypto = require("crypto");

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-04-15";
const CONTACTS_API_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 8000;

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

// Constant-time comparison so the key can't be guessed by timing responses.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Short, safe description of a GHL error reply (never includes the token),
// returned to the page so staff/admins can see why something failed.
function ghlDetail(r) {
  const d = r.data || {};
  let msg = d.message || d.error || d.msg || d.raw || "";
  if (Array.isArray(msg)) msg = msg.join("; ");
  return { ghlStatus: r.status, ghlMessage: String(msg).slice(0, 300) };
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

/*
 * Find the Service Menu booking ID for a calendar appointment ID.
 * GHL has no direct link between the two, so: read the appointment, then
 * list bookings around its start time (the list only works with epoch-ms
 * dates, max 31 days) and pick the one with the same contact, start time
 * and service. Returns { bookingId } or { status } on failure.
 */
async function findBookingId(token, appointmentId) {
  const ev = await ghl(token, "/calendars/events/appointments/" + encodeURIComponent(appointmentId));
  if (!ev.ok) return { status: ev.status, r: ev };

  const appt = (ev.data && (ev.data.appointment || ev.data.event)) || ev.data || {};
  const start = Date.parse(appt.startTime);
  if (!appt.locationId || isNaN(start)) return { status: 404 };

  const day = 24 * 60 * 60 * 1000;
  const list = await ghl(token,
    "/calendars/services/bookings?locationId=" + encodeURIComponent(appt.locationId) +
    "&startTime=" + (start - day) + "&endTime=" + (start + day));
  if (!list.ok) return { status: list.status, r: list };

  const match = ((list.data && list.data.bookings) || []).find((b) =>
    b.contactId === appt.contactId &&
    Date.parse(b.startTime) === start &&
    (!appt.calendarId || (b.services || []).some((s) => s.id === appt.calendarId))
  );
  return match ? { bookingId: match.bookingId } : { status: 404 };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  // `ghl_token` is accepted too, so a local .env written that way works with `vercel dev`.
  const token = process.env.GHL_TOKEN || process.env.ghl_token;
  const linkKey = process.env.LINK_KEY;
  if (!token || !linkKey) {
    console.error("[decision] Missing GHL_TOKEN or LINK_KEY environment variable.");
    return sendJson(res, 500, { error: "not_configured" });
  }

  // ---- 1. Validate input ----
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") return sendJson(res, 400, { error: "bad_request" });

  // The link carries either the booking ID or the calendar appointment ID
  // ({{appointment.id}} in GHL emails); the booking is looked up from the latter.
  let bookingId = String(body.bookingId || "");
  const appointmentId = String(body.appointmentId || "");
  const contactId = String(body.contactId || "");
  const action = String(body.action || "");
  const key = typeof body.key === "string" ? body.key : "";

  const idOk = bookingId ? ID_PATTERN.test(bookingId) : ID_PATTERN.test(appointmentId);
  if (!idOk || !ID_PATTERN.test(contactId) || !STATUS_FOR_ACTION[action]) {
    return sendJson(res, 400, { error: "bad_request" });
  }

  // ---- 2. Check the link key ----
  if (!key || !safeEqual(key, linkKey)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  const pending = (process.env.PENDING_STATUSES || "new")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const newStatus = STATUS_FOR_ACTION[action];

  try {
    // ---- 3. Find the booking (if the link has an appointment ID) ----
    if (!bookingId) {
      const found = await findBookingId(token, appointmentId);
      if (!found.bookingId) {
        if (found.status === 401 || found.status === 403) {
          console.error("[decision] GHL rejected the token while finding the booking:", found.status);
          return sendJson(res, 502, Object.assign({ error: "ghl_auth", step: "find booking" }, ghlDetail(found.r)));
        }
        if (found.r && found.status >= 500) {
          return sendJson(res, 502, Object.assign({ error: "ghl_error", step: "find booking" }, ghlDetail(found.r)));
        }
        return sendJson(res, 404, { error: "not_found" });
      }
      bookingId = found.bookingId;
    }
    const bookingPath = "/calendars/services/bookings/" + encodeURIComponent(bookingId);

    // ---- 4. Load the booking and check it ----
    const current = await ghl(token, bookingPath);

    if (current.status === 401 || current.status === 403) {
      console.error("[decision] GHL rejected the token (check token and scopes):", current.status, current.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_auth", step: "read booking" }, ghlDetail(current)));
    }
    if (current.status === 404 || current.status === 400) {
      return sendJson(res, 404, { error: "not_found" });
    }
    if (!current.ok) {
      console.error("[decision] GHL get booking failed:", current.status, current.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_error", step: "read booking" }, ghlDetail(current)));
    }

    const booking = current.data || {};

    // The contact in the link must own this booking. Someone who only has a
    // booking ID (or swaps IDs in the URL) can't act on it.
    if (booking.contactId !== contactId) {
      console.warn("[decision] contactId mismatch or missing for booking", bookingId);
      return sendJson(res, 403, { error: "forbidden" });
    }

    // Only act on bookings that are still pending. This is what makes double
    // clicks, retries and two staff members on the same link safe.
    const currentStatus = String(booking.status || "").toLowerCase();
    if (!pending.includes(currentStatus)) {
      return sendJson(res, 409, { error: "already_decided", currentStatus });
    }

    // ---- 5. Update the status ----
    // Note: this endpoint rejects a locationId query parameter.
    const update = await ghl(token, bookingPath, { method: "PUT", body: { status: newStatus } });
    if (!update.ok) {
      console.error("[decision] GHL update failed:", update.status, update.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_update_failed", step: "update status" }, ghlDetail(update)));
    }

    // ---- 6. Audit note on the contact (best effort; needs contacts.write) ----
    const note =
      (action === "approved" ? "Booking approved" : "Booking rejected") +
      " via staff approval page (" + (booking.title || "booking") + ", " + (booking.startTime || "") + ").";
    const n = await ghl(token, "/contacts/" + encodeURIComponent(contactId) + "/notes", {
      method: "POST", version: CONTACTS_API_VERSION, body: { body: note }
    }).catch(() => ({ ok: false }));
    if (!n.ok) console.warn("[decision] Note not added (token may lack contacts.write):", n.status);

    return sendJson(res, 200, { ok: true, action, status: newStatus });
  } catch (err) {
    if (err && err.name === "AbortError") {
      // The update may or may not have gone through. A retry is safe: if it
      // did, the pending check above answers 409 "already decided".
      console.error("[decision] GHL request timed out");
      return sendJson(res, 504, { error: "ghl_timeout" });
    }
    console.error("[decision] Unexpected error:", err);
    return sendJson(res, 502, { error: "server_error" });
  }
};
