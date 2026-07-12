import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  MetaHistoryQueryError,
  parseMetaHistoryQuery,
} from "@/lib/meta/history-contract";
import {
  readMetaHistoryAccounts,
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
    const accounts = await readMetaHistoryAccounts(query.businessId);
    const account = accounts.find((item) => item.id === query.providerAccountId) ?? null;
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
