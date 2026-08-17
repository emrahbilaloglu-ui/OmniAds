import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";
import {
  isKlaviyoOAuthConfigured,
  KLAVIYO_CONFIG,
  KLAVIYO_REQUIRED_ENV_VARS,
} from "@/lib/oauth/klaviyo-config";

/**
 * GET /api/oauth/klaviyo/start?businessId=...
 *
 * Redirects the user to Klaviyo's OAuth consent screen — the same shape as
 * `app/api/oauth/google/start/route.ts`: businessId required, the caller must
 * be a `collaborator` on that business, a random state encodes the businessId
 * and is mirrored into a short-lived httpOnly cookie for the callback to
 * compare.
 *
 * Two things differ from Google, both because Klaviyo requires them:
 *   - PKCE is mandatory, so a verifier is generated here, its S256 challenge
 *     goes to Klaviyo, and the verifier itself is kept in a second httpOnly
 *     cookie for the token exchange.
 *   - There is no `access_type=offline`; Klaviyo issues a refresh token to any
 *     confidential client and rotates it on every refresh.
 *
 * This route previously answered 501 unconditionally, because fabricating a
 * connection would have been a lie. It still answers 501 — with the exact env
 * vars named — whenever the deployment holds no Klaviyo client credential. That
 * is not a placeholder: an OAuth app id and secret are the owner's to create,
 * and a redirect built from a missing client id would fail at Klaviyo with a
 * message the user cannot act on.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const returnTo = sanitizeNextPath(searchParams.get("returnTo"));

  if (!businessId) {
    return NextResponse.json(
      { error: "businessId query parameter is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  // The honest boundary. Checked AFTER authorization so the deployment's
  // configuration state is not readable by a stranger, and BEFORE any redirect
  // so the user never authorizes against an app that cannot exchange the code.
  if (!isKlaviyoOAuthConfigured()) {
    return NextResponse.json(
      {
        error: "not_configured",
        message:
          "Klaviyo OAuth is not configured for this deployment. The owner must create a Klaviyo OAuth app and set its client credentials before Klaviyo can be connected.",
        requiredEnv: [...KLAVIYO_REQUIRED_ENV_VARS],
        redirectUri: KLAVIYO_CONFIG.redirectUri,
      },
      { status: 501 },
    );
  }

  const statePayload = JSON.stringify({
    businessId,
    provider: "klaviyo",
    returnTo,
    nonce: crypto.randomBytes(16).toString("hex"),
  });
  const state = Buffer.from(statePayload).toString("base64url");

  // PKCE. The verifier never leaves this server; only its SHA-256 goes to
  // Klaviyo, so an intercepted authorization code cannot be redeemed by anyone
  // who did not start this flow.
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const params = new URLSearchParams({
    client_id: KLAVIYO_CONFIG.clientId,
    redirect_uri: KLAVIYO_CONFIG.redirectUri,
    scope: KLAVIYO_CONFIG.scopes.join(" "),
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state,
  });

  const response = NextResponse.redirect(
    `${KLAVIYO_CONFIG.authUrl}?${params.toString()}`,
  );
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 600, // 10 minutes, as Google's start route uses
    path: "/",
  };
  response.cookies.set("klaviyo_oauth_state", state, cookieOptions);
  response.cookies.set("klaviyo_oauth_verifier", codeVerifier, cookieOptions);

  return response;
}
