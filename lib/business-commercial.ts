import { createHash } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  assertDbSchemaReady,
  getDbSchemaReadiness,
  isMissingRelationError,
} from "@/lib/db-schema-readiness";
import {
  getBusinessCostModel,
  type BusinessCostModel,
} from "@/lib/business-cost-model";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import {
  BUSINESS_COMMERCIAL_REQUIRED_INPUT_SECTIONS,
  BUSINESS_DECISION_BID_REGIMES,
  BUSINESS_DECISION_CALIBRATION_CHANNELS,
  BUSINESS_DECISION_OBJECTIVE_FAMILIES,
  BUSINESS_COUNTRY_PRIORITY_TIERS,
  BUSINESS_COUNTRY_SCALE_OVERRIDES,
  BUSINESS_COUNTRY_SERVICEABILITY,
  BUSINESS_ISSUE_STATUSES,
  BUSINESS_PROMO_SEVERITIES,
  BUSINESS_PROMO_TYPES,
  BUSINESS_RISK_POSTURES,
  BUSINESS_STOCK_PRESSURE_STATUSES,
  createEmptyBusinessCommercialCoverageSummary,
  createEmptyBusinessCommercialTruthSnapshot,
  createEmptyDecisionCalibrationProfile,
  createEmptyOperatingConstraints,
  createEmptyTargetPack,
  type BusinessCommercialBootstrapSuggestion,
  type BusinessCommercialCoverageSummary,
  type BusinessCommercialFreshnessMeta,
  type BusinessCommercialRequiredInput,
  type BusinessCommercialSectionMeta,
  type BusinessCommercialTruthSnapshot,
  type BusinessCountryEconomicsRow,
  type BusinessDecisionCalibrationProfile,
  type BusinessOperatingConstraints,
  type BusinessPromoCalendarEvent,
  type BusinessTargetPackData,
} from "@/src/types/business-commercial";
import type { DecisionSafeActionLabel } from "@/src/types/decision-trust";

const COMMERCIAL_TRUTH_TABLES = [
  "business_target_packs",
  "business_country_economics",
  "business_promo_calendar_events",
  "business_operating_constraints",
  "business_decision_calibration_profiles",
];

const COMMERCIAL_TRUTH_WRITE_TABLES = [
  ...COMMERCIAL_TRUTH_TABLES,
  "business_target_pack_history",
];

function businessCommercialAdvisoryLockKey(businessId: string) {
  return `business-commercial:${businessId}`;
}

async function acquireBusinessCommercialAdvisoryLock(businessId: string) {
  await getDb().query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [businessCommercialAdvisoryLockKey(businessId)],
  );
}

type MetaRow = {
  source_label: string | null;
  updated_at: string | Date | null;
  updated_by_user_id: string | null;
};

type SnapshotMetaRow = {
  sourceLabel: string | null;
  updatedAt: string | Date | null;
  updatedByUserId: string | null;
};

type TargetPackRow = {
  target_cpa: number | null;
  target_roas: number | null;
  break_even_cpa: number | null;
  break_even_roas: number | null;
  contribution_margin_assumption: number | null;
  aov_assumption: number | null;
  new_customer_weight: number | null;
  default_risk_posture: string | null;
  cost_cogs_percent: number | null;
  cost_shipping_percent: number | null;
  cost_fulfillment_percent: number | null;
  cost_payment_processing_percent: number | null;
} & MetaRow;

type TargetPackHistoryRow = TargetPackRow & {
  id: string;
  operation: "upsert" | "delete";
  effective_at: string | Date;
  recorded_at: string | Date;
};

export interface BusinessTargetPackHistoryEntry {
  id: string;
  operation: "upsert" | "delete";
  effectiveAt: string;
  recordedAt: string;
  sourceLabel: string | null;
  updatedByUserId: string | null;
  targetPack: BusinessTargetPackData | null;
}

type TargetPackReconfirmationRow = {
  result_status:
    | "reconfirmed"
    | "missing"
    | "conflict"
    | "invalid_target_pack"
    | "write_failed";
  reason: string;
  updated_at: string | Date | null;
};

export type BusinessTargetPackReconfirmationResult =
  | {
      status: "reconfirmed";
      reason: "target_pack_reconfirmed";
      updatedAt: string;
    }
  | {
      status: "missing";
      reason: "target_pack_missing";
    }
  | {
      status: "conflict";
      reason: "target_pack_changed";
      currentUpdatedAt: string;
    }
  | {
      status: "invalid_target_pack";
      reason: string;
      currentUpdatedAt: string;
    };

export class BusinessCommercialInputValidationError extends Error {
  readonly code = "invalid_target_pack";

  constructor(
    readonly field: string,
    readonly reason: string,
    message?: string,
  ) {
    super(
      message ?? `${field} must be a finite number greater than zero or null.`,
    );
    this.name = "BusinessCommercialInputValidationError";
  }
}

export class BusinessCommercialSnapshotConflictError extends Error {
  readonly code = "commercial_truth_changed";

  constructor(readonly currentRevision: string) {
    super(
      "Commercial truth changed after this editor loaded. Refresh before saving again.",
    );
    this.name = "BusinessCommercialSnapshotConflictError";
  }
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRevisionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRevisionValue);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([key, item]) => [key, canonicalRevisionValue(item)]),
  );
}

export function businessCommercialSnapshotRevision(
  snapshot: BusinessCommercialTruthSnapshot,
) {
  const countryEconomics = snapshot.countryEconomics
    .slice()
    .sort((left, right) =>
      compareCanonicalText(left.countryCode, right.countryCode),
    );
  const promoCalendar = snapshot.promoCalendar
    .slice()
    .sort((left, right) => compareCanonicalText(left.eventId, right.eventId));
  const calibrationProfiles = (snapshot.calibrationProfiles ?? [])
    .slice()
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.channel,
          left.objectiveFamily,
          left.bidRegime,
          left.archetype,
        ].join("\u0000"),
        [
          right.channel,
          right.objectiveFamily,
          right.bidRegime,
          right.archetype,
        ].join("\u0000"),
      ),
    );
  const persistedState = canonicalRevisionValue({
    businessId: snapshot.businessId,
    targetPack: snapshot.targetPack,
    countryEconomics,
    promoCalendar,
    operatingConstraints: snapshot.operatingConstraints,
    calibrationProfiles,
  });
  return createHash("sha256")
    .update(JSON.stringify(persistedState))
    .digest("hex");
}

type CountryEconomicsRow = {
  country_code: string;
  economics_multiplier: number | null;
  margin_modifier: number | null;
  serviceability: string | null;
  priority_tier: string | null;
  scale_override: string | null;
  notes: string | null;
} & MetaRow;

type PromoCalendarRow = {
  event_id: string;
  title: string;
  promo_type: string | null;
  severity: string | null;
  start_date: string;
  end_date: string;
  affected_scope: string | null;
  notes: string | null;
} & MetaRow;

type OperatingConstraintsRow = {
  site_issue_status: string | null;
  checkout_issue_status: string | null;
  conversion_tracking_issue_status: string | null;
  feed_issue_status: string | null;
  stock_pressure_status: string | null;
  landing_page_concern: string | null;
  merchandising_concern: string | null;
  manual_do_not_scale_reason: string | null;
} & MetaRow;

type CalibrationProfileRow = {
  channel: string | null;
  objective_family: string | null;
  bid_regime: string | null;
  archetype: string | null;
  target_roas_multiplier: number | null;
  break_even_roas_multiplier: number | null;
  target_cpa_multiplier: number | null;
  break_even_cpa_multiplier: number | null;
  confidence_cap: number | null;
  action_ceiling: string | null;
  notes: string | null;
} & MetaRow;

/**
 * Composite identity of a decision calibration profile, matching the table's
 * `UNIQUE (business_id, channel, objective_family, bid_regime, archetype)`.
 * Business scope is supplied by the caller's WHERE clause.
 */
function calibrationProfileIdentityKey(input: {
  channel: string;
  objectiveFamily: string;
  bidRegime: string;
  archetype: string;
}): string {
  return [
    input.channel,
    input.objectiveFamily,
    input.bidRegime,
    input.archetype,
  ].join("\u001f");
}

function normalizeString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestampValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : null;
  }
  return null;
}

function normalizeDate(value: unknown) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeAsOfCutoff(value: string | Date) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("asOf must be a valid date or timestamp");
    }
    return value.toISOString();
  }

  const normalized = value.trim();
  const dateOnly = normalizeDate(normalized);
  const candidate = dateOnly ? `${dateOnly}T03:00:00.000Z` : normalized;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("asOf must be a valid YYYY-MM-DD date or timestamp");
  }
  if (dateOnly && parsed.toISOString().slice(0, 10) !== dateOnly) {
    throw new Error("asOf must be a valid calendar date");
  }
  return parsed.toISOString();
}

function normalizeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnitInterval(value: unknown) {
  const normalized = normalizeNumber(value);
  if (normalized === null) return null;
  if (normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  return normalized;
}

function normalizeCommercialInputNumber(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BusinessCommercialInputValidationError(
      field,
      `${field.replaceAll(".", "_")}_must_be_finite_or_null`,
      `${field} must be a finite number or null.`,
    );
  }
  return value;
}

function normalizePositiveTargetAnchor(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BusinessCommercialInputValidationError(
      field,
      `${field.replaceAll(".", "_")}_must_be_positive_finite`,
    );
  }
  return value;
}

function normalizeCommercialInputUnitInterval(value: unknown, field: string) {
  const normalized = normalizeCommercialInputNumber(value, field);
  if (normalized === null) return null;
  if (normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  return normalized;
}

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && allowed.includes(value as T[number])
    ? (value as T[number])
    : fallback;
}

