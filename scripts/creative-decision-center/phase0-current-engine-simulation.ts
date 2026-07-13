#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import { composeDataHealth } from "@/lib/creative-decision-engine/data-health";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import {
  ENGINE_VERSION,
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine/types";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_BUSINESS_IDENTIFIERS = ["IwaStore", "EMOLOS", "Grandmix", "TheSwaf"];
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/phase0-current-engine-simulation.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/PHASE0_CURRENT_ENGINE_SIMULATION_2026-07-02.md";

type CountMap = Record<string, number>;
type FreshnessMode = "wall_clock" | "historical";

type BusinessRow = Record<string, unknown> & {
  id: unknown;
  name: unknown;
};

type LatestSourceDateRow = Record<string, unknown> & {
  lifecycle_as_of_date: unknown;
  meta_as_of_date: unknown;
};

interface ParsedArgs {
  requestedAsOf: string;
  businessIdentifiers: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  sampleSize: number;
  freshnessMode: FreshnessMode;
}

interface BusinessIdentity {
  id: string;
  name: string;
}

interface SimulationDecisionRow {
  creativeId: string;
  creativeName: string | null;
  campaignId: string | null;
  campaignKind: DecisionOutput["campaignKind"];
  campaignLabelStatus: DecisionOutput["campaignLabelStatus"] | null;
  decisionKindSource: DecisionOutput["decisionKindSource"] | null;
  label: DecisionLabel;
  blockedActionType: DecisionOutput["blockedActionType"] | null;
  confidence: number;
  truthSource: DecisionOutput["truthSource"];
  ratioToTarget: number | null;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7dRoas: number | null;
  dataFreshnessHours: number | null;
  badges: string[];
  labelTransform: DecisionOutput["labelTransform"] | null;
  reason: string;
}

interface BusinessSimulationReview {
  status: "ok" | "failed" | "skipped";
  business: BusinessIdentity;
  requestedAsOf: string;
  simulationAsOf: string | null;
  freshnessMode: FreshnessMode;
  engineVersion: string;
  readOnly: true;
  mutatesData: false;
  flags: {
    enabled: boolean;
    surfaceVisible: boolean;
    shadowOnly: boolean;
    presetOverride: string | null;
    source: unknown;
  } | null;
  source: {
    creativeInputCount: number;
    dedupedDecisionCount: number;
    uniqueCampaignIds: number;
    campaignLabelsFound: number;
  } | null;
  profile: ReturnType<typeof summarizeProfile> | null;
  dataHealth: DataHealth | null;
  rawDataHealth: DataHealth | null;
  distributions: {
    label: CountMap;
    hardLabel: CountMap;
    blockedActionType: CountMap;
    campaignLabelStatus: CountMap;
    campaignKind: CountMap;
    decisionKindSource: CountMap;
    truthSource: CountMap;
    confidenceBucket: CountMap;
    badgeType: CountMap;
    labelTransform: CountMap;
    signalFamily: CountMap;
  } | null;
  risks: ReturnType<typeof summarizeRisks> | null;
  riskHints: string[];
  samples: SimulationDecisionRow[];
  errorMessage?: string;
}

interface SimulationReport {
  contractVersion: "adsecute.phase0.current-engine-simulation.v1";
  generatedAt: string;
  readOnly: true;
  mutatesData: false;
  requestedAsOf: string;
  freshnessMode: FreshnessMode;
  engineVersion: string;
  businessesRequested: string[];
  businessesFound: number;
  reviews: BusinessSimulationReview[];
  limitations: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    requestedAsOf: arg(argv, "asOf", "latest"),
    businessIdentifiers:
      csvArg(argv, "businesses") ?? [...DEFAULT_BUSINESS_IDENTIFIERS],
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    sampleSize: Math.max(1, Number(arg(argv, "sampleSize", "12")) || 12),
    freshnessMode: parseFreshnessMode(arg(argv, "freshnessMode", "wall_clock")),
  };
}

