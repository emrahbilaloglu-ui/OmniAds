import { NextRequest, NextResponse } from "next/server";
import { SHOPIFY_CONFIG } from "@/lib/oauth/shopify-config";
import { upsertIntegration } from "@/lib/integrations";
import { updateBusinessCurrency } from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";
import { resolveRequestLanguage } from "@/lib/request-language";
import { createShopifyInstallContext } from "@/lib/shopify/install-context";
import {
  SHOPIFY_INSTALL_PROOF_COOKIE,
  SHOPIFY_INSTALL_PROOF_COOKIE_MAX_AGE_SECONDS,
  buildShopifyInstallProof,
} from "@/lib/shopify/install-context-access";
import { getSessionFromRequest } from "@/lib/auth";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { verifyShopifyQueryHmac } from "@/lib/shopify/oauth-hmac";
import { normalizeShopifyShopDomain } from "@/lib/shopify/shop-domain";
import { validateShopifyOAuthCallbackState } from "@/lib/shopify/oauth-state";
import { logRuntimeDebug } from "@/lib/runtime-logging";

/**
 * GET /api/oauth/shopify/callback?code=...&shop=...&state=...&hmac=...&timestamp=...
 *
 * Handles the OAuth redirect from Shopify:
 *   1. Validates the HMAC signature
 *   2. Validates the state parameter against the cookie when present
 *   3. Exchanges the authorization code for a permanent access token
 *   4. Fetches shop metadata
 *   5. Either upserts the integration directly or stores a pending install context
 *   6. Redirects to onboarding / callback UI with status
 */
