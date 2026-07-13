#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { ENGINE_PRESET_MULTIPLIERS } from "@/lib/creative-decision-engine/config-values";
import { assignRollingOriginFold } from "@/lib/creative-decision-engine/simulation/evaluation-folds";
import { clusteredMovingBlockBootstrap } from "@/lib/creative-decision-engine/simulation/clustered-moving-block-bootstrap";
import {
  H1_COUNTRY_PARENT_CONTRACT_VERSION,
  H1_COUNTRY_PARENT_SOURCE_MODE,
  buildAdCountrySpendMix,
  buildH1CountryParentGrid,
  comparePairedH1CountryEvaluations,
  countryParentStableHash,
  normalizeCountryGenerationRows,
  prepareH1CountryParentThresholdResolver,
  reconcileCountryAdDaySpend,
  selectLatestCompleteCountryGeneration,
  selectLatestCompleteCountryGenerationAtCutoff,
  summarizeH1CountryEvaluations,
  type AdCountrySpendMix,
  type CountryAdDayReconciliation,
  type CountryCalibrationObservation,
  type H1CountryEvaluationRow,
  type H1CountryOutcomeStatus,
  type H1CountryParentVariant,
  type MetaAdDaySpendFact,
  type NormalizedCountryAdDayRow,
  type RawCountrySnapshotPage,
} from "@/lib/creative-decision-engine/simulation/country-conditioned-calibration";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";
import { resolveMetaFunnelCohort } from "@/lib/meta/funnel-cohort";

export const H1_COUNTRY_PARENT_CHALLENGER_VERSION =
  "h1-country-parent-challenger.v1" as const;
export const H1_COUNTRY_PARENT_QUERY_POLICY = {
  databaseTransaction: "read_only",
  providerCalls: false,
  databaseWrites: false,
  filesystemWrites: false,
  manualCron: false,
  output: "stdout_json_only",
} as const;

const DEFAULT_START_DATE = "2025-12-01";
const DEFAULT_DECISION_END_DATE = "2026-07-05";
const DEFAULT_OUTCOME_CEILING = "2026-07-11";
export const H1_COUNTRY_OUTCOME_WINDOWS = [3, 7, 14] as const;
export type H1CountryOutcomeWindowDays =
  (typeof H1_COUNTRY_OUTCOME_WINDOWS)[number];
const PRIMARY_OUTCOME_WINDOW_DAYS: H1CountryOutcomeWindowDays = 14;
const DECISION_COOLDOWN_DAYS = 7;
const TARGET_FRESHNESS_DAYS = 30;
const QUERY_TIMEOUT_MS = 180_000;
export const DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC = "03:00:00.000Z";
const MAX_REJECTED_SCOPE_EXAMPLES = 100;

type DbRow = Record<string, unknown>;

export interface ParsedH1CountryArgs {
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  businesses: string[];
  producerCutoffUtc: string;
}

export interface H1CountryMetaFact {
  businessId: string;
  legacyBusinessId: string;
  businessName: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  currency: string | null;
  objective: string | null;
  goal: string | null;
  customEventType: string | null;
  spend: number;
  impressions: number;
  conversions: number;
  revenue: number;
  sourceId: string | null;
  updatedAt: string | null;
}

export interface H1CountryTargetPack {
  id: string | null;
  businessId: string;
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  riskPosture: "aggressive" | "balanced" | "conservative";
  updatedAt: string | null;
}

export interface H1CountryAccountCompleteness {
  businessId: string;
  providerAccountId: string;
  date: string;
  complete: boolean;
  sourceIds: string[];
}

interface AggregateMetrics {
  spend: number;
  impressions: number;
  conversions: number;
  revenue: number;
  roas: number | null;
  cpa: number | null;
  lastSpendDate: string | null;
  sourceIds: string[];
}

export interface FixedCountryCalibrationEnvironment {
  id: string;
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  asOfDate: string;
  observations: CountryCalibrationObservation[];
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  totalPurchases: number;
  totalRevenue: number;
  environmentHash: string;
}

export interface FixedH1CountryCohortRow {
  key: string;
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  manifestHash: string;
  businessId: string;
  businessName: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  currency: string | null;
  objective: string | null;
  goal: string | null;
  customEventType: string | null;
  purchaseCohort: boolean;
  target: H1CountryTargetPack | null;
  targetObservedAtCutoff: boolean;
  targetFresh: boolean;
  spend28: number;
  conversions28: number;
  revenue28: number;
  roas28: number | null;
  ratioToTarget: number | null;
  recent7Spend: number;
  recent7Roas: number | null;
  commercialMaturitySpend: number | null;
  recentSampleMinSpend: number | null;
  recoveryHold: boolean;
  breakEvenRatio: number | null;
  countryMix: AdCountrySpendMix;
  calibrationEnvironmentId: string;
  outcome: FixedH1CountryOutcome;
  outcomes: Record<H1CountryOutcomeWindowDays, FixedH1CountryOutcome>;
  missingFields: string[];
}

export interface FixedH1CountryOutcome {
  windowDays: H1CountryOutcomeWindowDays;
  dueDate: string;
  complete: boolean;
  status: H1CountryOutcomeStatus;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number | null;
  cutOpportunity: boolean | null;
  completenessSourceIds: string[];
}

export interface FixedH1CountryCohort {
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  rows: FixedH1CountryCohortRow[];
  environments: FixedCountryCalibrationEnvironment[];
  fixedCohortHash: string;
  manifestSetHash: string;
  coverage: {
    rows: number;
    uniqueKeys: number;
    purchaseCohortRows: number;
    targetObservedRows: number;
    targetFreshRows: number;
    completeOutcomeRows: number;
    completeOutcomeRowsByWindow: Record<
      `${H1CountryOutcomeWindowDays}d`,
      number
    >;
    countryMixAvailableRows: number;
    multiCountryRows: number;
    countryMixFallbackRows: number;
    countryMixMetaSpend: number;
    countryMixReconciledSpend: number;
    countryMixSpendCoverage: number | null;
  };
}

interface LoadedH1CountrySources {
  facts: H1CountryMetaFact[];
  targets: H1CountryTargetPack[];
  completeness: H1CountryAccountCompleteness[];
  countryRows: NormalizedCountryAdDayRow[];
  resolveCountryMix: H1CountryMixResolver;
  rawCoverage: {
    retainedPageRows: number;
    plannedCutoffSourceScopes: number;
    selectedGenerations: number;
    selectedCountryRows: number;
    incompleteOrInvalidLatestGenerations: number;
    invalidUniqueGenerations: number;
    unmappedRawScopes: number;
    generationSourceHashes: string[];
    rejectedScopes: Array<{ scope: string; reason: string }>;
    reconciliationStatusCounts: Record<string, number>;
    selectionPlanHash: string;
  };
  sourceHash: string;
}

export interface H1CountryMixScope {
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  goal: string | null;
  adId: string;
  asOfDate: string;
}

export type H1CountryMixResolver = (
  input: H1CountryMixScope,
) => AdCountrySpendMix;

function cliValue(argv: readonly string[], name: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function assertDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD`);
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return value;
}

function assertProducerCutoffUtc(value: string) {
  if (!/^\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("producerCutoffUtc must use HH:mm:ss.sssZ");
  }
  const timestamp = Date.parse(`2026-01-01T${value}`);
  if (!Number.isFinite(timestamp)) {
    throw new Error("producerCutoffUtc must be a valid UTC time");
  }
  return value;
}

export function h1CountryProducerCutoff(
  date: string,
  producerCutoffUtc = DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC,
) {
  return `${assertDate(date, "producer cutoff date")}T${assertProducerCutoffUtc(producerCutoffUtc)}`;
}

export function parseH1CountryArgs(
  argv: readonly string[],
): ParsedH1CountryArgs {
  const startDate = assertDate(
    cliValue(argv, "start") ?? DEFAULT_START_DATE,
    "start",
  );
  const decisionEndDate = assertDate(
    cliValue(argv, "end") ?? DEFAULT_DECISION_END_DATE,
    "end",
  );
  const outcomeCeiling = assertDate(
    cliValue(argv, "outcomeCeiling") ?? DEFAULT_OUTCOME_CEILING,
    "outcomeCeiling",
  );
  if (startDate > decisionEndDate) {
    throw new Error("start must be on or before end");
  }
  if (decisionEndDate > outcomeCeiling) {
    throw new Error("end must be on or before outcomeCeiling");
  }
  return {
    startDate,
    decisionEndDate,
    outcomeCeiling,
    businesses: (cliValue(argv, "businesses") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    producerCutoffUtc: assertProducerCutoffUtc(
      cliValue(argv, "producerCutoffUtc") ??
        DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC,
    ),
  };
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeOrZero(value: unknown) {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(later: string, earlier: string) {
  return Math.round(
    (Date.parse(`${later}T00:00:00.000Z`) -
      Date.parse(`${earlier}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function dateRange(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function quantile(values: readonly number[], q: number) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const fraction = index - lower;
  return (
    (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
  );
}

function aggregateFacts(rows: readonly H1CountryMetaFact[]): AggregateMetrics {
  let spend = 0;
  let impressions = 0;
  let conversions = 0;
  let revenue = 0;
  let lastSpendDate: string | null = null;
  const sourceIds = new Set<string>();
  for (const row of rows) {
    spend += row.spend;
    impressions += row.impressions;
    conversions += row.conversions;
    revenue += row.revenue;
    if (row.spend > 0 && (lastSpendDate === null || row.date > lastSpendDate)) {
      lastSpendDate = row.date;
    }
    if (row.sourceId) sourceIds.add(row.sourceId);
  }
  return {
    spend,
    impressions,
    conversions,
    revenue,
    roas: ratio(revenue, spend),
    cpa: conversions > 0 ? spend / conversions : null,
    lastSpendDate,
    sourceIds: Array.from(sourceIds).sort(),
  };
}

function entityKey(
  fact: Pick<H1CountryMetaFact, "businessId" | "providerAccountId" | "adId">,
) {
  return [fact.businessId, fact.providerAccountId, fact.adId].join("::");
}

function accountDateKey(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
}) {
  return [input.businessId, input.providerAccountId, input.date].join("::");
}

function currentScopeRows(input: {
  rows: readonly H1CountryMetaFact[];
  latest: H1CountryMetaFact;
  startDate: string;
  endDate: string;
}) {
  return input.rows.filter(
    (row) =>
      row.date >= input.startDate &&
      row.date <= input.endDate &&
      row.currency === input.latest.currency &&
      row.goal === input.latest.goal,
  );
}

function lastRowAtOrBefore(rows: readonly H1CountryMetaFact[], date: string) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if ((rows[midpoint]?.date ?? "") <= date) low = midpoint + 1;
    else high = midpoint;
  }
  return low > 0 ? (rows[low - 1] ?? null) : null;
}

