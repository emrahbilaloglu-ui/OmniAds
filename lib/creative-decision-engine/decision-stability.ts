// Decision-label stability (hard-label hysteresis).
//
// Live evidence 2026-07-04..06 showed hard-action round trips across adjacent
// evaluations. D036 makes the stability rule asymmetric: leaving a hard action
// is immediate so safety/authority exits can never resurrect yesterday's
// action; entering a hard action requires two consecutive evaluations. A
// direct hard-to-hard switch publishes a neutral pending state for one
// evaluation. The raw label is persisted alongside the published label so the
// confirmation rule has one evaluation of memory.
import { getDb } from "@/lib/db";
import { ENGINE_VERSION, NATIVE_AD_ENGINE_VERSION } from "./types";
import type {
  AdDecisionOutput,
  DecisionBadge,
  DecisionLabel,
  DecisionOutput,
} from "./types";

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set([
  "cut",
  "refresh",
  "scale",
]);

export interface PreviousPublishedLabel {
  publishedLabel: DecisionLabel;
  rawLabel: DecisionLabel | null;
}

export interface AdDecisionStabilityIdentity {
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
}

export interface PreviousAdPublishedLabel extends PreviousPublishedLabel {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
  sourceSnapshotId: string;
  sourceEvaluationId: string;
  sourceEngineVersion: string;
  sourceAsOfDate: string;
  sourceComputedAt: string;
  sourceInputHash: string;
  sourceDecisionHash: string;
}

export interface LabelHysteresisResult {
  publishedLabel: DecisionLabel;
  rawLabel: DecisionLabel;
  suppressed: boolean;
}

function isHardLabel(label: DecisionLabel) {
  return HARD_LABELS.has(label);
}

