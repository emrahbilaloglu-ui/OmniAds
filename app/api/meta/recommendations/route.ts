import { NextRequest, NextResponse } from "next/server";
import { DEMO_META_PROVIDER_ACCOUNT_ID } from "@/lib/demo-business-support";
import { requireBusinessAccess } from "@/lib/access";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import { getDemoMetaBreakdowns, getDemoMetaCampaigns } from "@/lib/demo-business";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  readMetaDecisionSnapshotForRange as readLatestMetaDecisionSnapshot,
} from "@/lib/meta/snapshot";
import {
  buildMetaRecommendations,
  type MetaRecommendationAnalysisSource,
  type MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";
import { readMetaBidRegimeHistorySummaries } from "@/lib/meta/config-snapshots";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { resolveRequestLanguage } from "@/lib/request-language";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import { readMetaCommercialTargets } from "@/lib/meta/commercial-targets";
import { computeMetaAttributedAov } from "@/lib/creative-decision-engine/meta-aov-calculator";
import { getDb } from "@/lib/db";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { attachMetaEmpiricalOutcomeSummariesFromLogs } from "@/lib/meta/empirical-outcome-integration";
import { sameMetaAccount } from "@/lib/meta/provider-account-param";

// Intentional exception: recommendations keep snapshot-backed historical
// config regime analysis across multi-window history. This is not a normal
// campaign/adset historical UI serving path.

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function attachAnalysisSource(
  payload: MetaRecommendationsResponse,
  input: {
    businessId: string;
    startDate: string;
    endDate: string;
    analysisSource: MetaRecommendationAnalysisSource;
    sourceModel: MetaRecommendationsResponse["sourceModel"];
  },
): MetaRecommendationsResponse {
  return {
    ...payload,
    businessId: payload.businessId ?? input.businessId,
    startDate: payload.startDate ?? input.startDate,
    endDate: payload.endDate ?? input.endDate,
    sourceModel: payload.sourceModel ?? input.sourceModel,
    analysisSource: input.analysisSource,
  };
}

function emptyPersistentSnapshotPayload(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): MetaRecommendationsResponse {
  return {
    status: "ok",
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    summary: {
      title: "No persisted Meta recommendation snapshot",
      summary: "No daily Meta decision snapshot rows were found for the selected range.",
      primaryLens: "structure",
      confidence: "low",
      recommendationCount: 0,
    },
    recommendations: [],
    sourceModel: "snapshot_persistent",
    analysisSource: {
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_snapshot_empty",
    },
  };
}

/**
 * The sentinel a REJECTED assignments read resolves to.
 *
 * A unique object rather than `null`, because `getProviderAccountAssignments`
 * legitimately answers `null` for a business with no assignment row — and
 * collapsing "there is no row" into "the query failed" is exactly the
 * conflation this route used to make in the other direction.
 */
const METAremoteAssignmentsUnreadable = Symbol(
  "meta_account_assignments_unreadable",
) as unknown as Awaited<ReturnType<typeof getProviderAccountAssignments>>;

/**
 * The demo scope, taken from the product's own demo manifest.
 *
 * ── ROUND 9 ITEM 9 ─────────────────────────────────────────────────────────
 * This file used to invent `demo:meta-account`. That was wrong in the direction
 * that matters: the demo workspace already HAS an authorized Meta account id —
 * `act_210009998877`, "UrbanTrail DTC" — and it is what
 * `getDemoIntegrations()`, `listDemoProviderAccounts()`, the demo business
 * summary and `getDemoMetaBreakdowns()` all publish. A demo request naming the
 * id the demo UI itself displays was therefore refused by this route.
 *
 * Imported rather than re-typed, so the two cannot drift apart again.
 */
const DEMO_META_PROVIDER_ACCOUNT_SCOPE = DEMO_META_PROVIDER_ACCOUNT_ID;

/**
 * Serve the demo recommendations under the demo-only scope.
 *
 * Extracted so it can run BEFORE the production assignment read rather than
 * after it. An explicitly requested account is echoed back as a refusal rather
 * than silently ignored: a caller naming `act_…` against a demo business is
 * asking for production data, and answering with demo rows under that id would
 * be the surface asserting a scope it does not have.
 */
function serveDemoMetaRecommendations(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  language: Parameters<typeof buildMetaRecommendations>[0]["language"];
  requestedProviderAccountId: string | null;
}) {
  if (
    input.requestedProviderAccountId &&
    input.requestedProviderAccountId !== DEMO_META_PROVIDER_ACCOUNT_SCOPE
  ) {
    return NextResponse.json(
      {
        error: "meta_account_not_assigned",
        message:
          "This business is in demo mode, so no provider ad account can be scoped.",
      },
      { status: 400 },
    );
  }
  const demoCampaigns = getDemoMetaCampaigns().rows as MetaCampaignRow[];
  const demoBreakdowns = getDemoMetaBreakdowns() as MetaBreakdownsResponse;
  return NextResponse.json(
    attachAnalysisSource(
      buildMetaRecommendations({
        windows: {
          selected: demoCampaigns,
          previousSelected: demoCampaigns,
          last3: demoCampaigns,
          last7: demoCampaigns,
          last14: demoCampaigns,
          last30: demoCampaigns,
          last90: demoCampaigns,
          allHistory: demoCampaigns,
        },
        breakdowns: demoBreakdowns,
        language: input.language,
      }),
      {
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        sourceModel: "snapshot_live",
        analysisSource: {
          system: "demo",
          decisionOsAvailable: false,
        },
      },
    ),
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const language = await resolveRequestLanguage(request);
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const live = searchParams.get("live") === "1";
  /*
    THE ACCOUNT SCOPE IS AN INPUT, NOT AN INFERENCE.

    This route never read one. Every campaign window was loaded for the whole
    business, the breakdowns with it, and the Meta-attributed AOV was computed
    only when the business happened to have exactly one assigned account —
    which meant a two-account business got windows pooled across both accounts
    and no canonical unit at all, while a one-account business got a unit
    resolved against a pooled window. Money-per-purchase is an ACCOUNT fact;
    pooling two accounts' purchases into one average is inventing a third
    account that does not exist.

    `accountId` is accepted as an alias because the sibling Meta reads
    (`/api/meta/campaigns`, `/api/meta/breakdowns`) already spell it that way.
  */
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() ||
    searchParams.get("accountId")?.trim() ||
    null;

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (!businessId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId, startDate and endDate are required." },
      { status: 400 }
    );
  }

  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture !== "live" && posture !== "demo") {
    return metaPostureUnavailable("meta_recommendations");
  }
  /*
    THE SCOPE IS RESOLVED BEFORE THE MODE BRANCH, NOT INSIDE ONE.

    This block sat AFTER the demo and persisted-snapshot returns, so only the
    live path was ever scoped: `?live=1` absent meant
    `readLatestMetaDecisionSnapshot` ran with no `providerAccountId` and served
    another account's persisted rows to a caller who had named one — and an
    unassigned or ambiguous account was never refused at all on that path. The
    validation is the same for every mode because the question is the same:
    WHICH account is this answer about.

    Fail closed. An account this business has not selected is refused rather
    than ignored; an omitted account is accepted ONLY when exactly one
    assignment exists, which is the unambiguous legacy caller. Zero or several
    with no explicit choice is refused: picking one would attribute another
    account's spend, windows and purchase sample to this answer, and pooling
    them would report an average belonging to no account at all.
  */
  /*
    ── DEMO IS SCOPED BY MANIFEST, NOT BY A PRODUCTION LOOKUP ────────────────

    The demo branch used to sit BELOW this block, so a demo business was made
    to pass production assignment validation before it could be served: it was
    refused with `meta_account_scope_required` ("No Meta ad account is selected
    for this business") unless a real provider account happened to be assigned
    to it. That is wrong in both directions — a demo answer must not depend on
    production data, and a production account must not be borrowed to scope one.

    So demo resolves its own deterministic scope from a constant manifest, and
    returns before `getProviderAccountAssignments` is ever called. The
    assignments table is not queried for a demo business, so nothing about a
    real account can reach a demo answer.
  */
  if (posture === "demo") {
    return serveDemoMetaRecommendations({
      businessId,
      startDate,
      endDate,
      language,
      requestedProviderAccountId,
    });
  }

  const metaAccountAssignments = await getProviderAccountAssignments(
    businessId,
    "meta",
  ).catch(() => METAremoteAssignmentsUnreadable);
  /*
    UNREADABLE IS NOT EMPTY.

    A rejected assignments read used to collapse to `null` and then to an empty
    id list, which produced a 400 saying "No Meta ad account is selected for
    this business" — a database failure presented to an operator as a settled
    fact about their configuration, and to a caller as a request error they
    could fix by choosing an account. They cannot: nothing about the request
    was wrong.

    A read this process could not complete is a 503 with its own code, so the
    caller can retry and the operator is not sent to a settings page to fix
    something that is not broken.
  */
  if (metaAccountAssignments === METAremoteAssignmentsUnreadable) {
    return NextResponse.json(
      {
        error: "meta_account_scope_unavailable",
        message:
          "Meta ad account assignments could not be read, so this answer cannot be scoped to an account.",
      },
      { status: 503 },
    );
  }
  const assignedAccountIds = metaAccountAssignments?.account_ids ?? [];
  let providerAccountId: string;
  if (requestedProviderAccountId) {
    const assignedAccountId = assignedAccountIds.find((candidate) =>
      sameMetaAccount(candidate, requestedProviderAccountId),
    );
    if (!assignedAccountId) {
      return NextResponse.json(
        {
          error: "meta_account_not_assigned",
          message:
            "The requested providerAccountId is not a selected Meta account for this business.",
        },
        { status: 400 },
      );
    }
    // Keep the assignment catalog's spelling. Meta returns both `act_123` and
    // `123`, but downstream cache keys and scoped reads must agree on the id
    // this business actually selected.
    providerAccountId = assignedAccountId;
  } else if (assignedAccountIds.length === 1) {
    providerAccountId = assignedAccountIds[0]!;
  } else {
    return NextResponse.json(
      {
        error: "meta_account_scope_required",
        message:
          assignedAccountIds.length === 0
            ? "No Meta ad account is selected for this business, so no account-scoped recommendation can be produced."
            : "This business has more than one selected Meta ad account; pass providerAccountId to choose the scope.",
        assignedAccountCount: assignedAccountIds.length,
      },
      { status: 400 },
    );
  }

  if (!live) {
    const snapshotPayload = await readLatestMetaDecisionSnapshot({
      businessId,
      // The account this answer is about. Without it the reader served every
      // account's persisted rows to a caller who had named one, and the
      // commercial guard inside it had no account-scoped Meta sample to hold
      // against — so a persisted `act` was re-served unguarded.
      providerAccountId,
      startDate,
      endDate,
    });
    if (snapshotPayload) {
      return NextResponse.json(snapshotPayload);
    }
    return NextResponse.json(
      emptyPersistentSnapshotPayload({ businessId, startDate, endDate }),
    );
  }

  const selectedSpanDays = dayDiffInclusive(startDate, endDate);
  const previousEnd = addDaysToISO(startDate, -1);
  const previousStart = addDaysToISO(previousEnd, -(selectedSpanDays - 1));
  const last3Start = addDaysToISO(endDate, -2);
  const last7Start = addDaysToISO(endDate, -6);
  const last14Start = addDaysToISO(endDate, -13);
  const last30Start = addDaysToISO(endDate, -29);
  const last90Start = addDaysToISO(endDate, -89);
  const allHistoryStart = addDaysToISO(endDate, -(META_WAREHOUSE_HISTORY_DAYS - 1));

  const baseParams = new URLSearchParams({ businessId });

  const [
    selectedCampaigns,
    previousSelectedCampaigns,
    last3Campaigns,
    last7Campaigns,
    last14Campaigns,
    last30Campaigns,
    last90Campaigns,
    allHistoryCampaigns,
    breakdowns,
    commercialTargetsBase,
  ] = await Promise.all([
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate,
      endDate,
      includePrev: true,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: previousStart,
      endDate: previousEnd,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: last3Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: last7Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: last14Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: last30Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: last90Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      accountId: providerAccountId,
      startDate: allHistoryStart,
      endDate,
    }),
    getMetaBreakdownsForRange({
      businessId,
      providerAccountId,
      startDate,
      endDate,
    }),
    /*
      TARGETS AS OF THE SAME CUTOFF THE WINDOWS CLOSE ON.

      This was `readMetaCommercialTargets(businessId)` — no `asOf` — so the
      ratios were read at WALL CLOCK while the AOV beside them was read as of
      `endDate`. A pack saved after the window closed then divided a purchase
      value the decision could not have seen, and the freshness stamp described
      "now" rather than the moment being decided.
    */
    readMetaCommercialTargets(businessId, { asOf: endDate }).catch(() => null),
  ]);

  /*
    ONE ACCOUNT, ONE CUTOFF — the same pair every window above was read with.

    Read only when a positive Target ROAS exists, because that is the only case
    in which the AOV is an authoritative input: without a ratio there is
    nothing to divide, and reading it anyway would put a number on the pack
    that nothing may use.
  */
  const metaAttributedAov = commercialTargetsBase?.targetRoas
    ? await computeMetaAttributedAov({
      businessId,
      asOf: endDate,
      providerAccountId,
      db: getDb(),
    }).catch(() => null)
    : null;
  const commercialTargets = commercialTargetsBase
    ? {
      ...commercialTargetsBase,
      metaAttributedAov: metaAttributedAov
        ? {
          aovMean: metaAttributedAov.aovMean,
          purchaseCount: metaAttributedAov.purchaseCount,
        }
        : null,
    }
    : commercialTargetsBase;

  const payload = attachAnalysisSource(
    buildMetaRecommendations({
      windows: {
        selected: selectedCampaigns.rows ?? [],
        previousSelected: previousSelectedCampaigns.rows ?? [],
        last3: last3Campaigns.rows ?? [],
        last7: last7Campaigns.rows ?? [],
        last14: last14Campaigns.rows ?? [],
        last30: last30Campaigns.rows ?? [],
        last90: last90Campaigns.rows ?? [],
        allHistory: allHistoryCampaigns.rows ?? [],
      },
      breakdowns,
      historicalBidRegimes: Object.fromEntries(
        (
          await readMetaBidRegimeHistorySummaries({
            businessId,
            /*
              ROUND 9 ITEM 6. The same account and the same cutoff every window
              above was read with. This history raises confidence and can carry
              a recommendation into the act lane, so reading it business-wide or
              past the served window built a high-confidence action out of
              evidence that belongs to another account or to a later day.
            */
            providerAccountId,
            capturedAtCutoff: endDate,
            entityLevel: "campaign",
            entityIds: (selectedCampaigns.rows ?? []).map((row) => row.id),
          })
        ).entries()
      ),
      commercialTargets,
      language,
    }),
    {
      businessId,
      startDate,
      endDate,
      sourceModel: "snapshot_live",
      analysisSource: {
        system: "snapshot_live",
        decisionOsAvailable: false,
        fallbackReason: "meta_engine_v1_live_debug",
      },
    },
  );

  const recommendations = await attachMetaEmpiricalOutcomeSummariesFromLogs({
    businessId,
    /*
      The same account every window above was read with. Pooling outcome
      evidence across accounts reintroduces, in the evidence, exactly what the
      account-scoped reads remove — the snapshot reader already passes this for
      the same reason.

      ROUND 9 ITEM 6 adds the other half: `endDate`. Without a temporal bound
      this attached outcomes whose EFFECTIVE time is later than the window being
      served — a March answer annotated with September evidence.
    */
    providerAccountId,
    endDate,
    recommendations: payload.recommendations,
  });

  return NextResponse.json({
    ...payload,
    summary: {
      ...payload.summary,
      recommendationCount: recommendations.length,
    },
    recommendations,
  });
}
