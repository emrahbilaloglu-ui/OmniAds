import { NextRequest, NextResponse } from "next/server";
import { attachSessionCookie, createSession } from "@/lib/auth";
import { findOrCreateFacebookUser } from "@/lib/account-store";
import { listUserBusinesses } from "@/lib/access";
import { logServerAuthEvent } from "@/lib/auth-diagnostics";
import { sanitizeNextPath } from "@/lib/auth-routing";

interface FacebookTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: {
    message: string;
    type: string;
    code: number;
  };
}

interface FacebookUserInfo {
  id: string;
  name?: string;
  email?: string;
  picture?: {
    data?: {
      url?: string;
    };
  };
}

/**
 * GET /api/oauth/sign-with-facebook/callback
 *
 * Handles the OAuth redirect from Facebook after user consents.
 * Exchanges code for token, fetches profile, creates/links user, creates session.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost:3000";

  function errorRedirect(msg: string) {
    const url = new URL("/login", baseUrl);
    url.searchParams.set("error", msg);
    return NextResponse.redirect(url.toString());
  }

  // Facebook returned an error (e.g. user denied consent)
  if (error) {
    logServerAuthEvent("facebook_login_oauth_error", { error });
    return errorRedirect("Facebook sign-in was cancelled.");
  }

  if (!code || !state) {
    return errorRedirect("Missing authorization code or state.");
  }

  // ── Validate state (CSRF protection) ──────────────────────
  const cookieState = request.cookies.get("facebook_login_state")?.value;
  if (!cookieState || cookieState !== state) {
    logServerAuthEvent("facebook_login_state_mismatch", {});
    return errorRedirect("Invalid OAuth state. Please try again.");
  }

  // Decode state to extract next path
  let nextPath = "";
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    nextPath = payload.next ?? "";
  } catch {
    // non-fatal
  }

  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.SIGN_WITH_FACEBOOK_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return errorRedirect("Facebook Sign-In is not configured.");
  }

  try {
    // ── Exchange code for access token ────────────────────────
    const tokenParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?${tokenParams.toString()}`,
    );

    const tokenData = (await tokenRes.json()) as FacebookTokenResponse;
    if (!tokenRes.ok || tokenData.error) {
      // The identifiers, not the sentence. `tokenData.error.message` is free
      // text Meta controls; `logServerAuthEvent` writes it to `console.info`,
      // which is the server log this deployment ships. The redirect below was
      // already locally authored — this was the last provider string on the
      // path.
      logServerAuthEvent("facebook_login_token_exchange_failed", {
        httpStatus: tokenRes.status,
        code: tokenData.error?.code,
        type: tokenData.error?.type,
      });
      return errorRedirect("Failed to exchange Facebook authorization code.");
    }

    if (!tokenData.access_token) {
      return errorRedirect("Facebook did not return an access token.");
    }

    // ── Fetch user profile from Facebook ──────────────────────
    const userInfoParams = new URLSearchParams({
      fields: "id,name,email,picture",
      access_token: tokenData.access_token,
    });

    const userInfoRes = await fetch(
      `https://graph.facebook.com/me?${userInfoParams.toString()}`,
    );

    if (!userInfoRes.ok) {
      return errorRedirect("Failed to fetch Facebook profile.");
    }

    const profile = (await userInfoRes.json()) as FacebookUserInfo;

    if (!profile.email) {
      logServerAuthEvent("facebook_login_no_email", {
        facebookId: profile.id,
      });
      return errorRedirect(
        "Facebook did not provide your email. Please ensure email permissions are granted.",
      );
    }

    if (!profile.id) {
      return errorRedirect(
        "Missing required profile information from Facebook.",
      );
    }

    // ── Find or create user ───────────────────────────────────
    const avatarUrl = profile.picture?.data?.url ?? null;
    const user = await findOrCreateFacebookUser({
      facebookId: profile.id,
      email: profile.email,
      name: profile.name ?? profile.email.split("@")[0],
      avatar: avatarUrl,
    });

    // ── Create session ────────────────────────────────────────
    const businesses = await listUserBusinesses(user.id);
    const firstActiveBusiness =
      businesses.find((b) => b.membershipStatus === "active")?.id ?? null;

    const { token, expiresAt } = await createSession({
      userId: user.id,
      activeBusinessId: firstActiveBusiness,
    });

    logServerAuthEvent("facebook_login_succeeded", {
      userId: user.id,
      email: user.email,
      membershipCount: businesses.length,
      activeBusinessId: firstActiveBusiness,
    });

    // ── Redirect to app ───────────────────────────────────────
    let destination = "/overview";
    const safeNextPath = sanitizeNextPath(nextPath);
    if (safeNextPath) {
      destination = safeNextPath;
    } else if (businesses.length === 0) {
      destination = "/businesses/new";
    } else if (!firstActiveBusiness) {
      destination = "/select-business";
    }

    const response = NextResponse.redirect(
      new URL(destination, baseUrl).toString(),
    );
    attachSessionCookie(response, token, expiresAt);

    // Clear state cookie
    response.cookies.set("facebook_login_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    return response;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error during Facebook sign-in.";
    console.error("[Facebook Sign-In Error]", message, err);
    logServerAuthEvent("facebook_login_error", { message });
    return errorRedirect("An error occurred during Facebook sign-in.");
  }
}
