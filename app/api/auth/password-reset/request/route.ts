import { NextRequest, NextResponse } from "next/server";
import { resolveRequestLanguage } from "@/lib/request-language";
import { getUserByEmail } from "@/lib/account-store";
import { createPasswordResetToken } from "@/lib/password-reset-store";
import { isEmailConfigured, sendEmail } from "@/lib/email/mailer";
import { normalizeBindAllOriginForBrowser } from "@/lib/public-url";
import { logStartupError } from "@/lib/startup-diagnostics";

interface PasswordResetRequestBody {
  email?: string;
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The origin the reset link is built from.
 *
 * This used to be `request.nextUrl.origin`. That is NOT attacker-controllable —
 * Next's standalone server pins the origin to HOSTNAME:PORT and only consults
 * the Host header when `experimental.trustHostHeader` is set, which it is not —
 * so a forged Host cannot redirect the victim's link. The real consequence was
 * the opposite of a spoof: the pinned value is the bind address, so every
 * self-serve reset email shipped a link to http://0.0.0.0:3000 that nobody
 * could open.
 *
 * In production a missing NEXT_PUBLIC_APP_URL therefore fails closed rather
 * than mailing a dead link, matching the honesty anchor above: we never claim
 * an email was sent that cannot work.
 */
function resolvePublicOrigin(request: NextRequest): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  if (process.env.NODE_ENV === "production") return null;
  return normalizeBindAllOriginForBrowser(request.nextUrl.origin);
}

export async function POST(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const body = (await request.json().catch(() => null)) as PasswordResetRequestBody | null;
  const email = body?.email?.trim().toLowerCase() ?? "";

  if (!looksLikeEmail(email)) {
    return NextResponse.json(
      {
        error: "invalid_email",
        message: language === "tr" ? "Geçerli bir email adresi girin." : "Enter a valid email address.",
      },
      { status: 400 },
    );
  }

  // Honesty anchor: with no email provider configured we never claim an email was sent.
  if (!isEmailConfigured()) {
    return NextResponse.json(
      {
        error: "email_delivery_not_configured",
        message:
          language === "tr"
            ? "Şifre sıfırlama email altyapısı henüz yapılandırılmadı; bu yüzden email gönderilmedi. Şimdilik bir adminin kullanıcı ekranından şifre sıfırlaması gerekir."
            : "Password reset email delivery is not configured yet, so no email was sent. For now, an admin must reset the password from the user screen.",
      },
      { status: 501 },
    );
  }

  const origin = resolvePublicOrigin(request);
  if (!origin) {
    return NextResponse.json(
      {
        error: "app_url_not_configured",
        message:
          language === "tr"
            ? "Uygulama adresi yapılandırılmadığı için sıfırlama bağlantısı üretilemedi; email gönderilmedi."
            : "The app URL is not configured, so a reset link could not be built. No email was sent.",
      },
      { status: 501 },
    );
  }

  // A provider IS configured. Send a real reset link when the account exists, but always
  // respond generically so we never reveal whether an account exists (no enumeration).
  try {
    const user = await getUserByEmail(email);
    if (user) {
      const rawToken = await createPasswordResetToken(user.id);
      // The token rides in the URL FRAGMENT, not the query string. A fragment
      // is never transmitted to the server, so it cannot land in nginx access
      // logs (which log $request by default) and browsers strip it from
      // Referer. The link is still one clickable URL, so the email is unchanged.
      const resetUrl = `${origin}/reset-password#token=${encodeURIComponent(rawToken)}`;
      const subject = language === "tr" ? "Adsecute şifre sıfırlama" : "Reset your Adsecute password";
      const intro =
        language === "tr"
          ? "Adsecute hesabınız için şifre sıfırlama isteği aldık. Aşağıdaki bağlantı 30 dakika geçerlidir:"
          : "We received a request to reset your Adsecute password. This link is valid for 30 minutes:";
      const ignore =
        language === "tr"
          ? "Bu isteği siz yapmadıysanız bu emaili yok sayabilirsiniz; şifreniz değişmez."
          : "If you did not request this, you can ignore this email — your password will not change.";
      await sendEmail({
        to: email,
        subject,
        text: `${intro}\n\n${resetUrl}\n\n${ignore}`,
        html: `<p>${intro}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${ignore}</p>`,
      });
    }
  } catch (error) {
    // Deliberately falls through to the same generic 200 below.
    //
    // This branch is only reachable once getUserByEmail has returned a user, so
    // returning a distinct 502 was an account-existence oracle: any delivery
    // failure answered 502 for real addresses and 200 for made-up ones,
    // defeating the generic-response guarantee this endpoint is built around.
    // The failure is still recorded server-side.
    logStartupError("password_reset_request_send_failed", error);
  }

  return NextResponse.json({
    ok: true,
    message:
      language === "tr"
        ? "Bu email bir hesaba bağlıysa, 30 dakika geçerli bir sıfırlama bağlantısı gönderdik."
        : "If that email is linked to an account, we sent a reset link valid for 30 minutes.",
  });
}
