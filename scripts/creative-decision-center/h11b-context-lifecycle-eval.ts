#!/usr/bin/env node
// H11B campaign-context lifecycle challenger — STAGE 2: offline evaluation.
//
// Runs entirely from the frozen bundle artifact produced by
// h11b-context-lifecycle-bundle.ts (no DB access at all), so every number is
// reproducible from the recorded bundleHash. The locked historical H11 replay
// (2025-12-01..2026-07-05) is untouched; this is a NEW evaluation package on
// a NEW retained-evidence window (2026-07-13..2026-08-22), justified per
// START_HERE's reopening rule by evidence sources that did not exist for the
// locked replay: complete-lane entity-state history (status transitions,
// campaign/ad-set budgets, ad-set structure).
//
// Modes:
//   --mode diagnose   TRAIN fold only, current resolver (v2) — failure
//                     taxonomy per labeled campaign. Never reads validation.
//   --mode full       v2 vs v3 on train + locked validation + LOBO, gate
//                     verdict per the D076 predeclared gate.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_CONTEXT_CONFIG,
  classifyCampaignContext,
  type CampaignFeatures,
  type CampaignKind,
  type ContextResolution,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  addDaysUtc,
  buildCampaignContextFeatures,
  computeCampaignLineage,
  diffDaysUtc,
  type CampaignMetaRow,
  type CreativeDayRow,
} from "@/lib/creative-decision-engine/campaign-context/data";
import {
  summarizeH11Evaluation,
  type H11EvaluationSummary,
  type H11ScoredObservation,
} from "@/lib/creative-decision-engine/simulation/h11-campaign-context-challenger";
import {
  CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
  DEFAULT_V3_CONFIG,
  classifyCampaignContextV3,
  type CampaignLifecycleFeatures,
} from "@/lib/creative-decision-engine/campaign-context/resolver-v3";

export const H11B_EVAL_CONTRACT_VERSION =
  "adsecute.meta.h11b-context-lifecycle-eval.v1";

const BUNDLE_PATH =
  "docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json";

export const H11B_TRAIN_ANCHORS = [
  "2026-06-15",
  "2026-06-22",
  "2026-06-29",
  "2026-07-06",
  "2026-07-13",
  "2026-07-20",
  "2026-07-27",
] as const;

/**
 * Truth freshness: a frozen label is current-state truth stamped at
 * labeled/updated time, not a per-day history. Pairing a label with an
 * anchor far from its stamp evaluates the resolver against a truth nobody
 * asserted for that date, so labeled observations are truth-evaluable only
 * within this window of the label's freshest stamp, at the in-window anchor
 * closest to it.
 */
export const H11B_TRUTH_WINDOW_DAYS = 45;
export const H11B_VALIDATION_ANCHORS = [
  "2026-08-03",
  "2026-08-10",
  "2026-08-17",
] as const;

const SOURCE_WINDOW_DAYS = 56;

interface BundleCreativeRow extends CreativeDayRow {
  businessId: string;
  accountId: string;
}
interface BundleNameRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  date: string;
  campaignName: string | null;
}
interface BundleFirstSeenRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  firstSeenDate: string;
}
interface BundleLabelRow {
  businessId: string;
  accountId: string | null;
  campaignId: string;
  campaignKind: CampaignKind;
  labeledAtDate: string | null;
  updatedAtDate: string | null;
}
interface BundleCampaignStateRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  capturedDate: string;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  presence: string;
  campaignDailyBudgetRaw: number | null;
}
interface BundleAdsetDailyRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  capturedDate: string;
  activeAdsets: number;
  presentAdsets: number;
  activeAdsetBudgetSum: number | null;
}
interface Bundle {
  contract: string;
  bundleHash: string;
  sectionHashes: Record<string, string>;
  businesses: Array<{
    businessId: string;
    name: string;
    providerAccountId: string;
  }>;
  creativeRows: BundleCreativeRow[];
  nameRows: BundleNameRow[];
  firstSeenRows: BundleFirstSeenRow[];
  labels: BundleLabelRow[];
  campaignStateRows: BundleCampaignStateRow[];
  adsetDailyRows: BundleAdsetDailyRow[];
}

