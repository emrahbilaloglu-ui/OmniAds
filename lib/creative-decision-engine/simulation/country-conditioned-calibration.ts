import { createHash } from "node:crypto";
import {
  H1_QUANTILES,
  H1_RECENCY_HALF_LIFE_DAYS,
  H1_SHRINKAGE_KAPPA,
  effectiveSampleSize,
  recencyWeight,
  shrinkPositiveRatioLogSpace,
  weightedQuantile,
} from "./hierarchical-calibration";
import {
  pairedMcNemarFromCounts,
  wilsonScoreInterval,
} from "./paired-binary-inference";

export const H1_COUNTRY_PARENT_CONTRACT_VERSION =
  "creative-decision-simulation.h1-country-parent.v1" as const;
export const H1_COUNTRY_PARENT_SOURCE_MODE =
  "restated_raw_ad_country_daily" as const;

export const H1_COUNTRY_PARENT_MODES = [
  "account_goal",
  "account_goal_country_spend_weighted",
] as const;

export type H1CountryParentMode = (typeof H1_COUNTRY_PARENT_MODES)[number];

export interface H1CountryParentVariant {
  id: string;
  baseVariantId: string;
  parentMode: H1CountryParentMode;
  halfLifeDays: (typeof H1_RECENCY_HALF_LIFE_DAYS)[number];
  kappa: (typeof H1_SHRINKAGE_KAPPA)[number];
  quantile: (typeof H1_QUANTILES)[number];
}

export interface CountryCellSupportPolicy {
  minimumSampleSize: number;
  minimumEffectiveSampleSize: number;
  minimumMixSpendCoverage: number;
}

export const DEFAULT_COUNTRY_CELL_SUPPORT_POLICY = {
  minimumSampleSize: 8,
  minimumEffectiveSampleSize: 8,
  minimumMixSpendCoverage: 0.8,
} as const satisfies CountryCellSupportPolicy;

export type CountryCalibrationConfidence =
  "unknown" | "insufficient" | "low" | "medium" | "high";

export type H1CountryOutcomeStatus =
  "supported" | "refuted" | "neutral" | "unknown" | "censored";

function token(value: number) {
  return String(value).replaceAll(".", "p");
}

