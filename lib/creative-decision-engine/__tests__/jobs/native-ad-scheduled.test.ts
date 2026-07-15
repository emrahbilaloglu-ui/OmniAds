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
  hasReusableNativeCalibration,
  isZeroRowNativeDecisionSuccess,
  listNativeAdMetaEligibleBusinessIds,
  READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL,
  readSuccessfulNativeJobs,
  runNativeAdShadowChainForActiveBusinessesIfDue,
  type NativeAdShadowScheduleOptions,
  type NativeAdShadowSchemaReadiness,
} from "../../jobs/native-ad-scheduled";
import { NATIVE_AD_ENGINE_VERSION } from "../../types";

const NOW = new Date("2026-07-13T03:30:00.000Z");
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
    listMetaEligibleIds: async () => BUSINESSES.map((business) => business.id),
    readSuccessfulJobs: async () => new Map(),
    hasSuccessfulJob: async () => false,
    runCalibration: async () => calibrationResult(),
    runDecisions: async () => decisionsResult(),
    runOperatorResponse: async () => operatorResult(),
    ...overrides,
  };
}

function nativeJobHistoryDb(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn(async (query: string, params?: unknown[]) => {
      if (query.includes("SELECT DISTINCT ON (business_ref_id, job_name)")) {
        const cutoff = new Date(
          String(params?.[4] ?? NOW.toISOString()),
        ).getTime();
        const candidates = rows.filter(
          (row) => new Date(String(row.started_at)).getTime() <= cutoff,
        );
        const effective = candidates
          .filter((row) => {
            const lockConflict =
              row.status === "skipped" &&
              String(row.error_message ?? "")
                .toLowerCase()
                .startsWith("advisory lock not acquired");
            if (!lockConflict) return true;
            const skippedStart = new Date(String(row.started_at)).getTime();
            const skippedFinish = new Date(
              String(row.finished_at ?? row.started_at),
            ).getTime();
            const completedHolder = candidates.some((holder) => {
              if (holder === row) return false;
              if (holder.business_ref_id !== row.business_ref_id) return false;
              if (holder.job_name !== row.job_name) return false;
              if (holder.status !== "success" && holder.status !== "failed") {
                return false;
              }
              const holderStart = new Date(String(holder.started_at)).getTime();
              const holderFinish = holder.finished_at
                ? new Date(String(holder.finished_at)).getTime()
                : Number.POSITIVE_INFINITY;
              return (
                holderStart <= skippedFinish &&
                holderFinish >= skippedStart &&
                holderFinish <= cutoff
              );
            });
            return !completedHolder;
          })
          .map((row) => {
            const finishedAt = row.finished_at
              ? new Date(String(row.finished_at)).getTime()
              : Number.POSITIVE_INFINITY;
            return row.status !== "running" && finishedAt > cutoff
              ? { ...row, status: "running" }
              : row;
          });
        const latest = new Map<string, Record<string, unknown>>();
        for (const row of effective.sort((left, right) => {
          const business = String(left.business_ref_id).localeCompare(
            String(right.business_ref_id),
          );
          if (business !== 0) return business;
          const job = String(left.job_name).localeCompare(
            String(right.job_name),
          );
          if (job !== 0) return job;
          const started =
            new Date(String(right.started_at)).getTime() -
            new Date(String(left.started_at)).getTime();
          if (started !== 0) return started;
          return String(right.id).localeCompare(String(left.id));
        })) {
          const key = `${String(row.business_ref_id)}:${String(row.job_name)}`;
          if (!latest.has(key)) latest.set(key, row);
        }
        return Array.from(latest.values());
      }
      if (query === READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL) {
        return [{ reusable: true }];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    }),
  };
}

function nativeJobRow(input: {
  id: string;
  jobName:
    | typeof AD_CALIBRATION_JOB_NAME
    | typeof AD_DECISIONS_JOB_NAME
    | typeof AD_OPERATOR_RESPONSE_JOB_NAME;
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string | null;
  dependencyRunId?: string | null;
  rowCount?: number;
  errorMessage?: string | null;
}) {
  return {
    id: input.id,
    business_ref_id: BUSINESSES[0].id,
    job_name: input.jobName,
    status: input.status,
    dependency_run_id: input.dependencyRunId ?? null,
    started_at: input.startedAt,
    finished_at: input.finishedAt ?? input.startedAt,
    row_count: input.rowCount ?? 1,
    error_message: input.errorMessage ?? null,
  };
}

