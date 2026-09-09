/**
 * The activation family, executed with nobody present.
 *
 * `activateLaunchIntent` has carried a `{ kind: "scheduled" }` arm — the one
 * that validates the stored approval and narrows an `ad`-scoped one — since it
 * was written, and nothing ever called it. The entire approval contract was
 * unreachable code guarding a door with no handle.
 *
 * These cases are about the two things that make this runtime safe rather than
 * merely present: it must not be reachable by a row whose verb it shares, and
 * every provider call must be preceded by a re-read that can still stop it. The
 * ordering, the read-back and the journal are NOT re-tested here — they belong
 * to `hierarchy-activation.ts` and `launch-intent-activation.ts` and have their
 * own cases; what is asserted is that this runtime reaches them and what it
 * hands them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/automation-write-guard", () => ({
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
}));
vi.mock("@/lib/meta/release-gates", () => ({
  readMetaReleaseGates: vi.fn(() => ({
    automationLiveWrites: true,
    launchpadExecution: true,
    decisionWorkflowUi: true,
  })),
}));
vi.mock("@/lib/meta/write-safety-contract", () => ({
  missingSteps: vi.fn(() => []),
  writeFamily: vi.fn((id: string) => ({ id })),
}));
vi.mock("@/lib/launchpad/meta-validation", () => ({
  resolveMetaLaunchWriteContext: vi.fn(async () => ({
    ok: true,
    ctx: { providerAccountId: "act_9", accessToken: "token" },
  })),
}));

import * as writeGuard from "@/lib/meta/automation-write-guard";
import * as releaseGates from "@/lib/meta/release-gates";
import * as safety from "@/lib/meta/write-safety-contract";
import * as validation from "@/lib/launchpad/meta-validation";
import { activateLaunchIntent } from "@/lib/meta/launch-intent-activation";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import {
  runClaimedProposalExecution,
  type ClaimedExecutionDeps,
} from "@/lib/meta/budget-execution-lifecycle";
import { createScheduledActivationRuntime } from "@/lib/meta/scheduled-activation-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const VERSION = "activation-v4";

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation: "new_campaign",
    idempotencyKey: "idem-1",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: null,
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    requestPayload: { creativeId: "23851000000077" },
    requestFingerprint: "a".repeat(64),
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-09-05T08:00:00.000Z",
      providerAccountId: ACCOUNT,
      campaignId: "120",
      adsetIds: ["121"],
      adIds: ["122"],
      steps: [],
      recovery: { rollbackSupported: false, retrySupported: false },
    },
    errorReceipt: null,
    // NULL is the default and it means operator-only. Nothing may read it as a
    // grant.
    activationApproval: null,
    activationReceipt: null,
    createdBy: ACTOR,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    startedAt: "2026-09-05T08:00:00.000Z",
    completedAt: "2026-09-05T08:00:05.000Z",
    ...overrides,
  } as MetaLaunchIntent;
}

function proposal(overrides: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal {
  return {
    id: "p-activate-1",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "campaign",
    scopeId: "120",
    proposedAction: "resume",
    launchIntentId: INTENT,
    entityLabel: "September test — broad",
    ...overrides,
  } as unknown as MetaAutomationProposal;
}

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: ACCOUNT,
    enablingActorUserId: ACTOR,
    activationControlVersion: VERSION,
    dryRunOnly: false,
    ...overrides,
  };
}

const SCHEDULED = {
  kind: "scheduled",
  expectedEnablingActorUserId: ACTOR,
  expectedActivationControlVersion: VERSION,
} as const;

type ActivateArgs = Parameters<typeof activateLaunchIntent>[0];

function stepReceipt(overrides: Record<string, unknown> = {}) {
  return {
    grain: "campaign",
    entityId: "120",
    outcome: "activated",
    reason: null,
    verified: { status: "ACTIVE", effectiveStatus: "ACTIVE" },
    actionLogId: "log-1",
    claimOutcome: "activated",
    ...overrides,
  };
}

/**
 * A complete hierarchy result, as the real sequence returns one.
 *
 * `partial` and `coverage` are part of that shape now: a launch can create
 * several ad sets and several ads, and the runtime reports the counts so a
 * stopped run reads as "three of five are on" rather than as a flat "not
 * delivering". A double that omitted them would be handing this runtime a shape
 * production cannot produce.
 */
