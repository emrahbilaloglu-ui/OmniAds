/**
 * R5, reproduced and then fixed: activation silently dropped entities.
 *
 * `activationPlanForIntent` took `adsetIds[0]` and `adIds[0]`, and
 * `activateHierarchy` then used `find` once per grain — so a launch that
 * created two ad sets and two ads was activated as three entities and still
 * reported `delivering: true`. The review drove the real hierarchy function
 * with injected in-memory provider operations and watched it happen:
 *
 *     requested: [c1, s1, s2, a1, a2]
 *     called:    [c1, s1, a1]
 *     delivering: true
 *     unvisited: [s2, a2]
 *
 * That is the worst shape a receipt can take. The dropped ad set and ad exist
 * in the account, paused, while the operator reads that their launch is live —
 * and nothing anywhere records that two identities were never considered.
 *
 * The first case below is that exact reproduction, kept as a regression. The
 * rest drive the real `activateLaunchIntent` — plan, ordering, journal and
 * receipt — over a launch with two ad sets and two ads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
  readMetaEntityExecutionState: vi.fn(),
  resumeAd: vi.fn(),
  resumeAdset: vi.fn(),
  resumeCampaign: vi.fn(),
}));

import * as adsWrite from "@/lib/meta/ads-write";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import {
  activateHierarchy,
  type ActivationTarget,
} from "@/lib/meta/hierarchy-activation";
import {
  activateLaunchIntent,
  activationPlanForIntent,
  type ActivationJournal,
  type LaunchActivationReceipt,
} from "@/lib/meta/launch-intent-activation";

const OPERATOR = "22222222-2222-4222-8222-222222222222";

/**
 * A launch that made two ad sets and, under each, one ad.
 *
 * The `steps` array is the create runtime's own shape: it pushes an `adset`
 * step and then, inside that ad set's loop, one `ad` step per creative. That
 * ordering is the only record of which ad set an ad belongs to, and it is what
 * the plan reads to give each ad its parent.
 */
function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    businessId: "44444444-4444-4444-8444-444444444444",
    providerAccountId: "act_9",
    operation: "new_campaign",
    idempotencyKey: "idem",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: null, sourceDecisionSnapshotId: null,
      creativeBriefId: null, sourceDraftId: null,
    },
    requestPayload: { creatives: [{ creativeId: "cr_1" }] },
    requestFingerprint: "a".repeat(64),
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-09-05T09:00:00.000Z",
      providerAccountId: "act_9",
      campaignId: "camp_1",
      adsetIds: ["set_1", "set_2"],
      adIds: ["ad_1", "ad_2"],
      steps: [
        { kind: "campaign", index: 0, status: "success", id: "camp_1" },
        { kind: "adset", index: 0, status: "success", id: "set_1" },
        { kind: "ad", index: 0, status: "success", id: "ad_1" },
        { kind: "adset", index: 1, status: "success", id: "set_2" },
        { kind: "ad", index: 1, status: "success", id: "ad_2" },
      ],
      recovery: { rollbackSupported: false, retrySupported: false },
    },
    errorReceipt: null,
    activationApproval: null,
    activationReceipt: null,
    createdBy: OPERATOR,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    startedAt: "2026-09-05T08:30:00.000Z",
    completedAt: "2026-09-05T09:00:00.000Z",
    ...overrides,
  };
}

/** What the provider double says each entity's two statuses are right now. */
const provider = new Map<string, { status: string; effective: string }>();
/** Every entity the run POSTed to, in order. */
let posted: string[] = [];
/** Every claim the journal was asked to write, in order. */
let claimed: string[] = [];
const stored: LaunchActivationReceipt[] = [];
/** Entities the provider refuses to resume, and the code it refuses with. */
let refuses: Record<string, string> = {};

const journal: ActivationJournal = {
  findUnresolved: async () => null,
  claim: async (input) => {
    claimed.push(input.entityId);
    return { id: `log_${input.entityId}` };
  },
  settle: async () => undefined,
};

