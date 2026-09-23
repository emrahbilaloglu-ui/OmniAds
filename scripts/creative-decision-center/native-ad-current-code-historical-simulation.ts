/**
 * Read-only historical simulation of the CURRENT native Meta decision chain.
 *
 * WHAT THIS IS. Orchestration only: the calibration batch, hydration, profile
 * resolution, campaign-role map, prior-label read, ready/soft-only decision
 * computation and the empty-hydration guard are the PRODUCTION functions,
 * imported from `jobs/ad-decisions-job.ts` and `jobs/ad-calibration-job.ts`
 * and called the way `runAdDecisionsJob` calls them. This file holds no
 * thresholds and no resolver logic. It persists nothing and contacts no
 * provider.
 *
 * WHAT IT IS NOT, and the receipt says so field by field:
 *
 * - not the integrated persisted job. Calibration is RECOMPUTED in memory at
 *   the simulated cutoff, whereas the job reads the persisted batch of its
 *   dependency run; evaluations, snapshots, change events, pruning and the
 *   job-run ledger are never produced;
 * - not the POLICY that was in force at the cutoff. Engine flags have no
 *   history (`business_engine_v3_flags` holds the current row; defaults come
 *   from the environment of THIS process), so the current policy is applied;
 * - not provider proof of anything.
 *
 * POINT-IN-TIME. Every production reader it calls is bounded by the simulated
 * cutoff: hydration via `decisionCutoff`, calibration and target authority via
 * their cutoff parameter, and the campaign-role map and prior published labels
 * via `visibleAtCutoff`. Those two tables are upserted in place, so a row that
 * existed at the cutoff but was rewritten afterwards is WITHHELD and counted,
 * never replaced by an older day the job did not read.
 *
 * CHAINED DAYS. Hysteresis publishes a hard label only on its second
 * consecutive evaluation, and prior labels are read only under the CURRENT
 * engine epoch. For an epoch that has never run in production no persisted
 * prior exists, so a single simulated day can only ever publish "keep" for a
 * hard verdict. `--cutoff` therefore accepts an ascending list of cutoffs, one
 * per day; each simulated day's published labels are carried in memory as the
 * next day's prior, exactly as the persisted row would have been.
 *
 * The database session must already be read-only, every read shares one
 * pinned REPEATABLE READ snapshot, and artifact output requires both
 * `--write 1` and `--out`.
 */
import { writeFileSync } from "node:fs";

