#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  FEATURE_WINDOW_DAYS,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  type CampaignFeatures,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolution,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  addDaysUtc,
  buildCampaignContextFeatures,
  computeCampaignLineage,
  type CampaignMetaRow,
  type CreativeDayRow,
} from "@/lib/creative-decision-engine/campaign-context/data";
import {
  applyDailyHysteresis,
  type HysteresisState,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import { clusteredMovingBlockBootstrap } from "@/lib/creative-decision-engine/simulation/clustered-moving-block-bootstrap";
import { assignRollingOriginFold } from "@/lib/creative-decision-engine/simulation/evaluation-folds";
import {
  H11_CAMPAIGN_CONTEXT_CONTRACT_VERSION,
  H11_CONTEXT_POLICIES,
  H11_H1_END_TO_END_SENSITIVITY,
  cyclicAccountLabelPlacebo,
  evaluateH11Acceptance,
  h11H1CalibrationParent,
  selectH11PolicyOnCalibration,
  summarizeH11Evaluation,
  type H11PolicyId,
  type H11ScoredObservation,
} from "@/lib/creative-decision-engine/simulation/h11-campaign-context-challenger";
import {
  H1_QUANTILES,
  H1_RECENCY_HALF_LIFE_DAYS,
  H1_SHRINKAGE_KAPPA,
} from "@/lib/creative-decision-engine/simulation/hierarchical-calibration";
import { summarizeLeaveOneBusinessOutMetric } from "@/lib/creative-decision-engine/simulation/leave-one-business-out";
import { pairedMcNemar } from "@/lib/creative-decision-engine/simulation/paired-binary-inference";
import { stableConfigHash } from "@/lib/creative-decision-engine/simulation/stable-config";

const START_DATE = "2025-12-01";
const END_DATE = "2026-07-05";
const LINEAGE_SOURCE_WINDOW_DAYS = 56;
const SOURCE_START_DATE = addDaysUtc(
  START_DATE,
  -(LINEAGE_SOURCE_WINDOW_DAYS - 1),
);
const JSON_OUT =
  "docs/creative-decision-center/generated/h11-campaign-context-challenger-2025-12-01-to-2026-07-05.json";
const MD_OUT =
  "docs/creative-decision-center/H11_CAMPAIGN_CONTEXT_CHALLENGER_2025-12-01_TO_2026-07-05.md";
const BOOTSTRAP_ITERATIONS = 10_000;
const PLACEBO_ITERATIONS = 999;
const MAX_FLIP_RATE_INCREASE_PER_100_DAYS = 0.1;
const SCRIPT_PATH =
  "scripts/creative-decision-center/h11-campaign-context-challenger.ts";
const MODULE_PATH =
  "lib/creative-decision-engine/simulation/h11-campaign-context-challenger.ts";

type Row = Record<string, unknown>;
type ScopeMode = "account_isolated" | "business_pooled_sensitivity";

export interface H11CreativeSourceRow extends CreativeDayRow {
  businessId: string;
  businessName: string;
  accountId: string;
}

export interface H11CampaignNameSourceRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  date: string;
  campaignName: string | null;
}

export interface H11CampaignFirstSeenSourceRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  firstSeenDate: string;
}

interface H11ManualLabelRow {
  businessId: string;
  accountId: string | null;
  campaignId: string;
  campaignKind: CampaignKind;
  labeledAtDate: string | null;
  updatedAtDate: string | null;
  source: string | null;
}

interface H11InputData {
  creativeRows: H11CreativeSourceRow[];
  campaignNameRows: H11CampaignNameSourceRow[];
  campaignFirstSeenRows: H11CampaignFirstSeenSourceRow[];
  labels: H11ManualLabelRow[];
}

export interface H11FeatureEnvelope {
  feature: CampaignFeatures;
  accountId: string | null;
}

export interface H11PointInTimeFeatureResult {
  features: H11FeatureEnvelope[];
  sourceRowsUsed: number;
  futureRowsIgnored: number;
  historicalNameCount: number;
  accountCollisionCampaignIds: string[];
}

export interface H11DailyResult {
  id: string;
  scopeMode: ScopeMode;
  policyId: H11PolicyId;
  foldId: string;
  foldRole: "fit" | "select" | "evaluate";
  businessId: string;
  businessName: string;
  accountId: string;
  campaignId: string;
  campaignName: string | null;
  date: string;
  manualKind: CampaignKind | null;
  manualLabelAvailableAtDecision: boolean | null;
  baseKind: CampaignKind | null;
  effectiveKind: CampaignKind | null;
  publishedKind: CampaignKind | null;
  baseClass: ContextConfidenceClass;
  publishedClass: ContextConfidenceClass;
  confidenceScore: number;
  inherited: boolean;
  suppressedFlip: boolean;
  invariantViolations: string[];
}

const H1_VARIANT_COUNT =
  H1_RECENCY_HALF_LIFE_DAYS.length *
  H1_SHRINKAGE_KAPPA.length *
  H1_QUANTILES.length;

interface ResolvedLabelIndex {
  byKey: Map<string, H11ManualLabelRow>;
  totalRows: number;
  exactAccountRows: number;
  inferredAccountRows: number;
  unresolvedAccountRows: number;
  duplicateKeyRows: number;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value !== null && value !== undefined && String(value).trim()) {
    return String(value).trim();
  }
  throw new Error(`${field} is missing`);
}

function optionalText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function calendarDate(value: unknown, field: string): string {
  const normalized = normalizePostgresDate(value);
  if (!normalized)
    throw new Error(`${field} is not a PostgreSQL calendar date`);
  return normalized;
}

function optionalTimestampDate(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  const date = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = addDaysUtc(cursor, 1);
  }
  return dates;
}

function groupBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function sourceIdentity(
  businessId: string,
  accountId: string,
  campaignId: string,
): string {
  return `${businessId}:${accountId}:${campaignId}`;
}

function manualLabelKey(
  businessId: string,
  accountId: string,
  campaignId: string,
): string {
  return sourceIdentity(businessId, accountId, campaignId);
}

