import { getDb, runDbTransaction } from "@/lib/db";
import {
  detectOperatorResponse,
  type OperatorResponseInput,
  type OperatorResponseResult,
  type OperatorResponseType,
} from "../operator-response-detection";
import { resolveEngineV3Flags } from "../feature-flags";
import { ENGINE_VERSION, type DecisionLabel } from "../types";
import { RESPONSE_WINDOW_DAYS } from "../config-values";
import { hashAdvisoryLock } from "./calibration-job";
import { JOB_NAME as DECISIONS_JOB_NAME } from "./decisions-job";

export const JOB_NAME = "engine_v3_operator_response_job";
export { RESPONSE_WINDOW_DAYS } from "../config-values";

type JobStatus = "success" | "failed" | "skipped";
type LifecycleOperatorResponseType =
  | "scaled"
  | "ignored"
  | "paused"
  | "creative_archived"
  | "budget_cut"
  | "unknown";
type OperatorActionEventType =
  | "scaled"
  | "paused"
  | "budget_decreased"
  | "creative_archived"
  | "unknown";

export interface OperatorResponseJobInput {
  businessId: string;
  asOf: string;
}

export interface OperatorResponseJobResult {
  jobRunId: string;
  dependencyRunId: string | null;
  status: JobStatus;
  creativesEvaluated: number;
  lifecycleRowsUpdated: number;
  operatorEventsWritten: number;
  lifecyclePromotions: number;
  durationMs: number;
  reason?: "engine_v3_disabled";
  errorMessage?: string;
}

type AdvisoryLockRow = Record<string, unknown> & {
  acquired: unknown;
};

type JobRunIdRow = Record<string, unknown> & {
  id: unknown;
};

type CreativeIdRow = Record<string, unknown> & {
  creative_id: unknown;
};

type RecommendationRow = Record<string, unknown> & {
  id: unknown;
  as_of_date: unknown;
  label: unknown;
  confidence: unknown;
};

type LifecycleContextRow = Record<string, unknown> & {
  adset_id: unknown;
  campaign_id: unknown;
  ad_id: unknown;
  lifecycle_position: unknown;
  roas_7d: unknown;
  roas_28d: unknown;
  frequency_28d: unknown;
};

type DailySpendRow = Record<string, unknown> & {
  date: unknown;
  spend: unknown;
  purchases: unknown;
  effective_status: unknown;
};

type BudgetHistoryRow = Record<string, unknown> & {
  captured_at: unknown;
  daily_budget: unknown;
  lifetime_budget: unknown;
};

type RecentFrequencyRow = Record<string, unknown> & {
  recent7d_frequency: unknown;
};

type ActionJournalRow = Record<string, unknown> & {
  created_at: unknown;
  event_type: unknown;
  action_title: unknown;
  metadata_json: unknown;
  match_level: unknown;
};

type UpdatedLifecycleRow = Record<string, unknown> & {
  lifecycle_position: unknown;
};

type InsertedEventRow = Record<string, unknown> & {
  id: unknown;
};

interface GatheredSignalInputs {
  detectorInput: OperatorResponseInput;
  firstRecommendationSnapshotId: string | null;
}

interface OperatorEventPayloadRow {
  business_ref_id: string;
  business_id: string;
  creative_id: string;
  event_date: string;
  operator_action_type: OperatorActionEventType;
  operator_evidence: Record<string, unknown>;
  decision_snapshot_id: string | null;
  job_run_id: string;
}

