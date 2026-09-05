import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
  readMetaEntityExecutionState: vi.fn(),
  resumeAd: vi.fn(async () => ({ ok: true })),
  resumeAdset: vi.fn(async () => ({ ok: true })),
  resumeCampaign: vi.fn(async () => ({ ok: true })),
}));

import * as adsWrite from "@/lib/meta/ads-write";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import {
  ACTIVATION_POLICY_VERSION,
  activateLaunchIntent,
  activationPlanForIntent,
} from "@/lib/meta/launch-intent-activation";
import { ACTIVATION_APPROVAL_CONTRACT } from "@/lib/meta/launch-activation-approval";

const APPROVER = "22222222-2222-4222-8222-222222222222";

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    businessId: "11111111-1111-4111-8111-111111111111",
    providerAccountId: "act_1",
    operation: "new_campaign",
    idempotencyKey: "idem",
    requestedStatus: "PAUSED",
    lineage: {
      sourceDecisionId: null, sourceDecisionSnapshotId: null,
      creativeBriefId: null, sourceDraftId: null,
    },
    requestPayload: { creativeId: "cr_1" },
    requestFingerprint: "a".repeat(64),
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-09-05T09:00:00.000Z",
      providerAccountId: "act_1",
      campaignId: "camp_1",
      adsetIds: ["set_1"],
      adIds: ["ad_1"],
      steps: [],
      recovery: { rollbackSupported: false, retrySupported: false },
    },
    errorReceipt: null,
    activationApproval: null,
    activationReceipt: null,
    createdBy: APPROVER,
    createdAt: "2026-09-05T08:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    startedAt: "2026-09-05T08:30:00.000Z",
    completedAt: "2026-09-05T09:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: ACTIVATION_APPROVAL_CONTRACT,
    businessId: intent().businessId,
    providerAccountId: "act_1",
    launchIntentId: intent().id,
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

/** Every entity reads back active, so a run that writes is a run that succeeds. */
function providerIsAgreeable() {
  vi.mocked(adsWrite.readMetaEntityExecutionState).mockImplementation((async (
    _ctx: unknown, scopeType: string, entityId: string,
  ) => ({
    ok: true, scopeType, entityId,
    configuredStatus: written.has(entityId) ? "ACTIVE" : "PAUSED",
    effectiveStatus: written.has(entityId) ? "ACTIVE" : "PAUSED",
  })) as never);
  vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation((async (
    _ctx: unknown, adId: string,
  ) => ({
    ok: true, adId,
    configuredStatus: written.has(adId) ? "ACTIVE" : "PAUSED",
    effectiveStatus: written.has(adId) ? "ACTIVE" : "PAUSED",
  })) as never);
}

const written = new Set<string>();

/*
  The durable seam, faked.

  Activation now claims a row before every POST and terminalises it after, in
  the same action log every other Meta write uses. These tests are about the
  sequence, not the table, so they inject a journal that records the calls —
  the durable behaviour itself is proved in `launch-activation-durability`.
*/
const claims: Array<{ entityId: string; grain: string }> = [];
const settled: Array<{ id: string; outcome: string }> = [];
let unresolvedFor = new Set<string>();
const receipts: unknown[] = [];

const fakeJournal = {
  findUnresolved: async (input: { entityId: string }) =>
    unresolvedFor.has(input.entityId) ? { id: `prior_${input.entityId}` } : null,
  claim: async (input: { entityId: string; grain: string }) => {
    claims.push({ entityId: input.entityId, grain: input.grain });
    return { id: `log_${input.entityId}` };
  },
  settle: async (input: { id: string; outcome: string }) => {
    settled.push({ id: input.id, outcome: input.outcome });
  },
};

const persistReceipt = async (receipt: unknown) => {
  receipts.push(receipt);
};