function rowsBetweenDates(
  rows: readonly H1CountryMetaFact[],
  startDate: string,
  endDate: string,
) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if ((rows[midpoint]?.date ?? "") < startDate) low = midpoint + 1;
    else high = midpoint;
  }
  const selected: H1CountryMetaFact[] = [];
  for (let index = low; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.date > endDate) break;
    selected.push(row);
  }
  return selected;
}

function targetState(
  target: H1CountryTargetPack | null,
  asOfDate: string,
  producerCutoffUtc = DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC,
) {
  if (!target?.updatedAt) return { observed: false, fresh: false };
  const cutoff = h1CountryProducerCutoff(asOfDate, producerCutoffUtc);
  const observed = target.updatedAt <= cutoff;
  return {
    observed,
    fresh:
      observed &&
      diffDays(asOfDate, target.updatedAt.slice(0, 10)) <=
        TARGET_FRESHNESS_DAYS,
  };
}

function normalizeMetaFacts(rows: readonly DbRow[]): H1CountryMetaFact[] {
  return rows.flatMap((row) => {
    const date = normalizePostgresDate(row.date);
    const businessId = optionalText(row.business_id);
    const legacyBusinessId = optionalText(row.legacy_business_id);
    const providerAccountId = optionalText(row.provider_account_id);
    const adId = optionalText(row.ad_id);
    if (
      date === null ||
      businessId === null ||
      legacyBusinessId === null ||
      providerAccountId === null ||
      adId === null
    ) {
      return [];
    }
    return [
      {
        businessId,
        legacyBusinessId,
        businessName: optionalText(row.business_name) ?? businessId,
        providerAccountId,
        date,
        campaignId: optionalText(row.campaign_id),
        adsetId: optionalText(row.adset_id),
        adId,
        currency: optionalText(row.account_currency),
        objective: optionalText(row.objective),
        goal: optionalText(row.optimization_goal),
        customEventType: optionalText(row.custom_event_type),
        spend: nonNegativeOrZero(row.spend),
        impressions: nonNegativeOrZero(row.impressions),
        conversions: nonNegativeOrZero(row.conversions),
        revenue: nonNegativeOrZero(row.revenue),
        sourceId: optionalText(row.source_snapshot_id),
        updatedAt: isoTimestamp(row.updated_at),
      },
    ];
  });
}

function normalizeTargets(rows: readonly DbRow[]): H1CountryTargetPack[] {
  return rows.flatMap((row) => {
    const businessId = optionalText(row.business_id);
    if (!businessId) return [];
    const risk = optionalText(row.default_risk_posture);
    return [
      {
        id: optionalText(row.id),
        businessId,
        targetCpa: numberOrNull(row.target_cpa),
        targetRoas: numberOrNull(row.target_roas),
        breakEvenRoas: numberOrNull(row.break_even_roas),
        operatorAovAssumption: numberOrNull(row.aov_assumption),
        riskPosture:
          risk === "aggressive" || risk === "conservative" ? risk : "balanced",
        updatedAt: isoTimestamp(row.updated_at),
      },
    ];
  });
}

function normalizeCompleteness(
  rows: readonly DbRow[],
): H1CountryAccountCompleteness[] {
  return rows.flatMap((row) => {
    const businessId = optionalText(row.business_id);
    const providerAccountId = optionalText(row.provider_account_id);
    const date = normalizePostgresDate(row.date);
    if (!businessId || !providerAccountId || !date) return [];
    return [
      {
        businessId,
        providerAccountId,
        date,
        complete: row.complete === true,
        sourceIds: Array.isArray(row.source_ids)
          ? row.source_ids.map(String).sort()
          : [],
      },
    ];
  });
}

function rawPageScopeKey(page: RawCountrySnapshotPage) {
  return [page.businessId, page.providerAccountId, page.sourceDate].join("::");
}

function rawAccountScopeKey(input: {
  businessId: string;
  providerAccountId: string;
}) {
  return [input.businessId, input.providerAccountId].join("::");
}

function selectedGenerationKey(input: { snapshotIds: readonly string[] }) {
  return input.snapshotIds.join("::");
}

function selectFixedCohortCandidates(input: {
  facts: readonly H1CountryMetaFact[];
  startDate: string;
  decisionEndDate: string;
}) {
  const candidates = [...input.facts]
    .filter(
      (fact) =>
        fact.date >= input.startDate &&
        fact.date <= input.decisionEndDate &&
        (fact.spend > 0 || fact.impressions > 0),
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.adId.localeCompare(right.adId),
    );
  const lastSelected = new Map<string, string>();
  return candidates.filter((current) => {
    const entityId = entityKey(current);
    const previousDate = lastSelected.get(entityId);
    if (
      previousDate !== undefined &&
      diffDays(current.date, previousDate) < DECISION_COOLDOWN_DAYS
    ) {
      return false;
    }
    lastSelected.set(entityId, current.date);
    return true;
  });
}

function fixedDecisionDatesByAccount(input: {
  facts: readonly H1CountryMetaFact[];
  startDate: string;
  decisionEndDate: string;
}) {
  const dates = new Map<string, Set<string>>();
  for (const candidate of selectFixedCohortCandidates(input)) {
    const key = rawAccountScopeKey(candidate);
    const accountDates = dates.get(key) ?? new Set<string>();
    accountDates.add(candidate.date);
    dates.set(key, accountDates);
  }
  return new Map(
    [...dates]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()] as const),
  );
}

interface PlannedCountryGeneration {
  key: string;
  metadata: ReturnType<
    typeof selectLatestCompleteCountryGenerationAtCutoff<RawCountrySnapshotPage>
  >;
  selectionCount: number;
}

interface CutoffCountryGenerationPlan {
  pagesByScope: Map<string, RawCountrySnapshotPage[]>;
  selectedGenerations: Map<string, PlannedCountryGeneration>;
  plannedCutoffSourceScopes: number;
  rejectedSelectionCount: number;
  rejectedScopes: Array<{ scope: string; reason: string }>;
  metadataSelectionPlanHash: string;
}

function addRejectedScopeExample(
  examples: Array<{ scope: string; reason: string }>,
  value: { scope: string; reason: string },
) {
  if (examples.length < MAX_REJECTED_SCOPE_EXAMPLES) examples.push(value);
}

