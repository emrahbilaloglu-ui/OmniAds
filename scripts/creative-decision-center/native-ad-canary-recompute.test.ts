import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

import {
  parseCanaryArgs,
  runCanaryRecompute,
  type CanaryRecomputeDependencies,
} from "./native-ad-canary-recompute";

const GRANDMIX = "5dbc7147-f051-4681-a4d6-20617170074f";
const THESWAF = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const NOW = "2026-09-24T15:40:00.000Z";
const CALIBRATION_ID = "10000000-0000-4000-8000-000000000001";
const DECISION_ID = "10000000-0000-4000-8000-000000000002";
const BATCH_ID = "10000000-0000-4000-8000-000000000003";

function fixture() {
  const scope = {
    businessName: "Grandmix",
    selectedMetaAccounts: 1,
    sourcePointerUpdatedAt: "2026-09-24T15:30:00.000Z",
    previousDecisionRunId: "10000000-0000-4000-8000-000000000004",
    previousDecisionFinishedAt: "2026-09-24T15:20:00.000Z",
  };
  const readScope = vi.fn().mockResolvedValue(scope);
  const withChainLock = vi.fn(async (_scope, run) => ({ acquired: true, value: await run() }));
  const runCalibration = vi.fn().mockResolvedValue({
    status: "success", jobRunId: CALIBRATION_ID, idempotentReplay: false,
    batches: [{ batchId: BATCH_ID }],
  });
  const readCalibration = vi.fn().mockResolvedValue({
    status: "success", engineVersion: NATIVE_AD_ENGINE_VERSION,
    asOf: "2026-09-24", accountBatchCount: 1,
    startedAt: "2026-09-24T15:35:00.000Z",
    receiptBatchCount: 1, requestedBatchesMatched: 1,
    earliestCutoff: "2026-09-24T15:35:00.000Z",
  });
  const runDecisions = vi.fn().mockResolvedValue({
    status: "success", jobRunId: DECISION_ID, snapshotsWritten: 49,
  });
  const readDecision = vi.fn().mockResolvedValue({
    status: "success", engineVersion: NATIVE_AD_ENGINE_VERSION,
    asOf: "2026-09-24", dependencyRunId: CALIBRATION_ID,
    snapshotCount: 49, earliestComputedAt: "2026-09-24T15:37:00.000Z",
    authorizedCount: 0, rawCutCount: 3, configAuthorityHoldCount: 3,
  });
  const deps = {
    now: () => new Date(NOW), readScope, withChainLock, runCalibration,
    readCalibration, runDecisions, readDecision,
  } as unknown as CanaryRecomputeDependencies;
  return { scope, deps, readScope, withChainLock, runCalibration, readCalibration,
    runDecisions, readDecision };
}

const oldApply = process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY;
const oldMigrations = process.env.ENABLE_RUNTIME_MIGRATIONS;
beforeEach(() => {
  process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY = "1";
  process.env.ENABLE_RUNTIME_MIGRATIONS = "0";
});
afterEach(() => {
  if (oldApply === undefined) delete process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY;
  else process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY = oldApply;
  if (oldMigrations === undefined) delete process.env.ENABLE_RUNTIME_MIGRATIONS;
  else process.env.ENABLE_RUNTIME_MIGRATIONS = oldMigrations;
});