beforeEach(() => {
  vi.clearAllMocks();
  written.clear();
  claims.length = 0;
  settled.length = 0;
  receipts.length = 0;
  unresolvedFor = new Set<string>();
  for (const [fn, ids] of [
    [adsWrite.resumeCampaign, "camp"], [adsWrite.resumeAdset, "set"],
    [adsWrite.resumeAd, "ad"],
  ] as const) {
    vi.mocked(fn).mockImplementation((async (_ctx: unknown, id: string) => {
      void ids;
      written.add(id);
      return { ok: true };
    }) as never);
  }
  providerIsAgreeable();
});

describe("the plan comes from the receipt, not the request", () => {
  it("activates all three for a launch that created its own campaign, each naming its parent", () => {
    /*
      The parent is part of the plan now. It is what makes a second ad set
      independent of the first — an ad names the ad set it was created under, so
      a blocked ad set stops its own ads and not the sibling branch's.
    */
    expect(activationPlanForIntent(intent())).toEqual([
      { grain: "campaign", entityId: "camp_1" },
      { grain: "adset", entityId: "set_1", parentEntityId: "camp_1" },
      // One ad set, so nothing has to be attributed: the conservative rule
      // (every planned ancestor on first) already names it exactly.
      { grain: "ad", entityId: "ad_1", parentEntityId: null },
    ]);
  });

  it("activates only the ad when the launch joined a live ad set", () => {
    /*
      The receipt of an add-to-existing names the campaign the ad joined,
      because the ad has to live somewhere. Turning that campaign on would be
      publishing structure this launch never created.
    */
    expect(activationPlanForIntent(intent({ operation: "add_to_existing" })))
      .toEqual([{ grain: "ad", entityId: "ad_1" }]);
  });

  it("uses the partial identities of a half-finished launch", () => {
    const partial = intent({
      status: "partially_succeeded",
      resultReceipt: null,
      errorReceipt: {
        recordedAt: "2026-09-05T09:00:00.000Z",
        code: "ad_create_failed", message: "x", failedAt: null,
        providerAccountId: "act_1",
        partialResult: {
          campaignId: "camp_1", adsetIds: ["set_1"], adIds: [], steps: [],
        },
        recovery: { rollbackSupported: false, retrySupported: false },
      },
    });
    // The campaign it created is real whether or not the ad followed.
    expect(activationPlanForIntent(partial)).toEqual([
      { grain: "campaign", entityId: "camp_1" },
      { grain: "adset", entityId: "set_1", parentEntityId: "camp_1" },
    ]);
  });
});

