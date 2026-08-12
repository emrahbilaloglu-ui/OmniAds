import { NextRequest, NextResponse } from "next/server";
import { META_CONFIG } from "@/lib/oauth/meta-config";
import crypto from "crypto";
import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";

/**
 * GET /api/oauth/meta/start?businessId=...
 *
 * Redirects the user to Meta's OAuth consent screen.
 * Generates a cryptographic state parameter to prevent CSRF.
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
    client_id: META_CONFIG.appId,
    redirect_uri: META_CONFIG.redirectUri,
    scope: META_CONFIG.scopes.join(","),
    response_type: "code",
    state,
  });

  const authorizationUrl = `${META_CONFIG.authUrl}?${params.toString()}`;

  // Set state in a short-lived httpOnly cookie for validation in callback
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("meta_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