function differenceInHours(
  updatedAt: string | null | undefined,
  referenceTime: Date = new Date(),
) {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  const referenceTimeMs = referenceTime.getTime();
  if (!Number.isFinite(parsed) || !Number.isFinite(referenceTimeMs))
    return null;
  const differenceMs = referenceTimeMs - parsed;
  if (differenceMs < 0) return null;
  return Number((differenceMs / 3_600_000).toFixed(1));
}

function dedupeStringList(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function hasTargetPackValue(
  targetPack: BusinessTargetPackData | null | undefined,
) {
  if (!targetPack) return false;
  const costStructure = targetPack.costStructure;
  return (
    targetPack.defaultRiskPosture !== "balanced" ||
    [
      targetPack.targetCpa,
      targetPack.targetRoas,
      targetPack.breakEvenCpa,
      targetPack.breakEvenRoas,
      targetPack.contributionMarginAssumption,
      targetPack.aovAssumption,
      targetPack.newCustomerWeight,
      costStructure?.cogsPercent,
      costStructure?.shippingPercent,
      costStructure?.fulfillmentPercent,
      costStructure?.paymentProcessingPercent,
    ].some((value) => value !== null && value !== undefined)
  );
}

function hasOperatingConstraintValue(
  constraints: BusinessOperatingConstraints | null | undefined,
) {
  if (!constraints) return false;
  return (
    constraints.siteIssueStatus !== "none" ||
    constraints.checkoutIssueStatus !== "none" ||
    constraints.conversionTrackingIssueStatus !== "none" ||
    constraints.feedIssueStatus !== "none" ||
    constraints.stockPressureStatus !== "healthy" ||
    Boolean(normalizeString(constraints.landingPageConcern)) ||
    Boolean(normalizeString(constraints.merchandisingConcern)) ||
    Boolean(normalizeString(constraints.manualDoNotScaleReason))
  );
}

function dedupeByKey<T>(rows: T[], getKey: (row: T) => string | null) {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = getKey(row);
    if (!key) continue;
    map.set(key, row);
  }
  return [...map.values()];
}

function readMetaValue(
  row: MetaRow | SnapshotMetaRow,
  key: "sourceLabel" | "updatedAt" | "updatedByUserId",
) {
  if ("source_label" in row) {
    if (key === "sourceLabel") return row.source_label;
    if (key === "updatedAt") return normalizeTimestampValue(row.updated_at);
    return row.updated_by_user_id;
  }
  if (key === "sourceLabel") return row.sourceLabel;
  if (key === "updatedAt") return normalizeTimestampValue(row.updatedAt);
  return row.updatedByUserId;
}

export const BUSINESS_TARGET_PACK_STALE_AFTER_HOURS = 24 * 30;

export function resolveBusinessTargetPackFreshness(
  updatedAt: string | Date | null | undefined,
  referenceTime: Date = new Date(),
): "fresh" | "stale" | "unknown" {
  const normalized = normalizeTimestampValue(updatedAt);
  if (!normalized) return "unknown";
  const updatedAtMs = Date.parse(normalized);
  const referenceTimeMs = referenceTime.getTime();
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(referenceTimeMs)) {
    return "unknown";
  }
  if (updatedAtMs > referenceTimeMs) return "unknown";
  const ageHours = (referenceTimeMs - updatedAtMs) / 3_600_000;
  return ageHours > BUSINESS_TARGET_PACK_STALE_AFTER_HOURS ? "stale" : "fresh";
}

const SECTION_META_RULES = {
  targetPack: {
    blocking: true,
    staleAfterHours: BUSINESS_TARGET_PACK_STALE_AFTER_HOURS,
    missingReason: "Target pack thresholds are not configured yet.",
    staleReason:
      "Target pack thresholds are older than 30 days and should be reviewed.",
  },
  countryEconomics: {
    blocking: false,
    staleAfterHours: 24 * 30,
    missingReason:
      "Country economics are not configured, so all locations use the global cost structure.",
    staleReason:
      "Country economics are older than 30 days and should be refreshed.",
  },
  promoCalendar: {
    blocking: false,
    staleAfterHours: 24 * 45,
    missingReason:
      "Promo calendar is not configured, so promo-aware posture stays conservative.",
    staleReason:
      "Promo calendar metadata is older than 45 days and may no longer match current launches.",
  },
  operatingConstraints: {
    blocking: true,
    staleAfterHours: 24 * 7,
    missingReason:
      "Operating constraints are not configured, so blockers and action ceilings stay conservative.",
    staleReason:
      "Operating constraints are older than 7 days and may not reflect live site or stock conditions.",
  },
} as const;

type SectionMetaKey = keyof typeof SECTION_META_RULES;

function buildFreshnessMeta(input: {
  configured: boolean;
  updatedAt: string | null;
  staleAfterHours: number;
  missingReason: string;
  staleReason: string;
}): BusinessCommercialFreshnessMeta {
  if (!input.configured) {
    return {
      status: "missing",
      updatedAt: null,
      ageHours: null,
      reason: input.missingReason,
    };
  }

  const ageHours = differenceInHours(input.updatedAt);
  if (ageHours === null) {
    return {
      status: "stale",
      updatedAt: input.updatedAt,
      ageHours: null,
      reason: "Configured data is missing a tracked refresh timestamp.",
    };
  }

  if (ageHours > input.staleAfterHours) {
    return {
      status: "stale",
      updatedAt: input.updatedAt,
      ageHours,
      reason: input.staleReason,
    };
  }

  return {
    status: "fresh",
    updatedAt: input.updatedAt,
    ageHours,
    reason: null,
  };
}

