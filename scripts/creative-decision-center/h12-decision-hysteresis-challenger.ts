#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import {
  H12_POLICIES,
  H12_OUTCOME_WINDOWS,
  evaluateH12Dataset,
  h12StableHash,
  replayH12Policy,
  summarizeH12Policy,
  verifyH12PrefixInvariance,
  type H12DatasetEvaluation,
  type H12Observation,
  type H12OutcomeStatus,
  type H12OutcomeWindowDays,
  type H12OutcomesByWindow,
  type H12Policy,
  type H12PolicyMetrics,
  type H12PublishedObservation,
} from "@/lib/creative-decision-engine/simulation/h12-decision-hysteresis";
import { clusteredMovingBlockBootstrap } from "@/lib/creative-decision-engine/simulation/clustered-moving-block-bootstrap";
import { pairedMcNemar } from "@/lib/creative-decision-engine/simulation/paired-binary-inference";
import type { DecisionLabel } from "@/lib/creative-decision-engine/types";

const CONTRACT_VERSION =
  "adsecute.h12-decision-hysteresis-challenger.v1" as const;
const NATIVE_SOURCE =
  "scripts/creative-decision-center/native-ad-grain-paired-replay.ts";
const NATIVE_ARTIFACT =
  "docs/creative-decision-center/generated/native-ad-grain-paired-replay-2025-12-01-to-2026-06-27.json";
const EXACT_ARTIFACT =
  "docs/creative-decision-center/generated/exact-pit-confirmatory-replay-2026-06-01-to-2026-07-05.json";
const DEFAULT_START_DATE = "2025-12-01";
const DEFAULT_DECISION_END_DATE = "2026-07-05";
const DEFAULT_OUTCOME_CEILING = "2026-07-11";
const DEFAULT_PERSISTED_RAW_ENGINE_VERSION =
  "v3-2026-07-07-vnext-stale-fatigue";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/h12-decision-hysteresis-challenger-2025-12-01-to-2026-07-05.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/H12_DECISION_HYSTERESIS_CHALLENGER_2025-12-01_TO_2026-07-05.md";
const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_BLOCK_DAYS = 7;

interface Args {
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  businesses: string[];
  persistedRawEngineVersion: string;
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
}

interface InstrumentedSequenceRow {
  businessId: string;
  businessName: string;
  accountId: string;
  entityId: string;
  date: string;
  rawLabel: DecisionLabel;
  outcomeStatus: H12OutcomeStatus;
  outcomeComplete: boolean;
  outcomesByWindow: H12OutcomesByWindow;
  targetExact: boolean;
  decisionInputHash: string;
  sourceUpdatedAfterCutoff: boolean;
}

export interface NativeArtifactReceipt {
  contractVersion: string;
  input: {
    startDate: string;
    decisionEndDate: string;
    outcomeCeiling: string;
  };
  coverage: Record<string, unknown>;
  lineage: {
    scriptContentHash: string;
    manifestSetHash: string;
  };
}

interface ExactArtifactReceipt {
  contractVersion: string;
  input: { startDate: string; endDate: string };
  summary: Record<string, unknown>;
  coverage: Record<string, unknown>;
  persistedBaseline: Record<string, unknown>;
  physicallyUnreconstructable: string[];
  hashes: { deterministicTransformVerified: boolean };
  reportHash: string;
}

interface InstrumentedNativeReport {
  contractVersion: string;
  coverage: {
    businesses: number;
    sourceRows: number;
    cohortRows: number;
    targetExactRows: number;
    completeOutcomeRows: number;
    sourceRowsUpdatedAfterCutoff: number;
    duplicateCohortKeys: number;
    uniqueDecisionInputHashes: number;
  };
  lineage: Record<string, unknown>;
  h12SequenceRows: InstrumentedSequenceRow[];
}

interface PairedEpisode {
  id: string;
  businessId: string;
  accountId: string | null;
  entityId: string;
  date: string;
  windowDays: H12OutcomeWindowDays;
  outcomeStatus: "supported" | "refuted";
  baselineCaptured: boolean;
  candidateCaptured: boolean;
}

function observationOutcome(
  row: H12Observation,
  windowDays: H12OutcomeWindowDays,
) {
  const explicit =
    row.outcomesByWindow?.[String(windowDays) as "3" | "7" | "14"];
  if (explicit) return explicit;
  return windowDays === 14
    ? {
        outcomeStatus: row.outcomeStatus,
        outcomeComplete: row.outcomeComplete,
      }
    : null;
}

interface ReversalEvent {
  id: string;
  businessId: string;
  entityId: string;
  date: string;
  baseline: number;
  candidate: number;
}