import {
  type NativeAdCalibrationCellQuery,
  type NativeAdAccountProfileDataSource,
} from "@/lib/creative-decision-engine/ad-account-decision-profile";
import {
  resolveCampaignContextMode,
  type CampaignContextPitExclusion,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import {
  buildCanonicalEvaluationProvenance,
  type BuildCanonicalEvaluationInput,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import {
  assertAdCanonicalEvaluationProvenance,
  buildAdCanonicalEvaluationProvenance,
  type AdCanonicalEvaluationProvenance,
} from "@/lib/creative-decision-engine/evaluation-store";
import {
  adDecisionStabilityKey,
  readPreviousPublishedAdLabels,
  type PreviousAdPublishedLabel,
  type PreviousLabelPitExclusion,
} from "@/lib/creative-decision-engine/decision-stability";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import {
  LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  computeNativeAdCalibrationBatch,
  mapNativeAdCalibrationSourceRow,
  mapNativeAdTargetAuthorityRow,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationCell,
  type NativeAdTargetAuthorityInput,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  assertEmptyNativeAdHydrationIsAuthoritative,
  buildNativeAdDataHealth,
  computeReadyNativeAdDecisions,
  computeSoftOnlyNativeAdDecisions,
  groupNativeProfileInputsByScope,
  mergeUniqueMap,
  readAdCampaignContext,
  resolveNativeAdDecisionProfileGroups,
  resolveNativeAdFrequencyPressureThresholdsByAccount,
  toNativeSnapshotPayload,
  type AdDecisionComputation,
  type NativeAdDecisionProfileGroup,
  type NativeAdProfileRuntimeDataSource,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import {
  NATIVE_AD_ENGINE_VERSION,
  type DecisionLabel,
} from "@/lib/creative-decision-engine/types";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";

import { configureOperationalScriptRuntime } from "../_operational-runtime";
import { pinReadOnlySnapshot, type PinnedReadOnlySnapshot } from "./read-only-snapshot";

export class NativeDecisionSimulationUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeDecisionSimulationUsageError";
  }
}

export interface SimulatedDay {
  asOf: string;
  cutoff: string;
}

export interface NativeDecisionSimulationArgs {
  businessId: string;
  /** The LAST simulated day. */
  asOf: string;
  /** The LAST simulated day's cutoff. */
  cutoff: string;
  /** Every simulated day, ascending; the last entry is `{ asOf, cutoff }`. */
  chain: SimulatedDay[];
  outPath: string | null;
  write: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A chain longer than this is a batch job, not a replay of a decision. */
export const MAX_SIMULATED_DAYS = 14;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function valueAfter(argv: string[], flag: string): string | null {
  const index = argv.indexOf(`--${flag}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new NativeDecisionSimulationUsageError(`--${flag} requires a value.`);
  }
  return value;
}

export function parseNativeDecisionSimulationArgs(
  argv: string[],
): NativeDecisionSimulationArgs {
  const businessId = valueAfter(argv, "business")?.trim() ?? "";
  const asOf = valueAfter(argv, "asOf")?.trim() ?? "";
  const cutoffList = (valueAfter(argv, "cutoff") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const outPath = valueAfter(argv, "out")?.trim() || null;
  const write = valueAfter(argv, "write") === "1";
  if (!businessId) {
    throw new NativeDecisionSimulationUsageError("--business is required.");
  }
  if (!validDate(asOf)) {
    throw new NativeDecisionSimulationUsageError("--asOf must be a real ISO date.");
  }
  if (cutoffList.length === 0) {
    throw new NativeDecisionSimulationUsageError(
      "--cutoff must be a canonical ISO timestamp.",
    );
  }
  if (cutoffList.length > MAX_SIMULATED_DAYS) {
    throw new NativeDecisionSimulationUsageError(
      `--cutoff accepts at most ${MAX_SIMULATED_DAYS} chained days.`,
    );
  }
  const chain: SimulatedDay[] = [];
  for (const cutoff of cutoffList) {
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || new Date(cutoffMs).toISOString() !== cutoff) {
      throw new NativeDecisionSimulationUsageError(
        "--cutoff must be a canonical ISO timestamp.",
      );
    }
    const day = cutoff.slice(0, 10);
    const previous = chain.at(-1);
    if (previous && (cutoff <= previous.cutoff || day <= previous.asOf)) {
      throw new NativeDecisionSimulationUsageError(
        "--cutoff days must be strictly ascending, one cutoff per UTC day.",
      );
    }
    chain.push({ asOf: day, cutoff });
  }
  const last = chain.at(-1)!;
  if (last.asOf !== asOf) {
    throw new NativeDecisionSimulationUsageError(
      "--cutoff must fall on --asOf in UTC, matching native calibration.",
    );
  }
  if (write && outPath === null) {
    throw new NativeDecisionSimulationUsageError(
      "--write 1 requires --out; database writes are never supported.",
    );
  }
  return { businessId, asOf, cutoff: last.cutoff, chain, outPath, write };
}

export async function assertSimulationSessionReadOnly(db: DbClient): Promise<void> {
  const rows = await db.query<Record<string, unknown>>(
    "SHOW default_transaction_read_only",
  );
  if (String(rows[0]?.default_transaction_read_only ?? "").toLowerCase() !== "on") {
    throw new NativeDecisionSimulationUsageError(
      'Historical decision simulation requires PGOPTIONS="-c default_transaction_read_only=on".',
    );
  }
}

interface ProviderBinding {
  providerAccountRefId: string;
  providerAccountId: string;
}

function providerBindings(rows: readonly Record<string, unknown>[]): ProviderBinding[] {
  return rows.map((row) => ({
    providerAccountRefId: String(row.provider_account_ref_id ?? "").trim(),
    providerAccountId: String(row.provider_account_id ?? "").trim(),
  })).filter((row) => row.providerAccountRefId && row.providerAccountId);
}

function simulatedBatchId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

/** Makes an in-memory computed cell pass the same complete-batch checks as a persisted one. */
function completeSimulationCells(
  batches: readonly NativeAdCalibrationBatch[],
): NativeAdCalibrationCell[] {
  return batches.flatMap((batch, index) =>
    batch.cells.map((cell) => ({
      ...cell,
      batchId: simulatedBatchId(index),
      batchCompleteness: "complete" as const,
    })),
  );
}

function profileCellMatches(
  cell: NativeAdCalibrationCell,
  query: NativeAdCalibrationCellQuery,
): boolean {
  return cell.key.businessId === query.businessId &&
    cell.key.providerAccountId === query.providerAccountId &&
    cell.key.accountTimezone === query.accountTimezone &&
    cell.key.accountCurrency === query.accountCurrency &&
    cell.key.cellScope === query.cellScope &&
    cell.key.objective === query.objective &&
    cell.key.cohort === query.cohort &&
    cell.key.optimizationContext === query.optimizationContext &&
    cell.asOfDate === query.asOfDate &&
    cell.engineVersion === query.engineVersion &&
    cell.policyVersion === query.policyVersion;
}

class InMemoryNativeProfileDataSource
  implements NativeAdAccountProfileDataSource, NativeAdProfileRuntimeDataSource {
  constructor(
    private readonly cells: NativeAdCalibrationCell[],
    private readonly targets: ReadonlyMap<string, NativeAdTargetAuthorityInput | null>,
  ) {}

  async getNativeAdCalibrationCell(
    query: NativeAdCalibrationCellQuery,
  ): Promise<NativeAdCalibrationCell | null> {
    return this.cells.find((cell) => profileCellMatches(cell, query)) ?? null;
  }

  async getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }): Promise<NativeAdTargetAuthorityInput | null> {
    return this.targets.get(
      `${input.providerAccountRefId}\u0000${input.providerAccountId}`,
    ) ?? null;
  }

  async getNativeCalibrationRowId(cell: NativeAdCalibrationCell): Promise<string> {
    return `read-only-simulation:${cell.inputManifestHash}`;
  }
}

function countBy<T>(rows: readonly T[], select: (row: T) => unknown) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(select(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/* ------------------------------------------------------------------ policy */

export interface SimulationPolicy {
  /** When the policy was read: the simulation's run time, not the cutoff. */
  resolvedAt: "simulation_run_time_not_point_in_time";
  flags: EngineV3Flags;
  /**
   * Flags that came from this PROCESS's environment rather than the business
   * row. They describe the machine running the simulation, which need not be
   * the one production runs on.
   */
  envDerivedFlags: string[];
}

export function describeSimulationPolicy(flags: EngineV3Flags): SimulationPolicy {
  const envDerivedFlags = (["enabled", "surfaceVisible", "shadowOnly"] as const)
    .filter((name) => flags.source?.[name] !== "business_override");
  return {
    resolvedAt: "simulation_run_time_not_point_in_time",
    flags,
    envDerivedFlags,
  };
}

/* -------------------------------------------------------------- hysteresis */

/** Same canonical envelopes as the production job; only storage is omitted. */
export function buildSimulationEvaluation(input: {
  computation: AdDecisionComputation;
  profile: NativeAdDecisionProfileGroup["profile"];
  dataHealth: BuildCanonicalEvaluationInput["dataHealth"];
  flags: EngineV3Flags;
  evaluatedAt: string;
}): AdCanonicalEvaluationProvenance {
  const { computation } = input;
  return buildAdCanonicalEvaluationProvenance({
    identity: {
      providerAccountRefId: computation.input.providerAccountRefId,
      providerAccountId: computation.input.providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId: computation.input.decisionEntityId,
      adId: computation.input.adId,
      creativeId: computation.input.creativeId,
    },
    adEvidence: {
      customConversionId: computation.input.customConversionId,
      configAuthority: computation.input.configAuthority,
    },
    base: buildCanonicalEvaluationProvenance({
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      accountProfile: input.profile,
      dataHealth: input.dataHealth,
      flags: input.flags,
      scope: input.profile.scope,
      creativeInput: computation.input,
      campaignContext: computation.campaignContext,
      priorHysteresis: computation.priorHysteresis,
      decision: computation.decision,
      rawLabel: computation.rawLabel,
      publishedLabel: computation.decision.label,
      hysteresisSuppressed: computation.hysteresisSuppressed,
      evaluatedAt: input.evaluatedAt,
    }),
  });
}

/** Virtual row IDs are explicitly synthetic; their content hashes are not. */
function simulatedEvaluationId(evaluation: AdCanonicalEvaluationProvenance): string {
  return `read-only-simulation:evaluation:${evaluation.decisionHash}`;
}

export function verifySimulationHashIntegrity(
  decisions: ReadonlyArray<{
    evaluation: AdCanonicalEvaluationProvenance;
    payload: Pick<ReturnType<typeof toNativeSnapshotPayload>, "input_hash" | "decision_hash">;
  }>,
  carried: ReadonlyMap<string, PreviousAdPublishedLabel>,
) {
  const carriedByEvaluation = new Map(
    [...carried.values()].map((prior) => [prior.sourceEvaluationId, prior]),
  );
  if (carried.size !== decisions.length || carriedByEvaluation.size !== decisions.length) {
    throw new Error("Simulation carried evaluation count differs from the computed count.");
  }
  for (const { evaluation, payload } of decisions) {
    // The production persistence validator recomputes all three hashes and
    // verifies their context -> input -> decision bindings and native identity.
    assertAdCanonicalEvaluationProvenance(evaluation);
    const prior = carriedByEvaluation.get(simulatedEvaluationId(evaluation));
    if (
      payload.input_hash !== evaluation.inputHash ||
      payload.decision_hash !== evaluation.decisionHash ||
      prior?.sourceInputHash !== evaluation.inputHash ||
      prior.sourceDecisionHash !== evaluation.decisionHash
    ) {
      throw new Error("Simulation snapshot or carried hashes differ from canonical evaluation.");
    }
  }
  return {
    evaluationsVerified: decisions.length,
    canonicalHashesVerified: true,
    snapshotHashesMatch: true,
    carriedHashesMatch: true,
    virtualRowIds: true,
  };
}

export interface HysteresisSourceCounts {
  /** Prior label taken from an earlier simulated day of this chain. */
  fromSimulatedPriorDay: number;
  /** Prior label read from a persisted row that existed at the cutoff. */
  fromPersistedRow: number;
  /** A persisted row and a simulated prior both existed and disagreed; the simulated one was used. */
  simulatedOverridesPersisted: number;
  /** Persisted prior withheld because it was rewritten after the cutoff. */
  persistedWithheldOverwritten: number;
}

/**
 * The prior labels a simulated day decides with.
 *
 * A simulated earlier day stands in for the row the current code would have
 * persisted, so it wins over a persisted row from a different epoch or code
 * revision. Identities with neither start cold, which `applyLabelHysteresis`
 * treats conservatively: an unconfirmed hard label is held.
 */
export function mergePriorLabelSources(input: {
  persisted: ReadonlyMap<string, PreviousAdPublishedLabel>;
  carried: ReadonlyMap<string, PreviousAdPublishedLabel>;
  persistedWithheld: ReadonlyMap<string, PreviousLabelPitExclusion>;
  keysInScope: ReadonlySet<string>;
}): { labels: Map<string, PreviousAdPublishedLabel>; counts: HysteresisSourceCounts } {
  const labels = new Map<string, PreviousAdPublishedLabel>();
  const counts: HysteresisSourceCounts = {
    fromSimulatedPriorDay: 0,
    fromPersistedRow: 0,
    simulatedOverridesPersisted: 0,
    persistedWithheldOverwritten: 0,
  };
  for (const key of input.keysInScope) {
    const carried = input.carried.get(key);
    const persisted = input.persisted.get(key);
    if (input.persistedWithheld.has(key)) counts.persistedWithheldOverwritten += 1;
    if (carried) {
      labels.set(key, carried);
      counts.fromSimulatedPriorDay += 1;
      if (
        persisted &&
        (persisted.publishedLabel !== carried.publishedLabel ||
          persisted.rawLabel !== carried.rawLabel)
      ) {
        counts.simulatedOverridesPersisted += 1;
      }
    } else if (persisted) {
      labels.set(key, persisted);
      counts.fromPersistedRow += 1;
    }
  }
  return { labels, counts };
}

/** A simulated day's published labels, shaped as the persisted prior row would be. */
export function toCarriedPriorLabels(input: {
  businessId: string;
  asOf: string;
  cutoff: string;
  decisions: ReadonlyArray<{
    scope: { type: "account" | "campaign"; id: string };
    computation: Pick<AdDecisionComputation, "input" | "decision" | "rawLabel">;
    evaluation: AdCanonicalEvaluationProvenance;
  }>;
}): Map<string, PreviousAdPublishedLabel> {
  const carried = new Map<string, PreviousAdPublishedLabel>();
  for (const { scope, computation, evaluation } of input.decisions) {
    const ad = computation.input;
    const key = adDecisionStabilityKey({
      businessId: input.businessId,
      providerAccountRefId: ad.providerAccountRefId,
      providerAccountId: ad.providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId: ad.decisionEntityId,
      scopeType: scope.type,
      scopeId: scope.id,
    });
    carried.set(key, {
      businessId: input.businessId,
      providerAccountRefId: ad.providerAccountRefId,
      providerAccountId: ad.providerAccountId,
      decisionEntityType: "ad",
      decisionEntityId: ad.decisionEntityId,
      sourceSnapshotId: `read-only-simulation:snapshot:${evaluation.decisionHash}`,
      sourceEvaluationId: simulatedEvaluationId(evaluation),
      sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceAsOfDate: input.asOf,
      sourceComputedAt: input.cutoff,
      sourceInputHash: evaluation.inputHash,
      sourceDecisionHash: evaluation.decisionHash,
      publishedLabel: computation.decision.label as DecisionLabel,
      rawLabel: computation.rawLabel,
    });
  }
  return carried;
}

/* ------------------------------------------------------------------- claim */

export const SIMULATION_CLAIM = {
  currentCodePureCompute: true,
  integratedPersistedJob: false,
  persistedCalibrationUsed: false,
  pointInTimeAuthority: {
    hydration: "production_loader_bounded_by_decision_cutoff",
    calibration: "recomputed_in_memory_at_the_simulated_cutoff_not_the_persisted_dependency_batch",
    targetAuthority: "as_of_the_simulated_cutoff",
    campaignContext: "rows_existing_at_cutoff_rewritten_rows_withheld",
    priorLabels: "rows_existing_at_cutoff_rewritten_rows_withheld_plus_earlier_simulated_days",
    policyFlags: "current_not_point_in_time",
    /*
      A limit, not a guarantee: an ad-day restated after the cutoff is
      invisible at that cutoff to BOTH calibration and hydration and its day is
      bridged as no delivery. Counted per day in pointInTime, never recovered.
    */
    adDaysRestatedAfterCutoff: "unobservable_at_cutoff_counted_not_reconstructed",
  },
  providerMutation: "none_no_provider_client_in_this_runner",
  databaseWrites: "none_read_only_transaction",
} as const;

/**
 * Ad-days that EXISTED at the cutoff but were restated after it.
 *
 * Both calibration and hydration admit a meta_ad_daily row only when
 * created_at AND updated_at are at or before the cutoff, so a row restated
 * later is invisible at that cutoff in both halves and its day is bridged as no
 * delivery. The value the job saw is gone; this cannot be reconstructed, only
 * counted. A simulation whose count is non-zero decided over fewer economic
 * days than the historical run did.
 */
export const RESTATED_AFTER_CUTOFF_WINDOW_DAYS = 90;
export const COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL = `
  SELECT count(*)::int AS rows,
         count(*) FILTER (
           WHERE COALESCE(spend, 0) <> 0 OR COALESCE(conversions, 0) <> 0
                 OR COALESCE(revenue, 0) <> 0
         )::int AS economic_rows
  FROM meta_ad_daily
  WHERE business_id = $1
    AND date > ($2::date - ${RESTATED_AFTER_CUTOFF_WINDOW_DAYS})
    AND date <= $2::date
    AND created_at <= $3::timestamptz
    AND updated_at > $3::timestamptz
`;

/* -------------------------------------------------------------------- run */

export interface SimulationDependencies {
  resolveFlags: (businessId: string) => Promise<EngineV3Flags>;
}

const DEFAULT_DEPENDENCIES: SimulationDependencies = {
  resolveFlags: (businessId) => resolveEngineV3Flags(businessId),
};

async function simulateOneDay(input: {
  db: DbClient;
  businessId: string;
  day: SimulatedDay;
  flags: EngineV3Flags;
  bindings: ProviderBinding[];
  carried: ReadonlyMap<string, PreviousAdPublishedLabel>;
}) {
  const { db, businessId, day, flags } = input;
  const batches: NativeAdCalibrationBatch[] = [];
  const targets = new Map<string, NativeAdTargetAuthorityInput | null>();
  for (const binding of input.bindings) {
    const sourceRows = await db.query<Record<string, unknown>>(
      READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
      [
        businessId,
        day.asOf,
        binding.providerAccountRefId,
        binding.providerAccountId,
        day.cutoff,
      ],
    );
    const [targetRow] = await db.query<Record<string, unknown>>(
      READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
      [businessId, binding.providerAccountRefId, binding.providerAccountId, day.cutoff],
    );
    const target = targetRow ? mapNativeAdTargetAuthorityRow(targetRow) : null;
    targets.set(`${binding.providerAccountRefId}\u0000${binding.providerAccountId}`, target);
    batches.push(
      computeNativeAdCalibrationBatch({
        businessId,
        providerAccountRefId: binding.providerAccountRefId,
        providerAccountId: binding.providerAccountId,
        asOf: day.asOf,
        computationCutoff: day.cutoff,
        sourceRows: sourceRows.map(mapNativeAdCalibrationSourceRow),
        targetAuthority: target,
        // Diagnostic only in the production contract; it never selects the
        // Meta spend/AOV basis. Keeping it null avoids a second currency path.
        observedShopifyAovEvidence: null,
      }),
    );
  }

  const [restated] = await db.query<Record<string, unknown>>(
    COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL,
    [businessId, day.asOf, day.cutoff],
  );
  const adDaysRestatedAfterCutoff = {
    windowDays: RESTATED_AFTER_CUTOFF_WINDOW_DAYS,
    rows: Number(restated?.rows ?? 0),
    economicRows: Number(restated?.economic_rows ?? 0),
  };

  const hydration = await new WarehouseDataSource().hydrateAdDecisionInputs({
    businessId,
    asOf: day.asOf,
    decisionCutoff: day.cutoff,
  });
  /*
    The production job FAILS here, and so does this day. It used to carry on
    and report zero decisions, which reads as "nothing to do" for an account
    whose hydration was not even proven empty.
  */
  try {
    assertEmptyNativeAdHydrationIsAuthoritative(hydration);
  } catch (error) {
    return {
      status: "failed" as const,
      reason: error instanceof Error ? error.message : String(error),
      report: {
        asOf: day.asOf,
        cutoff: day.cutoff,
        hydrationInputs: 0,
        pointInTime: { adDaysRestatedAfterCutoff },
      },
      published: new Map<string, PreviousAdPublishedLabel>(),
    };
  }

  const profileSource = new InMemoryNativeProfileDataSource(
    completeSimulationCells(batches),
    targets,
  );
  const groups = await resolveNativeAdDecisionProfileGroups({
    businessId,
    asOf: day.asOf,
    adInputs: hydration.inputs,
    flags,
    dataSource: profileSource,
  });

  const campaignContextMode = resolveCampaignContextMode();
  const contextExclusions = new Map<string, CampaignContextPitExclusion>();
  const campaignContextById = await readAdCampaignContext({
    businessId,
    asOf: day.asOf,
    adInputs: hydration.inputs,
    mode: campaignContextMode,
    visibleAtCutoff: day.cutoff,
    pitExclusions: contextExclusions,
  });

  const persisted = new Map<string, PreviousAdPublishedLabel>();
  const persistedWithheld = new Map<string, PreviousLabelPitExclusion>();
  const keysInScope = new Set<string>();
  for (const scopeGroup of groupNativeProfileInputsByScope(groups)) {
    for (const ad of scopeGroup.adInputs) {
      keysInScope.add(adDecisionStabilityKey({
        businessId,
        providerAccountRefId: ad.providerAccountRefId,
        providerAccountId: ad.providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId: ad.decisionEntityId,
        scopeType: scopeGroup.scope.type,
        scopeId: scopeGroup.scope.id,
      }));
    }
    const rows = await readPreviousPublishedAdLabels(
      {
        businessId,
        asOf: day.asOf,
        identities: scopeGroup.adInputs.map((ad) => ({
          providerAccountRefId: ad.providerAccountRefId,
          providerAccountId: ad.providerAccountId,
          decisionEntityType: "ad" as const,
          decisionEntityId: ad.decisionEntityId,
        })),
        scopeType: scopeGroup.scope.type,
        scopeId: scopeGroup.scope.id,
        visibleAtCutoff: day.cutoff,
        pitExclusions: persistedWithheld,
      },
      db,
    );
    mergeUniqueMap(persisted, rows, "hysteresis lineage");
  }
  const prior = mergePriorLabelSources({
    persisted,
    carried: input.carried,
    persistedWithheld,
    keysInScope,
  });

  const frequencyPressureThresholdByAccount =
    resolveNativeAdFrequencyPressureThresholdsByAccount(hydration.inputs);
  const scoped: Array<{
    scope: { type: "account" | "campaign"; id: string };
    computation: AdDecisionComputation;
    evaluation: AdCanonicalEvaluationProvenance;
    /**
     * The row the job would persist, built by the job's own pure payload
     * function. It applies the D098 config-source gate and the authorized
     * action rule, neither of which runs inside the decision computation —
     * reading `computation.decision` alone would miss both.
     */
    payload: ReturnType<typeof toNativeSnapshotPayload>;
  }> = [];
  for (const group of groups) {
    const dataHealth = buildNativeAdDataHealth({
      calibrationCell: group.calibrationCell,
      blocker: group.blocker,
      adInputs: group.adInputs,
      previousLabels: prior.labels,
      scope: group.profile.scope,
      evaluatedAt: day.cutoff,
    });
    // The production branch, including its provenance throw for a "ready"
    // group with incomplete native authority. No blocker is invented here.
    const computations =
      group.blocker === null
        ? computeReadyNativeAdDecisions({
            group,
            businessId,
            dataHealth,
            campaignContextMode,
            campaignContextById,
            previousLabels: prior.labels,
            frequencyPressureThresholdByAccount,
          })
        : computeSoftOnlyNativeAdDecisions({
            businessId,
            blocker: group.blocker,
            profile: group.profile,
            adInputs: group.adInputs,
            campaignContextMode,
            campaignContextById,
            previousLabels: prior.labels,
            evaluatedAt: day.cutoff,
          });
    for (const computation of computations) {
      const lineage = `read-only-simulation:${day.asOf}:${computation.input.decisionEntityId}`;
      const evaluation = buildSimulationEvaluation({
        computation,
        profile: group.profile,
        dataHealth,
        flags,
        evaluatedAt: day.cutoff,
      });
      scoped.push({
        scope: group.profile.scope,
        computation,
        evaluation,
        payload: toNativeSnapshotPayload({
          businessId,
          asOf: day.asOf,
          jobRunId: lineage,
          scope: group.profile.scope,
          computation,
          stored: {
            evaluationId: simulatedEvaluationId(evaluation),
            providerAccountRefId: computation.input.providerAccountRefId,
            providerAccountId: computation.input.providerAccountId,
            decisionEntityId: computation.input.decisionEntityId,
            inputHash: evaluation.inputHash,
            decisionHash: evaluation.decisionHash,
          },
          calibrationRowId: group.calibrationRowId,
          hardActionEligibility: group.profile.hardActionEligibility,
          computedAt: day.cutoff,
        }),
      });
    }
  }
  const decisions = scoped.map((entry) => entry.computation);
  const hardLabels = new Set(["scale", "cut", "refresh"]);
  const interesting = decisions.filter(
    (decision) =>
      decision.decision.label !== decision.rawLabel ||
      decision.decision.authorityBlocker !== null ||
      ["scale", "cut", "refresh", "keep"].includes(decision.rawLabel),
  );
  const INTERESTING_LIMIT = 100;
  const published = toCarriedPriorLabels({
    businessId,
    asOf: day.asOf,
    cutoff: day.cutoff,
    decisions: scoped,
  });
  const hashIntegrity = verifySimulationHashIntegrity(scoped, published);

  return {
    status: "computed" as const,
    reason: null,
    published,
    report: {
      asOf: day.asOf,
      cutoff: day.cutoff,
      hashIntegrity,
      hydration: {
        inputs: hydration.inputs.length,
        accountCoverageComplete: hydration.accountCoverageComplete,
        receipts: hydration.receipts.map((receipt) => ({
          providerAccountId: receipt.providerAccountId,
          sourceComplete: receipt.sourceComplete,
          hydrationComplete: receipt.hydrationComplete,
          authoritativeForPrune: receipt.authoritativeForPrune,
          reason: receipt.reason,
          expectedAdCount: receipt.expectedAdCount,
          hydratedAdCount: receipt.hydratedAdCount,
        })),
      },
      calibration: batches.map((batch) => ({
        providerAccountId: batch.providerAccountId,
        cells: batch.cells.length,
        authorityCells: countBy(batch.cells, (cell) =>
          cell.actionReadiness.cut.ready
            ? "cut_ready"
            : cell.actionReadiness.scale.ready
              ? "scale_ready"
              : "no_hard_ready",
        ),
        qualityCounts: batch.qualityCounts,
      })),
      profiles: {
        groups: groups.length,
        groupBlockers: countBy(groups, (group) => group.blocker ?? "ready"),
        adsByBlocker: countBy(
          groups.flatMap((group: NativeAdDecisionProfileGroup) =>
            group.adInputs.map(() => ({ blocker: group.blocker ?? "ready" })),
          ),
          (row) => row.blocker,
        ),
      },
      configAuthority: {
        currentValueObserved: hydration.inputs.filter(
          (ad) => ad.configAuthority.currentValueEvidence.observed,
        ).length,
        fullyVerifiedEconomics: hydration.inputs.filter(
          (ad) => ad.configAuthority.decisionEconomics.fullyVerified,
        ).length,
      },
      pointInTime: {
        campaignContextWithheldRewrittenAfterCutoff: contextExclusions.size,
        priorLabelsWithheldRewrittenAfterCutoff: persistedWithheld.size,
        adDaysRestatedAfterCutoff,
      },
      hysteresis: {
        ...prior.counts,
        coldStart: keysInScope.size - prior.labels.size,
        hardVerdictsHeldForSecondEvaluation: decisions.filter(
          (decision) => decision.hysteresisSuppressed,
        ).length,
      },
      decisions: {
        count: decisions.length,
        labels: countBy(decisions, (decision) => decision.decision.label),
        rawLabels: countBy(decisions, (decision) => decision.rawLabel),
        publishedHard: decisions.filter((decision) =>
          hardLabels.has(decision.decision.label),
        ).length,
        authorityBlockers: countBy(
          decisions,
          (decision) => decision.decision.authorityBlocker ?? "none",
        ),
        blockedActionTypes: countBy(
          decisions,
          (decision) => decision.decision.blockedActionType ?? "none",
        ),
        campaignRoleStatus: countBy(
          decisions,
          (decision) => decision.decision.campaignRoleStatus,
        ),
        /*
          What the job would PERSIST and serve, from its own payload function:
          the final authority blocker (including the D098 config-source hold
          applied after the decision), the held action, and the provider
          action the row would authorize. `authorizedActions` is the only
          field that grants anything, and only once governance, fresh
          hierarchy and preflight also pass.
        */
        persisted: {
          authorityBlockers: countBy(
            scoped,
            (entry) => entry.payload.authority_blocker ?? "none",
          ),
          blockedActionTypes: countBy(
            scoped,
            (entry) => entry.payload.blocked_action_type ?? "none",
          ),
          authorizedActions: countBy(
            scoped,
            (entry) => entry.payload.authorized_action ?? "none",
          ),
          hardVerdictsWithoutConfigAuthority: scoped.filter(
            (entry) =>
              hardLabels.has(entry.computation.rawLabel) &&
              (!entry.computation.input.configAuthority.currentValueEvidence.observed ||
                !entry.computation.input.configAuthority.decisionEconomics.fullyVerified),
          ).length,
        },
        interestingTotal: interesting.length,
        interestingTruncated: interesting.length > INTERESTING_LIMIT,
        interesting: interesting.slice(0, INTERESTING_LIMIT).map((decision) => {
          const payload = scoped.find((entry) => entry.computation === decision)!.payload;
          return {
            providerAccountId: decision.input.providerAccountId,
            adId: decision.input.adId,
            label: decision.decision.label,
            rawLabel: decision.rawLabel,
            hysteresisSuppressed: decision.hysteresisSuppressed,
            confidence: decision.decision.confidence,
            authorityBlocker: decision.decision.authorityBlocker,
            blockedActionType: decision.decision.blockedActionType,
            persistedAuthorityBlocker: payload.authority_blocker,
            persistedBlockedActionType: payload.blocked_action_type,
            authorizedAction: payload.authorized_action,
            inputHash: payload.input_hash,
            decisionHash: payload.decision_hash,
            configCurrentValueObserved:
              decision.input.configAuthority.currentValueEvidence.observed,
            configEconomicsFullyVerified:
              decision.input.configAuthority.decisionEconomics.fullyVerified,
            reason: payload.reason,
          };
        }),
      },
    },
  };
}

/**
 * The simulation body. The caller owns the transaction; this pins the snapshot
 * as its first statement.
 */
export async function simulateInsideReadOnlyTransaction(
  args: NativeDecisionSimulationArgs,
  dependencies: SimulationDependencies = DEFAULT_DEPENDENCIES,
  db: DbClient = getDb(),
): Promise<Record<string, unknown>> {
  const snapshot: PinnedReadOnlySnapshot = await pinReadOnlySnapshot(
    (text, values) => db.query<Record<string, unknown>>(text, values as unknown[]),
  );
  await db.query("SET LOCAL work_mem = '16MB'");

  const flags = await dependencies.resolveFlags(args.businessId);
  const policy = describeSimulationPolicy(flags);
  const base = {
    mode: "read_only_current_code_historical_decision_simulation",
    businessId: args.businessId,
    asOf: args.asOf,
    cutoff: args.cutoff,
    chain: args.chain,
    snapshot,
    policy,
    runtime: {
      campaignContextMode: resolveCampaignContextMode(),
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      observedShopifyAovEvidence: "not_consulted_diagnostic_only",
    },
  };

  /*
    Exactly what `runAdDecisionsJob` does with a disabled business: it marks
    the run skipped and produces no decision. This used to compute a full set
    of decisions anyway and label them "current code and policy" — a
    counterfactual presented as the current policy's output.
  */
  if (!flags.enabled) {
    return {
      ...base,
      status: "skipped",
      reason: "engine_v3_disabled",
      claim: { ...SIMULATION_CLAIM, currentCodePureCompute: false },
      days: [],
    };
  }

  const bindings = providerBindings(
    await db.query<Record<string, unknown>>(LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL, [
      args.businessId,
    ]),
  );
  const days: Array<Record<string, unknown>> = [];
  let carried = new Map<string, PreviousAdPublishedLabel>();
  for (const day of args.chain) {
    const result = await simulateOneDay({
      db,
      businessId: args.businessId,
      day,
      flags,
      bindings,
      carried,
    });
    days.push({ status: result.status, reason: result.reason, ...result.report });
    // A failed production day persists nothing, so it adds no prior; earlier
    // simulated days remain the latest prior, as the reader would find them.
    if (result.status === "computed") {
      carried = new Map([...carried, ...result.published]);
    }
  }
  return {
    ...base,
    status: days.every((day) => day.status === "computed") ? "computed" : "partially_failed",
    reason: null,
    claim: SIMULATION_CLAIM,
    days,
    finalDay: days.at(-1) ?? null,
  };
}

export async function runNativeDecisionSimulation(
  args: NativeDecisionSimulationArgs,
): Promise<Record<string, unknown>> {
  return runDbTransaction(
    () => simulateInsideReadOnlyTransaction(args),
    { timeoutMs: 300_000 },
  );
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseNativeDecisionSimulationArgs(process.argv.slice(2));
  const report = await runNativeDecisionSimulation(args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.write && args.outPath) writeFileSync(args.outPath, json, "utf8");
  console.log(json.trimEnd());
  console.error(
    [
      "READ-ONLY CURRENT-CODE PURE-COMPUTE SIMULATION, one pinned REPEATABLE READ snapshot.",
      "Calibration was RECOMPUTED in memory at each simulated cutoff; the integrated job reads a",
      "persisted dependency batch instead. Nothing was persisted and no provider was contacted.",
      "Engine flags are the CURRENT policy, not the policy in force at the cutoff.",
    ].join("\n"),
  );
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("native-ad-current-code-historical-simulation.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
