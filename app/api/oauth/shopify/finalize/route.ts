import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  consumeShopifyInstallContext,
  restoreShopifyInstallContext,
} from "@/lib/shopify/install-context";
import { upsertIntegration } from "@/lib/integrations";
import { updateBusinessCurrency } from "@/lib/account-store";
import { setSessionActiveBusiness } from "@/lib/auth";
import { sanitizeNextPath } from "@/lib/auth-routing";
import { registerShopifyCustomerEventsPixel } from "@/lib/shopify/pixels";
import { registerShopifySyncWebhooks } from "@/lib/shopify/webhooks";

interface FinalizeBody {
  token?: string;
  businessId?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as FinalizeBody | null;
  const token = body?.token?.trim() ?? "";
  const businessId = body?.businessId?.trim() ?? "";

  if (!token || !businessId) {
    return NextResponse.json(
      { error: "invalid_payload", message: "token and businessId are required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  // Authorized BEFORE the claim, and the claim is single-use and actor-bound.
  // The previous shape read the context by token alone and deleted it in a
  // second statement, so two concurrent finalizers both connected the shop, and
  // anyone holding the token could bind someone else's store to a business of
  // their own.
  const claim = await consumeShopifyInstallContext({
    token,
    sessionId: access.session.sessionId,
    userId: access.session.user?.id ?? null,
  });
  if (!claim.ok) {
    return claim.reason === "not_your_context"
      ? NextResponse.json(
          {
            error: "context_not_yours",
            message:
              "This Shopify install was started by a different session. Start the install again from this account.",
          },
          { status: 403 },
        )
      : NextResponse.json(
          {
            error: "context_not_found",
            message: "Shopify install context not found or expired.",
          },
          { status: 404 },
        );
  }
  const context = claim.context;

  let integration;
  try {
    integration = await upsertIntegration({
      businessId,
      provider: "shopify",
      status: "connected",
      providerAccountId: context.shop_domain,
      providerAccountName: context.shop_name ?? context.shop_domain,
      accessToken: context.access_token,
      scopes: context.scopes ?? undefined,
      metadata: {
        ...(context.metadata ?? {}),
        shopifyProductionServingMode: "auto",
      },
    });
  } catch (error: unknown) {
    // The claim already destroyed the only copy of the shop's access token, so
    // a failure here would force a reinstall. Put it back and say so.
    await restoreShopifyInstallContext(context).catch(() => undefined);
    return NextResponse.json(
      {
        error: "integration_save_failed",
        message:
          "The Shopify connection could not be saved. The install is still valid — retry shortly.",
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  const currency =
    context.metadata && typeof context.metadata.currency === "string"
      ? context.metadata.currency
      : null;
  if (currency) {
    await updateBusinessCurrency(businessId, currency).catch(() => {});
  }

  await registerShopifySyncWebhooks({
    shopId: context.shop_domain,
    accessToken: context.access_token,
  }).catch((error) => {
    console.warn("[shopify-finalize] webhook_registration_failed", {
      businessId,
      shopId: context.shop_domain,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await registerShopifyCustomerEventsPixel({
    shopId: context.shop_domain,
    accessToken: context.access_token,
  }).catch((error) => {
    console.warn("[shopify-finalize] customer_events_pixel_registration_failed", {
      businessId,
      shopId: context.shop_domain,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  await setSessionActiveBusiness(access.session.sessionId, businessId);

  return NextResponse.json({
    status: "success",
    integration: {
      id: integration.id,
      provider: integration.provider,
      providerAccountId: integration.provider_account_id,
      providerAccountName: integration.provider_account_name,
      connectedAt: integration.connected_at,
    },
    businessId,
    returnTo: sanitizeNextPath(context.return_to) ?? "/integrations",
  });
}
