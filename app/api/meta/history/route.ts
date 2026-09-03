import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  MetaHistoryQueryError,
  parseMetaHistoryQuery,
} from "@/lib/meta/history-contract";
import { readMetaAssignedAccountStates } from "@/lib/meta/assigned-account-states";
import {
  readMetaHistoryAccounts,
  readMetaHistoryAssignedAccountIds,
  readMetaHistoryJournal,
} from "@/lib/meta/history-read-model";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import { META_FAILURES } from "@/lib/meta/read-state-contract";
import { getDemoMetaStatus } from "@/lib/demo-business";
import { getDemoProviderAccounts } from "@/lib/demo-business-support";

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

  // D071: the journal answers from the same authority as the picker in front of
  // it, so an account the picker offers is never refused here.
  const posture = await readMetaBusinessDataPosture(query.businessId);
  if (posture === "demo") {
    const assigned = new Set(getDemoMetaStatus().assignedAccountIds);
    const account = getDemoProviderAccounts("meta").find(
      (item) => item.id === query.providerAccountId && assigned.has(item.id),
    );
    // An unassigned demo catalog account is refused exactly as an unassigned
    // live account is.
    if (!account) {
      return jsonError(
        404,
        "provider_account_not_assigned",
        "providerAccountId is not assigned to this business.",
      );
    }
    // The committed demo fixture is a decision inventory. It records no
    // provider actions, and inventing entries, actors, outcomes or timestamps
    // is forbidden. Zero entries are therefore returned *with* an explicit
    // limitation rather than as an ordinary empty journal.
    return NextResponse.json(
      {
        mode: "read_only",
        scope: {
          businessId: query.businessId,
          providerAccountId: account.id,
          providerAccountName: account.name,
          currency: account.currency,
          timezone: account.timezone,
        },
        filters: {
          businessId: query.businessId,
          providerAccountId: account.id,
          kind: query.kind,
          entity: query.entity,
          label: query.label,
          outcome: query.outcome,
          from: query.from,
          to: query.to,
          q: query.q,
        },
        entries: [],
        page: {
          limit: query.limit,
          returned: 0,
          // Null, not 0: this read counted nothing, so it states no exact
          // total. A 0 here would be the proven-zero claim the limitation
          // below exists to deny.
          total: null,
          nextCursor: null,
        },
        identityContract: {
          canonicalDecisionIdAvailable: false,
          grouping: "persisted_source_rows",
          limitation:
            "The demo workspace serves a committed decision fixture and records no provider-action journal.",
        },
        limitations: [
          {
            code: "demo_journal_not_recorded",
            // Single source. The code is registered in the shared failure
            // dictionary, so its operator sentence comes from there too — a
            // local copy would drift the moment either side is edited.
            message: META_FAILURES.demo_journal_not_recorded.message,
          },
        ],
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (posture !== "live") return metaPostureUnavailable("meta_history");

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
    const [accounts, assignedAccountIds, accountStates] = await Promise.all([
      readMetaHistoryAccounts(query.businessId),
      readMetaHistoryAssignedAccountIds(query.businessId),
      readMetaAssignedAccountStates(query.businessId).catch(() => null),
    ]);
    const currentlyAssigned = new Set(assignedAccountIds);
    const selectedAccount =
      accounts.find(
        (item) =>
          item.id === query.providerAccountId && currentlyAssigned.has(item.id),
      ) ?? null;
    // D078 R4: an assigned-but-DESELECTED account is a legitimate read-only
    // historical evidence scope for this journal — it may hold spend and
    // produced decisions no other surface can show. It remains forbidden as
    // any write/mutation scope (this endpoint performs none), and an id that
    // was never assigned to this business still 404s indistinguishably.
    // C2.3: when the requested scope is not a selected account AND the
    // account-state authority read FAILED, absence is UNPROVEN — answer
    // fail-closed unavailable instead of a confident "not assigned" 404.
    if (selectedAccount === null && accountStates === null) {
      return jsonError(
        503,
        "meta_history_account_scope_unavailable",
        "The assigned-account authority read failed; whether this account is bound to the business is unknown right now.",
      );
    }
    const historicalState =
      selectedAccount === null
        ? ((accountStates ?? []).find(
            (state) =>
              state.providerAccountId === query.providerAccountId &&
              state.selectionState === "deselected_historical",
          ) ?? null)
        : null;
    const account =
      selectedAccount ??
      (historicalState
        ? {
            id: historicalState.providerAccountId,
            name: historicalState.accountName,
            currency: historicalState.accountCurrency,
            timezone: historicalState.accountTimezone,
          }
        : null);
    if (!account) {
      return jsonError(
        404,
        "provider_account_not_assigned",
        "providerAccountId is not assigned to this business.",
      );
    }

    const payload = await readMetaHistoryJournal({ query, account });
    return NextResponse.json(
      {
        ...payload,
        accountScope: selectedAccount ? "selected" : "deselected_historical",
      },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
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
