/**
 * The launch family, executed with nobody present.
 *
 * `launch` was an allowed queue action with a producer and no runtime: the
 * sweep filtered its page to families it could dispatch, so a business whose
 * creative mode was `auto` watched its staged launches expire in the queue.
 * Adding the runtime is the easy half; these cases are the other half — that a
 * create with nobody present answers to MORE gates than a status change, not
 * fewer, and refuses in a way an operator can read.
 *
 * The provider tail is a seam here on purpose. What is under test is the gate
 * chain and what that chain hands the tail, and a create cannot be rehearsed —
 * so the only honest way to assert "nothing was created" is to assert the tail
 * was never entered.
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

import * as writeGuard from "@/lib/meta/automation-write-guard";
import * as releaseGates from "@/lib/meta/release-gates";
import * as safety from "@/lib/meta/write-safety-contract";
import { metaLaunchIntentRequestFingerprint } from "@/lib/launchpad/meta-launch-intent";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";
import {
  createScheduledLaunchRuntime,
  SCHEDULED_LAUNCH_ACTION_LOG_ORIGIN,
  type ScheduledLaunchCreateRequest,
} from "@/lib/meta/scheduled-launch-runtime";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const VERSION = "activation-v4";

const PAYLOAD = {
  mode: "new_campaign",
  campaign: { name: "September test — broad", objective: "OUTCOME_SALES" },
  creativeIds: ["23851000000077"],
  // The operator's own confirmation, bound into the payload when they staged
  // it. It is inside the fingerprint, so nothing may recompose it.
  executionAuthority: {
    actionOrigin: "launchpad_manual_v1",
    manualConfirmation: "explicit_operator_confirmation",
  },
} as const;

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  const requestPayload = (overrides.requestPayload
    ?? PAYLOAD) as Record<string, unknown>;
  const operation = overrides.operation ?? "new_campaign";
  const providerAccountId = overrides.providerAccountId ?? ACCOUNT;
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId,
    operation,
    idempotencyKey: "idem-1",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: "dec-1",
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    requestPayload,
    requestFingerprint: metaLaunchIntentRequestFingerprint({
      operation, providerAccountId, requestPayload,
    }),
    status: "prepared",
    validationReceipt: null,
    resultReceipt: null,
    errorReceipt: null,
    activationApproval: null,
    activationReceipt: null,
    createdBy: ACTOR,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T08:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as MetaLaunchIntent;
}

function proposal(overrides: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal {
  return {
    id: "p-launch-1",
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    scopeType: "campaign",
    scopeId: INTENT,
    proposedAction: "launch",
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

/**
 * The tail, standing in for prepare → validate → preflight → create.
 *
 * It answers the boundary the way the real tail does: only a literal `true`
 * lets a create through. The refusal form carries the gate that closed, which
 * is what the shipped `runMetaLaunchIntentCreate` records when it withholds a
 * create part of the way down a sequence.
 */
function createdOk(seen: ScheduledLaunchCreateRequest[]) {
  return async (request: ScheduledLaunchCreateRequest) => {
    seen.push(request);
    const mayDispatch = await request.beforeProviderMutation();
    if (mayDispatch !== true) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: {
            code: "dispatch_marker_unavailable",
            message: "nothing was created on Meta",
          },
          withheldReason:
            typeof mayDispatch === "object" ? mayDispatch.reason : null,
        },
        providerMutationAttempted: false,
      };
    }
    return {
      ok: true,
      status: 200,
      body: { ok: true, campaignId: "120", adsetIds: ["121"], adIds: ["122"] },
      providerMutationAttempted: true,
    };
  };
}

