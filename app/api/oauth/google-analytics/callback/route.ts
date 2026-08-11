import { NextRequest, NextResponse } from "next/server";
import { GA_CONFIG } from "@/lib/oauth/google-analytics-config";
import { upsertIntegration } from "@/lib/integrations";
import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { resolveRequestLanguage } from "@/lib/request-language";
import { logRuntimeDebug } from "@/lib/runtime-logging";

/**
 * GET /api/oauth/google-analytics/callback?code=...&state=...
 *
 * Handles the OAuth redirect from Google for Analytics:
 *   1. Validates the state parameter against the cookie
 *   2. Exchanges the authorization code for access + refresh tokens
 *   3. Fetches the user's Google identity
 *   4. Upserts the GA4 integration record in the DB
 *   5. Redirects to the frontend callback page with status
 */
export async function GET(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  // ── User denied or Google returned an error ────────────────
  if (error) {
    const msg = encodeURIComponent(errorDescription || error);
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&error=${msg}`,
    );
  }

  // ── Validate required params ───────────────────────────────
  if (!code || !state) {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&error=${encodeURIComponent(
        tr("Missing code or state parameter.", "Code veya state parametresi eksik."),
      )}`,
    );
  }

  // ── Validate state against cookie ──────────────────────────
  const cookieState = request.cookies.get("ga4_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&error=${encodeURIComponent(
        tr("Invalid OAuth state. Please try again.", "OAuth state geçersiz. Lütfen tekrar deneyin."),
      )}`,
    );
  }

  // Decode businessId from state
  let businessId: string;
  // Re-sanitized on return: the state round-tripped through the provider, so it
  // is not trusted just because we wrote it.
  let stateReturnTo: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    businessId = payload.businessId;
    stateReturnTo = sanitizeNextPath(payload.returnTo);
    if (!businessId) throw new Error("No businessId in state payload");
  } catch {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&error=${encodeURIComponent(
        tr("Malformed OAuth state.", "OAuth state bozuk."),
      )}`,
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&businessId=${businessId}&error=${encodeURIComponent(
        tr("You do not have permission to connect integrations for this business.", "Bu business için integration bağlama yetkiniz yok."),
      )}`,
    );
  }

  try {
    // ── Exchange code for tokens ───────────────────────────────
    const tokenRes = await fetch(GA_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GA_CONFIG.clientId,
        client_secret: GA_CONFIG.clientSecret,
        redirect_uri: GA_CONFIG.redirectUri,
        grant_type: "authorization_code",
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      throw new Error(
        tokenData.error_description ||
          tokenData.error ||
          tr("Failed to exchange authorization code.", "Authorization code değişimi başarısız oldu."),
      );
    }

    const accessToken: string = tokenData.access_token;
    const refreshToken: string | undefined = tokenData.refresh_token;
    const expiresIn: number | undefined = tokenData.expires_in;

    if (!refreshToken) {
      console.warn(
        "[ga4-oauth-callback] No refresh_token returned. The user may have already granted access. " +
          "Consider revoking and reconnecting to obtain a new refresh token.",
      );
    }

    // ── Fetch Google user identity (fault-tolerant) ─────────────
    let providerAccountId = "";
    let providerAccountName = "Google User";
    let providerEmail = "";

    try {
      const userinfoRes = await fetch(GA_CONFIG.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userinfoData = await userinfoRes.json();

      if (!userinfoData.error) {
        providerAccountId = userinfoData.id ?? "";
        providerAccountName =
          userinfoData.name ?? userinfoData.email ?? "Google User";
        providerEmail = userinfoData.email ?? "";
      } else {
        console.warn(
          "[ga4-oauth-callback] userinfo fetch returned error, proceeding without identity",
          { error: userinfoData.error },
        );
      }
    } catch (userinfoErr) {
      console.warn(
        "[ga4-oauth-callback] userinfo fetch failed, proceeding without identity",
        {
          error:
            userinfoErr instanceof Error
              ? userinfoErr.message
              : String(userinfoErr),
        },
      );
    }

    // ── Save to DB ──────────────────────────────────────────────
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : undefined;

    const integration = await upsertIntegration({
      businessId,
      provider: "ga4",
      status: "connected",
      providerAccountId,
      providerAccountName,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: GA_CONFIG.scopes.join(" "),
      metadata: {
        providerEmail,
      },
    });

    logRuntimeDebug("ga4-oauth-callback", "integration_upserted", {
      businessId,
      integrationId: integration.id,
      providerAccountId,
      providerAccountName,
      providerEmail,
      hasRefreshToken: Boolean(refreshToken),
    });

    // ── Redirect to frontend callback with success ──────────────
    const redirectUrl = new URL("/integrations/callback/ga4", baseUrl);
    redirectUrl.searchParams.set("status", "success");
    if (stateReturnTo) redirectUrl.searchParams.set("returnTo", stateReturnTo);
    redirectUrl.searchParams.set("businessId", businessId);
    redirectUrl.searchParams.set("integrationId", integration.id);

    const response = NextResponse.redirect(redirectUrl.toString());
    // Clear the state cookie
    response.cookies.set("ga4_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error during Google Analytics OAuth.";
    console.error("[ga4-oauth-callback] error", { businessId, message });

    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/ga4?status=error&businessId=${businessId}&error=${encodeURIComponent(
        message,
      )}`,
    );
  }
}
