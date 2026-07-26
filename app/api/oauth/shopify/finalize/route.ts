import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { finalizeShopifyInstall } from "@/lib/shopify/install-context";
import { updateBusinessCurrency } from "@/lib/account-store";
import { setSessionActiveBusiness } from "@/lib/auth";
import { sanitizeNextPath } from "@/lib/auth-routing";

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

  // Authorized BEFORE the claim, and the claim itself is single-use, actor-bound
  // and business-bound. The grant lifecycle lives in one place on purpose: this
  // handler must not be able to reorder the claim, the credential write and the
  // provider registrations, because the previous shape read the context by token
  // alone, deleted it in a second statement, and put a live credential back on
  // failures a retry could never fix.
  const result = await finalizeShopifyInstall({
    token,
    businessId,
    sessionId: access.session.sessionId,
    userId: access.session.user?.id ?? null,
  });

  if (!result.ok) {
    const { failure } = result;
    return NextResponse.json(
      {
        error: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        ...(failure.detail ? { detail: failure.detail } : {}),
      },
      { status: failure.httpStatus },
    );
  }

  const { context, integration } = result;
  const currency =
    context.metadata && typeof context.metadata.currency === "string"
      ? context.metadata.currency
      : null;
  if (currency) {
    await updateBusinessCurrency(businessId, currency).catch(() => {});
  }

  // Registration outcomes are reported, not thrown: the connection is already
  // durable, and a webhook or pixel that did not land is a repairable gap rather
  // than a reason to fail an install the user has completed. Refusals are logged
  // distinctly because they mean the connection MOVED mid-install, which is the
  // case where a superseded token would otherwise have been sent to Shopify.
  for (const [name, outcome] of [
    ["webhooks", result.webhooks],
    ["pixel", result.pixel],
  ] as const) {
    if (outcome.status === "failed") {
      console.warn(`[shopify-finalize] ${name}_registration_failed`, {
        businessId,
        shopId: context.shop_domain,
        error: outcome.detail,
      });
    } else if (outcome.status === "refused") {
      console.warn(`[shopify-finalize] ${name}_registration_refused`, {
        businessId,
        shopId: context.shop_domain,
        code: outcome.code,
        error: outcome.detail,
      });
    } else if (
      outcome.status === "registered" &&
      outcome.registrationRecorded === false
    ) {
      // The registration happened and nothing durable records it, so the next
      // finalize for this shop would perform it again.
      console.warn(`[shopify-finalize] ${name}_registration_unrecorded`, {
        businessId,
        shopId: context.shop_domain,
      });
    }
  }

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
    registration: {
      webhooks: result.webhooks.status,
      customerEventsPixel: result.pixel.status,
    },
    returnTo: sanitizeNextPath(context.return_to) ?? "/integrations",
  });
}
