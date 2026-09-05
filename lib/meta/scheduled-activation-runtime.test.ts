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
      contractVersion: "meta.launch-activation-approval.v1",
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      launchIntentId: INTENT,
      requestFingerprint: "b".repeat(64),
      approvedOperation: "new_campaign",
      approvedScope: "hierarchy",
      approvedAsset: { creativeId: "23851000000077", version: "v1" },
      approvedCopy: { hash: "c".repeat(64) },
      approvedDestination: { campaignId: "120", adsetId: "121" },
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
      activation: {
        contract: "meta.hierarchy-activation.v1",
        steps: [], delivering: true, blockedAt: null, blockedReason: null,
      },
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
      activation: {
        contract: "meta.hierarchy-activation.v1",
        steps: [], delivering: false, blockedAt: "adset",
        blockedReason: "kill_switch_engaged",
      },
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
      activation: {
        contract: "meta.hierarchy-activation.v1",
        steps: [], delivering: true, blockedAt: null, blockedReason: null,
      },
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
      activation: {
        contract: "meta.hierarchy-activation.v1",
        steps: [], delivering: false, blockedAt: "campaign",
        blockedReason: "dispatch_marker_unavailable",
      },
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
        activation: {
          contract: "meta.hierarchy-activation.v1",
          steps: [],
          delivering: false,
          blockedAt: "adset",
          blockedReason: "verified_not_active",
        },
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
    expect(result.reconcile).toBe(false);
  });

  it("parks an ambiguous step instead of offering the row again", async () => {
    const result = await runtime({
      activate: activateReturning({
        ok: true,
        activation: {
          contract: "meta.hierarchy-activation.v1",
          steps: [], delivering: false, blockedAt: "adset",
          blockedReason: "provider_outcome_ambiguous",
        },
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

  it("parks a step whose PRIOR attempt is unresolved, having sent nothing", async () => {
    const result = await runtime({
      activate: activateReturning({
        ok: true,
        activation: {
          contract: "meta.hierarchy-activation.v1",
          steps: [], delivering: false, blockedAt: "campaign",
          blockedReason: "unresolved_prior_attempt",
        },
        receipt: {
          steps: [
            stepReceipt({
              outcome: "ambiguous", reason: "unresolved_prior_attempt",
              claimOutcome: "unresolved_prior_attempt", actionLogId: "log-old",
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
    expect(result.receipt.withheld).toBeNull();
  });
});