async function activate(
  authorize?: (target: ActivationTarget) => Promise<string | null>,
) {
  return activateLaunchIntent({
    intent: intent(),
    ctx: {} as never,
    authorization: { kind: "operator", operatorUserId: OPERATOR },
    journal,
    ...(authorize ? { authorize } : {}),
    persistReceipt: async (receipt) => { stored.push(receipt); },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  posted = [];
  claimed = [];
  refuses = {};
  stored.length = 0;
  provider.clear();
  for (const id of ["camp_1", "set_1", "set_2", "ad_1", "ad_2"]) {
    provider.set(id, { status: "PAUSED", effective: "PAUSED" });
  }
  /*
    The double runs the pre-POST hook before it records a POST, exactly as the
    real primitives do — hook last, request after. Cases that pass no gate get
    an undefined hook and the same double they always had.
  */
  const resume = async (
    _ctx: unknown,
    id: string,
    options?: { beforeMutationAttempt?: (baseline: unknown) => Promise<void> },
  ) => {
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
    const refusal = refuses[id];
    if (refusal) {
      return {
        ok: false,
        error: { code: refusal, message: refusal },
        providerOutcome: "definite_failure",
      };
    }
    provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
    return { ok: true };
  };
  vi.mocked(adsWrite.resumeCampaign).mockImplementation(resume as never);
  vi.mocked(adsWrite.resumeAdset).mockImplementation(resume as never);
  vi.mocked(adsWrite.resumeAd).mockImplementation(resume as never);
  vi.mocked(adsWrite.readMetaEntityExecutionState).mockImplementation((async (
    _ctx: unknown, scopeType: string, entityId: string,
  ) => {
    const state = provider.get(entityId);
    if (!state) return { ok: false, error: { code: "not_found" } };
    return {
      ok: true, scopeType, entityId,
      configuredStatus: state.status, effectiveStatus: state.effective,
    };
  }) as never);
  vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation((async (
    _ctx: unknown, adId: string,
  ) => {
    const state = provider.get(adId);
    if (!state) return { ok: false, error: { code: "not_found" } };
    return {
      ok: true, adId,
      configuredStatus: state.status, effectiveStatus: state.effective,
    };
  }) as never);
});

describe("the review's reproduction, kept", () => {
  it("calls every requested identity instead of the first of each grain", async () => {
    const requested: ActivationTarget[] = [
      { grain: "campaign", entityId: "c1" },
      { grain: "adset", entityId: "s1" },
      { grain: "adset", entityId: "s2" },
      { grain: "ad", entityId: "a1" },
      { grain: "ad", entityId: "a2" },
    ];
    const state: Record<string, "ACTIVE" | "PAUSED"> = {
      c1: "PAUSED", s1: "PAUSED", s2: "PAUSED", a1: "PAUSED", a2: "PAUSED",
    };
    const called: string[] = [];

    const result = await activateHierarchy({
      targets: requested,
      deps: {
        activate: async (target) => {
          called.push(target.entityId);
          state[target.entityId] = "ACTIVE";
          return { ok: true };
        },
        readState: async (target) => ({
          id: target.entityId,
          status: state[target.entityId] ?? "PAUSED",
          effectiveStatus: state[target.entityId] ?? "PAUSED",
        }),
      },
    });

    // The exact list the review watched shrink to [c1, s1, a1].
    expect(called).toEqual(["c1", "s1", "s2", "a1", "a2"]);
    expect(result.steps.map((step) => step.entityId))
      .toEqual(["c1", "s1", "s2", "a1", "a2"]);
    expect(result.delivering).toBe(true);
    expect(result.coverage).toEqual({
      planned: 5, on: 5, blocked: 0, ambiguous: 0, notAttempted: 0,
    });
  });

  it("refuses to say delivering when an identity was never turned on", async () => {
    /*
      The other half of the same defect. `delivering` used to be asked of the
      steps the run chose to take, so three activated steps out of five
      requested identities read as a launch.
    */
    const result = await activateHierarchy({
      targets: [
        { grain: "adset", entityId: "s1" },
        { grain: "adset", entityId: "s2" },
      ],
      deps: {
        activate: async (target) =>
          target.entityId === "s2"
            ? { ok: false, reason: "adset_in_review" }
            : { ok: true },
        readState: async (target) => ({
          id: target.entityId,
          status: target.entityId === "s1" ? "ACTIVE" : "PAUSED",
          effectiveStatus: target.entityId === "s1" ? "ACTIVE" : "PAUSED",
        }),
      },
    });

    expect(result.delivering).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.coverage.on).toBe(1);
    expect(result.coverage.planned).toBe(2);
  });
});

