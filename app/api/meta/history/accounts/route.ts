import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
} from "@/lib/meta/history-read-model";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import { getDemoMetaStatus } from "@/lib/demo-business";
import { getDemoProviderAccounts } from "@/lib/demo-business-support";

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

  // D071: this list is the account picker, and the picker must answer from the
  // same authority the reads behind it use. A confirmed demo workspace answers
  // from the committed demo manifest; a proven-live workspace answers from
  // persisted assignments; an unconfirmed posture withholds rather than
  // reporting "no assigned account", which would present an unverified
  // workspace as an empty one.
  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture === "demo") {
    const assigned = new Set(getDemoMetaStatus().assignedAccountIds);
    return NextResponse.json(
      {
        mode: "read_only",
        businessId,
        accounts: getDemoProviderAccounts("meta")
          .filter((account) => assigned.has(account.id))
          .map((account) => ({
            id: account.id,
            name: account.name,
            currency: account.currency,
            timezone: account.timezone,
          })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (posture !== "live") return metaPostureUnavailable("meta_history_accounts");

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