export type LifecycleFeatures = CampaignLifecycleFeatures;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeLifecycleFeatures(input: {
  anchor: string;
  campaignIds: readonly string[];
  stateRows: readonly BundleCampaignStateRow[];
  adsetRows: readonly BundleAdsetDailyRow[];
  featuresByCampaign: ReadonlyMap<string, CampaignFeatures>;
}): Map<string, LifecycleFeatures> {
  const stateByCampaign = new Map<string, BundleCampaignStateRow[]>();
  for (const row of input.stateRows) {
    if (row.capturedDate > input.anchor) continue;
    const list = stateByCampaign.get(row.campaignId) ?? [];
    list.push(row);
    stateByCampaign.set(row.campaignId, list);
  }
  const adsetByCampaign = new Map<string, BundleAdsetDailyRow[]>();
  for (const row of input.adsetRows) {
    if (row.capturedDate > input.anchor) continue;
    const list = adsetByCampaign.get(row.campaignId) ?? [];
    list.push(row);
    adsetByCampaign.set(row.campaignId, list);
  }

  const raw = new Map<
    string,
    Omit<
      LifecycleFeatures,
      "accountMedianDailyBudget" | "accountMedianActiveCreatives"
    >
  >();
  for (const campaignId of input.campaignIds) {
    const series = (stateByCampaign.get(campaignId) ?? []).sort((a, b) =>
      a.capturedDate.localeCompare(b.capturedDate),
    );
    const adsets = (adsetByCampaign.get(campaignId) ?? []).sort((a, b) =>
      a.capturedDate.localeCompare(b.capturedDate),
    );
    const latestAdset = adsets[adsets.length - 1] ?? null;
    if (series.length === 0) {
      raw.set(campaignId, {
        statusCoverageDays: null,
        activeStatusShare28: null,
        currentConfiguredStatus: null,
        daysSinceLastStatusChange: null,
        effectiveDailyBudget: latestAdset?.activeAdsetBudgetSum ?? null,
        activeAdsetCount: latestAdset?.activeAdsets ?? null,
      });
      continue;
    }
    const firstCaptured = series[0].capturedDate;
    const coverage = Math.min(28, diffDaysUtc(input.anchor, firstCaptured) + 1);
    // Carry-forward day grid over the last 28 days (bounded by coverage).
    const windowStart = addDaysUtc(input.anchor, -27);
    let activeDays = 0;
    let coveredDays = 0;
    let cursor = 0;
    let currentStatus: string | null = null;
    for (
      let dayIso = windowStart;
      dayIso <= input.anchor;
      dayIso = addDaysUtc(dayIso, 1)
    ) {
      while (cursor < series.length && series[cursor].capturedDate <= dayIso) {
        currentStatus = series[cursor].configuredStatus;
        cursor += 1;
      }
      if (dayIso < firstCaptured) continue;
      coveredDays += 1;
      if (currentStatus === "ACTIVE") activeDays += 1;
    }
    const latest = series[series.length - 1];
    raw.set(campaignId, {
      statusCoverageDays: coverage,
      activeStatusShare28:
        coveredDays >= 7 ? activeDays / coveredDays : null,
      currentConfiguredStatus: latest.configuredStatus,
      daysSinceLastStatusChange: diffDaysUtc(
        input.anchor,
        latest.capturedDate,
      ),
      effectiveDailyBudget:
        latest.campaignDailyBudgetRaw ??
        latestAdset?.activeAdsetBudgetSum ??
        null,
      activeAdsetCount: latestAdset?.activeAdsets ?? null,
    });
  }

  const budgets = [...raw.entries()]
    .filter(([campaignId]) => input.featuresByCampaign.has(campaignId))
    .map(([, value]) => value.effectiveDailyBudget)
    .filter((value): value is number => value !== null && value > 0);
  const accountMedianDailyBudget = median(budgets);
  const accountMedianActiveCreatives = median(
    [...input.featuresByCampaign.values()].map((f) => f.activeCreatives),
  );

  const out = new Map<string, LifecycleFeatures>();
  for (const [campaignId, value] of raw) {
    out.set(campaignId, {
      ...value,
      accountMedianDailyBudget,
      accountMedianActiveCreatives,
    });
  }
  return out;
}

export interface AnchorResolution {
  businessId: string;
  businessName: string;
  accountId: string;
  campaignId: string;
  anchor: string;
  manualKind: CampaignKind | null;
  labeledAtDate: string | null;
  features: CampaignFeatures | null;
  lifecycle: LifecycleFeatures | null;
  resolution: ContextResolution | null;
}

