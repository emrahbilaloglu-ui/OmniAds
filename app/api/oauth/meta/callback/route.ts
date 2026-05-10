import { NextRequest, NextResponse } from "next/server";
import { META_CONFIG } from "@/lib/oauth/meta-config";
import { upsertIntegration } from "@/lib/integrations";
import { requireBusinessAccess } from "@/lib/access";
import { fetchMetaAdAccounts, getMetaApiErrorMessage } from "@/lib/meta-ad-accounts";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { forceProviderAccountSnapshotRefresh } from "@/lib/provider-account-snapshots";
import { syncMetaInitial } from "@/lib/sync/meta-sync";

async function exchangeMetaLongLivedToken(shortLivedToken: string) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: META_CONFIG.appId,
    client_secret: META_CONFIG.appSecret,
    fb_exchange_token: shortLivedToken,
  });

  const response = await fetch(`${META_CONFIG.tokenUrl}?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    throw new Error(
      data?.error?.message ||
        `Meta long-lived token exchange failed with status ${response.status}.`
    );
  }

  return {
    accessToken:
      typeof data?.access_token === "string" ? data.access_token : shortLivedToken,
    expiresIn:
      typeof data?.expires_in === "number" ? data.expires_in : undefined,
  };
}

/**
 * GET /api/oauth/meta/callback?code=...&state=...
 *
 * Handles the OAuth redirect from Meta:
 *   1. Validates the state parameter against the cookie
 *   2. Exchanges the authorization code for an access token
 *   3. Fetches the user's Meta identity
 *   4. Upserts the integration record in the DB
 *   5. Redirects to the frontend callback page with status
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  // ── User denied or Meta returned an error ──────────────────
  if (error) {
    const msg = encodeURIComponent(errorDescription || error);
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/meta?status=error&error=${msg}`,
    );
  }

  // ── Validate required params ───────────────────────────────
  if (!code || !state) {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/meta?status=error&error=${encodeURIComponent(
        "Missing code or state parameter.",
      )}`,
    );
  }

  // ── Validate state against cookie ──────────────────────────
  const cookieState = request.cookies.get("meta_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/meta?status=error&error=${encodeURIComponent(
        "Invalid OAuth state. Please try again.",
      )}`,
    );
  }

  // Decode businessId from state
  let businessId: string;
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    businessId = payload.businessId;
    if (!businessId) throw new Error("No businessId in state payload");
  } catch {
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/meta?status=error&error=${encodeURIComponent(
        "Malformed OAuth state.",
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
      `${baseUrl}/integrations/callback/meta?status=error&businessId=${businessId}&error=${encodeURIComponent(
        "You do not have permission to connect integrations for this business.",
      )}`
    );
  }

  try {
    // ── Exchange code for access token ─────────────────────────
    const tokenParams = new URLSearchParams({
      client_id: META_CONFIG.appId,
      client_secret: META_CONFIG.appSecret,
      redirect_uri: META_CONFIG.redirectUri,
      code,
    });

    const tokenRes = await fetch(
      `${META_CONFIG.tokenUrl}?${tokenParams.toString()}`,
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      throw new Error(
        tokenData.error.message || "Failed to exchange authorization code.",
      );
    }

    let accessToken: string = tokenData.access_token;
    let expiresIn: number | undefined = tokenData.expires_in;

    try {
      const longLived = await exchangeMetaLongLivedToken(accessToken);
      accessToken = longLived.accessToken;
      expiresIn = longLived.expiresIn ?? expiresIn;
    } catch (exchangeError) {
      console.warn("[meta-oauth-callback] long-lived token exchange failed", {
        message:
          exchangeError instanceof Error ? exchangeError.message : String(exchangeError),
      });
    }

    // ── Fetch Meta user identity ────────────────────────────────
    const meRes = await fetch(
      `${META_CONFIG.meUrl}?fields=id,name&access_token=${accessToken}`,
    );
    const meData = await meRes.json();

    if (meData.error) {
      throw new Error(
        meData.error.message || "Failed to fetch Meta user profile.",
      );
    }

    const providerAccountId: string = meData.id;
    const providerAccountName: string = meData.name ?? "Meta User";

    // ── Save to DB ──────────────────────────────────────────────
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : undefined;

    const integration = await upsertIntegration({
      businessId,
      provider: "meta",
      status: "connected",
      providerAccountId,
      providerAccountName,
      accessToken,
      tokenExpiresAt,
      scopes: META_CONFIG.scopes.join(" "),
    });

    await forceProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      freshnessMs: 6 * 60 * 60_000,
      reason: "oauth_callback_refresh",
      liveLoader: async () => {
        const metaResult = await fetchMetaAdAccounts(accessToken);
        if (!metaResult.ok || metaResult.body?.error) {
          throw new Error(getMetaApiErrorMessage(metaResult));
        }
        return metaResult.normalized.map((account) => ({
          id: account.id,
          name: account.name,
          currency: account.currency ?? undefined,
          timezone: account.timezone ?? undefined,
          isManager: false,
        }));
      },
    }).catch(() => null);

    const assignments = await getProviderAccountAssignments(businessId, "meta").catch(
      () => null,
    );
    if ((assignments?.account_ids?.length ?? 0) > 0) {
      await syncMetaInitial(businessId).catch(() => null);
    }

    // ── Redirect to frontend callback with success ──────────────
    const redirectUrl = new URL(`/integrations/callback/meta`, baseUrl);
    redirectUrl.searchParams.set("status", "success");
    redirectUrl.searchParams.set("businessId", businessId);
    redirectUrl.searchParams.set("integrationId", integration.id);

    const response = NextResponse.redirect(redirectUrl.toString());
    // Clear the state cookie
    response.cookies.set("meta_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during Meta OAuth.";
    return NextResponse.redirect(
      `${baseUrl}/integrations/callback/meta?status=error&businessId=${businessId}&error=${encodeURIComponent(
        message,
      )}`,
    );
  }
}
