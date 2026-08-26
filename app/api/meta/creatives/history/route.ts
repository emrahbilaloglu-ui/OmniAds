import { NextRequest, NextResponse } from "next/server";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import type { FormatFilter, GroupBy, SortKey } from "@/lib/meta/creatives-types";
import { toISODate, nDaysAgo } from "@/lib/meta/creatives-row-mappers";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";

export async function GET(request: NextRequest) {
  const requestStartedAt = Date.now();
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId");
  const mediaMode = params.get("mediaMode") === "full" ? "full" : "metadata";
  const groupBy = (params.get("groupBy") as GroupBy | null) ?? "creative";
  const format = (params.get("format") as FormatFilter | null) ?? "all";
  const sort = (params.get("sort") as SortKey | null) ?? "roas";
  const start = params.get("start") ?? toISODate(nDaysAgo(29));
  const end = params.get("end") ?? toISODate(new Date());

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture !== "live" && posture !== "demo") {
    return metaPostureUnavailable("meta_creative_history");
  }
  if (posture === "demo") {
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
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 10,
  });

  return NextResponse.json(result);
}
