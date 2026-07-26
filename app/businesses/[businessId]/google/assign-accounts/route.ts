import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import { getIntegration } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  upsertProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import { PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES } from "@/lib/provider-account-snapshots";
import {
  ASSIGNMENT_SNAPSHOT_FRESHNESS_MS,
  authorizeAssignmentMutation,
  validateRequestedProviderAccounts,
} from "@/lib/provider-assignment-authorization";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { enqueueGoogleAdsScheduledWork } from "@/lib/sync/google-ads-sync";

const GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS = ASSIGNMENT_SNAPSHOT_FRESHNESS_MS;

/**
 * POST /businesses/:businessId/google/assign-accounts
 *
 * Saves the selected Google Ads customer account assignments for a business.
 * Body: { account_ids: string[] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const { businessId } = await params;
  logRuntimeDebug("google-assign-accounts", "request", { businessId });

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId path parameter is required.",
      },
      { status: 400 },
    );
  }

  // FIRST, before the demo check, before any integration or credential read,
  // before any database or provider work. An empty selection here deselects
  // every account for the business, so even the "harmless" payload is a
  // destructive cross-tenant action without this.
  const authorized = await authorizeAssignmentMutation({ request, businessId });
  if (!authorized.ok) return authorized.response;

  if (await isDemoBusiness(businessId)) {
    const body = await request.json().catch(() => null);
    const accountIds = body?.account_ids;
    if (
      !Array.isArray(accountIds) ||
      accountIds.some((id) => typeof id !== "string")
    ) {
      return NextResponse.json(
        {
          error: "invalid_payload",
          message: "account_ids must be an array of strings.",
        },
        { status: 400 },
      );
    }

    const cleaned = Array.from(
      new Set(accountIds.map((id) => id.trim()).filter(Boolean)),
    );
    return NextResponse.json({
      success: true,
      assigned_accounts: cleaned,
    });
  }

  const integration = await getIntegration(businessId, "google");
  logRuntimeDebug("google-assign-accounts", "integration_lookup", {
    businessId,
    found: Boolean(integration),
  });
  if (!integration) {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message: "Google integration not found for this business.",
      },
      { status: 404 },
    );
  }

  const body = await request.json().catch(() => null);
  const accountIds = body?.account_ids;
  logRuntimeDebug("google-assign-accounts", "payload", {
    businessId,
    accountIds,
    isArray: Array.isArray(accountIds),
  });

  if (
    !Array.isArray(accountIds) ||
    accountIds.some((id) => typeof id !== "string")
  ) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: "account_ids must be an array of strings.",
      },
      { status: 400 },
    );
  }

  const cleaned = Array.from(
    new Set(accountIds.map((id) => id.trim()).filter(Boolean)),
  );

  const validation = await validateRequestedProviderAccounts({
    businessId,
    provider: "google",
    requestedIds: cleaned,
    freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
  });
  if (!validation.ok) {
    if (validation.refusal.kind === "snapshot_missing") {
      return NextResponse.json(
        {
          error: "google_accounts_not_loaded",
          message:
            "Google Ads accounts must be loaded before assignments can be saved. Refresh the account list and try again.",
        },
        { status: 409 }
      );
    }
    console.warn("[google-assign-accounts] rejected unknown account ids", {
      businessId,
      invalidIds: validation.refusal.invalidIds,
      snapshotCount: validation.refusal.snapshotCount,
    });
    return NextResponse.json(
      {
        error: "invalid_google_account_selection",
        message:
          "One or more selected Google Ads accounts are no longer available. Refresh the account list and try again.",
      },
      { status: 400 }
    );
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      ...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
      ...PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return NextResponse.json(
      {
        error: "schema_not_ready",
        message:
          "Google Ads account assignments are unavailable until request-external migrations are applied.",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      },
      { status: 503 },
    );
  }

  async function doUpsert() {
    return upsertProviderAccountAssignments({
      businessId,
      provider: "google",
      accountIds: cleaned,
    });
  }

  let row;
  try {
    row = await doUpsert();
  } catch (firstError: unknown) {
    const firstMessage =
      firstError instanceof Error ? firstError.message : String(firstError);
    console.warn("[google-assign-accounts] db write failed", {
      businessId,
      message: firstMessage,
    });

    if (
      isMissingRelationError(firstError, [
        ...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
        ...PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
      ])
    ) {
      return NextResponse.json(
        {
          error: "schema_not_ready",
          message:
            "Google Ads account assignments are unavailable until request-external migrations are applied.",
          missingTables: [
            ...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
            ...PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
          ],
          checkedAt: new Date().toISOString(),
        },
        { status: 503 },
      );
    }

    console.error("[google-assign-accounts] db write failed", {
      businessId,
      message: firstMessage,
    });
    return NextResponse.json(
      {
        error: "assignment_save_failed",
        message: "Could not save Google Ads account assignments.",
      },
      { status: 500 },
    );
  }

  logRuntimeDebug("google-assign-accounts", "db_write_success", {
    businessId,
    provider: "google",
    returnedAccountIds: row!.account_ids,
    updatedAt: row!.updated_at,
  });

  await enqueueGoogleAdsScheduledWork(businessId).catch(() => null);

  return NextResponse.json({
    success: true,
    assigned_accounts: cleaned,
  });
}