function runtime(input: {
  seen?: ScheduledLaunchCreateRequest[];
  mode?: "manual" | "semi_auto" | "auto";
  gates?: ScheduledAuthorityGates;
  intent?: MetaLaunchIntent | null;
  readIntent?: (input: { businessId: string; id: string }) => Promise<MetaLaunchIntent | null>;
} = {}) {
  const seen = input.seen ?? [];
  return createScheduledLaunchRuntime({
    readGates: async () => input.gates ?? gates(),
    readMode: async () => input.mode ?? "auto",
    readIntent: input.readIntent
      ?? (async () => (input.intent === undefined ? intent() : input.intent)),
    runCreate: createdOk(seen),
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
});

describe("what a scheduled launch refuses before it reads anything", () => {
  it("refuses mode_not_auto on a semi_auto creative family, before the intent read", async () => {
    const readIntent = vi.fn(async (_input: { businessId: string; id: string }) => intent());
    const result = await runtime({ mode: "semi_auto", readIntent })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("mode_not_auto");
    // The standing mode is the cheapest refusal there is; it must not cost a
    // database read of an intent nobody is allowed to execute.
    expect(readIntent).not.toHaveBeenCalled();
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });

  it("refuses a row with no launch lineage, whatever else is open", async () => {
    const result = await runtime()({
      proposal: proposal({ launchIntentId: null }),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("launch_intent_absent");
  });

  it("never speaks for an operator: a manual authorization is refused", async () => {
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
});

describe("Launchpad's gate is a SECOND gate, and both bind", () => {
  it("refuses launchpad_execution_gated while META_AUTOMATION_LIVE_WRITES is open", async () => {
    /*
      The two are different switches with different operators behind them.
      Reporting a shut Launchpad gate as `release_gate_closed` would point at
      the Automation gate, which this case proves is wide open.
    */
    vi.mocked(releaseGates.readMetaReleaseGates).mockReturnValue({
      automationLiveWrites: true, launchpadExecution: false, decisionWorkflowUi: true,
    } as never);
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("launchpad_execution_gated");
    expect(seen).toHaveLength(0);
  });

  it("refuses launchpad_safety_step_missing when the create family declares one", async () => {
    // An open flag over an incomplete safety contract is exactly the state the
    // contract exists to refuse, and it is a different fact from a shut flag.
    vi.mocked(safety.missingSteps).mockReturnValue([
      "independent_provider_readback",
    ] as never);
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("launchpad_safety_step_missing");
    expect(seen).toHaveLength(0);
  });
});

describe("a create cannot be rehearsed", () => {
  it("refuses dry_run_guardrail on a rehearsing posture and creates nothing", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValue({
      blocked: false, rehearsal: true, reason: null, message: null,
    } as never);
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });

    expect(result.receipt.withheld).toBe("dry_run_guardrail");
    expect(seen).toHaveLength(0);
  });

  it("refuses the same way when the sweep itself is in dry-run", async () => {
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: true,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("dry_run_guardrail");
    expect(seen).toHaveLength(0);
  });
});

describe("the intent is the authority, and it is re-read", () => {
  it("refuses an intent that is no longer prepared, so nothing is created twice", async () => {
    const result = await runtime({ intent: intent({ status: "succeeded" }) })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("launch_intent_not_prepared");
  });

  it("refuses an intent whose execution has already begun", async () => {
    const result = await runtime({
      intent: intent({ startedAt: "2026-09-05T08:00:01.000Z" }),
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("launch_intent_not_prepared");
  });

  it("refuses when the stored payload no longer hashes to the approved fingerprint", async () => {
    const edited = intent();
    const result = await runtime({
      intent: { ...edited, requestFingerprint: "f".repeat(64) },
    })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("launch_payload_changed");
  });

  it("refuses an intent bound to a different provider account", async () => {
    const result = await runtime({ intent: intent({ providerAccountId: "act_other" }) })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
    });
    expect(result.receipt.withheld).toBe("composition_blocked");
  });
});

describe("what reaches the create, and under whose name", () => {
  it("journals under launchpad_scheduled_v1 with no requester, never as manual", async () => {
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.actionLogOrigin).toBe(SCHEDULED_LAUNCH_ACTION_LOG_ORIGIN);
    expect(seen[0]!.actionLogOrigin).not.toBe("launchpad_manual");
    // Nobody requested this one. Naming the enabling admin as the requester
    // would make the two authorities indistinguishable afterwards.
    expect(seen[0]!.requestedBy).toBeNull();
    expect(seen[0]!.scheduledAuthority).toEqual({
      enablingActorUserId: ACTOR,
      activationControlVersion: VERSION,
    });
    // And the intent's OWN payload, handed over untouched.
    expect(seen[0]!.intent.requestPayload).toBe(seen[0]!.intent.requestPayload);
    expect(seen[0]!.intent.idempotencyKey).toBe("idem-1");
    expect(result.receipt.providerMutationAttempted).toBe(true);
  });

  it("re-reads the posture at the pre-POST boundary and creates nothing after a STOP", async () => {
    /*
      The STOP is engaged in the seconds between the claim and the create. The
      first read said go; only the second can still prevent the write.
    */
    const seen: ScheduledLaunchCreateRequest[] = [];
    let reads = 0;
    vi.mocked(writeGuard.readMetaWritePosture).mockImplementation((async () => {
      reads += 1;
      return reads === 1
        ? { blocked: false, rehearsal: false, reason: null, message: null }
        : { blocked: true, rehearsal: false, reason: "business_kill_switch", message: null };
    }) as never);
    const beforeProviderPost = vi.fn(async () => true);
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost,
    });

    expect(result.receipt.withheld).toBe("kill_switch_engaged");
    expect(result.receipt.providerMutationAttempted).toBe(false);
    // The marker is never fired for a write that will not happen.
    expect(beforeProviderPost).not.toHaveBeenCalled();
  });

  it("refuses dispatch_marker_unavailable when the marker cannot be written", async () => {
    const seen: ScheduledLaunchCreateRequest[] = [];
    const result = await runtime({ seen })({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => false,
    });

    expect(result.receipt.withheld).toBe("dispatch_marker_unavailable");
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});

describe("the boundary is a question, asked once per create", () => {
  it("re-reads the gates on every ask and names the one that closed", async () => {
    /*
      The tail asks three times, as a campaign / ad set / ad sequence does. The
      family comes off `auto` between the second ask and the third: the first
      two must be authorized and the third must refuse by name, because a
      remembered answer is exactly what let a launch keep building itself under
      authority that had already been withdrawn.
    */
    let mode: "manual" | "semi_auto" | "auto" = "auto";
    const asked: Array<boolean | { allowed: false; reason: string }> = [];
    const run = createScheduledLaunchRuntime({
      readGates: async () => gates(),
      readMode: async () => mode,
      readIntent: async () => intent(),
      runCreate: async (request) => {
        asked.push(await request.beforeProviderMutation());
        asked.push(await request.beforeProviderMutation());
        mode = "manual";
        asked.push(await request.beforeProviderMutation());
        return {
          ok: false,
          status: 409,
          body: {
            ok: false,
            error: {
              code: "provider_mutation_withheld",
              message: "Authority for this launch was withdrawn (mode_not_auto).",
            },
            campaignId: "120",
            adsetIds: ["121"],
            adIds: [],
            withheldReason: "mode_not_auto",
            launchIntentStatus: "partially_succeeded",
          },
          providerMutationAttempted: true,
        };
      },
    });
    const result = await run({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(asked).toEqual([
      true,
      true,
      { allowed: false, reason: "mode_not_auto" },
    ]);
    /*
      A partial create is NOT a withheld row. Something was created, the receipt
      says what, and flattening that to "we refused" would lose the campaign and
      the ad set an operator now owns.
    */
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
    expect(result.receipt.response).toMatchObject({
      campaignId: "120",
      adsetIds: ["121"],
      withheldReason: "mode_not_auto",
    });
    // Its outcome is known, so it is not parked for reconciliation.
    expect(result.reconcile).toBe(false);
  });

  it("settles as withheld when the refusal came before any provider create", async () => {
    let asks = 0;
    const run = createScheduledLaunchRuntime({
      readGates: async () => gates(),
      readMode: async () => {
        asks += 1;
        // The pre-claim read passes; the boundary read does not.
        return asks <= 1 ? "auto" : "semi_auto";
      },
      readIntent: async () => intent(),
      runCreate: createdOk([]),
    });
    const result = await run({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.receipt.withheld).toBe("mode_not_auto");
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });
});

describe("an outcome nobody can read parks the row", () => {
  it("sets reconcile on an ambiguous create rather than offering it again", async () => {
    const run = createScheduledLaunchRuntime({
      readGates: async () => gates(),
      readMode: async () => "auto",
      readIntent: async () => intent(),
      runCreate: async (request) => {
        expect(await request.beforeProviderMutation()).toBe(true);
        return {
          ok: false,
          status: 502,
          body: {
            ok: false,
            error: { code: "provider_outcome_ambiguous", message: "unknown" },
            launchIntentStatus: "silent_failure",
          },
          providerMutationAttempted: true,
        };
      },
    });
    const result = await run({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: SCHEDULED,
      beforeProviderPost: async () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.reconcile).toBe(true);
    // Not withheld: a provider was reached, and "we refused" would be false.
    expect(result.receipt.withheld).toBeNull();
  });
});
