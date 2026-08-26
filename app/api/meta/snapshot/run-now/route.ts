import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { requestMetaSnapshotRefreshForBusiness } from "@/lib/meta/snapshot-refresh";

export const dynamic = "force-dynamic";

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { businessId?: unknown } | null;
  const businessId =
    stringValue(body?.businessId) ||
    stringValue(request.nextUrl.searchParams.get("businessId"));

  if (!businessId) {
    return NextResponse.json(
      { ok: false, error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "snapshot_refresh");
  if (reviewerBlocked) return reviewerBlocked;
  /*
   * Demo authority, before the first side effect of any kind.
   *
   * `requestMetaSnapshotRefreshForBusiness` stamps a five-minute in-process
   * cooldown BEFORE it runs anything, and what it then runs opens a
   * calibration transaction and upserts snapshot rows. So the refusal has to
   * sit here, above the call, not inside it.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "snapshot_refresh",
  );
  if (demoBlocked) return demoBlocked;

  const refresh = await requestMetaSnapshotRefreshForBusiness({
    businessId: access.membership.businessId,
    reason: "manual",
  });

  return NextResponse.json(
    refresh,
    {
      status: refresh.ok ? 200 : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
