import { NextRequest, NextResponse } from "next/server";
import { resolveRequestLanguage } from "@/lib/request-language";
import { getUserByEmail } from "@/lib/account-store";
import { createPasswordResetToken } from "@/lib/password-reset-store";
import { isEmailConfigured, sendEmail } from "@/lib/email/mailer";
import { logStartupError } from "@/lib/startup-diagnostics";

interface PasswordResetRequestBody {
  email?: string;
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

  // A provider IS configured. Send a real reset link when the account exists, but always
  // respond generically so we never reveal whether an account exists (no enumeration).
  try {
    const user = await getUserByEmail(email);
    if (user) {
      const rawToken = await createPasswordResetToken(user.id);
      const resetUrl = new URL(`/reset-password?token=${rawToken}`, request.nextUrl.origin).toString();
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
    logStartupError("password_reset_request_send_failed", error);
    return NextResponse.json(
      {
        error: "email_send_failed",
        message:
          language === "tr"
            ? "Sıfırlama emaili gönderilemedi. Lütfen daha sonra tekrar deneyin."
            : "The reset email could not be sent. Please try again later.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      language === "tr"
        ? "Bu email bir hesaba bağlıysa, 30 dakika geçerli bir sıfırlama bağlantısı gönderdik."
        : "If that email is linked to an account, we sent a reset link valid for 30 minutes.",
  });
}
