import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-action-log", async (importOriginal) => {
  const { MetaAdStatusActionClaimConflictError } = await importOriginal<typeof import("@/lib/meta/ads-action-log")>();
  return {
    MetaAdStatusActionClaimConflictError,
    createMetaAdsActionLog: vi.fn(async () => ({ id: "log-1" })),
    completeMetaAdsActionLog: vi.fn(async () => ({ id: "log-1" })),
  };
});
vi.mock("@/lib/meta/ads-write", () => ({
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  pauseAdset: vi.fn(),
  resumeAdset: vi.fn(),
}));
/*
  The shared server posture, answered rather than removed.

  The runtime reads it twice — once cheaply and once at the pre-POST boundary —
  and it fails CLOSED, so with no database these cases would all refuse with
  `kill_switch_engaged` before reaching the behaviour they are about. Only the
  reading is faked; the branch that acts on it still runs, and the case below
  drives it blocked on purpose.
*/
vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(async () => ({ blocked: false, rehearsal: false })),
}));

import * as log from "@/lib/meta/ads-action-log";
import * as adsWrite from "@/lib/meta/ads-write";
import * as writeGuard from "@/lib/meta/automation-write-guard";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  createScheduledStatusRuntime,
  SCHEDULED_ACTION_ORIGIN,
} from "@/lib/meta/scheduled-status-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import { runClaimedProposalExecution, type ClaimedExecutionDeps } from "@/lib/meta/budget-execution-lifecycle";
import type { BudgetProposalExecutionResult } from "@/lib/meta/budget-proposal-runtime";

const ACTOR = "22222222-2222-4222-8222-222222222222";

const PROPOSAL = {
  id: "p-1",
  businessId: "11111111-1111-4111-8111-111111111111",
  providerAccountId: "act_1",
  scopeType: "adset",
  scopeId: "23851",
  proposedAction: "pause",
  recId: "rec-1",
} as unknown as MetaAutomationProposal;

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: "act_1",
    enablingActorUserId: ACTOR,
    activationControlVersion: "v-7",
    dryRunOnly: false,
    ...overrides,
  };
}

const SCHEDULED = {
  kind: "scheduled",
  expectedEnablingActorUserId: ACTOR,
  expectedActivationControlVersion: "v-7",
} as const;

function build(options: {
  gateSequence?: Array<ScheduledAuthorityGates | null>;
  modeSequence?: Array<"manual" | "semi_auto" | "auto" | null>;
} = {}) {
  const gateReads = options.gateSequence ?? [gates(), gates()];
  const modeReads = options.modeSequence ?? ["auto", "auto"];
  let gateCall = 0;
  let modeCall = 0;
  return createScheduledStatusRuntime({
    ctx: { businessId: PROPOSAL.businessId } as never,
    readGates: async () => gateReads[Math.min(gateCall++, gateReads.length - 1)],
    readMode: async () => modeReads[Math.min(modeCall++, modeReads.length - 1)],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(log.createMetaAdsActionLog).mockResolvedValue({ id: "log-1" } as never);
  vi.mocked(log.completeMetaAdsActionLog).mockResolvedValue({ id: "log-1" } as never);
  vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
    { blocked: false, rehearsal: false } as never,
  );
});

describe("the unattended path answers to the SAME server posture", () => {
  it("withholds and sends nothing when the shared posture is blocked", async () => {
    /*
      This runtime used to pass `killSwitchEngaged: false` as a literal, which
      made the write with nobody watching the only family that never consulted
      the shared gate. The capability, the readiness tier, the STOP, the guard
      rules and quiet hours all live behind this one read.
    */
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      { blocked: true, reason: "release_capability_closed", rehearsal: true } as never,
    );
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("release_gate_closed");
    expect(vi.mocked(adsWrite.pauseAdset)).not.toHaveBeenCalled();
    // No claim either: a refused row must not leave a marker saying a call
    // may be live.
    expect(vi.mocked(log.createMetaAdsActionLog)).not.toHaveBeenCalled();
  });

  it("names the readiness tier separately from the STOP", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue(
      { blocked: true, reason: "readiness_tier_read_only", rehearsal: true } as never,
    );
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    // Three different answers an operator has to be able to tell apart.
    expect(result.receipt.withheld).toBe("auto_execution_disabled");
  });

  it("refuses rather than writing when the posture cannot be read", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockRejectedValue(new Error("db down"));
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("control_state_unavailable");
    expect(vi.mocked(adsWrite.pauseAdset)).not.toHaveBeenCalled();
  });
});

