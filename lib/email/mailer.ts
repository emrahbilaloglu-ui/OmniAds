/**
 * Transactional email sender via Resend, configured entirely from env so no credential
 * ever lives in code. Set:
 *   RESEND_API_KEY=re_...
 *   RESEND_FROM="Adsecute <noreply@your-verified-domain.com>"   (the sending domain must
 *                                                                be verified in Resend)
 *
 * Honesty: when the config is absent, isEmailConfigured() is false and the caller must NOT
 * claim an email was sent. A value is only ever "sent" when a real Resend send succeeds.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface ResendConfig {
  apiKey: string;
  from: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function readResendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function isEmailConfigured(): boolean {
  return readResendConfig() !== null;
}

export interface SendEmailResult {
  sent: boolean;
  reason?: "not_configured";
}

/**
 * Sends an email via Resend. Returns { sent: false, reason: "not_configured" } when no
 * provider is set (caller stays honest); throws only on a genuine send failure so the
 * caller can surface a real error, never a fake success.
 */
export async function sendEmail(message: EmailMessage): Promise<SendEmailResult> {
  const config = readResendConfig();
  if (!config) return { sent: false, reason: "not_configured" };
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend send failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return { sent: true };
}