describe("native ad shadow scheduled chain", () => {
  it("runs only businesses with an assigned Meta account", async () => {
    const db = {
      query: vi.fn(async () => [{ business_id: BUSINESSES[0].id }]),
    };
    await expect(
      listNativeAdMetaEligibleBusinessIds(
        BUSINESSES.map((business) => business.id),
        db as never,
      ),
    ).resolves.toEqual([BUSINESSES[0].id]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("binding.provider = 'meta'"),
      [BUSINESSES.map((business) => business.id)],
    );

    const runCalibration = vi.fn(async () => calibrationResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        listMetaEligibleIds: async () => [BUSINESSES[0].id],
        runCalibration,
      }),
    );
    expect(result.results?.map((business) => business.businessId)).toEqual([
      BUSINESSES[0].id,
    ]);
    expect(runCalibration).toHaveBeenCalledOnce();
  });

  it("stops before history or jobs when no active business has a Meta assignment", async () => {
    const readSuccessfulJobs = vi.fn(async () => new Map());
    const hasSuccessfulJob = vi.fn(async () => false);
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        listMetaEligibleIds: async () => [],
        readSuccessfulJobs,
        hasSuccessfulJob,
        runCalibration,
        runDecisions,
        runOperatorResponse,
      }),
    );

    expect(result).toMatchObject({
      skipped: true,
      reason: "no_meta_businesses",
    });
    expect(readSuccessfulJobs).not.toHaveBeenCalled();
    expect(hasSuccessfulJob).not.toHaveBeenCalled();
    expect(runCalibration).not.toHaveBeenCalled();
    expect(runDecisions).not.toHaveBeenCalled();
    expect(runOperatorResponse).not.toHaveBeenCalled();
  });

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

  it("reruns decisions and downstream response when only calibration is reusable", async () => {
    const previous = new Map<
      string,
      Set<
        | typeof AD_CALIBRATION_JOB_NAME
        | typeof AD_DECISIONS_JOB_NAME
        | typeof AD_OPERATOR_RESPONSE_JOB_NAME
      >
    >([
      [
        BUSINESSES[0].id,
        new Set([AD_CALIBRATION_JOB_NAME, AD_OPERATOR_RESPONSE_JOB_NAME]),
      ],
    ]);
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () => previous,
        runDecisions,
        runOperatorResponse,
      }),
    );
    expect(result.results?.[0]?.calibration.status).toBe("previous_success");
    expect(result.results?.[0]?.decisions.status).toBe("success");
    expect(result.results?.[0]?.operatorResponse.status).toBe("success");
    expect(runDecisions).toHaveBeenCalledTimes(1);
    expect(runOperatorResponse).toHaveBeenCalledTimes(1);
  });

  it("reruns the full chain when a calibration success is no longer reusable", async () => {
    const previous = new Map<
      string,
      Set<
        | typeof AD_CALIBRATION_JOB_NAME
        | typeof AD_DECISIONS_JOB_NAME
        | typeof AD_OPERATOR_RESPONSE_JOB_NAME
      >
    >([
      [
        BUSINESSES[0].id,
        new Set([AD_DECISIONS_JOB_NAME, AD_OPERATOR_RESPONSE_JOB_NAME]),
      ],
    ]);
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () => previous,
        runCalibration,
        runDecisions,
        runOperatorResponse,
      }),
    );
    expect(result.results?.[0]?.calibration.status).toBe("success");
    expect(result.results?.[0]?.decisions.status).toBe("success");
    expect(result.results?.[0]?.operatorResponse.status).toBe("success");
    expect(runCalibration).toHaveBeenCalledTimes(1);
    expect(runDecisions).toHaveBeenCalledTimes(1);
    expect(runOperatorResponse).toHaveBeenCalledTimes(1);
  });

  it("invalidates calibration reuse when target history is newer than its batch", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce([{ reusable: false }])
        .mockResolvedValueOnce([{ reusable: true }]),
    };
    await expect(
      hasReusableNativeCalibration(
        {
          businessId: BUSINESSES[0].id,
          asOf: "2026-07-13",
          decisionCutoff: NOW.toISOString(),
        },
        db as never,
      ),
    ).resolves.toBe(false);
    await expect(
      hasReusableNativeCalibration(
        {
          businessId: BUSINESSES[0].id,
          asOf: "2026-07-13",
          decisionCutoff: NOW.toISOString(),
        },
        db as never,
      ),
    ).resolves.toBe(true);
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "recorded_at <= calibration_batches.earliest_batch_cutoff",
    );
    expect(
      READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL.indexOf(
        "WHEN calibration_batches.account_identities IS DISTINCT FROM assigned_accounts.account_identities",
      ),
    ).toBeLessThan(
      READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL.indexOf(
        "WHEN NOT EXISTS (SELECT 1 FROM latest_target_history)",
      ),
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).not.toContain(
      "COUNT(DISTINCT batch.provider_account_ref_id)",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "batch.provider_account_id",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "binding.provider_account_id",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "latest_successful_calibration",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "run.error_json #> '{metadata,batches}'",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "run.finished_at <= $3::timestamptz",
    );
  });

  it("recognizes only exact zero-row decision successes as repair candidates", () => {
    expect(isZeroRowNativeDecisionSuccess(0)).toBe(true);
    expect(isZeroRowNativeDecisionSuccess("0")).toBe(true);
    expect(isZeroRowNativeDecisionSuccess(1)).toBe(false);
    expect(isZeroRowNativeDecisionSuccess(null)).toBe(false);
  });

  it("does not let an older success hide the latest failed decision run", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000201";
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000200",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:20:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000202",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "failed",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        rowCount: 0,
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000203",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:19:00.000Z",
      }),
    ]);

    const jobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      db as never,
    );

    expect(Array.from(jobs.get(BUSINESSES[0].id) ?? [])).toEqual([
      AD_CALIBRATION_JOB_NAME,
    ]);
    const historyQuery = db.query.mock.calls[0]?.[0] as string;
    expect(historyQuery).not.toContain("AND status = 'success'");
    expect(historyQuery).toContain("started_at <= $5::timestamptz");
  });

  it("ignores advisory-lock skips that overlap a completed native chain", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000221";
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000222",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000223",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:22:00.000Z",
        finishedAt: "2026-07-13T03:22:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000224",
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "skipped",
        startedAt: "2026-07-13T03:20:15.000Z",
        errorMessage:
          "Advisory lock not acquired (native ad calibration may already be running)",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000225",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "skipped",
        startedAt: "2026-07-13T03:22:15.000Z",
        errorMessage:
          "Advisory lock not acquired (native ad operator-response may already be running).",
      }),
    ]);

    const jobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      db as never,
    );

    expect(Array.from(jobs.get(BUSINESSES[0].id) ?? [])).toEqual([
      AD_CALIBRATION_JOB_NAME,
      AD_DECISIONS_JOB_NAME,
      AD_OPERATOR_RESPONSE_JOB_NAME,
    ]);
    const historyQuery = db.query.mock.calls[0]?.[0] as string;
    expect(historyQuery).toContain("ILIKE 'Advisory lock not acquired%'");
  });

  it("keeps an unresolved advisory-lock skip authoritative", async () => {
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000226",
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:05.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000227",
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "skipped",
        startedAt: "2026-07-13T03:21:00.000Z",
        errorMessage:
          "Advisory lock not acquired (native ad calibration may already be running)",
      }),
    ]);

    const jobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      db as never,
    );

    expect(Array.from(jobs.get(BUSINESSES[0].id) ?? [])).toEqual([]);
  });

  it("treats a terminal row completed after the cutoff as in flight", async () => {
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000228",
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:31:00.000Z",
      }),
    ]);

    const jobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      db as never,
    );

    expect(Array.from(jobs.get(BUSINESSES[0].id) ?? [])).toEqual([]);
    const historyQuery = db.query.mock.calls[0]?.[0] as string;
    expect(historyQuery).toContain("effective_status AS status");
    expect(historyQuery).toContain("holder.finished_at <= $5::timestamptz");
  });

  it("requires decision calibration lineage and downstream operator chronology", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000211";
    const staleDecisionDb = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000212",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: "00000000-0000-4000-8000-000000000210",
        startedAt: "2026-07-13T03:21:00.000Z",
      }),
    ]);
    const staleDecisionJobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      staleDecisionDb as never,
    );
    expect(Array.from(staleDecisionJobs.get(BUSINESSES[0].id) ?? [])).toEqual([
      AD_CALIBRATION_JOB_NAME,
    ]);

    const staleOperatorDb = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000213",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000214",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:21:00.000Z",
      }),
    ]);
    const staleOperatorJobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      staleOperatorDb as never,
    );
    expect(Array.from(staleOperatorJobs.get(BUSINESSES[0].id) ?? [])).toEqual([
      AD_CALIBRATION_JOB_NAME,
      AD_DECISIONS_JOB_NAME,
    ]);

    const currentChainDb = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000215",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000216",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:22:00.000Z",
      }),
    ]);
    const currentChainJobs = await readSuccessfulNativeJobs(
      {
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      },
      currentChainDb as never,
    );
    expect(Array.from(currentChainJobs.get(BUSINESSES[0].id) ?? [])).toEqual([
      AD_CALIBRATION_JOB_NAME,
      AD_DECISIONS_JOB_NAME,
      AD_OPERATOR_RESPONSE_JOB_NAME,
    ]);
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

  it("records native terminal job times with wall-clock timestamps", () => {
    for (const file of [
      "ad-calibration-job.ts",
      "ad-decisions-job.ts",
      "ad-operator-response-job.ts",
    ]) {
      const source = fs.readFileSync(
        path.join(process.cwd(), "lib/creative-decision-engine/jobs", file),
        "utf8",
      );
      expect(source).toMatch(
        /SET status = 'success', finished_at = clock_timestamp\(\)/,
      );
      expect(source).toMatch(
        /SET status = 'failed', finished_at = clock_timestamp\(\)/,
      );
    }
  });
});
