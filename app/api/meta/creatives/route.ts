import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import type { FormatFilter, GroupBy, SortKey } from "@/lib/meta/creatives-types";
export type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { toISODate, nDaysAgo } from "@/lib/meta/creatives-row-mappers";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { logPerfEvent } from "@/lib/perf";

function getDateSpanDays(start: string, end: string) {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

export async function GET(request: NextRequest) {
  const requestStartedAt = Date.now();
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId");
  const detailPreviewCreativeId = params.get("detailPreviewCreativeId")?.trim() ?? "";
  const mediaMode = params.get("mediaMode") === "metadata" ? "metadata" : "full";
  const enableFullMediaHydration = mediaMode === "full";
  const groupBy = (params.get("groupBy") as GroupBy | null) ?? "creative";
  const format = (params.get("format") as FormatFilter | null) ?? "all";
  const sort = (params.get("sort") as SortKey | null) ?? "roas";
  const start = params.get("start") ?? toISODate(nDaysAgo(29));
  const end = params.get("end") ?? toISODate(new Date());
  const debugPreview = params.get("debugPreview") === "1";
  const debugThumbnail = params.get("debugThumbnail") === "1";
  const debugPerf = params.get("debugPerf") === "1";
  const snapshotBypass = params.get("snapshotBypass") === "1";
  const snapshotWarm = params.get("snapshotWarm") === "1";
  const enableCopyRecovery =
    enableFullMediaHydration || params.get("copyRecovery") === "1";
  const enableCreativeBasicsFallback = enableFullMediaHydration && params.get("creativeBasicsFallback") !== "0";
  const enableCreativeDetails = enableFullMediaHydration && params.get("creativeDetails") !== "0";
  const enableThumbnailBackfill = params.get("thumbnailBackfill") !== "0";
  const enableCardThumbnailBackfill = params.get("cardThumbnailBackfill") !== "0";
  const enableImageHashLookup =
    enableFullMediaHydration && (debugPreview || debugThumbnail || params.get("imageHashLookup") === "1");
  const enableMediaRecovery =
    enableFullMediaHydration && (debugPreview || debugThumbnail || params.get("recoverMedia") === "1");
  const enableMediaCache = params.get("mediaCache") !== "0";
  const enableDeepAudit = enableFullMediaHydration && (debugPreview || debugPerf);
  const previewSampleLimit = Number(params.get("previewSampleLimit") ?? "5");
  const perAccountSampleLimit =
    Number.isFinite(previewSampleLimit) && previewSampleLimit > 0
      ? Math.min(25, Math.max(1, Math.floor(previewSampleLimit)))
      : 10;

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }
  if (detailPreviewCreativeId) {
    return NextResponse.json(
      {
        error: "detail_preview_moved",
        message: "Use /api/meta/creatives/detail for creative detail preview requests.",
      },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoMetaCreatives());
  }

  const result = await getMetaCreativesApiPayload({
    request,
    requestStartedAt,
    businessId,
    mediaMode,
    groupBy,
    format,
    sort,
    start,
    end,
    debugPreview,
    debugThumbnail,
    debugPerf,
    snapshotBypass,
    snapshotWarm,
    enableCopyRecovery,
    enableCreativeBasicsFallback,
    enableCreativeDetails,
    enableThumbnailBackfill,
    enableCardThumbnailBackfill,
    enableImageHashLookup,
    enableMediaRecovery,
    enableMediaCache,
    enableDeepAudit,
    perAccountSampleLimit,
  });
  logPerfEvent("meta_creatives_route", {
    businessId,
    start,
    end,
    dateSpanDays: getDateSpanDays(start, end),
    groupBy,
    format,
    sort,
    mediaMode,
    rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
    readSource:
      "readSource" in result && typeof result.readSource === "string"
        ? result.readSource
        : "snapshot_source" in result && typeof result.snapshot_source === "string"
          ? result.snapshot_source
          : "live",
    freshnessState:
      "freshness_state" in result && typeof result.freshness_state === "string"
        ? result.freshness_state
        : null,
    durationMs: Date.now() - requestStartedAt,
  });
  return NextResponse.json(result);
}
