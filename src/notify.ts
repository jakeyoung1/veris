// Delivery. An alert that never leaves the process is not an alert.
//
// SMTP is deliberate: it works with Gmail app passwords, Fastmail, SES, Postmark,
// Resend — anything with a URL, no vendor SDK, no account to create. Config is a
// single connection string so a pilot can be stood up in one env var.
//
//   VERIS_SMTP_URL   smtps://user:pass@smtp.gmail.com:465
//   VERIS_MAIL_FROM  "Veris Alerts <alerts@yourdomain>"
//   VERIS_MAIL_TO    comma-separated default recipients

import nodemailer from "nodemailer";

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

export interface DeliveryResult {
  delivered: boolean;
  to: string[];
  reason?: string;
  messageId?: string;
}

export function mailConfigured(): boolean {
  return Boolean(process.env.VERIS_SMTP_URL && process.env.VERIS_MAIL_FROM);
}

function recipients(explicit?: string[]): string[] {
  if (explicit?.length) return explicit;
  return (process.env.VERIS_MAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Send one alert email. Never throws — a delivery failure is reported so the
 * caller can log it and keep the run going rather than losing the whole digest.
 */
export async function sendMail(
  mail: Mail,
  to?: string[],
): Promise<DeliveryResult> {
  const rcpt = recipients(to);
  if (!mailConfigured()) {
    return {
      delivered: false,
      to: rcpt,
      reason: "VERIS_SMTP_URL and VERIS_MAIL_FROM must both be set",
    };
  }
  if (!rcpt.length) {
    return { delivered: false, to: [], reason: "no recipients (set VERIS_MAIL_TO)" };
  }

  try {
    const transport = nodemailer.createTransport(process.env.VERIS_SMTP_URL!);
    const info = await transport.sendMail({
      from: process.env.VERIS_MAIL_FROM!,
      to: rcpt.join(", "),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { delivered: true, to: rcpt, messageId: info.messageId };
  } catch (e) {
    return {
      delivered: false,
      to: rcpt,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Verify SMTP credentials without sending anything. */
export async function verifyMail(): Promise<{ ok: boolean; detail: string }> {
  if (!mailConfigured()) {
    return { ok: false, detail: "VERIS_SMTP_URL / VERIS_MAIL_FROM not set" };
  }
  try {
    const transport = nodemailer.createTransport(process.env.VERIS_SMTP_URL!);
    await transport.verify();
    return { ok: true, detail: "SMTP connection and credentials OK" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
