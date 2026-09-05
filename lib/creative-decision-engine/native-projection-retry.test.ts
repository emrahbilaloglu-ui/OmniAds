import { describe, expect, it, vi } from "vitest";
import { AD_CALIBRATION_JOB_NAME } from "./jobs/ad-calibration-job";
import { AD_DECISIONS_JOB_NAME } from "./jobs/ad-decisions-job";
import { AD_OPERATOR_RESPONSE_JOB_NAME } from "./jobs/ad-operator-response-job";
import {
  AD_PROPOSAL_PROJECTION_JOB_NAME,
  READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL,
  readSuccessfulNativeJobs,
  runNativeAdShadowChainForActiveBusinessesIfDue,
  type NativeAdShadowScheduleOptions,
  type NativeAdShadowSchemaReadiness,
} from "./jobs/native-ad-scheduled";

/**
 * The queue projection is a step of the chain, not an afterthought of it.
 *
 * It used to be a fire-and-forget call guarded on `decisions.status ===
 * "success"` and rescued by `.catch(() => null)`, with no record anywhere. So
 * a projection that threw on the tick that PUBLISHED the decisions was never
 * attempted again: the three producer jobs reported `previous_success` for the
 * rest of the slot, the chain then reported `already_ran`, and the native cuts
 * sat durable in `engine_v3_ad_decision_snapshots_daily` while the operator
 * looked at an empty queue with nothing anywhere saying why.
 *
 * These cases pin the four halves of the repair: the projection keeps the slot
 * outstanding until it succeeds, it runs against decisions that were published
 * on an earlier tick of the same slot, its failure is recorded rather than
 * swallowed, and a mid-slot flip to manual is outstanding rather than done.
 */

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

function calibrationResult() {
  return {
    jobRunId: "calibration-run",
    status: "success" as const,
    rowsWritten: 4,
    expectedCellCount: 4,
    idempotentReplay: false,
    inputManifestHash: null,
    sourceManifestHash: null,
    cellSetHash: null,
    batches: [],
    durationMs: 1,
  };
}

function decisionsResult() {
  return {
    jobRunId: "decisions-run",
    status: "success" as const,
    snapshotsWritten: 3,
    changeEventsWritten: 0,
    durationMs: 1,
  };
}

function operatorResult() {
  return {
    jobRunId: "operator-run",
    status: "success" as const,
    engineVersion: "v3" as never,
    episodesCaptured: 3,
    episodesEvaluated: 3,
    evidenceEventsWritten: 0,
    evidenceEventsPruned: 0,
    responsesWritten: 3,
    durationMs: 1,
  };
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
    readOperatorResponseRetryBackoffs: async () => new Set(),
    hasSuccessfulJob: async () => true,
    runCalibration: async () => calibrationResult() as never,
    runDecisions: async () => decisionsResult() as never,
    runOperatorResponse: async () => operatorResult() as never,
    projectProposals: async () => ({ projected: 2, ran: true, withheld: null }),
    recordProjectionRun: async () => {},
    ...overrides,
  };
}

/** The successes map a slot that has already produced would hand back. */
function successesOf(
  names: ReadonlyArray<string>,
  perBusiness?: Record<string, ReadonlyArray<string>>,
) {
  return new Map(
    BUSINESSES.map((business) => [
      business.id,
      new Set((perBusiness?.[business.id] ?? names) as never[]),
    ]),
  ) as never;
}