function activation(overrides: Record<string, unknown> = {}) {
  const steps = (overrides.steps as unknown[]) ?? [];
  const delivering = overrides.delivering === true;
  return {
    contract: "meta.hierarchy-activation.v1",
    steps,
    delivering,
    partial: overrides.partial ?? false,
    coverage: overrides.coverage ?? {
      planned: steps.length,
      on: delivering ? steps.length : 0,
      blocked: 0,
      ambiguous: 0,
      notAttempted: 0,
    },
    blockedAt: null,
    blockedReason: null,
    ...overrides,
  };
}

function runtime(input: {
  mode?: "manual" | "semi_auto" | "auto";
  gates?: ScheduledAuthorityGates;
  intent?: MetaLaunchIntent | null;
  activate?: ActivateArgs extends never ? never : typeof activateLaunchIntent;
} = {}) {
  return createScheduledActivationRuntime({
    readGates: async () => input.gates ?? gates(),
    readMode: async () => input.mode ?? "auto",
    readIntent: async () => (input.intent === undefined ? intent() : input.intent),
    ...(input.activate ? { activate: input.activate } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue({
    blocked: false, rehearsal: false, reason: null, message: null,
  } as never);
  vi.mocked(releaseGates.readMetaReleaseGates).mockReturnValue({
    automationLiveWrites: true, launchpadExecution: true, decisionWorkflowUi: true,
  } as never);
  vi.mocked(safety.missingSteps).mockReturnValue([]);
  vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
    ok: true, ctx: { providerAccountId: ACCOUNT, accessToken: "token" },
  } as never);
});