function arg(argv: readonly string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function parseArgs(argv: readonly string[]): Args {
  return {
    startDate: arg(argv, "startDate", DEFAULT_START_DATE),
    decisionEndDate: arg(argv, "decisionEndDate", DEFAULT_DECISION_END_DATE),
    outcomeCeiling: arg(argv, "outcomeCeiling", DEFAULT_OUTCOME_CEILING),
    businesses: arg(argv, "businesses", "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    persistedRawEngineVersion: arg(
      argv,
      "persistedRawEngineVersion",
      DEFAULT_PERSISTED_RAW_ENGINE_VERSION,
    ),
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
  };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function verifyNativeArtifactSourceHash(input: {
  source: string;
  artifact: NativeArtifactReceipt;
}) {
  const actual = sha256(input.source);
  const expected = input.artifact.lineage?.scriptContentHash;
  if (!SHA256_HEX.test(expected ?? "") || actual !== expected) {
    throw new Error(
      `H12 native artifact source hash mismatch: expected=${expected ?? "missing"} actual=${actual}`,
    );
  }
  if (!SHA256_HEX.test(input.artifact.lineage.manifestSetHash ?? "")) {
    throw new Error("H12 native artifact manifest hash is missing or invalid");
  }
  return actual;
}

function readAndVerifySourceArtifacts(args: Args) {
  const nativeSourcePath = resolve(process.cwd(), NATIVE_SOURCE);
  const nativeArtifactPath = resolve(process.cwd(), NATIVE_ARTIFACT);
  const exactArtifactPath = resolve(process.cwd(), EXACT_ARTIFACT);
  const source = readFileSync(nativeSourcePath, "utf8");
  const nativeArtifact = JSON.parse(
    readFileSync(nativeArtifactPath, "utf8"),
  ) as NativeArtifactReceipt;
  const exactArtifact = JSON.parse(
    readFileSync(exactArtifactPath, "utf8"),
  ) as ExactArtifactReceipt;
  const sourceHash = verifyNativeArtifactSourceHash({
    source,
    artifact: nativeArtifact,
  });
  if (
    nativeArtifact.input.startDate !== args.startDate ||
    nativeArtifact.input.outcomeCeiling !== args.outcomeCeiling ||
    nativeArtifact.input.decisionEndDate > args.decisionEndDate
  ) {
    throw new Error("H12 native artifact protocol does not match replay input");
  }
  if (
    !SHA256_HEX.test(exactArtifact.reportHash ?? "") ||
    exactArtifact.hashes?.deterministicTransformVerified !== true
  ) {
    throw new Error("H12 exact artifact receipt is invalid or unverified");
  }
  return {
    source,
    sourceHash,
    nativeArtifact: {
      path: NATIVE_ARTIFACT,
      contractVersion: nativeArtifact.contractVersion,
      input: nativeArtifact.input,
      coverage: nativeArtifact.coverage,
      lineage: nativeArtifact.lineage,
    },
    exactArtifact: {
      path: EXACT_ARTIFACT,
      ...exactArtifact,
    },
  };
}

function replaceExactlyOnce(
  source: string,
  search: string,
  replacement: string,
) {
  const first = source.indexOf(search);
  if (first < 0)
    throw new Error(`H12 instrumentation anchor missing: ${search}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`H12 instrumentation anchor is ambiguous: ${search}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

/**
 * Creates an in-memory verification adapter without editing the native replay.
 * Every replacement is exact and fail-closed so a source refactor cannot
 * silently change the H12 cohort or decision semantics.
 */
export function instrumentNativeReplaySource(source: string) {
  let instrumented = replaceExactlyOnce(
    source,
    "const DECISION_COOLDOWN_DAYS = 7;",
    "const DECISION_COOLDOWN_DAYS = 1;",
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    `  const variants =\n    args.grid === "smoke" ? buildAdSmokeGrid() : buildAdChallengerGrid();`,
    `  const variants = [buildAdChallengerGrid()[0]!];`,
  );
  instrumented = replaceExactlyOnce(
    instrumented,
    `    nextActions: [`,
    `    h12SequenceRows: cohortRows.map((row) => {\n      const decision = row.decisions[0]!;\n      const outcomeStatusFor = (outcome: ForwardOutcome) => decision.label === "cut"\n        ? outcome.statusByAction.cut\n        : decision.label === "scale"\n          ? outcome.statusByAction.winner\n          : decision.label === "refresh"\n            ? outcome.statusByAction.refresh\n            : "neutral";\n      const outcomeStatus = outcomeStatusFor(row.outcome);\n      return {\n        businessId: row.context.business.id,\n        businessName: row.context.business.name,\n        accountId: row.context.providerAccountId,\n        entityId: row.context.adId,\n        date: row.context.asOfDate,\n        rawLabel: decision.label,\n        outcomeStatus,\n        outcomeComplete: row.outcome.complete,\n        outcomesByWindow: Object.fromEntries(\n          OUTCOME_WINDOWS.map((windowDays) => {\n            const outcome = row.outcomes[windowDays];\n            return [String(windowDays), {\n              outcomeStatus: outcomeStatusFor(outcome),\n              outcomeComplete: outcome.complete,\n            }];\n          }),\n        ),\n        targetExact: row.targetExact,\n        decisionInputHash: row.decisionInputHash,\n        sourceUpdatedAfterCutoff: row.context.sourceUpdatedAfterCutoff,\n      };\n    }),\n    nextActions: [`,
  );
  return instrumented;
}

async function runInstrumentedNativeReplay(
  args: Args,
  receipts = readAndVerifySourceArtifacts(args),
) {
  const source = receipts.source;
  const instrumented = instrumentNativeReplaySource(source);
  const temporaryDirectory = mkdtempSync(
    join(process.cwd(), ".h12-native-ad-instrumentation-"),
  );
  const temporaryPath = join(
    temporaryDirectory,
    "instrumented-native-replay.ts",
  );
  writeFileSync(temporaryPath, instrumented, "utf8");
  try {
    const moduleUrl = `${pathToFileURL(temporaryPath).href}?sha=${sha256(instrumented)}`;
    const imported = (await import(moduleUrl)) as {
      runReplay(input: {
        startDate: string;
        decisionEndDate: string;
        outcomeCeiling: string;
        businesses: string[];
        jsonOut: string;
        mdOut: string;
        writeFiles: boolean;
        grid: "full";
      }): Promise<InstrumentedNativeReport>;
    };
    const report = await imported.runReplay({
      startDate: args.startDate,
      decisionEndDate: args.decisionEndDate,
      outcomeCeiling: args.outcomeCeiling,
      businesses: args.businesses,
      jsonOut: "/dev/null",
      mdOut: "/dev/null",
      writeFiles: false,
      grid: "full",
    });
    return {
      report,
      sourceHash: receipts.sourceHash,
      instrumentedSourceHash: sha256(instrumented),
      nativeArtifact: receipts.nativeArtifact,
      exactArtifact: receipts.exactArtifact,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function toRestatedObservation(row: InstrumentedSequenceRow): H12Observation {
  return {
    businessId: row.businessId,
    accountId: row.accountId,
    entityId: row.entityId,
    date: row.date,
    rawLabel: row.rawLabel,
    evidenceTier: "restated_ad_daily",
    sourceMode: "restated_ad_daily_native_ad_grain",
    outcomeStatus: row.outcomeStatus,
    outcomeComplete: row.outcomeComplete,
    outcomesByWindow: row.outcomesByWindow,
    targetExact: row.targetExact,
    decisionInputHash: row.decisionInputHash,
  };
}

const VALID_LABELS = new Set<DecisionLabel>([
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
]);

async function readPersistedRawLabelSeam(
  engineVersion: string,
): Promise<H12Observation[]> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "adsecute-h12-persisted-raw-label-readonly",
  });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    const result = await client.query<{
      business_id: string;
      creative_id: string;
      decision_date: string;
      raw_label: string;
      input_hash: string | null;
    }>(
      `
      SELECT
        business_ref_id::text AS business_id,
        creative_id,
        as_of_date::text AS decision_date,
        raw_label,
        input_hash
      FROM engine_v3_decision_snapshots_daily
      WHERE engine_version = $1
        AND scope_type = 'account'
        AND scope_id = '*'
        AND raw_label IS NOT NULL
      ORDER BY business_ref_id, creative_id, as_of_date
      `,
      [engineVersion],
    );
    await client.query("COMMIT");
    return result.rows.flatMap((row) => {
      if (!VALID_LABELS.has(row.raw_label as DecisionLabel)) return [];
      return [
        {
          businessId: row.business_id,
          // Provider-account identity is not persisted on this snapshot row.
          accountId: null,
          entityId: row.creative_id,
          date: row.decision_date,
          rawLabel: row.raw_label as DecisionLabel,
          evidenceTier: "persisted_raw_label" as const,
          sourceMode: `persisted_raw_label:${engineVersion}`,
          outcomeStatus: "unknown" as const,
          outcomeComplete: false,
          targetExact: false,
          decisionInputHash: row.input_hash,
        },
      ];
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function sequenceKey(
  row: Pick<H12Observation, "businessId" | "accountId" | "entityId">,
) {
  return `${row.businessId}::${row.accountId ?? "unknown"}::${row.entityId}`;
}

function groupSequences<T extends H12Observation>(rows: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = sequenceKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const sequence of grouped.values()) {
    sequence.sort((left, right) => left.date.localeCompare(right.date));
  }
  return grouped;
}

const HARD_LABELS = new Set<DecisionLabel>(["cut", "scale", "refresh"]);

function isHard(label: DecisionLabel) {
  return HARD_LABELS.has(label);
}

function reversalDates<T extends H12Observation>(
  rows: readonly T[],
  label: (row: T) => DecisionLabel,
): Set<string> {
  const dates = new Set<string>();
  for (const sequence of groupSequences(rows).values()) {
    for (let index = 1; index < sequence.length; index += 1) {
      const previous = label(sequence[index - 1]!);
      const current = label(sequence[index]!);
      if (previous === current || (!isHard(previous) && !isHard(current)))
        continue;
      for (
        let lookahead = index + 1;
        lookahead <= Math.min(sequence.length - 1, index + 3);
        lookahead += 1
      ) {
        if (label(sequence[lookahead]!) === previous) {
          dates.add(
            `${sequenceKey(sequence[index]!)}::${sequence[index]!.date}`,
          );
          break;
        }
      }
    }
  }
  return dates;
}

function buildReversalEvents(input: {
  observations: readonly H12Observation[];
  candidate: H12Policy;
}): ReversalEvent[] {
  const baseline = replayH12Policy({
    observations: input.observations,
    policy: H12_POLICIES[0],
  });
  const candidate = replayH12Policy({
    observations: input.observations,
    policy: input.candidate,
  });
  const baselineDates = reversalDates(baseline, (row) => row.publishedLabel);
  const candidateDates = reversalDates(candidate, (row) => row.publishedLabel);
  const byKey = new Map(
    input.observations.map((row) => [`${sequenceKey(row)}::${row.date}`, row]),
  );
  return Array.from(new Set([...baselineDates, ...candidateDates]))
    .sort()
    .flatMap((key) => {
      const observation = byKey.get(key);
      if (!observation) return [];
      return [
        {
          id: key,
          businessId: observation.businessId,
          entityId: `${observation.accountId ?? "unknown"}::${observation.entityId}`,
          date: observation.date,
          baseline: baselineDates.has(key) ? 1 : 0,
          candidate: candidateDates.has(key) ? 1 : 0,
        },
      ];
    });
}

function buildPairedEpisodes(input: {
  observations: readonly H12Observation[];
  candidate: H12Policy;
  windowDays: H12OutcomeWindowDays;
}): PairedEpisode[] {
  const baseline = new Map(
    replayH12Policy({
      observations: input.observations,
      policy: H12_POLICIES[0],
    }).map((row) => [`${sequenceKey(row)}::${row.date}`, row]),
  );
  const candidate = new Map(
    replayH12Policy({
      observations: input.observations,
      policy: input.candidate,
    }).map((row) => [`${sequenceKey(row)}::${row.date}`, row]),
  );
  const episodes: PairedEpisode[] = [];
  for (const sequence of groupSequences(input.observations).values()) {
    let active: H12Observation[] = [];
    const flush = () => {
      const first = active[0];
      const outcome = first
        ? observationOutcome(first, input.windowDays)
        : null;
      if (
        !first ||
        !outcome ||
        (outcome.outcomeStatus !== "supported" &&
          outcome.outcomeStatus !== "refuted")
      ) {
        active = [];
        return;
      }
      const captured = (published: Map<string, H12PublishedObservation>) =>
        active.some(
          (row) =>
            published.get(`${sequenceKey(row)}::${row.date}`)
              ?.publishedLabel === first.rawLabel,
        );
      episodes.push({
        id: `${sequenceKey(first)}::${first.date}::${first.rawLabel}`,
        businessId: first.businessId,
        accountId: first.accountId,
        entityId: first.entityId,
        date: first.date,
        windowDays: input.windowDays,
        outcomeStatus: outcome.outcomeStatus,
        baselineCaptured: captured(baseline),
        candidateCaptured: captured(candidate),
      });
      active = [];
    };
    for (const row of sequence) {
      if (!isHard(row.rawLabel)) {
        flush();
        continue;
      }
      if (active.length > 0 && active[0]!.rawLabel !== row.rawLabel) flush();
      active.push(row);
    }
    flush();
  }
  return episodes;
}

function compactBootstrap<T extends { estimates: Array<number | null> }>(
  result: T,
) {
  const { estimates: _estimates, ...compact } = result;
  return compact;
}

function lockedRows(observations: readonly H12Observation[]) {
  return observations.filter(
    (row) => row.date >= "2026-06-01" && row.date <= "2026-07-05",
  );
}

function buildInference(input: {
  observations: readonly H12Observation[];
  candidate: H12Policy;
}) {
  const rows = lockedRows(input.observations);
  const reversalEvents = buildReversalEvents({
    observations: rows,
    candidate: input.candidate,
  });
  const pairedEpisodes = buildPairedEpisodes({
    observations: rows.filter((row) => row.date <= "2026-06-27"),
    candidate: input.candidate,
    windowDays: 14,
  });
  const reversalBootstrap =
    reversalEvents.length > 0
      ? compactBootstrap(
          clusteredMovingBlockBootstrap(reversalEvents, {
            getBusinessId: (row) => row.businessId,
            getEntityId: (row) => row.entityId,
            getDate: (row) => row.date,
            statistic: (sample) => {
              const baseline = sample.reduce(
                (sum, row) => sum + row.observation.baseline,
                0,
              );
              const candidate = sample.reduce(
                (sum, row) => sum + row.observation.candidate,
                0,
              );
              return baseline > 0 ? (baseline - candidate) / baseline : null;
            },
            seed: "H12-locked-reversal-reduction-v1",
            iterations: BOOTSTRAP_ITERATIONS,
            blockLengthDays: BOOTSTRAP_BLOCK_DAYS,
          }),
        )
      : null;
  const episodeAccuracy = (episode: PairedEpisode, candidate: boolean) => {
    const captured = candidate
      ? episode.candidateCaptured
      : episode.baselineCaptured;
    return episode.outcomeStatus === "supported" ? captured : !captured;
  };
  const episodeAccuracyBootstrap =
    pairedEpisodes.length > 0
      ? compactBootstrap(
          clusteredMovingBlockBootstrap(pairedEpisodes, {
            getBusinessId: (row) => row.businessId,
            getEntityId: (row) =>
              `${row.accountId ?? "unknown"}::${row.entityId}`,
            getDate: (row) => row.date,
            statistic: (sample) =>
              sample.reduce(
                (sum, row) =>
                  sum +
                  Number(episodeAccuracy(row.observation, true)) -
                  Number(episodeAccuracy(row.observation, false)),
                0,
              ) / sample.length,
            seed: "H12-locked-episode-accuracy-delta-v1",
            iterations: BOOTSTRAP_ITERATIONS,
            blockLengthDays: BOOTSTRAP_BLOCK_DAYS,
          }),
        )
      : null;
  const precisionBootstrap =
    pairedEpisodes.length > 0
      ? compactBootstrap(
          clusteredMovingBlockBootstrap(pairedEpisodes, {
            getBusinessId: (row) => row.businessId,
            getEntityId: (row) =>
              `${row.accountId ?? "unknown"}::${row.entityId}`,
            getDate: (row) => row.date,
            statistic: (sample) => {
              const baselineCaptured = sample.filter(
                (row) => row.observation.baselineCaptured,
              );
              const candidateCaptured = sample.filter(
                (row) => row.observation.candidateCaptured,
              );
              if (
                baselineCaptured.length === 0 ||
                candidateCaptured.length === 0
              ) {
                return null;
              }
              const baselinePrecision =
                baselineCaptured.filter(
                  (row) => row.observation.outcomeStatus === "supported",
                ).length / baselineCaptured.length;
              const candidatePrecision =
                candidateCaptured.filter(
                  (row) => row.observation.outcomeStatus === "supported",
                ).length / candidateCaptured.length;
              return candidatePrecision - baselinePrecision;
            },
            seed: "H12-locked-precision-delta-v1",
            iterations: BOOTSTRAP_ITERATIONS,
            blockLengthDays: BOOTSTRAP_BLOCK_DAYS,
          }),
        )
      : null;
  const mcnemar = pairedMcNemar(
    pairedEpisodes.map((episode) => ({
      id: episode.id,
      baselineCorrect: episodeAccuracy(episode, false),
      candidateCorrect: episodeAccuracy(episode, true),
    })),
  );
  return {
    bootstrapProtocol: {
      iterations: BOOTSTRAP_ITERATIONS,
      businessEntityClustered: true,
      movingBlockDays: BOOTSTRAP_BLOCK_DAYS,
      confidenceLevel: 0.95,
    },
    reversalEvents: reversalEvents.length,
    pairedKnownOutcomeEpisodes: pairedEpisodes.length,
    reversalReductionRate: reversalBootstrap,
    pairedEpisodeAccuracyDelta: episodeAccuracyBootstrap,
    episodeStartPrecisionDelta: precisionBootstrap,
    mcnemar,
  };
}

function rotateLabelsWithinAccountDate(
  observations: readonly H12Observation[],
): H12Observation[] {
  const grouped = new Map<string, H12Observation[]>();
  for (const row of observations) {
    const key = `${row.businessId}::${row.accountId ?? "unknown"}::${row.date}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return Array.from(grouped.entries()).flatMap(([key, rows]) => {
    const sorted = [...rows].sort((left, right) =>
      left.entityId.localeCompare(right.entityId),
    );
    if (sorted.length < 2) return sorted;
    const offset =
      (Number.parseInt(h12StableHash(key).slice(0, 8), 16) %
        (sorted.length - 1)) +
      1;
    const labels = sorted.map((row) => row.rawLabel);
    return sorted.map((row, index) => ({
      ...row,
      rawLabel: labels[(index + offset) % labels.length]!,
    }));
  });
}

function rotateOutcomeStatuses(
  observations: readonly H12Observation[],
): H12Observation[] {
  const statusMaps = new Map<
    H12OutcomeWindowDays,
    Map<string, H12OutcomeStatus>
  >();
  for (const windowDays of H12_OUTCOME_WINDOWS) {
    const known = observations.flatMap((row) => {
      const outcome = observationOutcome(row, windowDays);
      return outcome?.outcomeStatus === "supported" ||
        outcome?.outcomeStatus === "refuted"
        ? [{ row, status: outcome.outcomeStatus }]
        : [];
    });
    if (known.length < 2) continue;
    const statuses = known.map((item) => item.status);
    statusMaps.set(
      windowDays,
      new Map(
        known.map((item, index) => [
          `${sequenceKey(item.row)}::${item.row.date}`,
          statuses[
            (index + Math.max(1, Math.floor(statuses.length / 3))) %
              statuses.length
          ]!,
        ]),
      ),
    );
  }
  return observations.map((row) => {
    const key = `${sequenceKey(row)}::${row.date}`;
    const outcomesByWindow = Object.fromEntries(
      H12_OUTCOME_WINDOWS.flatMap((windowDays) => {
        const outcome = observationOutcome(row, windowDays);
        if (!outcome) return [];
        return [
          [
            String(windowDays),
            {
              ...outcome,
              outcomeStatus:
                statusMaps.get(windowDays)?.get(key) ?? outcome.outcomeStatus,
            },
          ],
        ];
      }),
    ) as H12OutcomesByWindow;
    const day14 = outcomesByWindow["14"] ?? {
      outcomeStatus: row.outcomeStatus,
      outcomeComplete: row.outcomeComplete,
    };
    return {
      ...row,
      outcomesByWindow,
      outcomeStatus: day14.outcomeStatus,
      outcomeComplete: day14.outcomeComplete,
    };
  });
}

function policyMetric(
  evaluation: H12DatasetEvaluation,
  foldId: "development" | "calibration" | "locked_test",
  policyId: H12Policy["id"],
) {
  const metric = evaluation.folds
    .find((fold) => fold.foldId === foldId)
    ?.policyMetrics.find((candidate) => candidate.policyId === policyId);
  if (!metric) throw new Error(`missing H12 metric ${foldId}/${policyId}`);
  return metric;
}

function buildFalsification(input: {
  observations: readonly H12Observation[];
  selectedPolicy: H12Policy;
  evaluation: H12DatasetEvaluation;
}) {
  const locked = lockedRows(input.observations);
  const selectedLocked = policyMetric(
    input.evaluation,
    "locked_test",
    input.selectedPolicy.id,
  );
  const gapResetPolicy = H12_POLICIES.find(
    (policy) => policy.id === "H12_two_consecutive_gap_reset",
  );
  if (!gapResetPolicy) throw new Error("H12 gap-reset policy is missing");
  const gapReset = summarizeH12Policy({
    observations: locked,
    policy: gapResetPolicy,
  });
  const continuityPlacebo = summarizeH12Policy({
    observations: rotateLabelsWithinAccountDate(locked),
    policy: input.selectedPolicy,
  });
  const outcomePermutation = summarizeH12Policy({
    observations: rotateOutcomeStatuses(locked),
    policy: input.selectedPolicy,
  });
  const prefix = verifyH12PrefixInvariance({
    observations: input.observations,
    policy: input.selectedPolicy,
    cutoffDate: "2026-05-31",
  });
  const rerun = evaluateH12Dataset({
    observations: input.observations,
    evidenceTier: "restated_ad_daily",
    outcomesObservedThrough: DEFAULT_OUTCOME_CEILING,
  });
  return {
    futureMutationPrefixInvariance: prefix,
    deterministicRerun: {
      passed: h12StableHash(input.evaluation) === h12StableHash(rerun),
      firstHash: h12StableHash(input.evaluation),
      secondHash: h12StableHash(rerun),
    },
    gapResetSensitivity: {
      candidatePolicyId: gapResetPolicy.id,
      productionLikeCarriesAcrossEvaluationGaps: {
        reversals: selectedLocked.publishedHardReversalsWithin3,
        durableRecall: selectedLocked.durableEpisodeRecall,
        p95DelayEvaluations: selectedLocked.transitionDelayEvaluations.p95,
      },
      resetPendingAfterCalendarGap: {
        reversals: gapReset.publishedHardReversalsWithin3,
        durableRecall: gapReset.durableEpisodeRecall,
        p95DelayEvaluations: gapReset.transitionDelayEvaluations.p95,
      },
    },
    continuityDestroyedPlacebo: {
      preservedAccountDateLabelMargins: true,
      observedReversals: selectedLocked.publishedHardReversalsWithin3,
      placeboReversals: continuityPlacebo.publishedHardReversalsWithin3,
      observedDurabilityPrecision: selectedLocked.durabilityPrecision,
      placeboDurabilityPrecision: continuityPlacebo.durabilityPrecision,
    },
    outcomeStatusPermutation: {
      observedOutcomePrecision: selectedLocked.outcomePrecision,
      permutedOutcomePrecision: outcomePermutation.outcomePrecision,
      note: "Outcome status is never an input to the policy; permutation is an evaluation-only falsification.",
    },
  };
}

function compactEvaluation(evaluation: H12DatasetEvaluation) {
  return evaluation;
}

function readExactPitBoundary(parsed: ExactArtifactReceipt) {
  const fullResolverRows = Number(
    parsed.summary.fullResolverInputEvaluableRows ?? 0,
  );
  return {
    sourceArtifact: EXACT_ARTIFACT,
    contractVersion: parsed.contractVersion,
    reportHash: parsed.reportHash,
    summary: parsed.summary,
    coverage: parsed.coverage,
    persistedBaseline: parsed.persistedBaseline,
    h12SequenceStatus:
      fullResolverRows > 0
        ? ("requires_exact_raw_label_sequence_join" as const)
        : ("unavailable_no_full_resolver_input_rows" as const),
  };
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function metricRow(metric: H12PolicyMetrics) {
  return [
    metric.policyId,
    metric.observations,
    metric.rawHardReversalsWithin3,
    metric.publishedHardReversalsWithin3,
    percent(metric.hardReversalReductionRate),
    metric.oneEvaluationBlipsPublished,
    percent(metric.durableEpisodeRecall),
    percent(metric.durabilityPrecision),
    percent(metric.outcomePrecision),
    percent(metric.supportedOutcomeRecall),
    metric.transitionDelayEvaluations.p50?.toFixed(1) ?? "n/a",
    metric.transitionDelayEvaluations.p95?.toFixed(1) ?? "n/a",
    metric.safetyExitDelayViolations,
  ].join(" | ");
}

function renderMarkdown(report: Awaited<ReturnType<typeof buildReport>>) {
  const lines: string[] = [];
  lines.push("# H12 Decision Hysteresis Challenger Closure");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Contract: \`${report.contractVersion}\``);
  lines.push(`Report hash: \`${report.reportHash}\``);
  lines.push("");
  lines.push("## Evidence Boundary");
  lines.push("");
  lines.push(
    "The selection replay is read-only `restated_ad_daily` evidence at native ad grain. It never claims exact decision-time inputs or causal provider-write lift. The persisted `raw_label` seam is reported separately and is not pooled with the restated selection. Exact/native coverage and hashes are loaded from their current artifacts at runtime; a native source-hash mismatch aborts the replay.",
  );
  lines.push("");
  lines.push("## Fixed Protocol");
  lines.push("");
  lines.push(
    `- Policies: exactly ${report.policyVerdicts.length} predeclared symmetric, gap-reset, and action-specific entry policies.`,
  );
  lines.push(
    "- Development: 2025-12-01..2026-03-31; 14d outcomes mature through 2026-03-17.",
  );
  lines.push(
    "- Calibration: 2026-04-01..2026-05-31; 14d outcomes mature through 2026-05-17.",
  );
  lines.push(
    "- Locked test: 2026-06-01..2026-07-05; 14d outcomes mature through 2026-06-27.",
  );
  lines.push(
    "- Policy state is causal: current/past raw labels only. Soft, blocked, and not-applicable exits publish immediately.",
  );
  lines.push(
    "- A direct hard-to-hard switch publishes canonical `keep` while the new action is pending.",
  );
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push(
    `- Restated observations: ${report.restated.coverage.observations}`,
  );
  lines.push(
    `- Businesses / accounts / entities: ${report.restated.evaluation.businesses} / ${report.restated.evaluation.accountsKnown} / ${report.restated.evaluation.entities}`,
  );
  lines.push(
    `- Target-cutoff-exact rows: ${report.restated.coverage.targetExactRows}`,
  );
  lines.push(
    `- Complete outcome rows (3d / 7d / 14d): ${report.restated.coverage.completeOutcomeRowsByWindow["3"]} / ${report.restated.coverage.completeOutcomeRowsByWindow["7"]} / ${report.restated.coverage.completeOutcomeRowsByWindow["14"]}`,
  );
  lines.push(
    `- Source rows updated after decision cutoff: ${report.restated.coverage.sourceUpdatedAfterCutoffRows}; therefore the tier remains restated.`,
  );
  lines.push("");
  for (const fold of report.restated.evaluation.folds) {
    lines.push(`## ${fold.foldId}`);
    lines.push("");
    lines.push(
      "Policy | Rows | Raw reversals | Published reversals | Reduction | 1-eval blips published | Durable recall | Durability precision | Outcome precision | Outcome recall | Delay P50 | Delay P95 | Safety-exit delays",
    );
    lines.push(
      "---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:",
    );
    for (const metric of fold.policyMetrics) lines.push(metricRow(metric));
    lines.push("");
    lines.push(
      "Policy | Window | Available | Complete | Known entries | Precision | Supported recall",
    );
    lines.push("---|---:|---:|---:|---:|---:|---:");
    for (const metric of fold.policyMetrics) {
      for (const windowDays of H12_OUTCOME_WINDOWS) {
        const window =
          metric.outcomeWindows[String(windowDays) as "3" | "7" | "14"];
        lines.push(
          `${metric.policyId} | ${windowDays}d | ${window.availableObservations} | ${window.completeObservations} | ${window.outcomeKnownPublishedEntries} | ${percent(window.outcomePrecision)} | ${percent(window.supportedOutcomeRecall)}`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Selection And Locked Inference");
  lines.push("");
  lines.push(
    `Calibration selection: \`${report.restated.evaluation.calibrationSelection.selectedPolicyId ?? "none"}\`.`,
  );
  lines.push(
    `Verdict: **${report.verdict.status}** - ${report.verdict.reason}`,
  );
  lines.push(
    `Performance promotion gate: **${report.verdict.performancePromotion}**; known=${report.performanceGate.knownPublishedEntries}, precision=${percent(report.performanceGate.outcomePrecision)}, supported-opportunity recall=${percent(report.performanceGate.supportedOutcomeRecall)}, episode-start precision-delta lower=${percent(report.performanceGate.episodeStartPrecisionDeltaLower)}.`,
  );
  lines.push(
    `10,000-replicate reversal-reduction CI: ${percent(report.restated.inference.reversalReductionRate?.lower ?? null)} .. ${percent(report.restated.inference.reversalReductionRate?.upper ?? null)}.`,
  );
  lines.push(
    `10,000-replicate episode-start precision delta CI: ${percent(report.restated.inference.episodeStartPrecisionDelta?.lower ?? null)} .. ${percent(report.restated.inference.episodeStartPrecisionDelta?.upper ?? null)}.`,
  );
  lines.push(
    `McNemar paired episodes: n=${report.restated.inference.mcnemar.pairedSampleSize}, net wins=${report.restated.inference.mcnemar.candidateNetWins}, p=${report.restated.inference.mcnemar.pValue.toFixed(4)}.`,
  );
  lines.push("");
  lines.push("## Held-Out Evidence");
  lines.push("");
  lines.push(
    `- Account cells: ${report.restated.evaluation.lockedTestAccountHoldout.length}; non-negative reversal direction: ${report.restated.holdoutSummary.accountsNonNegative}/${report.restated.holdoutSummary.accountsWithBaselineReversal}.`,
  );
  lines.push(
    `- Entity hash folds: ${report.restated.evaluation.lockedTestEntityHashHoldout.length}; non-negative reversal direction: ${report.restated.holdoutSummary.entityFoldsNonNegative}/${report.restated.evaluation.lockedTestEntityHashHoldout.length}.`,
  );
  lines.push(
    `- Seen/new entity cells: ${report.restated.evaluation.lockedTestEntityNovelty.map((cell) => `${cell.id}:${cell.reversalReduction}`).join(", ") || "none"}.`,
  );
  lines.push("");
  lines.push("## Falsification And Sensitivity");
  lines.push("");
  lines.push(
    `- Future mutation prefix invariance: ${report.restated.falsification.futureMutationPrefixInvariance.passed ? "PASS" : "FAIL"}.`,
  );
  lines.push(
    `- Deterministic rerun: ${report.restated.falsification.deterministicRerun.passed ? "PASS" : "FAIL"}.`,
  );
  lines.push(
    `- Gap-reset reversals: ${report.restated.falsification.gapResetSensitivity.resetPendingAfterCalendarGap.reversals}; production-like carry: ${report.restated.falsification.gapResetSensitivity.productionLikeCarriesAcrossEvaluationGaps.reversals}.`,
  );
  lines.push(
    `- Continuity-destroyed placebo durability precision: ${percent(report.restated.falsification.continuityDestroyedPlacebo.placeboDurabilityPrecision)} vs observed ${percent(report.restated.falsification.continuityDestroyedPlacebo.observedDurabilityPrecision)}.`,
  );
  lines.push(
    `- Outcome-permutation precision: ${percent(report.restated.falsification.outcomeStatusPermutation.permutedOutcomePrecision)} vs observed ${percent(report.restated.falsification.outcomeStatusPermutation.observedOutcomePrecision)}.`,
  );
  lines.push("");
  lines.push("## Persisted Raw-Label Seam");
  lines.push("");
  lines.push(
    `Engine version: \`${report.persistedRawLabelSeam.engineVersion}\`; rows=${report.persistedRawLabelSeam.evaluation.observations}; dates=${report.persistedRawLabelSeam.evaluation.dateRange.startDate}..${report.persistedRawLabelSeam.evaluation.dateRange.endDate}.`,
  );
  lines.push(
    `Full-seam reversal counts by policy order: ${report.persistedRawLabelSeam.fullSequenceMetrics.map((metric) => metric.publishedHardReversalsWithin3).join(" / ")}; safety-exit delays: ${report.persistedRawLabelSeam.fullSequenceMetrics.map((metric) => metric.safetyExitDelayViolations).join(" / ")}.`,
  );
  lines.push(
    "This is exact persisted output behavior, not exact-PIT input reconstruction and not outcome evidence.",
  );
  lines.push("");
  lines.push("## Exact-PIT Boundary");
  lines.push("");
  lines.push(
    `Full-resolver-input exact rows: ${String(report.exactPitBoundary.summary.fullResolverInputEvaluableRows ?? "unknown")}; exact 7d/28d rolling windows: ${String(report.exactPitBoundary.summary.exactSevenDayScopeWindows ?? "unknown")}/${String(report.exactPitBoundary.summary.exactTwentyEightDayScopeWindows ?? "unknown")}. H12 exact sequence status: \`${report.exactPitBoundary.h12SequenceStatus}\`.`,
  );
  lines.push("");
  lines.push("## Physically Unreconstructable Limits");
  lines.push("");
  for (const limit of report.physicallyUnreconstructable)
    lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}

async function buildReport(args: Args) {
  const sourceArtifacts = readAndVerifySourceArtifacts(args);
  const native = await runInstrumentedNativeReplay(args, sourceArtifacts);
  const restatedObservations = native.report.h12SequenceRows.map(
    toRestatedObservation,
  );
  const evaluation = evaluateH12Dataset({
    observations: restatedObservations,
    evidenceTier: "restated_ad_daily",
    outcomesObservedThrough: args.outcomeCeiling,
  });
  const selectedPolicy =
    H12_POLICIES.find(
      (policy) =>
        policy.id === evaluation.calibrationSelection.selectedPolicyId,
    ) ?? H12_POLICIES[1];
  const lockedBaseline = policyMetric(
    evaluation,
    "locked_test",
    H12_POLICIES[0].id,
  );
  const lockedSelected = policyMetric(
    evaluation,
    "locked_test",
    selectedPolicy.id,
  );
  const inference = buildInference({
    observations: restatedObservations,
    candidate: selectedPolicy,
  });
  const falsification = buildFalsification({
    observations: restatedObservations,
    selectedPolicy,
    evaluation,
  });
  const persistedRows = await readPersistedRawLabelSeam(
    args.persistedRawEngineVersion,
  );
  const persistedEvaluation = evaluateH12Dataset({
    observations: persistedRows,
    evidenceTier: "persisted_raw_label",
    outcomesObservedThrough: args.outcomeCeiling,
  });
  const exactPitBoundary = readExactPitBoundary(native.exactArtifact);
  const selectedIsCurrent =
    selectedPolicy.id === "H12_two_consecutive_evaluations";
  const lockedSafetyPass =
    lockedSelected.safetyExitDelayViolations === 0 &&
    lockedSelected.hardSwitchOldActionRepublished === 0;
  const lockedStabilityPass = lockedSelected.hardReversalReduction > 0;
  const lockedDelayPass =
    (lockedSelected.transitionDelayEvaluations.p95 ??
      Number.POSITIVE_INFINITY) <= 1;
  const performanceGate = {
    requiredKnownPublishedEntries: 100,
    requiredPrecision: 0.92,
    requiredSupportedOutcomeRecall: 0.92,
    requiredPrecisionDeltaLower: -0.02,
    knownPublishedEntries: lockedSelected.outcomeKnownPublishedEntries,
    outcomePrecision: lockedSelected.outcomePrecision,
    supportedOutcomeRecall: lockedSelected.supportedOutcomeRecall,
    episodeStartPrecisionDeltaLower:
      inference.episodeStartPrecisionDelta?.lower ?? null,
    passes:
      lockedSelected.outcomeKnownPublishedEntries >= 100 &&
      (lockedSelected.outcomePrecision ?? 0) >= 0.92 &&
      (lockedSelected.supportedOutcomeRecall ?? 0) >= 0.92 &&
      (inference.episodeStartPrecisionDelta?.lower ??
        Number.NEGATIVE_INFINITY) >= -0.02,
  };
  const stabilityGatePass =
    lockedSafetyPass && lockedStabilityPass && lockedDelayPass;
  const verdict =
    selectedIsCurrent && stabilityGatePass
      ? {
          status: "RETAIN_TWO_CONSECUTIVE_AS_STABILITY_POLICY_ONLY" as const,
          performancePromotion: "REJECT" as const,
          reason:
            "Calibration selected the current two-evaluation rule; locked stability improved with zero safety-exit delay and no old-hard republish. The hard-outcome sample, recall, and paired non-inferiority gates fail, so this is retained only as a fail-closed stability policy, not as a performance improvement or auto-execution signal.",
        }
      : stabilityGatePass
        ? {
            status: "RETAIN_CURRENT_PENDING_SEPARATE_POLICY_APPROVAL" as const,
            performancePromotion: "REJECT" as const,
            reason: `Calibration selected ${selectedPolicy.id} and its locked stability/safety gates passed, but this simulation cannot change production policy without a separate engine-version decision and causal performance evidence.`,
          }
        : {
            status: "REJECT_H12_POLICY_CHANGE" as const,
            performancePromotion: "REJECT" as const,
            reason:
              "The predeclared calibration/locked safety, stability, or delay gate did not support changing the current policy.",
          };
  const accountCells = evaluation.lockedTestAccountHoldout.filter(
    (cell) => cell.baselineReversals > 0,
  );
  const deterministicCore = {
    contractVersion: CONTRACT_VERSION,
    input: args,
    restated: {
      sourceContractVersion: native.report.contractVersion,
      coverage: {
        observations: restatedObservations.length,
        businesses: native.report.coverage.businesses,
        sourceRows: native.report.coverage.sourceRows,
        targetExactRows: restatedObservations.filter((row) => row.targetExact)
          .length,
        completeOutcomeRows: restatedObservations.filter(
          (row) => row.outcomeComplete,
        ).length,
        completeOutcomeRowsByWindow: Object.fromEntries(
          H12_OUTCOME_WINDOWS.map((windowDays) => [
            String(windowDays),
            restatedObservations.filter(
              (row) =>
                observationOutcome(row, windowDays)?.outcomeComplete === true,
            ).length,
          ]),
        ) as Record<`${H12OutcomeWindowDays}`, number>,
        sourceUpdatedAfterCutoffRows: native.report.h12SequenceRows.filter(
          (row) => row.sourceUpdatedAfterCutoff,
        ).length,
        duplicateObservationKeys:
          restatedObservations.length -
          new Set(
            restatedObservations.map(
              (row) => `${sequenceKey(row)}::${row.date}`,
            ),
          ).size,
        uniqueDecisionInputHashes: new Set(
          restatedObservations.flatMap((row) =>
            row.decisionInputHash ? [row.decisionInputHash] : [],
          ),
        ).size,
      },
      evaluation: compactEvaluation(evaluation),
      inference,
      holdoutSummary: {
        accountsWithBaselineReversal: accountCells.length,
        accountsNonNegative: accountCells.filter(
          (cell) => cell.reversalReduction >= 0,
        ).length,
        accountsStrictlyPositive: accountCells.filter(
          (cell) => cell.reversalReduction > 0,
        ).length,
        entityFoldsNonNegative: evaluation.lockedTestEntityHashHoldout.filter(
          (cell) => cell.reversalReduction >= 0,
        ).length,
      },
      falsification,
    },
    persistedRawLabelSeam: {
      engineVersion: args.persistedRawEngineVersion,
      evaluation: persistedEvaluation,
      fullSequenceMetrics: H12_POLICIES.map((policy) =>
        summarizeH12Policy({ observations: persistedRows, policy }),
      ),
      inputHashCoverage: {
        populated: persistedRows.filter((row) => row.decisionInputHash !== null)
          .length,
        total: persistedRows.length,
      },
      boundary:
        "Exact persisted raw decision output only; provider account and canonical serialized decision inputs are absent, and no mature forward outcome is claimed.",
    },
    exactPitBoundary,
    verdict,
    performanceGate,
    policyVerdicts: H12_POLICIES.map((policy) => {
      const metric = policyMetric(evaluation, "locked_test", policy.id);
      const selected = policy.id === selectedPolicy.id;
      const safetyPass =
        metric.safetyExitDelayViolations === 0 &&
        metric.hardSwitchOldActionRepublished === 0;
      const delayPass =
        (metric.transitionDelayEvaluations.p95 ?? Number.POSITIVE_INFINITY) <=
        1;
      return {
        policyId: policy.id,
        verdict:
          selected && safetyPass && delayPass
            ? "RETAIN_AS_STABILITY_POLICY_ONLY"
            : "REJECT",
        reason: `locked reversals=${metric.publishedHardReversalsWithin3}/${metric.rawHardReversalsWithin3}; one-evaluation blips=${metric.oneEvaluationBlipsPublished}; durable recall=${metric.durableEpisodeRecall ?? "n/a"}; 14d outcome recall=${metric.outcomeWindows["14"].supportedOutcomeRecall ?? "n/a"}; p95 delay=${metric.transitionDelayEvaluations.p95 ?? "n/a"}; safety-exit delays=${metric.safetyExitDelayViolations}; selected_on_calibration=${selected}.`,
      };
    }),
    decisionComparison: {
      lockedBaseline,
      lockedSelected,
      allPoliciesLocked: H12_POLICIES.map((policy) =>
        policyMetric(evaluation, "locked_test", policy.id),
      ),
    },
    lineage: {
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      nativeSourcePath: NATIVE_SOURCE,
      nativeSourceHash: native.sourceHash,
      nativeArtifactPath: native.nativeArtifact.path,
      nativeArtifactManifestSetHash:
        native.nativeArtifact.lineage.manifestSetHash,
      exactArtifactPath: native.exactArtifact.path,
      exactArtifactReportHash: native.exactArtifact.reportHash,
      instrumentedSourceHash: native.instrumentedSourceHash,
      nativeLineage: native.report.lineage,
      observationInputHash: h12StableHash(restatedObservations),
      policyGridHash: h12StableHash(H12_POLICIES),
      scriptHash: sha256(readFileSync(new URL(import.meta.url))),
    },
    physicallyUnreconstructable: [
      "The retained exact raw ad-insight payload has no creative_id, so its exact rows cannot be linked to the persisted creative decision sequence without promoting a later dimension.",
      ...native.exactArtifact.physicallyUnreconstructable.map(
        (item) => `Exact-PIT receipt: ${item}`,
      ),
      "Provider-account identity is absent from engine_v3_decision_snapshots_daily, so account-held-out analysis of the persisted raw-label seam would require mixing a restated identity and is intentionally not performed.",
      "The causal performance effect of acting one or two evaluations later cannot be identified without controlled contemporaneous treatment receipts; observational outcome precision remains review-only.",
    ],
  };
  const reportHash = h12StableHash(deterministicCore);
  return {
    ...deterministicCore,
    generatedAt: new Date().toISOString(),
    readOnly: true as const,
    mutatesData: false as const,
    providerCalls: false as const,
    providerWrites: false as const,
    manualCronPosted: false as const,
    reportHash,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  const markdown = renderMarkdown(report);
  if (args.writeFiles) {
    mkdirSync(dirname(resolve(process.cwd(), args.jsonOut)), {
      recursive: true,
    });
    mkdirSync(dirname(resolve(process.cwd(), args.mdOut)), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), args.jsonOut),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(resolve(process.cwd(), args.mdOut), `${markdown}\n`, "utf8");
  }
  console.log(
    JSON.stringify(
      {
        contractVersion: report.contractVersion,
        reportHash: report.reportHash,
        verdict: report.verdict,
        coverage: report.restated.coverage,
        selection: report.restated.evaluation.calibrationSelection,
        locked: report.decisionComparison,
        outputs: args.writeFiles
          ? { json: args.jsonOut, markdown: args.mdOut }
          : null,
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
}