function planCutoffCountryGenerations(input: {
  metadataPages: readonly RawCountrySnapshotPage[];
  decisionDatesByAccount: ReadonlyMap<string, readonly string[]>;
  producerCutoffUtc: string;
}): CutoffCountryGenerationPlan {
  const pagesByScope = new Map<string, RawCountrySnapshotPage[]>();
  for (const page of input.metadataPages) {
    const key = rawPageScopeKey(page);
    const pages = pagesByScope.get(key) ?? [];
    pages.push(page);
    pagesByScope.set(key, pages);
  }
  for (const pages of pagesByScope.values()) {
    pages.sort(
      (left, right) =>
        (left.fetchedAt ?? "").localeCompare(right.fetchedAt ?? "") ||
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  }

  const selectedGenerations = new Map<string, PlannedCountryGeneration>();
  const rejectedScopes: Array<{ scope: string; reason: string }> = [];
  const selectionHasher = createHash("sha256");
  let plannedCutoffSourceScopes = 0;
  let rejectedSelectionCount = 0;

  for (const [scope, pages] of [...pagesByScope].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = pages[0];
    if (!first) continue;
    const decisionDates = [
      ...new Set(
        input.decisionDatesByAccount.get(rawAccountScopeKey(first)) ?? [],
      ),
    ].sort();
    const lastEligibleDecisionDate = addDays(first.sourceDate, 27);
    for (const decisionDate of decisionDates) {
      if (
        decisionDate < first.sourceDate ||
        decisionDate > lastEligibleDecisionDate
      ) {
        continue;
      }
      plannedCutoffSourceScopes += 1;
      const cutoff = h1CountryProducerCutoff(
        decisionDate,
        input.producerCutoffUtc,
      );
      try {
        const selected = selectLatestCompleteCountryGenerationAtCutoff(
          pages,
          cutoff,
        );
        const key = selectedGenerationKey(selected);
        const previous = selectedGenerations.get(key);
        if (previous) previous.selectionCount += 1;
        else {
          selectedGenerations.set(key, {
            key,
            metadata: selected,
            selectionCount: 1,
          });
        }
        selectionHasher.update(`selected\0${scope}\0${decisionDate}\0${key}\n`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        rejectedSelectionCount += 1;
        addRejectedScopeExample(rejectedScopes, {
          scope: `${scope}@${decisionDate}`,
          reason,
        });
        selectionHasher.update(
          `rejected\0${scope}\0${decisionDate}\0${reason}\n`,
        );
      }
    }
  }

  return {
    pagesByScope,
    selectedGenerations: new Map(
      [...selectedGenerations].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    plannedCutoffSourceScopes,
    rejectedSelectionCount,
    rejectedScopes,
    metadataSelectionPlanHash: selectionHasher.digest("hex"),
  };
}

function metaAdDayKey(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  adId: string;
}) {
  return [
    input.businessId,
    input.providerAccountId,
    input.date,
    input.adId,
  ].join("::");
}

interface CutoffStrictCountryReplay {
  countryRows: NormalizedCountryAdDayRow[];
  reconciliationBundles: Array<{
    generationKey: string;
    sourceHash: string;
    reconciliations: CountryAdDayReconciliation[];
  }>;
  resolveCountryMix: H1CountryMixResolver;
  coverage: {
    plannedCutoffSourceScopes: number;
    selectedGenerations: number;
    selectedCountryRows: number;
    incompleteOrInvalidLatestGenerations: number;
    invalidUniqueGenerations: number;
    generationSourceHashes: string[];
    rejectedScopes: Array<{ scope: string; reason: string }>;
    reconciliationStatusCounts: Record<string, number>;
    selectionPlanHash: string;
  };
}

function hydrateCutoffStrictCountryReplay(input: {
  plan: CutoffCountryGenerationPlan;
  payloadBySnapshotId: ReadonlyMap<string, unknown>;
  metaRows: readonly MetaAdDaySpendFact[];
  producerCutoffUtc: string;
}): CutoffStrictCountryReplay {
  const metaRowsBySourceScope = new Map<string, MetaAdDaySpendFact[]>();
  const metaByAdDay = new Map<string, MetaAdDaySpendFact>();
  for (const row of input.metaRows) {
    const sourceScope = [row.businessId, row.providerAccountId, row.date].join(
      "::",
    );
    const sourceRows = metaRowsBySourceScope.get(sourceScope) ?? [];
    sourceRows.push(row);
    metaRowsBySourceScope.set(sourceScope, sourceRows);
    const key = metaAdDayKey(row);
    if (metaByAdDay.has(key)) {
      throw new Error(`duplicate Meta ad-day key in cutoff replay: ${key}`);
    }
    metaByAdDay.set(key, row);
  }

  const countryRows: NormalizedCountryAdDayRow[] = [];
  const reconciliationBundles: CutoffStrictCountryReplay["reconciliationBundles"] =
    [];
  const reconciliationsByGeneration = new Map<
    string,
    Map<string, CountryAdDayReconciliation>
  >();
  const invalidGenerations = new Map<string, string>();
  const generationSourceHashes = new Set<string>();
  let rejectedSelectionCount = input.plan.rejectedSelectionCount;
  const rejectedScopes = [...input.plan.rejectedScopes];

  for (const planned of input.plan.selectedGenerations.values()) {
    try {
      const hydratedPages = planned.metadata.pages.map((page) => {
        if (!input.payloadBySnapshotId.has(page.id)) {
          throw new Error(`selected country payload missing: ${page.id}`);
        }
        return { ...page, payload: input.payloadBySnapshotId.get(page.id) };
      });
      const selected = selectLatestCompleteCountryGeneration(hydratedPages);
      const normalizedRows = normalizeCountryGenerationRows(selected);
      const sourceScope = [
        selected.businessId,
        selected.providerAccountId,
        selected.sourceDate,
      ].join("::");
      const reconciliations = reconcileCountryAdDaySpend({
        countryRows: normalizedRows,
        metaRows: metaRowsBySourceScope.get(sourceScope) ?? [],
      });
      const byAdDay = new Map<string, CountryAdDayReconciliation>();
      for (const reconciliation of reconciliations) {
        byAdDay.set(reconciliation.key, reconciliation);
      }
      reconciliationsByGeneration.set(planned.key, byAdDay);
      countryRows.push(...normalizedRows);
      generationSourceHashes.add(selected.sourceHash);
      reconciliationBundles.push({
        generationKey: planned.key,
        sourceHash: selected.sourceHash,
        reconciliations,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      invalidGenerations.set(planned.key, reason);
      rejectedSelectionCount += planned.selectionCount;
      addRejectedScopeExample(rejectedScopes, {
        scope: `generation:${planned.key}`,
        reason,
      });
    }
  }

  reconciliationBundles.sort((left, right) =>
    left.generationKey.localeCompare(right.generationKey),
  );
  const reconciliationStatusCounts = reconciliationBundles
    .flatMap((bundle) => bundle.reconciliations)
    .reduce<Record<string, number>>((counts, row) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      return counts;
    }, {});
  const missingCountryByMetaKey = new Map<string, CountryAdDayReconciliation>();
  const missingCountry = (meta: MetaAdDaySpendFact) => {
    const key = metaAdDayKey(meta);
    const cached = missingCountryByMetaKey.get(key);
    if (cached) return cached;
    const reconciliation = reconcileCountryAdDaySpend({
      countryRows: [],
      metaRows: [meta],
    })[0];
    if (!reconciliation) {
      throw new Error(`missing reconciliation could not be built: ${key}`);
    }
    missingCountryByMetaKey.set(key, reconciliation);
    return reconciliation;
  };
  const cutoffSelectionCache = new Map<string, string | null>();
  const generationAtCutoff = (scope: string, asOfDate: string) => {
    const cacheKey = `${scope}@${asOfDate}`;
    if (cutoffSelectionCache.has(cacheKey)) {
      return cutoffSelectionCache.get(cacheKey) ?? null;
    }
    const pages = input.plan.pagesByScope.get(scope) ?? [];
    let generationKey: string | null = null;
    try {
      const selected = selectLatestCompleteCountryGenerationAtCutoff(
        pages,
        h1CountryProducerCutoff(asOfDate, input.producerCutoffUtc),
      );
      const candidateKey = selectedGenerationKey(selected);
      generationKey = reconciliationsByGeneration.has(candidateKey)
        ? candidateKey
        : null;
    } catch {
      generationKey = null;
    }
    cutoffSelectionCache.set(cacheKey, generationKey);
    return generationKey;
  };
  const resolveCountryMix: H1CountryMixResolver = (scope) => {
    const reconciliations: CountryAdDayReconciliation[] = [];
    for (
      let sourceDate = addDays(scope.asOfDate, -27);
      sourceDate <= scope.asOfDate;
      sourceDate = addDays(sourceDate, 1)
    ) {
      const adDayKey = metaAdDayKey({ ...scope, date: sourceDate });
      const meta = metaByAdDay.get(adDayKey);
      if (!meta) continue;
      const rawScope = [
        scope.businessId,
        scope.providerAccountId,
        sourceDate,
      ].join("::");
      const generationKey = generationAtCutoff(rawScope, scope.asOfDate);
      const selected = generationKey
        ? reconciliationsByGeneration.get(generationKey)?.get(adDayKey)
        : null;
      reconciliations.push(selected ?? missingCountry(meta));
    }
    return buildAdCountrySpendMix({ ...scope, reconciliations });
  };
  const invalidGenerationReceipts = [...invalidGenerations]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, reason]) => ({ key, reason }));

  return {
    countryRows,
    reconciliationBundles,
    resolveCountryMix,
    coverage: {
      plannedCutoffSourceScopes: input.plan.plannedCutoffSourceScopes,
      selectedGenerations: reconciliationBundles.length,
      selectedCountryRows: countryRows.length,
      incompleteOrInvalidLatestGenerations: rejectedSelectionCount,
      invalidUniqueGenerations: invalidGenerations.size,
      generationSourceHashes: [...generationSourceHashes].sort(),
      rejectedScopes,
      reconciliationStatusCounts,
      selectionPlanHash: countryParentStableHash({
        metadataSelectionPlanHash: input.plan.metadataSelectionPlanHash,
        invalidGenerationReceipts,
      }),
    },
  };
}

export function buildCutoffStrictH1CountryReplay(input: {
  pages: readonly RawCountrySnapshotPage[];
  metaRows: readonly MetaAdDaySpendFact[];
  decisionDatesByAccount: ReadonlyMap<string, readonly string[]>;
  producerCutoffUtc?: string;
}): CutoffStrictCountryReplay {
  const producerCutoffUtc = assertProducerCutoffUtc(
    input.producerCutoffUtc ?? DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC,
  );
  const plan = planCutoffCountryGenerations({
    metadataPages: input.pages.map((page) => ({ ...page, payload: [] })),
    decisionDatesByAccount: input.decisionDatesByAccount,
    producerCutoffUtc,
  });
  return hydrateCutoffStrictCountryReplay({
    plan,
    payloadBySnapshotId: new Map(
      input.pages.map((page) => [page.id, page.payload] as const),
    ),
    metaRows: input.metaRows,
    producerCutoffUtc,
  });
}

