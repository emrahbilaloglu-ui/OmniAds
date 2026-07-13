import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AD_CALIBRATION_JOB_NAME,
  type AdCalibrationJobResult,
} from "../../jobs/ad-calibration-job";
import {
  AD_DECISIONS_JOB_NAME,
  type AdDecisionsJobResult,
} from "../../jobs/ad-decisions-job";
import {
  AD_OPERATOR_RESPONSE_JOB_NAME,
  type AdOperatorResponseJobResult,
} from "../../jobs/ad-operator-response-job";
import {
  runNativeAdShadowChainForActiveBusinessesIfDue,
  type NativeAdShadowScheduleOptions,
  type NativeAdShadowSchemaReadiness,
} from "../../jobs/native-ad-scheduled";
import { NATIVE_AD_ENGINE_VERSION } from "../../types";

const NOW = new Date("2026-07-13T03:20:00.000Z");
const BUSINESSES = [
  { id: "00000000-0000-4000-8000-000000000101", name: "One" },
  { id: "00000000-0000-4000-8000-000000000102", name: "Two" },
];

const readySchema: NativeAdShadowSchemaReadiness = {
  ready: true,
  issues: [],
  components: {
    calibration: { ready: true, issues: [] },
    decisions: { ready: true, issues: [] },
    operatorResponse: { ready: true, issues: [] },
  },
};

function calibrationResult(status: "success" | "failed" = "success") {
  return {
    jobRunId: "calibration-run",
    status,
    rowsWritten: status === "success" ? 4 : 0,
    expectedCellCount: status === "success" ? 4 : 0,
    idempotentReplay: false,
    inputManifestHash: null,
    sourceManifestHash: null,
    cellSetHash: null,
    batches: [],
    durationMs: 1,
    ...(status === "failed" ? { errorMessage: "calibration_failed" } : {}),
  } satisfies AdCalibrationJobResult;
}

function decisionsResult(status: "success" | "failed" = "success") {
  return {
    jobRunId: "decisions-run",
    status,
    snapshotsWritten: status === "success" ? 3 : 0,
    changeEventsWritten: 0,
    durationMs: 1,
    ...(status === "failed" ? { errorMessage: "decisions_failed" } : {}),
  } satisfies AdDecisionsJobResult;
}

function operatorResult(status: "success" | "failed" = "success") {
  return {
    jobRunId: "operator-run",
    status,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    episodesCaptured: status === "success" ? 3 : 0,
    episodesEvaluated: status === "success" ? 3 : 0,
    evidenceEventsWritten: 0,
    evidenceEventsPruned: 0,
    responsesWritten: status === "success" ? 3 : 0,
    durationMs: 1,
    ...(status === "failed" ? { errorMessage: "operator_failed" } : {}),
  } satisfies AdOperatorResponseJobResult;
}

function options(
  overrides: Partial<NativeAdShadowScheduleOptions> = {},
): NativeAdShadowScheduleOptions {
  return {
    jobsDisabled: () => false,
    inspectSchema: async () => readySchema,
    listEnabledIds: async () => BUSINESSES.map((business) => business.id),
    readSuccessfulJobs: async () => new Map(),
    hasSuccessfulJob: async () => false,
    runCalibration: async () => calibrationResult(),
    runDecisions: async () => decisionsResult(),
    runOperatorResponse: async () => operatorResult(),
    ...overrides,
  };
}

describe("native ad shadow scheduled chain", () => {
  it("honors the shared jobs kill switch before schema or business reads", async () => {
    const inspectSchema = vi.fn(async () => readySchema);
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({ jobsDisabled: () => true, inspectSchema }),
    );
    expect(result).toMatchObject({ skipped: true, reason: "jobs_disabled" });
    expect(inspectSchema).not.toHaveBeenCalled();
  });

  it("fails closed before jobs when any native schema contract is not ready", async () => {
    const runCalibration = vi.fn(async () => calibrationResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        inspectSchema: async () => ({
          ...readySchema,
          ready: false,
          issues: ["operatorResponse:missing_table"],
        }),
        runCalibration,
      }),
    );
    expect(result).toMatchObject({
      skipped: true,
      reason: "schema_not_ready",
      missingSchema: ["operatorResponse:missing_table"],
    });
    expect(runCalibration).not.toHaveBeenCalled();
  });

  it("runs calibration, decisions, and operator response in strict order per business", async () => {
    const order: string[] = [];
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        runCalibration: async () => {
          order.push("calibration");
          return calibrationResult();
        },
        runDecisions: async () => {
          order.push("decisions");
          return decisionsResult();
        },
        runOperatorResponse: async (input) => {
          order.push("operator_response");
          expect(input.cutoff).toBe(NOW.toISOString());
          return operatorResult();
        },
      }),
    );
    expect(result.skipped).toBe(false);
    expect(order).toEqual(["calibration", "decisions", "operator_response"]);
  });

  it("isolates a failed business and continues the next business", async () => {
    const runDecisions = vi.fn(async (input) =>
      input.businessId === BUSINESSES[0].id
        ? decisionsResult("failed")
        : decisionsResult(),
    );
    const runOperatorResponse = vi.fn(async () => operatorResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({ runDecisions, runOperatorResponse }),
    );
    expect(result.results?.[0]?.operatorResponse.status).toBe(
      "dependency_blocked",
    );
    expect(result.results?.[1]?.operatorResponse.status).toBe("success");
    expect(runOperatorResponse).toHaveBeenCalledTimes(1);
  });

  it("uses previous success for a retry and runs only remaining steps", async () => {
    const previous = new Map([
      [BUSINESSES[0].id, new Set([AD_CALIBRATION_JOB_NAME])],
    ]);
    const runCalibration = vi.fn(async () => calibrationResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () => previous,
        runCalibration,
      }),
    );
    expect(result.results?.[0]?.calibration.status).toBe("previous_success");
    expect(result.results?.[0]?.decisions.status).toBe("success");
    expect(result.results?.[0]?.operatorResponse.status).toBe("success");
    expect(runCalibration).not.toHaveBeenCalled();
  });

  it("reports already_ran only when every native step succeeded for every business", async () => {
    const complete = new Map<
      string,
      Set<
        | typeof AD_CALIBRATION_JOB_NAME
        | typeof AD_DECISIONS_JOB_NAME
        | typeof AD_OPERATOR_RESPONSE_JOB_NAME
      >
    >(
      BUSINESSES.map((business) => [
        business.id,
        new Set([
          AD_CALIBRATION_JOB_NAME,
          AD_DECISIONS_JOB_NAME,
          AD_OPERATOR_RESPONSE_JOB_NAME,
        ]),
      ]),
    );
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({ readSuccessfulJobs: async () => complete }),
    );
    expect(result).toMatchObject({ skipped: true, reason: "already_ran" });
  });

  it("does not import or name legacy producer tables/jobs", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "lib/creative-decision-engine/jobs/native-ad-scheduled.ts",
      ),
      "utf8",
    );
    expect(source).not.toContain('from "./calibration-job"');
    expect(source).not.toContain('from "./decisions-job"');
    expect(source).not.toContain("engine_v3_decision_snapshots_daily");
    expect(source).not.toContain("engine_v3_creative_lifecycle_daily");
  });
});
