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

/**
 * The two windows, as callbacks the seams themselves fire.
 *
 * Hoisted because the DEFAULT journal — the one the production scheduled
 * runtime uses, since `activateLaunchIntent` only defaults it — is the mocked
 * action log below, and the claim window has to be expressible there too.
 */
const windows = vi.hoisted(() => ({
  /** Fired INSIDE the journal claim: after `authorize`, before any request. */
  duringClaim: {} as Record<string, () => void>,
  /** Fired inside the write primitive's own preflight, after the claim. */
  duringPreflight: {} as Record<string, () => void>,
}));

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
  createMetaLaunchActivationActionClaim: vi.fn(async (input: { adId: string }) => {
    windows.duringClaim[input.adId]?.();
    return { claimed: true, log: { id: `log_${input.adId}` } };
  }),
  completeMetaAdsActionLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(async () => null),
  recordMetaLaunchIntentActivation: vi.fn(async () => undefined),
}));

import * as actionLog from "@/lib/meta/ads-action-log";
import * as adsWrite from "@/lib/meta/ads-write";
import * as writeGuard from "@/lib/meta/automation-write-guard";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { ACTIVATION_APPROVAL_CONTRACT } from "@/lib/meta/launch-activation-approval";
import {
  ACTIVATION_POLICY_VERSION,
  activateLaunchIntent,
  type ActivationJournal,
  type LaunchActivationReceipt,
} from "@/lib/meta/launch-intent-activation";
import {
  runClaimedProposalExecution,
  type ClaimedExecutionDeps,
} from "@/lib/meta/budget-execution-lifecycle";
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
let settled: Array<{ id: string; outcome: string; reason: string | null }> = [];
const stored: LaunchActivationReceipt[] = [];
/** Fired the moment the named entity's resume lands, before the next step. */
let afterPost: Record<string, () => void> = {};
/**
 * `windows.duringClaim` is the first window the entry gate cannot see:
 * `authorize` has already answered, and the claim is a durable write that
 * awaits the database before anything is sent.
 *
 * `windows.duringPreflight` is strictly later — `updateAdStatus` reads the ad
 * back by id there and `metaFetchWriteOnce` takes the atomic write-authority
 * snapshot; both stand between the claim and the POST, and both are long enough
 * for an operator route to commit a revocation.
 */
const { duringClaim, duringPreflight } = windows;