async function loadH1CountrySources(
  args: ParsedH1CountryArgs,
): Promise<LoadedH1CountrySources> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "adsecute-h1-country-parent-readonly",
  });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    const readOnly = await client.query<{ transaction_read_only: string }>(
      "SHOW transaction_read_only",
    );
    if (readOnly.rows[0]?.transaction_read_only !== "on") {
      throw new Error("transaction_read_only is not on; refusing to query");
    }
    const historyStart = addDays(args.startDate, -89);
    const businessFilter = args.businesses.length > 0 ? args.businesses : null;
    const factsResult = await client.query<DbRow>(
      `
        SELECT
          b.id::text AS business_id,
          b.name AS business_name,
          d.business_id AS legacy_business_id,
          d.provider_account_id,
          d.date,
          d.campaign_id,
          d.adset_id,
          d.ad_id,
          d.account_currency,
          campaign.objective,
          adset.optimization_goal,
          adset.custom_event_type,
          d.spend,
          d.impressions,
          d.conversions,
          d.revenue,
          d.source_snapshot_id::text AS source_snapshot_id,
          d.updated_at
        FROM meta_ad_daily d
        JOIN businesses b ON b.id = d.business_ref_id
        LEFT JOIN LATERAL (
          SELECT a.optimization_goal, a.custom_event_type
          FROM meta_adset_daily a
          WHERE a.business_ref_id = d.business_ref_id
            AND a.provider_account_id = d.provider_account_id
            AND a.adset_id = d.adset_id
            AND a.date = d.date
          ORDER BY a.updated_at DESC, a.id DESC
          LIMIT 1
        ) adset ON TRUE
        LEFT JOIN LATERAL (
          SELECT c.objective
          FROM meta_campaign_daily c
          WHERE c.business_ref_id = d.business_ref_id
            AND c.provider_account_id = d.provider_account_id
            AND c.campaign_id = d.campaign_id
            AND c.date = d.date
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT 1
        ) campaign ON TRUE
        WHERE d.date BETWEEN $1::date AND $2::date
          AND d.truth_state = 'finalized'
          AND d.validation_status = 'passed'
          AND COALESCE(b.is_demo_business, FALSE) = FALSE
          AND (
            $3::text[] IS NULL OR
            b.id::text = ANY($3::text[]) OR
            b.name = ANY($3::text[])
          )
        ORDER BY b.id, d.provider_account_id, d.ad_id, d.date
      `,
      [historyStart, args.outcomeCeiling, businessFilter],
    );
    const facts = normalizeMetaFacts(factsResult.rows);
    if (facts.length === 0)
      throw new Error("no normalized Meta ad facts matched");
    const businessIds = Array.from(
      new Set(facts.map((fact) => fact.businessId)),
    ).sort();

    const targetResult = await client.query<DbRow>(
      `
        SELECT
          id::text,
          business_id::text AS business_id,
          target_cpa,
          target_roas,
          break_even_roas,
          aov_assumption,
          default_risk_posture,
          updated_at
        FROM business_target_packs
        WHERE business_id = ANY($1::uuid[])
        ORDER BY business_id, updated_at DESC, id DESC
      `,
      [businessIds],
    );
    const targets = normalizeTargets(targetResult.rows);

    const completenessResult = await client.query<DbRow>(
      `
        SELECT
          business_ref_id::text AS business_id,
          provider_account_id,
          date,
          BOOL_AND(
            truth_state = 'finalized' AND validation_status = 'passed'
          ) AS complete,
          ARRAY_AGG(id::text ORDER BY id::text) AS source_ids
        FROM meta_account_daily
        WHERE business_ref_id = ANY($1::uuid[])
          AND date BETWEEN $2::date AND $3::date
        GROUP BY business_ref_id, provider_account_id, date
        ORDER BY business_ref_id, provider_account_id, date
      `,
      [businessIds, historyStart, args.outcomeCeiling],
    );
    const completeness = normalizeCompleteness(completenessResult.rows);

    const rawMetadataResult = await client.query<DbRow>(
      `
        SELECT
          id::text,
          business_id,
          provider_account_id,
          partition_id::text,
          run_id,
          page_index,
          provider_cursor,
          provider_http_status,
          status,
          start_date,
          end_date,
          fetched_at,
          created_at
        FROM meta_raw_snapshots
        WHERE endpoint_name = 'breakdown_country'
          AND start_date = end_date
          AND start_date BETWEEN $1::date AND $2::date
        ORDER BY business_id, provider_account_id, start_date, fetched_at, created_at, id
      `,
      [historyStart, args.decisionEndDate],
    );

    const canonicalByRawScope = new Map<string, string>();
    for (const fact of facts) {
      for (const rawBusinessId of [fact.businessId, fact.legacyBusinessId]) {
        const key = `${rawBusinessId}::${fact.providerAccountId}`;
        const previous = canonicalByRawScope.get(key);
        if (previous && previous !== fact.businessId) {
          throw new Error(`ambiguous raw business mapping: ${key}`);
        }
        canonicalByRawScope.set(key, fact.businessId);
      }
    }
    const rawMetadataPages: RawCountrySnapshotPage[] =
      rawMetadataResult.rows.flatMap((row) => {
        const rawBusinessId = optionalText(row.business_id);
        const providerAccountId = optionalText(row.provider_account_id);
        const sourceDate = normalizePostgresDate(row.start_date);
        if (!rawBusinessId || !providerAccountId || !sourceDate) return [];
        const canonicalBusinessId = canonicalByRawScope.get(
          `${rawBusinessId}::${providerAccountId}`,
        );
        if (!canonicalBusinessId) return [];
        return [
          {
            id: optionalText(row.id) ?? "",
            businessId: canonicalBusinessId,
            providerAccountId,
            sourceDate,
            partitionId: optionalText(row.partition_id),
            runId: optionalText(row.run_id),
            pageIndex: numberOrNull(row.page_index),
            providerCursor: optionalText(row.provider_cursor),
            providerHttpStatus: numberOrNull(row.provider_http_status),
            status: optionalText(row.status) ?? "",
            fetchedAt: isoTimestamp(row.fetched_at),
            createdAt: isoTimestamp(row.created_at),
            payload: [],
          },
        ];
      });
    const unmappedRawScopes =
      rawMetadataResult.rows.length - rawMetadataPages.length;
    const metaSpendFacts: MetaAdDaySpendFact[] = facts.map((fact) => ({
      businessId: fact.businessId,
      providerAccountId: fact.providerAccountId,
      date: fact.date,
      adId: fact.adId,
      campaignId: fact.campaignId,
      adsetId: fact.adsetId,
      currency: fact.currency,
      goal: fact.goal,
      spend: fact.spend,
      sourceId: fact.sourceId,
    }));
    const decisionDatesByAccount = fixedDecisionDatesByAccount({
      facts,
      startDate: args.startDate,
      decisionEndDate: args.decisionEndDate,
    });
    const countryPlan = planCutoffCountryGenerations({
      metadataPages: rawMetadataPages,
      decisionDatesByAccount,
      producerCutoffUtc: args.producerCutoffUtc,
    });
    const selectedSnapshotIds = Array.from(
      new Set(
        Array.from(countryPlan.selectedGenerations.values()).flatMap(
          (generation) => generation.metadata.snapshotIds,
        ),
      ),
    ).sort();
    const payloadResult =
      selectedSnapshotIds.length > 0
        ? await client.query<DbRow>(
            `
              SELECT id::text, payload_json
              FROM meta_raw_snapshots
              WHERE id = ANY($1::uuid[])
              ORDER BY id
            `,
            [selectedSnapshotIds],
          )
        : { rows: [] as DbRow[] };
    await client.query("ROLLBACK");
    const payloadBySnapshotId = new Map(
      payloadResult.rows.map((row) => [String(row.id), row.payload_json]),
    );
    if (payloadBySnapshotId.size !== selectedSnapshotIds.length) {
      throw new Error(
        `selected country payload mismatch: expected ${selectedSnapshotIds.length}, received ${payloadBySnapshotId.size}`,
      );
    }
    const countryReplay = hydrateCutoffStrictCountryReplay({
      plan: countryPlan,
      payloadBySnapshotId,
      metaRows: metaSpendFacts,
      producerCutoffUtc: args.producerCutoffUtc,
    });
    const rawCoverage = {
      retainedPageRows: rawMetadataResult.rows.length,
      unmappedRawScopes,
      ...countryReplay.coverage,
    };
    const sourceHash = countryParentStableHash({
      sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
      producerCutoffUtc: args.producerCutoffUtc,
      facts,
      targets,
      completeness,
      rawCoverage,
      countryRows: countryReplay.countryRows,
      reconciliationBundles: countryReplay.reconciliationBundles,
    });
    return {
      facts,
      targets,
      completeness,
      countryRows: countryReplay.countryRows,
      resolveCountryMix: countryReplay.resolveCountryMix,
      rawCoverage,
      sourceHash,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function buildVariantIndependentH1CountryCohort(input: {
  facts: readonly H1CountryMetaFact[];
  targets: readonly H1CountryTargetPack[];
  completeness: readonly H1CountryAccountCompleteness[];
  reconciliations?: readonly CountryAdDayReconciliation[];
  resolveCountryMix?: H1CountryMixResolver;
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  producerCutoffUtc?: string;
}): FixedH1CountryCohort {
  const startDate = assertDate(input.startDate, "startDate");
  const decisionEndDate = assertDate(input.decisionEndDate, "decisionEndDate");
  const outcomeCeiling = assertDate(input.outcomeCeiling, "outcomeCeiling");
  if (startDate > decisionEndDate || decisionEndDate > outcomeCeiling) {
    throw new Error("invalid fixed-cohort date order");
  }
  if (
    (input.resolveCountryMix === undefined) ===
    (input.reconciliations === undefined)
  ) {
    throw new Error(
      "provide exactly one country mix source: resolveCountryMix or reconciliations",
    );
  }
  const producerCutoffUtc = assertProducerCutoffUtc(
    input.producerCutoffUtc ?? DEFAULT_H1_COUNTRY_PRODUCER_CUTOFF_UTC,
  );
  const facts = [...input.facts].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountId.localeCompare(right.providerAccountId) ||
      left.adId.localeCompare(right.adId),
  );
  const factKeys = new Set<string>();
  for (const fact of facts) {
    const key = [
      fact.businessId,
      fact.providerAccountId,
      fact.adId,
      fact.date,
    ].join("::");
    if (factKeys.has(key)) throw new Error(`duplicate Meta ad-day key: ${key}`);
    factKeys.add(key);
  }

  const byEntity = new Map<string, H1CountryMetaFact[]>();
  for (const fact of facts) {
    const key = entityKey(fact);
    const rows = byEntity.get(key) ?? [];
    rows.push(fact);
    byEntity.set(key, rows);
  }
  for (const rows of byEntity.values()) {
    rows.sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        (left.sourceId ?? "").localeCompare(right.sourceId ?? ""),
    );
  }
  const entitiesByAccount = new Map<
    string,
    Array<{ key: string; rows: H1CountryMetaFact[] }>
  >();
  for (const [key, rows] of byEntity) {
    const first = rows[0];
    if (!first) continue;
    const accountKey = [first.businessId, first.providerAccountId].join("::");
    const entities = entitiesByAccount.get(accountKey) ?? [];
    entities.push({ key, rows });
    entitiesByAccount.set(accountKey, entities);
  }
  for (const entities of entitiesByAccount.values()) {
    entities.sort((left, right) => left.key.localeCompare(right.key));
  }
  const targetsByBusiness = new Map<string, H1CountryTargetPack>();
  for (const target of [...input.targets].sort(
    (left, right) =>
      left.businessId.localeCompare(right.businessId) ||
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      (right.id ?? "").localeCompare(left.id ?? ""),
  )) {
    if (!targetsByBusiness.has(target.businessId)) {
      targetsByBusiness.set(target.businessId, target);
    }
  }
  const completenessByKey = new Map(
    input.completeness.map((row) => [accountDateKey(row), row] as const),
  );
  if (completenessByKey.size !== input.completeness.length) {
    throw new Error("duplicate account completeness key");
  }

  const reconciliationsByEntity = new Map<
    string,
    CountryAdDayReconciliation[]
  >();
  for (const reconciliation of input.reconciliations ?? []) {
    const key = [
      reconciliation.businessId,
      reconciliation.providerAccountId,
      reconciliation.adId,
    ].join("::");
    const rows = reconciliationsByEntity.get(key) ?? [];
    rows.push(reconciliation);
    reconciliationsByEntity.set(key, rows);
  }
  for (const rows of reconciliationsByEntity.values()) {
    rows.sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.key.localeCompare(right.key),
    );
  }
  const mixCache = new Map<string, AdCountrySpendMix>();
  const countryMix = (inputScope: {
    businessId: string;
    providerAccountId: string;
    currency: string | null;
    goal: string | null;
    adId: string;
    asOfDate: string;
  }) => {
    const key = [
      inputScope.businessId,
      inputScope.providerAccountId,
      inputScope.currency ?? "null",
      inputScope.goal ?? "null",
      inputScope.adId,
      inputScope.asOfDate,
    ].join("::");
    const cached = mixCache.get(key);
    if (cached) return cached;
    const mix = input.resolveCountryMix
      ? input.resolveCountryMix(inputScope)
      : buildAdCountrySpendMix({
          ...inputScope,
          reconciliations:
            reconciliationsByEntity.get(
              [
                inputScope.businessId,
                inputScope.providerAccountId,
                inputScope.adId,
              ].join("::"),
            ) ?? [],
        });
    mixCache.set(key, mix);
    return mix;
  };

  const environmentCache = new Map<
    string,
    FixedCountryCalibrationEnvironment
  >();
  const calibrationEnvironment = (scope: {
    businessId: string;
    providerAccountId: string;
    currency: string | null;
    asOfDate: string;
  }) => {
    const id = [
      scope.businessId,
      scope.providerAccountId,
      scope.currency ?? "null",
      scope.asOfDate,
    ].join("::");
    const cached = environmentCache.get(id);
    if (cached) return cached;
    const target = targetsByBusiness.get(scope.businessId) ?? null;
    const targetAtCutoff = targetState(
      target,
      scope.asOfDate,
      producerCutoffUtc,
    ).observed;
    const observations: CountryCalibrationObservation[] = [];
    const cpas: number[] = [];
    let totalPurchases = 0;
    let totalRevenue = 0;
    const scopedEntities =
      entitiesByAccount.get(
        [scope.businessId, scope.providerAccountId].join("::"),
      ) ?? [];
    for (const { key, rows: entityRows } of scopedEntities) {
      const latest = lastRowAtOrBefore(entityRows, scope.asOfDate);
      if (!latest || latest.currency !== scope.currency) continue;
      const trailing90 = aggregateFacts(
        rowsBetweenDates(
          entityRows,
          addDays(scope.asOfDate, -89),
          scope.asOfDate,
        ).filter(
          (row) => row.currency === latest.currency && row.goal === latest.goal,
        ),
      );
      if (trailing90.spend <= 0) continue;
      if (trailing90.cpa !== null) cpas.push(trailing90.cpa);
      totalPurchases += trailing90.conversions;
      totalRevenue += trailing90.revenue;
      observations.push({
        id: key,
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
        currency: scope.currency,
        goal: latest.goal,
        adId: latest.adId,
        value:
          targetAtCutoff &&
          (target?.targetRoas ?? 0) > 0 &&
          (trailing90.roas ?? 0) > 0
            ? trailing90.roas! / target!.targetRoas!
            : null,
        ageDays:
          trailing90.lastSpendDate === null
            ? null
            : Math.max(0, diffDays(scope.asOfDate, trailing90.lastSpendDate)),
        countryMix: countryMix({
          businessId: scope.businessId,
          providerAccountId: scope.providerAccountId,
          currency: scope.currency,
          goal: latest.goal,
          adId: latest.adId,
          asOfDate: scope.asOfDate,
        }),
      });
    }
    observations.sort((left, right) => left.id.localeCompare(right.id));
    const body = {
      id,
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      currency: scope.currency,
      asOfDate: scope.asOfDate,
      observations,
      accountCpaP50: quantile(cpas, 0.5),
      accountCpaSampleCount: cpas.length,
      totalPurchases,
      totalRevenue,
    };
    const environment = {
      ...body,
      environmentHash: countryParentStableHash(body),
    };
    environmentCache.set(id, environment);
    return environment;
  };

  const candidates = selectFixedCohortCandidates({
    facts,
    startDate,
    decisionEndDate,
  });
  const rows: FixedH1CountryCohortRow[] = [];
  for (const current of candidates) {
    const entityId = entityKey(current);
    const entityRows = byEntity.get(entityId) ?? [];
    const window28 = aggregateFacts(
      currentScopeRows({
        rows: entityRows,
        latest: current,
        startDate: addDays(current.date, -27),
        endDate: current.date,
      }),
    );
    const window7 = aggregateFacts(
      currentScopeRows({
        rows: entityRows,
        latest: current,
        startDate: addDays(current.date, -6),
        endDate: current.date,
      }),
    );
    const target = targetsByBusiness.get(current.businessId) ?? null;
    const targetReceipt = targetState(target, current.date, producerCutoffUtc);
    const targetRoas = targetReceipt.observed
      ? (target?.targetRoas ?? null)
      : null;
    const breakEvenRoas = targetReceipt.observed
      ? (target?.breakEvenRoas ?? null)
      : null;
    const environment = calibrationEnvironment({
      businessId: current.businessId,
      providerAccountId: current.providerAccountId,
      currency: current.currency,
      asOfDate: current.date,
    });
    const spendResolution = resolveSpendUnit({
      targetCpa: targetReceipt.observed ? (target?.targetCpa ?? null) : null,
      operatorAovAssumption: targetReceipt.observed
        ? (target?.operatorAovAssumption ?? null)
        : null,
      metaAttributedAovMean90d:
        environment.totalPurchases > 0
          ? environment.totalRevenue / environment.totalPurchases
          : null,
      metaAttributedAovPurchaseCount90d: Math.round(environment.totalPurchases),
      metaAttributedRevenue90d: environment.totalRevenue,
      targetRoas,
      breakEvenRoas,
      accountCpaP50: environment.accountCpaP50,
      accountCpaSampleCount: environment.accountCpaSampleCount,
      attributionAovAdjustmentMultiplier: 1,
    });
    const multipliers =
      ENGINE_PRESET_MULTIPLIERS[target?.riskPosture ?? "balanced"];
    const commercialMaturitySpend =
      spendResolution.spendUnit !== null
        ? spendResolution.spendUnit * multipliers.lossBudget
        : null;
    const recentSampleMinSpend =
      spendResolution.spendUnit !== null
        ? spendResolution.spendUnit * multipliers.recentSample
        : null;
    const recoveryHold =
      recentSampleMinSpend !== null &&
      targetRoas !== null &&
      window7.spend >= recentSampleMinSpend &&
      (window7.roas ?? Number.NEGATIVE_INFINITY) > targetRoas;
    const fixedCountryMix = countryMix({
      businessId: current.businessId,
      providerAccountId: current.providerAccountId,
      currency: current.currency,
      goal: current.goal,
      adId: current.adId,
      asOfDate: current.date,
    });
    const mature =
      commercialMaturitySpend !== null &&
      window28.spend >= commercialMaturitySpend;
    const buildOutcome = (
      windowDays: H1CountryOutcomeWindowDays,
    ): FixedH1CountryOutcome => {
      const dueDate = addDays(current.date, windowDays);
      const completenessReceipts = dateRange(
        addDays(current.date, 1),
        dueDate,
      ).map((date) =>
        completenessByKey.get(
          accountDateKey({
            businessId: current.businessId,
            providerAccountId: current.providerAccountId,
            date,
          }),
        ),
      );
      const complete =
        dueDate <= outcomeCeiling &&
        completenessReceipts.every((receipt) => receipt?.complete === true);
      const forward = aggregateFacts(
        currentScopeRows({
          rows: entityRows,
          latest: current,
          startDate: addDays(current.date, 1),
          endDate: dueDate,
        }),
      );
      const status: H1CountryOutcomeStatus =
        !complete || targetRoas === null || breakEvenRoas === null
          ? "unknown"
          : forward.spend <= 0
            ? "censored"
            : (forward.roas ?? 0) < breakEvenRoas
              ? "supported"
              : "refuted";
      return {
        windowDays,
        dueDate,
        complete,
        status,
        spend: forward.spend,
        conversions: forward.conversions,
        revenue: forward.revenue,
        roas: forward.roas,
        cutOpportunity:
          status === "unknown" || status === "censored"
            ? null
            : mature && status === "supported",
        completenessSourceIds: Array.from(
          new Set(
            completenessReceipts.flatMap(
              (receipt) => receipt?.sourceIds ?? [],
            ),
          ),
        ).sort(),
      };
    };
    const outcomes = Object.fromEntries(
      H1_COUNTRY_OUTCOME_WINDOWS.map((windowDays) => [
        windowDays,
        buildOutcome(windowDays),
      ]),
    ) as Record<H1CountryOutcomeWindowDays, FixedH1CountryOutcome>;
    const outcome = outcomes[PRIMARY_OUTCOME_WINDOW_DAYS];
    const cohort = resolveMetaFunnelCohort({
      optimizationGoal: current.goal,
      customEventType: current.customEventType,
      objective: current.objective,
      purchases: window28.conversions,
      revenue: window28.revenue,
    });
    const ratioToTarget =
      targetRoas !== null && targetRoas > 0 && window28.roas !== null
        ? window28.roas / targetRoas
        : null;
    const breakEvenRatio =
      targetRoas !== null &&
      targetRoas > 0 &&
      breakEvenRoas !== null &&
      breakEvenRoas > 0
        ? breakEvenRoas / targetRoas
        : null;
    const missingFields = [
      current.campaignId === null ? "campaign_id" : null,
      current.adsetId === null ? "adset_id" : null,
      current.currency === null ? "currency" : null,
      current.goal === null ? "goal" : null,
      !targetReceipt.observed ? "target_observed_at_cutoff" : null,
      targetRoas === null || targetRoas <= 0 ? "target_roas" : null,
      breakEvenRoas === null || breakEvenRoas <= 0 ? "break_even_roas" : null,
      commercialMaturitySpend === null ? "commercial_maturity_spend" : null,
      !fixedCountryMix.available ? "country_mix_28d" : null,
      !outcome.complete ? "outcome_completeness_14d" : null,
    ].flatMap((field) => (field === null ? [] : [field]));
    const key = [
      current.businessId,
      current.providerAccountId,
      current.adId,
      current.date,
    ].join("::");
    const manifest = {
      contractVersion: H1_COUNTRY_PARENT_CONTRACT_VERSION,
      challengerVersion: H1_COUNTRY_PARENT_CHALLENGER_VERSION,
      sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
      exactPit: false,
      causal: false,
      key,
      cutoff: h1CountryProducerCutoff(current.date, producerCutoffUtc),
      identity: {
        businessId: current.businessId,
        providerAccountId: current.providerAccountId,
        campaignId: current.campaignId,
        adsetId: current.adsetId,
        adId: current.adId,
        currency: current.currency,
        goal: current.goal,
      },
      target: {
        id: target?.id ?? null,
        observedAtCutoff: targetReceipt.observed,
        fresh: targetReceipt.fresh,
        updatedAt: target?.updatedAt ?? null,
        targetRoas,
        breakEvenRoas,
      },
      config: {
        riskPosture: target?.riskPosture ?? "balanced",
        spendUnitSource: spendResolution.source,
        lossBudgetMultiplier: multipliers.lossBudget,
        recentSampleMultiplier: multipliers.recentSample,
      },
      metrics: {
        spend28: window28.spend,
        conversions28: window28.conversions,
        revenue28: window28.revenue,
        roas28: window28.roas,
        ratioToTarget,
        recent7Spend: window7.spend,
        recent7Roas: window7.roas,
      },
      country: {
        assignedCountry: null,
        mixHash: fixedCountryMix.mixHash,
        generationSourceHashes: fixedCountryMix.sourceGenerationHashes,
      },
      calibrationEnvironmentHash: environment.environmentHash,
      normalizedSourceIds: Array.from(
        new Set([...window28.sourceIds, ...window7.sourceIds]),
      ).sort(),
      outcomes: Object.fromEntries(
        H1_COUNTRY_OUTCOME_WINDOWS.map((windowDays) => {
          const windowOutcome = outcomes[windowDays];
          return [
            `${windowDays}d`,
            {
              dueDate: windowOutcome.dueDate,
              complete: windowOutcome.complete,
              completenessSourceIds:
                windowOutcome.completenessSourceIds,
              status: windowOutcome.status,
              spend: windowOutcome.spend,
              conversions: windowOutcome.conversions,
              revenue: windowOutcome.revenue,
              roas: windowOutcome.roas,
              cutOpportunity: windowOutcome.cutOpportunity,
            },
          ];
        }),
      ),
      missingFields,
    };
    rows.push({
      key,
      sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
      manifestHash: countryParentStableHash(manifest),
      businessId: current.businessId,
      businessName: current.businessName,
      providerAccountId: current.providerAccountId,
      date: current.date,
      campaignId: current.campaignId,
      adsetId: current.adsetId,
      adId: current.adId,
      currency: current.currency,
      objective: current.objective,
      goal: current.goal,
      customEventType: current.customEventType,
      purchaseCohort: cohort === "purchase",
      target,
      targetObservedAtCutoff: targetReceipt.observed,
      targetFresh: targetReceipt.fresh,
      spend28: window28.spend,
      conversions28: window28.conversions,
      revenue28: window28.revenue,
      roas28: window28.roas,
      ratioToTarget,
      recent7Spend: window7.spend,
      recent7Roas: window7.roas,
      commercialMaturitySpend,
      recentSampleMinSpend,
      recoveryHold,
      breakEvenRatio,
      countryMix: fixedCountryMix,
      calibrationEnvironmentId: environment.id,
      outcome,
      outcomes,
      missingFields,
    });
  }

  rows.sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(rows.map((row) => row.key)).size !== rows.length) {
    throw new Error("fixed cohort contains duplicate keys");
  }
  const environments = Array.from(environmentCache.values()).sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const countryMixMetaSpend = rows.reduce(
    (sum, row) => sum + row.countryMix.totalMetaSpend,
    0,
  );
  const countryMixReconciledSpend = rows.reduce(
    (sum, row) => sum + row.countryMix.reconciledMetaSpend,
    0,
  );
  const coverage = {
    rows: rows.length,
    uniqueKeys: new Set(rows.map((row) => row.key)).size,
    purchaseCohortRows: rows.filter((row) => row.purchaseCohort).length,
    targetObservedRows: rows.filter((row) => row.targetObservedAtCutoff).length,
    targetFreshRows: rows.filter((row) => row.targetFresh).length,
    completeOutcomeRows: rows.filter((row) => row.outcome.complete).length,
    completeOutcomeRowsByWindow: Object.fromEntries(
      H1_COUNTRY_OUTCOME_WINDOWS.map((windowDays) => [
        `${windowDays}d`,
        rows.filter((row) => row.outcomes[windowDays].complete).length,
      ]),
    ) as Record<`${H1CountryOutcomeWindowDays}d`, number>,
    countryMixAvailableRows: rows.filter((row) => row.countryMix.available)
      .length,
    multiCountryRows: rows.filter(
      (row) => row.countryMix.available && row.countryMix.multiCountry,
    ).length,
    countryMixFallbackRows: rows.filter((row) => !row.countryMix.available)
      .length,
    countryMixMetaSpend,
    countryMixReconciledSpend,
    countryMixSpendCoverage: ratio(
      countryMixReconciledSpend,
      countryMixMetaSpend,
    ),
  };
  return {
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    rows,
    environments,
    fixedCohortHash: countryParentStableHash(
      rows.map((row) => ({ key: row.key, manifestHash: row.manifestHash })),
    ),
    manifestSetHash: countryParentStableHash(
      rows.map((row) => row.manifestHash).sort(),
    ),
    coverage,
  };
}

