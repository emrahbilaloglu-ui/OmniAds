import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoMetaCreatives } from "@/lib/demo-business";
import {
  decideCreative,
  ENGINE_VERSION,
  readCreativeDecisionBacktestSummary,
  resolveAccountDecisionProfile,
  type CreativeInput,
  type DecisionOutput,
} from "@/lib/creative-decision-engine";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveDataSource } from "@/app/api/creatives/decision-engine-v3/data-source";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  isInBriefing,
  parseBriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import { nDaysAgo, toISODate } from "@/lib/meta/creatives-row-mappers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { readTriageState } from "@/lib/triage-events";
import {
  AGGREGATE_AFFECTED_CREATIVE_ID_CAP,
  CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
  UNUSED_APPROVED_LOOKBACK_DAYS,
  WINNER_GAP_FRESHNESS_MAX_DAYS,
  WINNER_GAP_LOOKBACK_DAYS,
  WINNER_GAP_MIN_DEPTH_DAYS,
  WINNER_GAP_MIN_SAMPLED_DAYS,
} from "@/lib/creative-decision-engine/config-values";
import {
  cardForDecision,
  safeNumber,
} from "./card-serialization";
import {
  adaptCreativeDecisionsToRows,
  assembleDecisionCenterSnapshot,
  auditDecisionCenterSnapshotInvariants,
  buildDecisionCenterObservabilityEvents,
  buildDecisionCenterAggregateDecisions,
  buildUnusedApprovedCreativesAggregateCandidate,
  buildWinnerGapAggregateCandidate,
  REQUIRED_AGGREGATE_DATA,
  CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
  CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
  DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
  bridgeV3DecisionToAdapterInput,
  validateDecisionCenterSnapshot,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterAggregateCandidate,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionCenterFreshnessStatus,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center";
import type {
  BriefingCreativeCard,
  BriefingLaneSummary,
  CreativesBriefingMeasurementReconciliation,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";

export const dynamic = "force-dynamic";

type BriefingLane = "action" | "watching" | "healthy";

const DECISION_CENTER_OBSERVABILITY_ROUTE = "GET /api/creatives/briefing";
const LOCAL_DECISION_CENTER_OBSERVABILITY_SALT =
  "creative-decision-center.observability.v1.local-default";

type DecisionCenterParamState = "truthy" | "falsy" | "unset";

function decisionCenterParamState(
  value: string | null,
): DecisionCenterParamState {
  if (value == null) return "unset";
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return "truthy";
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return "falsy";
  }
  return "unset";
}

function resolveDecisionCenterParamState(
  searchParams: URLSearchParams,
): DecisionCenterParamState {
  const camel = decisionCenterParamState(searchParams.get("decisionCenter"));
  if (camel !== "unset") return camel;
  return decisionCenterParamState(searchParams.get("decision_center"));
}

function isDecisionCenterExplicitlyRequested(
  searchParams: URLSearchParams,
): boolean {
  return resolveDecisionCenterParamState(searchParams) === "truthy";
}

function isDecisionCenterDefaultDisabled(): boolean {
  const normalized = process.env.DECISION_CENTER_DEFAULT_DISABLED?.trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "enabled"
  );
}

/**
 * D027: response-inclusion gate only. This does not control resolver execution
 * or decision semantics; it controls whether the already computed
 * `decisionCenter` snapshot is serialized into the briefing response.
 */
function shouldIncludeDecisionCenter(searchParams: URLSearchParams): boolean {
  const explicit = resolveDecisionCenterParamState(searchParams);
  if (explicit === "truthy") return true;
  if (explicit === "falsy") return false;
  return !isDecisionCenterDefaultDisabled();
}

function isDecisionCenterObservabilityEnabled(): boolean {
  const value = process.env.DECISION_CENTER_OBSERVABILITY;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "enabled"
  );
}

function hashDecisionCenterObservabilityId(
  kind: "business" | "account" | "snapshot",
  value: string | null | undefined,
): string | null {
  const text = value?.trim();
  if (!text) return null;
  const envSalt = process.env.DECISION_CENTER_OBSERVABILITY_SALT?.trim();
  const salt = envSalt || LOCAL_DECISION_CENTER_OBSERVABILITY_SALT;
  const saltState = envSalt ? "salted" : "unsalted";
  const digest = createHash("sha256")
    .update(`${salt}:${kind}:${text}`)
    .digest("hex")
    .slice(0, 24);
  return `${saltState}:${kind}:${digest}`;
}