const FIND_RECOMMENDED_CREATIVES_QUERY = `
WITH snapshots AS (
  SELECT *
  FROM engine_v3_decision_snapshots_daily
  WHERE business_ref_id = $1::uuid
    AND label IN ('scale', 'refresh')
    AND as_of_date BETWEEN ($2::date - ($3::integer * INTERVAL '1 day')) AND $2::date
),
guarded AS (
  SELECT
    snapshots.creative_id,
    CASE
      WHEN lifecycle.campaign_id IS NOT NULL
        AND labels.campaign_id IS NULL
      THEN 'diagnose'
      ELSE snapshots.label
    END AS effective_label
  FROM snapshots
  LEFT JOIN LATERAL (
    SELECT lifecycle.campaign_id
    FROM engine_v3_creative_lifecycle_daily lifecycle
    WHERE lifecycle.business_ref_id = snapshots.business_ref_id
      AND lifecycle.creative_id = snapshots.creative_id
      AND lifecycle.engine_version = snapshots.engine_version
      AND lifecycle.as_of_date <= snapshots.as_of_date
    ORDER BY lifecycle.as_of_date DESC, lifecycle.computed_at DESC
    LIMIT 1
  ) lifecycle ON true
  LEFT JOIN meta_campaign_labels labels
    ON labels.business_id = COALESCE(snapshots.business_id, snapshots.business_ref_id::text)
   AND labels.campaign_id = lifecycle.campaign_id
)
SELECT DISTINCT creative_id
FROM guarded
WHERE effective_label IN ('scale', 'refresh')
ORDER BY creative_id
`;

const FIND_RECOMMENDATIONS_QUERY = `
WITH snapshots AS (
  SELECT *
  FROM engine_v3_decision_snapshots_daily
  WHERE business_ref_id = $1::uuid
    AND creative_id = $2
    AND as_of_date BETWEEN ($3::date - ($4::integer * INTERVAL '1 day')) AND $3::date
),
guarded AS (
  SELECT
    snapshots.id,
    snapshots.as_of_date,
    CASE
      WHEN snapshots.label IN ('scale', 'refresh', 'cut')
        AND lifecycle.campaign_id IS NOT NULL
        AND labels.campaign_id IS NULL
      THEN 'diagnose'
      ELSE snapshots.label
    END AS label,
    CASE
      WHEN snapshots.label IN ('scale', 'refresh', 'cut')
        AND lifecycle.campaign_id IS NOT NULL
        AND labels.campaign_id IS NULL
      THEN LEAST(snapshots.confidence, 50)
      ELSE snapshots.confidence
    END AS confidence,
    snapshots.computed_at
  FROM snapshots
  LEFT JOIN LATERAL (
    SELECT lifecycle.campaign_id
    FROM engine_v3_creative_lifecycle_daily lifecycle
    WHERE lifecycle.business_ref_id = snapshots.business_ref_id
      AND lifecycle.creative_id = snapshots.creative_id
      AND lifecycle.engine_version = snapshots.engine_version
      AND lifecycle.as_of_date <= snapshots.as_of_date
    ORDER BY lifecycle.as_of_date DESC, lifecycle.computed_at DESC
    LIMIT 1
  ) lifecycle ON true
  LEFT JOIN meta_campaign_labels labels
    ON labels.business_id = COALESCE(snapshots.business_id, snapshots.business_ref_id::text)
   AND labels.campaign_id = lifecycle.campaign_id
)
SELECT id, as_of_date, label, confidence
FROM guarded
ORDER BY as_of_date ASC, computed_at ASC
`;

const FIND_LIFECYCLE_CONTEXT_QUERY = `
SELECT
  adset_id,
  campaign_id,
  ad_id,
  lifecycle_position,
  roas_7d,
  roas_28d,
  frequency_28d
FROM engine_v3_creative_lifecycle_daily
WHERE business_ref_id = $1::uuid
  AND creative_id = $2
  AND as_of_date = $3::date
  AND engine_version = $4
ORDER BY computed_at DESC
LIMIT 1
`;

const FIND_DAILY_SPEND_QUERY = `
SELECT
  d.date,
  SUM(d.spend)::double precision AS spend,
  SUM(d.conversions)::double precision AS purchases,
  (ARRAY_AGG(d.effective_status ORDER BY d.updated_at DESC NULLS LAST)
    FILTER (WHERE d.effective_status IS NOT NULL))[1] AS effective_status
FROM meta_creative_daily d
WHERE d.business_ref_id = $1::uuid
  AND d.creative_id = $2
  AND d.date BETWEEN ($3::date - ($4::integer * INTERVAL '1 day')) AND $3::date
GROUP BY d.date
ORDER BY d.date ASC
`;