function stableHashRows<T>(rows: readonly T[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function fileHash(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(path)))
    .digest("hex");
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function latestNameAsOf(
  rows: readonly H11CampaignNameSourceRow[],
  asOf: string,
): string | null {
  let latest: H11CampaignNameSourceRow | null = null;
  for (const row of rows) {
    if (row.date > asOf) continue;
    if (latest === null || row.date > latest.date) latest = row;
  }
  return latest?.campaignName ?? null;
}

/**
 * Builds exactly one cutoff-safe feature set. Future source rows and future
 * metadata are ignored by construction; tests append future rows to prove it.
 */
export function buildH11PointInTimeFeatures(input: {
  creativeRows: readonly H11CreativeSourceRow[];
  campaignNameRows: readonly H11CampaignNameSourceRow[];
  campaignFirstSeenRows: readonly H11CampaignFirstSeenSourceRow[];
  asOf: string;
}): H11PointInTimeFeatureResult {
  const sourceStart = addDaysUtc(input.asOf, -(LINEAGE_SOURCE_WINDOW_DAYS - 1));
  const eligible = input.creativeRows.filter(
    (row) => row.date >= sourceStart && row.date <= input.asOf,
  );
  const futureRowsIgnored = input.creativeRows.filter(
    (row) => row.date > input.asOf,
  ).length;
  const accountsByCampaign = new Map<string, Set<string>>();
  for (const row of eligible) {
    const accounts =
      accountsByCampaign.get(row.campaignId) ?? new Set<string>();
    accounts.add(row.accountId);
    accountsByCampaign.set(row.campaignId, accounts);
  }

  const namesByIdentity = groupBy(input.campaignNameRows, (row) =>
    sourceIdentity(row.businessId, row.accountId, row.campaignId),
  );
  const firstSeenByIdentity = new Map(
    input.campaignFirstSeenRows.map((row) => [
      sourceIdentity(row.businessId, row.accountId, row.campaignId),
      row.firstSeenDate,
    ]),
  );
  const meta = new Map<string, CampaignMetaRow>();
  let historicalNameCount = 0;
  const collisions: string[] = [];
  for (const [campaignId, accountIds] of accountsByCampaign) {
    if (accountIds.size !== 1) {
      collisions.push(campaignId);
      continue;
    }
    const accountId = [...accountIds][0];
    const businessId = eligible.find(
      (row) => row.campaignId === campaignId && row.accountId === accountId,
    )?.businessId;
    if (!businessId) continue;
    const identity = sourceIdentity(businessId, accountId, campaignId);
    const campaignName = latestNameAsOf(
      namesByIdentity.get(identity) ?? [],
      input.asOf,
    );
    if (campaignName !== null) historicalNameCount += 1;
    const firstSeen = firstSeenByIdentity.get(identity) ?? null;
    meta.set(campaignId, {
      campaignId,
      campaignName,
      firstSeenDate:
        firstSeen !== null && firstSeen <= input.asOf ? firstSeen : null,
    });
  }

  const lineage = computeCampaignLineage(eligible);
  const features = buildCampaignContextFeatures({
    rows: eligible,
    meta,
    lineage,
    asOf: input.asOf,
  })
    .filter((feature) => !collisions.includes(feature.campaignId))
    .map((feature) => ({
      feature,
      accountId:
        [...(accountsByCampaign.get(feature.campaignId) ?? [])][0] ?? null,
    }));

  return {
    features,
    sourceRowsUsed: eligible.length,
    futureRowsIgnored,
    historicalNameCount,
    accountCollisionCampaignIds: collisions.sort(),
  };
}

async function readInputData(): Promise<H11InputData> {
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] =
    await Promise.all([
      import("@/lib/db"),
      import("@/scripts/_operational-runtime"),
    ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  process.env.DB_QUERY_TIMEOUT_MS = "180000";

  try {
    return await operational.withOperationalStartupLogsSilenced(async () =>
      runDbTransaction(
        async () => {
          const db = getDb();
          await db.query("SET TRANSACTION READ ONLY");
          const readOnly = await db.query<{ transaction_read_only: string }>(
            "SHOW transaction_read_only",
          );
          if (readOnly[0]?.transaction_read_only !== "on") {
            throw new Error(
              "H11 replay refuses to run outside a read-only transaction",
            );
          }

          const creativeRows = await db.query<Row>(
            `
            WITH first_spend AS (
              SELECT
                COALESCE(business_ref_id::text, business_id) AS business_id,
                provider_account_id,
                creative_id,
                MIN(date) AS first_spend_date
              FROM meta_creative_daily
              WHERE date <= $2::date
                AND spend > 0
                AND provider_account_id IS NOT NULL
                AND creative_id IS NOT NULL
              GROUP BY 1, 2, 3
            )
            SELECT
              COALESCE(d.business_ref_id::text, d.business_id) AS business_id,
              b.name AS business_name,
              d.provider_account_id,
              d.campaign_id,
              d.adset_id,
              d.creative_id,
              d.date::text AS date,
              d.spend,
              fs.first_spend_date::text AS first_spend_date
            FROM meta_creative_daily d
            JOIN businesses b
              ON b.id::text = COALESCE(d.business_ref_id::text, d.business_id)
            JOIN first_spend fs
              ON fs.business_id = COALESCE(d.business_ref_id::text, d.business_id)
             AND fs.provider_account_id = d.provider_account_id
             AND fs.creative_id = d.creative_id
            WHERE d.date BETWEEN $1::date AND $2::date
              AND d.spend > 0
              AND d.provider_account_id IS NOT NULL
              AND d.campaign_id IS NOT NULL
              AND d.creative_id IS NOT NULL
            ORDER BY 1, 3, 7, 4, 6
            `,
            [SOURCE_START_DATE, END_DATE],
          );

          const campaignNameRows = await db.query<Row>(
            `
            WITH timeline AS (
              SELECT
                COALESCE(business_ref_id::text, business_id) AS business_id,
                provider_account_id,
                campaign_id,
                date,
                campaign_name_historical,
                LAG(campaign_name_historical) OVER (
                  PARTITION BY COALESCE(business_ref_id::text, business_id),
                               provider_account_id, campaign_id
                  ORDER BY date
                ) AS previous_name,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(business_ref_id::text, business_id),
                               provider_account_id, campaign_id
                  ORDER BY date
                ) AS sequence_number
              FROM meta_campaign_daily
              WHERE date <= $1::date
                AND provider_account_id IS NOT NULL
                AND campaign_id IS NOT NULL
            )
            SELECT
              business_id,
              provider_account_id,
              campaign_id,
              date::text AS date,
              campaign_name_historical
            FROM timeline
            WHERE sequence_number = 1
               OR campaign_name_historical IS DISTINCT FROM previous_name
            ORDER BY business_id, provider_account_id, campaign_id, date
            `,
            [END_DATE],
          );

          const campaignFirstSeenRows = await db.query<Row>(
            `
            SELECT
              COALESCE(business_ref_id::text, business_id) AS business_id,
              provider_account_id,
              campaign_id,
              MIN(date)::text AS first_seen_date
            FROM meta_campaign_daily
            WHERE date <= $1::date
              AND provider_account_id IS NOT NULL
              AND campaign_id IS NOT NULL
            GROUP BY 1, 2, 3
            ORDER BY 1, 2, 3
            `,
            [END_DATE],
          );

          const labels = await db.query<Row>(
            `
            SELECT
              business_id,
              provider_account_id,
              campaign_id,
              campaign_kind,
              labeled_at::text AS labeled_at,
              updated_at::text AS updated_at,
              source
            FROM meta_campaign_labels
            WHERE campaign_kind IN ('main', 'test', 'mixed')
            ORDER BY business_id, provider_account_id NULLS LAST, campaign_id
            `,
          );

          return {
            creativeRows: creativeRows.map((row) => ({
              businessId: requiredText(row.business_id, "creative.business_id"),
              businessName: requiredText(
                row.business_name,
                "creative.business_name",
              ),
              accountId: requiredText(
                row.provider_account_id,
                "creative.provider_account_id",
              ),
              campaignId: requiredText(row.campaign_id, "creative.campaign_id"),
              adsetId: optionalText(row.adset_id),
              creativeId: requiredText(row.creative_id, "creative.creative_id"),
              date: calendarDate(row.date, "creative.date"),
              spend: numeric(row.spend),
              firstSpendDate: calendarDate(
                row.first_spend_date,
                "creative.first_spend_date",
              ),
            })),
            campaignNameRows: campaignNameRows.map((row) => ({
              businessId: requiredText(row.business_id, "name.business_id"),
              accountId: requiredText(
                row.provider_account_id,
                "name.provider_account_id",
              ),
              campaignId: requiredText(row.campaign_id, "name.campaign_id"),
              date: calendarDate(row.date, "name.date"),
              campaignName: optionalText(row.campaign_name_historical),
            })),
            campaignFirstSeenRows: campaignFirstSeenRows.map((row) => ({
              businessId: requiredText(
                row.business_id,
                "first_seen.business_id",
              ),
              accountId: requiredText(
                row.provider_account_id,
                "first_seen.provider_account_id",
              ),
              campaignId: requiredText(
                row.campaign_id,
                "first_seen.campaign_id",
              ),
              firstSeenDate: calendarDate(
                row.first_seen_date,
                "first_seen.first_seen_date",
              ),
            })),
            labels: labels.map((row) => ({
              businessId: requiredText(row.business_id, "label.business_id"),
              accountId: optionalText(row.provider_account_id),
              campaignId: requiredText(row.campaign_id, "label.campaign_id"),
              campaignKind: requiredText(
                row.campaign_kind,
                "label.campaign_kind",
              ) as CampaignKind,
              labeledAtDate: optionalTimestampDate(row.labeled_at),
              updatedAtDate: optionalTimestampDate(row.updated_at),
              source: optionalText(row.source),
            })),
          } satisfies H11InputData;
        },
        { timeoutMs: 180_000 },
      ),
    );
  } finally {
    resetDbClientCache();
  }
}

function resolveLabelIndex(data: H11InputData): ResolvedLabelIndex {
  const accountsByCampaign = groupBy(
    data.creativeRows,
    (row) => `${row.businessId}:${row.campaignId}`,
  );
  const byKey = new Map<string, H11ManualLabelRow>();
  let exactAccountRows = 0;
  let inferredAccountRows = 0;
  let unresolvedAccountRows = 0;
  let duplicateKeyRows = 0;

  for (const label of data.labels) {
    let accountId = label.accountId;
    if (accountId) {
      exactAccountRows += 1;
    } else {
      const accounts = new Set(
        (
          accountsByCampaign.get(`${label.businessId}:${label.campaignId}`) ??
          []
        ).map((row) => row.accountId),
      );
      if (accounts.size === 1) {
        accountId = [...accounts][0];
        inferredAccountRows += 1;
      } else {
        unresolvedAccountRows += 1;
        continue;
      }
    }
    const key = manualLabelKey(label.businessId, accountId, label.campaignId);
    if (byKey.has(key)) duplicateKeyRows += 1;
    byKey.set(key, { ...label, accountId });
  }

  return {
    byKey,
    totalRows: data.labels.length,
    exactAccountRows,
    inferredAccountRows,
    unresolvedAccountRows,
    duplicateKeyRows,
  };
}

function effectiveResolutions(
  features: readonly H11FeatureEnvelope[],
  policyId: H11PolicyId,
): Map<
  string,
  { resolution: ContextResolution; inheritedKind: CampaignKind | null }
> {
  const policy = H11_CONTEXT_POLICIES.find((item) => item.id === policyId);
  if (!policy) throw new Error(`unknown H11 policy ${policyId}`);
  const resolutions = new Map<string, ContextResolution>();
  for (const { feature } of features) {
    resolutions.set(
      feature.campaignId,
      classifyCampaignContext(feature, policy.config, {
        includeLineage: policy.includeLineage,
      }),
    );
  }
  const inheritance = computeFamilyInheritance(
    [...resolutions.values()].map((resolution) => ({
      campaignId: resolution.campaignId,
      familyKey: campaignFamilyKey(resolution.campaignName),
      kind: resolution.kind,
      confidenceClass: resolution.confidenceClass,
    })),
  );
  const inheritedById = new Map(
    inheritance.map((item) => [item.campaignId, item.inheritedKind]),
  );
  return new Map(
    [...resolutions.entries()].map(([campaignId, resolution]) => [
      campaignId,
      {
        resolution,
        inheritedKind: inheritedById.get(campaignId) ?? null,
      },
    ]),
  );
}

function invariantViolations(input: {
  resolution: ContextResolution;
  inheritedKind: CampaignKind | null;
  publishedKind: CampaignKind | null;
  publishedClass: ContextConfidenceClass;
  accountCollision: boolean;
}): string[] {
  const violations: string[] = [];
  if (
    input.resolution.kind === "test" &&
    input.resolution.confidenceClass === "high" &&
    !input.resolution.agreeingFamilies.includes("behavioral")
  ) {
    violations.push("high_test_without_behavioral_agreement");
  }
  if (input.inheritedKind === "test") {
    violations.push("test_kind_inherited");
  }
  if (input.publishedKind === null && input.publishedClass === "high") {
    violations.push("high_confidence_null_kind");
  }
  if (input.accountCollision) {
    violations.push("campaign_id_cross_account_collision");
  }
  return violations;
}

function replayMode(input: {
  data: H11InputData;
  labels: ResolvedLabelIndex;
  scopeMode: ScopeMode;
}): H11DailyResult[] {
  const accountScoped = input.scopeMode === "account_isolated";
  const scopeKey = (row: H11CreativeSourceRow) =>
    accountScoped ? `${row.businessId}:${row.accountId}` : row.businessId;
  const creativeScopes = groupBy(input.data.creativeRows, scopeKey);
  const nameScopes = groupBy(input.data.campaignNameRows, (row) =>
    accountScoped ? `${row.businessId}:${row.accountId}` : row.businessId,
  );
  const firstSeenScopes = groupBy(input.data.campaignFirstSeenRows, (row) =>
    accountScoped ? `${row.businessId}:${row.accountId}` : row.businessId,
  );
  const hysteresis = new Map<string, HysteresisState>();
  const results: H11DailyResult[] = [];

  for (const date of enumerateDates(START_DATE, END_DATE)) {
    const fold = assignRollingOriginFold({
      decisionDate: date,
      outcomeWindowDays: 0,
      outcomesObservedThrough: END_DATE,
    });
    if (!fold.eligible || !fold.foldId || !fold.role) continue;

    for (const [scope, creativeRows] of creativeScopes) {
      const pit = buildH11PointInTimeFeatures({
        creativeRows,
        campaignNameRows: nameScopes.get(scope) ?? [],
        campaignFirstSeenRows: firstSeenScopes.get(scope) ?? [],
        asOf: date,
      });
      if (pit.features.length === 0) continue;
      const collisionSet = new Set(pit.accountCollisionCampaignIds);

      for (const policy of H11_CONTEXT_POLICIES) {
        const resolutions = effectiveResolutions(pit.features, policy.id);
        for (const envelope of pit.features) {
          const accountId = envelope.accountId;
          if (!accountId) continue;
          const feature = envelope.feature;
          const evaluated = resolutions.get(feature.campaignId);
          if (!evaluated) continue;
          const effectiveKind =
            evaluated.inheritedKind ?? evaluated.resolution.kind;
          const effectiveClass: ContextConfidenceClass =
            evaluated.inheritedKind === null
              ? evaluated.resolution.confidenceClass
              : "medium";
          const stateKey = `${input.scopeMode}:${policy.id}:${scope}:${feature.campaignId}`;
          const outcome = applyDailyHysteresis(
            hysteresis.get(stateKey) ?? null,
            effectiveKind,
            effectiveClass,
          );
          hysteresis.set(stateKey, outcome.state);
          const label = input.labels.byKey.get(
            manualLabelKey(
              creativeRows[0].businessId,
              accountId,
              feature.campaignId,
            ),
          );
          const violations = invariantViolations({
            resolution: evaluated.resolution,
            inheritedKind: evaluated.inheritedKind,
            publishedKind: outcome.publishedKind,
            publishedClass: outcome.publishedClass,
            accountCollision: collisionSet.has(feature.campaignId),
          });
          const businessId = creativeRows[0].businessId;
          results.push({
            id: `${input.scopeMode}:${policy.id}:${businessId}:${accountId}:${feature.campaignId}:${date}`,
            scopeMode: input.scopeMode,
            policyId: policy.id,
            foldId: fold.foldId,
            foldRole: fold.role,
            businessId,
            businessName: creativeRows[0].businessName,
            accountId,
            campaignId: feature.campaignId,
            campaignName: feature.campaignName,
            date,
            manualKind: label?.campaignKind ?? null,
            manualLabelAvailableAtDecision:
              label?.labeledAtDate === null || label === undefined
                ? label === undefined
                  ? null
                  : false
                : label.labeledAtDate <= date,
            baseKind: evaluated.resolution.kind,
            effectiveKind,
            publishedKind: outcome.publishedKind,
            baseClass: evaluated.resolution.confidenceClass,
            publishedClass: outcome.publishedClass,
            confidenceScore: evaluated.resolution.confidenceScore,
            inherited: evaluated.inheritedKind !== null,
            suppressedFlip: outcome.suppressedFlip,
            invariantViolations: violations,
          });
        }
      }
    }
  }

  return results.sort(
    (left, right) =>
      left.policyId.localeCompare(right.policyId) ||
      left.businessId.localeCompare(right.businessId) ||
      left.accountId.localeCompare(right.accountId) ||
      left.campaignId.localeCompare(right.campaignId) ||
      left.date.localeCompare(right.date),
  );
}

function h11H1RowKey(row: H11DailyResult) {
  return `${row.scopeMode}:${row.businessId}:${row.accountId}:${row.campaignId}:${row.date}`;
}

export function summarizeH11H1EndToEndSensitivity(input: {
  rows: readonly H11DailyResult[];
  baselinePolicyId: H11PolicyId;
}) {
  const baselineParentByKey = new Map(
    input.rows
      .filter((row) => row.policyId === input.baselinePolicyId)
      .map((row) => [
        h11H1RowKey(row),
        h11H1CalibrationParent({
          publishedKind: row.publishedKind,
          publishedClass: row.publishedClass,
        }),
      ]),
  );
  const byPolicy = H11_CONTEXT_POLICIES.map((policy) => {
    const rows = input.rows.filter((row) => row.policyId === policy.id);
    let authorityViolations = 0;
    let changedParentVsBaseline = 0;
    const parentCounts = { all: 0, main: 0, test: 0, mixed: 0 };
    for (const row of rows) {
      const parent = h11H1CalibrationParent({
        publishedKind: row.publishedKind,
        publishedClass: row.publishedClass,
      });
      parentCounts[parent] += 1;
      if (
        parent !== "all" &&
        (row.publishedClass !== "high" || row.publishedKind === null)
      ) {
        authorityViolations += 1;
      }
      const baselineParent = baselineParentByKey.get(h11H1RowKey(row));
      if (baselineParent !== undefined && baselineParent !== parent) {
        changedParentVsBaseline += 1;
      }
    }
    return {
      policyId: policy.id,
      rows: rows.length,
      h1VariantsPerRow: H1_VARIANT_COUNT,
      evaluatedCrossCells: rows.length * H1_VARIANT_COUNT,
      kindSpecificAuthorityRows:
        parentCounts.main + parentCounts.test + parentCounts.mixed,
      accountAllFallbackRows: parentCounts.all,
      parentCounts,
      changedParentVsBaseline,
      authorityViolations,
    };
  });
  return {
    contract: H11_H1_END_TO_END_SENSITIVITY,
    h11Policies: H11_CONTEXT_POLICIES.length,
    h1Variants: H1_VARIANT_COUNT,
    predeclaredMatrixCells: H11_CONTEXT_POLICIES.length * H1_VARIANT_COUNT,
    interpretation:
      "End-to-end sensitivity changes the H1 calibration parent only. High, non-null published context may select a kind parent; every other context deterministically falls back to account-all and cannot gain authority.",
    byPolicy,
  };
}

function scored(row: H11DailyResult): H11ScoredObservation {
  return {
    id: `${row.businessId}:${row.accountId}:${row.campaignId}:${row.date}`,
    businessId: row.businessId,
    accountId: row.accountId,
    campaignId: row.campaignId,
    date: row.date,
    manualKind: row.manualKind,
    predictedKind: row.publishedKind,
    confidenceClass: row.publishedClass,
  };
}

function foldAnchors(
  rows: readonly H11DailyResult[],
  policyId: H11PolicyId,
  foldId: string,
): H11DailyResult[] {
  const latest = new Map<string, H11DailyResult>();
  for (const row of rows) {
    if (row.policyId !== policyId || row.foldId !== foldId) continue;
    const key = sourceIdentity(row.businessId, row.accountId, row.campaignId);
    const previous = latest.get(key);
    if (!previous || row.date > previous.date) latest.set(key, row);
  }
  return [...latest.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

interface StabilitySummary {
  campaignDays: number;
  campaignTransitions: number;
  rawFlips: number;
  publishedFlips: number;
  rawFlipRatePer100Days: number | null;
  publishedFlipRatePer100Days: number | null;
  suppressedDays: number;
  unresolvedDays: number;
  unresolvedRate: number | null;
  conflictDays: number;
  collapsedAccountCount: number;
  collapsedAccounts: string[];
  invariantViolationCount: number;
  invariantViolationExamples: Array<{
    business: string;
    accountId: string;
    campaignId: string;
    date: string;
    violations: string[];
  }>;
}

function summarizeStability(rows: readonly H11DailyResult[]): StabilitySummary {
  const byCampaign = groupBy(rows, (row) =>
    sourceIdentity(row.businessId, row.accountId, row.campaignId),
  );
  let rawFlips = 0;
  let publishedFlips = 0;
  let campaignTransitions = 0;
  for (const campaignRows of byCampaign.values()) {
    const sorted = [...campaignRows].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      campaignTransitions += 1;
      if (sorted[index].effectiveKind !== sorted[index - 1].effectiveKind) {
        rawFlips += 1;
      }
      if (sorted[index].publishedKind !== sorted[index - 1].publishedKind) {
        publishedFlips += 1;
      }
    }
  }

  const byAccount = groupBy(
    rows,
    (row) => `${row.businessName}:${row.accountId}`,
  );
  const collapsedAccounts = [...byAccount.entries()]
    .filter(([, accountRows]) => {
      const campaigns = new Set(accountRows.map((row) => row.campaignId)).size;
      const unresolved = accountRows.filter(
        (row) => row.publishedKind === null,
      ).length;
      return (
        accountRows.length >= 30 &&
        campaigns >= 3 &&
        unresolved / accountRows.length > 0.9
      );
    })
    .map(([key]) => key)
    .sort();
  const violations = rows.filter((row) => row.invariantViolations.length > 0);

  return {
    campaignDays: rows.length,
    campaignTransitions,
    rawFlips,
    publishedFlips,
    rawFlipRatePer100Days:
      campaignTransitions > 0 ? (rawFlips / campaignTransitions) * 100 : null,
    publishedFlipRatePer100Days:
      campaignTransitions > 0
        ? (publishedFlips / campaignTransitions) * 100
        : null,
    suppressedDays: rows.filter((row) => row.suppressedFlip).length,
    unresolvedDays: rows.filter((row) => row.publishedKind === null).length,
    unresolvedRate: ratio(
      rows.filter((row) => row.publishedKind === null).length,
      rows.length,
    ),
    conflictDays: rows.filter((row) => row.baseClass === "conflict").length,
    collapsedAccountCount: collapsedAccounts.length,
    collapsedAccounts,
    invariantViolationCount: violations.reduce(
      (sum, row) => sum + row.invariantViolations.length,
      0,
    ),
    invariantViolationExamples: violations.slice(0, 20).map((row) => ({
      business: row.businessName,
      accountId: row.accountId,
      campaignId: row.campaignId,
      date: row.date,
      violations: row.invariantViolations,
    })),
  };
}

interface PairedRow {
  id: string;
  businessId: string;
  accountId: string;
  campaignId: string;
  date: string;
  baselineCorrect: boolean;
  candidateCorrect: boolean;
}

function pairedRows(
  baseline: readonly H11DailyResult[],
  candidate: readonly H11DailyResult[],
): PairedRow[] {
  const baselineById = new Map(
    baseline
      .filter((row) => row.manualKind !== null)
      .map((row) => [
        `${row.businessId}:${row.accountId}:${row.campaignId}:${row.date}`,
        row,
      ]),
  );
  const pairs: PairedRow[] = [];
  for (const row of candidate) {
    if (row.manualKind === null) continue;
    const id = `${row.businessId}:${row.accountId}:${row.campaignId}:${row.date}`;
    const base = baselineById.get(id);
    if (!base || base.manualKind !== row.manualKind) continue;
    pairs.push({
      id,
      businessId: row.businessId,
      accountId: row.accountId,
      campaignId: row.campaignId,
      date: row.date,
      baselineCorrect: base.publishedKind === base.manualKind,
      candidateCorrect: row.publishedKind === row.manualKind,
    });
  }
  return pairs.sort((left, right) => left.id.localeCompare(right.id));
}

function bootstrapAccuracyDelta(pairs: readonly PairedRow[], seed: string) {
  if (pairs.length === 0) return null;
  if (pairs.every((row) => row.baselineCorrect === row.candidateCorrect)) {
    return {
      seed,
      iterations: BOOTSTRAP_ITERATIONS,
      validIterations: BOOTSTRAP_ITERATIONS,
      invalidIterations: 0,
      blockLengthDays: 7,
      confidenceLevel: 0.95,
      businessCount: new Set(pairs.map((row) => row.businessId)).size,
      entityCount: new Set(
        pairs.map((row) => `${row.accountId}:${row.campaignId}`),
      ).size,
      observationCount: pairs.length,
      pointEstimate: 0,
      standardError: 0,
      lower: 0,
      median: 0,
      upper: 0,
    };
  }
  const result = clusteredMovingBlockBootstrap(pairs, {
    getBusinessId: (row) => row.businessId,
    getEntityId: (row) => `${row.accountId}:${row.campaignId}`,
    getDate: (row) => row.date,
    statistic: (sample) =>
      sample.length === 0
        ? null
        : sample.reduce(
            (sum, item) =>
              sum +
              (item.observation.candidateCorrect ? 1 : 0) -
              (item.observation.baselineCorrect ? 1 : 0),
            0,
          ) / sample.length,
    seed,
    iterations: BOOTSTRAP_ITERATIONS,
    blockLengthDays: 7,
  });
  const { estimates: _estimates, ...summary } = result;
  return summary;
}

function pairedEvidence(
  anchors: readonly H11DailyResult[],
  baselineAnchors: readonly H11DailyResult[],
  daily: readonly H11DailyResult[],
  baselineDaily: readonly H11DailyResult[],
  seed: string,
) {
  const anchorPairs = pairedRows(baselineAnchors, anchors);
  const dailyPairs = pairedRows(baselineDaily, daily);
  const mcnemar = pairedMcNemar(
    anchorPairs.map((row) => ({
      id: row.id,
      baselineCorrect: row.baselineCorrect,
      candidateCorrect: row.candidateCorrect,
    })),
  );
  const leaveOneBusinessOut =
    anchorPairs.length === 0
      ? null
      : summarizeLeaveOneBusinessOutMetric(anchorPairs, {
          getBusinessId: (row) => row.businessId,
          getValue: (row) =>
            (row.candidateCorrect ? 1 : 0) - (row.baselineCorrect ? 1 : 0),
        });
  const leaveOneAccountOut =
    anchorPairs.length === 0
      ? null
      : summarizeLeaveOneBusinessOutMetric(anchorPairs, {
          getBusinessId: (row) => `${row.businessId}:${row.accountId}`,
          getValue: (row) =>
            (row.candidateCorrect ? 1 : 0) - (row.baselineCorrect ? 1 : 0),
        });
  return {
    anchorPairCount: anchorPairs.length,
    dailyPairCount: dailyPairs.length,
    mcnemar,
    bootstrapAccuracyDelta: bootstrapAccuracyDelta(dailyPairs, seed),
    leaveOneBusinessOut,
    leaveOneAccountOut,
  };
}

function sourceModeSensitivity(
  accountRows: readonly H11DailyResult[],
  pooledRows: readonly H11DailyResult[],
) {
  const accountByKey = new Map(
    accountRows.map((row) => [
      `${row.policyId}:${row.businessId}:${row.accountId}:${row.campaignId}:${row.date}`,
      row,
    ]),
  );
  let matched = 0;
  let kindDivergence = 0;
  let classDivergence = 0;
  let highTestDivergence = 0;
  const examples: Row[] = [];
  const byPolicy = new Map<
    H11PolicyId,
    {
      matchedCampaignDays: number;
      kindDivergence: number;
      classDivergence: number;
      highTestDivergence: number;
    }
  >();
  for (const pooled of pooledRows) {
    const key = `${pooled.policyId}:${pooled.businessId}:${pooled.accountId}:${pooled.campaignId}:${pooled.date}`;
    const account = accountByKey.get(key);
    if (!account) continue;
    const policy = byPolicy.get(pooled.policyId) ?? {
      matchedCampaignDays: 0,
      kindDivergence: 0,
      classDivergence: 0,
      highTestDivergence: 0,
    };
    matched += 1;
    policy.matchedCampaignDays += 1;
    const kindChanged = account.publishedKind !== pooled.publishedKind;
    const classChanged = account.publishedClass !== pooled.publishedClass;
    if (kindChanged) {
      kindDivergence += 1;
      policy.kindDivergence += 1;
    }
    if (classChanged) {
      classDivergence += 1;
      policy.classDivergence += 1;
    }
    const accountHighTest =
      account.publishedKind === "test" && account.publishedClass === "high";
    const pooledHighTest =
      pooled.publishedKind === "test" && pooled.publishedClass === "high";
    if (accountHighTest !== pooledHighTest) {
      highTestDivergence += 1;
      policy.highTestDivergence += 1;
    }
    byPolicy.set(pooled.policyId, policy);
    if ((kindChanged || classChanged) && examples.length < 20) {
      examples.push({
        policyId: pooled.policyId,
        business: pooled.businessName,
        accountId: pooled.accountId,
        campaignId: pooled.campaignId,
        date: pooled.date,
        accountIsolated: `${account.publishedKind ?? "null"}/${account.publishedClass}`,
        businessPooled: `${pooled.publishedKind ?? "null"}/${pooled.publishedClass}`,
      });
    }
  }
  return {
    matchedCampaignDays: matched,
    kindDivergence,
    kindDivergenceRate: ratio(kindDivergence, matched),
    classDivergence,
    classDivergenceRate: ratio(classDivergence, matched),
    highTestDivergence,
    byPolicy: [...byPolicy.entries()]
      .map(([policyId, value]) => ({
        policyId,
        ...value,
        kindDivergenceRate: ratio(
          value.kindDivergence,
          value.matchedCampaignDays,
        ),
        classDivergenceRate: ratio(
          value.classDivergence,
          value.matchedCampaignDays,
        ),
      }))
      .sort((left, right) => left.policyId.localeCompare(right.policyId)),
    examples,
  };
}

function placeboEvidence(anchors: readonly H11DailyResult[]) {
  const observations = anchors.map(scored);
  const observed = summarizeH11Evaluation(observations).allLabelAccuracy;
  if (observed === null) {
    return {
      iterations: PLACEBO_ITERATIONS,
      observedAccuracy: null,
      meanPlaceboAccuracy: null,
      maximumPlaceboAccuracy: null,
      empiricalPValue: null,
    };
  }
  const values: number[] = [];
  for (let iteration = 1; iteration <= PLACEBO_ITERATIONS; iteration += 1) {
    const value = summarizeH11Evaluation(
      cyclicAccountLabelPlacebo(observations, iteration),
    ).allLabelAccuracy;
    if (value !== null) values.push(value);
  }
  const atLeastObserved = values.filter((value) => value >= observed).length;
  return {
    iterations: PLACEBO_ITERATIONS,
    observedAccuracy: observed,
    meanPlaceboAccuracy:
      values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null,
    maximumPlaceboAccuracy: values.length > 0 ? Math.max(...values) : null,
    empiricalPValue: (atLeastObserved + 1) / (values.length + 1),
  };
}

function lockedTestDiagnostics(anchors: readonly H11DailyResult[]) {
  const byAccount = [
    ...groupBy(
      anchors,
      (row) => `${row.businessName}:${row.accountId}`,
    ).entries(),
  ]
    .map(([account, rows]) => ({
      account,
      business: rows[0].businessName,
      accountId: rows[0].accountId,
      summary: summarizeH11Evaluation(rows.map(scored)),
    }))
    .sort((left, right) => left.account.localeCompare(right.account));
  const mismatchExamples = anchors
    .filter(
      (row) => row.manualKind !== null && row.publishedKind !== row.manualKind,
    )
    .sort(
      (left, right) =>
        left.businessName.localeCompare(right.businessName) ||
        left.accountId.localeCompare(right.accountId) ||
        left.campaignId.localeCompare(right.campaignId),
    )
    .slice(0, 30)
    .map((row) => ({
      business: row.businessName,
      accountId: row.accountId,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      date: row.date,
      manualKind: row.manualKind,
      publishedKind: row.publishedKind,
      publishedClass: row.publishedClass,
      manualLabelAvailableAtDecision: row.manualLabelAvailableAtDecision,
    }));
  return { byAccount, mismatchExamples };
}

function pointInTimeLeakageCheck(data: H11InputData) {
  const seams = ["2026-03-31", "2026-05-31", "2026-06-27"];
  const accountScopes = groupBy(
    data.creativeRows,
    (row) => `${row.businessId}:${row.accountId}`,
  );
  const checks: Row[] = [];
  for (const asOf of seams) {
    for (const [scope, allRows] of accountScopes) {
      const [businessId, accountId] = scope.split(":");
      const names = data.campaignNameRows.filter(
        (row) => row.businessId === businessId && row.accountId === accountId,
      );
      const firstSeen = data.campaignFirstSeenRows.filter(
        (row) => row.businessId === businessId && row.accountId === accountId,
      );
      const full = buildH11PointInTimeFeatures({
        creativeRows: allRows,
        campaignNameRows: names,
        campaignFirstSeenRows: firstSeen,
        asOf,
      });
      const truncated = buildH11PointInTimeFeatures({
        creativeRows: allRows.filter((row) => row.date <= asOf),
        campaignNameRows: names.filter((row) => row.date <= asOf),
        campaignFirstSeenRows: firstSeen,
        asOf,
      });
      const comparable = (result: H11PointInTimeFeatureResult) =>
        result.features.map((item) => ({
          accountId: item.accountId,
          feature: item.feature,
        }));
      checks.push({
        asOf,
        scope,
        fullInputHash: stableConfigHash(comparable(full)),
        truncatedInputHash: stableConfigHash(comparable(truncated)),
        pass:
          stableConfigHash(comparable(full)) ===
          stableConfigHash(comparable(truncated)),
        futureRowsIgnored: full.futureRowsIgnored,
      });
    }
  }
  return {
    checks: checks.length,
    failures: checks.filter((row) => row.pass !== true).length,
    examples: checks.slice(0, 20),
  };
}

function renderMarkdown(report: Record<string, any>): string {
  const lines: string[] = [];
  lines.push("# H11 Campaign Context Challenger Closure");
  lines.push("");
  lines.push(
    "Deterministic, SELECT-only historical simulation of the fixed 4x2 campaign-context matrix. This is restated-history evidence, not authorization to change production resolver behavior or enable automatic execution.",
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- verdict: **${report.verdict.decision}**`);
  lines.push(`- selected on calibration: ${report.selection.selectedPolicyId}`);
  lines.push(`- locked-test gate: ${report.selection.lockedTestGateStatus}`);
  lines.push(
    `- automatic consumption recommendation: ${report.selection.automaticConsumptionRecommendation}`,
  );
  lines.push(`- production change: ${report.verdict.productionChange}`);
  lines.push(`- reason: ${report.verdict.reason}`);
  lines.push("");
  lines.push("## Contract");
  lines.push("");
  lines.push(`- contract: ${report.contractVersion}`);
  lines.push(`- resolver: ${report.resolverVersion}`);
  lines.push(`- source tier: ${report.evidence.sourceTier}`);
  lines.push(
    `- decision dates: ${report.protocol.startDate} .. ${report.protocol.endDate}`,
  );
  lines.push(
    `- policies: ${report.policies.length} exactly; bootstrap: ${report.protocol.bootstrapIterations} business/entity clustered replicates, 7-day moving blocks`,
  );
  lines.push(
    "- DB boundary: transaction_read_only=on; SELECT statements only; no provider or production writes",
  );
  lines.push("");
  lines.push("## Predeclared Policies");
  lines.push("");
  lines.push(
    "| Policy | Signals | Thresholds | Baseline | Config hash | Definition |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const policy of report.policies) {
    lines.push(
      `| ${policy.id} | ${policy.signalProfile} | ${policy.thresholdRegime} | ${policy.baseline ? "yes" : "no"} | ${policy.configHash.slice(0, 12)} | ${policy.rationale} |`,
    );
  }
  lines.push("");
  lines.push("## Data Coverage");
  lines.push("");
  for (const [key, value] of Object.entries(report.coverage)) {
    lines.push(
      `- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    );
  }
  lines.push("");
  lines.push("## Rolling-Origin Evaluation");
  lines.push("");
  lines.push(
    "One campaign contributes at most one anchor per fold. Daily rows are reserved for stability and the clustered bootstrap; they do not inflate the evidence gate.",
  );
  lines.push("");
  lines.push(
    "| Fold | Policy | Labeled campaigns | Classified | High n | High accuracy | Wilson lower | False Test | Coverage |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const fold of report.foldResults) {
    for (const policy of fold.policies) {
      lines.push(
        `| ${fold.foldId} | ${policy.policyId} | ${policy.summary.uniqueLabeledCampaigns} | ${policy.summary.uniqueClassifiedCampaigns} | ${policy.summary.uniqueHighConfidenceCampaigns} | ${percent(policy.summary.highConfidenceAccuracy)} | ${percent(policy.summary.highConfidenceWilson95?.lower ?? null)} | ${policy.summary.falseTestAny} | ${percent(policy.summary.labelCoverage)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Locked-Test Robustness");
  lines.push("");
  lines.push(
    "| Policy | Anchor pairs | McNemar net wins | p | Bootstrap delta [95%] | LOBO direction | LOAO direction | Gate | Closure |",
  );
  lines.push("| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |");
  for (const policy of report.lockedTestPolicies) {
    const bootstrap = policy.paired.bootstrapAccuracyDelta;
    lines.push(
      `| ${policy.policyId} | ${policy.paired.anchorPairCount} | ${policy.paired.mcnemar.candidateNetWins} | ${policy.paired.mcnemar.pValue.toFixed(4)} | ${percent(bootstrap?.pointEstimate ?? null)} [${percent(bootstrap?.lower ?? null)}, ${percent(bootstrap?.upper ?? null)}] | ${policy.paired.leaveOneBusinessOut?.foldDirection ?? "n/a"} | ${policy.paired.leaveOneAccountOut?.foldDirection ?? "n/a"} | ${policy.acceptance.status} | ${policy.closure} |`,
    );
  }
  lines.push("");
  lines.push("### Critical Test-recall diagnostic (not used for selection)");
  lines.push("");
  lines.push(
    "| Policy | Manual Test | Published Test | True-positive Test | Test recall | Missed Test |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const policy of report.lockedTestPolicies) {
    lines.push(
      `| ${policy.policyId} | ${policy.summary.manualTest} | ${policy.summary.predictedTest} | ${policy.summary.truePositiveTest} | ${percent(policy.summary.testRecall)} | ${policy.summary.missedTest} |`,
    );
  }
  lines.push("");
  lines.push(
    "This diagnostic was not added to the preregistered acceptance gate after seeing the result. It is reported because zero Test recall is operationally material and independently argues against automatic consumption.",
  );
  lines.push("");
  const selectedPolicy = report.lockedTestPolicies.find(
    (policy: Record<string, any>) =>
      policy.policyId === report.selection.selectedPolicyId,
  );
  if (selectedPolicy) {
    lines.push("### Selected policy by provider account");
    lines.push("");
    lines.push(
      "| Business / account | Labeled | Classified | High n | High accuracy | Test recall | Coverage |",
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const account of selectedPolicy.diagnostics.byAccount.filter(
      (item: Record<string, any>) => item.summary.labeledObservations > 0,
    )) {
      lines.push(
        `| ${account.business} / ${account.accountId} | ${account.summary.uniqueLabeledCampaigns} | ${account.summary.uniqueClassifiedCampaigns} | ${account.summary.uniqueHighConfidenceCampaigns} | ${percent(account.summary.highConfidenceAccuracy)} | ${percent(account.summary.testRecall)} | ${percent(account.summary.labelCoverage)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Stability And Sensitivity");
  lines.push("");
  lines.push(
    "| Policy | Published flips/100d | Raw flips/100d | Unresolved | Collapsed accounts | Invariant violations | Placebo p |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const policy of report.lockedTestPolicies) {
    lines.push(
      `| ${policy.policyId} | ${policy.stability.publishedFlipRatePer100Days?.toFixed(4) ?? "n/a"} | ${policy.stability.rawFlipRatePer100Days?.toFixed(4) ?? "n/a"} | ${percent(policy.stability.unresolvedRate)} | ${policy.stability.collapsedAccountCount} | ${policy.stability.invariantViolationCount} | ${policy.placebo.empiricalPValue?.toFixed(4) ?? "n/a"} |`,
    );
  }
  lines.push("");
  lines.push(
    `- account-isolated vs business-pooled sensitivity: ${report.sourceModeSensitivity.kindDivergence}/${report.sourceModeSensitivity.matchedCampaignDays} kind divergences (${percent(report.sourceModeSensitivity.kindDivergenceRate)}), ${report.sourceModeSensitivity.highTestDivergence} high-Test divergences.`,
  );
  for (const policy of report.sourceModeSensitivity.byPolicy) {
    lines.push(
      `- source sensitivity ${policy.policyId}: kind ${policy.kindDivergence}/${policy.matchedCampaignDays} (${percent(policy.kindDivergenceRate)}), class ${policy.classDivergence} (${percent(policy.classDivergenceRate)}).`,
    );
  }
  lines.push(
    `- PIT append-future falsification: ${report.pointInTimeLeakageCheck.failures}/${report.pointInTimeLeakageCheck.checks} failures.`,
  );
  lines.push("");
  lines.push("## H11xH1 End-to-End Parent Sensitivity");
  lines.push("");
  lines.push(
    `This is a clearly bounded ${report.h11xH1EndToEndSensitivity.h11Policies} x ${report.h11xH1EndToEndSensitivity.h1Variants} sensitivity (${report.h11xH1EndToEndSensitivity.predeclaredMatrixCells} configuration cells), not a new authority source. Only high, non-null published context may select an H1 kind parent; all other rows use account-all.`,
  );
  lines.push("");
  lines.push(
    "| Policy | Rows | Kind-parent authority | Account-all fallback | Parent changes vs baseline | Authority violations |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const policy of report.h11xH1EndToEndSensitivity.byPolicy) {
    lines.push(
      `| ${policy.policyId} | ${policy.rows} | ${policy.kindSpecificAuthorityRows} | ${policy.accountAllFallbackRows} | ${policy.changedParentVsBaseline} | ${policy.authorityViolations} |`,
    );
  }
  lines.push("");
  lines.push("## Closure Classification");
  lines.push("");
  for (const item of report.verdict.classifications) {
    lines.push(
      `- ${item.policyId}: **${item.classification}** - ${item.reason}`,
    );
  }
  lines.push("");
  lines.push("## Physically Unreconstructable Limits");
  lines.push("");
  for (const limit of report.physicallyUnreconstructableLimits) {
    lines.push(`- ${limit}`);
  }
  lines.push("");
  lines.push("## Deterministic Lineage");
  lines.push("");
  for (const [key, value] of Object.entries(report.lineage)) {
    lines.push(`- ${key}: ${String(value)}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function buildReport() {
  const data = await readInputData();
  const labelIndex = resolveLabelIndex(data);
  const accountRows = replayMode({
    data,
    labels: labelIndex,
    scopeMode: "account_isolated",
  });
  const pooledRows = replayMode({
    data,
    labels: labelIndex,
    scopeMode: "business_pooled_sensitivity",
  });
  const foldIds = ["development", "calibration", "locked_test"];
  const foldResults = foldIds.map((foldId) => ({
    foldId,
    policies: H11_CONTEXT_POLICIES.map((policy) => {
      const anchors = foldAnchors(accountRows, policy.id, foldId);
      return {
        policyId: policy.id,
        anchorCount: anchors.length,
        summary: summarizeH11Evaluation(anchors.map(scored)),
        manualLabelAvailableAtDecision: anchors.filter(
          (row) => row.manualLabelAvailableAtDecision === true,
        ).length,
      };
    }),
  }));
  const calibration = foldResults.find(
    (fold) => fold.foldId === "calibration",
  )!;
  const selected = selectH11PolicyOnCalibration(calibration.policies);
  if (!selected)
    throw new Error("H11 calibration selection produced no policy");
  const baselineId = H11_CONTEXT_POLICIES.find((policy) => policy.baseline)!.id;
  const h11xH1EndToEndSensitivity = summarizeH11H1EndToEndSensitivity({
    rows: accountRows.filter((row) => row.foldId === "locked_test"),
    baselinePolicyId: baselineId,
  });
  const baselineAnchors = foldAnchors(accountRows, baselineId, "locked_test");
  const baselineDaily = accountRows.filter(
    (row) => row.policyId === baselineId && row.foldId === "locked_test",
  );
  const baselineStability = summarizeStability(baselineDaily);

  const lockedTestPolicies = H11_CONTEXT_POLICIES.map((policy) => {
    const anchors = foldAnchors(accountRows, policy.id, "locked_test");
    const daily = accountRows.filter(
      (row) => row.policyId === policy.id && row.foldId === "locked_test",
    );
    const summary = summarizeH11Evaluation(anchors.map(scored));
    const stability = summarizeStability(daily);
    const paired = pairedEvidence(
      anchors,
      baselineAnchors,
      daily,
      baselineDaily,
      `${H11_CAMPAIGN_CONTEXT_CONTRACT_VERSION}:${policy.id}`,
    );
    const bootstrap = paired.bootstrapAccuracyDelta;
    const pairedPoint = bootstrap?.pointEstimate ?? null;
    const acceptance = evaluateH11Acceptance({
      summary,
      pairedAccuracyImprovement:
        bootstrap === null || pairedPoint === null
          ? null
          : {
              point: pairedPoint,
              lower:
                bootstrap.lower === null
                  ? null
                  : Math.min(bootstrap.lower, pairedPoint),
              upper:
                bootstrap.upper === null
                  ? null
                  : Math.max(bootstrap.upper, pairedPoint),
              sampleSize: bootstrap.observationCount,
              polarity: "positive_is_candidate_improvement",
            },
      publishedFlipRatePer100Days: stability.publishedFlipRatePer100Days,
      maximumAllowedFlipRatePer100Days:
        (baselineStability.publishedFlipRatePer100Days ?? 0) +
        MAX_FLIP_RATE_INCREASE_PER_100_DAYS,
      collapsedAccountCount: stability.collapsedAccountCount,
      invariantViolationCount: stability.invariantViolationCount,
    });
    const isSelected = policy.id === selected.policyId;
    const closure = policy.baseline
      ? "retain_as_policy"
      : isSelected && acceptance.accepted
        ? "adopt"
        : "reject";
    return {
      policyId: policy.id,
      selectedOnCalibration: isSelected,
      summary,
      stability,
      paired,
      acceptance,
      placebo: placeboEvidence(anchors),
      diagnostics: lockedTestDiagnostics(anchors),
      closure,
    };
  });
  const selectedLocked = lockedTestPolicies.find(
    (policy) => policy.policyId === selected.policyId,
  )!;
  const adopted =
    selectedLocked.acceptance.accepted &&
    selectedLocked.policyId !== baselineId;

  const sourceHash = stableHashRows([
    ...data.creativeRows.map((row) => ({ type: "creative", ...row })),
    ...data.campaignNameRows.map((row) => ({ type: "name", ...row })),
    ...data.campaignFirstSeenRows.map((row) => ({
      type: "first_seen",
      ...row,
    })),
    ...data.labels.map((row) => ({ type: "label", ...row })),
  ]);
  const accountIds = new Set(data.creativeRows.map((row) => row.accountId));
  const businessIds = new Set(data.creativeRows.map((row) => row.businessId));
  const campaignKeys = new Set(
    data.creativeRows.map((row) =>
      sourceIdentity(row.businessId, row.accountId, row.campaignId),
    ),
  );
  const labeledDaily = accountRows.filter((row) => row.manualKind !== null);
  const labelAvailableAtDecision = labeledDaily.filter(
    (row) => row.manualLabelAvailableAtDecision === true,
  ).length;

  const report = {
    title: "H11 Campaign Context Challenger Closure",
    contractVersion: H11_CAMPAIGN_CONTEXT_CONTRACT_VERSION,
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    deterministic: true,
    readOnly: true,
    providerWrites: false,
    productionWrites: false,
    productionBehaviorChanged: false,
    protocol: {
      startDate: START_DATE,
      endDate: END_DATE,
      sourceStartDate: SOURCE_START_DATE,
      featureWindowDays: FEATURE_WINDOW_DAYS,
      lineageSourceWindowDays: LINEAGE_SOURCE_WINDOW_DAYS,
      outcomeWindowDays: 0,
      bootstrapIterations: BOOTSTRAP_ITERATIONS,
      bootstrapBlockDays: 7,
      placeboIterations: PLACEBO_ITERATIONS,
      selectionRule:
        "calibration-only lexicographic: zero false-Test, high-confidence Wilson lower/accuracy/sample, all-label accuracy, coverage, stable id",
      lockedTestRule:
        "selected configuration is scored once on 2026-06-01..2026-07-05; one campaign anchor per fold",
    },
    evidence: {
      sourceTier: "restated_ad_daily_plus_current_manual_label_truth",
      primaryScope: "provider-account isolated",
      sensitivityScope:
        "business pooled to expose current producer pooling risk",
      labelsUsedAsFeatures: false,
      currentCampaignNameUsed: false,
      historicalNameRule:
        "latest campaign_name_historical on or before each as-of date",
      lineageRule:
        "only retained creative rows on or before as-of within 56 days",
      targetDataUsed: false,
    },
    policies: H11_CONTEXT_POLICIES.map((policy) => ({
      id: policy.id,
      label: policy.label,
      baseline: policy.baseline,
      rationale: policy.rationale,
      includeLineage: policy.includeLineage,
      signalProfile: policy.signalProfile,
      thresholdRegime: policy.thresholdRegime,
      configHash: policy.configHash,
      config: policy.config,
    })),
    coverage: {
      businesses: businessIds.size,
      providerAccounts: accountIds.size,
      campaigns: campaignKeys.size,
      creativeDayRows: data.creativeRows.length,
      campaignNameChangeRows: data.campaignNameRows.length,
      campaignFirstSeenRows: data.campaignFirstSeenRows.length,
      manualLabelRows: labelIndex.totalRows,
      manualLabelsWithExactAccount: labelIndex.exactAccountRows,
      manualLabelsWithInferredUniqueAccount: labelIndex.inferredAccountRows,
      manualLabelsWithUnresolvedAccount: labelIndex.unresolvedAccountRows,
      duplicateManualLabelKeys: labelIndex.duplicateKeyRows,
      labeledDailyObservations: labeledDaily.length,
      labelAvailableAtDecisionObservations: labelAvailableAtDecision,
      labelAvailableAtDecisionRate: ratio(
        labelAvailableAtDecision,
        labeledDaily.length,
      ),
    },
    foldResults,
    selection: {
      selectedPolicyId: selected.policyId,
      calibrationSummary: selected.summary,
      lockedTestGateStatus: selectedLocked.acceptance.status,
      accepted: selectedLocked.acceptance.accepted,
      automaticConsumptionRecommendation: "DO_NOT_ENABLE",
    },
    lockedTestPolicies,
    sourceModeSensitivity: sourceModeSensitivity(accountRows, pooledRows),
    pointInTimeLeakageCheck: pointInTimeLeakageCheck(data),
    h11xH1EndToEndSensitivity,
    verdict: {
      decision: adopted ? "ADOPT" : "RETAIN_PRODUCTION_DEFAULT",
      productionChange: adopted
        ? `Adopt ${selected.policyId} in a separately approved engine version.`
        : "No H11 resolver formula/configuration change is justified by retained history.",
      reason: adopted
        ? "The calibration-selected challenger passed every locked-test evidence and safety gate."
        : `The calibration-selected policy ${selected.policyId} did not pass every locked-test gate (${selectedLocked.acceptance.status}); bounded H11 alternatives are closed rather than left open.`,
      classifications: lockedTestPolicies.map((policy) => ({
        policyId: policy.policyId,
        classification: policy.closure,
        reason:
          policy.policyId === baselineId
            ? "Retained as the conservative policy while the automatic-context evidence gate remains closed."
            : policy.closure === "adopt"
              ? "Calibration-selected and passed every locked-test gate."
              : `Not adopted: gate=${policy.acceptance.status}; failed=${policy.acceptance.failedRequiredGateIds.join(",") || "none"}; insufficient=${policy.acceptance.insufficientRequiredGateIds.join(",") || "none"}.`,
      })),
    },
    physicallyUnreconstructableLimits: [
      "meta_campaign_labels stores only the current label and timestamps, not a versioned label history; the campaign role that an operator believed on each historical day cannot be reconstructed.",
      `Only ${data.labels.length} reviewed labels exist and unlabeled campaigns have no independent role truth; restated behavior cannot manufacture reviewed Main/Test/Mixed ground truth.`,
      "meta_creative_daily campaign/creative lineage is normalized and restatable rather than an immutable raw point-in-time identity graph; same-day multi-campaign reuse that was not retained cannot be recovered.",
      "Historical campaign status, policy/learning state, and every prior rename are not all preserved as exact raw point-in-time inputs; this replay therefore cannot claim exact producer reproduction.",
      "A context classification's causal effect on later buyer actions or business outcomes requires contemporaneous controlled assignment; observational history cannot reconstruct that counterfactual.",
    ],
    futureInstrumentation: [
      "Persist append-only campaign-context review/override events with effective_from/effective_to and reviewer provenance.",
      "Persist per-day resolver input manifests, account identity, raw campaign/ad/creative lineage edges, configuration hash, and output hash.",
      "Use a randomized or controlled canary before treating automatic-context unlocks as causal execution evidence.",
    ],
    lineage: {
      sourceHash,
      scriptHash: fileHash(SCRIPT_PATH),
      moduleHash: fileHash(MODULE_PATH),
      policyManifestHash: stableConfigHash(
        H11_CONTEXT_POLICIES.map((policy) => ({
          id: policy.id,
          includeLineage: policy.includeLineage,
          configHash: policy.configHash,
        })),
      ),
      inputManifestHash: stableConfigHash({
        contract: H11_CAMPAIGN_CONTEXT_CONTRACT_VERSION,
        sourceHash,
        dates: [START_DATE, END_DATE],
        policyHashes: H11_CONTEXT_POLICIES.map((policy) => policy.configHash),
      }),
    },
  };
  return report;
}

async function main() {
  const report = await buildReport();
  const jsonPath = resolve(JSON_OUT);
  const markdownPath = resolve(MD_OUT);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
  console.log(
    JSON.stringify(
      {
        jsonPath,
        markdownPath,
        selectedPolicyId: report.selection.selectedPolicyId,
        lockedTestGateStatus: report.selection.lockedTestGateStatus,
        verdict: report.verdict.decision,
      },
      null,
      2,
    ),
  );
}

const isDirectExecution =
  process.argv[1]?.endsWith("h11-campaign-context-challenger.ts") ?? false;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