function emitDecisionCenterObservability(input: {
  decisionCenterRequested: boolean;
  snapshot: DecisionCenterSnapshot | null;
  businessId: string;
  creativeRows: MetaCreativeApiRow[];
}) {
  if (!input.decisionCenterRequested || !isDecisionCenterObservabilityEnabled()) {
    return;
  }
  if (!input.snapshot) return;

  try {
    const businessIdHash = hashDecisionCenterObservabilityId(
      "business",
      input.businessId,
    );
    if (!businessIdHash) return;
    const accountIdHashes = Array.from(
      new Set(
        input.creativeRows
          .map((row) =>
            hashDecisionCenterObservabilityId("account", row.account_id),
          )
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((left, right) => left.localeCompare(right));
    const snapshotId =
      hashDecisionCenterObservabilityId(
        "snapshot",
        [
          input.businessId,
          input.snapshot.generatedAt,
          input.snapshot.engineVersion,
          input.snapshot.adapterVersion,
        ].join(":"),
      ) ?? "unsalted:snapshot:unknown";
    const events = buildDecisionCenterObservabilityEvents({
      snapshot: input.snapshot,
      businessIdHash,
      accountIdHashes,
      snapshotId,
      route: DECISION_CENTER_OBSERVABILITY_ROUTE,
      decisionCenterRequested: input.decisionCenterRequested,
    });
    for (const event of events) {
      console.info(
        DECISION_CENTER_OBSERVABILITY_LOG_MARKER,
        JSON.stringify(event),
      );
    }
  } catch {
    // Passive telemetry must never affect the briefing response.
  }
}

/**
 * Assemble a validated `DecisionCenterSnapshot` for the additive response
 * shape. The snapshot is now part of the production-default response surface;
 * callers can still opt out with `?decisionCenter=0` for rollback/debugging.
 */
function buildDecisionCenterSnapshot(input: {
  asOf: string;
  engineVersion: string;
  adapterVersion?: string;
  dataHealthDegraded: boolean;
  rowDecisions?: CreativeDecisionCenterRowDecision[];
  aggregateDecisions?: CreativeDecisionCenterAggregateDecision[];
}): DecisionCenterSnapshot | null {
  const dataFreshnessStatus: CreativeDecisionCenterFreshnessStatus =
    input.dataHealthDegraded ? "stale" : "fresh";
  const generatedAtDate = new Date(`${input.asOf}T00:00:00.000Z`);
  if (!Number.isFinite(generatedAtDate.getTime())) return null;
  const generatedAt = generatedAtDate.toISOString();
  const { snapshot } = assembleDecisionCenterSnapshot({
    engineVersion: input.engineVersion,
    adapterVersion: input.adapterVersion ?? CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
    configVersion: CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
    generatedAt,
    dataFreshness: { status: dataFreshnessStatus, maxAgeHours: null },
    rowDecisions: input.rowDecisions ?? [],
    aggregateDecisions: input.aggregateDecisions ?? [],
  });
  const validation = validateDecisionCenterSnapshot(snapshot);
  if (!validation.ok) return null;
  if (auditDecisionCenterSnapshotInvariants(snapshot).length > 0) return null;
  return snapshot;
}

const DECISION_CENTER_BRIDGED_ADAPTER_VERSION =
  `${CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION}+${CREATIVE_DECISION_CENTER_ADAPTER_VERSION}`;

type WinnerGapSnapshotSummaryRow = Record<string, unknown> & {
  window_start_date: unknown;
  window_end_date: unknown;
  last_winner_date: unknown;
  sampled_days: unknown;
};

type UnusedApprovedCreativesSummaryRow = Record<string, unknown> & {
  approved_unused_ids: unknown;
  approved_unused_count: unknown;
  status_proof_count: unknown;
  delivery_proof_count: unknown;
};

type MeasurementSnapshotSummaryRow = Record<string, unknown> & {
  as_of_date: unknown;
  engine_version: unknown;
  row_count: unknown;
  stale_rows: unknown;
  conflicting_groups: unknown;
  lifecycle_row_count: unknown;
};

type MeasurementOutcomeSummaryRow = Record<string, unknown> & {
  window_7_count: unknown;
  window_14_count: unknown;
  first_7d_window_closes_at: unknown;
  first_14d_window_closes_at: unknown;
};

function parseDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function parseTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [trimmed];
}

function safeCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function numericCount(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function coverage(present: number, total: number): number | null {
  return total > 0 ? Number((present / total).toFixed(4)) : null;
}

function hasPresentValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function buildDataCompletenessSummary(
  inputs: readonly CreativeInput[],
): CreativesBriefingMeasurementReconciliation["dataCompleteness"] {
  const fields = {
    reviewStatus: (input: CreativeInput) => input.reviewStatus,
    policyReason: (input: CreativeInput) => input.policyReason,
    disapprovalReason: (input: CreativeInput) => input.disapprovalReason,
    limitedReason: (input: CreativeInput) => input.limitedReason,
    firstSeenAt: (input: CreativeInput) => input.firstSeenAt,
    firstSpendAt: (input: CreativeInput) => input.firstSpendAt,
    spend24h: (input: CreativeInput) => input.spend24h,
    impressions24h: (input: CreativeInput) => input.impressions24h,
    ctr: (input: CreativeInput) => input.ctr,
    cpm: (input: CreativeInput) => input.cpm,
    frequency: (input: CreativeInput) => input.frequency,
  } as const;
  const total = inputs.length;
  const criticalForActionsByField: Record<string, string[]> = {
    reviewStatus: ["fix_policy", "unused_approved_creatives"],
    policyReason: ["fix_policy", "unused_approved_creatives"],
    disapprovalReason: ["fix_policy"],
    limitedReason: ["fix_policy"],
    firstSeenAt: ["watch_launch"],
    firstSpendAt: ["watch_launch", "fix_delivery"],
    spend24h: ["fix_delivery", "watch_launch"],
    impressions24h: ["fix_delivery", "watch_launch"],
    ctr: ["refresh", "diagnose_data"],
    cpm: ["refresh", "diagnose_data"],
    frequency: ["refresh", "diagnose_data"],
  };
  const entries = Object.entries(fields).map(([field, read]) => {
    const present = inputs.filter((input) => hasPresentValue(read(input))).length;
    return [
      field,
      {
        present,
        total,
        coverage: coverage(present, total),
        criticalForActions: criticalForActionsByField[field] ?? [],
      },
    ] as const;
  });
  return {
    totalInputs: total,
    fields: Object.fromEntries(entries),
  };
}

function buildLaneSummary(input: {
  lanes: Record<BriefingLane, BriefingCreativeCard[]>;
  deferredCount: number;
}): BriefingLaneSummary {
  const watching = input.lanes.watching;
  const totalDecisions =
    input.lanes.action.length + watching.length + input.lanes.healthy.length;
  const bucketCounts = {
    nearAction: 0,
    testMaturing: 0,
    diagnostic: 0,
    waitingOnLabels: 0,
    other: 0,
  };

  for (const card of watching) {
    if (card.watchingSubBucket === "near_action") {
      bucketCounts.nearAction += 1;
    } else if (card.watchingSubBucket === "test_maturing") {
      bucketCounts.testMaturing += 1;
    } else if (card.watchingSubBucket === "diagnostic") {
      bucketCounts.diagnostic += 1;
    } else if (card.watchingSubBucket === "waiting_on_labels") {
      bucketCounts.waitingOnLabels += 1;
    } else {
      bucketCounts.other += 1;
    }
  }

  return {
    actionNow: input.lanes.action.length,
    watching: {
      total: watching.length,
      ...bucketCounts,
    },
    healthy: input.lanes.healthy.length,
    deferred: input.deferredCount,
    totalDecisions,
    coveragePct: totalDecisions > 0 ? 1 : null,
  };
}

async function readMeasurementSnapshotSummary(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<CreativesBriefingMeasurementReconciliation["snapshotLatest"]> {
  const [row] = await getDb().query<MeasurementSnapshotSummaryRow>(
    `
    WITH latest_day AS (
      SELECT MAX(as_of_date) AS as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND as_of_date <= $2::date
        AND engine_version = $3
    ),
    latest_snapshots AS (
      SELECT *
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND as_of_date = (SELECT as_of_date FROM latest_day)
        AND engine_version = $3
        AND scope_type = 'account'
        AND scope_id = '*'
    ),
    conflicts AS (
      SELECT creative_id, as_of_date, engine_version, scope_type, scope_id
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND as_of_date = (SELECT as_of_date FROM latest_day)
        AND engine_version = $3
      GROUP BY creative_id, as_of_date, engine_version, scope_type, scope_id
      HAVING COUNT(DISTINCT label) > 1
    ),
    latest_lifecycle AS (
      SELECT COUNT(DISTINCT creative_id) AS lifecycle_row_count
      FROM engine_v3_creative_lifecycle_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND as_of_date = (SELECT as_of_date FROM latest_day)
    )
    SELECT
      (SELECT as_of_date FROM latest_day) AS as_of_date,
      $3::text AS engine_version,
      COUNT(DISTINCT latest_snapshots.creative_id) AS row_count,
      COUNT(*) FILTER (
        WHERE latest_snapshots.computed_at < (now() - INTERVAL '24 hours')
           OR latest_snapshots.as_of_date < ($2::date - INTERVAL '1 day')
      ) AS stale_rows,
      (SELECT COUNT(*) FROM conflicts) AS conflicting_groups,
      (SELECT lifecycle_row_count FROM latest_lifecycle) AS lifecycle_row_count
    FROM latest_snapshots
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  const asOfDate = parseDateOnly(row?.as_of_date);
  if (!asOfDate) return null;
  return {
    asOfDate,
    engineVersion:
      typeof row?.engine_version === "string" ? row.engine_version : input.engineVersion,
    rowCount: numericCount(row?.row_count),
    conflictingGroups: numericCount(row?.conflicting_groups),
    staleRows: numericCount(row?.stale_rows),
    lifecycleRowCount: numericCount(row?.lifecycle_row_count),
  };
}

async function readMeasurementOutcomeSummary(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<CreativesBriefingMeasurementReconciliation["outcome"]> {
  const [row] = await getDb().query<MeasurementOutcomeSummaryRow>(
    `
    WITH current_outcomes AS (
      SELECT outcome_window_days
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND evaluation_date <= $2::date
    ),
    earliest_snapshot AS (
      SELECT MIN(as_of_date) AS first_as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND engine_version = $3
        AND scope_type = 'account'
        AND scope_id = '*'
    )
    SELECT
      COUNT(*) FILTER (WHERE outcome_window_days = 7) AS window_7_count,
      COUNT(*) FILTER (WHERE outcome_window_days = 14) AS window_14_count,
      ((SELECT first_as_of_date FROM earliest_snapshot) + INTERVAL '7 day')::date
        AS first_7d_window_closes_at,
      ((SELECT first_as_of_date FROM earliest_snapshot) + INTERVAL '14 day')::date
        AS first_14d_window_closes_at
    FROM current_outcomes
    `,
    [input.businessId, input.asOf, input.engineVersion],
  );
  return {
    currentVersionRows7d: numericCount(row?.window_7_count),
    currentVersionRows14d: numericCount(row?.window_14_count),
    first7dWindowClosesAt: parseDateOnly(row?.first_7d_window_closes_at),
    first14dWindowClosesAt: parseDateOnly(row?.first_14d_window_closes_at),
  };
}

async function buildMeasurementReconciliation(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
  lanes: Record<BriefingLane, BriefingCreativeCard[]>;
  decisionCenterRowCount: number | null;
  inputs: readonly CreativeInput[];
}): Promise<CreativesBriefingMeasurementReconciliation> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const measurementQueries = {
    snapshotLatest: readMeasurementSnapshotSummary(input).catch((error) => {
      console.error("[creative-decision-center] measurement snapshot summary failed", error);
      notes.push("snapshot_summary_unavailable");
      return null;
    }),
    outcome: readMeasurementOutcomeSummary(input).catch((error) => {
      console.error("[creative-decision-center] measurement outcome summary failed", error);
      notes.push("outcome_summary_unavailable");
      return null;
    }),
  };
  const [snapshotLatest, outcome] = await Promise.all([
    measurementQueries.snapshotLatest,
    measurementQueries.outcome,
  ]);
  const actionNow = input.lanes.action.length;
  const watching = input.lanes.watching.length;
  const healthy = input.lanes.healthy.length;
  const total = actionNow + watching + healthy;

  if (!snapshotLatest && total > 0) {
    notes.push("snapshot_count_differs_from_live_briefing_count");
    notes.push("snapshot_missing_for_live_briefing_count");
  }
  if (snapshotLatest && snapshotLatest.rowCount === 0 && total > 0) {
    notes.push("snapshot_count_differs_from_live_briefing_count");
    notes.push("snapshot_missing_account_scope_rows_for_live_briefing_count");
  }
  if (
    snapshotLatest &&
    snapshotLatest.rowCount > 0 &&
    total > 0 &&
    Math.abs(snapshotLatest.rowCount - total) > 2
  ) {
    notes.push("snapshot_count_differs_from_live_briefing_count");
  }
  if (
    input.decisionCenterRowCount !== null &&
    Math.abs(input.decisionCenterRowCount - total) > 2
  ) {
    notes.push("decision_center_row_count_differs_from_live_briefing_count");
  }
  if (outcome && outcome.currentVersionRows7d === 0) {
    notes.push("current_version_7d_outcomes_not_yet_available_or_empty");
  }
  if (outcome && outcome.currentVersionRows14d === 0) {
    notes.push("current_version_14d_outcomes_not_yet_available_or_empty");
  }
  const dataCompleteness = buildDataCompletenessSummary(input.inputs);

  return {
    durationMs: Date.now() - startedAt,
    queryCount: Object.keys(measurementQueries).length,
    briefingCounts: { actionNow, watching, healthy, total },
    decisionCenterRowCount: input.decisionCenterRowCount,
    snapshotLatest,
    outcome,
    dataCompleteness,
    notes,
  };
}

function daysBetweenDateOnly(start: string | null, end: string): number | null {
  if (!start) return null;
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    return null;
  }
  return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function aggregateAffectedCreativeIds(decisions: readonly DecisionOutput[]) {
  return Array.from(
    new Set(
      [...decisions]
        .sort(
          (left, right) =>
            safeNumber(right.metrics.spend) - safeNumber(left.metrics.spend) ||
            left.creativeId.localeCompare(right.creativeId),
        )
        .map((decision) => decision.creativeId)
        .filter(Boolean),
    ),
  ).slice(0, AGGREGATE_AFFECTED_CREATIVE_ID_CAP);
}

async function buildWinnerGapCandidateFromSnapshots(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
  decisions: readonly DecisionOutput[];
}): Promise<CreativeDecisionCenterAggregateCandidate | null> {
  const affectedCreativeIds = aggregateAffectedCreativeIds(input.decisions);
  if (affectedCreativeIds.length === 0) return null;

  const [row] = await getDb().query<WinnerGapSnapshotSummaryRow>(
    `
    WITH scoped AS (
      SELECT creative_id, as_of_date, label
      FROM engine_v3_decision_snapshots_daily
      WHERE (business_ref_id::text = $1 OR business_id::text = $1)
        AND engine_version = $2
        AND scope_type = 'account'
        AND scope_id = '*'
        AND as_of_date BETWEEN ($3::date - (($4::integer - 1) * INTERVAL '1 day')) AND $3::date
    )
    SELECT
      MIN(as_of_date) AS window_start_date,
      MAX(as_of_date) AS window_end_date,
      MAX(as_of_date) FILTER (WHERE label = 'scale') AS last_winner_date,
      COUNT(DISTINCT as_of_date) AS sampled_days
    FROM scoped
    `,
    [input.businessId, input.engineVersion, input.asOf, WINNER_GAP_LOOKBACK_DAYS],
  );

  const windowStartDate = parseDateOnly(row?.window_start_date);
  const windowEndDate = parseDateOnly(row?.window_end_date);
  const lastWinnerDate = parseDateOnly(row?.last_winner_date);
  const sampledDays = Number(row?.sampled_days ?? 0);
  const freshnessDays = daysBetweenDateOnly(windowEndDate, input.asOf);
  const depthDays = daysBetweenDateOnly(windowStartDate, input.asOf);
  const hasUsableHistoricalWindow =
    windowStartDate !== null &&
    windowEndDate !== null &&
    freshnessDays !== null &&
    depthDays !== null &&
    freshnessDays <= WINNER_GAP_FRESHNESS_MAX_DAYS &&
    depthDays >= WINNER_GAP_MIN_DEPTH_DAYS &&
    sampledDays >= WINNER_GAP_MIN_SAMPLED_DAYS;

  return buildWinnerGapAggregateCandidate({
    lastWinnerDate,
    windowStartDate,
    windowEndDate: windowEndDate ?? input.asOf,
    affectedCreativeIds,
    availableData: hasUsableHistoricalWindow
      ? [...REQUIRED_AGGREGATE_DATA.winner_gap]
      : [],
  });
}

async function buildUnusedApprovedCreativesCandidateFromWarehouse(input: {
  businessId: string;
  asOf: string;
}): Promise<CreativeDecisionCenterAggregateCandidate | null> {
  const [row] = await getDb().query<UnusedApprovedCreativesSummaryRow>(
    `
    WITH latest_meta AS (
      SELECT DISTINCT ON (d.creative_id)
        d.creative_id,
        COALESCE(
          NULLIF(d.payload_json->>'review_status', ''),
          NULLIF(d.payload_json->>'ad_review_status', ''),
          NULLIF(d.payload_json->>'approval_status', '')
        ) AS review_status,
        COALESCE(
          NULLIF(d.payload_json->>'policy_reason', ''),
          NULLIF(d.payload_json->>'ad_review_feedback', ''),
          NULLIF(d.payload_json->>'review_feedback', ''),
          NULLIF(d.payload_json->>'disapproval_reason', ''),
          NULLIF(d.payload_json->>'limited_reason', ''),
          NULLIF(d.payload_json->>'delivery_status_reason', '')
        ) AS policy_reason
      FROM meta_creative_daily d
      WHERE (d.business_ref_id::text = $1 OR d.business_id::text = $1)
        AND d.date <= $2::date
        AND d.date >= ($2::date - (($3::integer - 1) * INTERVAL '1 day'))
        AND d.creative_id IS NOT NULL
      ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
    ),
    lifetime_delivery AS (
      SELECT
        d.creative_id,
        SUM(COALESCE(d.spend, 0)) AS lifetime_spend,
        SUM(COALESCE(d.impressions, 0)) AS lifetime_impressions,
        COUNT(*) AS sampled_rows
      FROM meta_creative_daily d
      WHERE (d.business_ref_id::text = $1 OR d.business_id::text = $1)
        AND d.date <= $2::date
        AND d.creative_id IS NOT NULL
      GROUP BY d.creative_id
    ),
    candidates AS (
      SELECT
        latest_meta.creative_id,
        UPPER(REPLACE(COALESCE(review_status, ''), ' ', '_')) IN (
          'APPROVED',
          'AD_APPROVED',
          'APPROVED_LIMITED',
          'APPROVED_WITH_LIMITED'
        ) AS approved_like,
        COALESCE(policy_reason, '') = '' AS policy_clear,
        COALESCE(lifetime_spend, 0) <= 0
          AND COALESCE(lifetime_impressions, 0) <= 0 AS no_delivery,
        review_status IS NOT NULL AS has_status_proof,
        sampled_rows > 0 AS has_delivery_proof
      FROM latest_meta
      INNER JOIN lifetime_delivery
        ON lifetime_delivery.creative_id = latest_meta.creative_id
    )
    SELECT
      ARRAY_AGG(creative_id ORDER BY creative_id)
        FILTER (WHERE approved_like AND policy_clear AND no_delivery)
        AS approved_unused_ids,
      COUNT(*) FILTER (WHERE approved_like AND policy_clear AND no_delivery)
        AS approved_unused_count,
      COUNT(*) FILTER (
        WHERE approved_like AND policy_clear AND no_delivery AND has_status_proof
      ) AS status_proof_count,
      COUNT(*) FILTER (
        WHERE approved_like AND policy_clear AND no_delivery AND has_delivery_proof
      ) AS delivery_proof_count
    FROM candidates
    `,
    [input.businessId, input.asOf, UNUSED_APPROVED_LOOKBACK_DAYS],
  );

  const approvedUnusedIds = parseTextArray(row?.approved_unused_ids).slice(
    0,
    AGGREGATE_AFFECTED_CREATIVE_ID_CAP,
  );
  const approvedUnusedCount = safeCount(row?.approved_unused_count);
  if (approvedUnusedIds.length === 0) return null;
  const statusProofCount = safeCount(row?.status_proof_count);
  const deliveryProofCount = safeCount(row?.delivery_proof_count);
  const availableData = [
    ...(statusProofCount >= approvedUnusedCount
      ? ["creative_review_status"]
      : []),
    ...(deliveryProofCount >= approvedUnusedCount
      ? ["delivery_proof", "lifetime_delivery"]
      : []),
  ];

  return buildUnusedApprovedCreativesAggregateCandidate({
    approvedUnusedCreativeIds: approvedUnusedIds,
    approvedUnusedCount,
    availableData,
  });
}

async function buildDecisionCenterAggregateCandidates(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
  decisions: readonly DecisionOutput[];
}): Promise<CreativeDecisionCenterAggregateCandidate[]> {
  const aggregateCandidates: CreativeDecisionCenterAggregateCandidate[] = [];

  try {
    const winnerGap = await buildWinnerGapCandidateFromSnapshots(input);
    if (winnerGap) aggregateCandidates.push(winnerGap);
  } catch (error) {
    // Aggregate decisions are helpful, but missing/stale persisted history must
    // not break the row-level briefing or invent a page-level recommendation.
    console.error(
      "[creative-decision-center] winner_gap candidate query failed",
      error,
    );
  }

  try {
    const unusedApproved =
      await buildUnusedApprovedCreativesCandidateFromWarehouse(input);
    if (unusedApproved) aggregateCandidates.push(unusedApproved);
  } catch (error) {
    console.error(
      "[creative-decision-center] unused_approved_creatives candidate query failed",
      error,
    );
  }

  return aggregateCandidates;
}

function decisionLane(
  decision: DecisionOutput,
  deferred: boolean,
): BriefingLane {
  if (deferred) return "watching";
  if (
    decision.label === "diagnose" &&
    decision.blockedActionType === "cut" &&
    decision.campaignLabelStatus === "unlabeled"
  ) {
    return "action";
  }
  if (
    decision.label === "keep" &&
    decision.badges.some((badge) => badge.type === "scale_readiness_blocked")
  ) {
    return "watching";
  }
  if (decision.label === "keep") return "healthy";
  if (
    decision.confidence >= 70 &&
    (decision.label === "scale" ||
      decision.label === "cut" ||
      decision.label === "refresh")
  ) {
    return "action";
  }
  return "watching";
}

function rowForDecision(
  decision: DecisionOutput,
  input: CreativeInput | undefined,
  creativeRowsById: Map<string, MetaCreativeApiRow>,
): MetaCreativeApiRow | null {
  return (
    creativeRowsById.get(decision.creativeId) ??
    (input?.creativeId ? creativeRowsById.get(input.creativeId) : undefined) ??
    null
  );
}

function buildDecisionCenterRows(input: {
  decisions: DecisionOutput[];
  inputsByCreativeId: Map<string, CreativeInput>;
  creativeRowsById: Map<string, MetaCreativeApiRow>;
  dataHealthDegraded: boolean;
}): CreativeDecisionCenterRowDecision[] {
  const adapterInputs = input.decisions.flatMap((decision) => {
    const creativeInput = input.inputsByCreativeId.get(decision.creativeId);
    const row = rowForDecision(
      decision,
      creativeInput,
      input.creativeRowsById,
    );
    const adapterInput = bridgeV3DecisionToAdapterInput({
      decision,
      context: {
        creativeId: decision.creativeId,
        rowId: row?.id,
        identityGrain: "creative",
        familyId: null,
        campaignKind: decision.campaignKind ?? creativeInput?.campaignKind ?? null,
        dataHealthDegraded: input.dataHealthDegraded,
      },
    });
    return adapterInput ? [adapterInput] : [];
  });

  return adaptCreativeDecisionsToRows(adapterInputs).map((result) => result.row);
}

function buildBridgedDecisionCenterSnapshot(input: {
  asOf: string;
  engineVersion: string;
  decisions: DecisionOutput[];
  inputsByCreativeId: Map<string, CreativeInput>;
  creativeRowsById: Map<string, MetaCreativeApiRow>;
  dataHealthDegraded: boolean;
  aggregateDecisions: readonly CreativeDecisionCenterAggregateDecision[];
}): DecisionCenterSnapshot | null {
  try {
    const rowDecisions = buildDecisionCenterRows({
      decisions: input.decisions,
      inputsByCreativeId: input.inputsByCreativeId,
      creativeRowsById: input.creativeRowsById,
      dataHealthDegraded: input.dataHealthDegraded,
    });
    return buildDecisionCenterSnapshot({
      asOf: input.asOf,
      engineVersion: input.engineVersion,
      adapterVersion: DECISION_CENTER_BRIDGED_ADAPTER_VERSION,
      dataHealthDegraded: input.dataHealthDegraded,
      rowDecisions,
      aggregateDecisions: [...input.aggregateDecisions],
    });
  } catch {
    return null;
  }
}

async function readCreativeRows(input: {
  request: NextRequest;
  businessId: string;
  start: string;
  end: string;
}): Promise<MetaCreativeApiRow[]> {
  if (await isDemoBusiness(input.businessId)) {
    return getDemoMetaCreatives().rows as unknown as MetaCreativeApiRow[];
  }
  const basePayloadInput = {
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "full",
    format: "all",
    sort: "spend",
    start: input.start,
    end: input.end,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: true,
    enableCardThumbnailBackfill: true,
    enableImageHashLookup: true,
    enableMediaRecovery: true,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 5,
  } as const;
  const payload = await getMetaCreativesApiPayload({
    ...basePayloadInput,
    groupBy: "creative",
  });
  const rows = payload.rows ?? [];

  if (!rows.some((row) => !usableMetaAdId(row.real_ad_id))) {
    return rows;
  }

  const adPayload = await getMetaCreativesApiPayload({
    ...basePayloadInput,
    requestStartedAt: Date.now(),
    groupBy: "ad",
  }).catch(() => null);

  return hydrateCreativeRowsWithRealAdIds(rows, adPayload?.rows ?? []);
}

function buildRowMap(rows: MetaCreativeApiRow[]) {
  const map = new Map<string, MetaCreativeApiRow>();
  for (const row of rows) {
    map.set(row.id, row);
    map.set(row.creative_id, row);
  }
  return map;
}

function usableMetaAdId(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;
  if (text.startsWith("creative_") || text.startsWith("adset_")) return null;
  return text;
}

function hydrateCreativeRowsWithRealAdIds(
  creativeRows: MetaCreativeApiRow[],
  adRows: MetaCreativeApiRow[],
) {
  if (adRows.length === 0) return creativeRows;
  const adIdByCreativeId = new Map<string, string>();
  for (const row of adRows) {
    const creativeId = row.creative_id?.trim();
    const realAdId = usableMetaAdId(row.real_ad_id) ?? usableMetaAdId(row.id);
    if (creativeId && realAdId && !adIdByCreativeId.has(creativeId)) {
      adIdByCreativeId.set(creativeId, realAdId);
    }
  }
  if (adIdByCreativeId.size === 0) return creativeRows;

  return creativeRows.map((row) => {
    if (usableMetaAdId(row.real_ad_id)) return row;
    const realAdId = adIdByCreativeId.get(row.creative_id);
    return realAdId ? { ...row, real_ad_id: realAdId } : row;
  });
}

export async function GET(request: NextRequest) {
  const businessId =
    request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const asOf =
    request.nextUrl.searchParams.get("asOf")?.trim() || toISODate(new Date());
  const campaignId =
    request.nextUrl.searchParams.get("campaignId")?.trim() || undefined;
  const statusFilter = parseBriefingStatusFilter(
    request.nextUrl.searchParams.get("status_filter"),
  );
  const decisionCenterExplicitlyRequested = isDecisionCenterExplicitlyRequested(
    request.nextUrl.searchParams,
  );
  const includeDecisionCenter = shouldIncludeDecisionCenter(
    request.nextUrl.searchParams,
  );

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const resolvedBusinessId = access.membership.businessId;
  const flags = await resolveEngineV3Flags(resolvedBusinessId);
  if (!flags.enabled) {
    const disabledBody: CreativesBriefingResponse & {
      status: "disabled";
      reason: string;
      statusFilter: typeof statusFilter;
    } = {
      status: "disabled",
      reason: "engine_v3_disabled_for_business",
      statusFilter,
      actionNow: [],
      watching: [],
      healthy: [],
      deferredCount: 0,
      pulse: {
        matureCount: 0,
        engineVersion: "disabled",
        trackingAnomalyActive: false,
      },
    };
    if (includeDecisionCenter) {
      disabledBody.decisionCenter = buildDecisionCenterSnapshot({
        asOf,
        engineVersion: "disabled",
        dataHealthDegraded: false,
      });
    }
    return NextResponse.json(disabledBody);
  }

  const { instance: dataSource, label: dataSourceLabel } = resolveDataSource();
  const [profile, dataHealth, creativeRows, triageState] = await Promise.all([
    resolveAccountDecisionProfile({
      businessId: resolvedBusinessId,
      asOf,
      dataSource,
      flags,
      campaignId,
    }),
    dataSource.getDataHealth({ businessId: resolvedBusinessId, asOf }),
    readCreativeRows({
      request,
      businessId: resolvedBusinessId,
      start: toISODate(nDaysAgo(29)),
      end: asOf,
    }).catch(() => [] as MetaCreativeApiRow[]),
    readTriageState({
      businessId: resolvedBusinessId,
      scopeType: "creative",
    }).catch(() => ({ rows: [], deferredCount: 0 })),
  ]);
  const creativeIds = creativeRows
    .map((row) => row.creative_id)
    .filter(Boolean);
  const inputs = await dataSource.listCreativeInputs({
    businessId: resolvedBusinessId,
    asOf,
    creativeIds: creativeIds.length > 0 ? creativeIds : undefined,
  });
  const campaignScopedInputs = campaignId
    ? inputs.filter((input) => input.campaignId === campaignId)
    : inputs;
  const allCreativeRowsById = buildRowMap(creativeRows);
  const scopedInputs = campaignScopedInputs.filter((input) => {
    const row = allCreativeRowsById.get(input.creativeId);
    const status = input.effectiveStatus ?? row?.effective_status ?? null;
    return isInBriefing(
      {
        status,
        effective_status: row?.effective_status ?? null,
        effectiveStatus: status,
      },
      statusFilter,
    );
  });
  const scopedInputByCreativeId = new Map(
    scopedInputs.map((input) => [input.creativeId, input]),
  );
  const creativeRowsById = buildRowMap(
    creativeRows.filter((row) => {
      const input = scopedInputByCreativeId.get(row.creative_id);
      const status = input?.effectiveStatus ?? row.effective_status ?? null;
      return isInBriefing(
        {
          status,
          effective_status: row.effective_status ?? null,
          effectiveStatus: status,
        },
        statusFilter,
      );
    }),
  );
  const deferredIds = new Set(
    triageState.rows
      .filter(
        (row) => row.action === "deferred" && row.scopeType === "creative",
      )
      .map((row) => row.scopeId),
  );
  const campaignIds = Array.from(
    new Set(
      scopedInputs
        .map((input) => input.campaignId?.trim() || "")
        .filter(Boolean),
    ),
  );
  const campaignLabelsById = buildCreativeCampaignLabelMap(
    campaignIds.length > 0
      ? await readMetaCampaignLabels({
          businessId: resolvedBusinessId,
          campaignIds,
        })
      : [],
  );

  const lanes: Record<BriefingLane, BriefingCreativeCard[]> = {
    action: [],
    watching: [],
    healthy: [],
  };
  const enrichedInputs = scopedInputs.map((creativeInput) =>
    withCreativeCampaignLabelContext(creativeInput, campaignLabelsById),
  );
  const inputByCreativeId = new Map(
    enrichedInputs.map((input) => [input.creativeId, input]),
  );
  const decisions = enrichedInputs.map((creativeInput) =>
    applyCreativeCampaignLabelGuard({
      decision: decideCreative(creativeInput, profile, dataHealth),
      input: creativeInput,
      campaignLabelsById,
    }),
  );
  const backtestSummary = await readCreativeDecisionBacktestSummary({
    businessId: resolvedBusinessId,
    asOf,
    activeCreativeCount: enrichedInputs.length,
  }).catch(() => null);

  for (const decision of decisions) {
    const creativeInput = inputByCreativeId.get(decision.creativeId);
    const row = rowForDecision(decision, creativeInput, creativeRowsById);
    const card = cardForDecision({
      decision,
      creativeInput,
      row,
      sourceAsOf: asOf,
      sourceDataSource: dataSourceLabel,
      profileScope: `${profile.scope.type}:${profile.scope.id}`,
      accountProfile: profile,
      backtestSummary,
    });
    const deferred =
      deferredIds.has(decision.creativeId) ||
      deferredIds.has(card.id) ||
      (row?.id ? deferredIds.has(row.id) : false);
    lanes[decisionLane(decision, deferred)].push(card);
  }

  const sortCards = (left: BriefingCreativeCard, right: BriefingCreativeCard) =>
    safeNumber(right.priorityScore?.score) - safeNumber(left.priorityScore?.score) ||
    safeNumber(right.confidence) - safeNumber(left.confidence) ||
    safeNumber(right.spend) - safeNumber(left.spend);
  lanes.action.sort(sortCards);
  lanes.watching.sort(sortCards);
  lanes.healthy.sort(sortCards);

  const trackingAnomalyActive = decisions.some((decision) =>
    decision.badges.some((badge) => badge.type === "tracking_anomaly"),
  );

  const responseEngineVersion = decisions[0]?.engineVersion ?? ENGINE_VERSION;
  const aggregateCandidates = await buildDecisionCenterAggregateCandidates({
    businessId: resolvedBusinessId,
    asOf,
    engineVersion: responseEngineVersion,
    decisions,
  });
  const aggregateBuild = buildDecisionCenterAggregateDecisions({
    candidates: aggregateCandidates,
  });
  let decisionCenterSnapshot: DecisionCenterSnapshot | null | undefined;
  if (includeDecisionCenter) {
    decisionCenterSnapshot = buildBridgedDecisionCenterSnapshot({
      asOf,
      engineVersion: responseEngineVersion,
      decisions,
      inputsByCreativeId: inputByCreativeId,
      creativeRowsById,
      dataHealthDegraded: Boolean(dataHealth.degraded),
      aggregateDecisions: aggregateBuild.aggregateDecisions,
    });
  }
  const laneSummary = buildLaneSummary({
    lanes,
    deferredCount: triageState.deferredCount,
  });
  const measurementReconciliation = await buildMeasurementReconciliation({
    businessId: resolvedBusinessId,
    asOf,
    engineVersion: responseEngineVersion,
    lanes,
    decisionCenterRowCount:
      decisionCenterSnapshot === undefined
        ? null
        : decisionCenterSnapshot?.rowDecisions.length ?? null,
    inputs: enrichedInputs,
  });

  const responseBody: CreativesBriefingResponse & {
    statusFilter: typeof statusFilter;
  } = {
    actionNow: lanes.action,
    watching: lanes.watching,
    healthy: lanes.healthy,
    statusFilter,
    deferredCount: triageState.deferredCount,
    pulse: {
      matureCount: lanes.healthy.length + lanes.action.length,
      spendTarget: null,
      spendHistory: null,
      rolling7dRoasTarget: profile.spendUnitEvidence.targetRoas,
      engineVersion: responseEngineVersion,
      calibratedAgo: dataHealth.calibration.computedAt ?? null,
      trackingAnomalyActive,
      trackingDetail: trackingAnomalyActive
        ? "Engine v3 flagged a tracking anomaly in the decision set."
        : dataHealth.degraded
          ? "Engine v3 is running with degraded data health."
          : null,
    },
    trackingAnomalyActive,
    trackingBlocked: trackingAnomalyActive,
    trackingDetail: trackingAnomalyActive
      ? "Engine v3 flagged a tracking anomaly in the decision set."
      : null,
    source: {
      dataSource: dataSourceLabel,
      asOf,
      dataHealth,
      accountProfile: profile,
      measurementReconciliation,
      laneSummary,
      aggregateSuppressionTrace: aggregateBuild.trace,
    },
  };

  if (includeDecisionCenter) {
    responseBody.decisionCenter = decisionCenterSnapshot ?? null;
    emitDecisionCenterObservability({
      decisionCenterRequested: decisionCenterExplicitlyRequested,
      snapshot: decisionCenterSnapshot ?? null,
      businessId: resolvedBusinessId,
      creativeRows,
    });
  }

  return NextResponse.json(responseBody, {
    headers: { "Cache-Control": "no-store" },
  });
}
