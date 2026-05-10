import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  forceReplayGoogleAdsPoisonedPartitions,
  getGoogleAdsCoveredDates,
  replayGoogleAdsDeadLetterPartitions,
} from "@/lib/google-ads/warehouse";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import { addDaysToIsoDate, enumerateDays } from "@/lib/google-ads/history";
import {
  refreshGoogleAdsSyncStateForBusiness,
  runGoogleAdsTargetedRepair,
} from "@/lib/sync/google-ads-sync";

const REPAIR_SCOPE_PRIORITY: GoogleAdsWarehouseScope[] = [
  "product_daily",
  "search_term_daily",
  "campaign_daily",
];
const MAX_REPAIR_DATE_ATTEMPTS = 2;
const GOOGLE_ADS_REPAIR_REQUIRED_TABLES = [
  "google_ads_sync_jobs",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_checkpoints",
  "google_ads_sync_state",
  "google_ads_raw_snapshots",
  "google_ads_account_daily",
  "google_ads_campaign_daily",
  "google_ads_search_term_daily",
  "google_ads_product_daily",
  "provider_account_rollover_state",
  "sync_reclaim_events",
  "sync_runner_leases",
  "google_ads_query_dictionary",
  "google_ads_search_query_hot_daily",
  "google_ads_top_query_weekly",
  "google_ads_search_cluster_daily",
  "google_ads_decision_action_outcome_logs",
] as const;

function getYesterdayIso() {
  return addDaysToIsoDate(new Date().toISOString().slice(0, 10), -1);
}

function resolveTargetWindow(input: {
  startDate?: string | null;
  endDate?: string | null;
}) {
  if (input.startDate && input.endDate) {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      source: "selected_range" as const,
    };
  }
  const endDate = getYesterdayIso();
  return {
    startDate: addDaysToIsoDate(endDate, -13),
    endDate,
    source: "recent_window" as const,
  };
}

async function selectMissingRecentGap(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const coveredDatesByScope = new Map(
    await Promise.all(
      REPAIR_SCOPE_PRIORITY.map(async (scope) => {
        const coveredDates = await getGoogleAdsCoveredDates({
          scope,
          businessId: input.businessId,
          providerAccountId: null,
          startDate: input.startDate,
          endDate: input.endDate,
        }).catch(() => []);
        return [scope, new Set(coveredDates)] as const;
      })
    )
  );

  const descendingDates = enumerateDays(input.startDate, input.endDate, true);
  for (const scope of REPAIR_SCOPE_PRIORITY) {
    const coveredDates = coveredDatesByScope.get(scope) ?? new Set<string>();
    const missingDates = descendingDates.filter((date) => !coveredDates.has(date));
    if (missingDates.length > 0) {
      return {
        scope,
        missingDates,
        reason: `selected ${scope} because ${missingDates[0]} is the newest missing recent date`,
      };
    }
  }

  return null;
}

