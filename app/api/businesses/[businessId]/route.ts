import { NextRequest, NextResponse } from "next/server";
import { updateBusinessSettings } from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { BusinessDeletionError, deleteBusinessWithData } from "@/lib/business-deletion";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { isDemoBusinessId } from "@/lib/demo-business";
import { resolveRequestLanguage } from "@/lib/request-language";

const BUSINESS_DELETE_REQUIRED_TABLES = [
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
    await deleteBusinessWithData(businessId);
  } catch (error) {
    if (error instanceof BusinessDeletionError) {
      const tr = language === "tr";
      const messages = {
        not_found: tr ? "İşletme bulunamadı." : "Business not found.",
        protected_history: tr
          ? "Bu işletmede silinmeye karşı korumalı karar veya reklam işlem geçmişi var. Hiçbir veri silinmedi. Kontrollü veri kaldırma gerekiyor."
          : "This business has protected decision or ad action history. No data was deleted. A controlled offboarding is required.",
        schema_not_ready: tr
          ? "İşletmenin tüm verileri güvenle kaldırılamıyor. Hiçbir veri silinmedi. Destek ile iletişime geçin."
          : "The business data cannot be safely removed with the current schema. No data was deleted. Contact support.",
        scope_conflict: tr
          ? "İşletme verilerindeki sahiplik uyuşmazlığı silmeyi engelliyor. Hiçbir veri silinmedi. Destek ile iletişime geçin."
          : "Conflicting business ownership prevents deletion. No data was deleted. Contact support.",
        business_busy: tr
          ? "Bu işletme için aktif veri işi veya kilit kaydı var. Hiçbir veri silinmedi. İşin kapandığı doğrulandıktan sonra yeniden deneyin."
          : "An active data job or lease record prevents deletion. No data was deleted. Try again after the job is confirmed closed.",
      };
      return NextResponse.json({ error: error.code, message: messages[error.code] }, {
        status: error.code === "not_found" ? 404 : error.code === "schema_not_ready" ? 503 : 409,
      });
    }
    console.error("[businesses DELETE] failed", error);
    return NextResponse.json({ error: "delete_failed", message: language === "tr"
      ? "İşletme silme sonucu doğrulanamadı. Listeyi yenileyerek işletmenin durumunu kontrol edin."
      : "Business deletion could not be confirmed. Refresh the business list to check its status." }, { status: 503 });
  }

  return NextResponse.json({ status: "ok" });
}