describe("native Ad canary recompute", () => {
  it("accepts only one or two exact release canaries", () => {
    expect(parseCanaryArgs(["--business", GRANDMIX, "--business", THESWAF, "--apply"]))
      .toEqual({ businessIds: [GRANDMIX, THESWAF], apply: true });
    expect(() => parseCanaryArgs(["--business", GRANDMIX, "--business", GRANDMIX]))
      .toThrow(/distinct/);
    expect(() => parseCanaryArgs(["--business", "00000000-0000-4000-8000-000000000000"]))
      .toThrow(/outside/);
    expect(() => parseCanaryArgs(["--business", GRANDMIX, "--unexpected"]))
      .toThrow(/Unknown/);
  });

  it("previews the exact live identity without taking a lock or writing", async () => {
    const fx = fixture();
    const result = await runCanaryRecompute({ businessIds: [GRANDMIX], apply: false }, fx.deps);
    expect(result.mode).toBe("dry_run");
    expect(result.scope[0]).toMatchObject({
      businessId: GRANDMIX, name: "Grandmix", selectedMetaAccounts: 1,
    });
    expect(fx.withChainLock).not.toHaveBeenCalled();
    expect(fx.runCalibration).not.toHaveBeenCalled();
    expect(fx.runDecisions).not.toHaveBeenCalled();
  });

  it("forces the current UTC generation under one chain lock and proves its dependency", async () => {
    const fx = fixture();
    const result = await runCanaryRecompute({ businessIds: [GRANDMIX], apply: true }, fx.deps);
    expect(fx.withChainLock).toHaveBeenCalledWith(
      { businessId: GRANDMIX, asOf: "2026-09-24" }, expect.any(Function),
    );
    expect(fx.runCalibration).toHaveBeenCalledWith({ businessId: GRANDMIX, asOf: "2026-09-24" });
    expect(fx.readCalibration).toHaveBeenCalledWith(CALIBRATION_ID, [BATCH_ID]);
    expect(fx.runDecisions).toHaveBeenCalledWith({ businessId: GRANDMIX, asOf: "2026-09-24" });
    expect(result.results[0]).toMatchObject({
      calibrationRunId: CALIBRATION_ID, decisionRunId: DECISION_ID,
      dependencyRunId: CALIBRATION_ID, snapshotCount: 49, rawCutCount: 3,
    });
  });

  it("requires the independent apply opt-in before any lock or producer call", async () => {
    const fx = fixture();
    delete process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY;
    await expect(runCanaryRecompute({ businessIds: [GRANDMIX], apply: true }, fx.deps))
      .rejects.toThrow(/ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY/);
    expect(fx.withChainLock).not.toHaveBeenCalled();
  });

  it("refuses a source pointer changed after the calibration snapshot", async () => {
    const fx = fixture();
    fx.readScope.mockResolvedValueOnce(fx.scope).mockResolvedValueOnce(fx.scope)
      .mockResolvedValueOnce({ ...fx.scope,
        sourcePointerUpdatedAt: "2026-09-24T15:36:00.000Z" });
    await expect(runCanaryRecompute({ businessIds: [GRANDMIX], apply: true }, fx.deps))
      .rejects.toThrow(/pointer changed after/);
    expect(fx.runCalibration).toHaveBeenCalledTimes(1);
    expect(fx.runDecisions).not.toHaveBeenCalled();
  });

  it("allows a fresh successful observation that reuses unchanged old batch content", async () => {
    const fx = fixture();
    fx.runCalibration.mockResolvedValue({
      status: "success", jobRunId: CALIBRATION_ID, idempotentReplay: true,
      batches: [{ batchId: BATCH_ID }],
    });
    fx.readCalibration.mockResolvedValue({
      status: "success", engineVersion: NATIVE_AD_ENGINE_VERSION,
      asOf: "2026-09-24", accountBatchCount: 1,
      receiptBatchCount: 1, requestedBatchesMatched: 1,
      startedAt: "2026-09-24T15:35:00.000Z",
      earliestCutoff: "2026-09-24T03:10:00.000Z",
    });
    const result = await runCanaryRecompute({ businessIds: [GRANDMIX], apply: true }, fx.deps);
    expect(result.results[0]).toMatchObject({
      calibrationIdempotentReplay: true,
      calibrationBatchCutoff: "2026-09-24T03:10:00.000Z",
      decisionRunId: DECISION_ID,
    });
  });

  it("refuses an unbound decision job even when it reports success", async () => {
    const fx = fixture();
    fx.readDecision.mockResolvedValue({
      status: "success", engineVersion: NATIVE_AD_ENGINE_VERSION,
      asOf: "2026-09-24", dependencyRunId: null,
      snapshotCount: 49, earliestComputedAt: "2026-09-24T15:37:00.000Z",
      authorizedCount: 0, rawCutCount: 3, configAuthorityHoldCount: 3,
    });
    await expect(runCanaryRecompute({ businessIds: [GRANDMIX], apply: true }, fx.deps))
      .rejects.toThrow(/dependency/);
  });
});
