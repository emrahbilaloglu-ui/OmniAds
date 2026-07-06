// Decision-label stability (hard-label hysteresis).
//
// Live evidence 2026-07-04..06 showed three creatives round-tripping hard
// labels across consecutive days (IwaStore 946471284944193 scale->keep->scale,
// TheSwaf 1962656064410174 cut->keep->cut, Tiles 25889037484086563
// keep->cut->keep) because ratio/recent-hold boundaries are re-estimated
// daily. Rule: a transition that crosses the hard-action boundary
// (cut/scale on either side) publishes only after the new raw label holds for
// two consecutive evaluations; the suppressed day republishes the previous
// published label with a pending_transition badge. Soft<->soft transitions
// publish immediately. The raw label is persisted alongside the published
// label so the confirmation rule has one day of memory.
import { getDb } from "@/lib/db";
import { ENGINE_VERSION } from "./types";
import type { DecisionBadge, DecisionLabel, DecisionOutput } from "./types";

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set(["cut", "scale"]);

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
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  if (rawLabel === previous.publishedLabel) {
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  const crossesHardBoundary =
    isHardLabel(rawLabel) || isHardLabel(previous.publishedLabel);
  if (!crossesHardBoundary) {
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  const previousRaw = previous.rawLabel ?? previous.publishedLabel;
  if (rawLabel === previousRaw) {
    // Second consecutive evaluation with the same new label: confirmed.
    return { publishedLabel: rawLabel, rawLabel, suppressed: false };
  }
  return {
    publishedLabel: previous.publishedLabel,
    rawLabel,
    suppressed: true,
  };
}

export const PENDING_TRANSITION_BADGE: DecisionBadge = {
  type: "pending_transition",
  label:
    "Label transition pending - new signal must hold a second evaluation before the published decision changes",
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
 * Applies hard-label hysteresis to a guarded decision. When suppressed, the
 * published decision keeps yesterday's label with a pending_transition badge
 * and the raw label is reported for persistence/audit.
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
      badges: withPendingTransitionBadge(decision.badges),
      reason: `[Pending transition - held at previous decision] ${decision.reason}`,
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
}): Promise<Map<string, PreviousPublishedLabel>> {
  if (input.creativeIds.length === 0) {
    return new Map();
  }
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (creative_id)
      creative_id, label, raw_label
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id::text = $1
      AND engine_version = $2
      AND creative_id = ANY($3::text[])
      AND as_of_date < $4::date
      AND scope_type = 'account'
      AND scope_id = '*'
    ORDER BY creative_id, as_of_date DESC, computed_at DESC
    `,
    [input.businessId, ENGINE_VERSION, input.creativeIds, input.asOf],
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
