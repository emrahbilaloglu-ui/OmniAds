import { NextRequest, NextResponse } from "next/server";
import { resolveRequestLanguage } from "@/lib/request-language";
import { consumePasswordResetToken } from "@/lib/password-reset-store";

interface PasswordResetConfirmBody {
  token?: string;
  password?: string;
}

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const body = (await request.json().catch(() => null)) as PasswordResetConfirmBody | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json(
      {
        error: "missing_token",
        message: language === "tr" ? "Sıfırlama bağlantısı geçersiz." : "The reset link is invalid.",
      },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        error: "weak_password",
        message:
          language === "tr"
            ? `Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı.`
            : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      },
      { status: 400 },
    );
  }

  const result = await consumePasswordResetToken(token, password);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: "invalid_or_expired_token",
        message:
          language === "tr"
            ? "Bu sıfırlama bağlantısı geçersiz veya süresi dolmuş. Lütfen yeni bir bağlantı isteyin."
            : "This reset link is invalid or has expired. Please request a new one.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    message:
      language === "tr"
        ? "Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz."
        : "Your password has been updated. You can sign in with your new password.",
  });
}
