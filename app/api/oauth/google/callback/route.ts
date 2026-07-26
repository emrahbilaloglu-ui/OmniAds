import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_CONFIG } from "@/lib/oauth/google-config";
import { fetchGoogleAdsAccounts } from "@/lib/google-ads-accounts";
import { upsertIntegration } from "@/lib/integrations";
import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { resolveRequestLanguage } from "@/lib/request-language";
import { scheduleAfterProviderConnect } from "@/lib/oauth/post-connect-schedule";
import { enqueueGoogleAdsScheduledWork } from "@/lib/sync/google-ads-sync";
import { logRuntimeDebug } from "@/lib/runtime-logging";

/**
 * GET /api/oauth/google/callback?code=...&state=...
 *
 * Handles the OAuth redirect from Google:
 *   1. Validates the state parameter against the cookie
 *   2. Exchanges the authorization code for access + refresh tokens
 *   3. Fetches the user's Google identity
 *   4. Upserts the integration record in the DB
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
  const buildFrontendCallbackUrl = (input: {
    provider: "google" | "search_console";
    status: "success" | "error";
    businessId?: string;
    returnTo?: string | null;
    integrationId?: string;
    error?: string;
  }) => {
    const url = new URL(`/integrations/callback/${input.provider}`, baseUrl);
    url.searchParams.set("status", input.status);
    if (input.businessId) {
      url.searchParams.set("businessId", input.businessId);
    }
    if (input.integrationId) {
      url.searchParams.set("integrationId", input.integrationId);
    }
    const safeReturnTo = sanitizeNextPath(input.returnTo);
    if (safeReturnTo) {
      url.searchParams.set("returnTo", safeReturnTo);
    }
    if (input.error) {
      url.searchParams.set("error", input.error);
    }
    return url.toString();
  };

  // ── User denied or Google returned an error ────────────────
  if (error) {
    const msg = errorDescription || error;
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: "google",
        status: "error",
        error: msg,
      }),
    );
  }

  // ── Validate required params ───────────────────────────────
  if (!code || !state) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: "google",
        status: "error",
        error: tr("Missing code or state parameter.", "Code veya state parametresi eksik."),
      }),
    );
  }

  // ── Validate state against cookie ──────────────────────────
  const cookieState = request.cookies.get("google_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: "google",
        status: "error",
        error: tr("Invalid OAuth state. Please try again.", "OAuth state geçersiz. Lütfen tekrar deneyin."),
      }),
    );
  }

  // Decode businessId from state
  let businessId: string;
  let oauthProvider: "google" | "search_console" = "google";
  let returnTo: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    businessId = payload.businessId;
    if (!businessId) throw new Error("No businessId in state payload");
    oauthProvider =
      payload.provider === "search_console" ? "search_console" : "google";
    returnTo = sanitizeNextPath(
      typeof payload.returnTo === "string" ? payload.returnTo : null,
    );
  } catch {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: "google",
        status: "error",
        error: tr("Malformed OAuth state.", "OAuth state bozuk."),
      }),
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: oauthProvider,
        status: "error",
        businessId,
        returnTo,
        error: tr("You do not have permission to connect integrations for this business.", "Bu business için integration bağlama yetkiniz yok."),
      }),
    );
  }

  try {
    // ── Exchange code for tokens ───────────────────────────────
    const tokenRes = await fetch(GOOGLE_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CONFIG.clientId,
        client_secret: GOOGLE_CONFIG.clientSecret,
        redirect_uri: GOOGLE_CONFIG.redirectUri,
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
        "[google-oauth-callback] No refresh_token returned. The user may have already granted access. " +
          "Consider revoking and reconnecting to obtain a new refresh token.",
      );
    }

    // ── Fetch Google user identity ──────────────────────────────
    const userinfoRes = await fetch(GOOGLE_CONFIG.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userinfoData = await userinfoRes.json();

    if (userinfoData.error) {
      throw new Error(
        userinfoData.error.message || tr("Failed to fetch Google user profile.", "Google kullanıcı profili alinamadi."),
      );
    }

    const providerAccountId: string = userinfoData.id ?? "";
    const providerAccountName: string =
      userinfoData.name ?? userinfoData.email ?? "Google User";

    // ── Save to DB ──────────────────────────────────────────────
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : undefined;

    const integration = await upsertIntegration({
      businessId,
      provider: "google",
      status: "connected",
      providerAccountId,
      providerAccountName,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: GOOGLE_CONFIG.scopes.join(" "),
    });

    let googlePostConnect: Awaited<
      ReturnType<typeof scheduleAfterProviderConnect>
    > | null = null;
    if (GOOGLE_CONFIG.scopes.includes("https://www.googleapis.com/auth/adwords")) {
      // Awaited, bound to this grant's generation, and intersected with the
      // accounts the new principal can actually see. The previous pair of
      // `.catch(() => null)` calls scheduled a background refresh whose failure
      // was invisible and then enqueued work for the OLD selection regardless —
      // including accounts this grant has no access to.
      googlePostConnect = await scheduleAfterProviderConnect({
        businessId,
        provider: "google",
        growthScope: "google_oauth_post_connect",
        liveLoader: async () => {
          const result = await fetchGoogleAdsAccounts(accessToken, {
            scopePresent: true,
          });
          if (!result.ok) {
            throw new Error(
              result.error ?? "Could not discover accessible Google Ads accounts."
            );
          }
          return result.customers.map((customer) => ({
            id: customer.id,
            name: customer.name,
            currency: customer.currency ?? undefined,
            timezone: customer.timezone ?? undefined,
            isManager: customer.isManager,
          }));
        },
        enqueue: async ({ businessId: id }: { businessId: string }) => {
          await enqueueGoogleAdsScheduledWork(id);
        },
      });
    }

    let searchConsoleIntegrationId: string | null = null;
    if (oauthProvider === "search_console") {
      const searchConsoleIntegration = await upsertIntegration({
        businessId,
        provider: "search_console",
        status: "connected",
        providerAccountName: "Not selected",
        metadata: {
          connectedAt: new Date().toISOString(),
        },
      });
      searchConsoleIntegrationId = searchConsoleIntegration.id;
    }

    logRuntimeDebug("google-oauth-callback", "integration_upserted", {
      businessId,
      integrationId: integration.id,
      providerAccountId,
      providerAccountName,
      hasRefreshToken: Boolean(refreshToken),
      returnTo,
    });

    // ── Redirect to frontend callback with success ──────────────
    const redirectProvider =
      oauthProvider === "search_console" ? "search_console" : "google";
    const redirectUrl = buildFrontendCallbackUrl({
      provider: redirectProvider,
      status: "success",
      businessId,
      returnTo,
      integrationId:
        oauthProvider === "search_console"
          ? (searchConsoleIntegrationId ?? integration.id)
          : integration.id,
    });

    // Truthful about scheduling. A connection that saved but scheduled nothing —
    // because discovery failed, because capacity refused, or because this
    // principal cannot see any previously selected account — is a different
    // outcome from one that started syncing.
    const finalRedirectUrl = new URL(redirectUrl);
    if (googlePostConnect) {
      finalRedirectUrl.searchParams.set(
        "syncScheduled",
        googlePostConnect.scheduled ? "1" : "0",
      );
      if (!googlePostConnect.scheduled) {
        finalRedirectUrl.searchParams.set("scheduleReason", googlePostConnect.reason);
      }
      if (googlePostConnect.droppedAccountIds.length > 0) {
        finalRedirectUrl.searchParams.set(
          "droppedAccounts",
          String(googlePostConnect.droppedAccountIds.length),
        );
      }
    }

    const response = NextResponse.redirect(finalRedirectUrl.toString());
    // Clear the state cookie
    response.cookies.set("google_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during Google OAuth.";
    console.error("[google-oauth-callback] error", { businessId, message, returnTo });

    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        provider: oauthProvider,
        status: "error",
        businessId,
        returnTo,
        error: message,
      }),
    );
  }
}
