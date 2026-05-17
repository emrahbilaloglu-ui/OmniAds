import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaCreativeDetailPayload } from "@/lib/meta/creatives-api";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId");
  const creativeId = params.get("creativeId")?.trim() ?? "";
  const adId = params.get("adId")?.trim() ?? "";
  const adFormat = params.get("adFormat")?.trim() ?? "";
  const adFormats = parseAdFormats(params.get("adFormats"));

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }
  if (!creativeId) {
    return NextResponse.json(
      { error: "missing_creative_id", message: "creativeId is required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({
      status: "ok",
      detail_preview: {
        creative_id: creativeId,
        mode: "unavailable",
        source: null,
        ad_format: null,
        html: null,
      },
    });
  }

  const result = await getMetaCreativeDetailPayload({
    businessId,
    creativeId,
    adId: adId || null,
    adFormat: adFormat || null,
    adFormats,
  });

  return NextResponse.json(result);
}

function parseAdFormats(value: string | null) {
  if (!value) return null;
  const formats = Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  return formats.length > 0 ? formats : null;
}
