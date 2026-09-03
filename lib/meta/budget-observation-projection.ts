/**
 * D083 → D086: the ONE projection from a retained observation row to a
 * `BudgetObservation`.
 *
 * D083 owns the canonical budget boundary — owner mode, raw amount, currency,
 * exponent, schedule and provenance all resolve inside
 * `buildCanonicalBudgetFact`. Its input, however, was a row mapper that lived
 * inside the D083 audit script, so a second reader could only get at it by
 * writing its own. D086 r7 did exactly that and produced a weaker parallel
 * budget authority.
 *
 * This module is that mapper, re-homed so both readers use one implementation.
 * It is intentionally free of any judgment: it converts columns to fields and
 * refuses rows it cannot identify. Every decision about what the fields MEAN
 * stays in `buildCanonicalBudgetFact`.
 */
import { isRealCalendarDate } from "@/lib/meta/budget-fact";
import type {
  BudgetEntityGrain,
  BudgetObservation,
  RunCompleteness,
} from "@/lib/meta/budget-fact";

export type ObservationRow = Record<string, unknown>;

export function rawText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function trimmedText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

export function dateOnly(value: unknown): string | null {
  const raw = trimmedText(value);
  if (!raw) return null;
  const head = raw.slice(0, 10);
  return isRealCalendarDate(head) ? head : null;
}

/** Postgres renders `timestamptz::text` with an hours-only offset; ISO needs more. */
export function instantMs(value: unknown): number | null {
  const raw = rawText(value)?.trim() || null;
  if (!raw) return null;
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso = `${iso}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function coverageBit(coverage: unknown, field: string): boolean {
  if (!coverage || typeof coverage !== "object") return false;
  return (coverage as Record<string, unknown>)[field] === true;
}

/**
 * Client-known provenance coverage, which the mapper records as a named source
 * string rather than a boolean. Only the admitted vocabulary counts.
 */
export const ADMITTED_COVERAGE_SOURCES = ["client_registry", "client_known"] as const;

export function coverageSource(coverage: unknown, field: string): string | null {
  if (!coverage || typeof coverage !== "object") return null;
  const value = (coverage as Record<string, unknown>)[field];
  return typeof value === "string" &&
    (ADMITTED_COVERAGE_SOURCES as readonly string[]).includes(value)
    ? value
    : null;
}

export function toBudgetObservation(
  row: ObservationRow,
  binding: { businessId: string; providerAccountId: string },
): BudgetObservation | null {
  const entityType = trimmedText(row.entity_type);
  const entityId = trimmedText(row.entity_id);
  const observedOn = dateOnly(row.observed_on);
  if ((entityType !== "campaign" && entityType !== "adset") || !entityId || !observedOn) return null;
  const completeness = trimmedText(row.run_completeness);
  const presence = trimmedText(row.presence);
  return {
    businessId: binding.businessId,
    providerAccountId: binding.providerAccountId,
    entityGrain: entityType as BudgetEntityGrain,
    entityId,
    // Stored campaign rows carry their own id in `campaign_id`; a campaign
    // observation has no parent, and reporting itself as one would let a
    // campaign fact become its own hierarchy.
    parentCampaignId: entityType === "campaign" ? null : trimmedText(row.campaign_id),
    observedAtMs: instantMs(row.observed_at),
    observedOn,
    capturedAtMs: instantMs(row.captured_at),
    presence: presence === "present" || presence === "absent_unconfirmed" ? presence : null,
    runCompleteness:
      completeness === "complete" || completeness === "partial" || completeness === "point_lookup"
        ? (completeness as RunCompleteness)
        : null,
    configuredStatus: trimmedText(row.configured_status),
    effectiveStatus: trimmedText(row.effective_status),
    budgetOrigin: trimmedText(row.budget_origin),
    budgetCurrency: trimmedText(row.budget_currency),
    // The exponent columns this slice adds are not populated in retained
    // history, so they stay null and every historical fact fails the
    // captured-exponent gate rather than being restated with today's registry.
    budgetCurrencyExponent:
      typeof row.budget_currency_exponent === "number" ? row.budget_currency_exponent : null,
    budgetCurrencyRegistryVersion: trimmedText(row.budget_currency_registry_version),
    campaignDailyRaw: rawText(row.campaign_daily_budget_raw),
    campaignLifetimeRaw: rawText(row.campaign_lifetime_budget_raw),
    adsetDailyRaw: rawText(row.adset_daily_budget_raw),
    adsetLifetimeRaw: rawText(row.adset_lifetime_budget_raw),
    startTime:
      entityType === "campaign"
        ? trimmedText(row.campaign_start_time)
        : trimmedText(row.adset_start_time),
    endTime:
      entityType === "campaign"
        ? trimmedText(row.campaign_end_time)
        : trimmedText(row.adset_end_time),
    statusFieldCoverage: {
      configuredStatus: coverageBit(row.field_coverage_json, "configuredStatus"),
      effectiveStatus: coverageBit(row.field_coverage_json, "effectiveStatus"),
    },
    /*
      The CAPTURED shape, not an assumption. Rows written before
      `budget_shape_support` existed have NULL and stay `shape_not_observed`,
      which is what fails their facts closed; rows the current writer produces
      state what the endpoint actually observed.
    */
    shapeSupport:
      row.budget_shape_support === "supported" || row.budget_shape_support === "unsupported_shape"
        ? row.budget_shape_support
        : "shape_not_observed",
    observationId: trimmedText(row.observation_id),
    sourceRunId: trimmedText(row.run_id),
    sourceSnapshotId: trimmedText(row.source_snapshot_id),
    // Two distinct facts about the run. An earlier revision wrote
    // `run_hash ?? payload_hash`, which reported one as the other.
    payloadHash: trimmedText(row.payload_hash),
    runHash: trimmedText(row.run_hash),
    stateHash: trimmedText(row.state_hash),
    providerApiVersion: trimmedText(row.provider_api_version),
  };
}