const FIND_LATEST_CREATIVE_IDENTIFIERS_QUERY = `
SELECT DISTINCT ON (d.creative_id)
  d.adset_id,
  d.campaign_id,
  d.ad_id
FROM meta_creative_daily d
WHERE d.business_ref_id = $1::uuid
  AND d.creative_id = $2
  AND d.date <= $3::date
ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
`;

const FIND_RECENT_7D_FREQUENCY_QUERY = `
SELECT AVG(d.frequency) FILTER (
  WHERE d.frequency > 0
    AND d.date BETWEEN ($3::date - INTERVAL '6 days') AND $3::date
) AS recent7d_frequency
FROM meta_creative_daily d
WHERE d.business_ref_id = $1::uuid
  AND d.creative_id = $2
  AND d.date BETWEEN ($3::date - INTERVAL '27 days') AND $3::date
`;

const FIND_ADSET_BUDGET_HISTORY_QUERY = `
SELECT captured_at, daily_budget, lifetime_budget
FROM meta_adset_config_history
WHERE business_id = $1
  AND adset_id = $2
  AND captured_at >= ($3::date - ($4::integer * INTERVAL '1 day'))
  AND captured_at < ($3::date + INTERVAL '1 day')
ORDER BY captured_at ASC
`;

const FIND_CAMPAIGN_BUDGET_HISTORY_QUERY = `
SELECT captured_at, daily_budget, lifetime_budget
FROM meta_campaign_config_history
WHERE business_id = $1
  AND campaign_id = $2
  AND captured_at >= ($3::date - ($4::integer * INTERVAL '1 day'))
  AND captured_at < ($3::date + INTERVAL '1 day')
ORDER BY captured_at ASC
`;

const FIND_ACTION_JOURNAL_QUERY = `
WITH candidate AS (
  SELECT
    journal.created_at,
    journal.event_type,
    journal.action_title,
    journal.metadata_json,
    CASE
      WHEN POSITION(LOWER($2) IN LOWER(COALESCE(journal.metadata_json::text, ''))) > 0
        OR POSITION(LOWER($2) IN LOWER(COALESCE(journal.action_fingerprint, ''))) > 0
      THEN 'creative'
      WHEN $3::text IS NOT NULL AND (
        POSITION(LOWER($3) IN LOWER(COALESCE(journal.metadata_json::text, ''))) > 0
        OR POSITION(LOWER($3) IN LOWER(COALESCE(journal.action_fingerprint, ''))) > 0
      )
      THEN 'ad'
      WHEN $4::text IS NOT NULL AND (
        POSITION(LOWER($4) IN LOWER(COALESCE(journal.metadata_json::text, ''))) > 0
        OR POSITION(LOWER($4) IN LOWER(COALESCE(journal.action_fingerprint, ''))) > 0
      )
      THEN 'adset'
      WHEN $5::text IS NOT NULL AND (
        POSITION(LOWER($5) IN LOWER(COALESCE(journal.metadata_json::text, ''))) > 0
        OR POSITION(LOWER($5) IN LOWER(COALESCE(journal.action_fingerprint, ''))) > 0
      )
      THEN 'campaign'
    END AS match_level
  FROM command_center_action_journal journal
  WHERE journal.business_id = $1::uuid
    AND journal.created_at >= ($6::date - ($7::integer * INTERVAL '1 day'))
    AND journal.created_at < ($6::date + INTERVAL '1 day')
)
SELECT created_at, event_type, action_title, metadata_json, match_level
FROM candidate
WHERE match_level IS NOT NULL
ORDER BY created_at ASC
`;

const UPDATE_LIFECYCLE_RESPONSE_QUERY = `
UPDATE engine_v3_creative_lifecycle_daily
SET
  operator_response_type = $4,
  operator_response_detected_at = $5::timestamptz,
  decision_recommended_at = $6::timestamptz,
  lifecycle_position = COALESCE($7, lifecycle_position),
  updated_at = now()
WHERE business_ref_id = $1::uuid
  AND creative_id = $2
  AND as_of_date = $3::date
  AND engine_version = $8
RETURNING lifecycle_position
`;

