import { getDb } from "@/lib/db";

export type MetaEntitySignalScopeType = "campaign" | "adset";
export type MetaEntitySignalQualityStatus =
  | "ready"
  | "partial"
  | "missing"
  | "stale"
  | "unsupported";

export type MetaLearningState =
  | "LEARNING"
  | "LEARNING_LIMITED"
  | "OPTIMAL_LEARNING_DONE";

export interface MetaEntityDecisionSignal {
  businessId: string;
  providerAccountId: string | null;
  scopeType: MetaEntitySignalScopeType;
  scopeId: string;
  asOfDate: string;
  learningState: MetaLearningState | null;
  daysAtLearningState: number | null;
  lastSignificantEditAt: string | null;
  daysSinceSignificantEdit: number | null;
  recentChangeCooldownUntil: string | null;
  creativeAgeDays: number | null;
  creativeAgeDaysMax: number | null;
  frequencyP80: number | null;
  ctrDecayPct: number | null;
  audienceOverlapPct?: number | null;
  audienceSize?: number | null;
  lookalikePct?: number | null;
  audienceStage?: string | null;
  feedDisapprovalCount?: number | null;
  feedStatus?: string | null;
  dedupRatePct?: number | null;
  metaToCrmRatio?: number | null;
  trackingQualityStatus?: string | null;
  sourceJson: Record<string, unknown>;
  qualityStatus: MetaEntitySignalQualityStatus;
  computedAt?: string | null;
}

export function metaEntitySignalKey(input: {
  scopeType: MetaEntitySignalScopeType;
  scopeId: string;
}) {
  return `${input.scopeType}:${input.scopeId}`;
}

function normalizeDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : text.slice(0, 10);
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return String(value);
}

function numberOrNull(value: unknown) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function learningStateOrNull(value: unknown): MetaLearningState | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "LEARNING") return "LEARNING";
  if (normalized === "LEARNING_LIMITED") return "LEARNING_LIMITED";
  if (normalized === "OPTIMAL_LEARNING_DONE") return "OPTIMAL_LEARNING_DONE";
  return null;
}

function qualityStatusOrDefault(value: unknown): MetaEntitySignalQualityStatus {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "ready" ||
    normalized === "partial" ||
    normalized === "missing" ||
    normalized === "stale" ||
    normalized === "unsupported"
  ) {
    return normalized;
  }
  return "missing";
}