const journal: ActivationJournal = {
  findUnresolved: async () => null,
  claim: async (input) => {
    duringClaim[input.entityId]?.();
    return { id: `log_${input.entityId}` };
  },
  settle: async (input) => {
    settled.push({ id: input.id, outcome: input.outcome, reason: input.reason });
  },
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

/*
  The clock is PINNED, because this suite's subject is an expiry.

  `beforeEach` used to call `vi.useRealTimers()`, so every case was judged
  against the wall clock while the shared fixture declared
  `expiresAt: "2026-09-06T09:00:00.000Z"`. That is a time bomb, and it went off:
  the file passed every run up to 2026-09-06T09:00Z and failed all 14 of its
  approval-dependent cases from 09:00Z onward — first observed on CI at 11:12Z,
  reproduced locally at 11:14Z, and reproducing identically on the two earlier
  commits of this branch, which is how it was established as a latent defect
  rather than a regression.

  An expiry test must not be able to expire. Time is frozen inside the approval
  window instead, so the fixture's absolute dates keep the meaning they were
  written with. `shouldAdvanceTime` lets the clock creep with real time so that
  nothing awaiting a timer can stall, which cannot matter here: the nearest
  boundary is 21 hours away and a run takes milliseconds.

  The one case that is ABOUT the boundary — "sends nothing after the approval
  expires between two steps" — installs its own fake timers and its own
  approval, and is unaffected.
*/
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
  row = { approval: approval(), requestFingerprint: "a".repeat(64) };
  posted = [];
  settled = [];
  afterPost = {};
  for (const key of Object.keys(duringClaim)) delete duringClaim[key];
  for (const key of Object.keys(duringPreflight)) delete duringPreflight[key];
  stored.length = 0;
  provider.clear();
  // `clearAllMocks` clears calls, not implementations, so the posture is
  // restated here rather than leaking out of whichever case last changed it.
  vi.mocked(writeGuard.readMetaWritePosture).mockImplementation((async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })) as never);
  // Same reason: the no-blind-retry gate's reader is a module mock, and a case
  // that arms it must not arm it for every case after.
  vi.mocked(actionLog.findUnresolvedMetaAdStatusActionLog)
    .mockImplementation((async () => null) as never);
  for (const id of ["camp_1", "set_1", "ad_1"]) {
    provider.set(id, { status: "PAUSED", effective: "PAUSED" });
  }
  /*
    A double shaped like the real primitive, in the real order.

    `resumeCampaign`/`resumeAdset` reach `metaFetchWriteOnce`, which takes the
    atomic write-authority snapshot and THEN runs `beforeMutationAttempt`
    immediately before the request; `resumeAd` reads the ad back first and runs
    the hook with that baseline. So: preflight, hook, POST — and a hook that
    throws returns a named failure with no request made at all
    (`buildWriteTransportFailure` with a null `mutationAttempt`).

    Modelling that order is the whole point. A double that simply posts could
    not express the window this file is about, and would pass whether or not the
    hook is ever wired.
  */
  const resume = async (
    _ctx: unknown,
    id: string,
    options?: { beforeMutationAttempt?: (baseline: unknown) => Promise<void> },
  ) => {
    duringPreflight[id]?.();
    if (options?.beforeMutationAttempt) {
      try {
        await options.beforeMutationAttempt({ adId: id });
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        return {
          ok: false,
          providerMutationAttempted: false,
          error: {
            code: typeof code === "string" ? code : "before_mutation_attempt_failed",
            message: "The pre-mutation hook refused.",
          },
        };
      }
    }
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
    expect(settled).toEqual([
      { id: "log_camp_1", outcome: "activated", reason: null },
    ]);
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

/**
 * The two windows the entry gate and the per-step gate BOTH miss.
 *
 * `activateHierarchy` asks `authorize` and, only then, `activate` awaits
 * `journal.findUnresolved`, awaits `journal.claim`, and finally calls the write
 * primitive — which takes its own authority snapshot before the request goes
 * out. Three awaits stand between the last question and the POST. An operator
 * revoking inside any of them was not seen, because nothing re-asked at the
 * provider boundary itself.
 */
describe("the approval is re-proved inside the primitive's pre-POST hook", () => {
  it("sends nothing when the revocation lands during the journal claim", async () => {
    // The claim is a durable write. The operator's route commits the revocation
    // while it is in flight — after `authorize` said yes, before any POST.
    duringClaim.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };

    const result = await runUnattended();

    expect(posted).toEqual([]);
    expect(vi.mocked(adsWrite.resumeCampaign)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adsWrite.resumeAdset)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("campaign");
    expect(result.activation.blockedReason).toBe("activation_approval_revoked");
    expect(result.activation.delivering).toBe(false);
    expect(result.activation.partial).toBe(false);
    /*
      And the claim that was written is SETTLED, not left pending.

      A pending row is this table's statement that a call may be in flight, and
      `findUnresolvedMetaAdStatusActionLog` reads exactly that. Leaving one
      behind for a POST that never happened would block the next honest attempt
      on an entity nobody has written to.
    */
    expect(settled).toEqual([
      {
        id: "log_camp_1",
        outcome: "authority_refused",
        reason: "activation_approval_revoked",
      },
    ]);
    expect(
      stored[0]!.steps.map((step) => [step.entityId, step.outcome, step.claimOutcome]),
    ).toEqual([
      ["camp_1", "blocked", "authority_refused"],
      ["set_1", "not_attempted", null],
      ["ad_1", "not_attempted", null],
    ]);
    expect(stored[0]!.coverage).toEqual({
      planned: 3, on: 0, blocked: 1, ambiguous: 0, notAttempted: 2,
    });
  });

  it("sends nothing when the revocation lands during the provider preflight", async () => {
    // Strictly later still: `authorize` has answered, the claim is written, and
    // the primitive is inside its own read-back and authority snapshot.
    duringPreflight.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };

    const result = await runUnattended();

    expect(posted).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("campaign");
    expect(result.activation.blockedReason).toBe("activation_approval_revoked");
    expect(settled).toEqual([
      {
        id: "log_camp_1",
        outcome: "authority_refused",
        reason: "activation_approval_revoked",
      },
    ]);
  });

  it("keeps the completed step's receipt when the window opens mid-sequence", async () => {
    /*
      The campaign comes on honestly; the revocation lands inside the AD SET's
      claim. The verified write is not rolled back — nothing here undoes a
      provider write to tidy a report — and everything below it stops.
    */
    duringClaim.set_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };

    const result = await runUnattended();

    expect(posted).toEqual(["camp_1"]);
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("adset");
    expect(result.activation.blockedReason).toBe("activation_approval_revoked");
    expect(settled).toEqual([
      { id: "log_camp_1", outcome: "activated", reason: null },
      {
        id: "log_set_1",
        outcome: "authority_refused",
        reason: "activation_approval_revoked",
      },
    ]);
    expect(
      stored[0]!.steps.map((step) => [step.entityId, step.outcome, step.actionLogId]),
    ).toEqual([
      ["camp_1", "activated", "log_camp_1"],
      ["set_1", "blocked", "log_set_1"],
      ["ad_1", "not_attempted", null],
    ]);
    expect(stored[0]!.coverage).toEqual({
      planned: 3, on: 1, blocked: 1, ambiguous: 0, notAttempted: 1,
    });
  });

  it("halts the run rather than stopping one branch", async () => {
    /*
      A withdrawn approval is a statement about the WHOLE run. An independently
      approved sibling ad set is not more permitted than the one just refused,
      so nothing below or beside the refusal is attempted.
    */
    duringPreflight.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };

    const result = await runUnattended();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.steps.map((step) => step.outcome)).toEqual([
      "blocked", "not_attempted", "not_attempted",
    ]);
    expect(result.activation.steps.slice(1).map((step) => step.reason)).toEqual([
      "blocked_at_campaign", "blocked_at_campaign",
    ]);
  });

  it("still posts every step when the approval holds through both windows", async () => {
    // The hook is a gate, not a brake.
    const result = await runUnattended();

    expect(posted).toEqual(["camp_1", "set_1", "ad_1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.delivering).toBe(true);
    expect(settled.map((entry) => entry.outcome)).toEqual([
      "activated", "activated", "activated",
    ]);
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

  it("withholds the first POST when the revocation lands during the claim", async () => {
    /*
      The same window, through the production runtime. `authorize` has already
      passed and stamped the dispatch marker; the revocation commits while the
      claim is being written; nothing reaches the provider.
    */
    duringClaim.camp_1 = () => {
      row.approval = approval({ revokedAt: "2026-09-05T09:05:00.000Z" });
    };
    const run = createScheduledActivationRuntime({
      readGates: async () => gates(),
      readMode: async () => "auto",
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

    expect(posted).toEqual([]);
    expect(result.ok).toBe(false);
    // Not `withheld`: the row was claimed and the sequence ran. But no provider
    // was reached, and the receipt must not say one was just because the
    // dispatch marker had already been stamped.
    expect(result.receipt.withheld).toBeNull();
    expect(result.receipt.providerMutationAttempted).toBe(false);
    const response = result.receipt.response as Record<string, unknown>;
    expect(response.blockedReason).toBe("activation_approval_revoked");
    expect(response.coverage).toEqual({
      planned: 3, on: 0, blocked: 1, ambiguous: 0, notAttempted: 2,
    });
  });

  it("withholds the POST when the runtime's OWN gate closes during the claim", async () => {
    /*
      The finding asks for the caller's authority gates at the boundary too, not
      only the approval. The STOP is engaged while the claim is being written —
      after this runtime's per-step `authorize` has already said yes.
    */
    let stopped = false;
    vi.mocked(writeGuard.readMetaWritePosture).mockImplementation((async () =>
      stopped
        ? { blocked: true, rehearsal: true, reason: "business_kill_switch", message: null }
        : { blocked: false, rehearsal: false, reason: null, message: null }) as never);
    duringClaim.camp_1 = () => { stopped = true; };

    const run = createScheduledActivationRuntime({
      readGates: async () => gates(),
      readMode: async () => "auto",
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

    expect(posted).toEqual([]);
    const response = result.receipt.response as Record<string, unknown>;
    expect(response.blockedReason).toBe("business_kill_switch");
    expect(result.receipt.providerMutationAttempted).toBe(false);
  });

  /*
    The consequence ONE LAYER UP, driven through the real lifecycle.

    `result.reconcile` is the runtime's own answer and it is only half the
    question. `runClaimedProposalExecution` decides what the claimed row settles
    to, and it gates that on `receipt.providerMutationAttempted`
    (`budget-execution-lifecycle.ts`, read as `providerDispatchStarted`): a row
    it settles `failed` releases the entity's one action slot, because `failed`
    is not one of `META_AUTOMATION_PROPOSAL_OPEN_STATUSES` and `reconcile` is
    — the list `automation-proposals.ts` documents as the thing that stops a
    projection raising a SECOND proposal for work whose provider outcome nobody
    has established. So the assertion has to be the settled status, not the
    runtime's flag.
  */
  async function throughLifecycle() {
    const settledStatuses: string[] = [];
    const ledger: string[] = [];
    const run = createScheduledActivationRuntime({
      readGates: async () => gates(),
      readMode: async () => "auto",
      readIntent: async () => intent(),
    });
    const deps: ClaimedExecutionDeps = {
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      proposal: proposal(),
      claimToken: "claim-1",
      actorUserId: APPROVER,
      executionKind: "scheduled",
      // The durable pre-POST marker, which the runtime fires from inside its
      // per-step authority hook exactly as production does.
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
        authorization: {
          kind: "scheduled",
          expectedEnablingActorUserId: APPROVER,
          expectedActivationControlVersion: CONTROL_VERSION,
        },
        beforeProviderPost,
      }),
    };
    const result = await runClaimedProposalExecution(deps);
    return { settledStatuses, ledger, result };
  }

  it("holds the row in reconcile when a PRIOR attempt on the entity is unresolved", async () => {
    /*
      The no-blind-retry gate arms: an earlier pause or resume on this campaign
      is still `pending` or `silent_failure`, so a provider mutation on it may
      be in flight or may already have landed — just not one of ours.
    */
    vi.mocked(actionLog.findUnresolvedMetaAdStatusActionLog)
      .mockImplementation((async () => ({ id: "log_old" })) as never);

    const probe = await throughLifecycle();

    // Nothing was sent by THIS dispatch, and no new claim was even written:
    // the gate refuses in front of both.
    expect(posted).toEqual([]);
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
    expect(vi.mocked(actionLog.createMetaLaunchActivationActionClaim)).not.toHaveBeenCalled();
    // And the older row is left exactly as it is, for a person to resolve.
    expect(vi.mocked(actionLog.completeMetaAdsActionLog)).not.toHaveBeenCalled();

    const response = probe.result.receipt.response as Record<string, unknown>;
    expect(response.blockedReason).toBe("unresolved_prior_attempt");
    expect(probe.result.reconcile).toBe(true);
    // THE ASSERTION THIS FILE WAS MISSING: the settled status, which is what
    // keeps the entity's action slot held.
    expect(probe.settledStatuses).toEqual(["reconcile"]);
    expect(probe.result.settledStatus).toBe("reconcile");
    expect(probe.ledger).toEqual(["automation_proposal_reconcile"]);
  });
});