interface VariantEvaluationBundle {
  variant: H1CountryParentVariant;
  rows: H1CountryEvaluationRow[];
  thresholdCoverage: {
    thresholdEvaluatedRows: number;
    thresholdAvailableRows: number;
    countryConditionedRows: number;
    fullCountrySupportRows: number;
    partialCountryFallbackRows: number;
    completeCountryFallbackRows: number;
    averageCountrySupportedSpendShare: number | null;
  };
}

function harmonicMean(left: number | null, right: number | null) {
  return left !== null && right !== null && left + right > 0
    ? (2 * left * right) / (left + right)
    : null;
}

function evaluateVariantOnFixedCohort(input: {
  cohort: FixedH1CountryCohort;
  environmentById: ReadonlyMap<string, FixedCountryCalibrationEnvironment>;
  variant: H1CountryParentVariant;
  preparedThresholdCache: Map<
    string,
    ReturnType<typeof prepareH1CountryParentThresholdResolver>
  >;
}): VariantEvaluationBundle {
  const rows: H1CountryEvaluationRow[] = [];
  let thresholdEvaluatedRows = 0;
  let thresholdAvailableRows = 0;
  let countryConditionedRows = 0;
  let fullCountrySupportRows = 0;
  let partialCountryFallbackRows = 0;
  let completeCountryFallbackRows = 0;
  let supportedSpendShareTotal = 0;
  for (const row of input.cohort.rows) {
    const environment = input.environmentById.get(row.calibrationEnvironmentId);
    if (!environment) {
      throw new Error(
        `missing calibration environment: ${row.calibrationEnvironmentId}`,
      );
    }
    const targetRoas = row.targetObservedAtCutoff
      ? (row.target?.targetRoas ?? null)
      : null;
    const breakEvenRoas = row.targetObservedAtCutoff
      ? (row.target?.breakEvenRoas ?? null)
      : null;
    const thresholdEligible =
      row.purchaseCohort &&
      row.targetFresh &&
      targetRoas !== null &&
      targetRoas > 0 &&
      breakEvenRoas !== null &&
      breakEvenRoas > 0 &&
      row.currency !== null &&
      row.goal !== null &&
      row.campaignId !== null &&
      row.adsetId !== null &&
      row.ratioToTarget !== null &&
      row.roas28 !== null &&
      row.commercialMaturitySpend !== null;
    const threshold = thresholdEligible
      ? (() => {
          const cacheKey = [
            input.variant.baseVariantId,
            environment.id,
            row.goal,
          ].join("::");
          let prepared = input.preparedThresholdCache.get(cacheKey);
          if (!prepared) {
            prepared = prepareH1CountryParentThresholdResolver({
              observations: environment.observations,
              target: {
                businessId: row.businessId,
                providerAccountId: row.providerAccountId,
                currency: row.currency,
                goal: row.goal,
              },
              variant: input.variant,
            });
            input.preparedThresholdCache.set(cacheKey, prepared);
          }
          return prepared.resolve({
            parentMode: input.variant.parentMode,
            countryMix: row.countryMix,
          });
        })()
      : null;
    if (threshold) {
      thresholdEvaluatedRows += 1;
      if (threshold.value !== null) thresholdAvailableRows += 1;
      supportedSpendShareTotal += threshold.countrySupportedSpendShare;
      if (threshold.usedCountryConditioning) countryConditionedRows += 1;
      if (threshold.fallbackSpendShare <= 1e-12) fullCountrySupportRows += 1;
      else if (threshold.fallbackSpendShare < 1 - 1e-12) {
        partialCountryFallbackRows += 1;
      } else {
        completeCountryFallbackRows += 1;
      }
    }
    const applicable = thresholdEligible && threshold?.value !== null;
    const cutBoundary =
      applicable && row.breakEvenRatio !== null
        ? Math.min(threshold!.value!, row.breakEvenRatio, 1)
        : null;
    const emitted =
      applicable &&
      cutBoundary !== null &&
      row.ratioToTarget! < cutBoundary &&
      row.spend28 >= row.commercialMaturitySpend! &&
      !row.recoveryHold;
    const safetyViolation =
      emitted &&
      (!row.targetFresh ||
        breakEvenRoas === null ||
        row.roas28 === null ||
        row.roas28 >= breakEvenRoas ||
        row.currency === null ||
        row.goal === null);
    rows.push({
      key: row.key,
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      adId: row.adId,
      date: row.date,
      emitted,
      outcomeStatus: row.outcome.status,
      cutOpportunity: row.outcome.cutOpportunity,
      safetyViolation,
      usedCountryConditioning: threshold?.usedCountryConditioning ?? false,
      fallbackSpendShare: threshold?.fallbackSpendShare ?? 1,
    });
  }
  return {
    variant: input.variant,
    rows,
    thresholdCoverage: {
      thresholdEvaluatedRows,
      thresholdAvailableRows,
      countryConditionedRows,
      fullCountrySupportRows,
      partialCountryFallbackRows,
      completeCountryFallbackRows,
      averageCountrySupportedSpendShare:
        thresholdEvaluatedRows > 0
          ? supportedSpendShareTotal / thresholdEvaluatedRows
          : null,
    },
  };
}

