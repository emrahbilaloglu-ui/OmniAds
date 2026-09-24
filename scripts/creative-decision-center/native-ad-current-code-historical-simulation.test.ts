import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL,
  MAX_SIMULATED_DAYS,
  NativeDecisionSimulationUsageError,
  SIMULATION_CLAIM,
  assertSimulationSessionReadOnly,
  buildSimulationEvaluation,
  describeSimulationPolicy,
  mergePriorLabelSources,
  parseNativeDecisionSimulationArgs,
  simulateInsideReadOnlyTransaction,
  toCarriedPriorLabels,
  verifySimulationHashIntegrity,
} from "./native-ad-current-code-historical-simulation";
import { applyLabelHysteresis } from "@/lib/creative-decision-engine/decision-stability";
import type { PreviousAdPublishedLabel } from "@/lib/creative-decision-engine/decision-stability";
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { buildCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/evaluation-store";
import type { AdDecisionComputation } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "@/lib/creative-decision-engine/native-ad-hydration-authority";
import { NATIVE_AD_ENGINE_VERSION, type AdDecisionInput } from "@/lib/creative-decision-engine/types";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth } from "@/lib/creative-decision-engine/__tests__/helpers";

function evaluationFixture() {
  const ad: AdDecisionInput = {
    ...makeCreativeInput(),
    decisionEntityType: "ad", decisionEntityId: "ad-1", adId: "ad-1",
    providerAccountRefId: "r", providerAccountId: "act",
    accountTimezone: "UTC", accountCurrency: "USD", adsetId: "adset-1",
    optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "PURCHASE",
    metricEvidence: { sourceRowCount: 28, performanceMetricsObserved: true, eventMetricsObserved: false, purchaseUnverifiedEconomicDays: 0 },
    configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY,
    statusEvidence: { source: "missing", sourceRecordId: null, observedAt: null, capturedAt: null },
    creativeEvidence: {
      sourceLifecycleRowId: null, sourceAsOfDate: null, sourceComputedAt: null, sourceMaxUpdatedAt: null,
      lifecyclePosition: null, daysSincePeak: null, peakRoas30d: null, peakConfidence: null,
      spendTrajectory30d: null, spendSlope7d: null, spendSlope30d: null, roasSlope7d: null, roasSlope30d: null,
      fatigueStatus: "unknown", qualityRanking: null, engagementRateRanking: null, conversionRateRanking: null, creativeFormat: null,
    },
  };
  const computation: AdDecisionComputation = {
    input: ad,
    decision: {
      decisionEntityType: "ad", decisionEntityId: ad.adId, adId: ad.adId,
      providerAccountId: ad.providerAccountId, creativeId: ad.creativeId,
      creativeName: ad.creativeName, label: "keep", reason: "Awaiting evidence",
      confidence: 40, truthSource: "commercial_truth", effectiveTargetRoas: 2,
      ratioToTarget: 1, badges: [], metrics: { spend: 500, purchases: 8, roas: 3, recent7dRoas: 2.8 },
      engineVersion: NATIVE_AD_ENGINE_VERSION, generatedAt: "2026-08-20T03:00:00.000Z",
      preAuthorityLabel: "cut", authorityBlocker: null,
    },
    rawLabel: "cut", hysteresisSuppressed: true,
    campaignContext: { mode: "automatic", source: "unknown", campaignId: ad.campaignId, kind: null, testDimension: null, contextTrust: "unknown" },
    priorHysteresis: { source: "none" },
  };
  return {
    computation,
    profile: makeAccountDecisionProfile(),
    dataHealth: makeDataHealth(),
    flags: { ...flags(true, "business_override"), businessId: "biz-1" },
    evaluatedAt: "2026-08-20T03:00:00.000Z",
  };
}

const valid = [
  "--business", "business-1",
  "--asOf", "2026-08-21",
  "--cutoff", "2026-08-21T03:04:38.924Z",
];