export async function GET(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const shop = normalizeShopifyShopDomain(searchParams.get("shop"));
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");
  const timestamp = searchParams.get("timestamp");

  const baseUrl = SHOPIFY_CONFIG.validatedAppUrl;

  function errorRedirect(msg: string, businessId?: string) {
    const url = new URL("/integrations/callback/shopify", baseUrl);
    url.searchParams.set("status", "error");
    url.searchParams.set("error", msg);
    if (businessId) url.searchParams.set("businessId", businessId);
    return NextResponse.redirect(url.toString());
  }

  // ── Validate required params ───────────────────────────────
  if (!code || !shop || !hmac || !timestamp) {
    return errorRedirect(tr("Missing required Shopify callback parameters.", "Gerekli Shopify callback parametreleri eksik."));
  }

  // ── Validate HMAC signature ────────────────────────────────
  if (!verifyShopifyQueryHmac({
    url: request.nextUrl,
    clientSecret: SHOPIFY_CONFIG.clientSecret,
  })) {
    console.error("[shopify-oauth-callback] HMAC verification failed", {
      shop,
      received: hmac,
    });
    return errorRedirect(tr("HMAC verification failed. Request may be tampered.", "HMAC doğrulamasi başarısız. Istekle oynanmis olabilir."));
  }

  const cookieState = request.cookies.get("shopify_oauth_state")?.value;
  const stateValidation = validateShopifyOAuthCallbackState({
    state,
    cookieState: cookieState ?? null,
  });
  if (!stateValidation.valid) {
    console.warn("[shopify-oauth-callback] State validation failed", {
      shop,
      reason: stateValidation.reason,
    });
    return errorRedirect(tr("Invalid Shopify callback state.", "Geçersiz Shopify callback state değeri."));
  }

  const stateBusinessId = stateValidation.parsedState?.businessId ?? null;
  const stateReturnTo = stateValidation.parsedState?.returnTo ?? null;
  const hasVerifiedState = stateValidation.reason === "state_verified";
  const session = await getSessionFromRequest(request);

  try {
    // ── Exchange code for permanent access token ───────────────
    const tokenRes = await fetch(SHOPIFY_CONFIG.tokenUrl(shop), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: SHOPIFY_CONFIG.clientId,
        client_secret: SHOPIFY_CONFIG.clientSecret,
        code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      throw new Error(
        tokenData.error_description ||
          tokenData.error ||
          `Shopify token exchange failed (HTTP ${tokenRes.status}).`,
      );
    }

    const accessToken: string = tokenData.access_token;
    const grantedScopes: string = tokenData.scope ?? "";

    // ── Fetch shop metadata ─────────────────────────────────────
    let shopName: string = shop;
    let shopCurrency: string | null = null;
    let shopIanaTimeZone: string | null = null;
    let shopTimeZoneLabel: string | null = null;
    try {
      const shopRes = await fetch(SHOPIFY_CONFIG.shopInfoUrl(shop), {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          Accept: "application/json",
        },
      });
      if (shopRes.ok) {
        const shopData = await shopRes.json();
        shopName = shopData.shop?.name ?? shop;
        shopCurrency = shopData.shop?.currency ?? null;
        shopIanaTimeZone = shopData.shop?.iana_timezone ?? null;
        shopTimeZoneLabel = shopData.shop?.timezone ?? null;
      }
    } catch (shopErr) {
      console.warn(
        "[shopify-oauth-callback] Failed to fetch shop info (non-fatal):",
        shopErr,
      );
    }

    const metadata =
      shopCurrency || shopIanaTimeZone || shopTimeZoneLabel
        ? {
            ...(shopCurrency ? { currency: shopCurrency } : {}),
            ...(shopIanaTimeZone ? { iana_timezone: shopIanaTimeZone } : {}),
            ...(shopTimeZoneLabel ? { timezone: shopTimeZoneLabel } : {}),
            shopifyProductionServingMode: "auto",
          }
        : { shopifyProductionServingMode: "auto" };

    if (hasVerifiedState && stateBusinessId) {
      const access = await requireBusinessAccess({
        request,
        businessId: stateBusinessId,
        minRole: "collaborator",
      });

      if (!("error" in access)) {
        const integration = await upsertIntegration({
          businessId: stateBusinessId,
          provider: "shopify",
          status: "connected",
          providerAccountId: shop,
          providerAccountName: shopName,
          accessToken,
          scopes: grantedScopes,
          metadata,
        });

        if (shopCurrency) {
          try {
            await updateBusinessCurrency(stateBusinessId, shopCurrency);
          } catch (currencyErr) {
            console.warn("[shopify-oauth-callback] Failed to sync shop currency (non-fatal):", currencyErr);
          }
        }

        logRuntimeDebug("shopify-oauth-callback", "integration_upserted", {
          businessId: stateBusinessId,
          integrationId: integration.id,
          shop,
          shopName,
        });

        const redirectUrl = new URL("/integrations/callback/shopify", baseUrl);
        redirectUrl.searchParams.set("status", "success");
        redirectUrl.searchParams.set("businessId", stateBusinessId);
        redirectUrl.searchParams.set("integrationId", integration.id);
        if (stateReturnTo) {
          redirectUrl.searchParams.set("returnTo", stateReturnTo);
        }

        const response = NextResponse.redirect(redirectUrl.toString());
        response.cookies.set("shopify_oauth_state", "", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: 0,
          path: "/",
        });
        return response;
      }
    }

    const context = await createShopifyInstallContext({
      shopDomain: shop,
      shopName,
      accessToken,
      scopes: grantedScopes,
      metadata,
      returnTo: stateReturnTo,
      sessionId: session?.sessionId ?? null,
      userId: session?.user.id ?? null,
      preferredBusinessId: stateBusinessId,
    });

    logRuntimeDebug("shopify-oauth-callback", "pending_install_context_created", {
      contextId: context.id,
      shop,
      shopName,
      userId: session?.user.id ?? null,
      preferredBusinessId: stateBusinessId,
    });

    const onboardingUrl = new URL("/shopify/connect", baseUrl);
    onboardingUrl.searchParams.set("context", context.token);
    if (stateReturnTo) {
      onboardingUrl.searchParams.set("returnTo", stateReturnTo);
    }
    const response = NextResponse.redirect(onboardingUrl.toString());
    response.cookies.set("shopify_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    // A Shopify-initiated install records no session and no user — the merchant
    // has not signed in yet — so the context row has no identity to check a
    // later reader against. This is the identity: an HMAC of the context token
    // that only this response carries, so the first authenticated view can bind
    // the context to a browser that provably completed the Shopify redirect
    // rather than to whoever presents the token first. See
    // `lib/shopify/install-context-access.ts`. The context token travels in the
    // URL; this does not, and cannot be derived from it.
    const installProof = buildShopifyInstallProof(context.token);
    if (installProof) {
      response.cookies.set(SHOPIFY_INSTALL_PROOF_COOKIE, installProof, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: SHOPIFY_INSTALL_PROOF_COOKIE_MAX_AGE_SECONDS,
        path: "/",
      });
    }
    return response;
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error during Shopify OAuth.";
    console.error("[shopify-oauth-callback] error", {
      businessId: stateBusinessId,
      shop,
      message,
    });
    return errorRedirect(message, stateBusinessId ?? undefined);
  }
}