function foldRows(input: {
  rows: readonly H1CountryEvaluationRow[];
  outcomeCeiling: string;
  outcomeWindowDays?: H1CountryOutcomeWindowDays;
}) {
  const result = {
    development: [] as H1CountryEvaluationRow[],
    calibration: [] as H1CountryEvaluationRow[],
    locked_test: [] as H1CountryEvaluationRow[],
  };
  for (const row of input.rows) {
    const assignment = assignRollingOriginFold({
      decisionDate: row.date,
      outcomeWindowDays:
        input.outcomeWindowDays ?? PRIMARY_OUTCOME_WINDOW_DAYS,
      outcomesObservedThrough: input.outcomeCeiling,
    });
    if (!assignment.eligible || assignment.foldId === null) continue;
    if (
      assignment.foldId === "development" ||
      assignment.foldId === "calibration" ||
      assignment.foldId === "locked_test"
    ) {
      result[assignment.foldId].push(row);
    }
  }
  return result;
}

function compactBootstrap(
  result: ReturnType<typeof clusteredMovingBlockBootstrap> | null,
) {
  if (!result) return null;
  const { estimates: _estimates, ...summary } = result;
  return summary;
}

export function evaluateH1CountryParentGrid(input: {
  cohort: FixedH1CountryCohort;
  outcomeCeiling: string;
  bootstrapIterations?: number;
}) {
  const variants = buildH1CountryParentGrid();
  if (variants.length !== 288) {
    throw new Error(
      `expected 288 H1 parent variants, received ${variants.length}`,
    );
  }
  const environmentById = new Map(
    input.cohort.environments.map((environment) => [
      environment.id,
      environment,
    ]),
  );
  const summarizeBundle = (bundle: VariantEvaluationBundle) => {
    const folds = foldRows({
      rows: bundle.rows,
      outcomeCeiling: input.outcomeCeiling,
    });
    return {
      variant: bundle.variant,
      thresholdCoverage: bundle.thresholdCoverage,
      full: summarizeH1CountryEvaluations(bundle.rows),
      folds: {
        development: summarizeH1CountryEvaluations(folds.development),
        calibration: summarizeH1CountryEvaluations(folds.calibration),
        lockedTest: summarizeH1CountryEvaluations(folds.locked_test),
      },
    };
  };
  const variantById = new Map(
    variants.map((variant) => [variant.id, variant] as const),
  );
  const baseVariantIds = Array.from(
    new Set(variants.map((variant) => variant.baseVariantId)),
  ).sort();
  const summaries: Array<ReturnType<typeof summarizeBundle>> = [];
  const pairComparisons: Array<{
    baseVariantId: string;
    full: ReturnType<typeof comparePairedH1CountryEvaluations>;
    calibration: ReturnType<typeof comparePairedH1CountryEvaluations>;
    lockedTest: ReturnType<typeof comparePairedH1CountryEvaluations>;
  }> = [];
  for (const baseVariantId of baseVariantIds) {
    const accountId = `${baseVariantId}__parent_account_goal`;
    const countryId = `${baseVariantId}__parent_account_goal_country_spend_weighted`;
    const accountVariant = variantById.get(accountId);
    const countryVariant = variantById.get(countryId);
    if (!accountVariant || !countryVariant) {
      throw new Error(`missing parent pair for ${baseVariantId}`);
    }
    const preparedThresholdCache = new Map<
      string,
      ReturnType<typeof prepareH1CountryParentThresholdResolver>
    >();
    const accountBundle = evaluateVariantOnFixedCohort({
      cohort: input.cohort,
      environmentById,
      variant: accountVariant,
      preparedThresholdCache,
    });
    const countryBundle = evaluateVariantOnFixedCohort({
      cohort: input.cohort,
      environmentById,
      variant: countryVariant,
      preparedThresholdCache,
    });
    summaries.push(
      summarizeBundle(accountBundle),
      summarizeBundle(countryBundle),
    );
    const accountFolds = foldRows({
      rows: accountBundle.rows,
      outcomeCeiling: input.outcomeCeiling,
    });
    const countryFolds = foldRows({
      rows: countryBundle.rows,
      outcomeCeiling: input.outcomeCeiling,
    });
    pairComparisons.push({
      baseVariantId,
      full: comparePairedH1CountryEvaluations({
        accountGoalRows: accountBundle.rows,
        countryWeightedRows: countryBundle.rows,
      }),
      calibration: comparePairedH1CountryEvaluations({
        accountGoalRows: accountFolds.calibration,
        countryWeightedRows: countryFolds.calibration,
      }),
      lockedTest: comparePairedH1CountryEvaluations({
        accountGoalRows: accountFolds.locked_test,
        countryWeightedRows: countryFolds.locked_test,
      }),
    });
  }
  const summaryById = new Map(
    summaries.map((summary) => [summary.variant.id, summary]),
  );
  const selectedAccountGoal =
    summaries
      .filter((summary) => summary.variant.parentMode === "account_goal")
      .map((summary) => ({
        summary,
        selectionScore: harmonicMean(
          summary.folds.calibration.precision,
          summary.folds.calibration.recall,
        ),
      }))
      .sort(
        (left, right) =>
          left.summary.folds.calibration.safetyViolations -
            right.summary.folds.calibration.safetyViolations ||
          (right.selectionScore ?? -1) - (left.selectionScore ?? -1) ||
          right.summary.folds.calibration.known -
            left.summary.folds.calibration.known ||
          left.summary.variant.id.localeCompare(right.summary.variant.id),
      )[0] ?? null;
  const selectedBaseVariantId =
    selectedAccountGoal?.summary.variant.baseVariantId ?? null;
  const selectedPair = selectedBaseVariantId
    ? (pairComparisons.find(
        (comparison) => comparison.baseVariantId === selectedBaseVariantId,
      ) ?? null)
    : null;
  const selectedPreparedThresholdCache = new Map<
    string,
    ReturnType<typeof prepareH1CountryParentThresholdResolver>
  >();
  const selectedAccountVariant = selectedBaseVariantId
    ? (variantById.get(`${selectedBaseVariantId}__parent_account_goal`) ?? null)
    : null;
  const selectedCountryVariant = selectedBaseVariantId
    ? (variantById.get(
        `${selectedBaseVariantId}__parent_account_goal_country_spend_weighted`,
      ) ?? null)
    : null;
  const selectedAccountBundle = selectedAccountVariant
    ? evaluateVariantOnFixedCohort({
        cohort: input.cohort,
        environmentById,
        variant: selectedAccountVariant,
        preparedThresholdCache: selectedPreparedThresholdCache,
      })
    : null;
  const selectedCountryBundle = selectedCountryVariant
    ? evaluateVariantOnFixedCohort({
        cohort: input.cohort,
        environmentById,
        variant: selectedCountryVariant,
        preparedThresholdCache: selectedPreparedThresholdCache,
      })
    : null;
  const selectedWindowSensitivity =
    selectedAccountVariant && selectedCountryVariant
      ? H1_COUNTRY_OUTCOME_WINDOWS.map((windowDays) => {
          const windowCohort: FixedH1CountryCohort = {
            ...input.cohort,
            rows: input.cohort.rows.map((row) => ({
              ...row,
              outcome: row.outcomes[windowDays],
            })),
          };
          const accountBundle =
            windowDays === PRIMARY_OUTCOME_WINDOW_DAYS &&
            selectedAccountBundle
              ? selectedAccountBundle
              : evaluateVariantOnFixedCohort({
                  cohort: windowCohort,
                  environmentById,
                  variant: selectedAccountVariant,
                  preparedThresholdCache: selectedPreparedThresholdCache,
                });
          const countryBundle =
            windowDays === PRIMARY_OUTCOME_WINDOW_DAYS &&
            selectedCountryBundle
              ? selectedCountryBundle
              : evaluateVariantOnFixedCohort({
                  cohort: windowCohort,
                  environmentById,
                  variant: selectedCountryVariant,
                  preparedThresholdCache: selectedPreparedThresholdCache,
                });
          const accountLocked = foldRows({
            rows: accountBundle.rows,
            outcomeCeiling: input.outcomeCeiling,
            outcomeWindowDays: windowDays,
          }).locked_test;
          const countryLocked = foldRows({
            rows: countryBundle.rows,
            outcomeCeiling: input.outcomeCeiling,
            outcomeWindowDays: windowDays,
          }).locked_test;
          return {
            windowDays,
            accountGoal: summarizeH1CountryEvaluations(accountLocked),
            countryWeighted: summarizeH1CountryEvaluations(countryLocked),
            comparison: comparePairedH1CountryEvaluations({
              accountGoalRows: accountLocked,
              countryWeightedRows: countryLocked,
            }),
          };
        })
      : [];
  const selectedAccountLocked = selectedAccountBundle
    ? foldRows({
        rows: selectedAccountBundle.rows,
        outcomeCeiling: input.outcomeCeiling,
      }).locked_test
    : [];
  const selectedCountryLocked = selectedCountryBundle
    ? foldRows({
        rows: selectedCountryBundle.rows,
        outcomeCeiling: input.outcomeCeiling,
      }).locked_test
    : [];
  const selectedCountryByKey = new Map(
    selectedCountryLocked.map((row) => [row.key, row]),
  );
  const bootstrapRows = selectedAccountLocked.flatMap((row) => {
    const country = selectedCountryByKey.get(row.key);
    return row.cutOpportunity === true && country
      ? [
          {
            businessId: row.businessId,
            entityId: `${row.providerAccountId}:${row.adId}`,
            date: row.date,
            delta: Number(country.emitted) - Number(row.emitted),
          },
        ]
      : [];
  });
  const recallDeltaBootstrap =
    bootstrapRows.length > 0
      ? clusteredMovingBlockBootstrap(bootstrapRows, {
          getBusinessId: (row) => row.businessId,
          getEntityId: (row) => row.entityId,
          getDate: (row) => row.date,
          statistic: (sample) =>
            sample.length > 0
              ? sample.reduce((sum, row) => sum + row.observation.delta, 0) /
                sample.length
              : null,
          seed: `H1-country-parent:${selectedBaseVariantId}:locked-test`,
          iterations: input.bootstrapIterations ?? 10_000,
          blockLengthDays: 7,
          confidenceLevel: 0.95,
        })
      : null;
  const selectedCountrySummary = selectedBaseVariantId
    ? (summaryById.get(
        `${selectedBaseVariantId}__parent_account_goal_country_spend_weighted`,
      ) ?? null)
    : null;
  const lockedScore = selectedCountrySummary?.folds.lockedTest ?? null;
  const historicalGateFailures = [
    !lockedScore || lockedScore.known < 100 ? "known_outcomes_below_100" : null,
    !lockedScore || (lockedScore.precision ?? 0) < 0.92
      ? "precision_below_0_92"
      : null,
    !lockedScore || (lockedScore.recall ?? 0) < 0.92
      ? "recall_below_0_92"
      : null,
    !lockedScore || (lockedScore.precisionWilson?.lower ?? 0) < 0.85
      ? "precision_wilson_lower_below_0_85"
      : null,
    !lockedScore || lockedScore.safetyViolations > 0
      ? "safety_violations_nonzero"
      : null,
    !recallDeltaBootstrap || (recallDeltaBootstrap.lower ?? -1) <= -0.02
      ? "paired_recall_noninferiority_not_met"
      : null,
  ].flatMap((failure) => (failure === null ? [] : [failure]));
  const countryCoverageAvailable =
    input.cohort.coverage.countryMixAvailableRows > 0;
  const lockedDecisionChanges = selectedPair
    ? selectedPair.lockedTest.transition.accountGoalOnly +
      selectedPair.lockedTest.transition.countryWeightedOnly
    : 0;
  const status = !countryCoverageAvailable
    ? "INSUFFICIENT_RETAINED_COUNTRY_COVERAGE"
    : lockedDecisionChanges === 0
      ? "RETAIN_ACCOUNT_GOAL_NO_INCREMENTAL_DECISION_SIGNAL"
      : historicalGateFailures.length === 0
        ? "PASSES_HISTORICAL_SENSITIVITY_GATE_REVIEW_ONLY"
        : "INSUFFICIENT_EVIDENCE_RETAIN_ACCOUNT_GOAL";
  return {
    variants,
    variantGridHash: countryParentStableHash(variants),
    summaries,
    pairComparisons,
    selection: {
      protocol:
        "select H1 configuration on account_goal calibration fold, then compare both parent modes at that locked configuration",
      selectedBaseVariantId,
      calibrationSelectionScore: selectedAccountGoal?.selectionScore ?? null,
      selectedPair,
      selectedWindowSensitivity,
      lockedRecallDeltaBootstrap: compactBootstrap(recallDeltaBootstrap),
      historicalGateFailures,
      status,
    },
  };
}

