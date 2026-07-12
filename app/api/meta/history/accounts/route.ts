import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { readMetaHistoryAccounts } from "@/lib/meta/history-read-model";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) {
    return NextResponse.json(
      {
        error: {
          code: "missing_business_id",
          message: "businessId is required.",
        },
      },
      {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  try {
    const accounts = await readMetaHistoryAccounts(businessId);
    return NextResponse.json(
      { mode: "read_only", businessId, accounts },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[meta-history] account scope read failed", {
      businessId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: {
          code: "meta_history_accounts_unavailable",
          message: "Assigned Meta accounts are unavailable right now.",
        },
      },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
