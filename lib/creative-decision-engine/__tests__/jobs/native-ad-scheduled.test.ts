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
  NATIVE_AD_DECISION_EVIDENCE_COMMIT_SAFETY_MS,
  NATIVE_AD_DECISION_FAILURE_RETRY_COOLDOWN_MS,
  NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS,
  READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL,
  READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL,
  AD_PROPOSAL_PROJECTION_JOB_NAME,
  READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL,
  readNativeAdDecisionRetryBackoffs,
  readNativeAdOperatorResponseRetryBackoffs,
  readSuccessfulNativeJobs,
  runNativeAdShadowChainForActiveBusinessesIfDue,
  type NativeAdShadowScheduleOptions,
  type NativeAdShadowSchemaReadiness,
} from "../../jobs/native-ad-scheduled";
import { NATIVE_AD_ENGINE_VERSION } from "../../types";
import { AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION } from "../../data-source";

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
    clock: () => NOW,
    jobsDisabled: () => false,
    inspectSchema: async () => readySchema,
    listEnabledIds: async () => BUSINESSES.map((business) => business.id),
    listMetaEligibleIds: async () => BUSINESSES.map((business) => business.id),
    readSuccessfulJobs: async () => new Map(),
    readDecisionRetryBackoffs: async () => new Set(),
    readOperatorResponseRetryBackoffs: async () => new Set(),
    hasSuccessfulJob: async () => false,
    withBusinessChainLock: async (_input, run) => ({
      acquired: true,
      value: await run(),
    }),
    runCalibration: async () => calibrationResult(),
    runDecisions: async () => decisionsResult(),
    runOperatorResponse: async () => operatorResult(),
    /*
      The queue projection is a step of this chain now, so these cases would
      otherwise reach the real one and, through it, an unset DATABASE_URL. A
      case that is about the chain's ordering answers it here; the cases that
      are about the projection itself override this.
    */
    projectProposals: async () => ({ projected: 0, ran: true, withheld: null }),
    recordProjectionRun: async () => undefined,
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
    | typeof AD_OPERATOR_RESPONSE_JOB_NAME
    | typeof AD_PROPOSAL_PROJECTION_JOB_NAME;
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string | null;
  dependencyRunId?: string | null;
  rowCount?: number;
  errorMessage?: string | null;
  authoritativeReceipt?: boolean;
}) {
  const manifestHash = "a".repeat(64);
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
    error_json:
      input.jobName === AD_DECISIONS_JOB_NAME
        ? {
            metadata: {
              hydration_receipts: [
                input.authoritativeReceipt === false
                  ? {
                      provider_account_ref_id: "ref-1",
                      provider_account_id: "act_1",
                      expected_ad_count: 0,
                      hydrated_ad_count: 1,
                      expected_manifest_hash: manifestHash,
                      hydrated_manifest_hash: "b".repeat(64),
                      source_complete: false,
                      hydration_complete: false,
                      authoritative_for_prune: false,
                      reason: "complete_source_run_missing",
                    }
                  : {
                      provider_account_ref_id: "ref-1",
                      provider_account_id: "act_1",
                      expected_ad_count: input.rowCount ?? 1,
                      hydrated_ad_count: input.rowCount ?? 1,
                      expected_manifest_hash: manifestHash,
                      hydrated_manifest_hash: manifestHash,
                      source_complete: true,
                      hydration_complete: true,
                      authoritative_for_prune: true,
                      reason: null,
                    },
              ],
            },
          }
        : null,
  };
}

