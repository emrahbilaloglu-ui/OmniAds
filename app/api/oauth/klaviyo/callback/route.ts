import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { upsertIntegration } from "@/lib/integrations";
import {
  exchangeKlaviyoAuthorizationCode,
  fetchKlaviyoAccount,
} from "@/lib/klaviyo/api";
import { syncKlaviyoFlowMetrics } from "@/lib/klaviyo/sync";
import {
  isKlaviyoOAuthConfigured,
  KLAVIYO_CONFIG,
} from "@/lib/oauth/klaviyo-config";
import { resolveRequestLanguage } from "@/lib/request-language";
import { logRuntimeDebug } from "@/lib/runtime-logging";

/**
 * GET /api/oauth/klaviyo/callback?code=...&state=...
 *
 * The same six steps as `app/api/oauth/google/callback/route.ts`, in the same
 * order, with the same error paths:
 *   1. Klaviyo-reported error → redirect with status=error
 *   2. Missing code/state → redirect with status=error
 *   3. State must equal the httpOnly cookie the start route set
 *   4. businessId is decoded from the state, then re-authorised server-side
 *   5. Code (plus the PKCE verifier cookie) is exchanged for tokens
 *   6. The integration row is upserted and the first import is attempted
 *
 * Step 4 is the load-bearing one and is deliberately identical to Google's: the
 * state cookie proves the flow started in this browser, not that the person
 * finishing it may connect integrations for that business, so
 * `requireBusinessAccess` runs again with the same `collaborator` minimum.
 */
export async function GET(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const tr = (english: string, turkish: string) =>
    language === "tr" ? turkish : english;

  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const buildFrontendCallbackUrl = (input: {
    status: "success" | "error";
    businessId?: string;
    returnTo?: string | null;
    integrationId?: string;
    error?: string;
  }) => {
    const url = new URL("/integrations/callback/klaviyo", baseUrl);
    url.searchParams.set("status", input.status);
    if (input.businessId) url.searchParams.set("businessId", input.businessId);
    if (input.integrationId) {
      url.searchParams.set("integrationId", input.integrationId);
    }
    const safeReturnTo = sanitizeNextPath(input.returnTo);
    if (safeReturnTo) url.searchParams.set("returnTo", safeReturnTo);
    if (input.error) url.searchParams.set("error", input.error);
    return url.toString();
  };

  const clearFlowCookies = (response: NextResponse) => {
    const expired = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: 0,
      path: "/",
    };
    response.cookies.set("klaviyo_oauth_state", "", expired);
    response.cookies.set("klaviyo_oauth_verifier", "", expired);
    return response;
  };

  // ── User denied or Klaviyo returned an error ───────────────
  if (error) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        status: "error",
        error: errorDescription || error,
      }),
    );
  }

  // ── Validate required params ───────────────────────────────
  if (!code || !state) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        status: "error",
        error: tr(
          "Missing code or state parameter.",
          "Code veya state parametresi eksik.",
        ),
      }),
    );
  }

  // ── Validate state against cookie ──────────────────────────
  const cookieState = request.cookies.get("klaviyo_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        status: "error",
        error: tr(
          "Invalid OAuth state. Please try again.",
          "OAuth state geçersiz. Lütfen tekrar deneyin.",
        ),
      }),
    );
  }

  const codeVerifier = request.cookies.get("klaviyo_oauth_verifier")?.value;
  if (!codeVerifier) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        status: "error",
        error: tr(
          "The Klaviyo authorization session expired. Please try again.",
          "Klaviyo yetkilendirme oturumu doldu. Lütfen tekrar deneyin.",
        ),
      }),
    );
  }

  let businessId: string;
  let returnTo: string | null = null;
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    businessId = payload.businessId;
    if (!businessId) throw new Error("No businessId in state payload");
    returnTo = sanitizeNextPath(
      typeof payload.returnTo === "string" ? payload.returnTo : null,
    );
  } catch {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
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
        status: "error",
        businessId,
        returnTo,
        error: tr(
          "You do not have permission to connect integrations for this business.",
          "Bu business için integration bağlama yetkiniz yok.",
        ),
      }),
    );
  }

  // Reachable only if the credential was removed between start and callback.
  if (!isKlaviyoOAuthConfigured()) {
    return NextResponse.redirect(
      buildFrontendCallbackUrl({
        status: "error",
        businessId,
        returnTo,
        error: tr(
          "Klaviyo OAuth is not configured for this deployment.",
          "Bu kurulumda Klaviyo OAuth yapılandırılmamış.",
        ),
      }),
    );
  }

  try {
    const token = await exchangeKlaviyoAuthorizationCode({ code, codeVerifier });

    // The account identity is what the snapshot is keyed on, so a grant we
    // cannot attribute to an account is refused rather than stored under a
    // synthetic id — the exact fabrication the previous 501 existed to prevent.
    const account = await fetchKlaviyoAccount(token.accessToken);
    if (!account) {
      throw new Error(
        tr(
          "Klaviyo did not return an account for this authorization.",
          "Klaviyo bu yetkilendirme için hesap döndürmedi.",
        ),
      );
    }

    const integration = await upsertIntegration({
      businessId,
      provider: "klaviyo",
      status: "connected",
      providerAccountId: account.id,
      providerAccountName: account.name ?? account.id,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? undefined,
      tokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
      scopes: token.scope ?? KLAVIYO_CONFIG.scopes.join(" "),
      metadata: {
        connectedAt: new Date().toISOString(),
        ...(account.currency ? { klaviyoCurrency: account.currency } : {}),
      },
    });

    // The first import, attempted here and REPORTED truthfully. It runs through
    // the ordinary ingest admission, so a disabled `source_ingest` lane or a
    // tripped growth fence makes it refuse — and a connection that saved but
    // imported nothing is a different outcome from one that is ready to read.
    let syncScheduled = false;
    let scheduleReason = "";
    try {
      const result = await syncKlaviyoFlowMetrics(businessId);
      syncScheduled = !result.skipped;
      scheduleReason = result.skipReason ?? "";
    } catch (syncError) {
      scheduleReason =
        syncError instanceof Error ? syncError.name : "sync_failed";
    }

    logRuntimeDebug("klaviyo-oauth-callback", "integration_upserted", {
      businessId,
      integrationId: integration.id,
      providerAccountId: account.id,
      hasRefreshToken: Boolean(token.refreshToken),
      syncScheduled,
      returnTo,
    });

    const redirectUrl = new URL(
      buildFrontendCallbackUrl({
        status: "success",
        businessId,
        returnTo,
        integrationId: integration.id,
      }),
    );
    redirectUrl.searchParams.set("syncScheduled", syncScheduled ? "1" : "0");
    if (!syncScheduled && scheduleReason) {
      redirectUrl.searchParams.set("scheduleReason", scheduleReason);
    }

    return clearFlowCookies(NextResponse.redirect(redirectUrl.toString()));
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during Klaviyo OAuth.";
    console.error("[klaviyo-oauth-callback] error", {
      businessId,
      message,
      returnTo,
    });
    return clearFlowCookies(
      NextResponse.redirect(
        buildFrontendCallbackUrl({
          status: "error",
          businessId,
          returnTo,
          error: message,
        }),
      ),
    );
  }
}
