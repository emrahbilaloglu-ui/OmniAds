/**
 * R4, reproduced and then fixed: a revoked approval stayed usable mid-sequence.
 *
 * An unattended activation's ENTIRE authority is a document in
 * `meta_launch_intents.activation_approval_json`, and the operator's own route
 * can rewrite it — revoke it, or change what it binds — at any moment. The
 * sequence makes up to one provider POST per entity, so there is a real gap
 * between the campaign coming on and the ad being sent.
 *
 * That gap was unguarded. `activateLaunchIntent` validated the approval once,
 * from the intent object loaded at the top of the run, and the scheduled
 * runtime's per-step hook re-read gates, mode and posture but never the
 * approval or the intent's current fingerprint. Driving the shipped code with a
 * revocation persisted the moment the campaign came on:
 *
 *     posted: ["camp_1", "set_1", "ad_1"]   revokedAt: set   delivering: true
 *
 * Two entities were turned on under an authorization that had been withdrawn
 * before either write was sent.
 *
 * These cases drive the real `activateLaunchIntent`, and the last of them the
 * real scheduled runtime, against a provider double whose resume call is what
 * moves the stored document — so the revocation lands exactly where it did in
 * production: between two steps of one in-flight sequence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
  readMetaEntityExecutionState: vi.fn(),
  resumeAd: vi.fn(),
  resumeAdset: vi.fn(),
  resumeCampaign: vi.fn(),
}));
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
/*
  The two durable seams the runtime does NOT inject.

  `activateLaunchIntent` defaults its journal to the real action log and its
  receipt writer to the intent row, which is exactly right in production and
  means a test driving the real runtime would otherwise open a database. The
  journal's behaviour has its own cases in `launch-activation-durability`; what
  is asserted here is which provider calls happen, so these stand in.
*/
vi.mock("@/lib/meta/ads-action-log", () => ({
  findUnresolvedMetaAdStatusActionLog: vi.fn(async () => null),
  createMetaAdsActionLog: vi.fn(async (input: { adId: string }) => ({
    id: `log_${input.adId}`,
  })),
  completeMetaAdsActionLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(async () => null),
  recordMetaLaunchIntentActivation: vi.fn(async () => undefined),
}));

import * as adsWrite from "@/lib/meta/ads-write";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { ACTIVATION_APPROVAL_CONTRACT } from "@/lib/meta/launch-activation-approval";
import {
  ACTIVATION_POLICY_VERSION,
  activateLaunchIntent,
  type ActivationJournal,
  type LaunchActivationReceipt,
} from "@/lib/meta/launch-intent-activation";
import { createScheduledActivationRuntime } from "@/lib/meta/scheduled-activation-runtime";
import type { ScheduledAuthorityGates } from "@/lib/meta/scheduled-action-execution";

const BUSINESS = "44444444-4444-4444-8444-444444444444";
const APPROVER = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_9";
const CONTROL_VERSION = "activation-v4";

function approval(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: ACTIVATION_APPROVAL_CONTRACT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    launchIntentId: INTENT,
    requestFingerprint: "a".repeat(64),
    approvedOperation: "new_campaign",
    approvedScope: "hierarchy",
    approvedAssets: [{ creativeId: "cr_1", version: "v1" }],
    approvedCopy: { hash: "b".repeat(64) },
    approvedDestination: { campaignId: "camp_1", adsetIds: ["set_1"] },
    approvedBy: APPROVER,
    approvedAt: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-06T09:00:00.000Z",
    revokedAt: null,
    policyVersion: ACTIVATION_POLICY_VERSION,
    ...overrides,
  };
}

/**
 * The row as it stands right now.
 *
 * The whole finding is that this can change while a sequence is in flight, so
 * the tests mutate it and re-read it exactly as the store would.
 */
let row: { approval: unknown; requestFingerprint: string };

function intent(): MetaLaunchIntent {
  return {
    id: INTENT,
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    operation: "new_campaign",
    idempotencyKey: "idem",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: null, sourceDecisionSnapshotId: null,
      creativeBriefId: null, sourceDraftId: null,
    },
    requestPayload: { creatives: [{ creativeId: "cr_1" }] },
    requestFingerprint: row.requestFingerprint,
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-09-05T09:00:00.000Z",
      providerAccountId: ACCOUNT,
      campaignId: "camp_1",
      adsetIds: ["set_1"],
      adIds: ["ad_1"],
      steps: [],
      recovery: { rollbackSupported: false, retrySupported: false },
    },
    errorReceipt: null,
    activationApproval: row.approval,
    activationReceipt: null,
    createdBy: APPROVER,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    startedAt: "2026-09-05T08:30:00.000Z",
    completedAt: "2026-09-05T09:00:00.000Z",
  };
}