describe("native ad shadow scheduled chain", () => {
  it("runs only businesses with an assigned Meta account", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _params?: unknown[]) => [
        { business_id: BUSINESSES[0].id },
      ]),
    };
    await expect(
      listNativeAdMetaEligibleBusinessIds(
        BUSINESSES.map((business) => business.id),
        db as never,
      ),
    ).resolves.toEqual([BUSINESSES[0].id]);
    const eligibilitySql = String(db.query.mock.calls[0]?.[0] ?? "");
    expect(eligibilitySql).toContain("binding.provider = 'meta'");
    expect(eligibilitySql).toContain("JOIN provider_accounts account");
    expect(eligibilitySql).toContain("account.provider = binding.provider");
    expect(eligibilitySql).toContain(
      "account.external_account_id = binding.provider_account_id",
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual(
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

  it("skips a business already owned by an overlapping scheduler tick", async () => {
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        withBusinessChainLock: async () => ({
          acquired: false,
          value: null,
        }),
        runCalibration,
        runDecisions,
      }),
    );

    expect(result).toMatchObject({
      skipped: false,
      concurrentBusinessIds: [BUSINESSES[0].id],
      results: [
        {
          businessId: BUSINESSES[0].id,
          calibration: {
            status: "dependency_blocked",
            reason: "business_chain_in_progress",
          },
          decisions: {
            status: "dependency_blocked",
            reason: "business_chain_in_progress",
          },
          operatorResponse: {
            status: "dependency_blocked",
            reason: "business_chain_in_progress",
          },
          proposalProjection: {
            status: "dependency_blocked",
            reason: "business_chain_in_progress",
          },
        },
      ],
    });
    expect(runCalibration).not.toHaveBeenCalled();
    expect(runDecisions).not.toHaveBeenCalled();
  });

  it("re-reads completion after acquiring the business lock", async () => {
    const completed = new Map([
      [
        BUSINESSES[0].id,
        new Set([
          AD_CALIBRATION_JOB_NAME,
          AD_DECISIONS_JOB_NAME,
          AD_OPERATOR_RESPONSE_JOB_NAME,
          AD_PROPOSAL_PROJECTION_JOB_NAME,
        ]),
      ],
    ]);
    const readSuccessfulJobs = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(completed);
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({ readSuccessfulJobs, runCalibration, runDecisions }),
    );

    expect(readSuccessfulJobs).toHaveBeenCalledTimes(2);
    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "previous_success" },
      decisions: { status: "previous_success" },
      operatorResponse: { status: "previous_success" },
      proposalProjection: { status: "previous_success" },
    });
    expect(runCalibration).not.toHaveBeenCalled();
    expect(runDecisions).not.toHaveBeenCalled();
  });

  it("uses a fresh post-lock cutoff to see work completed while this tick waited", async () => {
    const tickStartedAt = new Date("2026-07-13T15:10:00.000Z");
    const lockAcquiredAt = new Date("2026-07-13T15:13:00.000Z");
    const calibrationId = "00000000-0000-4000-8000-000000000201";
    const decisionsId = "00000000-0000-4000-8000-000000000202";
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T15:11:00.000Z",
        finishedAt: "2026-07-13T15:11:10.000Z",
      }),
      nativeJobRow({
        id: decisionsId,
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T15:11:20.000Z",
        finishedAt: "2026-07-13T15:11:40.000Z",
        dependencyRunId: calibrationId,
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000203",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T15:11:50.000Z",
        finishedAt: "2026-07-13T15:12:00.000Z",
        dependencyRunId: decisionsId,
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000204",
        jobName: AD_PROPOSAL_PROJECTION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T15:11:50.000Z",
        finishedAt: "2026-07-13T15:12:00.000Z",
        dependencyRunId: decisionsId,
      }),
    ]);
    const cutoffs: string[] = [];
    const decisionRetryCutoffs: string[] = [];
    const operatorRetryCutoffs: string[] = [];
    const readSuccessfulJobs: NonNullable<
      NativeAdShadowScheduleOptions["readSuccessfulJobs"]
    > = async (input) => {
      cutoffs.push(input.decisionCutoff);
      return readSuccessfulNativeJobs(input, db as never);
    };
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      tickStartedAt,
      [BUSINESSES[0]],
      options({
        clock: () => lockAcquiredAt,
        readSuccessfulJobs,
        readDecisionRetryBackoffs: async (input) => {
          decisionRetryCutoffs.push(input.decisionCutoff);
          return new Set();
        },
        readOperatorResponseRetryBackoffs: async (input) => {
          operatorRetryCutoffs.push(input.decisionCutoff);
          return new Set();
        },
        runCalibration,
        runDecisions,
        runOperatorResponse,
      }),
    );

    expect(cutoffs).toEqual([
      tickStartedAt.toISOString(),
      lockAcquiredAt.toISOString(),
    ]);
    expect(decisionRetryCutoffs).toEqual([lockAcquiredAt.toISOString()]);
    expect(operatorRetryCutoffs).toEqual([lockAcquiredAt.toISOString()]);
    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "previous_success" },
      decisions: { status: "previous_success" },
      operatorResponse: { status: "previous_success" },
      proposalProjection: { status: "previous_success" },
    });
    expect(runCalibration).not.toHaveBeenCalled();
    expect(runDecisions).not.toHaveBeenCalled();
    expect(runOperatorResponse).not.toHaveBeenCalled();
  });

  it("uses the post-lock cutoff for dependency fallback and the tick cutoff for operator response", async () => {
    const tickStartedAt = new Date("2026-07-13T15:10:00.000Z");
    const lockAcquiredAt = new Date("2026-07-13T15:13:00.000Z");
    const hasSuccessfulJob = vi.fn(async (input) => {
      expect(input.decisionCutoff).toBe(lockAcquiredAt.toISOString());
      return input.jobName === AD_CALIBRATION_JOB_NAME;
    });
    const runOperatorResponse = vi.fn(async (input) => {
      expect(input.cutoff).toBe(tickStartedAt.toISOString());
      return operatorResult();
    });

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      tickStartedAt,
      [BUSINESSES[0]],
      options({
        clock: () => lockAcquiredAt,
        hasSuccessfulJob,
        runCalibration: async () => calibrationResult("failed"),
        runOperatorResponse,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "failed" },
      decisions: { status: "success" },
      operatorResponse: { status: "success" },
    });
    expect(hasSuccessfulJob).toHaveBeenCalledOnce();
    expect(runOperatorResponse).toHaveBeenCalledOnce();
  });

  it("isolates a thrown business-chain failure and continues later businesses", async () => {
    const runCalibration = vi.fn(async () => calibrationResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        withBusinessChainLock: async (input, run) => {
          if (input.businessId === BUSINESSES[0].id) {
            throw new Error("forced lock cleanup failure");
          }
          return { acquired: true, value: await run() };
        },
        runCalibration,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      businessId: BUSINESSES[0].id,
      calibration: { status: "failed", reason: "uncaught_error" },
      decisions: { status: "failed", reason: "uncaught_error" },
      operatorResponse: { status: "failed", reason: "uncaught_error" },
      proposalProjection: { status: "failed", reason: "uncaught_error" },
    });
    expect(result.results?.[1]).toMatchObject({
      businessId: BUSINESSES[1].id,
      calibration: { status: "success" },
      decisions: { status: "success" },
      operatorResponse: { status: "success" },
      proposalProjection: { status: "success" },
    });
    expect(runCalibration).toHaveBeenCalledOnce();
  });

  it("backs off only operator response after a recent same-day failure", async () => {
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());
    const readOperatorResponseRetryBackoffs = vi.fn(async (input) => {
      expect(input).toEqual({
        businessIds: [BUSINESSES[0].id],
        asOf: "2026-07-13",
        decisionCutoff: NOW.toISOString(),
      });
      return new Set([BUSINESSES[0].id]);
    });

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readOperatorResponseRetryBackoffs,
        runCalibration,
        runDecisions,
        runOperatorResponse,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "success", source: "ran" },
      decisions: { status: "success", source: "ran" },
      operatorResponse: {
        status: "skipped",
        source: "retry_backoff",
        reason: "retry_backoff",
        errorMessage: null,
      },
    });
    expect(readOperatorResponseRetryBackoffs).toHaveBeenCalledOnce();
    expect(runCalibration).toHaveBeenCalledOnce();
    expect(runDecisions).toHaveBeenCalledOnce();
    expect(runOperatorResponse).not.toHaveBeenCalled();
  });

  it("runs operator response when the failed-attempt cooldown has expired", async () => {
    const previous = new Map<
      string,
      Set<typeof AD_CALIBRATION_JOB_NAME | typeof AD_DECISIONS_JOB_NAME>
    >([
      [
        BUSINESSES[0].id,
        new Set([AD_CALIBRATION_JOB_NAME, AD_DECISIONS_JOB_NAME]),
      ],
    ]);
    const runCalibration = vi.fn(async () => calibrationResult());
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      new Date(NOW.getTime() + NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS),
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () => previous,
        readOperatorResponseRetryBackoffs: async () => new Set(),
        runCalibration,
        runDecisions,
        runOperatorResponse,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "previous_success" },
      decisions: { status: "previous_success" },
      operatorResponse: { status: "success", source: "ran" },
    });
    expect(runCalibration).not.toHaveBeenCalled();
    expect(runDecisions).not.toHaveBeenCalled();
    expect(runOperatorResponse).toHaveBeenCalledOnce();
  });

  it("does not carry an operator-response retry backoff into the next UTC day", async () => {
    const nextDay = new Date("2026-07-14T03:30:00.000Z");
    const previous = new Map<
      string,
      Set<typeof AD_CALIBRATION_JOB_NAME | typeof AD_DECISIONS_JOB_NAME>
    >([
      [
        BUSINESSES[0].id,
        new Set([AD_CALIBRATION_JOB_NAME, AD_DECISIONS_JOB_NAME]),
      ],
    ]);
    const readOperatorResponseRetryBackoffs = vi.fn(async (input) => {
      expect(input.asOf).toBe("2026-07-14");
      return new Set<string>();
    });
    const runOperatorResponse = vi.fn(async () => operatorResult());

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      nextDay,
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () => previous,
        readOperatorResponseRetryBackoffs,
        runOperatorResponse,
      }),
    );

    expect(result.results?.[0]?.operatorResponse).toMatchObject({
      status: "success",
      source: "ran",
    });
    expect(readOperatorResponseRetryBackoffs).toHaveBeenCalledOnce();
    expect(runOperatorResponse).toHaveBeenCalledOnce();
  });

  it("bulk-reads an honest 60-minute same-day operator-response retry backoff", async () => {
    const oneMillisecondInside = new Date(
      NOW.getTime() - NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS + 1,
    ).toISOString();
    const exactlyExpired = new Date(
      NOW.getTime() - NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS,
    ).toISOString();
    const db = {
      query: vi.fn(async () => [
        {
          business_ref_id: BUSINESSES[0].id,
          status: "failed",
          finished_at: oneMillisecondInside,
        },
        {
          business_ref_id: BUSINESSES[1].id,
          status: "failed",
          finished_at: exactlyExpired,
        },
      ]),
    };

    await expect(
      readNativeAdOperatorResponseRetryBackoffs(
        {
          businessIds: BUSINESSES.map((business) => business.id),
          asOf: "2026-07-13",
          decisionCutoff: NOW.toISOString(),
        },
        db as never,
      ),
    ).resolves.toEqual(new Set([BUSINESSES[0].id]));

    expect(db.query).toHaveBeenCalledWith(
      READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL,
      [
        BUSINESSES.map((business) => business.id),
        "2026-07-13",
        NATIVE_AD_ENGINE_VERSION,
        AD_OPERATOR_RESPONSE_JOB_NAME,
        NOW.toISOString(),
      ],
    );
    expect(READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL).toContain(
      "run.as_of_date = $2::date",
    );
    expect(READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL).toContain(
      "run.status IN ('success', 'failed')",
    );
    expect(READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL).toContain(
      "run.finished_at <= $5::timestamptz",
    );
  });

  it("backs off an unchanged missing Ad receipt, but retries immediately when the source appears", async () => {
    const providerAccountRefId =
      "00000000-0000-4000-8000-000000000119";
    const providerAccountId = "act-missing";
    const missingReceipt = {
      metadata: {
        hydration_receipts: [
          {
            contract_version:
              AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
            provider_account_ref_id: providerAccountRefId,
            provider_account_id: providerAccountId,
            decision_cutoff: "2026-07-13T02:15:00.000Z",
            source_run_id: null,
            source_run_hash: null,
            source_expected_row_count: null,
            source_persisted_row_count: null,
            expected_ad_count: 0,
            expected_manifest_hash: "a".repeat(64),
            hydrated_ad_count: 0,
            hydrated_manifest_hash: "a".repeat(64),
            source_complete: false,
            hydration_complete: false,
            authoritative_for_prune: false,
            reason: "complete_source_run_missing",
          },
        ],
      },
    };
    const previousAttemptStartedAt = "2026-07-13T03:05:00.000Z";
    const previousAttemptFinishedAt = "2026-07-13T03:06:00.000Z";
    const recentFailure = new Date(
      NOW.getTime() - NATIVE_AD_DECISION_FAILURE_RETRY_COOLDOWN_MS + 1,
    ).toISOString();
    const currentAccount = (
      sourceRunId: string | null,
      sourceRunHash: string | null = null,
      sourceExpectedRowCount: number | null = null,
    ) => [
      {
        provider_account_ref_id: providerAccountRefId,
        provider_account_id: providerAccountId,
        current_source_run_id: sourceRunId,
        current_source_run_hash: sourceRunHash,
        current_source_expected_row_count: sourceExpectedRowCount,
        latest_ad_evidence_changed_at: "2026-07-13T02:00:00.000Z",
      },
    ];
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "success",
            started_at: previousAttemptStartedAt,
            finished_at: previousAttemptFinishedAt,
            error_json: missingReceipt,
            current_accounts: currentAccount(null),
          },
        ])
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "success",
            started_at: previousAttemptStartedAt,
            finished_at: previousAttemptFinishedAt,
            error_json: missingReceipt,
            current_accounts: currentAccount(
              "00000000-0000-4000-8000-000000000120",
              "b".repeat(64),
              1,
            ),
          },
        ])
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "failed",
            started_at: recentFailure,
            finished_at: recentFailure,
            error_json: null,
            current_accounts: currentAccount(null),
          },
        ]),
    };
    const input = {
      businessIds: [BUSINESSES[0].id],
      asOf: "2026-07-13",
      decisionCutoff: NOW.toISOString(),
      since: "2026-07-13T03:00:00.000Z",
    };

    await expect(
      readNativeAdDecisionRetryBackoffs(input, db as never),
    ).resolves.toEqual(new Set([BUSINESSES[0].id]));
    await expect(
      readNativeAdDecisionRetryBackoffs(input, db as never),
    ).resolves.toEqual(new Set());
    await expect(
      readNativeAdDecisionRetryBackoffs(input, db as never),
    ).resolves.toEqual(new Set([BUSINESSES[0].id]));

    expect(db.query).toHaveBeenCalledWith(
      READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL,
      [
        [BUSINESSES[0].id],
        "2026-07-13",
        NATIVE_AD_ENGINE_VERSION,
        AD_DECISIONS_JOB_NAME,
        NOW.toISOString(),
        "2026-07-13T03:00:00.000Z",
      ],
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "AND binding.is_selected",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "run.completeness = 'complete'",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "JOIN provider_accounts account",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "account.provider = binding.provider",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "candidate.completeness <> 'failed'",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "candidate.semantic_hash IS DISTINCT FROM previous.semantic_hash",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).toContain(
      "> latest.started_at - INTERVAL '1 minute'",
    );
    expect(READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL).not.toContain(
      "MAX(GREATEST(run.last_captured_at",
    );
  });

  it("retries when any selected sibling account advances its source fingerprint", async () => {
    const missingRef = "00000000-0000-4000-8000-000000000121";
    const healthyRef = "00000000-0000-4000-8000-000000000122";
    const finishedAt = "2026-07-13T03:00:00.000Z";
    const manifestHash = "c".repeat(64);
    const receipt = (
      ref: string,
      accountId: string,
      sourceRunId: string | null,
      authoritative: boolean,
    ) => ({
      contract_version: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
      provider_account_ref_id: ref,
      provider_account_id: accountId,
      decision_cutoff: "2026-07-13T02:50:00.000Z",
      source_run_id: sourceRunId,
      source_run_hash: sourceRunId ? "d".repeat(64) : null,
      source_expected_row_count: sourceRunId ? 2 : null,
      source_persisted_row_count: sourceRunId ? 2 : null,
      expected_ad_count: sourceRunId ? 2 : 0,
      expected_manifest_hash: manifestHash,
      hydrated_ad_count: sourceRunId ? 2 : 0,
      hydrated_manifest_hash: manifestHash,
      source_complete: sourceRunId !== null,
      hydration_complete: sourceRunId !== null,
      authoritative_for_prune: authoritative,
      reason: authoritative ? null : "complete_source_run_missing",
    });
    const account = (
      ref: string,
      accountId: string,
      sourceRunId: string | null,
    ) => ({
      provider_account_ref_id: ref,
      provider_account_id: accountId,
      current_source_run_id: sourceRunId,
      current_source_run_hash: sourceRunId ? "d".repeat(64) : null,
      current_source_expected_row_count: sourceRunId ? 2 : null,
      latest_ad_evidence_changed_at: "2026-07-13T02:45:00.000Z",
    });
    const db = {
      query: vi.fn(async () => [
        {
          business_ref_id: BUSINESSES[0].id,
          status: "success",
          started_at: finishedAt,
          finished_at: finishedAt,
          error_json: {
            metadata: {
              hydration_receipts: [
                receipt(missingRef, "act-missing", null, false),
                receipt(healthyRef, "act-healthy", "source-b1", true),
              ],
            },
          },
          current_accounts: [
            account(missingRef, "act-missing", null),
            account(healthyRef, "act-healthy", "source-b2"),
          ],
        },
      ]),
    };

    await expect(
      readNativeAdDecisionRetryBackoffs(
        {
          businessIds: [BUSINESSES[0].id],
          asOf: "2026-07-13",
          decisionCutoff: NOW.toISOString(),
          since: "2026-07-13T03:00:00.000Z",
        },
        db as never,
      ),
    ).resolves.toEqual(new Set());
  });

  it("refuses cooldown for duplicate or internally incoherent receipt fingerprints", async () => {
    const firstRef = "00000000-0000-4000-8000-000000000125";
    const secondRef = "00000000-0000-4000-8000-000000000126";
    const manifestHash = "7".repeat(64);
    const missingReceipt = {
      contract_version: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
      provider_account_ref_id: firstRef,
      provider_account_id: "act-first",
      source_run_id: null,
      source_run_hash: null,
      source_expected_row_count: null,
      source_persisted_row_count: null,
      expected_ad_count: 0,
      expected_manifest_hash: manifestHash,
      hydrated_ad_count: 0,
      hydrated_manifest_hash: manifestHash,
      source_complete: false,
      hydration_complete: false,
      authoritative_for_prune: false,
      reason: "complete_source_run_missing",
    };
    const forgedAuthoritative = {
      contract_version: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
      provider_account_ref_id: secondRef,
      provider_account_id: "act-second",
      source_run_id: "source-second",
      source_run_hash: "8".repeat(64),
      source_expected_row_count: 2,
      source_persisted_row_count: 2,
      expected_ad_count: 2,
      expected_manifest_hash: manifestHash,
      hydrated_ad_count: 1,
      hydrated_manifest_hash: "9".repeat(64),
      source_complete: true,
      hydration_complete: true,
      authoritative_for_prune: true,
      reason: null,
    };
    const currentAccounts = [
      {
        provider_account_ref_id: firstRef,
        provider_account_id: "act-first",
        current_source_run_id: null,
        current_source_run_hash: null,
        current_source_expected_row_count: null,
        latest_ad_evidence_changed_at: "2026-07-13T02:45:00.000Z",
      },
      {
        provider_account_ref_id: secondRef,
        provider_account_id: "act-second",
        current_source_run_id: "source-second",
        current_source_run_hash: "8".repeat(64),
        current_source_expected_row_count: 2,
        latest_ad_evidence_changed_at: "2026-07-13T02:45:00.000Z",
      },
    ];
    const row = (hydrationReceipts: unknown[]) => ({
      business_ref_id: BUSINESSES[0].id,
      status: "success",
      started_at: "2026-07-13T03:00:00.000Z",
      finished_at: "2026-07-13T03:00:00.000Z",
      error_json: { metadata: { hydration_receipts: hydrationReceipts } },
      current_accounts: currentAccounts,
    });
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          row([missingReceipt, { ...missingReceipt }]),
        ])
        .mockResolvedValueOnce([
          row([missingReceipt, forgedAuthoritative]),
        ]),
    };
    const input = {
      businessIds: [BUSINESSES[0].id],
      asOf: "2026-07-13",
      decisionCutoff: NOW.toISOString(),
      since: "2026-07-13T03:00:00.000Z",
    };

    await expect(readNativeAdDecisionRetryBackoffs(input, db as never)).resolves.toEqual(
      new Set(),
    );
    await expect(readNativeAdDecisionRetryBackoffs(input, db as never)).resolves.toEqual(
      new Set(),
    );
  });

  it("bounds unchanged non-authoritative count/hash and hydration mismatches", async () => {
    const ref = "00000000-0000-4000-8000-000000000123";
    const sourceRunId = "00000000-0000-4000-8000-000000000124";
    const sourceHash = "e".repeat(64);
    const manifestHash = "f".repeat(64);
    const receipt = (reason: string) => {
      const sourceComplete = reason !== "complete_source_run_count_or_hash_invalid";
      return {
        contract_version: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
        provider_account_ref_id: ref,
        provider_account_id: "act-incomplete",
        decision_cutoff: "2026-07-13T02:50:00.000Z",
        source_run_id: sourceRunId,
        source_run_hash: sourceHash,
        source_expected_row_count: 2,
        source_persisted_row_count: sourceComplete ? 2 : 1,
        expected_ad_count: 2,
        expected_manifest_hash: manifestHash,
        hydrated_ad_count: 1,
        hydrated_manifest_hash: "0".repeat(64),
        source_complete: sourceComplete,
        hydration_complete: false,
        authoritative_for_prune: false,
        reason,
      };
    };
    const current = {
      provider_account_ref_id: ref,
      provider_account_id: "act-incomplete",
      current_source_run_id: sourceRunId,
      current_source_run_hash: sourceHash,
      current_source_expected_row_count: 2,
      latest_ad_evidence_changed_at: "2026-07-13T02:45:00.000Z",
    };
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "success",
            started_at: "2026-07-13T03:00:00.000Z",
            finished_at: "2026-07-13T03:00:00.000Z",
            error_json: {
              metadata: {
                hydration_receipts: [
                  receipt("complete_source_run_count_or_hash_invalid"),
                ],
              },
            },
            current_accounts: [current],
          },
        ])
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "success",
            started_at: "2026-07-13T03:00:00.000Z",
            finished_at: "2026-07-13T03:00:00.000Z",
            error_json: {
              metadata: {
                hydration_receipts: [receipt("hydrated_manifest_mismatch")],
              },
            },
            current_accounts: [current],
          },
        ])
        .mockResolvedValueOnce([
          {
            business_ref_id: BUSINESSES[0].id,
            status: "success",
            started_at: "2026-07-13T03:00:00.000Z",
            finished_at: "2026-07-13T03:00:00.000Z",
            error_json: {
              metadata: {
                hydration_receipts: [receipt("hydrated_manifest_mismatch")],
              },
            },
            current_accounts: [
              {
                ...current,
                // Even a source transaction whose clock began just before the
                // snapshot must force a retry when it can have committed after it.
                latest_ad_evidence_changed_at: new Date(
                  Date.parse("2026-07-13T03:00:00.000Z") -
                    NATIVE_AD_DECISION_EVIDENCE_COMMIT_SAFETY_MS +
                    1,
                ).toISOString(),
              },
            ],
          },
        ]),
    };
    const input = {
      businessIds: [BUSINESSES[0].id],
      asOf: "2026-07-13",
      decisionCutoff: NOW.toISOString(),
      since: "2026-07-13T03:00:00.000Z",
    };

    await expect(readNativeAdDecisionRetryBackoffs(input, db as never)).resolves.toEqual(
      new Set([BUSINESSES[0].id]),
    );
    await expect(readNativeAdDecisionRetryBackoffs(input, db as never)).resolves.toEqual(
      new Set([BUSINESSES[0].id]),
    );
    await expect(readNativeAdDecisionRetryBackoffs(input, db as never)).resolves.toEqual(
      new Set(),
    );
  });

  it("skips only the decision stage while its source retry is backed off and calibration is reused", async () => {
    const runDecisions = vi.fn(async () => decisionsResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readSuccessfulJobs: async () =>
          new Map([[BUSINESSES[0].id, new Set([AD_CALIBRATION_JOB_NAME])]]),
        readDecisionRetryBackoffs: async () =>
          new Set([BUSINESSES[0].id]),
        runDecisions,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "previous_success", source: "previous_success" },
      decisions: { status: "skipped", source: "retry_backoff" },
      operatorResponse: { status: "dependency_blocked" },
      proposalProjection: { status: "dependency_blocked" },
    });
    expect(runDecisions).not.toHaveBeenCalled();
  });

  it("bypasses a stale decision retry snapshot after this tick publishes fresh calibration", async () => {
    const runDecisions = vi.fn(async () => decisionsResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        readDecisionRetryBackoffs: async () =>
          new Set([BUSINESSES[0].id]),
        runDecisions,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "success", source: "ran" },
      decisions: { status: "success", source: "ran" },
    });
    expect(runDecisions).toHaveBeenCalledTimes(1);
  });

  it("runs every business and reports degradation when a retry reader fails", async () => {
    const runDecisions = vi.fn(async () => decisionsResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        readDecisionRetryBackoffs: async () => {
          throw new Error("forced retry reader failure");
        },
        runDecisions,
      }),
    );

    expect(result.retryBackoffReadFailures).toEqual(["decision"]);
    expect(result.results).toHaveLength(BUSINESSES.length);
    expect(
      result.results?.every(
        (business) =>
          business.decisions.status === "success" &&
          business.decisions.source === "ran",
      ),
    ).toBe(true);
    expect(runDecisions).toHaveBeenCalledTimes(BUSINESSES.length);
  });

  it("continues decisions after an atomic calibration success that contains a currency-blocked account batch", async () => {
    const hash = "a".repeat(64);
    const runDecisions = vi.fn(async () => decisionsResult());
    const runOperatorResponse = vi.fn(async () => operatorResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        runCalibration: async () =>
          ({
            ...calibrationResult(),
            batches: [
              {
                providerAccountRefId:
                  "00000000-0000-4000-8000-000000000111",
                providerAccountId: "act-currency-blocked",
                batchId: "00000000-0000-4000-8000-000000000112",
                rowsWritten: 0,
                expectedCellCount: 0,
                idempotentReplay: false,
                generationContentHash: hash,
                inputManifestHash: hash,
                sourceManifestHash: hash,
                cellSetHash: hash,
                currencyAdmission: {
                  contractVersion:
                    "engine-v3-native-ad-currency-admission.v1",
                  status: "blocked",
                  keyBasis: "bound_provider_fallback",
                  accountCurrency: "USD",
                  reason: "source_currency_missing",
                  candidateRowCount: 1,
                  admittedRowCount: 0,
                  anomalyRowCount: 1,
                  sourceCurrencyMissingRowCount: 1,
                  resolvedCurrencyMissingRowCount: 0,
                  resolvedSourceMismatchRowCount: 0,
                  distinctSourceCurrencyCount: 0,
                  distinctResolvedCurrencyCount: 1,
                  manifestHash: hash,
                },
                timezoneAdmission: {
                  contractVersion:
                    "engine-v3-native-ad-timezone-admission.v1",
                  status: "ready",
                  keyBasis: "immutable_latest_source_date",
                  accountTimezone: "UTC",
                  reason: null,
                  candidateRowCount: 1,
                  latestSourceDate: "2026-07-12",
                  latestSourceRowCount: 1,
                  admittedRowCount: 1,
                  anomalyRowCount: 0,
                  sourceTimezoneMissingRowCount: 0,
                  distinctSourceTimezoneCount: 1,
                  manifestHash: hash,
                },
              },
            ],
          }) satisfies AdCalibrationJobResult,
        runDecisions,
        runOperatorResponse,
      }),
    );

    expect(result.results?.[0]).toMatchObject({
      calibration: { status: "success" },
      decisions: { status: "success" },
      operatorResponse: { status: "success" },
    });
    expect(runDecisions).toHaveBeenCalledOnce();
    expect(runOperatorResponse).toHaveBeenCalledOnce();
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

  it("does not satisfy a failed dependency from an earlier slot", async () => {
    const hasSuccessfulJob = vi.fn(async (input) => {
      expect(input.since).toBe("2026-07-13T03:00:00.000Z");
      return false;
    });
    const runDecisions = vi.fn(async () => decisionsResult());
    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      [BUSINESSES[0]],
      options({
        runCalibration: async () => calibrationResult("failed"),
        hasSuccessfulJob,
        runDecisions,
      }),
    );

    expect(result.results?.[0]?.decisions).toMatchObject({
      status: "dependency_blocked",
      reason: "upstream_native_calibration_not_success",
    });
    expect(hasSuccessfulJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: AD_CALIBRATION_JOB_NAME,
        since: "2026-07-13T03:00:00.000Z",
      }),
    );
    expect(runDecisions).not.toHaveBeenCalled();
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
      "GREATEST(target.recorded_at, target.effective_at)",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "<= run.started_at - INTERVAL '1 minute'",
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
      "JOIN provider_accounts account",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "account.provider = binding.provider",
    );
    expect(READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL).toContain(
      "account.external_account_id = binding.provider_account_id",
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
    const historyParams = db.query.mock.calls[0]?.[1] as unknown[];
    expect(historyQuery).not.toContain("AND status = 'success'");
    expect(historyQuery).toContain("AND engine_version = $3");
    expect(historyQuery).toContain("started_at <= $5::timestamptz");
    expect(historyParams[2]).toBe(NATIVE_AD_ENGINE_VERSION);
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

  it("does not reuse a successful decision job whose Ad manifest was non-authoritative", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000241";
    const db = nativeJobHistoryDb([
      nativeJobRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:30.000Z",
      }),
      nativeJobRow({
        id: "00000000-0000-4000-8000-000000000242",
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
        rowCount: 1027,
        authoritativeReceipt: false,
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
    expect(db.query.mock.calls[0]?.[0]).toContain("error_json");
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

  it("bounds a 126-tick day to two decisions unless target truth changes", async () => {
    async function simulateDay(
      scenario: "authoritative" | "non_authoritative" | "target_update" | "partial_lane",
    ) {
      const jobsBySlot = new Map<string, Set<string>>();
      const attemptedDecisionSlots = new Set<string>();
      let activeNow = new Date("2026-07-13T03:00:00.000Z");
      let activeSlot = "";
      let targetHandled = false;
      let decisionRuns = 0;

      const jobsFor = (slot: string) => {
        const existing = jobsBySlot.get(slot);
        if (existing) return existing;
        const created = new Set<string>();
        jobsBySlot.set(slot, created);
        return created;
      };
      const readSuccessfulJobs: NonNullable<
        NativeAdShadowScheduleOptions["readSuccessfulJobs"]
      > = async (input) => {
        activeSlot = String(input.since);
        const jobs = jobsFor(activeSlot);
        if (
          scenario === "target_update" &&
          activeSlot.includes("T03:00:00.000Z") &&
          activeNow >= new Date("2026-07-13T09:00:00.000Z") &&
          !targetHandled
        ) {
          jobs.clear();
        }
        return new Map([[BUSINESSES[0].id, new Set(jobs)]]) as never;
      };
      const runCalibration = async () => {
        jobsFor(activeSlot).add(AD_CALIBRATION_JOB_NAME);
        if (
          scenario === "target_update" &&
          activeNow >= new Date("2026-07-13T09:00:00.000Z")
        ) {
          targetHandled = true;
        }
        return calibrationResult();
      };
      const runDecisions = async () => {
        decisionRuns += 1;
        attemptedDecisionSlots.add(activeSlot);
        if (
          scenario === "authoritative" ||
          scenario === "target_update"
        ) {
          jobsFor(activeSlot).add(AD_DECISIONS_JOB_NAME);
        }
        return decisionsResult();
      };

      for (let tick = 0; tick < 126; tick += 1) {
        activeNow = new Date(
          Date.parse("2026-07-13T03:00:00.000Z") + tick * 10 * 60_000,
        );
        await runNativeAdShadowChainForActiveBusinessesIfDue(
          activeNow,
          [BUSINESSES[0]],
          options({
            readSuccessfulJobs,
            readDecisionRetryBackoffs: async (input) =>
              (scenario === "non_authoritative" ||
                scenario === "partial_lane") &&
              attemptedDecisionSlots.has(input.since)
                ? new Set([BUSINESSES[0].id])
                : new Set(),
            hasSuccessfulJob: async (input) =>
              jobsFor(input.since).has(input.jobName),
            runCalibration,
            runDecisions,
            runOperatorResponse: async () => {
              jobsFor(activeSlot).add(AD_OPERATOR_RESPONSE_JOB_NAME);
              return operatorResult();
            },
            projectProposals: async () => {
              jobsFor(activeSlot).add(AD_PROPOSAL_PROJECTION_JOB_NAME);
              return { projected: 0, ran: true, withheld: null };
            },
          }),
        );
      }
      return decisionRuns;
    }

    await expect(simulateDay("authoritative")).resolves.toBe(2);
    await expect(simulateDay("non_authoritative")).resolves.toBe(2);
    await expect(simulateDay("target_update")).resolves.toBe(3);
    await expect(simulateDay("partial_lane")).resolves.toBe(2);
  });

  it("reports already_ran only when every native step succeeded for every business", async () => {
    /*
      Four names, not three.

      Filling the queue is a step of this chain, and the slot is not done until
      it has succeeded — a projection that threw on the tick that published the
      decisions used to leave the queue empty and be skipped forever after,
      because the three PRODUCER jobs were complete and nothing recorded that
      the projection was not.
    */
    const complete = new Map<
      string,
      Set<
        | typeof AD_CALIBRATION_JOB_NAME
        | typeof AD_DECISIONS_JOB_NAME
        | typeof AD_OPERATOR_RESPONSE_JOB_NAME
        | typeof AD_PROPOSAL_PROJECTION_JOB_NAME
      >
    >(
      BUSINESSES.map((business) => [
        business.id,
        new Set([
          AD_CALIBRATION_JOB_NAME,
          AD_DECISIONS_JOB_NAME,
          AD_OPERATOR_RESPONSE_JOB_NAME,
          AD_PROPOSAL_PROJECTION_JOB_NAME,
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
