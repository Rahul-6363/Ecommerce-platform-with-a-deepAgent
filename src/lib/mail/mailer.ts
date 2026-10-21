/**
 * Nodemailer transport plus the Outbox fallback.
 *
 * With SMTP configured, mail goes out and the attempt is logged. With no SMTP
 * configured the message is rendered exactly as it would be sent and written
 * to the MailLog as `captured`, visible on the operator Outbox tab. The point
 * is that the mail path is always exercised: you can read every letter the
 * system would have sent without owning a mail server.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { connectDb } from "@/lib/db/connect";
import { MailLog } from "@/models";
import { emit } from "@/lib/events";

let transporter: Transporter | null = null;

function transport(): Transporter | null {
  if (!env.mail.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure, // true for 465, false for 587 STARTTLS
      auth: { user: env.mail.user, pass: env.mail.pass },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 15_000,
    });
  }
  return transporter;
}

export type SendInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template?: string;
  claimId?: string | null;
  orderId?: string | null;
};

export type SendResult = {
  status: "sent" | "captured" | "failed";
  messageId?: string;
  error?: string;
  logId: string;
};

/** Addresses are validated before Nodemailer sees them. */
function validRecipient(addr: string): boolean {
  // Deliberately strict and single-address: no commas, no angle brackets, no
  // CR/LF. Header injection via a recipient field is a real class of bug.
  return /^[^\s@,<>;:\\"]+@[^\s@,<>;:\\"]+\.[a-z]{2,}$/i.test(addr.trim());
}

export async function sendMail(input: SendInput): Promise<SendResult> {
  await connectDb();

  const to = input.to.trim();
  const text = input.text ?? stripHtml(input.html);

  if (!validRecipient(to)) {
    const log = await MailLog.create({
      to, from: env.mail.from, subject: input.subject, html: input.html, text,
      template: input.template ?? "", status: "failed",
      error: "recipient address failed validation",
      claimId: input.claimId ?? null, orderId: input.orderId ?? null,
    });
    return { status: "failed", error: "invalid recipient address", logId: String(log._id) };
  }

  const t = transport();

  if (!t) {
    const log = await MailLog.create({
      to, from: env.mail.from, subject: input.subject, html: input.html, text,
      template: input.template ?? "", status: "captured",
      claimId: input.claimId ?? null, orderId: input.orderId ?? null,
    });
    await emit({
      type: "mail.captured",
      actor: "MailAgent",
      summary: `Captured to Outbox (no SMTP configured): "${input.subject}" to ${to}`,
      payload: { to, subject: input.subject, template: input.template },
      claimId: input.claimId ?? null,
      orderId: input.orderId ?? null,
    });
    return { status: "captured", logId: String(log._id) };
  }

  try {
    const info = await t.sendMail({
      from: env.mail.from,
      to,
      subject: input.subject,
      html: input.html,
      text,
    });
    const log = await MailLog.create({
      to, from: env.mail.from, subject: input.subject, html: input.html, text,
      template: input.template ?? "", status: "sent", messageId: info.messageId ?? "",
      claimId: input.claimId ?? null, orderId: input.orderId ?? null,
    });
    await emit({
      type: "mail.sent",
      actor: "MailAgent",
      summary: `Sent "${input.subject}" to ${to}`,
      payload: { to, subject: input.subject, messageId: info.messageId, template: input.template },
      claimId: input.claimId ?? null,
      orderId: input.orderId ?? null,
    });
    return { status: "sent", messageId: info.messageId, logId: String(log._id) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = await MailLog.create({
      to, from: env.mail.from, subject: input.subject, html: input.html, text,
      template: input.template ?? "", status: "failed", error: message,
      claimId: input.claimId ?? null, orderId: input.orderId ?? null,
    });
    await emit({
      type: "mail.failed",
      actor: "MailAgent",
      summary: `Mail to ${to} failed: ${message}`,
      payload: { to, subject: input.subject, error: message },
      claimId: input.claimId ?? null,
      orderId: input.orderId ?? null,
    });
    return { status: "failed", error: message, logId: String(log._id) };
  }
}

/** Verify the SMTP credentials without sending anything. */
export async function verifyMail(): Promise<{ ok: boolean; detail: string }> {
  const t = transport();
  if (!t) {
    return { ok: false, detail: "No SMTP_HOST configured — mail is captured to the Outbox." };
  }
  try {
    await t.verify();
    return { ok: true, detail: `SMTP ${env.mail.host}:${env.mail.port} accepted the credentials.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export { stripHtml, validRecipient };
