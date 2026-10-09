import { NextRequest, NextResponse } from "next/server";
import { updateBusinessSettings } from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { BusinessDeletionError } from "@/lib/business-deletion";
import { businessDeletionFailureMessage, enqueueBusinessDeletion } from "@/lib/business-deletion-jobs";
import { issueBusinessDeletionTicket } from "@/lib/business-deletion-ticket";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { isDemoBusinessId } from "@/lib/demo-business";
import { resolveRequestLanguage } from "@/lib/request-language";

const BUSINESS_DELETE_REQUIRED_TABLES = [
  "business_deletion_jobs",
  "memberships",
  "invites",
  "business_cost_models",
  "business_provider_accounts",
  "provider_connections",
  "provider_account_snapshot_runs",
  "creative_share_snapshots",
  "businesses",
  "sessions",
] as const;

interface UpdateBusinessBody {
  name?: string;
  timezone?: string;
  currency?: string;
}

/**
 * ISO 4217 alphabetic codes only — the same shape every currency reader in this
 * repo enforces (`normalizeCurrencyCode`, `normalizeReportCurrency`,
 * `lib/google-ads/account-scope.ts:32`, …). A stored non-code reaches
 * `Intl.NumberFormat`, which throws a RangeError rather than rendering the
 * missing value, so the write is the place to refuse it.
 */
const ISO_4217_ALPHABETIC = /^[A-Z]{3}$/;

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ businessId: string }> }
) {
  const language = await resolveRequestLanguage(request);
  const { businessId } = await context.params;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: language === "tr" ? "businessId path parametresi zorunludur." : "businessId path parameter is required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "admin",
  });
  if ("error" in access) return access.error;
  if (isDemoBusinessId(businessId)) {
    return NextResponse.json(
      { error: "forbidden", message: language === "tr" ? "Demo business ayarlari degistirilemez." : "Demo business settings cannot be changed." },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => null)) as UpdateBusinessBody | null;
  const name = body?.name?.trim() ?? "";
  const currency = body?.currency?.trim().toUpperCase() ?? "";
  if (typeof body?.timezone === "string" && body.timezone.trim().length > 0) {
    console.warn("[businesses] deprecated_timezone_input_ignored", {
      route: "update_business",
      businessId,
    });
  }

  if (name.length < 2 || !currency) {
    return NextResponse.json(
      { error: "invalid_payload", message: language === "tr" ? "Ad ve currency zorunludur." : "Name and currency are required." },
      { status: 400 }
    );
  }
  if (!ISO_4217_ALPHABETIC.test(currency)) {
    return NextResponse.json(
      {
        error: "invalid_currency",
        message:
          language === "tr"
            ? "Currency üç harfli bir ISO 4217 kodu olmalidir."
            : "Currency must be a three-letter ISO 4217 code.",
      },
      { status: 400 }
    );
  }

  const business = await updateBusinessSettings({
    businessId,
    name,
    currency,
  });
  return NextResponse.json({ business });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ businessId: string }> }
) {
  const language = await resolveRequestLanguage(request);
  const { businessId } = await context.params;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: language === "tr" ? "businessId path parametresi zorunludur." : "businessId path parameter is required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "admin",
  });
  if ("error" in access) return access.error;
  if (isDemoBusinessId(businessId)) {
    return NextResponse.json(
      { error: "forbidden", message: language === "tr" ? "Demo business silinemez." : "Demo business cannot be deleted." },
      { status: 403 }
    );
  }

  const readiness = await getDbSchemaReadiness({
    tables: [...BUSINESS_DELETE_REQUIRED_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) {
    return NextResponse.json(
      {
        error: "schema_not_ready",
        message:
          language === "tr"
            ? "Business silme işlemi için DB şeması hazır değil. `npm run db:migrate` çalıştırın."
            : "Database schema is not ready for business deletion. Run `npm run db:migrate`.",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      },
      { status: 503 },
    );
  }
  // Business deletion removes `business_provider_accounts` outright — the widest
  // possible selection mutation — and it did so outside every switch and every
  // lock. It therefore belongs to the same lane as ordinary selection changes,
  // so a quiesced cutover cannot have canonical bindings deleted underneath it.
  try {
    assertSyncLaneEnabled("assignment_mutation");
  } catch (error) {
    return NextResponse.json(
      {
        error: "lane_disabled",
        message:
          language === "tr"
            ? "Business silme işlemi şu anda devre dışı."
            : "Business deletion is currently disabled.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  try {
    const monitorTicket = issueBusinessDeletionTicket(request.cookies.get("omniads_session")?.value ?? "", businessId, access.session.sessionId);
    const job = await enqueueBusinessDeletion(businessId);
    return NextResponse.json({ status: job.status, monitorTicket }, { status: 202 });
  } catch (error) {
    if (error instanceof BusinessDeletionError) return NextResponse.json({ error: error.code,
      message: businessDeletionFailureMessage(error.code, language === "tr", error.tables) }, {
      status: error.code === "not_found" ? 404 : error.code === "schema_not_ready" ? 503 : 409,
    });
    console.error("[businesses DELETE] enqueue failed");
    return NextResponse.json({ error: "delete_failed", message: businessDeletionFailureMessage("delete_failed", language === "tr") }, { status: 503 });
  }
}