function buildSectionMeta(
  section: SectionMetaKey,
  rows: Array<MetaRow | SnapshotMetaRow | null | undefined>,
): BusinessCommercialSectionMeta {
  const validRows = rows.filter((row): row is MetaRow | SnapshotMetaRow =>
    Boolean(row),
  );
  const rule = SECTION_META_RULES[section];
  if (validRows.length === 0) {
    return {
      configured: false,
      itemCount: 0,
      sourceLabel: null,
      updatedAt: null,
      updatedByUserId: null,
      completeness: "missing",
      freshness: buildFreshnessMeta({
        configured: false,
        updatedAt: null,
        staleAfterHours: rule.staleAfterHours,
        missingReason: rule.missingReason,
        staleReason: rule.staleReason,
      }),
      blocking: rule.blocking,
    };
  }

  const latest = [...validRows].sort((left, right) =>
    String(readMetaValue(right, "updatedAt") ?? "").localeCompare(
      String(readMetaValue(left, "updatedAt") ?? ""),
    ),
  )[0];
  const uniqueSources = Array.from(
    new Set(
      validRows
        .map((row) => readMetaValue(row, "sourceLabel"))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  return {
    configured: true,
    itemCount: validRows.length,
    sourceLabel:
      uniqueSources.length === 0
        ? (readMetaValue(latest, "sourceLabel") ?? null)
        : uniqueSources.length === 1
          ? uniqueSources[0]
          : "mixed_sources",
    updatedAt: readMetaValue(latest, "updatedAt") ?? null,
    updatedByUserId: readMetaValue(latest, "updatedByUserId") ?? null,
    completeness: "complete",
    freshness: buildFreshnessMeta({
      configured: true,
      updatedAt: readMetaValue(latest, "updatedAt") ?? null,
      staleAfterHours: rule.staleAfterHours,
      missingReason: rule.missingReason,
      staleReason: rule.staleReason,
    }),
    blocking: rule.blocking,
  };
}

function mapTargetPackRow(
  row: TargetPackRow | undefined,
): BusinessTargetPackData | null {
  if (!row) return null;
  return {
    targetCpa: normalizeNumber(row.target_cpa),
    targetRoas: normalizeNumber(row.target_roas),
    breakEvenCpa: normalizeNumber(row.break_even_cpa),
    breakEvenRoas: normalizeNumber(row.break_even_roas),
    contributionMarginAssumption: normalizeNumber(
      row.contribution_margin_assumption,
    ),
    aovAssumption: normalizeNumber(row.aov_assumption),
    newCustomerWeight: normalizeNumber(row.new_customer_weight),
    defaultRiskPosture: normalizeEnum(
      row.default_risk_posture,
      BUSINESS_RISK_POSTURES,
      "balanced",
    ),
    costStructure: {
      cogsPercent: normalizeUnitInterval(row.cost_cogs_percent),
      shippingPercent: normalizeUnitInterval(row.cost_shipping_percent),
      fulfillmentPercent: normalizeUnitInterval(row.cost_fulfillment_percent),
      paymentProcessingPercent: normalizeUnitInterval(
        row.cost_payment_processing_percent,
      ),
    },
    sourceLabel: normalizeString(row.source_label),
    updatedAt: normalizeTimestampValue(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function mapCountryEconomicsRow(
  row: CountryEconomicsRow,
): BusinessCountryEconomicsRow {
  return {
    countryCode: String(row.country_code ?? "").toUpperCase(),
    economicsMultiplier: normalizeNumber(row.economics_multiplier),
    marginModifier: normalizeNumber(row.margin_modifier),
    serviceability: normalizeEnum(
      row.serviceability,
      BUSINESS_COUNTRY_SERVICEABILITY,
      "full",
    ),
    priorityTier: normalizeEnum(
      row.priority_tier,
      BUSINESS_COUNTRY_PRIORITY_TIERS,
      "tier_2",
    ),
    scaleOverride: normalizeEnum(
      row.scale_override,
      BUSINESS_COUNTRY_SCALE_OVERRIDES,
      "default",
    ),
    notes: normalizeString(row.notes),
    sourceLabel: normalizeString(row.source_label),
    updatedAt: normalizeTimestampValue(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function mapPromoRow(row: PromoCalendarRow): BusinessPromoCalendarEvent {
  return {
    eventId: String(row.event_id ?? ""),
    title: String(row.title ?? ""),
    promoType: normalizeEnum(row.promo_type, BUSINESS_PROMO_TYPES, "sale"),
    severity: normalizeEnum(row.severity, BUSINESS_PROMO_SEVERITIES, "medium"),
    startDate: String(row.start_date ?? ""),
    endDate: String(row.end_date ?? ""),
    affectedScope: normalizeString(row.affected_scope),
    notes: normalizeString(row.notes),
    sourceLabel: normalizeString(row.source_label),
    updatedAt: normalizeTimestampValue(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function mapConstraintsRow(
  row: OperatingConstraintsRow | undefined,
): BusinessOperatingConstraints | null {
  if (!row) return null;
  return {
    siteIssueStatus: normalizeEnum(
      row.site_issue_status,
      BUSINESS_ISSUE_STATUSES,
      "none",
    ),
    checkoutIssueStatus: normalizeEnum(
      row.checkout_issue_status,
      BUSINESS_ISSUE_STATUSES,
      "none",
    ),
    conversionTrackingIssueStatus: normalizeEnum(
      row.conversion_tracking_issue_status,
      BUSINESS_ISSUE_STATUSES,
      "none",
    ),
    feedIssueStatus: normalizeEnum(
      row.feed_issue_status,
      BUSINESS_ISSUE_STATUSES,
      "none",
    ),
    stockPressureStatus: normalizeEnum(
      row.stock_pressure_status,
      BUSINESS_STOCK_PRESSURE_STATUSES,
      "healthy",
    ),
    landingPageConcern: normalizeString(row.landing_page_concern),
    merchandisingConcern: normalizeString(row.merchandising_concern),
    manualDoNotScaleReason: normalizeString(row.manual_do_not_scale_reason),
    sourceLabel: normalizeString(row.source_label),
    updatedAt: normalizeTimestampValue(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function mapCalibrationProfileRow(
  row: CalibrationProfileRow,
): BusinessDecisionCalibrationProfile {
  return {
    ...createEmptyDecisionCalibrationProfile(),
    channel: normalizeEnum(
      row.channel,
      BUSINESS_DECISION_CALIBRATION_CHANNELS,
      "meta",
    ),
    objectiveFamily: normalizeEnum(
      row.objective_family,
      BUSINESS_DECISION_OBJECTIVE_FAMILIES,
      "unknown",
    ),
    bidRegime: normalizeEnum(
      row.bid_regime,
      BUSINESS_DECISION_BID_REGIMES,
      "unknown",
    ),
    archetype: normalizeString(row.archetype) ?? "default",
    targetRoasMultiplier: normalizeNumber(row.target_roas_multiplier),
    breakEvenRoasMultiplier: normalizeNumber(row.break_even_roas_multiplier),
    targetCpaMultiplier: normalizeNumber(row.target_cpa_multiplier),
    breakEvenCpaMultiplier: normalizeNumber(row.break_even_cpa_multiplier),
    confidenceCap: normalizeUnitInterval(row.confidence_cap),
    actionCeiling:
      normalizeString(row.action_ceiling) &&
      [
        "review_hold",
        "review_reduce",
        "monitor_low_truth",
        "degraded_no_scale",
      ].includes(normalizeString(row.action_ceiling) ?? "")
        ? (normalizeString(
            row.action_ceiling,
          ) as BusinessDecisionCalibrationProfile["actionCeiling"])
        : null,
    notes: normalizeString(row.notes),
    sourceLabel: normalizeString(row.source_label),
    updatedAt: normalizeTimestampValue(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function mapCostModelContext(
  row: BusinessCostModel | null,
): BusinessCommercialTruthSnapshot["costModelContext"] {
  if (!row) return null;
  return {
    cogsPercent: row.cogsPercent,
    shippingPercent: row.shippingPercent,
    feePercent: row.feePercent,
    fixedCost: row.fixedCost,
    updatedAt: normalizeTimestampValue(row.updatedAt),
  };
}

function buildCommercialThresholdSummary(
  snapshot: Pick<BusinessCommercialTruthSnapshot, "targetPack">,
): BusinessCommercialCoverageSummary["thresholds"] {
  const targetPack = snapshot.targetPack;
  if (
    targetPack?.targetRoas != null ||
    targetPack?.breakEvenRoas != null ||
    targetPack?.targetCpa != null ||
    targetPack?.breakEvenCpa != null
  ) {
    return {
      source: "configured_targets",
      targetRoas: targetPack.targetRoas,
      breakEvenRoas: targetPack.breakEvenRoas,
      targetCpa: targetPack.targetCpa,
      breakEvenCpa: targetPack.breakEvenCpa,
      defaultRiskPosture: targetPack.defaultRiskPosture,
    };
  }

  return createEmptyBusinessCommercialCoverageSummary().thresholds;
}

function buildCalibrationSummary(
  calibrationProfiles: BusinessDecisionCalibrationProfile[],
): BusinessCommercialCoverageSummary["calibration"] {
  if (calibrationProfiles.length === 0) {
    return {
      profileCount: 0,
      channels: [],
      updatedAt: null,
    };
  }

  const latestUpdatedAt =
    calibrationProfiles
      .map((row) => row.updatedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;

  return {
    profileCount: calibrationProfiles.length,
    channels: Array.from(
      new Set(calibrationProfiles.map((row) => row.channel)),
    ),
    updatedAt: latestUpdatedAt,
  };
}

function buildCalibrationFreshness(
  calibrationProfiles: BusinessDecisionCalibrationProfile[],
): BusinessCommercialFreshnessMeta {
  const latestUpdatedAt =
    calibrationProfiles
      .map((profile) => profile.updatedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;

  if (calibrationProfiles.length === 0) {
    return {
      status: "missing",
      updatedAt: null,
      ageHours: null,
      reason: "No calibration profiles exist yet.",
    };
  }

  const ageHours = differenceInHours(latestUpdatedAt);
  if (ageHours === null) {
    return {
      status: "stale",
      updatedAt: latestUpdatedAt,
      ageHours: null,
      reason:
        "Calibration profiles are present, but their refresh timestamp is unavailable.",
    };
  }

  if (ageHours > 24 * 30) {
    return {
      status: "stale",
      updatedAt: latestUpdatedAt,
      ageHours,
      reason:
        "Calibration profiles are older than 30 days and should be reviewed.",
    };
  }

  return {
    status: "fresh",
    updatedAt: latestUpdatedAt,
    ageHours,
    reason: null,
  };
}

function buildRequiredInputs(input: {
  targetPack: BusinessCommercialTruthSnapshot["targetPack"];
  countryEconomics: BusinessCommercialTruthSnapshot["countryEconomics"];
  promoCalendar: BusinessCommercialTruthSnapshot["promoCalendar"];
  operatingConstraints: BusinessCommercialTruthSnapshot["operatingConstraints"];
  sectionMeta: BusinessCommercialTruthSnapshot["sectionMeta"];
  calibrationProfiles: BusinessDecisionCalibrationProfile[];
}): BusinessCommercialRequiredInput[] {
  const calibrationFreshness = buildCalibrationFreshness(
    input.calibrationProfiles,
  );

  return BUSINESS_COMMERCIAL_REQUIRED_INPUT_SECTIONS.map((section) => {
    if (section === "targetPack") {
      const freshness =
        input.sectionMeta.targetPack.freshness ??
        buildFreshnessMeta({
          configured: false,
          updatedAt: null,
          staleAfterHours: SECTION_META_RULES.targetPack.staleAfterHours,
          missingReason: SECTION_META_RULES.targetPack.missingReason,
          staleReason: SECTION_META_RULES.targetPack.staleReason,
        });
      const ageOnlyReviewDue =
        freshness.status === "stale" &&
        typeof freshness.ageHours === "number" &&
        Number.isFinite(freshness.ageHours);
      const targetProvenanceUnsafe =
        input.targetPack !== null &&
        freshness.status !== "fresh" &&
        !ageOnlyReviewDue;
      return {
        section,
        blocking: true,
        freshness,
        reason: !input.targetPack
          ? "Target pack is missing, so ROAS/CPA thresholds stay on conservative fallback defaults."
          : targetProvenanceUnsafe
            ? "Target pack confirmation time is unavailable or cutoff-unsafe, so hard action authority remains withheld."
          : ageOnlyReviewDue
            ? (freshness.reason ??
              "Target pack thresholds need review.")
            : "Target pack thresholds are configured.",
        actionCeiling:
          !input.targetPack || targetProvenanceUnsafe ? "review_hold" : null,
      } satisfies BusinessCommercialRequiredInput;
    }

    if (section === "countryEconomics") {
      return {
        section,
        blocking: false,
        freshness:
          input.sectionMeta.countryEconomics.freshness ??
          buildFreshnessMeta({
            configured: false,
            updatedAt: null,
            staleAfterHours:
              SECTION_META_RULES.countryEconomics.staleAfterHours,
            missingReason: SECTION_META_RULES.countryEconomics.missingReason,
            staleReason: SECTION_META_RULES.countryEconomics.staleReason,
          }),
        reason:
          input.countryEconomics.length === 0
            ? "Country economics are not configured, so all locations use the global cost structure."
            : input.sectionMeta.countryEconomics.freshness?.status === "stale"
              ? (input.sectionMeta.countryEconomics.freshness.reason ??
                "Country economics need review.")
              : "Country economics are configured.",
        actionCeiling: null,
      } satisfies BusinessCommercialRequiredInput;
    }

    if (section === "promoCalendar") {
      return {
        section,
        blocking: false,
        freshness:
          input.sectionMeta.promoCalendar.freshness ??
          buildFreshnessMeta({
            configured: false,
            updatedAt: null,
            staleAfterHours: SECTION_META_RULES.promoCalendar.staleAfterHours,
            missingReason: SECTION_META_RULES.promoCalendar.missingReason,
            staleReason: SECTION_META_RULES.promoCalendar.staleReason,
          }),
        reason:
          input.promoCalendar.length === 0
            ? "Promo calendar is optional, but promo-aware posture remains conservative until windows are configured."
            : input.sectionMeta.promoCalendar.freshness?.status === "stale"
              ? (input.sectionMeta.promoCalendar.freshness.reason ??
                "Promo calendar needs review.")
              : "Promo windows are configured.",
        actionCeiling: null,
      } satisfies BusinessCommercialRequiredInput;
    }

    if (section === "operatingConstraints") {
      return {
        section,
        blocking: true,
        freshness:
          input.sectionMeta.operatingConstraints.freshness ??
          buildFreshnessMeta({
            configured: false,
            updatedAt: null,
            staleAfterHours:
              SECTION_META_RULES.operatingConstraints.staleAfterHours,
            missingReason:
              SECTION_META_RULES.operatingConstraints.missingReason,
            staleReason: SECTION_META_RULES.operatingConstraints.staleReason,
          }),
        reason: !input.operatingConstraints
          ? "Operating constraints are missing, so action ceilings stay conservative."
          : input.sectionMeta.operatingConstraints.freshness?.status === "stale"
            ? (input.sectionMeta.operatingConstraints.freshness.reason ??
              "Operating constraints need review.")
            : "Operating constraints are configured.",
        actionCeiling: !input.operatingConstraints ? "degraded_no_scale" : null,
      } satisfies BusinessCommercialRequiredInput;
    }

    return {
      section,
      blocking: false,
      freshness: calibrationFreshness,
      reason:
        input.calibrationProfiles.length === 0
          ? "No calibration profiles exist yet, so channel-specific confidence caps stay generic."
          : calibrationFreshness.status === "stale"
            ? (calibrationFreshness.reason ??
              "Calibration profiles need review.")
            : "Calibration profiles are configured.",
      actionCeiling:
        input.calibrationProfiles.length === 0 ? "review_hold" : null,
    } satisfies BusinessCommercialRequiredInput;
  });
}

function buildBootstrapSuggestions(input: {
  promoCalendar: BusinessCommercialTruthSnapshot["promoCalendar"];
  calibrationProfiles: BusinessDecisionCalibrationProfile[];
}): BusinessCommercialBootstrapSuggestion[] {
  const suggestions: BusinessCommercialBootstrapSuggestion[] = [];

  if (input.promoCalendar.length === 0) {
    suggestions.push({
      section: "promoCalendar",
      title: "Record the next promo window",
      detail:
        "Capture only the next material launch, sale, or clearance window so promo-aware posture has an explicit date range to reference.",
      safe: true,
    });
  }

  if (input.calibrationProfiles.length === 0) {
    suggestions.push({
      section: "calibrationProfiles",
      title: "Create a baseline calibration profile",
      detail:
        "Start with a conservative meta/default profile and keep the ceiling at review_hold until operator benchmark feedback exists.",
      safe: true,
    });
  }

  return suggestions;
}

function buildCommercialCoverageSummary(input: {
  targetPack: BusinessCommercialTruthSnapshot["targetPack"];
  countryEconomics: BusinessCommercialTruthSnapshot["countryEconomics"];
  promoCalendar: BusinessCommercialTruthSnapshot["promoCalendar"];
  operatingConstraints: BusinessCommercialTruthSnapshot["operatingConstraints"];
  sectionMeta: BusinessCommercialTruthSnapshot["sectionMeta"];
  calibrationProfiles: BusinessDecisionCalibrationProfile[];
}): BusinessCommercialCoverageSummary {
  const requiredInputs = buildRequiredInputs(input);
  const participatesInBlockingCoverage = (
    section: BusinessCommercialRequiredInput,
  ) =>
      section.blocking &&
    !(
      section.section === "targetPack" &&
      section.freshness.status === "stale" &&
      typeof section.freshness.ageHours === "number" &&
      Number.isFinite(section.freshness.ageHours)
    );
  const blockingSections = requiredInputs.filter(
    participatesInBlockingCoverage,
  );
  const configuredBlockingCount = blockingSections.filter(
    (section) => section.freshness.status !== "missing",
  ).length;

  const completeness =
    configuredBlockingCount === blockingSections.length
      ? "complete"
      : configuredBlockingCount > 0
        ? "partial"
        : "missing";

  const latestUpdatedAt =
    [
      input.sectionMeta.targetPack.updatedAt,
      input.sectionMeta.countryEconomics.updatedAt,
      input.sectionMeta.promoCalendar.updatedAt,
      input.sectionMeta.operatingConstraints.updatedAt,
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;

  const staleBlockingSections = blockingSections.filter(
    (section) => section.freshness.status === "stale",
  );
  const freshness: BusinessCommercialFreshnessMeta =
    completeness === "missing"
      ? {
          status: "missing",
          updatedAt: latestUpdatedAt,
          ageHours: differenceInHours(latestUpdatedAt),
          reason: "Blocking commercial truth sections are not configured yet.",
        }
      : staleBlockingSections.length > 0
        ? {
            status: "stale",
            updatedAt: latestUpdatedAt,
            ageHours: differenceInHours(latestUpdatedAt),
            reason: "One or more blocking commercial truth sections are stale.",
          }
        : {
            status: "fresh",
            updatedAt: latestUpdatedAt,
            ageHours: differenceInHours(latestUpdatedAt),
            reason: null,
          };

  const blockingReasons = dedupeStringList(
    requiredInputs
      .filter(
        (section) =>
          participatesInBlockingCoverage(section) &&
          section.freshness.status !== "fresh",
      )
      .map((section) => section.reason),
  );

  const nonBlockingReasons = dedupeStringList(
    requiredInputs
      .filter(
        (section) =>
          !participatesInBlockingCoverage(section) &&
          section.freshness.status !== "fresh",
      )
      .map((section) => section.reason),
  );

  const actionCeilings = Array.from(
    new Set([
      ...requiredInputs
        .map((section) => section.actionCeiling)
        .filter((value): value is DecisionSafeActionLabel => Boolean(value)),
      ...input.calibrationProfiles
        .map((profile) => profile.actionCeiling)
        .filter((value): value is NonNullable<typeof value> => Boolean(value)),
    ]),
  );

  return {
    completeness,
    freshness,
    blockingReasons,
    nonBlockingReasons,
    actionCeilings,
    thresholds: buildCommercialThresholdSummary({
      targetPack: input.targetPack,
    }),
    calibration: buildCalibrationSummary(input.calibrationProfiles),
    requiredInputs,
  };
}

export function sanitizeBusinessCommercialTruthInput(
  businessId: string,
  input: Partial<BusinessCommercialTruthSnapshot> | null | undefined,
) {
  const targetPackInput = input?.targetPack;
  const costStructureInput = targetPackInput?.costStructure;
  const costStructure = costStructureInput
    ? {
        cogsPercent: normalizeCommercialInputUnitInterval(
          costStructureInput.cogsPercent,
          "targetPack.costStructure.cogsPercent",
        ),
        shippingPercent: normalizeCommercialInputUnitInterval(
          costStructureInput.shippingPercent,
          "targetPack.costStructure.shippingPercent",
        ),
        fulfillmentPercent: normalizeCommercialInputUnitInterval(
          costStructureInput.fulfillmentPercent,
          "targetPack.costStructure.fulfillmentPercent",
        ),
        paymentProcessingPercent: normalizeCommercialInputUnitInterval(
          costStructureInput.paymentProcessingPercent,
          "targetPack.costStructure.paymentProcessingPercent",
        ),
      }
    : null;
  const targetPack = targetPackInput
    ? {
        ...createEmptyTargetPack(),
        targetCpa: normalizePositiveTargetAnchor(
          targetPackInput.targetCpa,
          "targetPack.targetCpa",
        ),
        targetRoas: normalizePositiveTargetAnchor(
          targetPackInput.targetRoas,
          "targetPack.targetRoas",
        ),
        breakEvenCpa: normalizePositiveTargetAnchor(
          targetPackInput.breakEvenCpa,
          "targetPack.breakEvenCpa",
        ),
        breakEvenRoas: normalizePositiveTargetAnchor(
          targetPackInput.breakEvenRoas,
          "targetPack.breakEvenRoas",
        ),
        contributionMarginAssumption: normalizeCommercialInputNumber(
          targetPackInput.contributionMarginAssumption,
          "targetPack.contributionMarginAssumption",
        ),
        // The operator AOV assumption is a hard-action ANCHOR (with a Target
        // ROAS it resolves the spend unit at high confidence), so it is
        // validated like the other anchors rather than as a loose secondary
        // number. A zero or negative AOV can never establish a spend unit —
        // the engine's `positiveFinite` guard drops it — and persisting one
        // silently told the operator they had configured an anchor when they
        // had not. Explicit null still clears it.
        aovAssumption: normalizePositiveTargetAnchor(
          targetPackInput.aovAssumption,
          "targetPack.aovAssumption",
        ),
        newCustomerWeight: normalizeCommercialInputNumber(
          targetPackInput.newCustomerWeight,
          "targetPack.newCustomerWeight",
        ),
        defaultRiskPosture: normalizeEnum(
          targetPackInput.defaultRiskPosture,
          BUSINESS_RISK_POSTURES,
          "balanced",
        ),
        costStructure,
        sourceLabel:
          normalizeString(targetPackInput.sourceLabel) ??
          "settings_manual_entry",
      }
    : null;

  const targetPackHasEconomicAnchor = Boolean(
    targetPack &&
    [
      targetPack.targetCpa,
      targetPack.targetRoas,
      targetPack.breakEvenCpa,
      targetPack.breakEvenRoas,
    ].some((value) => value !== null),
  );
  if (hasTargetPackValue(targetPack) && !targetPackHasEconomicAnchor) {
    throw new BusinessCommercialInputValidationError(
      "targetPack",
      "target_pack_has_no_economic_anchors",
      "targetPack must contain at least one CPA or ROAS economic anchor.",
    );
  }

  if (
    targetPack?.targetRoas != null &&
    targetPack.breakEvenRoas != null &&
    targetPack.targetRoas < targetPack.breakEvenRoas
  ) {
    throw new BusinessCommercialInputValidationError(
      "targetPack.targetRoas",
      "target_roas_below_break_even_roas",
      "targetPack.targetRoas must be greater than or equal to targetPack.breakEvenRoas.",
    );
  }
  if (
    targetPack?.targetCpa != null &&
    targetPack.breakEvenCpa != null &&
    targetPack.targetCpa > targetPack.breakEvenCpa
  ) {
    throw new BusinessCommercialInputValidationError(
      "targetPack.targetCpa",
      "target_cpa_above_break_even_cpa",
      "targetPack.targetCpa must be less than or equal to targetPack.breakEvenCpa.",
    );
  }

  const countryEconomics = dedupeByKey(
    (input?.countryEconomics ?? [])
      .map((row) => ({
        countryCode: normalizeString(row.countryCode)?.toUpperCase() ?? "",
        economicsMultiplier: normalizeCommercialInputNumber(
          row.economicsMultiplier,
          "countryEconomics.economicsMultiplier",
        ),
        marginModifier: normalizeCommercialInputNumber(
          row.marginModifier,
          "countryEconomics.marginModifier",
        ),
        serviceability: normalizeEnum(
          row.serviceability,
          BUSINESS_COUNTRY_SERVICEABILITY,
          "full",
        ),
        priorityTier: normalizeEnum(
          row.priorityTier,
          BUSINESS_COUNTRY_PRIORITY_TIERS,
          "tier_2",
        ),
        scaleOverride: normalizeEnum(
          row.scaleOverride,
          BUSINESS_COUNTRY_SCALE_OVERRIDES,
          "default",
        ),
        notes: normalizeString(row.notes),
        sourceLabel:
          normalizeString(row.sourceLabel) ?? "settings_manual_entry",
      }))
      .filter((row) => row.countryCode.length > 0),
    (row) => row.countryCode,
  );

  const promoCalendar = dedupeByKey(
    (input?.promoCalendar ?? [])
      .map((row, index) => {
        const startDate = normalizeDate(row.startDate);
        const endDate = normalizeDate(row.endDate);
        if (!startDate || !endDate) {
          return null;
        }
        return {
          eventId:
            normalizeString(row.eventId) ??
            `promo_${index + 1}_${startDate.replaceAll("-", "")}`,
          title: normalizeString(row.title) ?? "",
          promoType: normalizeEnum(row.promoType, BUSINESS_PROMO_TYPES, "sale"),
          severity: normalizeEnum(
            row.severity,
            BUSINESS_PROMO_SEVERITIES,
            "medium",
          ),
          startDate,
          endDate,
          affectedScope: normalizeString(row.affectedScope),
          notes: normalizeString(row.notes),
          sourceLabel:
            normalizeString(row.sourceLabel) ?? "settings_manual_entry",
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter((row) => row.title.length > 0)
      .filter((row) => row.endDate >= row.startDate),
    (row) => row.eventId,
  );

  const constraintsInput = input?.operatingConstraints;
  const operatingConstraints = constraintsInput
    ? {
        ...createEmptyOperatingConstraints(),
        siteIssueStatus: normalizeEnum(
          constraintsInput.siteIssueStatus,
          BUSINESS_ISSUE_STATUSES,
          "none",
        ),
        checkoutIssueStatus: normalizeEnum(
          constraintsInput.checkoutIssueStatus,
          BUSINESS_ISSUE_STATUSES,
          "none",
        ),
        conversionTrackingIssueStatus: normalizeEnum(
          constraintsInput.conversionTrackingIssueStatus,
          BUSINESS_ISSUE_STATUSES,
          "none",
        ),
        feedIssueStatus: normalizeEnum(
          constraintsInput.feedIssueStatus,
          BUSINESS_ISSUE_STATUSES,
          "none",
        ),
        stockPressureStatus: normalizeEnum(
          constraintsInput.stockPressureStatus,
          BUSINESS_STOCK_PRESSURE_STATUSES,
          "healthy",
        ),
        landingPageConcern: normalizeString(
          constraintsInput.landingPageConcern,
        ),
        merchandisingConcern: normalizeString(
          constraintsInput.merchandisingConcern,
        ),
        manualDoNotScaleReason: normalizeString(
          constraintsInput.manualDoNotScaleReason,
        ),
        sourceLabel:
          normalizeString(constraintsInput.sourceLabel) ??
          "settings_manual_entry",
      }
    : null;

  const calibrationProfiles = dedupeByKey(
    (input?.calibrationProfiles ?? [])
      .map((profile) => ({
        ...createEmptyDecisionCalibrationProfile(),
        channel: normalizeEnum(
          profile.channel,
          BUSINESS_DECISION_CALIBRATION_CHANNELS,
          "meta",
        ),
        objectiveFamily: normalizeEnum(
          profile.objectiveFamily,
          BUSINESS_DECISION_OBJECTIVE_FAMILIES,
          "unknown",
        ),
        bidRegime: normalizeEnum(
          profile.bidRegime,
          BUSINESS_DECISION_BID_REGIMES,
          "unknown",
        ),
        archetype: normalizeString(profile.archetype) ?? "default",
        targetRoasMultiplier: normalizeCommercialInputNumber(
          profile.targetRoasMultiplier,
          "calibrationProfiles.targetRoasMultiplier",
        ),
        breakEvenRoasMultiplier: normalizeCommercialInputNumber(
          profile.breakEvenRoasMultiplier,
          "calibrationProfiles.breakEvenRoasMultiplier",
        ),
        targetCpaMultiplier: normalizeCommercialInputNumber(
          profile.targetCpaMultiplier,
          "calibrationProfiles.targetCpaMultiplier",
        ),
        breakEvenCpaMultiplier: normalizeCommercialInputNumber(
          profile.breakEvenCpaMultiplier,
          "calibrationProfiles.breakEvenCpaMultiplier",
        ),
        confidenceCap: normalizeCommercialInputUnitInterval(
          profile.confidenceCap,
          "calibrationProfiles.confidenceCap",
        ),
        actionCeiling:
          typeof profile.actionCeiling === "string"
            ? normalizeEnum(
                profile.actionCeiling,
                [
                  "review_hold",
                  "review_reduce",
                  "monitor_low_truth",
                  "degraded_no_scale",
                ] as const,
                "review_hold",
              )
            : null,
        notes: normalizeString(profile.notes),
        sourceLabel:
          normalizeString(profile.sourceLabel) ?? "settings_manual_entry",
      }))
      .filter((profile) => profile.archetype.length > 0),
    (profile) =>
      [
        profile.channel,
        profile.objectiveFamily,
        profile.bidRegime,
        profile.archetype.toLowerCase(),
      ].join(":"),
  );

  return {
    businessId,
    targetPack: hasTargetPackValue(targetPack) ? targetPack : null,
    countryEconomics,
    promoCalendar,
    operatingConstraints: hasOperatingConstraintValue(operatingConstraints)
      ? operatingConstraints
      : null,
    calibrationProfiles,
  };
}

export async function getBusinessCommercialTruthSnapshot(
  businessId: string,
  options?: { sequentialQueries?: boolean },
): Promise<BusinessCommercialTruthSnapshot> {
  try {
    const readiness = await getDbSchemaReadiness({
      tables: COMMERCIAL_TRUTH_TABLES,
    });
    const emptySnapshot =
      createEmptyBusinessCommercialTruthSnapshot(businessId);

    if (!readiness.ready) {
      return {
        ...emptySnapshot,
        costModelContext: mapCostModelContext(
          await getBusinessCostModel(businessId).catch(() => null),
        ),
      };
    }

    const sql = getDb();
    const snapshotQueries = [
      () => sql`
        SELECT
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          to_char(
            updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS updated_at,
          updated_by_user_id
        FROM business_target_packs
        WHERE business_id = ${businessId}
        LIMIT 1
      `,
      () => sql`
        SELECT
          country_code,
          economics_multiplier,
          margin_modifier,
          serviceability,
          priority_tier,
          scale_override,
          notes,
          source_label,
          updated_at,
          updated_by_user_id
        FROM business_country_economics
        WHERE business_id = ${businessId}
        ORDER BY priority_tier ASC, country_code ASC
      `,
      () => sql`
        SELECT
          event_id,
          title,
          promo_type,
          severity,
          start_date::text AS start_date,
          end_date::text AS end_date,
          affected_scope,
          notes,
          source_label,
          updated_at,
          updated_by_user_id
        FROM business_promo_calendar_events
        WHERE business_id = ${businessId}
        ORDER BY start_date ASC, end_date ASC, title ASC
      `,
      () => sql`
        SELECT
          site_issue_status,
          checkout_issue_status,
          conversion_tracking_issue_status,
          feed_issue_status,
          stock_pressure_status,
          landing_page_concern,
          merchandising_concern,
          manual_do_not_scale_reason,
          source_label,
          updated_at,
          updated_by_user_id
        FROM business_operating_constraints
        WHERE business_id = ${businessId}
        LIMIT 1
      `,
      () => sql`
        SELECT
          channel,
          objective_family,
          bid_regime,
          archetype,
          target_roas_multiplier,
          break_even_roas_multiplier,
          target_cpa_multiplier,
          break_even_cpa_multiplier,
          confidence_cap,
          action_ceiling,
          notes,
          source_label,
          updated_at,
          updated_by_user_id
        FROM business_decision_calibration_profiles
        WHERE business_id = ${businessId}
        ORDER BY channel ASC, objective_family ASC, bid_regime ASC, archetype ASC
      `,
    ] as const;
    const snapshotResults: unknown[][] = [];
    if (options?.sequentialQueries) {
      for (const query of snapshotQueries) {
        snapshotResults.push(await query());
      }
    } else {
      snapshotResults.push(
        ...(await Promise.all(snapshotQueries.map((query) => query()))),
      );
    }
    const [
      targetRows,
      countryRows,
      promoRows,
      constraintRows,
      calibrationRows,
    ] = snapshotResults;

    const targetPack = mapTargetPackRow((targetRows as TargetPackRow[])[0]);
    const countryEconomics = (countryRows as CountryEconomicsRow[]).map(
      mapCountryEconomicsRow,
    );
    const promoCalendar = (promoRows as PromoCalendarRow[]).map(mapPromoRow);
    const operatingConstraints = mapConstraintsRow(
      (constraintRows as OperatingConstraintsRow[])[0],
    );
    const calibrationProfiles = (
      calibrationRows as CalibrationProfileRow[]
    ).map(mapCalibrationProfileRow);
    const costModelContext = mapCostModelContext(
      await getBusinessCostModel(businessId).catch(() => null),
    );

    const sectionMeta = {
      targetPack: buildSectionMeta(
        "targetPack",
        targetPack ? [targetPack] : [],
      ),
      countryEconomics: buildSectionMeta("countryEconomics", countryEconomics),
      promoCalendar: buildSectionMeta("promoCalendar", promoCalendar),
      operatingConstraints: buildSectionMeta(
        "operatingConstraints",
        operatingConstraints ? [operatingConstraints] : [],
      ),
    } satisfies BusinessCommercialTruthSnapshot["sectionMeta"];

    return {
      businessId,
      targetPack,
      countryEconomics,
      promoCalendar,
      operatingConstraints,
      costModelContext,
      calibrationProfiles,
      sectionMeta,
      coverage: buildCommercialCoverageSummary({
        targetPack,
        countryEconomics,
        promoCalendar,
        operatingConstraints,
        sectionMeta,
        calibrationProfiles,
      }),
      bootstrapSuggestions: buildBootstrapSuggestions({
        promoCalendar,
        calibrationProfiles,
      }),
    };
  } catch (error) {
    if (isMissingRelationError(error, COMMERCIAL_TRUTH_TABLES)) {
      return {
        ...createEmptyBusinessCommercialTruthSnapshot(businessId),
        costModelContext: mapCostModelContext(
          await getBusinessCostModel(businessId).catch(() => null),
        ),
      };
    }
    throw error;
  }
}

export async function getBusinessTargetPackHistoryAsOf(input: {
  businessId: string;
  asOf: string | Date;
}): Promise<BusinessTargetPackData | null> {
  await assertDbSchemaReady({
    tables: ["business_target_pack_history"],
    context: "business_target_pack_history_as_of_read",
  });

  const asOfCutoff = normalizeAsOfCutoff(input.asOf);
  const sql = getDb();
  const rows = await sql`
    SELECT
      target_cpa,
      target_roas,
      break_even_cpa,
      break_even_roas,
      contribution_margin_assumption,
      aov_assumption,
      new_customer_weight,
      default_risk_posture,
      cost_cogs_percent,
      cost_shipping_percent,
      cost_fulfillment_percent,
      cost_payment_processing_percent,
      source_label,
      effective_at AS updated_at,
      updated_by_user_id,
      operation,
      effective_at,
      recorded_at
    FROM business_target_pack_history
    WHERE business_id = ${input.businessId}
      AND effective_at <= ${asOfCutoff}::timestamptz
      AND recorded_at <= ${asOfCutoff}::timestamptz
    ORDER BY effective_at DESC, recorded_at DESC, id DESC
    LIMIT 1
  `;
  const row = (rows as TargetPackHistoryRow[])[0];
  if (!row || row.operation !== "upsert") return null;
  return mapTargetPackRow(row);
}

export async function listBusinessTargetPackHistory(input: {
  businessId: string;
  limit?: number;
}): Promise<BusinessTargetPackHistoryEntry[]> {
  await assertDbSchemaReady({
    tables: ["business_target_pack_history"],
    context: "business_target_pack_history_list",
  });

  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
  const sql = getDb();
  const rows = await sql`
    SELECT
      id::text,
      target_cpa,
      target_roas,
      break_even_cpa,
      break_even_roas,
      contribution_margin_assumption,
      aov_assumption,
      new_customer_weight,
      default_risk_posture,
      cost_cogs_percent,
      cost_shipping_percent,
      cost_fulfillment_percent,
      cost_payment_processing_percent,
      source_label,
      effective_at AS updated_at,
      updated_by_user_id,
      operation,
      effective_at,
      recorded_at
    FROM business_target_pack_history
    WHERE business_id = ${input.businessId}
    ORDER BY effective_at DESC, recorded_at DESC, id DESC
    LIMIT ${limit}
  `;

  return (rows as TargetPackHistoryRow[]).map((row) => ({
    id: row.id,
    operation: row.operation,
    effectiveAt: normalizeTimestampValue(row.effective_at) ?? new Date(0).toISOString(),
    recordedAt: normalizeTimestampValue(row.recorded_at) ?? new Date(0).toISOString(),
    sourceLabel: normalizeString(row.source_label),
    updatedByUserId: row.updated_by_user_id,
    targetPack: row.operation === "upsert" ? mapTargetPackRow(row) : null,
  }));
}

export async function reconfirmBusinessTargetPack(input: {
  businessId: string;
  updatedByUserId: string;
  expectedUpdatedAt: string;
}): Promise<BusinessTargetPackReconfirmationResult> {
  await assertDbSchemaReady({
    tables: ["business_target_packs", "business_target_pack_history"],
    context: "business_target_pack_reconfirmation",
  });

  const rows = await runDbTransaction(async () => {
    await acquireBusinessCommercialAdvisoryLock(input.businessId);
    const sql = getDb();
    return sql<TargetPackReconfirmationRow>`
    /* target-pack-reconfirmation */
    WITH params AS (
      SELECT
        ${input.businessId}::uuid AS business_id,
        ${input.expectedUpdatedAt}::timestamptz AS expected_updated_at,
        ${input.updatedByUserId}::uuid AS updated_by_user_id
    ), current_row AS MATERIALIZED (
      SELECT
        target.business_id,
        target.business_ref_id,
        target.target_cpa,
        target.target_roas,
        target.break_even_cpa,
        target.break_even_roas,
        target.contribution_margin_assumption,
        target.aov_assumption,
        target.new_customer_weight,
        target.default_risk_posture,
        target.cost_cogs_percent,
        target.cost_shipping_percent,
        target.cost_fulfillment_percent,
        target.cost_payment_processing_percent,
        target.source_label,
        target.updated_by_user_id,
        target.updated_at
      FROM business_target_packs target
      JOIN params ON params.business_id = target.business_id
      FOR UPDATE OF target
    ), assessment AS (
      SELECT
        current_row.*,
        CASE
          WHEN current_row.business_id IS NULL THEN 'target_pack_missing'
          WHEN current_row.updated_at IS DISTINCT FROM params.expected_updated_at
            THEN 'target_pack_changed'
          WHEN current_row.target_cpa IS NULL
            AND current_row.target_roas IS NULL
            AND current_row.break_even_cpa IS NULL
            AND current_row.break_even_roas IS NULL
            THEN 'target_pack_has_no_economic_anchors'
          WHEN current_row.target_cpa IS NOT NULL
            AND NOT (
              current_row.target_cpa > 0
              AND current_row.target_cpa < 'Infinity'::double precision
            ) THEN 'target_cpa_must_be_positive_finite'
          WHEN current_row.target_roas IS NOT NULL
            AND NOT (
              current_row.target_roas > 0
              AND current_row.target_roas < 'Infinity'::double precision
            ) THEN 'target_roas_must_be_positive_finite'
          WHEN current_row.break_even_cpa IS NOT NULL
            AND NOT (
              current_row.break_even_cpa > 0
              AND current_row.break_even_cpa < 'Infinity'::double precision
            ) THEN 'break_even_cpa_must_be_positive_finite'
          WHEN current_row.break_even_roas IS NOT NULL
            AND NOT (
              current_row.break_even_roas > 0
              AND current_row.break_even_roas < 'Infinity'::double precision
            ) THEN 'break_even_roas_must_be_positive_finite'
          WHEN current_row.target_roas IS NOT NULL
            AND current_row.break_even_roas IS NOT NULL
            AND current_row.target_roas < current_row.break_even_roas
            THEN 'target_roas_below_break_even_roas'
          WHEN current_row.target_cpa IS NOT NULL
            AND current_row.break_even_cpa IS NOT NULL
            AND current_row.target_cpa > current_row.break_even_cpa
            THEN 'target_cpa_above_break_even_cpa'
          ELSE 'target_pack_reconfirmed'
        END AS reason
      FROM params
      LEFT JOIN current_row ON true
    ), evaluation AS (
      SELECT
        assessment.*,
        CASE
          WHEN assessment.reason = 'target_pack_missing' THEN 'missing'
          WHEN assessment.reason = 'target_pack_changed' THEN 'conflict'
          WHEN assessment.reason = 'target_pack_reconfirmed' THEN 'eligible'
          ELSE 'invalid_target_pack'
        END AS result_status
      FROM assessment
    ), write_clock AS MATERIALIZED (
      SELECT
        GREATEST(
          clock_timestamp(),
          evaluation.updated_at + INTERVAL '1 microsecond'
        ) AS effective_at
      FROM evaluation
      WHERE evaluation.result_status = 'eligible'
    ), updated_row AS (
      UPDATE business_target_packs target
      SET
        updated_at = write_clock.effective_at,
        updated_by_user_id = params.updated_by_user_id
      FROM params, evaluation, write_clock
      WHERE evaluation.result_status = 'eligible'
        AND target.business_id = evaluation.business_id
        AND target.updated_at = params.expected_updated_at
      RETURNING
        target.business_id,
        target.business_ref_id,
        target.target_cpa,
        target.target_roas,
        target.break_even_cpa,
        target.break_even_roas,
        target.contribution_margin_assumption,
        target.aov_assumption,
        target.new_customer_weight,
        target.default_risk_posture,
        target.cost_cogs_percent,
        target.cost_shipping_percent,
        target.cost_fulfillment_percent,
        target.cost_payment_processing_percent,
        target.source_label,
        target.updated_by_user_id,
        target.updated_at
    ), history_write AS (
      INSERT INTO business_target_pack_history (
        business_id,
        business_ref_id,
        target_cpa,
        target_roas,
        break_even_cpa,
        break_even_roas,
        contribution_margin_assumption,
        aov_assumption,
        new_customer_weight,
        default_risk_posture,
        cost_cogs_percent,
        cost_shipping_percent,
        cost_fulfillment_percent,
        cost_payment_processing_percent,
        source_label,
        operation,
        effective_at,
        recorded_at,
        updated_by_user_id
      )
      SELECT
        business_id,
        business_ref_id,
        target_cpa,
        target_roas,
        break_even_cpa,
        break_even_roas,
        contribution_margin_assumption,
        aov_assumption,
        new_customer_weight,
        default_risk_posture,
        cost_cogs_percent,
        cost_shipping_percent,
        cost_fulfillment_percent,
        cost_payment_processing_percent,
        source_label,
        'upsert',
        updated_at,
        updated_at,
        updated_by_user_id
      FROM updated_row
      RETURNING business_id, effective_at AS updated_at
    )
    SELECT
      CASE
        WHEN history_write.business_id IS NOT NULL THEN 'reconfirmed'
        WHEN evaluation.result_status = 'eligible' THEN 'write_failed'
        ELSE evaluation.result_status
      END AS result_status,
      CASE
        WHEN history_write.business_id IS NOT NULL THEN 'target_pack_reconfirmed'
        WHEN evaluation.result_status = 'eligible'
          THEN 'target_pack_reconfirmation_write_failed'
        ELSE evaluation.reason
      END AS reason,
      to_char(
        COALESCE(history_write.updated_at, evaluation.updated_at)
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS updated_at
    FROM evaluation
    LEFT JOIN history_write ON true
    `;
  });

  const row = rows[0];
  if (!row) {
    throw new Error("Target pack reconfirmation did not return a result.");
  }

  if (row.result_status === "missing") {
    return { status: "missing", reason: "target_pack_missing" };
  }
  if (row.result_status === "write_failed") {
    throw new Error(
      "Target pack reconfirmation did not persist its history row.",
    );
  }

  const updatedAt = normalizeTimestampValue(row.updated_at);
  if (!updatedAt) {
    throw new Error(
      `Target pack reconfirmation returned ${row.result_status} without updated_at.`,
    );
  }

  if (row.result_status === "reconfirmed") {
    return {
      status: "reconfirmed",
      reason: "target_pack_reconfirmed",
      updatedAt,
    };
  }
  if (row.result_status === "conflict") {
    return {
      status: "conflict",
      reason: "target_pack_changed",
      currentUpdatedAt: updatedAt,
    };
  }
  return {
    status: "invalid_target_pack",
    reason: row.reason,
    currentUpdatedAt: updatedAt,
  };
}

export async function upsertBusinessCommercialTruthSnapshot(input: {
  businessId: string;
  updatedByUserId: string | null;
  snapshot: Partial<BusinessCommercialTruthSnapshot> | null | undefined;
  expectedRevision?: string | null;
}) {
  await assertDbSchemaReady({
    tables: COMMERCIAL_TRUTH_WRITE_TABLES,
    context: "business_commercial_truth_upsert",
  });

  const sanitized = sanitizeBusinessCommercialTruthInput(
    input.businessId,
    input.snapshot,
  );
  const businessRefIds = await resolveBusinessReferenceIds([
    sanitized.businessId,
  ]);
  const businessRefId = businessRefIds.get(sanitized.businessId) ?? null;

  await runDbTransaction(async () => {
    const sql = getDb();
    await acquireBusinessCommercialAdvisoryLock(sanitized.businessId);
    if (input.expectedRevision !== undefined) {
      const currentSnapshot = await getBusinessCommercialTruthSnapshot(
        sanitized.businessId,
        { sequentialQueries: true },
      );
      const currentRevision =
        businessCommercialSnapshotRevision(currentSnapshot);
      if (input.expectedRevision !== currentRevision) {
        throw new BusinessCommercialSnapshotConflictError(currentRevision);
      }
    }

    if (sanitized.targetPack) {
      await sql`
      WITH write_clock AS (
        SELECT now() AS effective_at
      ), current_write AS (
        INSERT INTO business_target_packs (
          business_id,
          business_ref_id,
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          updated_by_user_id,
          updated_at
        )
        SELECT
          ${sanitized.businessId},
          ${businessRefId},
          ${sanitized.targetPack.targetCpa},
          ${sanitized.targetPack.targetRoas},
          ${sanitized.targetPack.breakEvenCpa},
          ${sanitized.targetPack.breakEvenRoas},
          ${sanitized.targetPack.contributionMarginAssumption},
          ${sanitized.targetPack.aovAssumption},
          ${sanitized.targetPack.newCustomerWeight},
          ${sanitized.targetPack.defaultRiskPosture},
          ${sanitized.targetPack.costStructure?.cogsPercent ?? null},
          ${sanitized.targetPack.costStructure?.shippingPercent ?? null},
          ${sanitized.targetPack.costStructure?.fulfillmentPercent ?? null},
          ${sanitized.targetPack.costStructure?.paymentProcessingPercent ?? null},
          ${sanitized.targetPack.sourceLabel},
          ${input.updatedByUserId},
          write_clock.effective_at
        FROM write_clock
        WHERE true
        ON CONFLICT (business_id)
        DO UPDATE SET
          business_ref_id = COALESCE(business_target_packs.business_ref_id, EXCLUDED.business_ref_id),
          target_cpa = EXCLUDED.target_cpa,
          target_roas = EXCLUDED.target_roas,
          break_even_cpa = EXCLUDED.break_even_cpa,
          break_even_roas = EXCLUDED.break_even_roas,
          contribution_margin_assumption = EXCLUDED.contribution_margin_assumption,
          aov_assumption = EXCLUDED.aov_assumption,
          new_customer_weight = EXCLUDED.new_customer_weight,
          default_risk_posture = EXCLUDED.default_risk_posture,
          cost_cogs_percent = EXCLUDED.cost_cogs_percent,
          cost_shipping_percent = EXCLUDED.cost_shipping_percent,
          cost_fulfillment_percent = EXCLUDED.cost_fulfillment_percent,
          cost_payment_processing_percent = EXCLUDED.cost_payment_processing_percent,
          source_label = EXCLUDED.source_label,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = EXCLUDED.updated_at
        WHERE ROW(
          business_target_packs.business_ref_id,
          business_target_packs.target_cpa,
          business_target_packs.target_roas,
          business_target_packs.break_even_cpa,
          business_target_packs.break_even_roas,
          business_target_packs.contribution_margin_assumption,
          business_target_packs.aov_assumption,
          business_target_packs.new_customer_weight,
          business_target_packs.default_risk_posture,
          business_target_packs.cost_cogs_percent,
          business_target_packs.cost_shipping_percent,
          business_target_packs.cost_fulfillment_percent,
          business_target_packs.cost_payment_processing_percent,
          business_target_packs.source_label
        ) IS DISTINCT FROM ROW(
          COALESCE(business_target_packs.business_ref_id, EXCLUDED.business_ref_id),
          EXCLUDED.target_cpa,
          EXCLUDED.target_roas,
          EXCLUDED.break_even_cpa,
          EXCLUDED.break_even_roas,
          EXCLUDED.contribution_margin_assumption,
          EXCLUDED.aov_assumption,
          EXCLUDED.new_customer_weight,
          EXCLUDED.default_risk_posture,
          EXCLUDED.cost_cogs_percent,
          EXCLUDED.cost_shipping_percent,
          EXCLUDED.cost_fulfillment_percent,
          EXCLUDED.cost_payment_processing_percent,
          EXCLUDED.source_label
        )
        RETURNING
          business_id,
          business_ref_id,
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          updated_by_user_id,
          updated_at
      )
      INSERT INTO business_target_pack_history (
        business_id,
        business_ref_id,
        target_cpa,
        target_roas,
        break_even_cpa,
        break_even_roas,
        contribution_margin_assumption,
        aov_assumption,
        new_customer_weight,
        default_risk_posture,
        cost_cogs_percent,
        cost_shipping_percent,
        cost_fulfillment_percent,
        cost_payment_processing_percent,
        source_label,
        operation,
        effective_at,
        recorded_at,
        updated_by_user_id
      )
      SELECT
        business_id,
        business_ref_id,
        target_cpa,
        target_roas,
        break_even_cpa,
        break_even_roas,
        contribution_margin_assumption,
        aov_assumption,
        new_customer_weight,
        default_risk_posture,
        cost_cogs_percent,
        cost_shipping_percent,
        cost_fulfillment_percent,
        cost_payment_processing_percent,
        source_label,
        'upsert',
        updated_at,
        updated_at,
        updated_by_user_id
      FROM current_write
    `;
    } else {
      await sql`
      WITH write_clock AS (
        SELECT now() AS effective_at
      ), current_row AS (
        SELECT
          target.business_id,
          target.business_ref_id,
          target.target_cpa,
          target.target_roas,
          target.break_even_cpa,
          target.break_even_roas,
          target.contribution_margin_assumption,
          target.aov_assumption,
          target.new_customer_weight,
          target.default_risk_posture,
          target.cost_cogs_percent,
          target.cost_shipping_percent,
          target.cost_fulfillment_percent,
          target.cost_payment_processing_percent,
          target.source_label,
          write_clock.effective_at
        FROM business_target_packs target
        CROSS JOIN write_clock
        WHERE target.business_id = ${sanitized.businessId}
        FOR UPDATE OF target
      ), history_write AS (
        INSERT INTO business_target_pack_history (
          business_id,
          business_ref_id,
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          operation,
          effective_at,
          recorded_at,
          updated_by_user_id
        )
        SELECT
          business_id,
          business_ref_id,
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          'delete',
          effective_at,
          effective_at,
          ${input.updatedByUserId}
        FROM current_row
        RETURNING business_id
      )
      DELETE FROM business_target_packs target
      USING history_write
      WHERE target.business_id = history_write.business_id
    `;
    }

    await sql`DELETE FROM business_country_economics WHERE business_id = ${sanitized.businessId}`;
    for (const row of sanitized.countryEconomics) {
      await sql`
      INSERT INTO business_country_economics (
        business_id,
        business_ref_id,
        country_code,
        economics_multiplier,
        margin_modifier,
        serviceability,
        priority_tier,
        scale_override,
        notes,
        source_label,
        updated_by_user_id,
        updated_at
      )
      VALUES (
        ${sanitized.businessId},
        ${businessRefId},
        ${row.countryCode},
        ${row.economicsMultiplier},
        ${row.marginModifier},
        ${row.serviceability},
        ${row.priorityTier},
        ${row.scaleOverride},
        ${row.notes},
        ${row.sourceLabel},
        ${input.updatedByUserId},
        now()
      )
      ON CONFLICT (business_id, country_code)
      DO UPDATE SET
        business_ref_id = COALESCE(
          business_country_economics.business_ref_id,
          EXCLUDED.business_ref_id
        ),
        economics_multiplier = EXCLUDED.economics_multiplier,
        margin_modifier = EXCLUDED.margin_modifier,
        serviceability = EXCLUDED.serviceability,
        priority_tier = EXCLUDED.priority_tier,
        scale_override = EXCLUDED.scale_override,
        notes = EXCLUDED.notes,
        source_label = EXCLUDED.source_label,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
    `;
    }

    await sql`DELETE FROM business_promo_calendar_events WHERE business_id = ${sanitized.businessId}`;
    for (const row of sanitized.promoCalendar) {
      await sql`
      INSERT INTO business_promo_calendar_events (
        business_id,
        business_ref_id,
        event_id,
        title,
        promo_type,
        severity,
        start_date,
        end_date,
        affected_scope,
        notes,
        source_label,
        updated_by_user_id,
        updated_at
      )
      VALUES (
        ${sanitized.businessId},
        ${businessRefId},
        ${row.eventId},
        ${row.title},
        ${row.promoType},
        ${row.severity},
        ${row.startDate},
        ${row.endDate},
        ${row.affectedScope},
        ${row.notes},
        ${row.sourceLabel},
        ${input.updatedByUserId},
        now()
      )
      ON CONFLICT (business_id, event_id)
      DO UPDATE SET
        business_ref_id = COALESCE(
          business_promo_calendar_events.business_ref_id,
          EXCLUDED.business_ref_id
        ),
        title = EXCLUDED.title,
        promo_type = EXCLUDED.promo_type,
        severity = EXCLUDED.severity,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        affected_scope = EXCLUDED.affected_scope,
        notes = EXCLUDED.notes,
        source_label = EXCLUDED.source_label,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
    `;
    }

    if (sanitized.operatingConstraints) {
      await sql`
      INSERT INTO business_operating_constraints (
        business_id,
        business_ref_id,
        site_issue_status,
        checkout_issue_status,
        conversion_tracking_issue_status,
        feed_issue_status,
        stock_pressure_status,
        landing_page_concern,
        merchandising_concern,
        manual_do_not_scale_reason,
        source_label,
        updated_by_user_id,
        updated_at
      )
      VALUES (
        ${sanitized.businessId},
        ${businessRefId},
        ${sanitized.operatingConstraints.siteIssueStatus},
        ${sanitized.operatingConstraints.checkoutIssueStatus},
        ${sanitized.operatingConstraints.conversionTrackingIssueStatus},
        ${sanitized.operatingConstraints.feedIssueStatus},
        ${sanitized.operatingConstraints.stockPressureStatus},
        ${sanitized.operatingConstraints.landingPageConcern},
        ${sanitized.operatingConstraints.merchandisingConcern},
        ${sanitized.operatingConstraints.manualDoNotScaleReason},
        ${sanitized.operatingConstraints.sourceLabel},
        ${input.updatedByUserId},
        now()
      )
      ON CONFLICT (business_id)
      DO UPDATE SET
        business_ref_id = COALESCE(
          business_operating_constraints.business_ref_id,
          EXCLUDED.business_ref_id
        ),
        site_issue_status = EXCLUDED.site_issue_status,
        checkout_issue_status = EXCLUDED.checkout_issue_status,
        conversion_tracking_issue_status = EXCLUDED.conversion_tracking_issue_status,
        feed_issue_status = EXCLUDED.feed_issue_status,
        stock_pressure_status = EXCLUDED.stock_pressure_status,
        landing_page_concern = EXCLUDED.landing_page_concern,
        merchandising_concern = EXCLUDED.merchandising_concern,
        manual_do_not_scale_reason = EXCLUDED.manual_do_not_scale_reason,
        source_label = EXCLUDED.source_label,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
    `;
    } else {
      await sql`
      DELETE FROM business_operating_constraints
      WHERE business_id = ${sanitized.businessId}
    `;
    }

    // `business_decision_calibration_profiles` is shared: the commercial-truth
    // snapshot owns the four target multipliers, confidence cap, action
    // ceiling, notes and source label, while the decision engine separately
    // owns `engine_preset_label`, the eight threshold multipliers and
    // `attribution_aov_adjustment_multiplier` (read by
    // READ_DECISION_CALIBRATION_PROFILE_QUERY). The snapshot neither reads nor
    // writes the engine-owned columns, so deleting every row and re-inserting
    // the settings-owned subset silently reset them on EVERY save — including
    // the attribution AOV multiplier that scales the Meta-derived spend unit.
    // Delete only the profiles the operator actually removed; the ones that
    // survive go through INSERT ... ON CONFLICT DO UPDATE below, which only
    // ever assigns the settings-owned columns.
    const retainedCalibrationProfileKeys = new Set(
      (sanitized.calibrationProfiles ?? []).map((profile) =>
        calibrationProfileIdentityKey({
          channel: profile.channel,
          objectiveFamily: profile.objectiveFamily,
          bidRegime: profile.bidRegime,
          archetype: profile.archetype,
        }),
      ),
    );
    const existingCalibrationProfiles = (await sql`
    SELECT channel, objective_family, bid_regime, archetype
    FROM business_decision_calibration_profiles
    WHERE business_id = ${sanitized.businessId}
  `) as Array<{
      channel: string;
      objective_family: string;
      bid_regime: string;
      archetype: string;
    }>;
    for (const existing of existingCalibrationProfiles) {
      const identity = calibrationProfileIdentityKey({
        channel: existing.channel,
        objectiveFamily: existing.objective_family,
        bidRegime: existing.bid_regime,
        archetype: existing.archetype,
      });
      if (retainedCalibrationProfileKeys.has(identity)) continue;
      await sql`
      DELETE FROM business_decision_calibration_profiles
      WHERE business_id = ${sanitized.businessId}
        AND channel = ${existing.channel}
        AND objective_family = ${existing.objective_family}
        AND bid_regime = ${existing.bid_regime}
        AND archetype = ${existing.archetype}
    `;
    }
    for (const profile of sanitized.calibrationProfiles ?? []) {
      await sql`
      INSERT INTO business_decision_calibration_profiles (
        business_id,
        business_ref_id,
        channel,
        objective_family,
        bid_regime,
        archetype,
        target_roas_multiplier,
        break_even_roas_multiplier,
        target_cpa_multiplier,
        break_even_cpa_multiplier,
        confidence_cap,
        action_ceiling,
        notes,
        source_label,
        updated_by_user_id,
        updated_at
      )
      VALUES (
        ${sanitized.businessId},
        ${businessRefId},
        ${profile.channel},
        ${profile.objectiveFamily},
        ${profile.bidRegime},
        ${profile.archetype},
        ${profile.targetRoasMultiplier},
        ${profile.breakEvenRoasMultiplier},
        ${profile.targetCpaMultiplier},
        ${profile.breakEvenCpaMultiplier},
        ${profile.confidenceCap},
        ${profile.actionCeiling},
        ${profile.notes},
        ${profile.sourceLabel},
        ${input.updatedByUserId},
        now()
      )
      ON CONFLICT (business_id, channel, objective_family, bid_regime, archetype)
      DO UPDATE SET
        business_ref_id = COALESCE(
          business_decision_calibration_profiles.business_ref_id,
          EXCLUDED.business_ref_id
        ),
        target_roas_multiplier = EXCLUDED.target_roas_multiplier,
        break_even_roas_multiplier = EXCLUDED.break_even_roas_multiplier,
        target_cpa_multiplier = EXCLUDED.target_cpa_multiplier,
        break_even_cpa_multiplier = EXCLUDED.break_even_cpa_multiplier,
        confidence_cap = EXCLUDED.confidence_cap,
        action_ceiling = EXCLUDED.action_ceiling,
        notes = EXCLUDED.notes,
        source_label = EXCLUDED.source_label,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
    `;
    }
  });

  return getBusinessCommercialTruthSnapshot(input.businessId);
}
