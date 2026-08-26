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
  const body = (await request.json().catch(() => null)) as {
    businessId?: unknown;
    providerAccountId?: unknown;
  } | null;
  const businessId =
    stringValue(body?.businessId) ||
    stringValue(request.nextUrl.searchParams.get("businessId"));
  /*
   * The account the operator is looking at, when the surface names one.
   *
   * A selected-account control that refreshed the whole business would compute
   * every assigned account on a click about one of them, and the operator would
   * wait on work they did not ask for. Omitted still orchestrates every
   * assigned account — each computed and persisted independently (D-M011), so
   * neither shape produces pooled truth. An account this workspace no longer
   * holds is refused by `runMetaSnapshotForBusiness` rather than computed.
   */
  const providerAccountId =
    stringValue(body?.providerAccountId) ||
    stringValue(request.nextUrl.searchParams.get("providerAccountId")) ||
    null;

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
    providerAccountId,
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