describe("a scheduled status change never claims an operator confirmed it", () => {
  it("journals under its own origin with no requester", async () => {
    vi.mocked(adsWrite.pauseAdset).mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      responsePayload: { success: true },
      verificationPayload: { status: "PAUSED" },
    } as never);

    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(true);
    const logged = vi.mocked(log.createMetaAdsActionLog).mock.calls[0]![0];
    expect(logged.source).toBe(SCHEDULED_ACTION_ORIGIN);
    // The enabling admin authorized the standing arrangement; they did not
    // request this row. Naming them here would make the log unable to tell a
    // sweep from a click.
    expect(logged.requestedBy).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
  });

  it("refuses a manual authorization outright", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "manual",
        explicitConfirmation: true,
        operatorUserId: ACTOR,
      },
    });
    expect(result.receipt.withheld).toBe("manual_confirmation_absent");
    expect(vi.mocked(adsWrite.pauseAdset)).not.toHaveBeenCalled();
  });
});

describe("the authority is re-proved at the pre-POST boundary", () => {
  it("throws inside the hook when the mode changed after the claim", async () => {
    /*
      The first read authorizes and the second does not — exactly the window
      this hook exists for. The primitive turns the throw into a write error
      with no attempt, so the assertion is that the hook refuses; whether a
      request followed is the primitive's own tested contract.
    */
    let hook: (() => Promise<void>) | undefined;
    vi.mocked(adsWrite.pauseAdset).mockImplementation((async (
      _ctx: unknown,
      _id: string,
      options: { beforeMutationAttempt?: () => Promise<void> },
    ) => {
      hook = options.beforeMutationAttempt;
      return { ok: false, httpStatus: 502, error: { code: "x", message: "x" } };
    }) as never);

    const runtime = build({ modeSequence: ["auto", "manual"] });
    await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(hook).toBeDefined();
    await expect(hook!()).rejects.toThrow("mode_not_auto");
  });

  it("refuses when the marker cannot be written, so nothing is sent", async () => {
    let hook: (() => Promise<void>) | undefined;
    vi.mocked(adsWrite.pauseAdset).mockImplementation((async (
      _ctx: unknown,
      _id: string,
      options: { beforeMutationAttempt?: () => Promise<void> },
    ) => {
      hook = options.beforeMutationAttempt;
      return { ok: false, httpStatus: 502, error: { code: "x", message: "x" } };
    }) as never);

    const runtime = build();
    await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => false,
    });

    await expect(hook!()).rejects.toThrow("dispatch_marker_unavailable");
  });
});

describe("an unknown provider answer parks rather than settles", () => {
  it("reports reconcile on an ambiguous outcome", async () => {
    vi.mocked(adsWrite.pauseAdset).mockResolvedValue({
      ok: false,
      httpStatus: 504,
      providerOutcome: "outcome_ambiguous",
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
      mutationAttempt: { attemptCount: 1 },
    } as never);

    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    expect(vi.mocked(log.completeMetaAdsActionLog).mock.calls[0]![0].status)
      .toBe("silent_failure");
  });
});