export function buildH1CountryParentGrid(): H1CountryParentVariant[] {
  const variants: H1CountryParentVariant[] = [];
  for (const halfLifeDays of H1_RECENCY_HALF_LIFE_DAYS) {
    for (const kappa of H1_SHRINKAGE_KAPPA) {
      for (const quantile of H1_QUANTILES) {
        const baseVariantId = `H1_hl${halfLifeDays}_k${kappa}_q${token(quantile)}`;
        for (const parentMode of H1_COUNTRY_PARENT_MODES) {
          variants.push({
            id: `${baseVariantId}__parent_${parentMode}`,
            baseVariantId,
            parentMode,
            halfLifeDays,
            kappa,
            quantile,
          });
        }
      }
    }
  }
  return variants;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function countryParentStableHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validIsoDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

function addDays(date: string, days: number) {
  if (!validIsoDate(date)) throw new Error(`invalid ISO date: ${date}`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function assertSupportPolicy(policy: CountryCellSupportPolicy) {
  if (
    !Number.isInteger(policy.minimumSampleSize) ||
    policy.minimumSampleSize <= 0
  ) {
    throw new Error("minimumSampleSize must be a positive integer");
  }
  if (
    !Number.isFinite(policy.minimumEffectiveSampleSize) ||
    policy.minimumEffectiveSampleSize <= 0
  ) {
    throw new Error("minimumEffectiveSampleSize must be positive");
  }
  if (
    !Number.isFinite(policy.minimumMixSpendCoverage) ||
    policy.minimumMixSpendCoverage < 0 ||
    policy.minimumMixSpendCoverage > 1
  ) {
    throw new Error("minimumMixSpendCoverage must be between zero and one");
  }
}

export interface RawCountrySnapshotPage {
  id: string;
  businessId: string;
  providerAccountId: string;
  sourceDate: string;
  partitionId: string | null;
  runId: string | null;
  pageIndex: number | null;
  providerCursor: string | null;
  providerHttpStatus: number | null;
  status: string;
  fetchedAt: string | null;
  createdAt?: string | null;
  payload: unknown;
}

export interface SelectedCountryGeneration<
  TPage extends RawCountrySnapshotPage = RawCountrySnapshotPage,
> {
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  businessId: string;
  providerAccountId: string;
  sourceDate: string;
  partitionId: string | null;
  runId: string | null;
  snapshotIds: string[];
  firstPageIndex: number;
  lastPageIndex: number;
  rowCount: number;
  sourceHash: string;
  pages: TPage[];
}

export class CountryGenerationIntegrityError extends Error {
  constructor(
    public readonly code:
      | "empty_scope"
      | "mixed_scope"
      | "latest_generation_incomplete"
      | "latest_generation_invalid",
    detail: string,
  ) {
    super(`Country generation rejected (${code}): ${detail}`);
    this.name = "CountryGenerationIntegrityError";
  }
}

function observedTimestamp(page: RawCountrySnapshotPage) {
  const parsed = Date.parse(page.fetchedAt ?? "");
  if (Number.isFinite(parsed)) return parsed;
  const createdTimestamp = retainedCreatedTimestamp(page);
  return createdTimestamp !== null && Number.isFinite(createdTimestamp)
    ? createdTimestamp
    : Number.NEGATIVE_INFINITY;
}

function retainedCreatedTimestamp(page: RawCountrySnapshotPage) {
  if (page.createdAt === undefined || page.createdAt === null) return null;
  const parsed = Date.parse(page.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function generationIdentity(page: RawCountrySnapshotPage) {
  return `${page.partitionId ?? "null"}::${page.runId ?? "null"}`;
}

function splitObservedGenerations<TPage extends RawCountrySnapshotPage>(
  pages: readonly TPage[],
) {
  const sorted = [...pages].sort(
    (left, right) =>
      observedTimestamp(left) - observedTimestamp(right) ||
      left.id.localeCompare(right.id),
  );
  const generations: TPage[][] = [];
  let current: TPage[] = [];

  for (const page of sorted) {
    const previous = current.at(-1) ?? null;
    const startsNew =
      previous !== null &&
      (generationIdentity(previous) !== generationIdentity(page) ||
        (page.pageIndex !== null &&
          previous.pageIndex !== null &&
          page.pageIndex <= previous.pageIndex));
    if (startsNew) {
      generations.push(current);
      current = [];
    }
    current.push(page);
    if (page.providerCursor === null) {
      generations.push(current);
      current = [];
    }
  }
  if (current.length > 0) generations.push(current);
  return generations;
}

export function selectLatestCompleteCountryGeneration<
  TPage extends RawCountrySnapshotPage,
>(pages: readonly TPage[]): SelectedCountryGeneration<TPage> {
  return selectLatestCountryGeneration(pages, null);
}

export function selectLatestCompleteCountryGenerationAtCutoff<
  TPage extends RawCountrySnapshotPage,
>(pages: readonly TPage[], cutoff: string): SelectedCountryGeneration<TPage> {
  const cutoffTimestamp = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTimestamp)) {
    throw new Error(`invalid country generation cutoff: ${cutoff}`);
  }
  const observedPages = pages.filter((page) => {
    const fetchedTimestamp = observedTimestamp(page);
    if (Number.isFinite(fetchedTimestamp)) {
      return fetchedTimestamp <= cutoffTimestamp;
    }
    const createdTimestamp = retainedCreatedTimestamp(page);
    return createdTimestamp !== null && createdTimestamp <= cutoffTimestamp;
  });
  return selectLatestCountryGeneration(observedPages, cutoffTimestamp);
}

function selectLatestCountryGeneration<TPage extends RawCountrySnapshotPage>(
  pages: readonly TPage[],
  cutoffTimestamp: number | null,
): SelectedCountryGeneration<TPage> {
  if (pages.length === 0) {
    throw new CountryGenerationIntegrityError(
      "empty_scope",
      cutoffTimestamp === null
        ? "no raw breakdown_country pages were retained"
        : "no raw breakdown_country pages were observed by the producer cutoff",
    );
  }
  const scopes = new Set(
    pages.map((page) =>
      [page.businessId, page.providerAccountId, page.sourceDate].join("::"),
    ),
  );
  if (scopes.size !== 1) {
    throw new CountryGenerationIntegrityError(
      "mixed_scope",
      "pages span more than one business/account/source-day",
    );
  }

  const latest = splitObservedGenerations(pages).at(-1) ?? [];
  const failures: string[] = [];
  const firstPageIndex = latest[0]?.pageIndex ?? null;
  const snapshotIds = new Set<string>();
  const partitionIds = new Set<string>();
  const runIds = new Set<string>();
  let rowCount = 0;

  for (const [offset, page] of latest.entries()) {
    if (!page.id.trim() || snapshotIds.has(page.id)) {
      failures.push(`snapshot_id:${page.id || "missing"}`);
    }
    snapshotIds.add(page.id);
    if (!validIsoDate(page.sourceDate)) {
      failures.push(`source_date:${page.id}`);
    }
    if (page.status !== "fetched") {
      failures.push(`status:${page.id}:${page.status}`);
    }
    if (
      page.providerHttpStatus === null ||
      page.providerHttpStatus < 200 ||
      page.providerHttpStatus >= 300
    ) {
      failures.push(`http_status:${page.id}`);
    }
    if (!Number.isFinite(Date.parse(page.fetchedAt ?? ""))) {
      failures.push(`fetched_at:${page.id}`);
    }
    if (cutoffTimestamp !== null && observedTimestamp(page) > cutoffTimestamp) {
      failures.push(`fetched_after_cutoff:${page.id}`);
    }
    const createdTimestamp = retainedCreatedTimestamp(page);
    if (createdTimestamp !== null && !Number.isFinite(createdTimestamp)) {
      failures.push(`created_at:${page.id}`);
    } else if (
      cutoffTimestamp !== null &&
      createdTimestamp !== null &&
      createdTimestamp > cutoffTimestamp
    ) {
      failures.push(`created_after_cutoff:${page.id}`);
    }
    if (!Array.isArray(page.payload)) {
      failures.push(`payload_not_array:${page.id}`);
    } else {
      rowCount += page.payload.length;
    }
    if (
      page.pageIndex === null ||
      !Number.isInteger(page.pageIndex) ||
      page.pageIndex < 0
    ) {
      failures.push(`page_index:${page.id}`);
    } else if (
      firstPageIndex === null ||
      page.pageIndex !== firstPageIndex + offset
    ) {
      failures.push(`page_sequence:${page.id}`);
    }
    if (offset < latest.length - 1 && page.providerCursor === null) {
      failures.push(`early_terminal:${page.id}`);
    }
    if (page.partitionId) partitionIds.add(page.partitionId);
    if (page.runId) runIds.add(page.runId);
  }
  if (partitionIds.size > 1) failures.push("partition_id_conflict");
  if (runIds.size > 1) failures.push("run_id_conflict");
  if (latest.at(-1)?.providerCursor !== null) {
    throw new CountryGenerationIntegrityError(
      "latest_generation_incomplete",
      "the latest observed generation has no terminal page",
    );
  }
  if (failures.length > 0 || firstPageIndex === null) {
    throw new CountryGenerationIntegrityError(
      "latest_generation_invalid",
      failures.join(", ") || "missing first page index",
    );
  }

  const orderedPages = [...latest];
  const first = orderedPages[0]!;
  const sourceHash = countryParentStableHash({
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    scope: {
      businessId: first.businessId,
      providerAccountId: first.providerAccountId,
      sourceDate: first.sourceDate,
    },
    pages: orderedPages.map((page) => ({
      id: page.id,
      partitionId: page.partitionId,
      runId: page.runId,
      pageIndex: page.pageIndex,
      providerCursor: page.providerCursor,
      providerHttpStatus: page.providerHttpStatus,
      status: page.status,
      fetchedAt: page.fetchedAt,
      createdAt: page.createdAt ?? null,
      payload: page.payload,
    })),
  });
  return {
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    businessId: first.businessId,
    providerAccountId: first.providerAccountId,
    sourceDate: first.sourceDate,
    partitionId: first.partitionId,
    runId: first.runId,
    snapshotIds: orderedPages.map((page) => page.id),
    firstPageIndex,
    lastPageIndex: orderedPages.at(-1)!.pageIndex!,
    rowCount,
    sourceHash,
    pages: orderedPages,
  };
}

export interface NormalizedCountryAdDayRow {
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  sourceSnapshotId: string;
  sourceGenerationHash: string;
  businessId: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  country: string | null;
  spend: number | null;
  missingFields: string[];
  conflictFields: string[];
  rawRowHash: string;
}

export class CountryAdKeyIntegrityError extends Error {
  constructor(
    public readonly code:
      "duplicate_ad_country_key" | "conflicting_ad_country_key",
    public readonly key: string,
  ) {
    super(`Country ad-day generation rejected (${code}): ${key}`);
    this.name = "CountryAdKeyIntegrityError";
  }
}

function normalizeCountry(value: unknown) {
  return optionalText(value)?.toUpperCase() ?? null;
}

export function normalizeCountryGenerationRows(
  generation: SelectedCountryGeneration,
): NormalizedCountryAdDayRow[] {
  const rows: NormalizedCountryAdDayRow[] = [];
  for (const page of generation.pages) {
    if (!Array.isArray(page.payload)) continue;
    for (const payload of page.payload) {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      const adId = optionalText(record.ad_id);
      const country = normalizeCountry(record.country);
      const spend = optionalNonNegativeNumber(record.spend);
      const dateStart = optionalText(record.date_start);
      const dateStop = optionalText(record.date_stop);
      const missingFields = [
        adId === null ? "ad_id" : null,
        country === null ? "country" : null,
        spend === null ? "spend" : null,
      ].flatMap((field) => (field === null ? [] : [field]));
      const conflictFields = [
        dateStart !== null && dateStart !== generation.sourceDate
          ? "date_start"
          : null,
        dateStop !== null && dateStop !== generation.sourceDate
          ? "date_stop"
          : null,
      ].flatMap((field) => (field === null ? [] : [field]));
      rows.push({
        sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
        sourceSnapshotId: page.id,
        sourceGenerationHash: generation.sourceHash,
        businessId: generation.businessId,
        providerAccountId: generation.providerAccountId,
        date: generation.sourceDate,
        campaignId: optionalText(record.campaign_id),
        adsetId: optionalText(record.adset_id),
        adId,
        country,
        spend,
        missingFields,
        conflictFields,
        rawRowHash: countryParentStableHash(record),
      });
    }
  }

  const seen = new Map<string, NormalizedCountryAdDayRow>();
  for (const row of rows) {
    if (row.adId === null || row.country === null) continue;
    const key = [
      row.businessId,
      row.providerAccountId,
      row.date,
      row.adId,
      row.country,
    ].join("::");
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, row);
      continue;
    }
    throw new CountryAdKeyIntegrityError(
      previous.rawRowHash === row.rawRowHash
        ? "duplicate_ad_country_key"
        : "conflicting_ad_country_key",
      key,
    );
  }
  return rows.sort(
    (left, right) =>
      left.businessId.localeCompare(right.businessId) ||
      left.providerAccountId.localeCompare(right.providerAccountId) ||
      left.date.localeCompare(right.date) ||
      (left.adId ?? "").localeCompare(right.adId ?? "") ||
      (left.country ?? "").localeCompare(right.country ?? ""),
  );
}

export interface MetaAdDaySpendFact {
  businessId: string;
  providerAccountId: string;
  date: string;
  adId: string;
  campaignId?: string | null;
  adsetId?: string | null;
  currency: string | null;
  goal: string | null;
  spend: number | null;
  sourceId: string | null;
}

export type CountryAdDayReconciliationStatus =
  | "reconciled"
  | "spend_mismatch"
  | "missing_meta"
  | "missing_country"
  | "invalid";

export interface CountryAdDayReconciliation {
  key: string;
  businessId: string;
  providerAccountId: string;
  date: string;
  adId: string;
  currency: string | null;
  goal: string | null;
  metaSpend: number | null;
  rawCountrySpend: number | null;
  difference: number | null;
  allowedDifference: number | null;
  status: CountryAdDayReconciliationStatus;
  countrySpend: Array<{ country: string; spend: number }>;
  metaSourceId: string | null;
  sourceGenerationHashes: string[];
}

function adDayKey(input: {
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

export function reconcileCountryAdDaySpend(input: {
  countryRows: readonly NormalizedCountryAdDayRow[];
  metaRows: readonly MetaAdDaySpendFact[];
  absoluteTolerance?: number;
  relativeTolerance?: number;
}): CountryAdDayReconciliation[] {
  const absoluteTolerance = input.absoluteTolerance ?? 0.02;
  const relativeTolerance = input.relativeTolerance ?? 0.005;
  if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0) {
    throw new Error("absoluteTolerance must be non-negative");
  }
  if (!Number.isFinite(relativeTolerance) || relativeTolerance < 0) {
    throw new Error("relativeTolerance must be non-negative");
  }

  const metaByKey = new Map<string, MetaAdDaySpendFact>();
  for (const row of input.metaRows) {
    const key = adDayKey(row);
    const previous = metaByKey.get(key);
    if (previous) {
      const previousHash = countryParentStableHash(previous);
      const nextHash = countryParentStableHash(row);
      throw new Error(
        `${previousHash === nextHash ? "duplicate" : "conflicting"} meta ad-day key: ${key}`,
      );
    }
    metaByKey.set(key, row);
  }

  const countryByKey = new Map<string, NormalizedCountryAdDayRow[]>();
  for (const row of input.countryRows) {
    if (row.adId === null) continue;
    const key = adDayKey({ ...row, adId: row.adId });
    const grouped = countryByKey.get(key) ?? [];
    grouped.push(row);
    countryByKey.set(key, grouped);
  }

  const keys = Array.from(
    new Set([...metaByKey.keys(), ...countryByKey.keys()]),
  ).sort();
  return keys.map((key) => {
    const meta = metaByKey.get(key) ?? null;
    const countryRows = countryByKey.get(key) ?? [];
    const seed = meta ?? countryRows[0];
    if (!seed) throw new Error(`empty reconciliation key: ${key}`);
    const countrySpendMap = new Map<string, number>();
    let countryInvalid = false;
    const generationHashes = new Set<string>();
    for (const row of countryRows) {
      if (
        row.country === null ||
        row.spend === null ||
        row.conflictFields.length > 0
      ) {
        countryInvalid = true;
        continue;
      }
      countrySpendMap.set(
        row.country,
        (countrySpendMap.get(row.country) ?? 0) + row.spend,
      );
      generationHashes.add(row.sourceGenerationHash);
    }
    const countrySpend = Array.from(countrySpendMap, ([country, spend]) => ({
      country,
      spend,
    })).sort((left, right) => left.country.localeCompare(right.country));
    const rawCountrySpend =
      countryRows.length === 0 || countryInvalid
        ? null
        : countrySpend.reduce((sum, row) => sum + row.spend, 0);
    const metaSpend = meta?.spend ?? null;
    const validMetaSpend =
      metaSpend !== null && Number.isFinite(metaSpend) && metaSpend >= 0;
    const hierarchyConflict =
      meta !== null &&
      countryRows.some(
        (row) =>
          (row.campaignId !== null &&
            meta.campaignId !== undefined &&
            meta.campaignId !== null &&
            row.campaignId !== meta.campaignId) ||
          (row.adsetId !== null &&
            meta.adsetId !== undefined &&
            meta.adsetId !== null &&
            row.adsetId !== meta.adsetId),
      );
    const difference =
      validMetaSpend && rawCountrySpend !== null
        ? rawCountrySpend - metaSpend
        : null;
    const allowedDifference =
      validMetaSpend && rawCountrySpend !== null
        ? Math.max(
            absoluteTolerance,
            relativeTolerance * Math.max(metaSpend, rawCountrySpend),
          )
        : null;
    const status: CountryAdDayReconciliationStatus =
      meta === null
        ? "missing_meta"
        : countryRows.length === 0
          ? "missing_country"
          : !validMetaSpend ||
              rawCountrySpend === null ||
              hierarchyConflict ||
              meta.currency === null ||
              meta.goal === null
            ? "invalid"
            : Math.abs(difference ?? Number.POSITIVE_INFINITY) <=
                (allowedDifference ?? -1)
              ? "reconciled"
              : "spend_mismatch";
    return {
      key,
      businessId: seed.businessId,
      providerAccountId: seed.providerAccountId,
      date: seed.date,
      adId: seed.adId ?? meta!.adId,
      currency: meta?.currency ?? null,
      goal: meta?.goal ?? null,
      metaSpend,
      rawCountrySpend,
      difference,
      allowedDifference,
      status,
      countrySpend,
      metaSourceId: meta?.sourceId ?? null,
      sourceGenerationHashes: Array.from(generationHashes).sort(),
    };
  });
}

export interface AdCountrySpendMix {
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  goal: string | null;
  adId: string;
  asOfDate: string;
  windowDays: 28;
  assignedCountry: null;
  countries: Array<{ country: string; spend: number; spendShare: number }>;
  multiCountry: boolean;
  totalMetaSpend: number;
  reconciledMetaSpend: number;
  rawCountrySpend: number;
  coveredSpendShare: number | null;
  available: boolean;
  missingFields: string[];
  sourceGenerationHashes: string[];
  mixHash: string;
}

export function buildAdCountrySpendMix(input: {
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  goal: string | null;
  adId: string;
  asOfDate: string;
  reconciliations: readonly CountryAdDayReconciliation[];
  supportPolicy?: CountryCellSupportPolicy;
}): AdCountrySpendMix {
  const supportPolicy =
    input.supportPolicy ?? DEFAULT_COUNTRY_CELL_SUPPORT_POLICY;
  assertSupportPolicy(supportPolicy);
  const startDate = addDays(input.asOfDate, -27);
  const scoped = input.reconciliations.filter(
    (row) =>
      row.businessId === input.businessId &&
      row.providerAccountId === input.providerAccountId &&
      row.currency === input.currency &&
      row.goal === input.goal &&
      row.adId === input.adId &&
      row.date >= startDate &&
      row.date <= input.asOfDate,
  );
  const totalMetaSpend = scoped.reduce(
    (sum, row) => sum + Math.max(0, row.metaSpend ?? 0),
    0,
  );
  let reconciledMetaSpend = 0;
  let rawCountrySpend = 0;
  const countrySpend = new Map<string, number>();
  const generationHashes = new Set<string>();
  for (const row of scoped) {
    if (
      row.status !== "reconciled" ||
      row.metaSpend === null ||
      row.rawCountrySpend === null ||
      row.rawCountrySpend <= 0
    ) {
      continue;
    }
    reconciledMetaSpend += row.metaSpend;
    rawCountrySpend += row.rawCountrySpend;
    const scale = row.metaSpend / row.rawCountrySpend;
    for (const country of row.countrySpend) {
      countrySpend.set(
        country.country,
        (countrySpend.get(country.country) ?? 0) + country.spend * scale,
      );
    }
    for (const hash of row.sourceGenerationHashes) generationHashes.add(hash);
  }
  const countries = Array.from(countrySpend, ([country, spend]) => ({
    country,
    spend,
    spendShare: totalMetaSpend > 0 ? spend / totalMetaSpend : 0,
  })).sort((left, right) => left.country.localeCompare(right.country));
  const coveredSpendShare = ratio(reconciledMetaSpend, totalMetaSpend);
  const missingFields = [
    input.currency === null ? "currency" : null,
    input.goal === null ? "goal" : null,
    totalMetaSpend <= 0 ? "meta_spend_28d" : null,
    coveredSpendShare === null ||
    coveredSpendShare < supportPolicy.minimumMixSpendCoverage
      ? "country_mix_spend_coverage"
      : null,
    countries.length === 0 ? "country_mix" : null,
  ].flatMap((field) => (field === null ? [] : [field]));
  const available = missingFields.length === 0;
  const body = {
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    currency: input.currency,
    goal: input.goal,
    adId: input.adId,
    asOfDate: input.asOfDate,
    windowDays: 28 as const,
    assignedCountry: null,
    countries,
    multiCountry: countries.length > 1,
    totalMetaSpend,
    reconciledMetaSpend,
    rawCountrySpend,
    coveredSpendShare,
    available,
    missingFields,
    sourceGenerationHashes: Array.from(generationHashes).sort(),
  };
  return { ...body, mixHash: countryParentStableHash(body) };
}

export interface CountryCalibrationObservation {
  id: string;
  businessId: string;
  providerAccountId: string;
  currency: string | null;
  goal: string | null;
  adId: string;
  value: number | null;
  ageDays: number | null;
  countryMix: AdCountrySpendMix | null;
}

export interface CountryCalibrationCellResolution {
  country: string;
  targetSpendShare: number;
  sampleSize: number;
  effectiveSampleSize: number | null;
  localEstimate: number | null;
  threshold: number;
  source: "country_cell" | "account_goal_fallback";
  adequateSupport: boolean;
  confidence: CountryCalibrationConfidence;
}

export interface H1CountryThresholdResolution {
  sourceMode: typeof H1_COUNTRY_PARENT_SOURCE_MODE;
  parentMode: H1CountryParentMode;
  value: number | null;
  confidence: CountryCalibrationConfidence;
  accountGoal: {
    value: number | null;
    sampleSize: number;
    effectiveSampleSize: number | null;
    confidence: CountryCalibrationConfidence;
    accountParentEstimate: number | null;
    accountParentSampleSize: number;
    accountParentEffectiveSampleSize: number | null;
    goalEstimate: number | null;
    goalSampleSize: number;
    goalEffectiveSampleSize: number | null;
  };
  countryCells: CountryCalibrationCellResolution[];
  countrySupportedSpendShare: number;
  fallbackSpendShare: number;
  usedCountryConditioning: boolean;
  fallbackReason: string | null;
  resolutionHash: string;
}

const CONFIDENCE_ORDER = [
  "unknown",
  "insufficient",
  "low",
  "medium",
  "high",
] as const satisfies readonly CountryCalibrationConfidence[];

function confidenceFromEffectiveSampleSize(
  value: number | null,
): CountryCalibrationConfidence {
  if (value === null || value <= 0) return "unknown";
  if (value >= 30) return "high";
  if (value >= 20) return "medium";
  if (value >= 8) return "low";
  return "insufficient";
}

export function countryCalibrationConfidenceRank(
  value: CountryCalibrationConfidence,
) {
  return CONFIDENCE_ORDER.indexOf(value);
}

function minimumConfidence(
  left: CountryCalibrationConfidence,
  right: CountryCalibrationConfidence,
) {
  return countryCalibrationConfidenceRank(left) <=
    countryCalibrationConfidenceRank(right)
    ? left
    : right;
}

function weightedObservationRows(input: {
  observations: readonly CountryCalibrationObservation[];
  halfLifeDays: number;
  country?: string;
}) {
  return input.observations.flatMap((observation) => {
    if (
      observation.value === null ||
      observation.value <= 0 ||
      observation.ageDays === null
    ) {
      return [];
    }
    const timeWeight = recencyWeight(observation.ageDays, input.halfLifeDays);
    if (timeWeight === null) return [];
    if (input.country === undefined) {
      return [
        { id: observation.id, value: observation.value, weight: timeWeight },
      ];
    }
    const countryShare = observation.countryMix?.available
      ? (observation.countryMix.countries.find(
          (country) => country.country === input.country,
        )?.spendShare ?? 0)
      : 0;
    return countryShare > 0
      ? [
          {
            id: observation.id,
            value: observation.value,
            weight: timeWeight * countryShare,
          },
        ]
      : [];
  });
}

export function resolveH1CountryParentThreshold(input: {
  observations: readonly CountryCalibrationObservation[];
  target: {
    businessId: string;
    providerAccountId: string;
    currency: string | null;
    goal: string | null;
    countryMix: AdCountrySpendMix | null;
  };
  variant: Pick<
    H1CountryParentVariant,
    "parentMode" | "halfLifeDays" | "kappa" | "quantile"
  >;
  supportPolicy?: CountryCellSupportPolicy;
}): H1CountryThresholdResolution {
  const supportPolicy =
    input.supportPolicy ?? DEFAULT_COUNTRY_CELL_SUPPORT_POLICY;
  assertSupportPolicy(supportPolicy);
  const accountScoped = input.observations.filter(
    (observation) =>
      observation.businessId === input.target.businessId &&
      observation.providerAccountId === input.target.providerAccountId &&
      observation.currency === input.target.currency,
  );
  const goalScoped = accountScoped.filter(
    (observation) => observation.goal === input.target.goal,
  );
  const accountParentRows = weightedObservationRows({
    observations: accountScoped,
    halfLifeDays: input.variant.halfLifeDays,
  });
  const goalRows = weightedObservationRows({
    observations: goalScoped,
    halfLifeDays: input.variant.halfLifeDays,
  });
  const accountParentEffective = effectiveSampleSize(
    accountParentRows.map((row) => row.weight),
  );
  const goalEffective = effectiveSampleSize(goalRows.map((row) => row.weight));
  const accountParentEstimate = weightedQuantile(
    accountParentRows,
    input.variant.quantile,
  );
  const goalEstimate = weightedQuantile(goalRows, input.variant.quantile);
  const accountValue =
    goalEstimate !== null &&
    accountParentEstimate !== null &&
    goalEffective !== null
      ? (shrinkPositiveRatioLogSpace({
          local: goalEstimate,
          parent: accountParentEstimate,
          localEffectiveSampleSize: goalEffective,
          kappa: input.variant.kappa,
        })?.value ?? accountParentEstimate)
      : (goalEstimate ?? accountParentEstimate);
  const accountEffective =
    goalEstimate !== null ? goalEffective : accountParentEffective;
  const accountConfidence = confidenceFromEffectiveSampleSize(accountEffective);
  const accountGoal = {
    value: accountValue,
    sampleSize:
      goalEstimate !== null
        ? new Set(goalRows.map((row) => row.id)).size
        : new Set(accountParentRows.map((row) => row.id)).size,
    effectiveSampleSize: accountEffective,
    confidence: accountConfidence,
    accountParentEstimate,
    accountParentSampleSize: new Set(accountParentRows.map((row) => row.id))
      .size,
    accountParentEffectiveSampleSize: accountParentEffective,
    goalEstimate,
    goalSampleSize: new Set(goalRows.map((row) => row.id)).size,
    goalEffectiveSampleSize: goalEffective,
  };

  const fallback = (reason: string): H1CountryThresholdResolution => {
    const body = {
      sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
      parentMode: input.variant.parentMode,
      value: accountValue,
      confidence: accountConfidence,
      accountGoal,
      countryCells: [] as CountryCalibrationCellResolution[],
      countrySupportedSpendShare: 0,
      fallbackSpendShare: 1,
      usedCountryConditioning: false,
      fallbackReason: reason,
    };
    return { ...body, resolutionHash: countryParentStableHash(body) };
  };

  if (input.variant.parentMode === "account_goal") {
    return fallback("parent_mode_account_goal");
  }
  if (accountValue === null) return fallback("account_goal_unavailable");
  const targetMix = input.target.countryMix;
  if (!targetMix?.available) return fallback("country_mix_unavailable");

  const countryCells: CountryCalibrationCellResolution[] = [];
  const observedCountrySpendShare = Math.min(
    1,
    targetMix.countries.reduce((sum, country) => sum + country.spendShare, 0),
  );
  const uncoveredSpendShare = Math.max(0, 1 - observedCountrySpendShare);
  let supportedSpendShare = 0;
  let confidence = accountConfidence;
  for (const targetCountry of targetMix.countries) {
    const rows = weightedObservationRows({
      observations: goalScoped,
      halfLifeDays: input.variant.halfLifeDays,
      country: targetCountry.country,
    });
    const sampleSize = new Set(rows.map((row) => row.id)).size;
    const effective = effectiveSampleSize(rows.map((row) => row.weight));
    const localEstimate = weightedQuantile(rows, input.variant.quantile);
    const adequateSupport =
      sampleSize >= supportPolicy.minimumSampleSize &&
      effective !== null &&
      effective >= supportPolicy.minimumEffectiveSampleSize &&
      localEstimate !== null;
    const localConfidence = confidenceFromEffectiveSampleSize(effective);
    const threshold = adequateSupport
      ? (shrinkPositiveRatioLogSpace({
          local: localEstimate!,
          parent: accountValue,
          localEffectiveSampleSize: effective!,
          kappa: input.variant.kappa,
        })?.value ?? accountValue)
      : accountValue;
    if (adequateSupport) {
      supportedSpendShare += targetCountry.spendShare;
      confidence = minimumConfidence(confidence, localConfidence);
    }
    countryCells.push({
      country: targetCountry.country,
      targetSpendShare: targetCountry.spendShare,
      sampleSize,
      effectiveSampleSize: effective,
      localEstimate,
      threshold,
      source: adequateSupport ? "country_cell" : "account_goal_fallback",
      adequateSupport,
      confidence: adequateSupport ? localConfidence : accountConfidence,
    });
  }
  const value =
    countryCells.reduce(
      (sum, cell) => sum + cell.targetSpendShare * cell.threshold,
      0,
    ) +
    uncoveredSpendShare * accountValue;
  const fallbackSpendShare = Math.max(0, 1 - supportedSpendShare);
  const body = {
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    parentMode: input.variant.parentMode,
    value,
    confidence,
    accountGoal,
    countryCells,
    countrySupportedSpendShare: supportedSpendShare,
    fallbackSpendShare,
    usedCountryConditioning: supportedSpendShare > 0,
    fallbackReason:
      supportedSpendShare === 0
        ? "country_cells_sparse"
        : fallbackSpendShare > 1e-12
          ? "partial_country_cell_fallback"
          : null,
  };
  return { ...body, resolutionHash: countryParentStableHash(body) };
}

export function prepareH1CountryParentThresholdResolver(input: {
  observations: readonly CountryCalibrationObservation[];
  target: {
    businessId: string;
    providerAccountId: string;
    currency: string | null;
    goal: string | null;
  };
  variant: Pick<H1CountryParentVariant, "halfLifeDays" | "kappa" | "quantile">;
  supportPolicy?: CountryCellSupportPolicy;
}) {
  const accountGoal = resolveH1CountryParentThreshold({
    observations: input.observations,
    target: { ...input.target, countryMix: null },
    variant: { ...input.variant, parentMode: "account_goal" },
    supportPolicy: input.supportPolicy,
  });
  const countryCellCache = new Map<string, CountryCalibrationCellResolution>();
  const resolutionCache = new Map<string, H1CountryThresholdResolution>();

  const fallback = (reason: string): H1CountryThresholdResolution => {
    const body = {
      sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
      parentMode: "account_goal_country_spend_weighted" as const,
      value: accountGoal.value,
      confidence: accountGoal.confidence,
      accountGoal: accountGoal.accountGoal,
      countryCells: [] as CountryCalibrationCellResolution[],
      countrySupportedSpendShare: 0,
      fallbackSpendShare: 1,
      usedCountryConditioning: false,
      fallbackReason: reason,
    };
    return { ...body, resolutionHash: countryParentStableHash(body) };
  };

  const resolveCountryCell = (
    country: string,
    targetMix: AdCountrySpendMix,
  ) => {
    const cached = countryCellCache.get(country);
    if (cached) return cached;
    const singletonMix: AdCountrySpendMix = {
      ...targetMix,
      countries: [{ country, spend: 1, spendShare: 1 }],
      multiCountry: false,
      totalMetaSpend: 1,
      reconciledMetaSpend: 1,
      rawCountrySpend: 1,
      coveredSpendShare: 1,
      available: true,
      missingFields: [],
      mixHash: countryParentStableHash({
        baseMixHash: targetMix.mixHash,
        country,
      }),
    };
    const resolved = resolveH1CountryParentThreshold({
      observations: input.observations,
      target: { ...input.target, countryMix: singletonMix },
      variant: {
        ...input.variant,
        parentMode: "account_goal_country_spend_weighted",
      },
      supportPolicy: input.supportPolicy,
    });
    const cell = resolved.countryCells[0];
    if (!cell) {
      throw new Error(`prepared country cell missing: ${country}`);
    }
    countryCellCache.set(country, cell);
    return cell;
  };

  return {
    resolve(args: {
      parentMode: H1CountryParentMode;
      countryMix: AdCountrySpendMix | null;
    }): H1CountryThresholdResolution {
      if (args.parentMode === "account_goal") return accountGoal;
      const cacheKey = args.countryMix?.mixHash ?? "country_mix_unavailable";
      const cached = resolutionCache.get(cacheKey);
      if (cached) return cached;
      if (accountGoal.value === null) {
        const resolved = fallback("account_goal_unavailable");
        resolutionCache.set(cacheKey, resolved);
        return resolved;
      }
      const targetMix = args.countryMix;
      if (!targetMix?.available) {
        const resolved = fallback("country_mix_unavailable");
        resolutionCache.set(cacheKey, resolved);
        return resolved;
      }

      const observedCountrySpendShare = Math.min(
        1,
        targetMix.countries.reduce(
          (sum, country) => sum + country.spendShare,
          0,
        ),
      );
      const uncoveredSpendShare = Math.max(0, 1 - observedCountrySpendShare);
      let supportedSpendShare = 0;
      let confidence = accountGoal.confidence;
      const countryCells = targetMix.countries.map((targetCountry) => {
        const prepared = resolveCountryCell(targetCountry.country, targetMix);
        if (prepared.adequateSupport) {
          supportedSpendShare += targetCountry.spendShare;
          confidence = minimumConfidence(confidence, prepared.confidence);
        }
        return {
          ...prepared,
          targetSpendShare: targetCountry.spendShare,
        };
      });
      const value =
        countryCells.reduce(
          (sum, cell) => sum + cell.targetSpendShare * cell.threshold,
          0,
        ) +
        uncoveredSpendShare * accountGoal.value;
      const fallbackSpendShare = Math.max(0, 1 - supportedSpendShare);
      const body = {
        sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
        parentMode: "account_goal_country_spend_weighted" as const,
        value,
        confidence,
        accountGoal: accountGoal.accountGoal,
        countryCells,
        countrySupportedSpendShare: supportedSpendShare,
        fallbackSpendShare,
        usedCountryConditioning: supportedSpendShare > 0,
        fallbackReason:
          supportedSpendShare === 0
            ? "country_cells_sparse"
            : fallbackSpendShare > 1e-12
              ? "partial_country_cell_fallback"
              : null,
      };
      const resolved = {
        ...body,
        resolutionHash: countryParentStableHash(body),
      };
      resolutionCache.set(cacheKey, resolved);
      return resolved;
    },
  };
}

export interface H1CountryEvaluationRow {
  key: string;
  businessId: string;
  providerAccountId: string;
  adId: string;
  date: string;
  emitted: boolean;
  outcomeStatus: H1CountryOutcomeStatus;
  cutOpportunity: boolean | null;
  safetyViolation: boolean;
  usedCountryConditioning: boolean;
  fallbackSpendShare: number;
}

export interface H1CountryActionScore {
  cohortRows: number;
  emitted: number;
  known: number;
  supported: number;
  refuted: number;
  neutral: number;
  unknown: number;
  censored: number;
  precision: number | null;
  precisionWilson: ReturnType<typeof wilsonScoreInterval>;
  opportunityKnown: number;
  opportunityPositive: number;
  opportunityCaptured: number;
  recall: number | null;
  recallWilson: ReturnType<typeof wilsonScoreInterval>;
  emittedUnknownRate: number | null;
  emittedCensoredRate: number | null;
  cohortUnknownRate: number | null;
  cohortCensoredRate: number | null;
  safetyViolations: number;
  countryConditionedRows: number;
  fallbackRows: number;
  accountConcentration: {
    emittingAccounts: number;
    topAccountId: string | null;
    topAccountShare: number | null;
    hhi: number | null;
    byAccount: Array<{ accountId: string; emitted: number; share: number }>;
  };
}

export function summarizeH1CountryEvaluations(
  rows: readonly H1CountryEvaluationRow[],
): H1CountryActionScore {
  const emittedRows = rows.filter((row) => row.emitted);
  const countStatus = (status: H1CountryOutcomeStatus, emittedOnly: boolean) =>
    (emittedOnly ? emittedRows : rows).filter(
      (row) => row.outcomeStatus === status,
    ).length;
  const supported = countStatus("supported", true);
  const refuted = countStatus("refuted", true);
  const neutral = countStatus("neutral", true);
  const unknown = countStatus("unknown", true);
  const censored = countStatus("censored", true);
  const known = supported + refuted;
  const opportunityKnown = rows.filter(
    (row) => row.cutOpportunity !== null,
  ).length;
  const opportunityRows = rows.filter((row) => row.cutOpportunity === true);
  const opportunityCaptured = opportunityRows.filter(
    (row) => row.emitted,
  ).length;
  const byAccountMap = new Map<string, number>();
  for (const row of emittedRows) {
    const accountId = `${row.businessId}:${row.providerAccountId}`;
    byAccountMap.set(accountId, (byAccountMap.get(accountId) ?? 0) + 1);
  }
  const byAccount = Array.from(byAccountMap, ([accountId, emitted]) => ({
    accountId,
    emitted,
    share: emittedRows.length > 0 ? emitted / emittedRows.length : 0,
  })).sort(
    (left, right) =>
      right.emitted - left.emitted ||
      left.accountId.localeCompare(right.accountId),
  );
  return {
    cohortRows: rows.length,
    emitted: emittedRows.length,
    known,
    supported,
    refuted,
    neutral,
    unknown,
    censored,
    precision: ratio(supported, known),
    precisionWilson: wilsonScoreInterval(supported, known),
    opportunityKnown,
    opportunityPositive: opportunityRows.length,
    opportunityCaptured,
    recall: ratio(opportunityCaptured, opportunityRows.length),
    recallWilson: wilsonScoreInterval(
      opportunityCaptured,
      opportunityRows.length,
    ),
    emittedUnknownRate: ratio(unknown, emittedRows.length),
    emittedCensoredRate: ratio(censored, emittedRows.length),
    cohortUnknownRate: ratio(countStatus("unknown", false), rows.length),
    cohortCensoredRate: ratio(countStatus("censored", false), rows.length),
    safetyViolations: emittedRows.filter((row) => row.safetyViolation).length,
    countryConditionedRows: rows.filter((row) => row.usedCountryConditioning)
      .length,
    fallbackRows: rows.filter((row) => row.fallbackSpendShare > 1e-12).length,
    accountConcentration: {
      emittingAccounts: byAccount.length,
      topAccountId: byAccount[0]?.accountId ?? null,
      topAccountShare: byAccount[0]?.share ?? null,
      hhi:
        byAccount.length > 0
          ? byAccount.reduce((sum, row) => sum + row.share * row.share, 0)
          : null,
      byAccount,
    },
  };
}

export function comparePairedH1CountryEvaluations(input: {
  accountGoalRows: readonly H1CountryEvaluationRow[];
  countryWeightedRows: readonly H1CountryEvaluationRow[];
}) {
  const baseline = new Map(
    input.accountGoalRows.map((row) => [row.key, row] as const),
  );
  const candidate = new Map(
    input.countryWeightedRows.map((row) => [row.key, row] as const),
  );
  if (
    baseline.size !== input.accountGoalRows.length ||
    candidate.size !== input.countryWeightedRows.length ||
    baseline.size !== candidate.size ||
    [...baseline.keys()].some((key) => !candidate.has(key))
  ) {
    throw new Error(
      "parent modes must be paired on identical unique cohort rows",
    );
  }
  let bothEmit = 0;
  let accountGoalOnly = 0;
  let countryWeightedOnly = 0;
  let neitherEmit = 0;
  let bothCorrect = 0;
  let baselineOnlyCorrect = 0;
  let candidateOnlyCorrect = 0;
  let bothWrong = 0;
  let bothCapture = 0;
  let baselineOnlyCapture = 0;
  let candidateOnlyCapture = 0;
  let neitherCapture = 0;

  for (const [key, left] of baseline) {
    const right = candidate.get(key)!;
    if (
      left.businessId !== right.businessId ||
      left.providerAccountId !== right.providerAccountId ||
      left.adId !== right.adId ||
      left.date !== right.date ||
      left.outcomeStatus !== right.outcomeStatus ||
      left.cutOpportunity !== right.cutOpportunity
    ) {
      throw new Error(`parent modes have non-identical paired outcome: ${key}`);
    }
    if (left.emitted && right.emitted) bothEmit += 1;
    else if (left.emitted) accountGoalOnly += 1;
    else if (right.emitted) countryWeightedOnly += 1;
    else neitherEmit += 1;

    if (
      left.outcomeStatus === "supported" ||
      left.outcomeStatus === "refuted"
    ) {
      const supported = left.outcomeStatus === "supported";
      const leftCorrect = left.emitted === supported;
      const rightCorrect = right.emitted === supported;
      if (leftCorrect && rightCorrect) bothCorrect += 1;
      else if (leftCorrect) baselineOnlyCorrect += 1;
      else if (rightCorrect) candidateOnlyCorrect += 1;
      else bothWrong += 1;
    }
    if (left.cutOpportunity === true) {
      if (left.emitted && right.emitted) bothCapture += 1;
      else if (left.emitted) baselineOnlyCapture += 1;
      else if (right.emitted) candidateOnlyCapture += 1;
      else neitherCapture += 1;
    }
  }
  const accountGoalScore = summarizeH1CountryEvaluations(input.accountGoalRows);
  const countryWeightedScore = summarizeH1CountryEvaluations(
    input.countryWeightedRows,
  );
  return {
    cohortHash: countryParentStableHash([...baseline.keys()].sort()),
    cohortRows: baseline.size,
    transition: {
      bothEmit,
      accountGoalOnly,
      countryWeightedOnly,
      neitherEmit,
    },
    actionCorrectnessMcNemar: pairedMcNemarFromCounts({
      bothCorrect,
      baselineOnlyCorrect,
      candidateOnlyCorrect,
      bothWrong,
    }),
    opportunityCaptureMcNemar: pairedMcNemarFromCounts({
      bothCorrect: bothCapture,
      baselineOnlyCorrect: baselineOnlyCapture,
      candidateOnlyCorrect: candidateOnlyCapture,
      bothWrong: neitherCapture,
    }),
    deltas: {
      emitted: countryWeightedScore.emitted - accountGoalScore.emitted,
      supported: countryWeightedScore.supported - accountGoalScore.supported,
      refuted: countryWeightedScore.refuted - accountGoalScore.refuted,
      precision:
        countryWeightedScore.precision !== null &&
        accountGoalScore.precision !== null
          ? countryWeightedScore.precision - accountGoalScore.precision
          : null,
      recall:
        countryWeightedScore.recall !== null && accountGoalScore.recall !== null
          ? countryWeightedScore.recall - accountGoalScore.recall
          : null,
      safetyViolations:
        countryWeightedScore.safetyViolations -
        accountGoalScore.safetyViolations,
      unknown: countryWeightedScore.unknown - accountGoalScore.unknown,
      censored: countryWeightedScore.censored - accountGoalScore.censored,
    },
  };
}