describe("the plan is the complete identity set", () => {
  it("names every ad set and every ad, each under the parent that made it", () => {
    expect(activationPlanForIntent(intent())).toEqual([
      { grain: "campaign", entityId: "camp_1" },
      { grain: "adset", entityId: "set_1", parentEntityId: "camp_1" },
      { grain: "adset", entityId: "set_2", parentEntityId: "camp_1" },
      { grain: "ad", entityId: "ad_1", parentEntityId: "set_1" },
      { grain: "ad", entityId: "ad_2", parentEntityId: "set_2" },
    ]);
  });

  it("leaves an ad unparented when the receipt cannot say which ad set made it", () => {
    /*
      A receipt whose steps were not recorded cannot attribute an ad to one of
      two ad sets. Guessing would be worse than the conservative rule, so the ad
      names no parent and the sequence requires BOTH ad sets to be on first.
    */
    const plan = activationPlanForIntent(intent({
      resultReceipt: { ...intent().resultReceipt!, steps: [] },
    }));
    expect(plan.filter((target) => target.grain === "ad")).toEqual([
      { grain: "ad", entityId: "ad_1", parentEntityId: null },
      { grain: "ad", entityId: "ad_2", parentEntityId: null },
    ]);
  });

  it("never names a parent for an add-to-existing ad", () => {
    // The ad set it joined is live and was not created here. It is not in the
    // plan, so nothing can be blocked on it and nothing can turn it on.
    expect(activationPlanForIntent(intent({ operation: "add_to_existing" })))
      .toEqual([
        { grain: "ad", entityId: "ad_1" },
        { grain: "ad", entityId: "ad_2" },
      ]);
  });
});

