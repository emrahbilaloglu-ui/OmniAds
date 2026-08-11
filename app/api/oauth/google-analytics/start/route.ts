import { NextRequest, NextResponse } from "next/server";
import { GA_CONFIG } from "@/lib/oauth/google-analytics-config";
import crypto from "crypto";
import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";

/**
 * GET /api/oauth/google-analytics/start?businessId=...
 *
 * Redirects the user to Google's OAuth consent screen requesting
 * Google Analytics readonly access.
 * Generates a cryptographic state parameter to prevent CSRF.
 * Requests offline access so we receive a refresh_token.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");

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

  // Generate a random state that encodes the businessId
  const statePayload = JSON.stringify({
    businessId,
    // Carried through the round trip so the callback can return the operator
    // to the surface that started it. Sanitized here, re-sanitized on return.
    returnTo: sanitizeNextPath(searchParams.get("returnTo")),
    nonce: crypto.randomBytes(16).toString("hex"),
  });
  const state = Buffer.from(statePayload).toString("base64url");

  const params = new URLSearchParams({
    client_id: GA_CONFIG.clientId,
    redirect_uri: GA_CONFIG.redirectUri,
    scope: GA_CONFIG.scopes.join(" "),
    response_type: "code",
    access_type: "offline",
    prompt: "consent", // Force consent to always get refresh_token
    state,
  });

  const authorizationUrl = `${GA_CONFIG.authUrl}?${params.toString()}`;

  // Set state in a short-lived httpOnly cookie for validation in callback
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("ga4_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
