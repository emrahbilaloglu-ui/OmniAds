import { NextRequest, NextResponse } from "next/server";
import {
  LOGIN_POLICY,
  consumeToken,
  releasePasswordSlot,
  tryAcquirePasswordSlot,
} from "@/lib/auth-throttle";
import { getTrustedClientIp } from "@/lib/request-client-ip";
import { attachSessionCookie, createSession, verifyPassword } from "@/lib/auth";
import { getUserByEmail } from "@/lib/account-store";
import { listUserBusinesses } from "@/lib/access";
import { logServerAuthEvent } from "@/lib/auth-diagnostics";
import { isReviewerEmail, scopeBusinessesForUser } from "@/lib/reviewer-access";
import { getDb } from "@/lib/db";
import { resolveRequestLanguage } from "@/lib/request-language";

interface LoginBody {
  email?: string;
  password?: string;
}

function shouldResetSessionsOnLogin(email: string) {
  const normalized = email.trim().toLowerCase();
  const reviewerEmail = (
    process.env.SHOPIFY_REVIEWER_EMAIL ?? "shopify-review@adsecute.com"
  )
    .trim()
    .toLowerCase();
  const commercialSmokeEmail = (
    process.env.COMMERCIAL_SMOKE_OPERATOR_EMAIL ?? "commercial-smoke@adsecute.com"
  )
    .trim()
    .toLowerCase();
  return normalized === reviewerEmail || normalized === commercialSmokeEmail;
}

export async function POST(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);
  const body = (await request.json().catch(() => null)) as LoginBody | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";

  if (!email || !password) {
    logServerAuthEvent("login_rejected_invalid_payload", { email });
    return NextResponse.json(
      { error: "invalid_payload", message: tr("Email and password are required.", "Email ve sifre zorunludur.") },
      { status: 400 },
    );
  }

  // Keyed on the client address, never on the account: a per-account lockout
  // would let any stranger who knows the operator's email lock the sole
  // operator out of a live-spend dashboard. A correct password always passes.
  const clientIp = getTrustedClientIp(request);
  const gate = consumeToken(
    clientIp ? `login:ip:${clientIp}` : "login:ip:unknown",
    LOGIN_POLICY,
    Date.now(),
  );
  if (!gate.allowed) {
    logServerAuthEvent("login_rejected_rate_limited", { email });
    return NextResponse.json(
      {
        error: "rate_limited",
        message: tr(
          "Too many attempts. Please try again shortly.",
          "Cok fazla deneme. Lutfen biraz sonra tekrar deneyin.",
        ),
      },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    );
  }

  const user = await getUserByEmail(email);
  if (!user) {
    logServerAuthEvent("login_rejected_unknown_user", { email });
    return NextResponse.json(
      { error: "invalid_credentials", message: tr("Invalid email or password.", "Email veya sifre hatali.") },
      { status: 401 },
    );
  }

  // Social-only accounts have no password — tell user to use social sign-in
  if (!user.password_hash) {
    logServerAuthEvent("login_rejected_social_only_user", {
      email,
      userId: user.id,
    });
    return NextResponse.json(
      {
        error: "social_only",
        message: tr('This account uses social sign-in. Please use the "Sign in with Google" or "Sign in with Facebook" button.', 'Bu hesap sosyal giriş kullaniyor. Lütfen "Google ile giriş yap" veya "Facebook ile giriş yap" butonunu kullanin.'),
      },
      { status: 401 },
    );
  }

  // Check if account is suspended
  if ((user as any).suspended_at) {
    logServerAuthEvent("login_rejected_suspended", { email, userId: user.id });
    return NextResponse.json(
      { error: "account_suspended", message: tr("This account has been suspended. Please contact support.", "Bu hesap askiya alinmis. Lütfen destek ile iletisime gecin.") },
      { status: 403 },
    );
  }

  // bcryptjs is the pure-JS build, so each compare blocks the single JS thread
  // for ~240ms. Concurrency buys an attacker no extra guesses but does starve
  // the event loop, so the number in flight is what actually has to be bounded.
  if (!tryAcquirePasswordSlot()) {
    logServerAuthEvent("login_rejected_password_capacity", { email });
    return NextResponse.json(
      {
        error: "rate_limited",
        message: tr("Server busy. Please retry.", "Sunucu mesgul. Lutfen tekrar deneyin."),
      },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }
  let ok: boolean;
  try {
    ok = await verifyPassword(password, user.password_hash);
  } finally {
    releasePasswordSlot();
  }
  if (!ok) {
    logServerAuthEvent("login_rejected_bad_password", {
      email,
      userId: user.id,
    });
    return NextResponse.json(
      { error: "invalid_credentials", message: tr("Invalid email or password.", "Email veya sifre hatali.") },
      { status: 401 },
    );
  }

  const businesses = scopeBusinessesForUser(
    user.email,
    await listUserBusinesses(user.id),
  );
  if (isReviewerEmail(user.email) && businesses.length === 0) {
    logServerAuthEvent("login_rejected_reviewer_not_ready", {
      email: user.email,
      userId: user.id,
    });
    return NextResponse.json(
      {
        error: "reviewer_account_not_ready",
        message: tr("Reviewer account is not assigned to the demo workspace.", "Reviewer hesabi demo workspace'e atanmamis."),
      },
      { status: 403 },
    );
  }
  const firstActiveBusiness =
    businesses.find((b) => b.membershipStatus === "active")?.id ?? null;
  if (shouldResetSessionsOnLogin(user.email)) {
    const sql = getDb();
    await sql`DELETE FROM sessions WHERE user_id = ${user.id}`.catch(() => {});
  }
  const { token, expiresAt } = await createSession({
    userId: user.id,
    activeBusinessId: firstActiveBusiness,
  });
  // Record last login time (fire-and-forget)
  { const sql = getDb(); sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`.catch(() => {}); }


  logServerAuthEvent("login_succeeded", {
    userId: user.id,
    email: user.email,
    membershipCount: businesses.length,
    activeBusinessId: firstActiveBusiness,
  });

  const response = NextResponse.json(
    {
      user: { id: user.id, name: user.name, email: user.email, language: user.language },
      businesses,
      activeBusinessId: firstActiveBusiness,
    },
    { headers: { "Cache-Control": "no-store, max-age=0", Vary: "Cookie" } },
  );
  attachSessionCookie(response, token, expiresAt);
  return response;
}