export async function buildH1CountryParentReport(args: ParsedH1CountryArgs) {
  const startedAt = performance.now();
  const sources = await loadH1CountrySources(args);
  console.error(
    `[h1-country] sources_loaded_ms=${Math.round(performance.now() - startedAt)}`,
  );
  const cohort = buildVariantIndependentH1CountryCohort({
    facts: sources.facts,
    targets: sources.targets,
    completeness: sources.completeness,
    resolveCountryMix: sources.resolveCountryMix,
    startDate: args.startDate,
    decisionEndDate: args.decisionEndDate,
    outcomeCeiling: args.outcomeCeiling,
    producerCutoffUtc: args.producerCutoffUtc,
  });
  console.error(
    `[h1-country] cohort_built_ms=${Math.round(performance.now() - startedAt)} rows=${cohort.rows.length}`,
  );
  const evaluation = evaluateH1CountryParentGrid({
    cohort,
    outcomeCeiling: args.outcomeCeiling,
  });
  console.error(
    `[h1-country] grid_evaluated_ms=${Math.round(performance.now() - startedAt)} variants=${evaluation.variants.length}`,
  );
  const deterministicCore = {
    contractVersion: H1_COUNTRY_PARENT_CONTRACT_VERSION,
    challengerVersion: H1_COUNTRY_PARENT_CHALLENGER_VERSION,
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    evidenceClaims: {
      exactPit: false,
      causal: false,
      permitted: "restated formula and parent-axis sensitivity only",
    },
    queryPolicy: H1_COUNTRY_PARENT_QUERY_POLICY,
    dates: {
      startDate: args.startDate,
      decisionEndDate: args.decisionEndDate,
      outcomeCeiling: args.outcomeCeiling,
      primaryOutcomeWindowDays: PRIMARY_OUTCOME_WINDOW_DAYS,
      outcomeWindowDays: H1_COUNTRY_OUTCOME_WINDOWS,
      producerCutoffUtc: args.producerCutoffUtc,
      calibrationDecisionDates: "2026-04-01..2026-05-31",
      calibrationMatureThrough: "2026-05-17",
      lockedDecisionDates: "2026-06-01..2026-07-05",
      lockedMatureThrough: "2026-06-27",
    },
    sources: {
      sourceHash: sources.sourceHash,
      normalizedAdRows: sources.facts.length,
      targetRows: sources.targets.length,
      completenessRows: sources.completeness.length,
      rawCoverage: sources.rawCoverage,
    },
    cohort: {
      fixedCohortHash: cohort.fixedCohortHash,
      manifestSetHash: cohort.manifestSetHash,
      coverage: cohort.coverage,
      environmentCount: cohort.environments.length,
    },
    evaluation,
    constraints: [
      "Every variant uses the same precomputed native-ad entity-date cohort.",
      "Country is a 28-day spend-share vector; assignedCountry is always null.",
      "For every decision date, each trailing source day uses only the latest generation observed by that decision's declared producer cutoff; fetched_at and retained created_at must be at or before cutoff, and no older-generation fallback is allowed.",
      "Country ad-day spend must reconcile to meta_ad_daily before it enters a mix.",
      "Sparse country cells fall back share-by-share to account_goal and never increase confidence.",
      "The D049 breakeven ceiling remains fixed in both parent modes.",
      "No result is exact PIT, causal lift, automation evidence, or production resolver authority.",
    ],
    productionChange: null,
  };
  return {
    ...deterministicCore,
    reportHash: countryParentStableHash(deterministicCore),
  };
}

async function main() {
  const args = parseH1CountryArgs(process.argv.slice(2));
  const report = await buildH1CountryParentReport(args);
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