export function applyLabelHysteresis(
  rawLabel: DecisionLabel,
  previous: PreviousPublishedLabel | null | undefined,
): LabelHysteresisResult {
  if (!previous) {
    return isHardLabel(rawLabel)
      ? { publishedLabel: "keep", rawLabel, suppressed: true }
      : { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  if (rawLabel === previous.publishedLabel) {
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  // Safety and authority exits dominate stability: once today's guarded
  // decision is soft, the earlier hard action loses authority immediately.
  if (!isHardLabel(rawLabel)) {
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }

  const previousRaw = previous.rawLabel ?? previous.publishedLabel;
  if (rawLabel === previousRaw) {
    // Second consecutive evaluation with the same new label: confirmed.
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }

  // Every unconfirmed hard entry uses one canonical, non-actionable tuple.
  // Reusing diagnose/out_of_scope here would combine yesterday's verdict with
  // today's hard-action evidence and create a semantically hybrid row.
  return {
    publishedLabel: "keep",
    rawLabel,
    suppressed: true,
  };
}

export const PENDING_TRANSITION_BADGE: DecisionBadge = {
  type: "pending_transition",
  label:
    "Hard action pending - the signal must hold a second evaluation before it is published",
  severity: "info",
};

export function withPendingTransitionBadge(
  badges: readonly DecisionBadge[],
): DecisionBadge[] {
  if (badges.some((badge) => badge.type === "pending_transition")) {
    return [...badges];
  }
  return [...badges, PENDING_TRANSITION_BADGE];
}

/**
 * Applies hard-action hysteresis to a guarded decision. A suppressed hard
 * entry publishes a non-hard state, keeps the intended action only as
 * blockedActionType/rawLabel provenance, and explicitly says that no hard
 * action is currently published.
 */
export function stabilizeDecisionLabel<
  TDecision extends DecisionOutput | AdDecisionOutput,
>(
  decision: TDecision,
  previous: PreviousPublishedLabel | null | undefined,
): { decision: TDecision; rawLabel: DecisionLabel; suppressed: boolean } {
  const result = applyLabelHysteresis(decision.label, previous);
  if (!result.suppressed) {
    return { decision, rawLabel: result.rawLabel, suppressed: false };
  }
  return {
    decision: {
      ...decision,
      label: result.publishedLabel,
      blockedActionType: result.rawLabel,
      badges: withPendingTransitionBadge(decision.badges),
      reason: `[Pending hard action: ${result.rawLabel}] No hard action is published until this signal repeats on the next evaluation. Current evidence: ${decision.reason}`,
    } as TDecision,
    rawLabel: result.rawLabel,
    suppressed: true,
  };
}

type Row = Record<string, unknown>;

function requiredText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function adDecisionStabilityKey(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
  scopeType: "account" | "campaign";
  scopeId: string;
}): string {
  return [
    input.businessId,
    input.providerAccountRefId,
    input.providerAccountId,
    input.decisionEntityType,
    input.decisionEntityId,
    input.scopeType,
    input.scopeId,
  ].join("\u0000");
}

export const READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY = `
WITH identities AS (
  SELECT *
  FROM jsonb_to_recordset($3::jsonb) AS row(
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text
  )
)
SELECT DISTINCT ON (
  snapshot.provider_account_id,
  snapshot.decision_entity_type,
  snapshot.decision_entity_id
)
  snapshot.id::text AS source_snapshot_id,
  snapshot.provider_account_ref_id::text,
  snapshot.provider_account_id,
  snapshot.decision_entity_type,
  snapshot.decision_entity_id,
  snapshot.as_of_date::text AS source_as_of_date,
  snapshot.computed_at::text AS source_computed_at,
  snapshot.engine_version AS source_engine_version,
  snapshot.label,
  snapshot.raw_label,
  snapshot.evaluation_id::text AS source_evaluation_id,
  snapshot.input_hash::text AS source_input_hash,
  snapshot.decision_hash::text AS source_decision_hash
FROM engine_v3_ad_decision_snapshots_daily snapshot
INNER JOIN identities identity
  ON identity.provider_account_ref_id = snapshot.provider_account_ref_id
 AND identity.provider_account_id = snapshot.provider_account_id
 AND identity.decision_entity_type = snapshot.decision_entity_type
 AND identity.decision_entity_id = snapshot.decision_entity_id
INNER JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = snapshot.evaluation_id
 AND evaluation.business_ref_id = snapshot.business_ref_id
 AND evaluation.business_id = snapshot.business_id
 AND evaluation.provider_account_ref_id = snapshot.provider_account_ref_id
 AND evaluation.provider_account_id = snapshot.provider_account_id
 AND evaluation.decision_entity_type = snapshot.decision_entity_type
 AND evaluation.decision_entity_id = snapshot.decision_entity_id
 AND evaluation.as_of_date = snapshot.as_of_date
 AND evaluation.engine_version = snapshot.engine_version
 AND evaluation.scope_type = snapshot.scope_type
 AND evaluation.scope_id = snapshot.scope_id
 AND evaluation.input_hash = snapshot.input_hash
 AND evaluation.decision_hash = snapshot.decision_hash
 AND evaluation.job_run_id = snapshot.job_run_id
WHERE snapshot.business_ref_id = $1::uuid
  AND snapshot.engine_version = $2
  AND snapshot.as_of_date < $4::date
  AND snapshot.scope_type = $5
  AND snapshot.scope_id = $6
ORDER BY
  snapshot.provider_account_id,
  snapshot.decision_entity_type,
  snapshot.decision_entity_id,
  snapshot.as_of_date DESC,
  snapshot.computed_at DESC,
  snapshot.id DESC
`;

export async function readPreviousPublishedAdLabels(input: {
  businessId: string;
  asOf: string;
  identities: AdDecisionStabilityIdentity[];
  scopeType?: "account" | "campaign";
  scopeId?: string;
}): Promise<Map<string, PreviousAdPublishedLabel>> {
  if (input.identities.length === 0) return new Map();
  const scopeType = input.scopeType ?? "account";
  const scopeId = input.scopeId ?? "*";
  const rows = await getDb().query<Row>(
    READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY,
    [
      input.businessId,
      NATIVE_AD_ENGINE_VERSION,
      JSON.stringify(
        input.identities.map((identity) => ({
          provider_account_id: identity.providerAccountId,
          provider_account_ref_id: identity.providerAccountRefId,
          decision_entity_type: identity.decisionEntityType,
          decision_entity_id: identity.decisionEntityId,
        })),
      ),
      input.asOf,
      scopeType,
      scopeId,
    ],
  );
  const map = new Map<string, PreviousAdPublishedLabel>();
  for (const row of rows) {
    const providerAccountId = requiredText(row.provider_account_id);
    const providerAccountRefId = requiredText(row.provider_account_ref_id);
    const decisionEntityId = requiredText(row.decision_entity_id);
    const sourceSnapshotId = requiredText(row.source_snapshot_id);
    const sourceEvaluationId = requiredText(row.source_evaluation_id);
    const sourceEngineVersion = requiredText(row.source_engine_version);
    const sourceAsOfDate = requiredText(row.source_as_of_date);
    const sourceComputedAt = requiredText(row.source_computed_at);
    const sourceInputHash = requiredText(row.source_input_hash);
    const sourceDecisionHash = requiredText(row.source_decision_hash);
    const label = toPersistedDecisionLabel(row.label);
    const rawLabel = toPersistedDecisionLabel(row.raw_label);
    if (
      providerAccountId === null ||
      providerAccountRefId === null ||
      decisionEntityId === null ||
      sourceSnapshotId === null ||
      sourceEvaluationId === null ||
      sourceEngineVersion === null ||
      sourceAsOfDate === null ||
      sourceComputedAt === null ||
      sourceInputHash === null ||
      sourceDecisionHash === null ||
      label === null ||
      row.decision_entity_type !== "ad"
    ) {
      throw new Error("Persisted ad hysteresis lineage is incomplete.");
    }
    const value: PreviousAdPublishedLabel = {
      businessId: input.businessId,
      providerAccountRefId,
      providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId,
      sourceSnapshotId,
      sourceEvaluationId,
      sourceEngineVersion,
      sourceAsOfDate,
      sourceComputedAt,
      sourceInputHash,
      sourceDecisionHash,
      publishedLabel: label,
      rawLabel,
    };
    map.set(
      adDecisionStabilityKey({
        businessId: input.businessId,
        providerAccountRefId,
        providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId,
        scopeType,
        scopeId,
      }),
      value,
    );
  }
  return map;
}

function toPersistedDecisionLabel(value: unknown): DecisionLabel | null {
  return value === "scale" ||
    value === "keep" ||
    value === "refresh" ||
    value === "cut" ||
    value === "test_more" ||
    value === "diagnose" ||
    value === "out_of_scope"
    ? value
    : null;
}

/**
 * Latest published+raw labels per creative before asOf for the current engine
 * version. Used by live surfaces (briefing) to publish the same stabilized
 * labels as the persisted decisions job.
 */
export async function readPreviousPublishedLabels(input: {
  businessId: string;
  asOf: string;
  creativeIds: string[];
  scopeType?: "account" | "campaign";
  scopeId?: string;
}): Promise<Map<string, PreviousPublishedLabel>> {
  if (input.creativeIds.length === 0) {
    return new Map();
  }
  const scopeType = input.scopeType ?? "account";
  const scopeId = input.scopeId ?? "*";
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (creative_id)
      creative_id, label, raw_label
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id::text = $1
      AND engine_version = $2
      AND creative_id = ANY($3::text[])
      AND as_of_date < $4::date
      AND scope_type = $5
      AND scope_id = $6
    ORDER BY creative_id, as_of_date DESC, computed_at DESC
    `,
    [
      input.businessId,
      ENGINE_VERSION,
      input.creativeIds,
      input.asOf,
      scopeType,
      scopeId,
    ],
  );
  const map = new Map<string, PreviousPublishedLabel>();
  const validLabels: ReadonlySet<string> = new Set([
    "scale",
    "keep",
    "refresh",
    "cut",
    "test_more",
    "diagnose",
    "out_of_scope",
  ]);
  for (const row of rows) {
    const creativeId =
      typeof row.creative_id === "string" ? row.creative_id : null;
    const label =
      typeof row.label === "string" && validLabels.has(row.label)
        ? (row.label as DecisionLabel)
        : null;
    const rawLabel =
      typeof row.raw_label === "string" && validLabels.has(row.raw_label)
        ? (row.raw_label as DecisionLabel)
        : null;
    if (!creativeId || !label) continue;
    map.set(creativeId, { publishedLabel: label, rawLabel });
  }
  return map;
}
