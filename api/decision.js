/*
 * POST /api/decision  (Vercel Serverless Function, Node 18+)
 *
 * Called by public/index.html when a staff member taps Approve or Reject.
 * Updates the appointment status directly through the GHL API, using a
 * Private Integration Token that lives ONLY in this server's environment.
 *
 * Request body (JSON):
 *   { appointmentId, contactId, action: "approved" | "rejected", reason, key }
 *
 * Responses (JSON):
 *   200 { ok: true, action, status, warnings: [] }   updated in GHL
 *   400 { error: "bad_request" }                      missing/invalid fields
 *   403 { error: "forbidden" }                        wrong link key, or contact doesn't match
 *   404 { error: "not_found" }                        appointment doesn't exist
 *   405 { error: "method_not_allowed" }
 *   409 { error: "already_decided", currentStatus }   appointment is no longer pending
 *   500 { error: "not_configured" }                   env vars missing
 *   502 / 504                                         GHL error / GHL timeout
 *
 * Environment variables (Vercel > Project > Settings > Environment Variables):
 *   GHL_TOKEN         required  Private Integration Token (pit-...). Scopes:
 *                               calendars/events.readonly, calendars/events.write,
 *                               contacts.write (for notes / reason field).
 *   LINK_KEY          required  Long random string. Also added as &key=... to the
 *                               link in the staff email.
 *   PENDING_STATUSES  optional  Comma list of GHL statuses that count as "pending".
 *                               Default: "new" (GHL's status for unconfirmed bookings).
 *   REASON_FIELD_ID   optional  ID of a contact custom field to store the rejection
 *                               reason in, so your notification workflow can use it.
 *   ADD_NOTES         optional  "false" to skip adding an audit note to the contact.
 */

"use strict";

const crypto = require("crypto");

const GHL_BASE = "https://services.leadconnectorhq.com";
const CALENDAR_API_VERSION = "2021-04-15";
const CONTACTS_API_VERSION = "2021-07-28";
const GHL_TIMEOUT_MS = 8000;

// Page action -> GHL appointmentStatus
const STATUS_FOR_ACTION = { approved: "confirmed", rejected: "cancelled" };

// GHL IDs are short alphanumeric strings. Rejecting anything else also stops
// path tricks like "../" from reaching the GHL URL.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Short, safe description of a GHL error reply (never includes the token),
// returned to the page so staff/admins can see why an update failed.
function ghlDetail(r) {
  const d = r.data || {};
  let msg = d.message || d.error || d.msg || d.raw || "";
  if (Array.isArray(msg)) msg = msg.join("; ");
  return { ghlStatus: r.status, ghlMessage: String(msg).slice(0, 300) };
}

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

// Small wrapper around the GHL API. Never throws on HTTP errors; returns
// { status, ok, data }. Throws only on network failure / timeout.
async function ghl(token, path, { method = "GET", version, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHL_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: "Bearer " + token,
      Version: version,
      Accept: "application/json"
    };
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

  const appointmentId = String(body.appointmentId || "");
  const contactId = String(body.contactId || "");
  const action = String(body.action || "");
  const key = typeof body.key === "string" ? body.key : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  if (!ID_PATTERN.test(appointmentId) || !ID_PATTERN.test(contactId) || !STATUS_FOR_ACTION[action]) {
    return sendJson(res, 400, { error: "bad_request" });
  }

  // ---- 2. Check the link key ----
  if (!key || !safeEqual(key, linkKey)) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  const pending = (process.env.PENDING_STATUSES || "new")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const newStatus = STATUS_FOR_ACTION[action];
  const apptPath = "/calendars/events/appointments/" + encodeURIComponent(appointmentId);
  const warnings = [];

  try {
    // ---- 3. Load the appointment and check it ----
    const current = await ghl(token, apptPath, { version: CALENDAR_API_VERSION });

    if (current.status === 401 || current.status === 403) {
      console.error("[decision] GHL rejected the token (check token and scopes):", current.status, current.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_auth", step: "read appointment" }, ghlDetail(current)));
    }
    if (current.status === 404 || current.status === 400) {
      return sendJson(res, 404, { error: "not_found" });
    }
    if (!current.ok) {
      console.error("[decision] GHL get appointment failed:", current.status, current.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_error", step: "read appointment" }, ghlDetail(current)));
    }

    const appt = (current.data && (current.data.appointment || current.data.event)) || current.data || {};

    // The contact in the link must own this appointment. Someone who only has
    // an appointment ID (or swaps IDs in the URL) can't act on it.
    if (appt.contactId !== contactId) {
      console.warn("[decision] contactId mismatch or missing for appointment", appointmentId);
      return sendJson(res, 403, { error: "forbidden" });
    }

    // Only act on appointments that are still pending. This is what makes
    // double clicks, retries and two staff members on the same link safe.
    const currentStatus = String(appt.appointmentStatus || appt.status || "").toLowerCase();
    if (!pending.includes(currentStatus)) {
      return sendJson(res, 409, { error: "already_decided", currentStatus });
    }

    // ---- 4. Save the rejection reason first (optional), so a workflow that
    //         triggers on the status change can already read it. ----
    if (action === "rejected" && process.env.REASON_FIELD_ID) {
      const r = await ghl(token, "/contacts/" + encodeURIComponent(contactId), {
        method: "PUT",
        version: CONTACTS_API_VERSION,
        body: { customFields: [{ id: process.env.REASON_FIELD_ID, field_value: reason }] }
      });
      if (!r.ok) {
        console.error("[decision] Could not save reason field:", r.status, r.data);
        warnings.push("reason_field_not_saved");
      }
    }

    // ---- 5. Update the appointment status ----
    const update = await ghl(token, apptPath, {
      method: "PUT",
      version: CALENDAR_API_VERSION,
      body: { appointmentStatus: newStatus }
    });
    if (!update.ok) {
      console.error("[decision] GHL update failed:", update.status, update.data);
      return sendJson(res, 502, Object.assign({ error: "ghl_update_failed", step: "update status" }, ghlDetail(update)));
    }

    // ---- 6. Audit note on the contact (best effort, never fails the request) ----
    if (process.env.ADD_NOTES !== "false") {
      const note =
        (action === "approved" ? "Appointment approved" : "Appointment rejected") +
        " via staff approval page (appointment " + appointmentId + ")." +
        (reason ? "\nReason: " + reason : "");
      const n = await ghl(token, "/contacts/" + encodeURIComponent(contactId) + "/notes", {
        method: "POST",
        version: CONTACTS_API_VERSION,
        body: { body: note }
      });
      if (!n.ok) {
        console.error("[decision] Could not add note:", n.status, n.data);
        warnings.push("note_not_added");
      }
    }

    return sendJson(res, 200, { ok: true, action, status: newStatus, warnings });
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