describe("native current-code historical simulation boundary", () => {
  it("requires an exact business, day, and canonical cutoff", () => {
    expect(parseNativeDecisionSimulationArgs(valid)).toMatchObject({
      businessId: "business-1",
      asOf: "2026-08-21",
      cutoff: "2026-08-21T03:04:38.924Z",
      write: false,
      outPath: null,
    });
    expect(() => parseNativeDecisionSimulationArgs(valid.slice(2))).toThrow(
      NativeDecisionSimulationUsageError,
    );
    expect(() =>
      parseNativeDecisionSimulationArgs([
        ...valid.slice(0, 4),
        "--cutoff", "2026-08-22T03:04:38.924Z",
      ]),
    ).toThrow(/must fall on --asOf/);
  });

  it("writes an artifact only when both switches are explicit", () => {
    expect(parseNativeDecisionSimulationArgs([...valid, "--out", "/tmp/report.json"]).write)
      .toBe(false);
    expect(() => parseNativeDecisionSimulationArgs([...valid, "--write", "1"]))
      .toThrow(/requires --out/);
    expect(
      parseNativeDecisionSimulationArgs([
        ...valid,
        "--write", "1",
        "--out", "/tmp/report.json",
      ]).write,
    ).toBe(true);
  });

  it("refuses a session that is not read-only", async () => {
    const db = (value: string) => ({
      query: async () => [{ default_transaction_read_only: value }],
    });
    await expect(assertSimulationSessionReadOnly(db("off") as never)).rejects.toThrow(
      /default_transaction_read_only/,
    );
    await expect(assertSimulationSessionReadOnly(db("on") as never)).resolves.toBeUndefined();
  });

  it("orchestrates production readers and pure decision functions without a writer", () => {
    const source = code(SIMULATOR);
    for (const required of [
      "hydrateAdDecisionInputs",
      "READ_NATIVE_AD_CALIBRATION_SOURCE_SQL",
      "computeNativeAdCalibrationBatch",
      "resolveNativeAdDecisionProfileGroups",
      "computeReadyNativeAdDecisions(",
      "computeSoftOnlyNativeAdDecisions(",
    ]) {
      expect(source).toContain(required);
    }
    for (const forbidden of [
      "runAdCalibrationJob",
      "runAdDecisionsJob",
      "replaceNativeAdCalibrationBatch",
      "persistAdDecisionEvaluations",
      "upsertNativeAdDecisionSnapshots",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

const SIMULATOR =
  "scripts/creative-decision-center/native-ad-current-code-historical-simulation.ts";
/** Source with comments stripped, so a pin cannot be satisfied by prose. */
function code(path: string) {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

describe("it runs the production chain, not a copy of it", () => {
  it("calls the job's own helpers and defines none of its own", () => {
    const source = code(SIMULATOR);
    for (const shared of [
      "computeReadyNativeAdDecisions(",
      "readAdCampaignContext(",
      "groupNativeProfileInputsByScope(",
      "mergeUniqueMap(",
      "assertEmptyNativeAdHydrationIsAuthoritative(",
      // The D098 config-source gate and the authorized-action rule run at
      // PAYLOAD time, after the decision; reading the decision alone misses both.
      "toNativeSnapshotPayload(",
    ]) {
      expect(source, shared).toContain(shared);
    }
    expect(source).toContain("persistedAuthorityBlocker: payload.authority_blocker");
    expect(source).toContain("authorizedAction: payload.authorized_action");
    // The copies that used to live here, and the blocker they invented.
    expect(source).not.toContain("simulation_profile_shape_invalid");
    expect(source).not.toMatch(/function readCampaignContexts\b/);
    expect(source).not.toMatch(/function groupInputsByScope\b/);
    expect(source).not.toMatch(/\bcomputeNativeAdDecisions\(/);
  });

  it("the job exports exactly those helpers, so the two cannot drift", () => {
    const job = readFileSync(
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
      "utf8",
    );
    for (const exported of [
      "export function computeReadyNativeAdDecisions(",
      "export async function readAdCampaignContext(",
      "export function groupNativeProfileInputsByScope(",
      "export function mergeUniqueMap<T>(",
      "export function assertEmptyNativeAdHydrationIsAuthoritative(",
    ]) {
      expect(job, exported).toContain(exported);
    }
    // The production path never passes the replay-only cutoff.
    const start = job.indexOf("export async function runAdDecisionsJob(");
    // The job body ends at the first top-level closing brace after it.
    const run = job.slice(start, job.indexOf("\n}\n", start));
    expect(run).toContain("readAdCampaignContext(");
    expect(run).toContain("readPreviousPublishedAdLabels(");
    expect(run).not.toContain("visibleAtCutoff");
  });

  it("bounds both upserted readers by the simulated cutoff", () => {
    const source = code(SIMULATOR);
    const context = source.slice(source.indexOf("readAdCampaignContext({"));
    expect(context.slice(0, 400)).toContain("visibleAtCutoff: day.cutoff");
    const prior = source.slice(source.indexOf("readPreviousPublishedAdLabels("));
    expect(prior.slice(0, 900)).toContain("visibleAtCutoff: day.cutoff");
  });
});

describe("chained days", () => {
  it("accepts an ascending cutoff list ending on --asOf", () => {
    const parsed = parseNativeDecisionSimulationArgs([
      "--business", "business-1",
      "--asOf", "2026-08-21",
      "--cutoff", "2026-08-20T03:05:10.000Z,2026-08-21T03:04:38.924Z",
    ]);
    expect(parsed.chain).toEqual([
      { asOf: "2026-08-20", cutoff: "2026-08-20T03:05:10.000Z" },
      { asOf: "2026-08-21", cutoff: "2026-08-21T03:04:38.924Z" },
    ]);
    expect(parsed.cutoff).toBe("2026-08-21T03:04:38.924Z");
  });

  it("refuses an unordered, same-day or over-long chain", () => {
    const base = ["--business", "b", "--asOf", "2026-08-21", "--cutoff"];
    expect(() => parseNativeDecisionSimulationArgs([
      ...base, "2026-08-21T03:04:38.924Z,2026-08-20T03:05:10.000Z",
    ])).toThrow(/strictly ascending/);
    expect(() => parseNativeDecisionSimulationArgs([
      ...base, "2026-08-21T01:00:00.000Z,2026-08-21T03:04:38.924Z",
    ])).toThrow(/one cutoff per UTC day/);
    const tooMany = Array.from({ length: MAX_SIMULATED_DAYS + 1 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 1 + i, 3)).toISOString());
    expect(() => parseNativeDecisionSimulationArgs([
      "--business", "b", "--asOf", tooMany.at(-1)!.slice(0, 10), "--cutoff", tooMany.join(","),
    ])).toThrow(/at most/);
  });
});

function priorLabel(
  key: string,
  published: PreviousAdPublishedLabel["publishedLabel"],
  raw: PreviousAdPublishedLabel["rawLabel"],
): PreviousAdPublishedLabel {
  return {
    businessId: "b", providerAccountRefId: "r", providerAccountId: "act",
    decisionEntityType: "ad", decisionEntityId: key,
    sourceSnapshotId: "s", sourceEvaluationId: "e", sourceEngineVersion: "v",
    sourceAsOfDate: "2026-08-20", sourceComputedAt: "2026-08-20T03:00:00.000Z",
    sourceInputHash: "i", sourceDecisionHash: "d",
    publishedLabel: published, rawLabel: raw,
  };
}

describe("prior labels for a simulated day", () => {
  it("prefers the earlier simulated day over a persisted row, and counts the override", () => {
    const merged = mergePriorLabelSources({
      persisted: new Map([["a", priorLabel("a", "keep", "keep")]]),
      carried: new Map([["a", priorLabel("a", "keep", "cut")]]),
      persistedWithheld: new Map(),
      keysInScope: new Set(["a"]),
    });
    expect(merged.labels.get("a")?.rawLabel).toBe("cut");
    expect(merged.counts).toMatchObject({
      fromSimulatedPriorDay: 1,
      fromPersistedRow: 0,
      simulatedOverridesPersisted: 1,
    });
  });

  it("NEGATIVE: a withheld (rewritten-after-cutoff) prior starts cold, it is never replaced", () => {
    const merged = mergePriorLabelSources({
      persisted: new Map(),
      carried: new Map(),
      persistedWithheld: new Map([["a", "overwritten_after_cutoff"]]),
      keysInScope: new Set(["a"]),
    });
    expect(merged.labels.has("a")).toBe(false);
    expect(merged.counts.persistedWithheldOverwritten).toBe(1);
    // Cold start is the conservative side: an unconfirmed hard verdict is held.
    expect(applyLabelHysteresis("cut", merged.labels.get("a"))).toEqual({
      publishedLabel: "keep", rawLabel: "cut", suppressed: true,
    });
  });

  it("POSITIVE: the carried day-1 verdict confirms the same day-2 verdict", () => {
    const fixture = evaluationFixture();
    const evaluation = buildSimulationEvaluation(fixture);
    const carried = toCarriedPriorLabels({
      businessId: "b",
      asOf: "2026-08-20",
      cutoff: "2026-08-20T03:00:00.000Z",
      decisions: [{
        scope: { type: "account", id: "act" },
        computation: fixture.computation,
        evaluation,
      }],
    });
    const [prior] = [...carried.values()];
    expect(prior).toMatchObject({
      publishedLabel: "keep", rawLabel: "cut", sourceAsOfDate: "2026-08-20",
    });
    expect(prior!.sourceSnapshotId).toMatch(/^read-only-simulation:/);
    expect(prior!.sourceInputHash).toBe(evaluation.inputHash);
    expect(prior!.sourceDecisionHash).toBe(evaluation.decisionHash);
    // Day 1 held the Cut for a second evaluation; day 2's Cut is confirmed.
    expect(applyLabelHysteresis("cut", prior)).toEqual({
      publishedLabel: "cut", rawLabel: "cut", suppressed: false,
    });
  });
});

describe("canonical simulation provenance", () => {
  it("uses the production envelopes, binds changed input, and excludes the evaluation clock", () => {
    const fixture = evaluationFixture();
    const { computation: c } = fixture;
    const expected = buildAdCanonicalEvaluationProvenance({
      identity: {
        providerAccountRefId: c.input.providerAccountRefId,
        providerAccountId: c.input.providerAccountId, decisionEntityType: "ad",
        decisionEntityId: c.input.decisionEntityId, adId: c.input.adId, creativeId: c.input.creativeId,
      },
      adEvidence: { customConversionId: c.input.customConversionId, configAuthority: c.input.configAuthority },
      base: buildCanonicalEvaluationProvenance({
        engineVersion: NATIVE_AD_ENGINE_VERSION, accountProfile: fixture.profile,
        dataHealth: fixture.dataHealth, flags: fixture.flags, scope: fixture.profile.scope,
        creativeInput: c.input, campaignContext: c.campaignContext, priorHysteresis: c.priorHysteresis,
        decision: c.decision, rawLabel: c.rawLabel, publishedLabel: c.decision.label,
        hysteresisSuppressed: c.hysteresisSuppressed, evaluatedAt: fixture.evaluatedAt,
      }),
    });
    const actual = buildSimulationEvaluation(fixture);
    expect(actual).toEqual(expected);
    expect(actual.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(actual.decisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildSimulationEvaluation({ ...fixture, evaluatedAt: "2026-08-21T03:00:00.000Z" })).toEqual(actual);
    const changed = buildSimulationEvaluation({
      ...fixture, computation: { ...c, input: { ...c.input, spend: c.input.spend + 1 } },
    });
    expect(changed.inputHash).not.toBe(actual.inputHash);
    expect(changed.decisionHash).not.toBe(actual.decisionHash);
  });

  it("verifies the full hash chain and refuses tampered envelopes, snapshot or carried hashes", () => {
    const fixture = evaluationFixture();
    const evaluation = buildSimulationEvaluation(fixture);
    const carried = toCarriedPriorLabels({
      businessId: "biz-1", asOf: "2026-08-20", cutoff: fixture.evaluatedAt,
      decisions: [{ scope: fixture.profile.scope, computation: fixture.computation, evaluation }],
    });
    const row = { evaluation, payload: { input_hash: evaluation.inputHash, decision_hash: evaluation.decisionHash } };
    expect(verifySimulationHashIntegrity([row], carried)).toMatchObject({
      evaluationsVerified: 1, canonicalHashesVerified: true, snapshotHashesMatch: true, carriedHashesMatch: true,
    });
    expect(() => verifySimulationHashIntegrity([{ ...row, evaluation: { ...evaluation, inputHash: "f".repeat(64) } }], carried)).toThrow();
    expect(() => verifySimulationHashIntegrity([{ ...row, payload: { ...row.payload, input_hash: "read-only-simulation:fake" } }], carried)).toThrow(/hashes differ/);
    const [key, prior] = [...carried.entries()][0];
    expect(() => verifySimulationHashIntegrity([row], new Map([[key, { ...prior, sourceDecisionHash: "read-only-simulation:fake" }]]))).toThrow(/hashes differ/);
  });
});

function flags(enabled: boolean, source: "business_override" | "env_default"): EngineV3Flags {
  return {
    businessId: "b",
    enabled,
    surfaceVisible: false,
    shadowOnly: true,
    presetOverride: null,
    source: { enabled: source, surfaceVisible: "env_default", shadowOnly: "env_default", presetOverride: null },
    envDefaults: { enabled, surfaceVisible: false, shadowOnly: true },
  } as unknown as EngineV3Flags;
}

describe("the policy it applies, and the one it cannot", () => {
  it("names flags that came from this process's environment", () => {
    const policy = describeSimulationPolicy(flags(true, "business_override"));
    expect(policy.resolvedAt).toBe("simulation_run_time_not_point_in_time");
    expect(policy.envDerivedFlags).toEqual(["surfaceVisible", "shadowOnly"]);
  });

  it("separates what it proves into lanes and claims no integrated job", () => {
    expect(SIMULATION_CLAIM).toMatchObject({
      currentCodePureCompute: true,
      integratedPersistedJob: false,
      persistedCalibrationUsed: false,
      providerMutation: "none_no_provider_client_in_this_runner",
      databaseWrites: "none_read_only_transaction",
    });
    expect(SIMULATION_CLAIM.pointInTimeAuthority.policyFlags).toBe(
      "current_not_point_in_time",
    );
    expect(code(SIMULATOR)).not.toContain("currentCodeAndPolicy");
  });

  it("NEGATIVE: a disabled business is skipped exactly as the job skips it", async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        if (text.startsWith("SET")) return [];
        if (text === "SHOW default_transaction_read_only") return [{ default_transaction_read_only: "on" }];
        if (text === "SHOW transaction_isolation") return [{ transaction_isolation: "repeatable read" }];
        if (text === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
        if (text.includes("txid_current_snapshot")) {
          return [{ started_at: "2026-09-22T10:00:00.000Z", snapshot_id: "1:2:" }];
        }
        throw new Error(`a disabled business must read nothing else: ${text.slice(0, 50)}`);
      },
    };
    const report = await simulateInsideReadOnlyTransaction(
      parseNativeDecisionSimulationArgs(valid),
      { resolveFlags: async () => flags(false, "business_override") },
      db as never,
    );
    expect(report).toMatchObject({
      status: "skipped",
      reason: "engine_v3_disabled",
      days: [],
      claim: { currentCodePureCompute: false, integratedPersistedJob: false },
    });
    expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  });
});

describe("what a historical cutoff cannot see", () => {
  it("counts ad-days that existed at the cutoff but were restated after it", () => {
    /* Calibration and hydration both admit a row only when created_at AND
       updated_at are at or before the cutoff, so these are invisible to both;
       the report counts them because they cannot be reconstructed. */
    const sql = COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL.replace(/\s+/g, " ");
    expect(sql).toContain("created_at <= $3::timestamptz");
    expect(sql).toContain("updated_at > $3::timestamptz");
    expect(SIMULATION_CLAIM.pointInTimeAuthority.adDaysRestatedAfterCutoff).toBe(
      "unobservable_at_cutoff_counted_not_reconstructed",
    );
  });
});