describe("two ad sets and two ads, driven through the real activation", () => {
  it("turns on all five, journals one row each, and only then says delivering", async () => {
    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Outside in between grains; given order within one.
    expect(posted).toEqual(["camp_1", "set_1", "set_2", "ad_1", "ad_2"]);
    // One durable row per entity, no more and no fewer.
    expect(claimed).toEqual(["camp_1", "set_1", "set_2", "ad_1", "ad_2"]);
    expect(result.activation.delivering).toBe(true);
    expect(result.receipt.coverage).toEqual({
      planned: 5, on: 5, blocked: 0, ambiguous: 0, notAttempted: 0,
    });
    expect(result.receipt.partial).toBe(false);
    expect(stored[0]!.steps.map((step) => [step.entityId, step.outcome])).toEqual([
      ["camp_1", "activated"],
      ["set_1", "activated"],
      ["set_2", "activated"],
      ["ad_1", "activated"],
      ["ad_2", "activated"],
    ]);
  });

  it("stops one branch at the ad set that failed and leaves the sibling on", async () => {
    refuses = { set_2: "adset_in_review" };

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The ad under the failed ad set was never sent; the one under the ad set
    // that came on was, because its own parent really is active.
    expect(posted).toEqual(["camp_1", "set_1", "set_2", "ad_1"]);
    expect(result.activation.delivering).toBe(false);
    expect(result.receipt.partial).toBe(true);
    expect(result.activation.blockedAt).toBe("adset");
    expect(result.activation.blockedReason).toBe("adset_in_review");
    /*
      THE POINT OF THE FINDING: all five identities are accounted for. The one
      that failed says so, and the one that was never attempted says which
      grain stopped it — neither is missing from the receipt.
    */
    expect(stored[0]!.steps.map((step) => [step.entityId, step.outcome, step.reason]))
      .toEqual([
        ["camp_1", "activated", null],
        ["set_1", "activated", null],
        ["set_2", "blocked", "adset_in_review"],
        ["ad_1", "activated", null],
        ["ad_2", "not_attempted", "blocked_at_adset"],
      ]);
    expect(result.receipt.coverage).toEqual({
      planned: 5, on: 3, blocked: 1, ambiguous: 0, notAttempted: 1,
    });
  });

  it("resumes only the unfinished entities on the retry", async () => {
    refuses = { set_2: "adset_in_review" };
    await activate();

    posted = [];
    claimed = [];
    stored.length = 0;
    refuses = {};

    const retried = await activate();

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    /*
      Three entities were already active, so they cost one read and no write —
      which is what makes a retry safe to run as often as an operator likes.
      Nothing is created here, so nothing can be duplicated; the identities were
      fixed when the launch receipt was written.
    */
    expect(posted).toEqual(["set_2", "ad_2"]);
    expect(claimed).toEqual(["set_2", "ad_2"]);
    expect(retried.activation.delivering).toBe(true);
    expect(retried.receipt.coverage).toEqual({
      planned: 5, on: 5, blocked: 0, ambiguous: 0, notAttempted: 0,
    });
    expect(stored[0]!.steps.map((step) => [step.entityId, step.outcome])).toEqual([
      ["camp_1", "already_active"],
      ["set_1", "already_active"],
      ["set_2", "activated"],
      ["ad_1", "already_active"],
      ["ad_2", "activated"],
    ]);
  });

  it("attempts nothing after an ambiguous step, in any branch", async () => {
    /*
      An unknown outcome is not a branch failure. The write may have landed, so
      re-sending it could be the second of two writes on a live entity — and the
      run parks for a person rather than continuing anywhere.
    */
    vi.mocked(adsWrite.resumeAdset).mockImplementation((async (
      _ctx: unknown, id: string,
    ) => {
      posted.push(id);
      if (id === "set_1") {
        return {
          ok: false,
          error: { code: "provider_outcome_ambiguous", message: "timeout" },
          providerOutcome: "outcome_ambiguous",
        };
      }
      provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
      return { ok: true };
    }) as never);

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(posted).toEqual(["camp_1", "set_1"]);
    expect(result.activation.blockedAt).toBe("adset");
    expect(result.receipt.coverage).toEqual({
      planned: 5, on: 1, blocked: 0, ambiguous: 1, notAttempted: 3,
    });
  });

  it("halts every branch when the authority is refused at the provider boundary", async () => {
    /*
      A blocked ad set stops its own ad and leaves the sibling branch alone.
      A withdrawn authority is not that: it is a statement about the whole run,
      so the sibling ad set — independently approved, independently deliverable
      — is not attempted either. The gate answers yes when the sequence asks and
      no when the primitive asks, which is the window this exists for.
    */
    const asked = new Map<string, number>();
    const result = await activate(async (target) => {
      const seen = (asked.get(target.entityId) ?? 0) + 1;
      asked.set(target.entityId, seen);
      return target.entityId === "set_1" && seen > 1
        ? "activation_approval_revoked"
        : null;
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The campaign really is on. `set_2` is untouched, and so is every ad.
    expect(posted).toEqual(["camp_1"]);
    expect(result.activation.steps.map((step) => [step.entityId, step.outcome]))
      .toEqual([
        ["camp_1", "activated"],
        ["set_1", "blocked"],
        ["set_2", "not_attempted"],
        ["ad_1", "not_attempted"],
        ["ad_2", "not_attempted"],
      ]);
    expect(result.activation.blockedReason).toBe("activation_approval_revoked");
    /*
      Every identity is still accounted for, and `delivering` is false because
      one of five is on — not because the run chose to take fewer steps.
    */
    expect(result.receipt.coverage).toEqual({
      planned: 5, on: 1, blocked: 1, ambiguous: 0, notAttempted: 3,
    });
    expect(result.activation.delivering).toBe(false);
    expect(result.activation.partial).toBe(true);
    // One row per identity that reached the boundary, and no more.
    expect(claimed).toEqual(["camp_1", "set_1"]);
    expect(result.receipt.steps.map((step) => step.claimOutcome)).toEqual([
      "activated", "authority_refused", null, null, null,
    ]);
  });
});
