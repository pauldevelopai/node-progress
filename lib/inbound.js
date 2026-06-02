/**
 * lib/inbound.js — reporters self-report by EMAIL.
 *
 * The newsroom shares one inbound address; a reporter emails their end-of-day
 * note to it; that email reaches us as an HTTP POST (from whichever mail service
 * the newsroom points at the webhook — SendGrid Inbound Parse, Mailgun Routes,
 * Postmark, or a Cloudflare Email-Routing Worker). This module is deliberately
 * provider-agnostic: `normalizeInbound` pulls {from, to, subject, text, token}
 * out of the common payload shapes, and `ingestInboundEmail` matches the sender
 * to a reporter and runs the SAME parse+save path as the submit link and the
 * manager's "paste daily report" — so email is just a new front door onto the
 * pipeline we already have.
 *
 * The route in lib/routes.js owns the security (a shared INBOUND_EMAIL_SECRET +
 * the per-newsroom token) and newsroom scoping; this module is pure data, so it
 * unit-tests with a mock host and no network.
 */

import { findReporterByEmail, addEntries } from "./store.js";
import { parseDailyReport } from "./parse-report.js";

/** Pull a bare email address out of "Name <addr@x>" or a raw address. */
export function extractEmail(s) {
  const m = String(s || "").match(/<([^>]+)>/);
  const raw = (m ? m[1] : String(s || "")).trim().toLowerCase();
  return /\S+@\S+\.\S+/.test(raw) ? raw : null;
}

/**
 * The newsroom token from the recipient address. Supports both addressing
 * schemes: plus-addressing (`reports+<token>@domain`) and a dedicated subdomain
 * (`<token>@in.domain`). Case is preserved (the token is base64url).
 */
export function tokenFromAddress(to) {
  const m = String(to || "").match(/<([^>]+)>/);
  const raw = (m ? m[1] : String(to || "")).trim();
  const local = raw.split("@")[0];
  if (!local) return null;
  return local.includes("+") ? local.split("+").pop() : local;
}

/** Normalise the many provider payload shapes into one. */
export function normalizeInbound(body = {}, query = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = body[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return null;
  };
  const from = pick("from", "From", "sender", "envelope_from");
  const to = pick("to", "To", "recipient");
  const subject = pick("subject", "Subject") || "";
  const text = pick("text", "text_body", "TextBody", "body-plain", "stripped-text", "plain", "body") || "";
  // The Cloudflare Worker (which we control) can send an explicit token; otherwise
  // derive it from the recipient address.
  const token = body.token || query.token || tokenFromAddress(to);
  return { from, fromEmail: extractEmail(from), to, subject: String(subject), text: String(text), token };
}

/**
 * Match the sender to a reporter and turn their message into entries. The host
 * is already scoped to the right newsroom by the caller.
 * Returns {ok:true, reporter, added, items, date} or {ok:false, error, ...}.
 */
export async function ingestInboundEmail(host, { fromEmail, subject, text } = {}) {
  if (!fromEmail) return { ok: false, error: "no_sender" };
  const reporter = await findReporterByEmail(host, fromEmail);
  if (!reporter) return { ok: false, error: "unknown_sender", fromEmail };

  const message = [subject, text].filter((s) => String(s || "").trim()).join("\n\n").trim();
  if (!message) return { ok: false, error: "empty", reporter: reporter.name };

  const parsed = await parseDailyReport(host, { text: message, reporterName: reporter.name });
  if (!parsed.ok) return { ...parsed, reporter: reporter.name };

  const out = await addEntries(host, parsed.items, {
    reporter_name: reporter.name, entry_date: parsed.date,
    source: "email", raw_text: message.slice(0, 4000),
  });
  return { ok: true, reporter: reporter.name, date: parsed.date, items: parsed.items, added: out.added };
}
