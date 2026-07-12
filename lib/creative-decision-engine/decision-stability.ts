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
import { ENGINE_VERSION } from "./types";
import type { DecisionBadge, DecisionLabel, DecisionOutput } from "./types";

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set([
  "cut",
  "refresh",
  "scale",
]);

export interface PreviousPublishedLabel {
  publishedLabel: DecisionLabel;
  rawLabel: DecisionLabel | null;
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
export function stabilizeDecisionLabel(
  decision: DecisionOutput,
  previous: PreviousPublishedLabel | null | undefined,
): { decision: DecisionOutput; rawLabel: DecisionLabel; suppressed: boolean } {
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
    },
    rawLabel: result.rawLabel,
    suppressed: true,
  };
}

type Row = Record<string, unknown>;

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
    const creativeId = typeof row.creative_id === "string" ? row.creative_id : null;
    const label = typeof row.label === "string" && validLabels.has(row.label)
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