export function resolveAccountAnchor(input: {
  bundle: Bundle;
  businessId: string;
  businessName: string;
  accountId: string;
  anchor: string;
  classify: (
    features: CampaignFeatures,
    lifecycle: LifecycleFeatures | null,
  ) => ContextResolution;
}): AnchorResolution[] {
  const { bundle, accountId, anchor } = input;
  const sourceStart = addDaysUtc(anchor, -(SOURCE_WINDOW_DAYS - 1));
  const rows = bundle.creativeRows.filter(
    (row) =>
      row.businessId === input.businessId &&
      row.accountId === accountId &&
      row.date >= sourceStart &&
      row.date <= anchor,
  );
  const meta = new Map<string, CampaignMetaRow>();
  for (const row of bundle.nameRows) {
    if (row.businessId !== input.businessId || row.accountId !== accountId)
      continue;
    if (row.date > anchor) continue;
    const existing = meta.get(row.campaignId);
    if (!existing || (existing as { _nameDate?: string })._nameDate! <= row.date) {
      meta.set(row.campaignId, {
        providerAccountId: accountId,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        firstSeenDate: null,
        ...( { _nameDate: row.date } as object ),
      } as CampaignMetaRow);
    }
  }
  for (const row of bundle.firstSeenRows) {
    if (row.businessId !== input.businessId || row.accountId !== accountId)
      continue;
    if (row.firstSeenDate > anchor) continue;
    const existing = meta.get(row.campaignId);
    if (existing) existing.firstSeenDate = row.firstSeenDate;
    else
      meta.set(row.campaignId, {
        providerAccountId: accountId,
        campaignId: row.campaignId,
        campaignName: null,
        firstSeenDate: row.firstSeenDate,
      });
  }
  const lineage = computeCampaignLineage(rows);
  const features = buildCampaignContextFeatures({
    rows,
    meta,
    lineage,
    asOf: anchor,
  });
  const featuresByCampaign = new Map(
    features.map((feature) => [feature.campaignId, feature]),
  );
  const lifecycle = computeLifecycleFeatures({
    anchor,
    campaignIds: features.map((feature) => feature.campaignId),
    stateRows: bundle.campaignStateRows.filter(
      (row) =>
        row.businessId === input.businessId && row.accountId === accountId,
    ),
    adsetRows: bundle.adsetDailyRows.filter(
      (row) =>
        row.businessId === input.businessId && row.accountId === accountId,
    ),
    featuresByCampaign,
  });

  const labelByCampaign = new Map(
    bundle.labels
      .filter(
        (row) =>
          row.businessId === input.businessId &&
          (row.accountId === null || row.accountId === accountId),
      )
      .map((row) => [row.campaignId, row]),
  );

  return features.map((feature) => {
    const label = labelByCampaign.get(feature.campaignId) ?? null;
    const lifecycleFeatures = lifecycle.get(feature.campaignId) ?? null;
    return {
      businessId: input.businessId,
      businessName: input.businessName,
      accountId,
      campaignId: feature.campaignId,
      anchor,
      manualKind: label?.campaignKind ?? null,
      labeledAtDate: label?.labeledAtDate ?? null,
      features: feature,
      lifecycle: lifecycleFeatures,
      resolution: input.classify(feature, lifecycleFeatures),
    };
  });
}

export type FailureCategory =
  | "correct"
  | "featureless_in_fold"
  | "unresolved_floors"
  | "conflict_naming_vs_smallN_behavior"
  | "conflict_other"
  | "wrong_kind_smallN_concentration"
  | "wrong_kind_other"
  | "kind_right_low_confidence"
  | "mixed_disagreement";