describe("the row must be one this path can actually execute", () => {
  it("withholds an ad-grain row instead of pausing the wrong thing", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: { ...PROPOSAL, scopeType: "ad" } as MetaAutomationProposal,
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("composition_blocked");
  });

  it("withholds without a claim token", async () => {
    const runtime = build();
    const result = await runtime({
      proposal: PROPOSAL,
      dryRunOnly: false,
      claimToken: null,
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("claim_absent");
  });
});


describe("terminal persistence is required for an ordinary settlement", () => {
  const targets = [
    { scopeType: "campaign", action: "pause", write: "pauseCampaign" },
    { scopeType: "campaign", action: "resume", write: "resumeCampaign" },
    { scopeType: "adset", action: "pause", write: "pauseAdset" },
    { scopeType: "adset", action: "resume", write: "resumeAdset" },
  ] as const;
  const outcomes = [
    { name: "verified live success", ok: true, attempted: true, dryRun: false, ambiguous: false },
    { name: "known live failure", ok: false, attempted: true, dryRun: false, ambiguous: false },
    { name: "ambiguous live failure", ok: false, attempted: true, dryRun: false, ambiguous: true },
    { name: "pre-provider refusal", ok: false, attempted: false, dryRun: false, ambiguous: false },
    { name: "verified rehearsal", ok: true, attempted: false, dryRun: true, ambiguous: false },
    { name: "failed rehearsal", ok: false, attempted: false, dryRun: true, ambiguous: false },
  ] as const;
  for (const target of targets) {
    it.each(outcomes)(`${target.scopeType} ${target.action}: $name retains journal failure without retry`, async (outcome) => {
      vi.mocked(log.completeMetaAdsActionLog).mockRejectedValueOnce(new Error("statement timeout"));
      const providerResponse = { evidence: outcome.name };
      let providerPosts = 0;
      vi.mocked(adsWrite[target.write]).mockImplementation((async (...args: unknown[]) => {
        const options = args[2] as { beforeMutationAttempt?: () => Promise<void> };
        if (outcome.attempted) {
          await options.beforeMutationAttempt?.();
          providerPosts += 1;
        }
        return {
          ok: outcome.ok, dryRun: outcome.dryRun, responsePayload: providerResponse,
          verificationPayload: outcome.ok ? { verified: true } : null,
          httpStatus: outcome.ambiguous ? 504 : 422,
          error: outcome.ok ? undefined : {
            code: outcome.ambiguous ? "provider_outcome_ambiguous" : "provider_refused",
            message: "Provider fixture refusal",
          },
          providerOutcome: outcome.ambiguous ? "outcome_ambiguous" : undefined,
          mutationAttempt: outcome.attempted ? { attemptCount: 1 } : null,
        };
      }) as never);
      const row = { ...PROPOSAL, scopeType: target.scopeType, proposedAction: target.action };
      const results: BudgetProposalExecutionResult[] = [];
      const settle = vi.fn<ClaimedExecutionDeps["settle"]>(async () => row);
      const recordLedger = vi.fn<ClaimedExecutionDeps["recordLedger"]>(async () => true);
      const markDispatchStarted = vi.fn(async () => true);
      const settled = await runClaimedProposalExecution({
        businessId: row.businessId, providerAccountId: row.providerAccountId,
        proposal: row, claimToken: "claim-1", actorUserId: ACTOR, executionKind: "scheduled",
        markDispatchStarted, settle, recordLedger,
        forceReconcile: async () => true, recordReconciliation: async () => true,
        execute: async (beforeProviderPost) => {
          const result = await build()({
            proposal: row, claimToken: "claim-1", authorization: SCHEDULED,
            dryRunOnly: outcome.dryRun, beforeProviderPost,
          });
          results.push(result);
          return result;
        },
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        ok: false, reconcile: true, journalId: "log-1", rollbackRequested: false,
        receipt: { httpStatus: 503, response: providerResponse, dryRun: outcome.dryRun,
          providerMutationAttempted: outcome.attempted, receiptKey: "claim-1", withheld: null },
      });
      expect(adsWrite[target.write]).toHaveBeenCalledTimes(1);
      expect(providerPosts).toBe(outcome.attempted ? 1 : 0);
      expect(markDispatchStarted).toHaveBeenCalledTimes(outcome.attempted ? 1 : 0);
      expect(log.completeMetaAdsActionLog).toHaveBeenCalledTimes(1);
      expect(log.completeMetaAdsActionLog).toHaveBeenCalledWith(expect.objectContaining({
        id: "log-1", status: outcome.ok ? "success" : outcome.ambiguous ? "silent_failure" : "failure",
        payloadResponse: providerResponse,
      }));
      expect(settled.ok).toBe(false);
      expect(settled.providerDispatchStarted).toBe(outcome.attempted);
      expect(settled.settledStatus).toBe(outcome.attempted ? "reconcile" : "failed");
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({
        status: outcome.attempted ? "reconcile" : "failed",
      }));
      expect(recordLedger).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        activityType: outcome.attempted ? "automation_proposal_reconcile" : "automation_proposal_failed",
        severity: "danger",
      }));
    });
  }
});

describe("a contended status claim belongs to its existing owner", () => {
  it.each([
    { code: "action_in_flight", reconciliationRequired: false },
    { code: "meta_ad_status_reconciliation_required", reconciliationRequired: true },
  ] as const)("reports $code without claiming or settling the blocker", async (conflict) => {
    vi.mocked(log.createMetaAdsActionLog).mockRejectedValueOnce(new log.MetaAdStatusActionClaimConflictError({
      ...conflict, blockingActionLogId: "other-attempt", blockingOrigin: "launch_activation_v1",
    }));
    const result = await build()({
      proposal: PROPOSAL, dryRunOnly: false, claimToken: "claim-1", authorization: SCHEDULED,
    });
    expect(result).toMatchObject({
      ok: false, journalId: null, reconcile: false,
      receipt: {
        httpStatus: 409, withheld: "dispatch_marker_unavailable", providerMutationAttempted: false,
        response: { ...conflict, blockingActionLogId: "other-attempt", blockingOrigin: "launch_activation_v1" },
      },
    });
    expect(adsWrite.pauseAdset).not.toHaveBeenCalled();
    expect(log.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("keeps an unavailable insert distinct from entity contention", async () => {
    vi.mocked(log.createMetaAdsActionLog).mockRejectedValueOnce(new Error("database unavailable"));
    const result = await build()({
      proposal: PROPOSAL, dryRunOnly: false, claimToken: "claim-1", authorization: SCHEDULED,
    });
    expect(result).toMatchObject({
      ok: false, journalId: null, reconcile: false,
      receipt: { httpStatus: 422, response: null, withheld: "dispatch_marker_unavailable", providerMutationAttempted: false },
    });
    expect(adsWrite.pauseAdset).not.toHaveBeenCalled();
    expect(log.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });
});
