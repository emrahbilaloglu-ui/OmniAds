import { parseMetaPurchaseActions } from "@/lib/meta/purchase-count-parse";
import { buildMetaCompleteWindowSql } from "@/lib/meta/funnel-stage-parse";
import { creativeDayDecisionBearingActivitySql } from "@/lib/meta/creative-day-metric-evidence";

/** Additive to metric_evidence.v1: existing verified funnel stages remain readable. */
export const META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION =
  "meta-creative-day-purchase-evidence.v1";
export const META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY = "purchase_evidence";

export type MetaCreativeDayPurchaseEvidence = {
  version: typeof META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION;
  source: "meta_actions";
  state: "measured" | "unmeasurable" | "unreadable" | "incomplete";
  value?: number;
  reason?: "actions_absent" | "actions_invalid_or_conflicting" | "merged_partial" | "evidence_absent" | "source_scalar_conflict";
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function buildMetaCreativeDayPurchaseEvidence(
  actions: unknown,
  options: { completeActionsRequest?: boolean } = {},
): MetaCreativeDayPurchaseEvidence {
  // Graph omits the entire actions field on zero-event Ad rows. This is a zero
  // only when the caller proves that actions was requested on a complete page
  // set. A partial/best-effort response cannot make the same claim.
  if (actions === undefined && options.completeActionsRequest === true) {
    return { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
      source: "meta_actions", state: "measured", value: 0 };
  }
  const value = parseMetaPurchaseActions(actions);
  if (value !== null) {
    return { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
      source: "meta_actions", state: "measured", value };
  }
  const absent = actions === undefined;
  return { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
    source: "meta_actions", state: absent ? "unmeasurable" : "unreadable",
    reason: absent ? "actions_absent" : "actions_invalid_or_conflicting" };
}

export function parseMetaCreativeDayPurchaseEvidence(raw: unknown): MetaCreativeDayPurchaseEvidence | null {
  const value = record(raw);
  if (!value || value.version !== META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION ||
      value.source !== "meta_actions") return null;
  if (value.state === "measured") {
    return typeof value.value === "number" && Number.isSafeInteger(value.value) && value.value >= 0
      ? { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
          source: "meta_actions", state: "measured", value: value.value }
      : null;
  }
  const reasons = {
    unmeasurable: "actions_absent",
    unreadable: "actions_invalid_or_conflicting",
    incomplete: ["merged_partial", "evidence_absent", "source_scalar_conflict"],
  } as const;
  if (value.state === "unmeasurable" && value.reason === reasons.unmeasurable ||
      value.state === "unreadable" && value.reason === reasons.unreadable ||
      value.state === "incomplete" && reasons.incomplete.some((reason) => reason === value.reason)) {
    return { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
      source: "meta_actions", state: value.state, reason: value.reason as MetaCreativeDayPurchaseEvidence["reason"] };
  }
  return null;
}

export function readMetaCreativeDayPurchaseEvidence(payload: unknown): MetaCreativeDayPurchaseEvidence | null {
  return parseMetaCreativeDayPurchaseEvidence(record(payload)?.[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY]);
}

/** A stored creative scalar is accepted only when it agrees with the raw-action stamp. */
export function readMetaCreativeDayPurchases(payload: unknown, storedConversions: unknown): number | null {
  const evidence = readMetaCreativeDayPurchaseEvidence(payload);
  return evidence?.state === "measured" && evidence.value === storedConversions
    ? evidence.value! : null;
}

/** A fresh provider observation cannot certify a different finalized Ad-day scalar. */
export function constrainMetaCreativeDayPurchaseEvidenceToScalar(
  raw: unknown, storedConversions: unknown,
): MetaCreativeDayPurchaseEvidence | null {
  const evidence = parseMetaCreativeDayPurchaseEvidence(raw);
  if (!evidence) return null;
  return evidence.state === "measured" && evidence.value !== storedConversions
    ? { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
        source: "meta_actions", state: "incomplete", reason: "source_scalar_conflict" }
    : evidence;
}

export function mergeMetaCreativeDayPurchaseEvidence(a: unknown, b: unknown): MetaCreativeDayPurchaseEvidence {
  const left = parseMetaCreativeDayPurchaseEvidence(a);
  const right = parseMetaCreativeDayPurchaseEvidence(b);
  const base = { version: META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION,
    source: "meta_actions" } as const;
  if (!left || !right) return { ...base, state: "incomplete", reason: "evidence_absent" };
  if (left.state !== "measured" || right.state !== "measured") {
    return { ...base, state: "incomplete", reason: "merged_partial" };
  }
  const sum = left.value! + right.value!;
  return Number.isSafeInteger(sum)
    ? { ...base, state: "measured", value: sum }
    : { ...base, state: "unreadable", reason: "actions_invalid_or_conflicting" };
}

export function mergeCarriedMetaCreativeDayPurchaseEvidence(rows: readonly unknown[]): MetaCreativeDayPurchaseEvidence | null {
  const evidence = rows.map((row) => record(row)?.[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY]);
  if (evidence.every((value) => value == null)) return null;
  if (evidence.length === 1) return parseMetaCreativeDayPurchaseEvidence(evidence[0]);
  return evidence.slice(1).reduce<unknown>(
    (merged, next) => mergeMetaCreativeDayPurchaseEvidence(merged, next), evidence[0],
  ) as MetaCreativeDayPurchaseEvidence;
}

export function withMetaCreativeDayPurchaseEvidence<T extends object>(
  row: T, evidence: MetaCreativeDayPurchaseEvidence | null,
): T & { purchase_evidence?: MetaCreativeDayPurchaseEvidence } {
  return evidence ? { ...row, [META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY]: evidence } : row;
}

export function mergeMetaCreativeDayPayloadPurchaseEvidence(input: {
  basePayload: unknown; left: unknown; right: unknown;
}): unknown {
  const left = record(input.left)?.[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY];
  const right = record(input.right)?.[META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY];
  if (left == null && right == null) return input.basePayload;
  const evidence = mergeMetaCreativeDayPurchaseEvidence(left, right);
  return { ...(record(input.basePayload) ?? {}),
    [META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY]: evidence };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const PAYLOAD = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
export function buildMetaCreativeDayPurchasesSql(options: {
  payloadExpression: string; conversionsExpression: string;
}): string {
  const { payloadExpression, conversionsExpression } = options;
  if (!PAYLOAD.test(payloadExpression) || !PAYLOAD.test(conversionsExpression)) {
    throw new Error("creative_day_purchase_sql_expression_invalid");
  }
  const stamp = `${payloadExpression}->'${META_CREATIVE_DAY_PURCHASE_EVIDENCE_KEY}'`;
  const value = `(${stamp}->>'value')`;
  return `(CASE WHEN (${stamp}->>'version') IS NOT DISTINCT FROM '${META_CREATIVE_DAY_PURCHASE_EVIDENCE_VERSION}'
      AND (${stamp}->>'source') IS NOT DISTINCT FROM 'meta_actions'
      AND (${stamp}->>'state') IS NOT DISTINCT FROM 'measured'
      AND jsonb_typeof(${stamp}->'value') IS NOT DISTINCT FROM 'number'
      THEN CASE WHEN ${value} ~ '^[0-9]{1,16}$'
      THEN CASE WHEN ${value}::numeric <= 9007199254740991
        AND ${value}::numeric = ${conversionsExpression}
        THEN ${value}::double precision END END END)`;
}

/** Complete-or-NULL over every decision-bearing creative day. */
export function buildMetaCreativePurchaseWindowSql(options: {
  valueSql: string; activitySql: string; rowFilterSql?: string;
}): string {
  return buildMetaCompleteWindowSql({
    valueSql: options.valueSql,
    missingSql: `(${options.valueSql} IS NULL)`,
    activitySql: options.activitySql,
    rowFilterSql: options.rowFilterSql,
  }).sumSql;
}

export function buildMetaCreativePurchaseLateralSql(options: {
  rowAlias: string; lateralAlias: string;
}) {
  const { rowAlias, lateralAlias } = options;
  if (!IDENTIFIER.test(rowAlias) || !IDENTIFIER.test(lateralAlias)) {
    throw new Error("creative_day_purchase_sql_alias_invalid");
  }
  const valueSql = buildMetaCreativeDayPurchasesSql({
    payloadExpression: `${rowAlias}.payload_json`,
    conversionsExpression: `${rowAlias}.conversions`,
  });
  return {
    lateralSql: `CROSS JOIN LATERAL (SELECT ${valueSql} AS purchases,
      ${creativeDayDecisionBearingActivitySql(rowAlias)} AS decision_bearing_activity
      OFFSET 0) ${lateralAlias}`,
    valueSql: `${lateralAlias}.purchases`,
    activitySql: `${lateralAlias}.decision_bearing_activity`,
  };
}