function parseFreshnessMode(value: string): FreshnessMode {
  return value === "historical" ? "historical" : "wall_clock";
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function csvArg(argv: string[], name: string) {
  const raw = arg(argv, name, "");
  if (!raw) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function findBusinesses(identifiers: readonly string[]) {
  const normalized = identifiers.map((item) => item.toLowerCase());
  const rows = await getDb().query<BusinessRow>(
    `
    SELECT id::text AS id, name
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
       OR id::text = ANY($2::text[])
    ORDER BY name ASC, id ASC
    `,
    [normalized, identifiers],
  );

  return rows.flatMap((row) => {
    const id = toText(row.id);
    const name = toText(row.name);
    return id && name ? [{ id, name }] : [];
  });
}

async function resolveSimulationAsOf(input: {
  businessId: string;
  requestedAsOf: string;
}) {
  if (isIsoDate(input.requestedAsOf)) return input.requestedAsOf;
  const [row] = await getDb().query<LatestSourceDateRow>(
    `
    SELECT
      (
        SELECT MAX(as_of_date)
        FROM engine_v3_creative_lifecycle_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $2
      ) AS lifecycle_as_of_date,
      (
        SELECT MAX(date)
        FROM meta_creative_daily
        WHERE business_ref_id = $1::uuid
      ) AS meta_as_of_date
    `,
    [input.businessId, ENGINE_VERSION],
  );

  return (
    normalizePostgresDate(row?.lifecycle_as_of_date) ??
    normalizePostgresDate(row?.meta_as_of_date)
  );
}

function increment(map: CountMap, key: string | null | undefined) {
  const normalized = key?.trim() || "null";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function confidenceBucket(confidence: number) {
  if (confidence < 50) return "00_49";
  if (confidence < 60) return "50_59";
  if (confidence < 70) return "60_69";
  if (confidence < 80) return "70_79";
  if (confidence < 90) return "80_89";
  return "90_100";
}

function isHardLabel(label: DecisionLabel) {
  return label === "scale" || label === "cut" || label === "refresh";
}

function badgeTypes(decision: DecisionOutput) {
  return decision.badges.map((badge) => badge.type);
}

const DECISION_LABEL_PRIORITY: Record<DecisionLabel, number> = {
  cut: 70,
  scale: 60,
  refresh: 50,
  diagnose: 40,
  test_more: 30,
  keep: 20,
  out_of_scope: 10,
};

function roundedConfidence(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function compareDecisionRows(left: SimulationDecisionRow, right: SimulationDecisionRow) {
  return (
    DECISION_LABEL_PRIORITY[right.label] - DECISION_LABEL_PRIORITY[left.label] ||
    roundedConfidence(right.confidence) - roundedConfidence(left.confidence) ||
    right.spend - left.spend ||
    left.creativeId.localeCompare(right.creativeId)
  );
}

function compareDecisionOutputs(
  left: { input: CreativeInput; decision: DecisionOutput },
  right: { input: CreativeInput; decision: DecisionOutput },
) {
  return (
    DECISION_LABEL_PRIORITY[left.decision.label] -
      DECISION_LABEL_PRIORITY[right.decision.label] ||
    roundedConfidence(left.decision.confidence) -
      roundedConfidence(right.decision.confidence) ||
    left.input.spend - right.input.spend ||
    (left.input.campaignId ?? "").localeCompare(right.input.campaignId ?? "")
  );
}

function dedupeDecisionComputations(
  computations: Array<{ input: CreativeInput; decision: DecisionOutput }>,
) {
  const byCreativeId = new Map<string, { input: CreativeInput; decision: DecisionOutput }>();
  for (const computation of computations) {
    const current = byCreativeId.get(computation.input.creativeId);
    if (!current || compareDecisionOutputs(computation, current) > 0) {
      byCreativeId.set(computation.input.creativeId, computation);
    }
  }
  return Array.from(byCreativeId.values()).sort((left, right) =>
    left.input.creativeId.localeCompare(right.input.creativeId),
  );
}

function summarizeProfile(profile: AccountDecisionProfile) {
  return {
    preset: profile.preset,
    presetSource: profile.presetSource,
    spendUnit: profile.spendUnit,
    spendUnitSource: profile.spendUnitSource,
    spendUnitConfidence: profile.spendUnitConfidence,
    thresholds: profile.thresholds,
    hardActionEligibility: profile.hardActionEligibility,
    quality: profile.quality,
    accountBaselines: {
      matureCreativeCount: profile.accountBaselines.matureCreativeCount,
      roasRatioP10: profile.accountBaselines.roasRatioP10,
      roasRatioP25: profile.accountBaselines.roasRatioP25,
      roasRatioP50: profile.accountBaselines.roasRatioP50,
      roasRatioP75: profile.accountBaselines.roasRatioP75,
      winnerPurchaseP50: profile.accountBaselines.winnerPurchaseP50,
      metaAovQuality: profile.accountBaselines.metaAovQuality,
    },
    scope: profile.scope,
  };
}

function toDecisionRow(input: CreativeInput, decision: DecisionOutput): SimulationDecisionRow {
  return {
    creativeId: input.creativeId,
    creativeName: input.creativeName,
    campaignId: input.campaignId,
    campaignKind: decision.campaignKind ?? null,
    campaignLabelStatus: decision.campaignLabelStatus ?? null,
    decisionKindSource: decision.decisionKindSource ?? null,
    label: decision.label,
    blockedActionType: decision.blockedActionType ?? null,
    confidence: decision.confidence,
    truthSource: decision.truthSource,
    ratioToTarget: decision.ratioToTarget,
    spend: input.spend,
    purchases: input.purchases,
    roas: input.roas,
    recent7dRoas: input.recent7dRoas,
    dataFreshnessHours: input.dataFreshnessHours,
    badges: badgeTypes(decision),
    labelTransform: decision.labelTransform ?? null,
    reason: decision.reason,
  };
}

function summarizeDistributions(rows: SimulationDecisionRow[]) {
  const distributions = {
    label: {},
    hardLabel: {},
    blockedActionType: {},
    campaignLabelStatus: {},
    campaignKind: {},
    decisionKindSource: {},
    truthSource: {},
    confidenceBucket: {},
    badgeType: {},
    labelTransform: {},
    signalFamily: {},
  } satisfies BusinessSimulationReview["distributions"];

  for (const row of rows) {
    increment(distributions.label, row.label);
    if (isHardLabel(row.label)) increment(distributions.hardLabel, row.label);
    increment(distributions.blockedActionType, row.blockedActionType);
    increment(distributions.campaignLabelStatus, row.campaignLabelStatus);
    increment(distributions.campaignKind, row.campaignKind);
    increment(distributions.decisionKindSource, row.decisionKindSource);
    increment(distributions.truthSource, row.truthSource);
    increment(distributions.confidenceBucket, confidenceBucket(row.confidence));
    for (const badge of row.badges) increment(distributions.badgeType, badge);
    increment(distributions.labelTransform, row.labelTransform);
    increment(distributions.signalFamily, classifySignalFamilyFromRow(row));
  }

  return distributions;
}

function classifySignalFamilyFromRow(row: SimulationDecisionRow) {
  const badges = new Set(row.badges);
  if (badges.has("policy_blocked")) return "policy";
  if (badges.has("delivery_no_spend_24h") || badges.has("delivery_limited")) return "delivery";
  if (badges.has("launch_monitoring")) return "launch_monitoring";
  if (
    badges.has("stale_evidence") ||
    badges.has("tracking_anomaly") ||
    badges.has("lifecycle_unavailable")
  ) {
    return "data_health";
  }
  if (badges.has("scale_readiness_blocked") || badges.has("scale_calibration_thin")) {
    return "scale_readiness";
  }
  if (badges.has("fatigue_watch") || badges.has("fatigue_fatigued")) return "fatigue";
  if (badges.has("unlabeled_campaign_context")) return "campaign_label";
  if (row.label === "cut" || badges.has("weak_performance")) return "performance_loser";
  if (row.label === "scale") return "performance_winner";
  if (row.label === "test_more") return "insufficient_signal";
  if (row.label === "keep") return "keep";
  return row.label;
}

function countRows(
  rows: SimulationDecisionRow[],
  predicate: (row: SimulationDecisionRow) => boolean,
) {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0);
}

function summarizeRisks(rows: SimulationDecisionRow[], profile: AccountDecisionProfile) {
  return {
    hardActionRows: countRows(rows, (row) => isHardLabel(row.label)),
    blockedHardActionRows: countRows(
      rows,
      (row) => row.label === "diagnose" && row.blockedActionType !== null,
    ),
    unlabeledOrNoCampaignRows: countRows(
      rows,
      (row) => row.campaignLabelStatus === "unlabeled" || row.campaignLabelStatus === "no_campaign",
    ),
    staleEvidenceRows: countRows(rows, (row) => row.badges.includes("stale_evidence")),
    staleHardActionRows: countRows(
      rows,
      (row) => isHardLabel(row.label) && row.badges.includes("stale_evidence"),
    ),
    nullFreshnessRows: countRows(rows, (row) => row.dataFreshnessHours === null),
    globalDefaultTruthRows: countRows(rows, (row) => row.truthSource === "global_default"),
    accountBaselineTruthRows: countRows(
      rows,
      (row) => row.truthSource === "account_baseline" || row.truthSource === "account_baseline_thin",
    ),
    highConfidenceHardRows: countRows(
      rows,
      (row) => isHardLabel(row.label) && row.confidence >= 80,
    ),
    highConfidenceHardWithoutCommercialTruthRows: countRows(
      rows,
      (row) =>
        isHardLabel(row.label) &&
        row.confidence >= 80 &&
        row.truthSource !== "commercial_truth",
    ),
    scaleReadinessBlockedRows: countRows(
      rows,
      (row) => row.badges.includes("scale_readiness_blocked"),
    ),
    scaleCalibrationThinRows: countRows(
      rows,
      (row) => row.badges.includes("scale_calibration_thin"),
    ),
    lowCtrHardRows: countRows(
      rows,
      (row) => isHardLabel(row.label) && row.badges.includes("low_ctr"),
    ),
    labelTransformRows: countRows(rows, (row) => row.labelTransform !== null),
    cutBoundary: {
      bottomQuartileRatio: profile.thresholds.bottomQuartileRatio,
      severeLoserRatio: profile.thresholds.severeLoserRatio,
      commercialMaturitySpend: profile.thresholds.commercialMaturitySpend,
      hardCutSpend: profile.thresholds.hardCutSpend,
    },
  };
}

function buildRiskHints(input: {
  rows: SimulationDecisionRow[];
  profile: AccountDecisionProfile;
  risks: ReturnType<typeof summarizeRisks>;
  dataHealth: DataHealth;
  rawDataHealth: DataHealth;
  flags: Awaited<ReturnType<typeof resolveEngineV3Flags>>;
  freshnessMode: FreshnessMode;
}) {
  const hints: string[] = [];
  const { risks, profile } = input;

  if (!input.flags.enabled) {
    hints.push("engine_flag_disabled_actual_job_would_not_write_snapshots");
  }
  if (input.freshnessMode === "historical") {
    hints.push("historical_freshness_normalized_not_actual_runtime");
  }
  if (input.flags.shadowOnly) {
    hints.push("shadow_only_flags_block_hard_actions");
  }
  if (risks.blockedHardActionRows > 0) {
    hints.push("campaign_label_guard_is_blocking_hard_actions");
  }
  if (risks.staleEvidenceRows > 0 || input.dataHealth.worstTier !== "none") {
    hints.push("freshness_can_dominate_formula_replay");
  }
  if (
    input.freshnessMode === "historical" &&
    input.rawDataHealth.worstTier !== "none"
  ) {
    hints.push("raw_wall_clock_data_health_was_stale");
  }
  if (risks.nullFreshnessRows > 0) {
    hints.push("null_data_freshness_rows_need_explicit_unknown_handling");
  }
  if (risks.globalDefaultTruthRows > 0) {
    hints.push("global_default_truth_used_confidence_should_remain_capped");
  }
  if (risks.highConfidenceHardWithoutCommercialTruthRows > 0) {
    hints.push("hard_actions_high_confidence_without_commercial_truth");
  }
  if (risks.scaleReadinessBlockedRows > 0 || risks.scaleCalibrationThinRows > 0) {
    hints.push("scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action");
  }
  if (profile.thresholds.bottomQuartileRatio !== null && profile.thresholds.bottomQuartileRatio >= 0.85) {
    hints.push("cut_boundary_is_close_to_target_and_may_over_cut_near_target_rows");
  }
  if (profile.thresholds.bottomQuartileRatio !== null && profile.thresholds.bottomQuartileRatio <= 0.45) {
    hints.push("cut_boundary_is_loose_and_may_miss_weak_losers");
  }
  if (!profile.hardActionEligibility.cut || !profile.hardActionEligibility.scale) {
    hints.push("hard_action_eligibility_not_fully_ready_for_account");
  }
  if (input.rows.length === 0) {
    hints.push("no_creative_inputs_available_for_replay");
  }

  return hints;
}

async function readCampaignLabelsById(input: {
  businessId: string;
  creativeInputs: CreativeInput[];
}) {
  const campaignIds = Array.from(
    new Set(
      input.creativeInputs
        .map((creativeInput) => creativeInput.campaignId?.trim() ?? "")
        .filter(Boolean),
    ),
  );
  if (campaignIds.length === 0) {
    return {
      campaignIds,
      labelsFound: 0,
      map: buildCreativeCampaignLabelMap([]),
    };
  }
  const labels = await readMetaCampaignLabels({
    businessId: input.businessId,
    campaignIds,
  });
  return {
    campaignIds,
    labelsFound: labels.length,
    map: buildCreativeCampaignLabelMap(labels),
  };
}

function normalizeDataHealthForHistoricalReplay(
  dataHealth: DataHealth,
  asOf: string,
): DataHealth {
  const normalizeLayer = (layer: DataHealth["calibration"]) => ({
    ...layer,
    asOfDate: layer.asOfDate ?? asOf,
    sourceFreshnessHours:
      layer.sourceFreshnessHours === null ? null : 0,
    staleTier: "none" as const,
    note: layer.note
      ? `${layer.note}; historical replay freshness normalized`
      : "historical replay freshness normalized",
  });

  return composeDataHealth({
    calibration: normalizeLayer(dataHealth.calibration),
    lifecycle: normalizeLayer(dataHealth.lifecycle),
    decisions: normalizeLayer(dataHealth.decisions),
  });
}

function normalizeCreativeInputsForHistoricalReplay(
  inputs: CreativeInput[],
): CreativeInput[] {
  return inputs.map((input) => ({
    ...input,
    dataFreshnessHours:
      input.dataFreshnessHours === null
        ? null
        : Math.min(input.dataFreshnessHours, 6),
  }));
}

async function simulateBusiness(input: {
  business: BusinessIdentity;
  requestedAsOf: string;
  sampleSize: number;
  freshnessMode: FreshnessMode;
}): Promise<BusinessSimulationReview> {
  const simulationAsOf = await resolveSimulationAsOf({
    businessId: input.business.id,
    requestedAsOf: input.requestedAsOf,
  });
  if (simulationAsOf === null) {
    return {
      status: "skipped",
      business: input.business,
      requestedAsOf: input.requestedAsOf,
      simulationAsOf: null,
      freshnessMode: input.freshnessMode,
      engineVersion: ENGINE_VERSION,
      readOnly: true,
      mutatesData: false,
      flags: null,
      source: null,
      profile: null,
      dataHealth: null,
      rawDataHealth: null,
      distributions: null,
      risks: null,
      riskHints: ["no_lifecycle_or_meta_source_date_available"],
      samples: [],
    };
  }

  try {
    const dataSource = new WarehouseDataSource();
    const flags = await resolveEngineV3Flags(input.business.id);
    const profile = await resolveAccountDecisionProfile({
      businessId: input.business.id,
      asOf: simulationAsOf,
      dataSource,
      flags,
    });
    const rawDataHealth = await dataSource.getDataHealth({
      businessId: input.business.id,
      asOf: simulationAsOf,
    });
    const rawCreativeInputs = await dataSource.listCreativeInputs({
      businessId: input.business.id,
      asOf: simulationAsOf,
    });
    const dataHealth =
      input.freshnessMode === "historical"
        ? normalizeDataHealthForHistoricalReplay(rawDataHealth, simulationAsOf)
        : rawDataHealth;
    const creativeInputs =
      input.freshnessMode === "historical"
        ? normalizeCreativeInputsForHistoricalReplay(rawCreativeInputs)
        : rawCreativeInputs;
    const campaignLabels = await readCampaignLabelsById({
      businessId: input.business.id,
      creativeInputs,
    });

    const rawComputations = creativeInputs.map((creativeInput) => {
      const inputWithCampaignKind = withCreativeCampaignLabelContext(
        creativeInput,
        campaignLabels.map,
      );
      const decision = applyCreativeCampaignLabelGuard({
        decision: decideCreative(inputWithCampaignKind, profile, dataHealth),
        input: inputWithCampaignKind,
        campaignLabelsById: campaignLabels.map,
      });
      return { input: inputWithCampaignKind, decision };
    });
    const computations = dedupeDecisionComputations(rawComputations);
    const rows = computations.map(({ input: creativeInput, decision }) =>
      toDecisionRow(creativeInput, decision),
    );
    const risks = summarizeRisks(rows, profile);

    return {
      status: "ok",
      business: input.business,
      requestedAsOf: input.requestedAsOf,
      simulationAsOf,
      freshnessMode: input.freshnessMode,
      engineVersion: ENGINE_VERSION,
      readOnly: true,
      mutatesData: false,
      flags: {
        enabled: flags.enabled,
        surfaceVisible: flags.surfaceVisible,
        shadowOnly: flags.shadowOnly,
        presetOverride: flags.presetOverride,
        source: flags.source,
      },
      source: {
        creativeInputCount: creativeInputs.length,
        dedupedDecisionCount: rows.length,
        uniqueCampaignIds: campaignLabels.campaignIds.length,
        campaignLabelsFound: campaignLabels.labelsFound,
      },
      profile: summarizeProfile(profile),
      dataHealth,
      rawDataHealth,
      distributions: summarizeDistributions(rows),
      risks,
      riskHints: buildRiskHints({
        rows,
        profile,
        risks,
        dataHealth,
        rawDataHealth,
        flags,
        freshnessMode: input.freshnessMode,
      }),
      samples: rows
        .filter((row) => isHardLabel(row.label) || row.blockedActionType !== null)
        .sort(compareDecisionRows)
        .slice(0, input.sampleSize),
    };
  } catch (error) {
    return {
      status: "failed",
      business: input.business,
      requestedAsOf: input.requestedAsOf,
      simulationAsOf,
      freshnessMode: input.freshnessMode,
      engineVersion: ENGINE_VERSION,
      readOnly: true,
      mutatesData: false,
      flags: null,
      source: null,
      profile: null,
      dataHealth: null,
      rawDataHealth: null,
      distributions: null,
      risks: null,
      riskHints: ["business_replay_failed"],
      samples: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatCountMap(map: CountMap | null | undefined) {
  if (!map || Object.keys(map).length === 0) return "-";
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "null";
  if (!Number.isFinite(value)) return "null";
  return Number(value.toFixed(4)).toString();
}

function escapeCell(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function renderMarkdown(report: SimulationReport) {
  const lines: string[] = [];
  lines.push("# Phase 0 - Current Engine Simulation");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Requested asOf: ${report.requestedAsOf}`);
  lines.push(`Freshness mode: ${report.freshnessMode}`);
  lines.push(`Engine version: ${report.engineVersion}`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(
    "- Read-only replay: no DB writes, no snapshot upsert, no decision event insert.",
  );
  lines.push(
    "- Uses the current WarehouseDataSource + current account profile + current decideCreative pipeline.",
  );
  if (report.freshnessMode === "historical") {
    lines.push(
      "- Analysis-only historical mode normalizes freshness to the simulated date so formula output is not dominated by wall-clock staleness.",
    );
  }
  lines.push(
    "- If requested asOf is `latest`, each business uses its latest available lifecycle date, falling back to latest Meta creative date.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "| Business | Status | Simulated asOf | Freshness | Inputs | Decisions | Labels | Blocked hard | Confidence | Risk hints |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---|---:|---|---|");
  for (const review of report.reviews) {
    lines.push(
      [
        review.business.name,
        review.status,
        review.simulationAsOf ?? "null",
        review.freshnessMode,
        review.source?.creativeInputCount ?? 0,
        review.source?.dedupedDecisionCount ?? 0,
        formatCountMap(review.distributions?.label),
        review.risks?.blockedHardActionRows ?? 0,
        formatCountMap(review.distributions?.confidenceBucket),
        review.riskHints.join(", ") || "-",
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }

  for (const review of report.reviews) {
    lines.push("");
    lines.push(`## ${review.business.name}`);
    lines.push("");
    if (review.status !== "ok") {
      lines.push(`Status: ${review.status}`);
      if (review.errorMessage) lines.push(`Error: ${review.errorMessage}`);
      lines.push(`Risk hints: ${review.riskHints.join(", ") || "-"}`);
      continue;
    }

    lines.push(`Business ID: ${review.business.id}`);
    lines.push(`Simulated asOf: ${review.simulationAsOf}`);
    lines.push(`Freshness mode: ${review.freshnessMode}`);
    lines.push(
      `Flags: enabled=${review.flags?.enabled}, surfaceVisible=${review.flags?.surfaceVisible}, shadowOnly=${review.flags?.shadowOnly}, presetOverride=${review.flags?.presetOverride ?? "null"}`,
    );
    lines.push(
      `Profile: preset=${review.profile?.preset}, spendUnit=${formatNumber(review.profile?.spendUnit)}, source=${review.profile?.spendUnitSource}, confidence=${review.profile?.spendUnitConfidence}`,
    );
    lines.push(
      `Thresholds: commercialMaturity=${formatNumber(review.profile?.thresholds.commercialMaturitySpend)}, hardCut=${formatNumber(review.profile?.thresholds.hardCutSpend)}, scaleMinPurchases=${review.profile?.thresholds.scaleMinPurchases ?? "null"}, bottomQuartileRatio=${formatNumber(review.profile?.thresholds.bottomQuartileRatio)}, severeLoserRatio=${formatNumber(review.profile?.thresholds.severeLoserRatio)}`,
    );
    lines.push(
      `Data health: worst=${review.dataHealth?.worstTier}, degraded=${review.dataHealth?.degraded}`,
    );
    if (review.rawDataHealth) {
      lines.push(
        `Raw wall-clock data health: worst=${review.rawDataHealth.worstTier}, degraded=${review.rawDataHealth.degraded}`,
      );
    }
    lines.push("");
    lines.push("Distributions:");
    lines.push(`- label: ${formatCountMap(review.distributions?.label)}`);
    lines.push(`- signalFamily: ${formatCountMap(review.distributions?.signalFamily)}`);
    lines.push(`- badgeType: ${formatCountMap(review.distributions?.badgeType)}`);
    lines.push(`- labelTransform: ${formatCountMap(review.distributions?.labelTransform)}`);
    lines.push(`- truthSource: ${formatCountMap(review.distributions?.truthSource)}`);
    lines.push(`- campaignLabelStatus: ${formatCountMap(review.distributions?.campaignLabelStatus)}`);
    lines.push("");
    lines.push("Risk counters:");
    lines.push(`- hardActionRows: ${review.risks?.hardActionRows ?? 0}`);
    lines.push(`- blockedHardActionRows: ${review.risks?.blockedHardActionRows ?? 0}`);
    lines.push(`- staleEvidenceRows: ${review.risks?.staleEvidenceRows ?? 0}`);
    lines.push(`- nullFreshnessRows: ${review.risks?.nullFreshnessRows ?? 0}`);
    lines.push(`- highConfidenceHardWithoutCommercialTruthRows: ${review.risks?.highConfidenceHardWithoutCommercialTruthRows ?? 0}`);
    lines.push(`- scaleReadinessBlockedRows: ${review.risks?.scaleReadinessBlockedRows ?? 0}`);
    lines.push(`- scaleCalibrationThinRows: ${review.risks?.scaleCalibrationThinRows ?? 0}`);
    lines.push(`- hints: ${review.riskHints.join(", ") || "-"}`);

    if (review.samples.length > 0) {
      lines.push("");
      lines.push("Sample hard/blocker rows:");
      lines.push(
        "| Creative | Campaign | Label | Blocked | Confidence | Spend | Purchases | ROAS | Ratio | Badges | Reason |",
      );
      lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|");
      for (const row of review.samples) {
        lines.push(
          [
            row.creativeId,
            row.campaignId ?? "null",
            row.label,
            row.blockedActionType ?? "null",
            formatNumber(row.confidence),
            formatNumber(row.spend),
            formatNumber(row.purchases),
            formatNumber(row.roas),
            formatNumber(row.ratioToTarget),
            row.badges.join(", "),
            row.reason,
          ]
            .map(escapeCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        );
      }
    }
  }

  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeTextFile(path: string, content: string) {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const businesses = await findBusinesses(args.businessIdentifiers);
  const reviews: BusinessSimulationReview[] = [];

  for (const business of businesses) {
    reviews.push(
      await simulateBusiness({
        business,
        requestedAsOf: args.requestedAsOf,
        sampleSize: args.sampleSize,
        freshnessMode: args.freshnessMode,
      }),
    );
  }

  const report: SimulationReport = {
    contractVersion: "adsecute.phase0.current-engine-simulation.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutatesData: false,
    requestedAsOf: args.requestedAsOf,
    freshnessMode: args.freshnessMode,
    engineVersion: ENGINE_VERSION,
    businessesRequested: args.businessIdentifiers,
    businessesFound: businesses.length,
    reviews,
    limitations: [
      "This is a replay of the current engine pipeline; it does not change formulas or persist decisions.",
      "The report measures output distribution and guard pressure, not outcome precision or causal correctness.",
      "Historical rows may be marked stale because the current data-source computes freshness against wall-clock now.",
      "Historical freshness mode is analysis-only; actual runtime still uses wall-clock freshness.",
      "If a business has no lifecycle/meta source date, no formula conclusion should be drawn for that business.",
    ],
  };

  const json = JSON.stringify(report, null, 2);
  const markdown = renderMarkdown(report);

  if (args.writeFiles) {
    const jsonPath = writeTextFile(args.jsonOut, json);
    const mdPath = writeTextFile(args.mdOut, markdown);
    console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
  } else {
    console.log(json);
  }
}

withOperationalStartupLogsSilenced(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
