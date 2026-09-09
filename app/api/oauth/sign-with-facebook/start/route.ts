import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { sanitizeNextPath } from "@/lib/auth-routing";

/**
 * GET /api/oauth/sign-with-facebook/start
 *
 * Redirects the user to Facebook's OAuth consent screen for authentication.
 * Uses META_APP_ID (shared with Meta Ads integration) but only requests
 * email + public_profile scopes — no ads permissions.
 */
export async function GET(request: NextRequest) {
  const clientId = process.env.META_APP_ID;
  const redirectUri = process.env.SIGN_WITH_FACEBOOK_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "Facebook Sign-In is not configured." },
      { status: 500 },
    );
  }

  // Preserve ?next= param for post-login redirect
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get("next")) ?? "";

  const statePayload = JSON.stringify({
    nonce: crypto.randomBytes(16).toString("hex"),
    next: nextPath,
  });
  const state = Buffer.from(statePayload).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "email,public_profile",
    state,
  });

  const authorizationUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;

  // Store state in httpOnly cookie for CSRF validation
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("facebook_login_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