async function getActiveRunningRepair(input: {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
}) {
  const sql = getDb();
  const rows = await sql`
    SELECT id, scope, start_date, end_date, updated_at
    FROM google_ads_sync_jobs
    WHERE business_id = ${input.businessId}
      AND scope = ${input.scope}
      AND trigger_source = ${`manual_targeted_repair:${input.scope}`}
      AND status = 'running'
    ORDER BY updated_at DESC
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    scope: String(row.scope),
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : null,
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");

  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  const body = (await request.json().catch(() => null)) as
    | {
        businessId?: string;
        startDate?: string | null;
        endDate?: string | null;
      }
    | null;

  const resolvedBusinessId = body?.businessId ?? businessId;
  if (!resolvedBusinessId) {
    return NextResponse.json({ error: "businessId is required." }, { status: 400 });
  }

  const readiness = await getDbSchemaReadiness({
    tables: [...GOOGLE_ADS_REPAIR_REQUIRED_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) {
    return NextResponse.json(
      {
        error: "schema_not_ready",
        message:
          "Google Ads recent-gap repair is unavailable until request-external migrations are applied.",
        provider: "google_ads",
        missingTables: readiness?.missingTables ?? [],
        checkedAt: readiness?.checkedAt ?? null,
      },
      { status: 503 },
    );
  }

  const targetWindow = resolveTargetWindow({
    startDate: body?.startDate ?? null,
    endDate: body?.endDate ?? null,
  });
  const chosenGap = await selectMissingRecentGap({
    businessId: resolvedBusinessId,
    startDate: targetWindow.startDate,
    endDate: targetWindow.endDate,
  });

  if (!chosenGap) {
    return NextResponse.json({
      ok: true,
      outcome: "no_missing_recent_gap",
      targetWindow,
      chosenScope: null,
      chosenStartDate: null,
      chosenEndDate: null,
      reason: "No missing recent gap found in search_term_daily, product_daily, or asset_daily.",
    });
  }

  const attemptedDates = chosenGap.missingDates.slice(0, MAX_REPAIR_DATE_ATTEMPTS);
  const runningJob = await getActiveRunningRepair({
    businessId: resolvedBusinessId,
    scope: chosenGap.scope,
  });

  if (runningJob) {
    return NextResponse.json({
      ok: true,
      outcome: "already_running",
      targetWindow,
      attemptedScope: chosenGap.scope,
      attemptedDates,
      attemptCount: 0,
      chosenScope: chosenGap.scope,
      chosenStartDate: runningJob.startDate,
      chosenEndDate: runningJob.endDate,
      chosenDate: runningJob.startDate,
      runningJob,
      reason: `A ${chosenGap.scope} repair is already running.`,
    });
  }

  let finalResult: Awaited<ReturnType<typeof runGoogleAdsTargetedRepair>> | null = null;
  let finalOutcome:
    | "coverage_increased"
    | "no_data"
    | "failed" = "no_data";
  let chosenDate: string | null = null;
  const replayedDeadLetterRows: Array<{
    id: string;
    lane: string;
    scope: string;
    partitionDate: string;
  }> = [];

  for (const date of attemptedDates) {
    chosenDate = date;
    const replayedPoisonedRows = await forceReplayGoogleAdsPoisonedPartitions({
      businessId: resolvedBusinessId,
      scope: chosenGap.scope,
      startDate: date,
      endDate: date,
    }).catch(() => ({ partitions: [] }));
    const replayedRows = await replayGoogleAdsDeadLetterPartitions({
      businessId: resolvedBusinessId,
      scope: chosenGap.scope,
      startDate: date,
      endDate: date,
      recoveryKinds: ["replayable_transient", "unknown"],
    }).catch(() => ({ partitions: [] }));
    replayedDeadLetterRows.push(...replayedPoisonedRows.partitions);
    replayedDeadLetterRows.push(...replayedRows.partitions);

    const result = await runGoogleAdsTargetedRepair({
      businessId: resolvedBusinessId,
      scope: chosenGap.scope,
      startDate: date,
      endDate: date,
    });
    finalResult = result;
    if (result.outcome === "coverage_increased") {
      finalOutcome = "coverage_increased";
      break;
    }
    if (result.outcome === "failed") {
      finalOutcome = "failed";
      break;
    }
  }

  await refreshGoogleAdsSyncStateForBusiness({
    businessId: resolvedBusinessId,
    scopes: [chosenGap.scope],
  }).catch(() => null);

  return NextResponse.json({
    ok: true,
    outcome: finalOutcome,
    targetWindow,
    attemptedScope: chosenGap.scope,
    attemptedDates,
    attemptCount: attemptedDates.length,
    chosenScope: chosenGap.scope,
    chosenStartDate: chosenDate,
    chosenEndDate: chosenDate,
    chosenDate,
    replayedRecentDeadLetterCount: replayedDeadLetterRows.length,
    replayedRecentDeadLetters: replayedDeadLetterRows,
    reason: chosenGap.reason,
    runningJob: null,
    result: finalResult,
  });
}
