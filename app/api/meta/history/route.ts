import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  MetaHistoryQueryError,
  parseMetaHistoryQuery,
} from "@/lib/meta/history-contract";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
  readMetaHistoryJournal,
} from "@/lib/meta/history-read-model";

export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

export async function GET(request: NextRequest) {
  let query;
  try {
    query = parseMetaHistoryQuery(request.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof MetaHistoryQueryError) {
      return jsonError(400, error.code, error.message);
    }
    throw error;
  }

  const access = await requireBusinessAccess({
    request,
    businessId: query.businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  try {
    // `providerAccountId` arrives from the caller, so it is a REQUEST, never an
    // authority. It is answered here against the business's current assignment,
    // and against it twice:
    //
    //  - `readMetaHistoryAssignedAccountIds` is the canonical guard every other
    //    surface resolves scope through (`business_provider_accounts` filtered
    //    by `is_selected`);
    //  - `readMetaHistoryAccounts` is History's own projection, which carries
    //    the name/currency/timezone the response has to state.
    //
    // Only the intersection is served. A previously assigned account that has
    // since been deselected fails the guard even if some warehouse row still
    // names it, and an id belonging to another business is absent from both
    // because both are scoped by `businessId`. Neither read is caught here: a
    // failure falls through to the unavailable branch below rather than being
    // read as "nothing is assigned", which would answer a broken read with a
    // confident refusal.
    const [accounts, assignedAccountIds] = await Promise.all([
      readMetaHistoryAccounts(query.businessId),
      readMetaHistoryAssignedAccountIds(query.businessId),
    ]);
    const currentlyAssigned = new Set(assignedAccountIds);
    const account =
      accounts.find(
        (item) =>
          item.id === query.providerAccountId && currentlyAssigned.has(item.id),
      ) ?? null;
    if (!account) {
      return jsonError(
        404,
        "provider_account_not_assigned",
        "providerAccountId is not assigned to this business.",
      );
    }

    const payload = await readMetaHistoryJournal({ query, account });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[meta-history] read failed", {
      businessId: query.businessId,
      providerAccountId: query.providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(
      500,
      "meta_history_unavailable",
      "The persisted Meta journal is unavailable right now.",
    );
  }
}