const INSERT_OPERATOR_EVENTS_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid,
    business_id text,
    creative_id text,
    event_date date,
    operator_action_type text,
    operator_evidence jsonb,
    decision_snapshot_id uuid,
    job_run_id uuid
  )
)
INSERT INTO engine_v3_decision_events (
  business_ref_id,
  business_id,
  creative_id,
  event_date,
  event_type,
  operator_action_type,
  operator_evidence,
  decision_snapshot_id,
  job_run_id
)
SELECT
  payload.business_ref_id,
  payload.business_id,
  payload.creative_id,
  payload.event_date,
  'operator_action',
  payload.operator_action_type,
  payload.operator_evidence,
  payload.decision_snapshot_id,
  payload.job_run_id
FROM payload
WHERE NOT EXISTS (
  SELECT 1
  FROM engine_v3_decision_events existing
  WHERE existing.business_ref_id = payload.business_ref_id
    AND existing.creative_id = payload.creative_id
    AND existing.event_date = payload.event_date
    AND existing.event_type = 'operator_action'
    AND existing.operator_action_type IS NOT DISTINCT FROM payload.operator_action_type
)
RETURNING id
`;

export function operatorResponseJobAdvisoryLockKey(
  input: OperatorResponseJobInput,
): bigint {
  return hashAdvisoryLock(`${JOB_NAME}:${input.businessId}:${input.asOf}`);
}

export async function runOperatorResponseJob(
  input: OperatorResponseJobInput,
): Promise<OperatorResponseJobResult> {
  const startedAt = Date.now();
  const flags = await resolveEngineV3Flags(input.businessId);
  if (!flags.enabled) {
    return {
      jobRunId: "",
      dependencyRunId: null,
      status: "skipped",
      creativesEvaluated: 0,
      lifecycleRowsUpdated: 0,
      operatorEventsWritten: 0,
      lifecyclePromotions: 0,
      durationMs: Date.now() - startedAt,
      reason: "engine_v3_disabled",
    };
  }

  const lockKey = operatorResponseJobAdvisoryLockKey(input);

  return runDbTransaction(async () => {
    const db = getDb();
    const [lockRow] = await db.query<AdvisoryLockRow>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [lockKey.toString()],
    );
    const dependencyRunId = await findLatestSuccessfulDecisionsRun(input);

    if (lockRow?.acquired !== true) {
      const durationMs = Date.now() - startedAt;
      const jobRunId = await insertJobRun({
        businessId: input.businessId,
        asOf: input.asOf,
        status: "skipped",
        dependencyRunId,
        durationMs,
        rowCount: 0,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      });
      return {
        jobRunId,
        dependencyRunId,
        status: "skipped",
        creativesEvaluated: 0,
        lifecycleRowsUpdated: 0,
        operatorEventsWritten: 0,
        lifecyclePromotions: 0,
        durationMs,
        errorMessage: "Advisory lock not acquired (job may already be running)",
      };
    }

    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "running",
      dependencyRunId,
    });

    await db.query("SAVEPOINT engine_v3_operator_response_job_work");
    try {
      const recommendedCreatives = await findRecommendedCreativeIds(input);
      let lifecycleRowsUpdated = 0;
      let operatorEventsWritten = 0;
      let lifecyclePromotions = 0;

      for (const creativeId of recommendedCreatives) {
        const gathered = await gatherSignalInputs({
          creativeId,
          businessId: input.businessId,
          asOf: input.asOf,
        });
        const detection = detectOperatorResponse(gathered.detectorInput);
        if (detection.responseType === "no_recommendation") continue;

        const updatedRows = await updateLifecycleResponse({
          businessId: input.businessId,
          creativeId,
          asOf: input.asOf,
          detection,
        });
        lifecycleRowsUpdated += updatedRows.length;
        if (detection.promoteLifecyclePosition === "past_peak_inaction") {
          lifecyclePromotions += updatedRows.filter(
            (row) => row.lifecycle_position === "past_peak_inaction",
          ).length;
        }

        const eventPayload = toOperatorEventPayload({
          businessId: input.businessId,
          creativeId,
          asOf: input.asOf,
          jobRunId,
          decisionSnapshotId: gathered.firstRecommendationSnapshotId,
          detection,
        });
        operatorEventsWritten += await insertOperatorEvents(eventPayload);
      }

      const durationMs = Date.now() - startedAt;
      await db.query(
        `
        UPDATE engine_v3_job_runs
        SET
          status = 'success',
          finished_at = now(),
          duration_ms = $1::integer,
          row_count = $2::integer,
          error_json = $3::jsonb,
          updated_at = now()
        WHERE id = $4::uuid
        `,
        [
          durationMs,
          lifecycleRowsUpdated,
          JSON.stringify({
            metadata: {
              recommended_creative_count: recommendedCreatives.length,
              operator_event_count: operatorEventsWritten,
              lifecycle_promotion_count: lifecyclePromotions,
            },
          }),
          jobRunId,
        ],
      );

      return {
        jobRunId,
        dependencyRunId,
        status: "success",
        creativesEvaluated: recommendedCreatives.length,
        lifecycleRowsUpdated,
        operatorEventsWritten,
        lifecyclePromotions,
        durationMs,
      };
    } catch (error) {
      await db
        .query("ROLLBACK TO SAVEPOINT engine_v3_operator_response_job_work")
        .catch(() => undefined);
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await db
        .query(
          `
          UPDATE engine_v3_job_runs
          SET
            status = 'failed',
            finished_at = now(),
            duration_ms = $1::integer,
            row_count = 0,
            error_message = $2,
            error_json = $3::jsonb,
            updated_at = now()
          WHERE id = $4::uuid
          `,
          [durationMs, message, JSON.stringify(errorToJson(error)), jobRunId],
        )
        .catch(() => undefined);

      return {
        jobRunId,
        dependencyRunId,
        status: "failed",
        creativesEvaluated: 0,
        lifecycleRowsUpdated: 0,
        operatorEventsWritten: 0,
        lifecyclePromotions: 0,
        durationMs,
        errorMessage: message,
      };
    }
  });
}

async function findRecommendedCreativeIds(input: OperatorResponseJobInput) {
  const rows = await getDb().query<CreativeIdRow>(
    FIND_RECOMMENDED_CREATIVES_QUERY,
    [input.businessId, input.asOf, RESPONSE_WINDOW_DAYS],
  );
  return rows.flatMap((row) => {
    const creativeId = toStringOrNull(row.creative_id);
    return creativeId === null ? [] : [creativeId];
  });
}

async function gatherSignalInputs(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}): Promise<GatheredSignalInputs> {
  const [recommendationRows, lifecycleContext, dailySpend, latestIdentifiers] =
    await Promise.all([
      findRecommendations(input),
      findLifecycleContext(input),
      findDailySpend(input),
      findLatestCreativeIdentifiers(input),
    ]);

  const identifiers = {
    adsetId: lifecycleContext.adsetId ?? latestIdentifiers.adsetId,
    campaignId: lifecycleContext.campaignId ?? latestIdentifiers.campaignId,
    adId: lifecycleContext.adId ?? latestIdentifiers.adId,
  };
  const [adsetBudgetHistory, campaignBudgetHistory, actionJournal] =
    await Promise.all([
      identifiers.adsetId === null
        ? Promise.resolve([])
        : findAdsetBudgetHistory({
            businessId: input.businessId,
            adsetId: identifiers.adsetId,
            asOf: input.asOf,
          }),
      identifiers.campaignId === null
        ? Promise.resolve([])
        : findCampaignBudgetHistory({
            businessId: input.businessId,
            campaignId: identifiers.campaignId,
            asOf: input.asOf,
          }),
      findActionJournal({
        businessId: input.businessId,
        creativeId: input.creativeId,
        adId: identifiers.adId,
        adsetId: identifiers.adsetId,
        campaignId: identifiers.campaignId,
        asOf: input.asOf,
      }),
    ]);

  const recentRecommendations = recommendationRows
    .map(toRecommendation)
    .filter(
      (
        recommendation,
      ): recommendation is OperatorResponseInput["recentRecommendations"][number] =>
        recommendation !== null,
    );
  const firstRecommendationRow = [...recommendationRows]
    .filter((row) => {
      const label = toDecisionLabel(row.label);
      return label === "scale" || label === "refresh";
    })
    .sort(
      (left, right) =>
        (toIsoDateOnly(left.as_of_date) ?? "").localeCompare(
          toIsoDateOnly(right.as_of_date) ?? "",
        ),
    )[0];
  const firstRecommendationSnapshotId = toStringOrNull(
    firstRecommendationRow?.id,
  );

  return {
    firstRecommendationSnapshotId,
    detectorInput: {
      creativeId: input.creativeId,
      businessId: input.businessId,
      asOf: input.asOf,
      recentRecommendations,
      adsetBudgetHistory,
      campaignBudgetHistory,
      dailySpend,
      actionJournal,
      lifecyclePosition: lifecycleContext.lifecyclePosition,
      recent7dRoas: lifecycleContext.recent7dRoas,
      cumulative28dRoas: lifecycleContext.cumulative28dRoas,
      recent7dFrequency: await findRecent7dFrequency(input),
      cumulative28dFrequency: lifecycleContext.cumulative28dFrequency,
    },
  };
}

async function findRecommendations(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}) {
  return getDb().query<RecommendationRow>(FIND_RECOMMENDATIONS_QUERY, [
    input.businessId,
    input.creativeId,
    input.asOf,
    RESPONSE_WINDOW_DAYS,
  ]);
}

async function findLifecycleContext(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}) {
  const [row] = await getDb().query<LifecycleContextRow>(
    FIND_LIFECYCLE_CONTEXT_QUERY,
    [input.businessId, input.creativeId, input.asOf, ENGINE_VERSION],
  );
  return {
    adsetId: toStringOrNull(row?.adset_id),
    campaignId: toStringOrNull(row?.campaign_id),
    adId: toStringOrNull(row?.ad_id),
    lifecyclePosition: toStringOrNull(row?.lifecycle_position),
    recent7dRoas: toNumberOrNull(row?.roas_7d),
    cumulative28dRoas: toNumberOrNull(row?.roas_28d),
    cumulative28dFrequency: toNumberOrNull(row?.frequency_28d),
  };
}

async function findDailySpend(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}): Promise<OperatorResponseInput["dailySpend"]> {
  const rows = await getDb().query<DailySpendRow>(FIND_DAILY_SPEND_QUERY, [
    input.businessId,
    input.creativeId,
    input.asOf,
    RESPONSE_WINDOW_DAYS,
  ]);
  return rows.flatMap((row) => {
    const date = toIsoDateOnly(row.date);
    if (!date) return [];
    return [
      {
        date,
        spend: toNumberOrNull(row.spend) ?? 0,
        purchases: toNumberOrNull(row.purchases) ?? 0,
        effectiveStatus: toStringOrNull(row.effective_status),
      },
    ];
  });
}

async function findLatestCreativeIdentifiers(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}) {
  const [row] = await getDb().query<LifecycleContextRow>(
    FIND_LATEST_CREATIVE_IDENTIFIERS_QUERY,
    [input.businessId, input.creativeId, input.asOf],
  );
  return {
    adsetId: toStringOrNull(row?.adset_id),
    campaignId: toStringOrNull(row?.campaign_id),
    adId: toStringOrNull(row?.ad_id),
  };
}

async function findRecent7dFrequency(input: {
  creativeId: string;
  businessId: string;
  asOf: string;
}) {
  const [row] = await getDb().query<RecentFrequencyRow>(
    FIND_RECENT_7D_FREQUENCY_QUERY,
    [input.businessId, input.creativeId, input.asOf],
  );
  return toNumberOrNull(row?.recent7d_frequency);
}

async function findAdsetBudgetHistory(input: {
  businessId: string;
  adsetId: string;
  asOf: string;
}): Promise<OperatorResponseInput["adsetBudgetHistory"]> {
  const rows = await getDb().query<BudgetHistoryRow>(
    FIND_ADSET_BUDGET_HISTORY_QUERY,
    [input.businessId, input.adsetId, input.asOf, RESPONSE_WINDOW_DAYS + 1],
  );
  return rows.flatMap(toBudgetSnapshot);
}

async function findCampaignBudgetHistory(input: {
  businessId: string;
  campaignId: string;
  asOf: string;
}): Promise<OperatorResponseInput["campaignBudgetHistory"]> {
  const rows = await getDb().query<BudgetHistoryRow>(
    FIND_CAMPAIGN_BUDGET_HISTORY_QUERY,
    [input.businessId, input.campaignId, input.asOf, RESPONSE_WINDOW_DAYS + 1],
  );
  return rows.flatMap(toBudgetSnapshot);
}

async function findActionJournal(input: {
  businessId: string;
  creativeId: string;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  asOf: string;
}): Promise<OperatorResponseInput["actionJournal"]> {
  const rows = await getDb().query<ActionJournalRow>(FIND_ACTION_JOURNAL_QUERY, [
    input.businessId,
    input.creativeId,
    input.adId,
    input.adsetId,
    input.campaignId,
    input.asOf,
    RESPONSE_WINDOW_DAYS,
  ]);
  return rows.flatMap((row) => {
    const createdAt = toIsoTimestampOrNull(row.created_at);
    const eventType = toStringOrNull(row.event_type);
    const actionTitle = toStringOrNull(row.action_title);
    if (createdAt === null || eventType === null || actionTitle === null) {
      return [];
    }
    const matchLevel = toStringOrNull(row.match_level) ?? "creative";
    return [
      {
        createdAt,
        eventType,
        actionTitle,
        metadata: {
          ...toRecord(row.metadata_json),
          operator_response_match_level: matchLevel,
          operator_response_confidence_multiplier:
            matchLevel === "creative" ? 1 : 0.85,
        },
      },
    ];
  });
}

async function updateLifecycleResponse(input: {
  businessId: string;
  creativeId: string;
  asOf: string;
  detection: OperatorResponseResult;
}) {
  const lifecycleResponseType = mapResponseToLifecycleColumn(
    input.detection.responseType,
  );
  if (lifecycleResponseType === null) return [];

  return getDb().query<UpdatedLifecycleRow>(UPDATE_LIFECYCLE_RESPONSE_QUERY, [
    input.businessId,
    input.creativeId,
    input.asOf,
    lifecycleResponseType,
    input.detection.operatorResponseDetectedAt,
    input.detection.decisionRecommendedAt,
    input.detection.confidence >= 0.7
      ? input.detection.promoteLifecyclePosition ?? null
      : null,
    ENGINE_VERSION,
  ]);
}

async function insertOperatorEvents(rows: OperatorEventPayloadRow[]) {
  if (rows.length === 0) return 0;
  const insertedRows = await getDb().query<InsertedEventRow>(
    INSERT_OPERATOR_EVENTS_QUERY,
    [JSON.stringify(rows)],
  );
  return insertedRows.length;
}

async function findLatestSuccessfulDecisionsRun(input: OperatorResponseJobInput) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    SELECT id
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND business_ref_id = $2::uuid
      AND as_of_date = $3::date
      AND engine_version = $4
      AND status = 'success'
    ORDER BY finished_at DESC NULLS LAST, started_at DESC
    LIMIT 1
    `,
    [DECISIONS_JOB_NAME, input.businessId, input.asOf, ENGINE_VERSION],
  );

  return toStringOrNull(row?.id);
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: JobStatus | "running";
  dependencyRunId: string | null;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, dependency_run_id, finished_at, duration_ms, row_count, error_message
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, $7::uuid, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $8::integer, $9::integer, $10
    )
    RETURNING id
    `,
    [
      JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      ENGINE_VERSION,
      input.status,
      input.dependencyRunId,
      input.durationMs ?? null,
      input.rowCount ?? null,
      input.errorMessage ?? null,
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Operator response job run insert did not return an id.");
  }
  return id;
}

function toRecommendation(
  row: RecommendationRow,
): OperatorResponseInput["recentRecommendations"][number] | null {
  const decisionDate = toIsoDateOnly(row.as_of_date);
  const label = toDecisionLabel(row.label);
  if (decisionDate === null || label === null) return null;
  return {
    decisionDate,
    label,
    confidence: toNumberOrNull(row.confidence) ?? 0,
  };
}

function toBudgetSnapshot(row: BudgetHistoryRow) {
  const capturedAt = toIsoTimestampOrNull(row.captured_at);
  if (capturedAt === null) return [];
  return [
    {
      capturedAt,
      dailyBudget: toNumberOrNull(row.daily_budget),
      lifetimeBudget: toNumberOrNull(row.lifetime_budget),
    },
  ];
}

function toOperatorEventPayload(input: {
  businessId: string;
  creativeId: string;
  asOf: string;
  jobRunId: string;
  decisionSnapshotId: string | null;
  detection: OperatorResponseResult;
}): OperatorEventPayloadRow[] {
  const operatorActionType = mapResponseToOperatorActionEvent(
    input.detection.responseType,
  );
  if (operatorActionType === null) return [];
  if (
    input.detection.responseType === "unknown" &&
    !hasActionLikeSignal(input.detection)
  ) {
    return [];
  }

  return [
    {
      business_ref_id: input.businessId,
      business_id: input.businessId,
      creative_id: input.creativeId,
      event_date:
        toIsoDateOnly(input.detection.operatorResponseDetectedAt) ?? input.asOf,
      operator_action_type: operatorActionType,
      operator_evidence: {
        response_type: input.detection.responseType,
        confidence: input.detection.confidence,
        evidence: input.detection.evidence,
        decision_recommended_at: input.detection.decisionRecommendedAt,
        operator_response_detected_at:
          input.detection.operatorResponseDetectedAt,
        signals: input.detection.signals,
        lifecycle_promotion: input.detection.promoteLifecyclePosition ?? null,
        engine_version: ENGINE_VERSION,
      },
      decision_snapshot_id: input.decisionSnapshotId,
      job_run_id: input.jobRunId,
    },
  ];
}

function hasActionLikeSignal(detection: OperatorResponseResult) {
  return (
    detection.signals.actionJournalReceiptCount > 0 ||
    detection.signals.statusChanged ||
    (detection.signals.budgetChangeAmount !== null &&
      detection.signals.budgetChangeAmount !== 0)
  );
}

function mapResponseToLifecycleColumn(
  responseType: OperatorResponseType,
): LifecycleOperatorResponseType | null {
  switch (responseType) {
    case "scaled":
    case "scaled_natural_saturation":
      return "scaled";
    case "ignored":
      return "ignored";
    case "paused":
      return "paused";
    case "creative_archived":
      return "creative_archived";
    case "budget_decreased":
      return "budget_cut";
    case "unknown":
      return "unknown";
    case "no_recommendation":
      return null;
  }
}

function mapResponseToOperatorActionEvent(
  responseType: OperatorResponseType,
): OperatorActionEventType | null {
  switch (responseType) {
    case "scaled":
    case "scaled_natural_saturation":
      return "scaled";
    case "paused":
      return "paused";
    case "creative_archived":
      return "creative_archived";
    case "budget_decreased":
      return "budget_decreased";
    case "unknown":
      return "unknown";
    case "ignored":
    case "no_recommendation":
      return null;
  }
}

function toDecisionLabel(value: unknown): DecisionLabel | null {
  const text = toStringOrNull(value);
  if (
    text === "scale" ||
    text === "keep" ||
    text === "refresh" ||
    text === "cut" ||
    text === "test_more" ||
    text === "diagnose" ||
    text === "out_of_scope"
  ) {
    return text;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return toRecord(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoDateOnly(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const trimmed = value.trim();
    const datePrefix = /^\d{4}-\d{2}-\d{2}/.exec(trimmed)?.[0] ?? null;
    if (datePrefix !== null) return datePrefix;
    const parsed = new Date(trimmed);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}