export function categorizeFailure(input: {
  manualKind: CampaignKind;
  resolution: ContextResolution | null;
  features: CampaignFeatures | null;
}): FailureCategory {
  const { manualKind, resolution, features } = input;
  if (!resolution || !features) return "featureless_in_fold";
  if (resolution.confidenceClass === "unknown") return "unresolved_floors";
  const smallN = features.activeCreatives <= 5;
  if (resolution.confidenceClass === "conflict") {
    return resolution.conflictReasons.includes("naming_contradicts_behavior") &&
      smallN
      ? "conflict_naming_vs_smallN_behavior"
      : "conflict_other";
  }
  if (resolution.kind === manualKind) {
    return resolution.confidenceClass === "low"
      ? "kind_right_low_confidence"
      : "correct";
  }
  if (manualKind === "mixed" || resolution.kind === "mixed")
    return "mixed_disagreement";
  if (manualKind === "test" && resolution.kind === "main" && smallN)
    return "wrong_kind_smallN_concentration";
  return "wrong_kind_other";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function loadBundle(): Bundle {
  const bundle = JSON.parse(
    readFileSync(resolve(BUNDLE_PATH), "utf8"),
  ) as Bundle;
  const recomputed = sha256(bundle.sectionHashes);
  if (recomputed !== bundle.bundleHash) {
    throw new Error(
      `Bundle hash mismatch: manifest ${bundle.bundleHash} vs recomputed ${recomputed}`,
    );
  }
  return bundle;
}

interface FoldObservation extends H11ScoredObservation {
  businessName: string;
  resolution: ContextResolution | null;
  features: CampaignFeatures | null;
  lifecycle: LifecycleFeatures | null;
  labeledAtDate: string | null;
}

/**
 * One anchor per labeled campaign per fold: the LAST fold anchor at which the
 * campaign has features. Labeled campaigns with no features at any fold
 * anchor are reported separately as featureless (a data gap, not a resolver
 * defect — the resolver cannot run without evidence and must not guess).
 */
export function labelTruthDate(label: {
  labeledAtDate: string | null;
  updatedAtDate: string | null;
}): string | null {
  const candidates = [label.labeledAtDate, label.updatedAtDate].filter(
    (value): value is string => value !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.sort()[candidates.length - 1];
}

export function collectFoldObservations(input: {
  bundle: Bundle;
  anchors: readonly string[];
  classify: (
    features: CampaignFeatures,
    lifecycle: LifecycleFeatures | null,
  ) => ContextResolution;
}): {
  observations: FoldObservation[];
  featurelessLabeled: Array<{
    businessName: string;
    accountId: string;
    campaignId: string;
    manualKind: CampaignKind;
  }>;
  staleTruthExcluded: Array<{
    businessName: string;
    accountId: string;
    campaignId: string;
    manualKind: CampaignKind;
    truthDate: string | null;
  }>;
} {
  const anchorRows = new Map<string, AnchorResolution[]>();
  for (const anchor of input.anchors) {
    for (const business of input.bundle.businesses) {
      const resolutions = resolveAccountAnchor({
        bundle: input.bundle,
        businessId: business.businessId,
        businessName: business.name,
        accountId: business.providerAccountId,
        anchor,
        classify: input.classify,
      });
      for (const row of resolutions) {
        const key = `${row.accountId}:${row.campaignId}`;
        const list = anchorRows.get(key) ?? [];
        list.push(row);
        anchorRows.set(key, list);
      }
    }
  }
  const truthDateByCampaign = new Map<string, string | null>(
    input.bundle.labels.map((label) => [
      `${label.accountId}:${label.campaignId}`,
      labelTruthDate(label),
    ]),
  );

  const observations: FoldObservation[] = [];
  const seenLabeled = new Set<string>();
  const staleLabeled = new Set<string>();
  for (const [key, rows] of anchorRows) {
    const labeled = rows[0].manualKind !== null;
    let chosen: AnchorResolution | null = null;
    if (labeled) {
      const truthDate = truthDateByCampaign.get(key) ?? null;
      if (truthDate !== null) {
        const inWindow = rows.filter(
          (row) =>
            Math.abs(diffDaysUtc(row.anchor, truthDate)) <=
            H11B_TRUTH_WINDOW_DAYS,
        );
        if (inWindow.length > 0) {
          chosen = inWindow.reduce((best, row) => {
            const bestDistance = Math.abs(diffDaysUtc(best.anchor, truthDate));
            const rowDistance = Math.abs(diffDaysUtc(row.anchor, truthDate));
            if (rowDistance < bestDistance) return row;
            if (rowDistance === bestDistance && row.anchor > best.anchor)
              return row;
            return best;
          });
          seenLabeled.add(key);
        } else {
          staleLabeled.add(key);
        }
      }
    }
    if (!chosen) {
      // Unlabeled campaigns (and stale-truth labeled ones, kept as
      // truth-less observations) use the last anchor with features.
      chosen = rows[rows.length - 1];
    }
    observations.push({
      id: `${key}:${chosen.anchor}`,
      businessId: chosen.businessId,
      businessName: chosen.businessName,
      accountId: chosen.accountId,
      campaignId: chosen.campaignId,
      date: chosen.anchor,
      manualKind: seenLabeled.has(key) ? chosen.manualKind : null,
      predictedKind: chosen.resolution?.kind ?? null,
      confidenceClass: chosen.resolution?.confidenceClass ?? "unknown",
      resolution: chosen.resolution,
      features: chosen.features,
      lifecycle: chosen.lifecycle,
      labeledAtDate: chosen.labeledAtDate,
    });
  }

  const businessNameOf = (businessId: string) =>
    input.bundle.businesses.find(
      (business) => business.businessId === businessId,
    )?.name ?? businessId;
  const featurelessLabeled = input.bundle.labels
    .filter((label) => !anchorRows.has(`${label.accountId}:${label.campaignId}`))
    .map((label) => ({
      businessName: businessNameOf(label.businessId),
      accountId: label.accountId ?? "",
      campaignId: label.campaignId,
      manualKind: label.campaignKind,
    }));
  const staleTruthExcluded = input.bundle.labels
    .filter((label) =>
      staleLabeled.has(`${label.accountId}:${label.campaignId}`),
    )
    .map((label) => ({
      businessName: businessNameOf(label.businessId),
      accountId: label.accountId ?? "",
      campaignId: label.campaignId,
      manualKind: label.campaignKind,
      truthDate: labelTruthDate(label),
    }));
  return { observations, featurelessLabeled, staleTruthExcluded };
}

function formatFeatures(features: CampaignFeatures | null): string {
  if (!features) return "n/a";
  return (
    `spend28=${features.spend28.toFixed(0)} creatives=${features.activeCreatives}` +
    ` new=${features.newCreatives} top3=${features.top3SpendShare ?? "n/a"}` +
    ` share=${features.spendShareOfBusiness} age=${features.campaignAgeDays ?? "n/a"}` +
    ` adsets=${features.adsetCount} activeDays=${features.activeDays}`
  );
}

function formatLifecycle(lifecycle: LifecycleFeatures | null): string {
  if (!lifecycle) return "n/a";
  return (
    `statusCover=${lifecycle.statusCoverageDays ?? "n/a"}` +
    ` activeShare=${lifecycle.activeStatusShare28?.toFixed(2) ?? "n/a"}` +
    ` status=${lifecycle.currentConfiguredStatus ?? "n/a"}` +
    ` budget=${lifecycle.effectiveDailyBudget ?? "n/a"}` +
    ` acctMedBudget=${lifecycle.accountMedianDailyBudget ?? "n/a"}` +
    ` adsets=${lifecycle.activeAdsetCount ?? "n/a"}` +
    ` acctMedCreatives=${lifecycle.accountMedianActiveCreatives ?? "n/a"}`
  );
}

async function runDiagnose() {
  const bundle = loadBundle();
  const classifyV2 = (features: CampaignFeatures) =>
    classifyCampaignContext(features, DEFAULT_CONTEXT_CONFIG);
  const { observations, featurelessLabeled, staleTruthExcluded } =
    collectFoldObservations({
      bundle,
      anchors: H11B_TRAIN_ANCHORS,
      classify: classifyV2,
    });
  const labeled = observations.filter((row) => row.manualKind !== null);
  const summary = summarizeH11Evaluation(observations);

  const lines: string[] = [];
  lines.push("# H11B TRAIN diagnosis — current resolver (v2) on frozen bundle");
  lines.push(`bundleHash=${bundle.bundleHash}`);
  lines.push(`anchors=${H11B_TRAIN_ANCHORS.join(",")}`);
  lines.push(
    `labeled=${summary.uniqueLabeledCampaigns} classified=${summary.classifiedObservations} high=${summary.highConfidenceObservations} highAcc=${summary.highConfidenceAccuracy} testRecall=${summary.testRecall} falseTestAny=${summary.falseTestAny} unresolved=${summary.unresolved} conflict=${summary.conflict}`,
  );
  lines.push("");
  const counts = new Map<FailureCategory, number>();
  for (const row of labeled) {
    const category = categorizeFailure({
      manualKind: row.manualKind as CampaignKind,
      resolution: row.resolution,
      features: row.features,
    });
    counts.set(category, (counts.get(category) ?? 0) + 1);
    lines.push(
      `- [${category}] ${row.businessName} ${row.campaignId} label=${row.manualKind} → kind=${row.predictedKind ?? "null"}/${row.confidenceClass} labeledAt=${row.labeledAtDate ?? "n/a"}`,
    );
    if (row.resolution) {
      lines.push(
        `    scores test=${row.resolution.testScore} main=${row.resolution.mainScore} mixed=${row.resolution.mixedScore} agreeing=[${row.resolution.agreeingFamilies.join("+")}] conflicts=[${row.resolution.conflictReasons.join(",")}]`,
      );
    }
    lines.push(`    features ${formatFeatures(row.features)}`);
    lines.push(`    lifecycle ${formatLifecycle(row.lifecycle)}`);
  }
  lines.push("");
  lines.push("## Failure taxonomy (labeled campaigns, train fold)");
  for (const [category, count] of [...counts.entries()].sort()) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push("");
  lines.push(
    `## Stale-truth labeled campaigns (features exist, label stamp > ${H11B_TRUTH_WINDOW_DAYS}d from every train anchor): ${staleTruthExcluded.length}`,
  );
  for (const row of staleTruthExcluded) {
    lines.push(
      `- ${row.businessName} ${row.campaignId} label=${row.manualKind} truthDate=${row.truthDate ?? "n/a"}`,
    );
  }
  lines.push("");
  lines.push(
    `## Featureless labeled campaigns (no spend at any train anchor window): ${featurelessLabeled.length}`,
  );
  for (const row of featurelessLabeled) {
    lines.push(
      `- ${row.businessName} ${row.campaignId} label=${row.manualKind}`,
    );
  }
  const outPath = resolve(
    "docs/creative-decision-center/generated/h11b-train-diagnosis.md",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(lines.slice(0, 8).join("\n"));
  console.log(`[h11b-eval] wrote ${outPath}`);
}

type CandidateId = "current_v2" | "challenger_v3";

const CANDIDATES: Record<
  CandidateId,
  {
    version: string;
    classify: (
      features: CampaignFeatures,
      lifecycle: LifecycleFeatures | null,
    ) => ContextResolution;
  }
> = {
  current_v2: {
    version: DEFAULT_CONTEXT_CONFIG ? "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01" : "",
    classify: (features) =>
      classifyCampaignContext(features, DEFAULT_CONTEXT_CONFIG),
  },
  challenger_v3: {
    version: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    classify: (features, lifecycle) =>
      classifyCampaignContextV3(features, lifecycle, DEFAULT_V3_CONFIG),
  },
};

const KINDS = ["main", "test", "mixed"] as const;

function confusionMatrix(observations: readonly FoldObservation[]) {
  const matrix: Record<string, Record<string, number>> = {};
  for (const manual of KINDS) {
    matrix[manual] = { main: 0, test: 0, mixed: 0, unresolved: 0, conflict: 0 };
  }
  for (const row of observations) {
    if (row.manualKind === null) continue;
    const predicted =
      row.predictedKind ??
      (row.confidenceClass === "conflict" ? "conflict" : "unresolved");
    matrix[row.manualKind][predicted] += 1;
  }
  return matrix;
}

function classCalibration(observations: readonly FoldObservation[]) {
  const byClass: Record<string, { n: number; correct: number }> = {};
  for (const row of observations) {
    if (row.manualKind === null || row.predictedKind === null) continue;
    const entry = (byClass[row.confidenceClass] ??= { n: 0, correct: 0 });
    entry.n += 1;
    if (row.predictedKind === row.manualKind) entry.correct += 1;
  }
  return byClass;
}

interface GateCheck {
  id: string;
  pass: boolean;
  detail: string;
}

function evaluateD076Gate(input: {
  v2: H11EvaluationSummary;
  v3: H11EvaluationSummary;
  v3Observations: readonly FoldObservation[];
  loboSummaries: Array<{
    excludedBusiness: string;
    v3: H11EvaluationSummary;
  }>;
  unlabeledHighTestShareByAccount: Array<{
    accountId: string;
    share: number | null;
    highClassified: number;
  }>;
}): { checks: GateCheck[]; verdict: "PASS" | "REJECT" } {
  const checks: GateCheck[] = [];
  const v3HighAcc = input.v3.highConfidenceAccuracy;
  const v2HighAcc = input.v2.highConfidenceAccuracy;
  checks.push({
    id: "G1_high_confidence_accuracy",
    pass:
      input.v3.highConfidenceObservations >= 5 &&
      v3HighAcc !== null &&
      v3HighAcc >= 0.8 &&
      (v2HighAcc === null || v3HighAcc >= v2HighAcc),
    detail: `v3 high n=${input.v3.highConfidenceObservations} acc=${v3HighAcc?.toFixed(4) ?? "n/a"} vs v2 acc=${v2HighAcc?.toFixed(4) ?? "n/a"} (need n>=5, acc>=0.8, >=v2)`,
  });
  checks.push({
    id: "G2_false_test_high",
    pass: input.v3.falseTestHigh === 0,
    detail: `v3 falseTestHigh=${input.v3.falseTestHigh}`,
  });
  checks.push({
    id: "G3_false_test_any_non_inferior",
    pass: input.v3.falseTestAny <= input.v2.falseTestAny,
    detail: `v3 falseTestAny=${input.v3.falseTestAny} vs v2=${input.v2.falseTestAny}`,
  });
  const v3Coverage = input.v3.labelCoverage ?? 0;
  const v2Coverage = input.v2.labelCoverage ?? 0;
  checks.push({
    id: "G4_coverage",
    pass: v3Coverage >= v2Coverage - 0.05,
    detail: `v3 coverage=${v3Coverage.toFixed(4)} vs v2=${v2Coverage.toFixed(4)} (allow -0.05)`,
  });
  const highMixedOnMain = input.v3Observations.filter(
    (row) =>
      row.manualKind === "main" &&
      row.predictedKind === "mixed" &&
      row.confidenceClass === "high",
  ).length;
  checks.push({
    id: "G5_high_mixed_on_main",
    pass: highMixedOnMain === 0,
    detail: `v3 high-confidence mixed on main-labeled=${highMixedOnMain}`,
  });
  const loboFailures = input.loboSummaries.filter((entry) => {
    const acc = entry.v3.highConfidenceAccuracy;
    const g1 =
      entry.v3.highConfidenceObservations === 0 ||
      (acc !== null && acc >= 0.8);
    const g2 = entry.v3.falseTestHigh === 0;
    return !(g1 && g2);
  });
  checks.push({
    id: "G6_lobo_stability",
    pass: loboFailures.length === 0,
    detail:
      loboFailures.length === 0
        ? "no single-business exclusion flips G1/G2"
        : `flipped by excluding: ${loboFailures.map((entry) => entry.excludedBusiness).join(", ")}`,
  });
  const g7Violations = input.unlabeledHighTestShareByAccount.filter(
    (entry) => entry.share !== null && entry.share > 0.05,
  );
  checks.push({
    id: "G7_unlabeled_high_test_share",
    pass: g7Violations.length === 0,
    detail:
      g7Violations.length === 0
        ? "all accounts <=5% high-confidence Test share on unlabeled inventory"
        : g7Violations
            .map(
              (entry) =>
                `${entry.accountId}=${((entry.share ?? 0) * 100).toFixed(1)}% of ${entry.highClassified}`,
            )
            .join("; "),
  });
  return {
    checks,
    verdict: checks.every((check) => check.pass) ? "PASS" : "REJECT",
  };
}

function summaryLine(label: string, summary: H11EvaluationSummary): string {
  return (
    `${label}: labeled=${summary.uniqueLabeledCampaigns} classified=${summary.classifiedObservations}` +
    ` coverage=${summary.labelCoverage?.toFixed(4) ?? "n/a"} exactAcc=${summary.exactAccuracy?.toFixed(4) ?? "n/a"}` +
    ` [wilson ${summary.exactAccuracyWilson95 ? `${summary.exactAccuracyWilson95.lower.toFixed(3)}-${summary.exactAccuracyWilson95.upper.toFixed(3)}` : "n/a"}]` +
    ` high n=${summary.highConfidenceObservations} highAcc=${summary.highConfidenceAccuracy?.toFixed(4) ?? "n/a"}` +
    ` [wilson ${summary.highConfidenceWilson95 ? `${summary.highConfidenceWilson95.lower.toFixed(3)}-${summary.highConfidenceWilson95.upper.toFixed(3)}` : "n/a"}]` +
    ` falseTestAny=${summary.falseTestAny} falseTestHigh=${summary.falseTestHigh}` +
    ` manualTest=${summary.manualTest} testRecall=${summary.testRecall?.toFixed(4) ?? "n/a"}` +
    ` unresolved=${summary.unresolved} conflict=${summary.conflict}`
  );
}

function toScored(row: FoldObservation): H11ScoredObservation {
  return {
    id: row.id,
    businessId: row.businessId,
    accountId: row.accountId,
    campaignId: row.campaignId,
    date: row.date,
    manualKind: row.manualKind,
    predictedKind: row.predictedKind,
    confidenceClass: row.confidenceClass,
  };
}

async function runFull() {
  const bundle = loadBundle();
  const lines: string[] = [];
  const jsonOut: Record<string, unknown> = {
    contract: H11B_EVAL_CONTRACT_VERSION,
    bundleHash: bundle.bundleHash,
    trainAnchors: H11B_TRAIN_ANCHORS,
    validationAnchors: H11B_VALIDATION_ANCHORS,
    truthWindowDays: H11B_TRUTH_WINDOW_DAYS,
    candidates: {
      current_v2: CANDIDATES.current_v2.version,
      challenger_v3: CANDIDATES.challenger_v3.version,
    },
  };
  lines.push("# H11B context lifecycle challenger — current (v2) vs challenger (v3)");
  lines.push("");
  lines.push(`- bundleHash: ${bundle.bundleHash}`);
  lines.push(`- candidates: v2=${CANDIDATES.current_v2.version} v3=${CANDIDATES.challenger_v3.version}`);
  lines.push(`- truth window: ±${H11B_TRUTH_WINDOW_DAYS}d of label stamp`);
  lines.push("");

  const foldResults: Record<string, Record<CandidateId, FoldObservation[]>> = {};
  for (const [foldName, anchors] of [
    ["train", H11B_TRAIN_ANCHORS],
    ["validation", H11B_VALIDATION_ANCHORS],
  ] as const) {
    foldResults[foldName] = {} as Record<CandidateId, FoldObservation[]>;
    for (const candidateId of Object.keys(CANDIDATES) as CandidateId[]) {
      const { observations } = collectFoldObservations({
        bundle,
        anchors,
        classify: CANDIDATES[candidateId].classify,
      });
      foldResults[foldName][candidateId] = observations;
    }
  }

  const foldJson: Record<string, unknown> = {};
  for (const foldName of ["train", "validation"] as const) {
    lines.push(`## Fold: ${foldName}`);
    const perCandidate: Record<string, unknown> = {};
    for (const candidateId of Object.keys(CANDIDATES) as CandidateId[]) {
      const observations = foldResults[foldName][candidateId];
      const summary = summarizeH11Evaluation(observations.map(toScored));
      lines.push(`- ${summaryLine(candidateId, summary)}`);
      const matrix = confusionMatrix(observations);
      lines.push(
        `  confusion(manual->predicted): ${JSON.stringify(matrix)}`,
      );
      lines.push(
        `  calibration by class: ${JSON.stringify(classCalibration(observations))}`,
      );
      const perBusiness: Record<string, unknown> = {};
      for (const business of bundle.businesses) {
        const rows = observations.filter(
          (row) => row.accountId === business.providerAccountId,
        );
        if (rows.every((row) => row.manualKind === null)) continue;
        const businessSummary = summarizeH11Evaluation(rows.map(toScored));
        perBusiness[`${business.name}/${business.providerAccountId}`] =
          businessSummary;
        lines.push(
          `    ${summaryLine(`${business.name}/${business.providerAccountId}`, businessSummary)}`,
        );
      }
      perCandidate[candidateId] = {
        summary,
        confusion: matrix,
        calibration: classCalibration(observations),
        perBusiness,
      };
    }
    // Paired disagreement table between candidates on identical observations.
    const v2ByKey = new Map(
      foldResults[foldName].current_v2.map((row) => [
        `${row.accountId}:${row.campaignId}`,
        row,
      ]),
    );
    const disagreements = foldResults[foldName].challenger_v3
      .filter((row) => row.manualKind !== null)
      .map((row) => ({
        row,
        v2: v2ByKey.get(`${row.accountId}:${row.campaignId}`) ?? null,
      }))
      .filter(
        (pair) =>
          pair.v2 !== null &&
          (pair.v2.predictedKind !== pair.row.predictedKind ||
            pair.v2.confidenceClass !== pair.row.confidenceClass),
      );
    lines.push(`  labeled disagreements v2->v3: ${disagreements.length}`);
    for (const pair of disagreements) {
      lines.push(
        `    ${pair.row.businessName} ${pair.row.campaignId} label=${pair.row.manualKind}: v2=${pair.v2!.predictedKind ?? "null"}/${pair.v2!.confidenceClass} -> v3=${pair.row.predictedKind ?? "null"}/${pair.row.confidenceClass}`,
      );
    }
    lines.push("");
    foldJson[foldName] = perCandidate;
  }

  // Gate on the validation fold.
  const validationV2 = summarizeH11Evaluation(
    foldResults.validation.current_v2.map(toScored),
  );
  const validationV3 = summarizeH11Evaluation(
    foldResults.validation.challenger_v3.map(toScored),
  );
  const v3ValidationObservations = foldResults.validation.challenger_v3;
  const loboSummaries = bundle.businesses
    .map((business) => business.businessId)
    .filter((value, index, list) => list.indexOf(value) === index)
    .map((excludedBusinessId) => ({
      excludedBusiness:
        bundle.businesses.find(
          (business) => business.businessId === excludedBusinessId,
        )?.name ?? excludedBusinessId,
      v3: summarizeH11Evaluation(
        v3ValidationObservations
          .filter((row) => row.businessId !== excludedBusinessId)
          .map(toScored),
      ),
    }));
  const unlabeledHighTestShareByAccount = bundle.businesses.map((business) => {
    const rows = v3ValidationObservations.filter(
      (row) =>
        row.accountId === business.providerAccountId &&
        row.manualKind === null &&
        row.predictedKind !== null &&
        row.confidenceClass === "high",
    );
    const testRows = rows.filter((row) => row.predictedKind === "test");
    return {
      accountId: `${business.name}/${business.providerAccountId}`,
      share: rows.length > 0 ? testRows.length / rows.length : null,
      highClassified: rows.length,
    };
  });
  const gate = evaluateD076Gate({
    v2: validationV2,
    v3: validationV3,
    v3Observations: v3ValidationObservations,
    loboSummaries,
    unlabeledHighTestShareByAccount,
  });
  lines.push("## D076 predeclared gate (validation fold)");
  for (const check of gate.checks) {
    lines.push(`- [${check.pass ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  lines.push("");
  lines.push(`## VERDICT: ${gate.verdict}`);
  lines.push("");
  lines.push("### LOBO (validation, v3, excluding one business at a time)");
  for (const entry of loboSummaries) {
    lines.push(`- ${summaryLine(`without ${entry.excludedBusiness}`, entry.v3)}`);
  }
  jsonOut.folds = foldJson;
  jsonOut.gate = gate;
  jsonOut.lobo = loboSummaries;
  jsonOut.unlabeledHighTestShareByAccount = unlabeledHighTestShareByAccount;
  jsonOut.scriptHash = sha256(readFileSync(resolve(process.argv[1] ?? ""), "utf8"));

  const mdPath = resolve(
    "docs/creative-decision-center/H11B_CONTEXT_LIFECYCLE_CHALLENGER_2026-06-15_TO_2026-08-22.md",
  );
  const jsonPath = resolve(
    "docs/creative-decision-center/generated/h11b-context-lifecycle-eval.json",
  );
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `${lines.join("\n")}\n`);
  writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 1));
  console.log(
    lines
      .filter((line) => line.startsWith("- [") || line.startsWith("## "))
      .join("\n"),
  );
  console.log(`[h11b-eval] wrote ${mdPath}`);
}

async function main() {
  const mode = process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : "diagnose";
  if (mode === "diagnose") {
    await runDiagnose();
    return;
  }
  if (mode === "full") {
    await runFull();
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