describe("an operator may activate; an unattended run needs an approval", () => {
  it("runs the sequence for an operator with no stored approval", async () => {
    const result = await activateLaunchIntent({
      intent: intent(),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "operator", operatorUserId: APPROVER },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.activation.delivering).toBe(true);
    expect(vi.mocked(adsWrite.resumeCampaign)).toHaveBeenCalledTimes(1);
  });

  it("refuses an unattended run with no approval and writes nothing", async () => {
    const result = await activateLaunchIntent({
      intent: intent(),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
    });

    expect(result).toEqual({ ok: false, refusal: "activation_approval_absent" });
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
  });

  it("runs the whole hierarchy for an explicit hierarchy approval", async () => {
    const approved = intent({ activationApproval: approval() });
    const result = await activateLaunchIntent({
      intent: approved,
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      // The approval is re-proved before every step, so an unattended run needs
      // the row as it stands right now — not the copy it was handed.
      reloadIntent: async () => approved,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activation.steps.map((step) => [step.grain, step.outcome]))
        .toEqual([
          ["campaign", "activated"],
          ["adset", "activated"],
          ["ad", "activated"],
        ]);
      expect(result.activation.delivering).toBe(true);
    }
  });

  it("refuses an unattended run whose approval cannot be re-read at the step", async () => {
    /*
      An unreadable authority is not an unchanged one. The run has no document
      to send the next write under, so it stops rather than proceeding on the
      copy it happened to load first.
    */
    const result = await activateLaunchIntent({
      intent: intent({ activationApproval: approval() }),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      reloadIntent: async () => null,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activation.blockedAt).toBe("campaign");
      expect(result.activation.blockedReason).toBe("activation_intent_unreadable");
    }
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
  });

  it("refuses an unattended run the approval does not cover completely", async () => {
    /*
      The approval names a SET of creatives, and containment is asked against
      what the launch actually produced. A document naming `cr_1` cannot turn
      on the ads built from `cr_2`: that would be acting under an authorization
      which never mentioned them.
    */
    const many = intent({
      activationApproval: approval(),
      requestPayload: { creatives: [{ creativeId: "cr_1" }, { creativeId: "cr_2" }] },
    });
    const result = await activateLaunchIntent({
      intent: many,
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      reloadIntent: async () => many,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: false, refusal: "activation_approval_asset_mismatch",
    });
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
  });

  it("runs an unattended multi-creative launch the approval DOES cover", async () => {
    /*
      The other half of the same rule, and the reason the document had to hold
      a set at all: a two-creative launch used to be unrunnable unattended
      because the approval had exactly one asset field. Naming both is now a
      thing an operator can actually do, and then the run proceeds.
    */
    providerIsAgreeable();
    const many = intent({
      activationApproval: approval({
        approvedAssets: [
          { creativeId: "cr_1", version: "v1" },
          { creativeId: "cr_2", version: "v1" },
        ],
      }),
      requestPayload: { creatives: [{ creativeId: "cr_1" }, { creativeId: "cr_2" }] },
    });
    const result = await activateLaunchIntent({
      intent: many,
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      reloadIntent: async () => many,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.activation.delivering).toBe(true);
    expect(vi.mocked(adsWrite.resumeAd)).toHaveBeenCalled();
  });

  it("refuses an unattended run whose payload changed after approval", async () => {
    const result = await activateLaunchIntent({
      intent: intent({
        activationApproval: approval(),
        requestFingerprint: "c".repeat(64),
      }),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: false, refusal: "activation_approval_payload_changed",
    });
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
  });

  it("narrows an ad-scoped approval to the ad and leaves the parents alone", async () => {
    const joined = intent({
      operation: "add_to_existing",
      activationApproval: approval({
        approvedOperation: "add_to_existing", approvedScope: "ad",
      }),
    });
    const result = await activateLaunchIntent({
      intent: joined,
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "scheduled" },
      reloadIntent: async () => joined,
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.activation.steps).toHaveLength(1);
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.resumeAdset)).not.toHaveBeenCalled();
    expect(vi.mocked(adsWrite.resumeAd)).toHaveBeenCalledTimes(1);
  });
});

describe("nothing is activated that was not created", () => {
  it("refuses an intent whose launch never succeeded", async () => {
    const result = await activateLaunchIntent({
      intent: intent({ status: "failed" }),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "operator", operatorUserId: APPROVER },
    });
    expect(result).toEqual({ ok: false, refusal: "intent_not_succeeded" });
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
  });

  it("refuses when the receipt names no entities", async () => {
    const result = await activateLaunchIntent({
      intent: intent({ resultReceipt: null }),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "operator", operatorUserId: APPROVER },
    });
    expect(result).toEqual({ ok: false, refusal: "receipt_absent" });
  });
});

describe("a mid-sequence refusal stops where it happened", () => {
  it("reports the blocked step and does not undo the completed one", async () => {
    const result = await activateLaunchIntent({
      intent: intent(),
      ctx: {} as never,
      journal: fakeJournal,
      persistReceipt: persistReceipt,
      authorization: { kind: "operator", operatorUserId: APPROVER },
      authorize: async (target) =>
        target.grain === "adset" ? "kill_switch_engaged" : null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activation.blockedAt).toBe("adset");
      expect(result.activation.delivering).toBe(false);
      expect(result.activation.steps[0]!.outcome).toBe("activated");
      expect(result.activation.steps[2]!.outcome).toBe("not_attempted");
    }
    // The campaign write stands; the ad was never attempted.
    expect(vi.mocked(adsWrite.resumeCampaign)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adsWrite.resumeAd)).not.toHaveBeenCalled();
  });
});