const provider = new Map<string, { status: string; effective: string }>();
let posted: string[] = [];
let settled: Array<{ id: string; outcome: string }> = [];
const stored: LaunchActivationReceipt[] = [];
/** Fired the moment the named entity's resume lands, before the next step. */
let afterPost: Record<string, () => void> = {};

const journal: ActivationJournal = {
  findUnresolved: async () => null,
  claim: async (input) => ({ id: `log_${input.entityId}` }),
  settle: async (input) => { settled.push({ id: input.id, outcome: input.outcome }); },
};

async function runUnattended() {
  return activateLaunchIntent({
    intent: intent(),
    ctx: {} as never,
    authorization: { kind: "scheduled" },
    // The store, as the runtime reads it: whatever the row says right now.
    reloadIntent: async () => intent(),
    journal,
    persistReceipt: async (receipt) => { stored.push(receipt); },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  row = { approval: approval(), requestFingerprint: "a".repeat(64) };
  posted = [];
  settled = [];
  afterPost = {};
  stored.length = 0;
  provider.clear();
  for (const id of ["camp_1", "set_1", "ad_1"]) {
    provider.set(id, { status: "PAUSED", effective: "PAUSED" });
  }
  const resume = async (_ctx: unknown, id: string) => {
    posted.push(id);
    provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
    afterPost[id]?.();
    return { ok: true };
  };
  vi.mocked(adsWrite.resumeCampaign).mockImplementation(resume as never);
  vi.mocked(adsWrite.resumeAdset).mockImplementation(resume as never);
  vi.mocked(adsWrite.resumeAd).mockImplementation(resume as never);
  vi.mocked(adsWrite.readMetaEntityExecutionState).mockImplementation((async (
    _ctx: unknown, scopeType: string, entityId: string,
  ) => {
    const state = provider.get(entityId)!;
    return {
      ok: true, scopeType, entityId,
      configuredStatus: state.status, effectiveStatus: state.effective,
    };
  }) as never);
  vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation((async (
    _ctx: unknown, adId: string,
  ) => {
    const state = provider.get(adId)!;
    return {
      ok: true, adId,
      configuredStatus: state.status, effectiveStatus: state.effective,
    };
  }) as never);
});

describe("the approval is re-proved before every provider call", () => {
  it("sends nothing after the operator revokes it, and keeps the campaign's receipt", async () => {
    // The operator revokes the moment the campaign comes on — the exact gap
    // the old code could not see.
    afterPost.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };

    const result = await runUnattended();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ONE post. The ad set and the ad were never sent.
    expect(posted).toEqual(["camp_1"]);
    expect(vi.mocked(adsWrite.resumeAdset)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
    expect(result.activation.delivering).toBe(false);
    expect(result.activation.blockedAt).toBe("adset");
    // Named, so the operator reads which authority stopped it.
    expect(result.activation.blockedReason).toBe("activation_approval_revoked");
    /*
      The campaign really is on and nothing rolls it back. Its completed step
      keeps its durable row; the step that was refused is explicit rather than
      missing, and the ad below it says which grain stopped the run.
    */
    expect(stored[0]!.steps.map((step) => [step.entityId, step.outcome, step.actionLogId]))
      .toEqual([
        ["camp_1", "activated", "log_camp_1"],
        ["set_1", "blocked", null],
        ["ad_1", "not_attempted", null],
      ]);
    expect(settled).toEqual([{ id: "log_camp_1", outcome: "activated" }]);
    expect(stored[0]!.coverage).toEqual({
      planned: 3, on: 1, blocked: 1, ambiguous: 0, notAttempted: 1,
    });
  });

  it("sends nothing after the approval expires between two steps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T10:00:00.000Z"));
    // The approval stands for another hour when the run starts.
    row.approval = approval({ expiresAt: "2026-09-05T11:00:00.000Z" });
    afterPost.camp_1 = () => { vi.setSystemTime(new Date("2026-09-05T11:30:00.000Z")); };

    const result = await runUnattended();

    expect(posted).toEqual(["camp_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedReason).toBe("activation_approval_expired");
    expect(result.activation.steps[0]!.outcome).toBe("activated");
  });

  it("sends nothing after the payload it approved changes", async () => {
    /*
      A fingerprint that moves is a different request. The approval names the
      payload it read, and carrying it forward would activate something nobody
      approved — the same rule the entry check applies, applied again at the
      only other moment it can still matter.
    */
    afterPost.camp_1 = () => { row.requestFingerprint = "c".repeat(64); };

    const result = await runUnattended();

    expect(posted).toEqual(["camp_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedReason)
      .toBe("activation_approval_payload_changed");
  });

  it("sends nothing after the approval is rebound to another destination", async () => {
    afterPost.camp_1 = () => {
      row.approval = approval({
        approvedDestination: { campaignId: "camp_other", adsetIds: ["set_other"] },
      });
    };

    const result = await runUnattended();

    expect(posted).toEqual(["camp_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedReason)
      .toBe("activation_approval_destination_mismatch");
  });

  it("sends nothing above an ad once the scope narrows to the ad alone", async () => {
    /*
      A scope rewritten to `ad` mid-sequence no longer covers a parent. The
      campaign is already on and stays on; the ad set is not sent.
    */
    afterPost.camp_1 = () => {
      row.approval = approval({ approvedScope: "ad" });
    };

    const result = await runUnattended();

    expect(posted).toEqual(["camp_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("adset");
    /*
      `activation_approval_scope_mismatch` from the validator itself: an
      ad-scoped approval cannot stand on a launch that created its own campaign.
      Either way the answer is the same — nothing above an ad may be sent.
    */
    expect(result.activation.blockedReason)
      .toBe("activation_approval_scope_mismatch");
  });

  it("still runs the whole hierarchy when nothing changed", async () => {
    // The re-read is a gate, not a brake: an approval that still holds lets
    // every step through exactly as before.
    const result = await runUnattended();

    expect(posted).toEqual(["camp_1", "set_1", "ad_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.delivering).toBe(true);
  });
});

describe("the production scheduled runtime re-reads it too", () => {
  function proposal(): MetaAutomationProposal {
    return {
      id: "p-activate-1",
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scopeType: "campaign",
      scopeId: "camp_1",
      proposedAction: "resume",
      launchIntentId: INTENT,
      entityLabel: "September test — broad",
    } as unknown as MetaAutomationProposal;
  }

  function gates(): ScheduledAuthorityGates {
    return {
      releaseGateOpen: true,
      autoExecutionEnabled: true,
      enabledProviderAccountId: ACCOUNT,
      enablingActorUserId: APPROVER,
      activationControlVersion: CONTROL_VERSION,
      dryRunOnly: false,
    };
  }

  it("withholds the ad set and the ad after a revocation, through the real runtime", async () => {
    /*
      Driven through `createScheduledActivationRuntime` and the REAL
      `activateLaunchIntent`, because the finding is precisely that the runtime
      re-read three things and not the fourth. A double for the activation would
      only prove what the double was told.
    */
    afterPost.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };
    const run = createScheduledActivationRuntime({
      readGates: async () => gates(),
      readMode: async () => "auto",
      // The store. Called at entry AND before every step.
      readIntent: async () => intent(),
    });

    const result = await run({
      proposal: proposal(),
      dryRunOnly: false,
      claimToken: "claim-1",
      authorization: {
        kind: "scheduled",
        expectedEnablingActorUserId: APPROVER,
        expectedActivationControlVersion: CONTROL_VERSION,
      },
      beforeProviderPost: async () => true,
    });

    expect(posted).toEqual(["camp_1"]);
    expect(result.ok).toBe(false);
    // A provider WAS reached — the campaign is on — so this is an outcome and
    // not a refusal, and the row must not claim nothing was contacted.
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(true);
    const response = result.receipt.response as Record<string, unknown>;
    expect(response.delivering).toBe(false);
    expect(response.partial).toBe(true);
    expect(response.blockedReason).toBe("activation_approval_revoked");
    expect(response.coverage).toEqual({
      planned: 3, on: 1, blocked: 1, ambiguous: 0, notAttempted: 1,
    });
  });
});
