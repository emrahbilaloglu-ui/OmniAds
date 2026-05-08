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
        error.message.includes("days_since_significant_edit"))
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
        source_json = EXCLUDED.source_json::jsonb,
        quality_status = EXCLUDED.quality_status,
        computed_at = now()
    `,
    values,
  );
  return { rowsWritten: signals.length };
}