describe("a failed queue projection keeps the slot outstanding", () => {
  it("does not report already_ran while the projection has no successful run", async () => {
    const projectProposals = vi.fn(async () => ({
      projected: 2,
      ran: true,
      withheld: null,
    }));

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        readSuccessfulJobs: async () =>
          successesOf([
            AD_CALIBRATION_JOB_NAME,
            AD_DECISIONS_JOB_NAME,
            AD_OPERATOR_RESPONSE_JOB_NAME,
          ]),
        projectProposals: projectProposals as never,
      }),
    );

    expect(result.skipped).toBe(false);
    expect(projectProposals).toHaveBeenCalledTimes(BUSINESSES.length);
  });

  it("projects when this slot's decisions were published on an earlier tick", async () => {
    const projectProposals = vi.fn(async () => ({
      projected: 1,
      ran: true,
      withheld: null,
    }));

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        readSuccessfulJobs: async () =>
          successesOf([AD_CALIBRATION_JOB_NAME, AD_DECISIONS_JOB_NAME]),
        projectProposals: projectProposals as never,
      }),
    );

    // `previous_success` means the rows this projection reads are already
    // there, which is exactly when it should run.
    expect(result.results?.[0]?.decisions.status).toBe("previous_success");
    expect(projectProposals).toHaveBeenCalledWith({
      businessId: BUSINESSES[0].id,
      snapshotDate: "2026-07-13",
    });
    expect(result.results?.[0]?.proposalProjection).toMatchObject({
      status: "success",
      source: "ran",
      result: { projected: 1 },
    });
  });

  it("records a projection that threw as failed instead of swallowing it", async () => {
    const recordProjectionRun = vi.fn(async () => {});

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        projectProposals: (async () => {
          throw new Error("projection_exploded");
        }) as never,
        recordProjectionRun,
      }),
    );

    expect(result.results?.[0]?.proposalProjection).toMatchObject({
      status: "failed",
      source: "ran",
      errorMessage: "projection_exploded",
    });
    expect(recordProjectionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESSES[0].id,
        status: "failed",
        errorMessage: "projection_exploded",
      }),
    );
  });

  it("does not repeat a projection that already succeeded in this slot", async () => {
    const projectProposals = vi.fn(async () => ({
      projected: 1,
      ran: true,
      withheld: null,
    }));

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        readSuccessfulJobs: async () =>
          successesOf([], {
            [BUSINESSES[0].id]: [
              AD_CALIBRATION_JOB_NAME,
              AD_DECISIONS_JOB_NAME,
              AD_OPERATOR_RESPONSE_JOB_NAME,
              AD_PROPOSAL_PROJECTION_JOB_NAME,
            ],
            [BUSINESSES[1].id]: [
              AD_CALIBRATION_JOB_NAME,
              AD_DECISIONS_JOB_NAME,
              AD_OPERATOR_RESPONSE_JOB_NAME,
            ],
          }),
        projectProposals: projectProposals as never,
      }),
    );

    expect(projectProposals).toHaveBeenCalledTimes(1);
    expect(projectProposals).toHaveBeenCalledWith({
      businessId: BUSINESSES[1].id,
      snapshotDate: "2026-07-13",
    });
    expect(result.results?.[0]?.proposalProjection.status).toBe(
      "previous_success",
    );
  });

  it("treats manual standing mode as outstanding, not as done", async () => {
    const recordProjectionRun = vi.fn(async () => {});

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        projectProposals: (async () => ({
          projected: 0,
          ran: true,
          withheld: "standing_mode_manual",
        })) as never,
        recordProjectionRun,
      }),
    );

    // A family flipped to semi-automatic mid-slot must still fill the queue,
    // so manual is recorded as skipped and the name never enters the slot's
    // successful set.
    expect(result.results?.[0]?.proposalProjection).toMatchObject({
      status: "skipped",
      reason: "standing_mode_manual",
    });
    expect(recordProjectionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        errorMessage: "standing_mode_manual",
      }),
    );
  });

  it("treats an unreadable standing mode as a failure, not a completion", async () => {
    const recordProjectionRun = vi.fn(async () => {});

    const result = await runNativeAdShadowChainForActiveBusinessesIfDue(
      NOW,
      BUSINESSES,
      options({
        projectProposals: (async () => ({
          projected: 0,
          ran: false,
          withheld: "standing_mode_unreadable",
        })) as never,
        recordProjectionRun,
      }),
    );

    expect(result.results?.[0]?.proposalProjection.status).toBe("failed");
    expect(recordProjectionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "standing_mode_unreadable",
      }),
    );
  });
});

function projectionHistoryDb(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn(async (query: string) => {
      if (query.includes("SELECT DISTINCT ON (business_ref_id, job_name)")) {
        return rows;
      }
      if (query === READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL) {
        return [{ reusable: true }];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    }),
  };
}

function historyRow(input: {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  dependencyRunId?: string | null;
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
    row_count: 1,
    error_message: null,
    error_json:
      input.jobName === AD_DECISIONS_JOB_NAME
        ? {
            metadata: {
              hydration_receipts: [
                {
                  provider_account_ref_id: "ref-1",
                  provider_account_id: "act_1",
                  expected_ad_count: 1,
                  hydrated_ad_count: 1,
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

describe("the projection and the operator response are siblings", () => {
  it("a failed operator response no longer hides a completed projection", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000301";
    const decisionsId = "00000000-0000-4000-8000-000000000302";
    const db = projectionHistoryDb([
      historyRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:30.000Z",
      }),
      historyRow({
        id: decisionsId,
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
      }),
      historyRow({
        id: "00000000-0000-4000-8000-000000000303",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "failed",
        startedAt: "2026-07-13T03:22:00.000Z",
        finishedAt: "2026-07-13T03:22:10.000Z",
      }),
      historyRow({
        id: "00000000-0000-4000-8000-000000000304",
        jobName: AD_PROPOSAL_PROJECTION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:23:00.000Z",
        finishedAt: "2026-07-13T03:23:10.000Z",
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
      AD_PROPOSAL_PROJECTION_JOB_NAME,
    ]);
  });

  it("a projection that ran before its decisions is not this slot's projection", async () => {
    const calibrationId = "00000000-0000-4000-8000-000000000311";
    const decisionsId = "00000000-0000-4000-8000-000000000312";
    const db = projectionHistoryDb([
      historyRow({
        id: calibrationId,
        jobName: AD_CALIBRATION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:00.000Z",
        finishedAt: "2026-07-13T03:20:30.000Z",
      }),
      historyRow({
        id: decisionsId,
        jobName: AD_DECISIONS_JOB_NAME,
        status: "success",
        dependencyRunId: calibrationId,
        startedAt: "2026-07-13T03:21:00.000Z",
        finishedAt: "2026-07-13T03:21:30.000Z",
      }),
      historyRow({
        id: "00000000-0000-4000-8000-000000000313",
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:22:00.000Z",
        finishedAt: "2026-07-13T03:22:10.000Z",
      }),
      // Finished before the decisions it claims to project.
      historyRow({
        id: "00000000-0000-4000-8000-000000000314",
        jobName: AD_PROPOSAL_PROJECTION_JOB_NAME,
        status: "success",
        startedAt: "2026-07-13T03:20:40.000Z",
        finishedAt: "2026-07-13T03:20:50.000Z",
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
  });
});
