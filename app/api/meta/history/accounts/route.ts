import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
} from "@/lib/meta/history-read-model";

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
    // The same intersection the journal endpoint applies, for the same reason:
    // this list is what an account picker offers, and offering a deselected
    // account would let the operator pick a scope the journal read then refuses
    // — or, before `is_selected` was honoured, silently served.
    const [accounts, assignedAccountIds] = await Promise.all([
      readMetaHistoryAccounts(businessId),
      readMetaHistoryAssignedAccountIds(businessId),
    ]);
    const currentlyAssigned = new Set(assignedAccountIds);
    return NextResponse.json(
      {
        mode: "read_only",
        businessId,
        accounts: accounts.filter((account) => currentlyAssigned.has(account.id)),
      },
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
