import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import { getIntegration } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  upsertProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import {
  authorizeAssignmentMutation,
  validateRequestedProviderAccounts,
} from "@/lib/provider-assignment-authorization";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { syncMetaInitial } from "@/lib/sync/meta-sync";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
) {
  const { businessId } = await params;
  logRuntimeDebug("meta-assign-accounts", "request", { businessId });

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId path parameter is required.",
      },
      { status: 400 }
    );
  }

  // FIRST, before the demo check, before any integration or credential read,
  // before any database or provider work. The demo branch is not a safe place to
  // land an unauthenticated caller either: it still discloses whether a business
  // id exists and is a demo.
  const authorized = await authorizeAssignmentMutation({ request, businessId });
  if (!authorized.ok) return authorized.response;

  if (await isDemoBusiness(businessId)) {
    const body = await request.json().catch(() => null);
    const accountIds = body?.account_ids;

    if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")) {
      return NextResponse.json(
        {
          error: "invalid_payload",
          message: "account_ids must be an array of strings.",
        },
        { status: 400 }
      );
    }

    const cleaned = Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));
    return NextResponse.json({
      success: true,
      assigned_accounts: cleaned,
    });
  }

  const integration = await getIntegration(businessId, "meta");
  logRuntimeDebug("meta-assign-accounts", "integration_lookup", {
    businessId,
    found: Boolean(integration),
  });
  if (!integration) {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message: "Meta integration not found for this business.",
      },
      { status: 404 }
    );
  }

  const body = await request.json().catch(() => null);
  const accountIds = body?.account_ids;
  logRuntimeDebug("meta-assign-accounts", "payload", {
    businessId,
    accountIds,
    isArray: Array.isArray(accountIds),
  });

  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: "account_ids must be an array of strings.",
      },
      { status: 400 }
    );
  }

  const cleaned = Array.from(new Set(accountIds.map((id) => id.trim()).filter(Boolean)));

  // Membership authorises acting on THIS business; it does not authorise binding
  // an arbitrary provider account id to it. Meta previously accepted any string,
  // so a caller could have attached an account this business was never shown.
  if (cleaned.length > 0) {
    const validation = await validateRequestedProviderAccounts({
      businessId,
      provider: "meta",
      requestedIds: cleaned,
    });
    if (!validation.ok) {
      if (validation.refusal.kind === "snapshot_missing") {
        return NextResponse.json(
          {
            error: "meta_accounts_not_loaded",
            message:
              "Meta ad accounts must be loaded before assignments can be saved. Refresh the account list and try again.",
          },
          { status: 409 },
        );
      }
      console.warn("[meta-assign-accounts] rejected unknown account ids", {
        businessId,
        invalidIds: validation.refusal.invalidIds,
        snapshotCount: validation.refusal.snapshotCount,
      });
      return NextResponse.json(
        {
          error: "invalid_meta_account_selection",
          message:
            "One or more selected Meta ad accounts are no longer available. Refresh the account list and try again.",
        },
        { status: 400 },
      );
    }
  }

  const readiness = await getDbSchemaReadiness({
    tables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) {
    return NextResponse.json(
      {
        error: "schema_not_ready",
        message:
          "Meta account assignments are unavailable until request-external migrations are applied.",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      },
      { status: 503 },
    );
  }

  async function doUpsert() {
    return upsertProviderAccountAssignments({
      businessId,
      provider: "meta",
      accountIds: cleaned,
    });
  }

  let row;
  try {
    row = await doUpsert();
  } catch (firstError: unknown) {
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    console.warn("[meta-assign-accounts] db write failed", {
      businessId,
      message: firstMessage,
    });

    if (isMissingRelationError(firstError, [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES])) {
      return NextResponse.json(
        {
          error: "schema_not_ready",
          message:
            "Meta account assignments are unavailable until request-external migrations are applied.",
          missingTables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
          checkedAt: new Date().toISOString(),
        },
        { status: 503 },
      );
    }

    console.error("[meta-assign-accounts] db write failed", {
      businessId,
      message: firstMessage,
    });
    return NextResponse.json(
      {
        error: "assignment_save_failed",
        message: "Could not save Meta account assignments.",
      },
      { status: 500 }
    );
  }

  logRuntimeDebug("meta-assign-accounts", "db_write_success", {
    businessId,
    provider: "meta",
    returnedAccountIds: row.account_ids,
    updatedAt: row.updated_at,
  });

  logRuntimeDebug("meta-assign-accounts", "response", {
    businessId,
    assigned_accounts: cleaned,
  });

  await syncMetaInitial(businessId).catch(() => null);

  return NextResponse.json({
    success: true,
    assigned_accounts: cleaned,
  });
}