export async function readMetaEntityDecisionSignalsDaily(input: {
  businessId: string;
  asOfDate: string;
}): Promise<Map<string, MetaEntityDecisionSignal>> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT
        business_id,
        provider_account_id,
        scope_type,
        scope_id,
        as_of_date::text AS as_of_date,
        learning_state,
        days_at_learning_state,
        last_significant_edit_at,
        days_since_significant_edit,
        recent_change_cooldown_until,
        creative_age_days,
        creative_age_days_max,
        frequency_p80,
        ctr_decay_pct,
        audience_overlap_pct,
        audience_size,
        lookalike_pct,
        audience_stage,
        feed_disapproval_count,
        feed_status,
        dedup_rate_pct,
        meta_to_crm_ratio,
        tracking_quality_status,
        source_json,
        quality_status,
        computed_at
      FROM meta_entity_decision_signals_daily
      WHERE business_id = ${input.businessId}
        AND as_of_date = ${normalizeDate(input.asOfDate)}
    `) as Array<{
      business_id: string;
      provider_account_id: string | null;
      scope_type: MetaEntitySignalScopeType;
      scope_id: string;
      as_of_date: string;
      learning_state: string | null;
      days_at_learning_state: number | null;
      last_significant_edit_at: string | null;
      days_since_significant_edit: number | null;
      recent_change_cooldown_until: string | null;
      creative_age_days: number | null;
      creative_age_days_max: number | null;
      frequency_p80: number | null;
      ctr_decay_pct: number | null;
      audience_overlap_pct: number | null;
      audience_size: number | null;
      lookalike_pct: number | null;
      audience_stage: string | null;
      feed_disapproval_count: number | null;
      feed_status: string | null;
      dedup_rate_pct: number | null;
      meta_to_crm_ratio: number | null;
      tracking_quality_status: string | null;
      source_json: Record<string, unknown> | null;
      quality_status: string | null;
      computed_at: string | null;
    }>;

    return new Map(
      rows.map((row) => [
        metaEntitySignalKey({ scopeType: row.scope_type, scopeId: row.scope_id }),
        {
          businessId: row.business_id,
          providerAccountId: row.provider_account_id,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          asOfDate: normalizeDate(row.as_of_date),
          learningState: learningStateOrNull(row.learning_state),
          daysAtLearningState: numberOrNull(row.days_at_learning_state),
          lastSignificantEditAt: normalizeTimestamp(row.last_significant_edit_at),
          daysSinceSignificantEdit: numberOrNull(row.days_since_significant_edit),
          recentChangeCooldownUntil: normalizeTimestamp(row.recent_change_cooldown_until),
          creativeAgeDays: numberOrNull(row.creative_age_days),
          creativeAgeDaysMax: numberOrNull(row.creative_age_days_max),
          frequencyP80: numberOrNull(row.frequency_p80),
          ctrDecayPct: numberOrNull(row.ctr_decay_pct),
          audienceOverlapPct: numberOrNull(row.audience_overlap_pct),
          audienceSize: numberOrNull(row.audience_size),
          lookalikePct: numberOrNull(row.lookalike_pct),
          audienceStage: textOrNull(row.audience_stage),
          feedDisapprovalCount: numberOrNull(row.feed_disapproval_count),
          feedStatus: textOrNull(row.feed_status),
          dedupRatePct: numberOrNull(row.dedup_rate_pct),
          metaToCrmRatio: numberOrNull(row.meta_to_crm_ratio),
          trackingQualityStatus: textOrNull(row.tracking_quality_status),
          sourceJson: row.source_json ?? {},
          qualityStatus: qualityStatusOrDefault(row.quality_status),
          computedAt: normalizeTimestamp(row.computed_at),
        },
      ]),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("meta_entity_decision_signals_daily") ||
        error.message.includes("creative_age_days_max") ||
        error.message.includes("days_since_significant_edit") ||
        error.message.includes("tracking_quality_status"))
    ) {
      return new Map();
    }
    throw error;
  }
}

export async function upsertMetaEntityDecisionSignalsDaily(
  signals: MetaEntityDecisionSignal[],
) {
  if (signals.length === 0) return { rowsWritten: 0 };
  const sql = getDb();
  const columns = [
    "business_id",
    "provider_account_id",
    "scope_type",
    "scope_id",
    "as_of_date",
    "learning_state",
    "days_at_learning_state",
    "last_significant_edit_at",
    "days_since_significant_edit",
    "recent_change_cooldown_until",
    "creative_age_days",
    "creative_age_days_max",
    "frequency_p80",
    "ctr_decay_pct",
    "audience_overlap_pct",
    "audience_size",
    "lookalike_pct",
    "audience_stage",
    "feed_disapproval_count",
    "feed_status",
    "dedup_rate_pct",
    "meta_to_crm_ratio",
    "tracking_quality_status",
    "source_json",
    "quality_status",
  ];
  const values: unknown[] = [];
  const tuples = signals.map((signal, index) => {
    const offset = index * columns.length;
    values.push(
      signal.businessId,
      signal.providerAccountId,
      signal.scopeType,
      signal.scopeId,
      normalizeDate(signal.asOfDate),
      signal.learningState,
      signal.daysAtLearningState,
      signal.lastSignificantEditAt,
      signal.daysSinceSignificantEdit,
      signal.recentChangeCooldownUntil,
      signal.creativeAgeDays,
      signal.creativeAgeDaysMax,
      signal.frequencyP80,
      signal.ctrDecayPct,
      signal.audienceOverlapPct ?? null,
      signal.audienceSize ?? null,
      signal.lookalikePct ?? null,
      signal.audienceStage ?? null,
      signal.feedDisapprovalCount ?? null,
      signal.feedStatus ?? null,
      signal.dedupRatePct ?? null,
      signal.metaToCrmRatio ?? null,
      signal.trackingQualityStatus ?? null,
      JSON.stringify(signal.sourceJson ?? {}),
      signal.qualityStatus,
    );
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });
  await sql.query(
    `
      INSERT INTO meta_entity_decision_signals_daily (${columns.join(", ")})
      VALUES ${tuples.join(", ")}
      ON CONFLICT (business_id, scope_type, scope_id, as_of_date)
      DO UPDATE SET
        provider_account_id = EXCLUDED.provider_account_id,
        learning_state = EXCLUDED.learning_state,
        days_at_learning_state = EXCLUDED.days_at_learning_state,
        last_significant_edit_at = EXCLUDED.last_significant_edit_at,
        days_since_significant_edit = EXCLUDED.days_since_significant_edit,
        recent_change_cooldown_until = EXCLUDED.recent_change_cooldown_until,
        creative_age_days = EXCLUDED.creative_age_days,
        creative_age_days_max = EXCLUDED.creative_age_days_max,
        frequency_p80 = EXCLUDED.frequency_p80,
        ctr_decay_pct = EXCLUDED.ctr_decay_pct,
        audience_overlap_pct = EXCLUDED.audience_overlap_pct,
        audience_size = EXCLUDED.audience_size,
        lookalike_pct = EXCLUDED.lookalike_pct,
        audience_stage = EXCLUDED.audience_stage,
        feed_disapproval_count = EXCLUDED.feed_disapproval_count,
        feed_status = EXCLUDED.feed_status,
        dedup_rate_pct = EXCLUDED.dedup_rate_pct,
        meta_to_crm_ratio = EXCLUDED.meta_to_crm_ratio,
        tracking_quality_status = EXCLUDED.tracking_quality_status,
        source_json = EXCLUDED.source_json::jsonb,
        quality_status = EXCLUDED.quality_status,
        computed_at = now()
    `,
    values,
  );
  return { rowsWritten: signals.length };
}