describe("the row's verb cannot reach this runtime on its own", () => {
  it("refuses a resume with no launch lineage — that is an ordinary un-pause", async () => {
    const activate = vi.fn();
    const result = await runtime({ activate: activate as never })({
      proposal: proposal({ launchIntentId: null }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("launch_intent_absent");
    expect(activate).not.toHaveBeenCalled();
  });

  it("refuses a launch row: creating and turning on are different acts", async () => {
    const result = await runtime()({
      proposal: proposal({ proposedAction: "launch" }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("composition_blocked");
  });

  it("refuses mode_not_auto when the CREATIVE family is not armed", async () => {
    // The pause mode is irrelevant here by construction: the runtime asks the
    // creative one, which is what an activation belongs to.
    const activate = vi.fn();
    const result = await runtime({ mode: "semi_auto", activate: activate as never })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("mode_not_auto");
    expect(activate).not.toHaveBeenCalled();
  });

  it("never speaks for an operator", async () => {
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: ACTOR,
      },
    });
    expect(result.receipt.withheld).toBe("manual_confirmation_absent");
  });

  it("refuses a rehearsing business rather than reporting an activation that did not happen", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue({
      blocked: false, rehearsal: true, reason: null, message: null,
    } as never);
    const activate = vi.fn();
    const result = await runtime({ activate: activate as never })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("dry_run_guardrail");
    expect(activate).not.toHaveBeenCalled();
  });

  it("answers to the ACTIVATION family's own safety record, not the create's", async () => {
    const seen: string[] = [];
    vi.mocked(safety.writeFamily).mockImplementation(((id: string) => {
      seen.push(id);
      return { id };
    }) as never);
    await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(seen).toContain("launchpad_activation");
    expect(seen).not.toContain("launchpad_create");
  });
});

describe("the stored approval is the entire authority", () => {
  it("refuses activation_approval_absent on the NULL default and reaches no provider", async () => {
    /*
      Driven through the REAL `activateLaunchIntent`, because the point is that
      its scheduled arm refuses before it plans anything. A double here would
      only prove what the double was told.
    */
    const result = await runtime()({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.receipt.withheld).toBe("activation_approval_absent");
    expect(result.receipt.providerMutationAttempted).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("carries the approval's own refusal code through to the receipt", async () => {
    // A stored approval for a payload that has since changed. "Nobody approved
    // this" and "somebody approved something else" are different sentences and
    // the operator has to be able to read which one happened.
    const approved = {
      contractVersion: "meta.launch-activation-approval.v2",
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      launchIntentId: INTENT,
      requestFingerprint: "b".repeat(64),
      approvedOperation: "new_campaign",
      approvedScope: "hierarchy",
      approvedAssets: [{ creativeId: "23851000000077", version: "v1" }],
      approvedCopy: { hash: "c".repeat(64) },
      approvedDestination: { campaignId: "120", adsetIds: ["121"] },
      approvedBy: ACTOR,
      approvedAt: "2026-09-05T07:00:00.000Z",
      expiresAt: "2126-09-05T07:00:00.000Z",
      revokedAt: null,
      policyVersion: "meta.activation-policy.v1",
    };
    const result = await runtime({
      intent: intent({ activationApproval: approved }),
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("activation_approval_payload_changed");
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});

describe("what the sequence is handed, and when it may proceed", () => {
  function capturing(result: unknown) {
    const calls: ActivateArgs[] = [];
    const activate = (async (args: ActivateArgs) => {
      calls.push(args);
      return result;
    }) as unknown as typeof activateLaunchIntent;
    return { calls, activate };
  }

  it("reaches activateLaunchIntent under a scheduled authorization, never an operator one", async () => {
    const { calls, activate } = capturing({
      ok: true,
      activation: activation({ delivering: true }),
      receipt: { steps: [stepReceipt()] },
    });
    const result = await runtime({ activate })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toEqual({ kind: "scheduled" });
    expect(calls[0]!.intent.id).toBe(INTENT);
    expect(typeof calls[0]!.authorize).toBe("function");
    expect(result.ok).toBe(true);
    expect(result.receipt.withheld).toBeNull();
  });

  it("re-reads the posture before EVERY step, so a STOP mid-sequence stops it", async () => {
    /*
      The sequence makes up to three provider calls. An operator can engage the
      STOP between the campaign and the ad set, and the per-step hook is the
      only place that can still act on it.
    */
    const { calls, activate } = capturing({
      ok: true,
      activation: activation({
        blockedAt: "adset", blockedReason: "kill_switch_engaged",
      }),
      receipt: { steps: [stepReceipt()] },
    });
    let reads = 0;
    vi.mocked(writeGuard.readMetaWritePosture).mockImplementation((async () => {
      reads += 1;
      return reads <= 2
        ? { blocked: false, rehearsal: false, reason: null, message: null }
        : { blocked: true, rehearsal: false, reason: "business_kill_switch", message: null };
    }) as never);

    await runtime({ activate })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    const authorize = calls[0]!.authorize!;
    // The campaign step is allowed through.
    expect(await authorize({ grain: "campaign", entityId: "120" })).toBeNull();
    /*
      The STOP is engaged; the ad-set step is refused by the posture's OWN
      reason, the way the operator's route does it — "business_kill_switch" and
      a global kill switch are different facts and the blocked step records
      which one stopped the sequence.
    */
    expect(await authorize({ grain: "adset", entityId: "121" }))
      .toBe("business_kill_switch");
  });

  it("fires the dispatch marker once, inside the per-step hook, and refuses when it cannot", async () => {
    const { calls, activate } = capturing({
      ok: true,
      activation: activation({ delivering: true }),
      receipt: { steps: [stepReceipt()] },
    });
    const marker = vi.fn(async () => true);
    await runtime({ activate })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: marker,
    });
    const authorize = calls[0]!.authorize!;

    /*
      Not fired at entry. Most refusals — an absent approval above all — never
      reach a provider, and marking before them would stamp a dispatch on a row
      that made no call.
    */
    expect(marker).not.toHaveBeenCalled();
    await authorize({ grain: "campaign", entityId: "120" });
    await authorize({ grain: "adset", entityId: "121" });
    // One attempt, one marker, however many steps follow.
    expect(marker).toHaveBeenCalledTimes(1);

    const refused = capturing({
      ok: true,
      activation: activation({
        blockedAt: "campaign", blockedReason: "dispatch_marker_unavailable",
      }),
      receipt: { steps: [] },
    });
    await runtime({ activate: refused.activate })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => false,
    });
    expect(await refused.calls[0]!.authorize!({ grain: "campaign", entityId: "120" }))
      .toBe("dispatch_marker_unavailable");
  });
});

describe("how an outcome is reported", () => {
  function activateReturning(result: unknown) {
    return (async () => result) as unknown as typeof activateLaunchIntent;
  }

  it("reports a blocked ad set as an OUTCOME, never as a refusal, and not as live", async () => {
    const result = await runtime({
      activate: activateReturning({
        ok: true,
        activation: activation({
          blockedAt: "adset",
          blockedReason: "verified_not_active",
          partial: true,
          coverage: { planned: 2, on: 1, blocked: 1, ambiguous: 0, notAttempted: 0 },
        }),
        receipt: {
          steps: [
            stepReceipt(),
            stepReceipt({
              grain: "adset", entityId: "121", outcome: "blocked",
              reason: "verified_not_active", claimOutcome: "refused",
              actionLogId: "log-2",
            }),
          ],
        },
      }),
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.ok).toBe(false);
    // A provider WAS reached. Saying "withheld" would claim it was not.
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
    const response = result.receipt.response as Record<string, unknown>;
    expect(response.delivering).toBe(false);
    expect(response.blockedAt).toBe("adset");
    /*
      And the counts, because "not delivering" is true of a launch where nothing
      came on and of one where most of it is live and spending. Only one of
      those needs somebody now.
    */
    expect(response.partial).toBe(true);
    expect(response.coverage).toEqual({
      planned: 2, on: 1, blocked: 1, ambiguous: 0, notAttempted: 0,
    });
    expect(result.reconcile).toBe(false);
  });

  it("parks an ambiguous step instead of offering the row again", async () => {
    const result = await runtime({
      activate: activateReturning({
        ok: true,
        activation: activation({
          blockedAt: "adset", blockedReason: "provider_outcome_ambiguous",
          partial: true,
          coverage: { planned: 2, on: 1, blocked: 0, ambiguous: 1, notAttempted: 0 },
        }),
        receipt: {
          steps: [
            stepReceipt(),
            stepReceipt({
              grain: "adset", entityId: "121", outcome: "ambiguous",
              claimOutcome: "ambiguous", actionLogId: "log-2",
            }),
          ],
        },
      }),
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.reconcile).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("says no provider was reached when the boundary refused every step", async () => {
    /*
      The claim was written and the pre-POST hook then refused, so a journal row
      exists for a request that was never built. `providerMutationAttempted` used
      to be `true` here twice over — once from the dispatch marker having been
      stamped, once from "some step has a row" — and both are the wrong sentence
      about a run in which nothing was sent.
    */
    const result = await runtime({
      activate: activateReturning({
        ok: true,
        activation: activation({
          blockedAt: "campaign",
          blockedReason: "activation_approval_revoked",
          coverage: { planned: 1, on: 0, blocked: 1, ambiguous: 0, notAttempted: 0 },
        }),
        receipt: {
          steps: [
            stepReceipt({
              outcome: "blocked",
              reason: "activation_approval_revoked",
              claimOutcome: "authority_refused",
              verified: null,
            }),
          ],
        },
      }),
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.ok).toBe(false);
    // Still not `withheld`: the sequence ran and the row was claimed. But
    // nothing reached Meta, and the receipt must be able to say so.
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(false);
    // Nothing to park for a person, either: a definite non-write is not an
    // outcome anybody has to reconcile.
    expect(result.reconcile).toBe(false);
    const response = result.receipt.response as Record<string, unknown>;
    expect(response.blockedReason).toBe("activation_approval_revoked");
  });

  /**
   * A double in the REAL order: `authorize` first, then the gate's verdict.
   *
   * `hierarchy-activation.ts` asks `authorize` before it calls `activate` for
   * every step, and both outcomes below are produced inside `activate` — the
   * no-blind-retry gate at its top, the pre-POST hook underneath it. So the
   * dispatch marker this runtime stamps from inside `authorize` has always been
   * written by the time either is reported. A double that skipped `authorize`
   * would be modelling a sequence production cannot run, and the marker is
   * exactly what the layer above falls back to when the receipt states nothing.
   */
  function activateAfterAuthorizing(result: unknown) {
    return (async (args: {
      authorize?: (target: { grain: string; entityId: string }) => Promise<string | null>;
    }) => {
      await args.authorize?.({ grain: "campaign", entityId: "120" });
      return result;
    }) as unknown as typeof activateLaunchIntent;
  }

  /** The one activation whose prior attempt on the same entity is unresolved. */
  function unresolvedPriorAttempt() {
    return activateAfterAuthorizing({
      ok: true,
      activation: activation({
        blockedAt: "campaign", blockedReason: "unresolved_prior_attempt",
        coverage: { planned: 1, on: 0, blocked: 0, ambiguous: 1, notAttempted: 0 },
      }),
      receipt: {
        steps: [
          stepReceipt({
            outcome: "ambiguous", reason: "unresolved_prior_attempt",
            // The id is the OLD row's: this dispatch wrote no claim of its own.
            claimOutcome: "unresolved_prior_attempt", actionLogId: "log-old",
          }),
        ],
      },
    });
  }

  it("parks a step whose PRIOR attempt is unresolved, having sent nothing", async () => {
    const result = await runtime({ activate: unresolvedPriorAttempt() })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.reconcile).toBe(true);
    expect(result.receipt.withheld).toBeNull();
    /*
      And the receipt does not CLAIM a provider contact this dispatch did not
      make. It states nothing at all: `undefined`, which is not `false`.
      `false` is read one layer up as a definite non-attempt and would release
      the entity's action slot — see the note in the runtime and the settled
      status asserted below.
    */
    expect(result.receipt.providerMutationAttempted).toBeUndefined();
    const steps = (result.receipt.response as { steps: Array<{ claimOutcome: string }> }).steps;
    expect(steps.map((step) => step.claimOutcome)).toEqual(["unresolved_prior_attempt"]);
  });

  /*
    The same case, carried into the layer that decides what the row becomes.

    `result.reconcile` is the runtime's own answer and this file used to stop
    there. `runClaimedProposalExecution` is what settles the claimed row, and it
    gates reconcile on `receipt.providerMutationAttempted`; `failed` is not one
    of `META_AUTOMATION_PROPOSAL_OPEN_STATUSES` and `reconcile` is, so the
    settled status IS whether the entity's one action slot stays held against a
    provider outcome nobody has established. Asserting the flag alone would let
    the two drift apart again.
  */
  it("settles that row to reconcile through the real claimed-execution lifecycle", async () => {
    const settledStatuses: string[] = [];
    const ledger: string[] = [];
    const run = runtime({ activate: unresolvedPriorAttempt() });
    const deps: ClaimedExecutionDeps = {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      proposal: proposal(),
      claimToken: "claim-1",
      actorUserId: ACTOR,
      executionKind: "scheduled",
      // The durable pre-POST marker. It is stamped inside the runtime's own
      // per-step hook, before the gate that produced this outcome can run.
      markDispatchStarted: async () => true,
      settle: async ({ status }) => {
        settledStatuses.push(status);
        return { ...proposal(), status } as unknown as MetaAutomationProposal;
      },
      forceReconcile: async () => true,
      recordReconciliation: async () => true,
      recordLedger: async (entry) => { ledger.push(entry.activityType); return true; },
      execute: async (beforeProviderPost) => run({
        proposal: proposal(),
        dryRunOnly: false,
        claimToken: "claim-1",
        authorization: SCHEDULED,
        beforeProviderPost,
      }),
    };

    const lifecycle = await runClaimedProposalExecution(deps);

    expect(lifecycle.settledStatus).toBe("reconcile");
    expect(settledStatuses).toEqual(["reconcile"]);
    expect(lifecycle.reconcile).toBe(true);
    expect(ledger).toEqual(["automation_proposal_reconcile"]);
    // Never reported as applied, either.
    expect(lifecycle.ok).toBe(false);
    expect(lifecycle.providerOutcomeKnown).toBe(false);
  });

  /*
    The neighbouring case, which must NOT park.

    A boundary refusal is a definite non-write: the hook stopped the request
    before it was built, nothing is outstanding, and the row is free to be
    offered again. It is the reason `providerMutationAttempted` cannot simply be
    dropped whenever `contacted` is false.
  */
  it("settles a boundary-refused row to failed, holding no slot", async () => {
    const settledStatuses: string[] = [];
    const run = runtime({
      activate: activateAfterAuthorizing({
        ok: true,
        activation: activation({
          blockedAt: "campaign", blockedReason: "activation_approval_revoked",
          coverage: { planned: 1, on: 0, blocked: 1, ambiguous: 0, notAttempted: 0 },
        }),
        receipt: {
          steps: [
            stepReceipt({
              outcome: "blocked", reason: "activation_approval_revoked",
              claimOutcome: "authority_refused", verified: null,
            }),
          ],
        },
      }),
    });
    const lifecycle = await runClaimedProposalExecution({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      proposal: proposal(),
      claimToken: "claim-1",
      actorUserId: ACTOR,
      executionKind: "scheduled",
      markDispatchStarted: async () => true,
      settle: async ({ status }) => {
        settledStatuses.push(status);
        return { ...proposal(), status } as unknown as MetaAutomationProposal;
      },
      forceReconcile: async () => true,
      recordReconciliation: async () => true,
      recordLedger: async () => true,
      execute: async (beforeProviderPost) => run({
        proposal: proposal(),
        dryRunOnly: false,
        claimToken: "claim-1",
        authorization: SCHEDULED,
        beforeProviderPost,
      }),
    });

    /*
      The marker WAS stamped here too — `authorize` passed and only the
      primitive's own pre-POST hook refused — so this receipt's explicit `false`
      is what keeps the row out of `reconcile`. Both halves of the fix are
      visible in one pair of cases: a stated `false` overrides the marker, and
      only an unstated field defers to it.
    */
    expect(lifecycle.providerDispatchIntentMarked).toBe(true);
    expect(lifecycle.receipt.providerMutationAttempted).toBe(false);
    expect(lifecycle.settledStatus).toBe("failed");
    expect(settledStatuses).toEqual(["failed"]);
    expect(lifecycle.reconcile).toBe(false);
    expect(lifecycle.providerOutcomeKnown).toBe(true);
  });
});
