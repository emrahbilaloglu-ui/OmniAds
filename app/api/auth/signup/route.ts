import { NextRequest, NextResponse } from "next/server";
import { attachSessionCookie, createSession, hashPassword } from "@/lib/auth";
import { acceptInvite, createBusinessWithAdminMembership, createUser, getInviteByToken, getUserByEmail } from "@/lib/account-store";
import { listUserBusinesses } from "@/lib/access";
import { logServerAuthEvent } from "@/lib/auth-diagnostics";
import { scopeBusinessesForUser } from "@/lib/reviewer-access";
import { getLanguageFromCookieValue, LANGUAGE_COOKIE_NAME } from "@/lib/i18n";
import { resolveRequestLanguage } from "@/lib/request-language";

interface SignupBody {
  name?: string;
  email?: string;
  password?: string;
  businessName?: string;
  timezone?: string;
  currency?: string;
  inviteToken?: string;
}

export async function POST(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);
  const body = (await request.json().catch(() => null)) as SignupBody | null;
  const name = body?.name?.trim() ?? "";
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";
  const businessName = body?.businessName?.trim() ?? "";
  const currency = body?.currency?.trim().toUpperCase() || "USD";
  const inviteToken = body?.inviteToken?.trim() ?? "";
  if (typeof body?.timezone === "string" && body.timezone.trim().length > 0) {
    console.warn("[signup] deprecated_timezone_input_ignored", { email });
  }

  if (!name || !email || !password) {
    logServerAuthEvent("signup_rejected_invalid_payload", { email });
    return NextResponse.json(
      { error: "invalid_payload", message: tr("Name, email, and password are required.", "Ad, email ve sifre zorunludur.") },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    logServerAuthEvent("signup_rejected_weak_password", { email });
    return NextResponse.json(
      { error: "weak_password", message: tr("Password müst be at least 8 characters.", "Sifre en az 8 karakter olmali.") },
      { status: 400 }
    );
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    logServerAuthEvent("signup_rejected_email_exists", { email });
    return NextResponse.json(
      { error: "email_exists", message: tr("An account with this email already exists.", "Bu email ile zaten bir hesap var.") },
      { status: 409 }
    );
  }

  if (inviteToken) {
    const validatedInvite = await getInviteByToken(inviteToken);
    if (!validatedInvite || validatedInvite.status !== "pending") {
      logServerAuthEvent("signup_rejected_invite_invalid", { email, inviteTokenPresent: true });
      return NextResponse.json(
        { error: "invite_invalid", message: tr("Invite link is invalid or expired.", "Davet linki geçersiz veya süresi dolmuş.") },
        { status: 400 }
      );
    }
    if (validatedInvite.email.toLowerCase() !== email) {
      logServerAuthEvent("signup_rejected_invite_email_mismatch", { email });
      return NextResponse.json(
        { error: "invite_email_mismatch", message: tr("Signup email müst match invite email.", "Kayit email'i davet email'i ile eslesmelidir.") },
        { status: 403 }
      );
    }
  }

  const passwordHash = await hashPassword(password);
  const initialLanguage = getLanguageFromCookieValue(request.cookies.get(LANGUAGE_COOKIE_NAME)?.value);
  const user = await createUser({ name, email, passwordHash, language: initialLanguage });
  let business: {
    id: string;
    name: string;
    timezone: string | null;
    timezoneSource: "shopify" | "ga4" | null;
    currency: string;
  } | null = null;
  if (inviteToken) {
    const accepted = await acceptInvite(inviteToken, user.id);
    if (!accepted) {
      logServerAuthEvent("signup_rejected_invite_accept_failed", { email, userId: user.id });
      return NextResponse.json(
        { error: "invite_accept_failed", message: tr("Could not accept invite.", "Davet kabul edilemedi.") },
        { status: 400 }
      );
    }
    business = {
      id: accepted.businessId,
      name: "Invited workspace",
      timezone: null,
      timezoneSource: null,
      currency,
    };
  } else if (businessName) {
    business = await createBusinessWithAdminMembership({
      name: businessName,
      ownerId: user.id,
      currency,
    });
  }
  const { token, expiresAt } = await createSession({
    userId: user.id,
    activeBusinessId: business?.id ?? null,
  });
  const businesses = scopeBusinessesForUser(user.email, await listUserBusinesses(user.id));
  logServerAuthEvent("signup_succeeded", {
    userId: user.id,
    email: user.email,
    membershipCount: businesses.length,
    activeBusinessId: business?.id ?? null,
  });

  const response = NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, language: user.language },
    businesses,
    activeBusinessId: business?.id ?? null,
  }, { headers: { "Cache-Control": "no-store, max-age=0", Vary: "Cookie" } });
  attachSessionCookie(response, token, expiresAt);
  return response;
}
