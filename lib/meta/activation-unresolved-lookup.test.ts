/**
 * The no-blind-retry gate, when its own lookup cannot be read.
 *
 * `providerDeps.activate` asks `journal.findUnresolved` whether an earlier
 * pause or resume on this entity is still `pending` or `silent_failure` — the
 * two states in which the provider's answer is unknown and the write may
 * already have landed. The production implementation is
 * `findUnresolvedMetaAdStatusActionLog`, a single query against
 * `meta_ads_action_log` that swallows nothing, so a statement timeout or a
 * dead pool arrives at the caller as a rejection.
 *
 * That rejection used to be folded into `null`, which is the same value the
 * lookup returns when it has read the table and found nothing outstanding. The
 * failed safety check therefore read as a clean bill of health and the POST
 * went out — the exact blind retry the gate exists to prevent, on the path that
 * ends a paused state and starts spend.
 *
 * These cases drive the real `activateLaunchIntent` against a provider double
 * and a journal double whose lookup throws, and assert on what reached the
 * provider rather than on the response text.
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
  activateLaunchIntent,
  type ActivationJournal,
  type LaunchActivationReceipt,
} from "@/lib/meta/launch-intent-activation";

const OPERATOR = "22222222-2222-4222-8222-222222222222";
const BUSINESS = "44444444-4444-4444-8444-444444444444";

function intent(): MetaLaunchIntent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    businessId: BUSINESS,
    providerAccountId: "act_9",
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
      providerAccountId: "act_9",
      campaignId: "camp_1",
      adsetIds: ["set_1"],
      adIds: ["ad_1"],
      steps: [],
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
  };
}

/** Whatever the double says each entity's two statuses are right now. */
const provider = new Map<string, { status: string; effective: string }>();
/** Every entity a claim row was written for, in order. */
let claimed: string[] = [];
/** Every entity a POST actually reached, in order. */
let posted: string[] = [];
const stored: LaunchActivationReceipt[] = [];

function journalDouble(overrides: Partial<ActivationJournal> = {}): ActivationJournal {
  return {
    findUnresolved: async () => null,
    claim: async (input) => {
      claimed.push(input.entityId);
      return { id: `log_${input.entityId}` };
    },
    settle: async () => undefined,
    ...overrides,
  };
}

function activate(journal: ActivationJournal) {
  return activateLaunchIntent({
    intent: intent(),
    ctx: {} as never,
    authorization: { kind: "operator", operatorUserId: OPERATOR },
    journal,
    persistReceipt: async (receipt) => { stored.push(receipt); },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claimed = [];
  posted = [];
  stored.length = 0;
  provider.clear();
  for (const id of ["camp_1", "set_1", "ad_1"]) {
    provider.set(id, { status: "PAUSED", effective: "PAUSED" });
  }
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
  const turnOn = async (_ctx: unknown, id: string) => {
    posted.push(id);
    provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
    return { ok: true };
  };
  vi.mocked(adsWrite.resumeCampaign).mockImplementation(turnOn as never);
  vi.mocked(adsWrite.resumeAdset).mockImplementation(turnOn as never);
  vi.mocked(adsWrite.resumeAd).mockImplementation(turnOn as never);
});

describe("the unresolved-attempt lookup cannot be read", () => {
  it.each(["unresolved_prior_attempt", "activation_already_consumed"] as const)(
    "sends no POST and never settles the winner when the atomic claim reports %s",
    async (blocked) => {
      const settle = vi.fn(async () => undefined);
      const result = await activate(journalDouble({
        findUnresolved: async () => null,
        claim: async () => ({ id: "winning-log", blocked }),
        settle,
      }));
      expect(posted).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
      expect(stored).toHaveLength(0);
      expect(result).toMatchObject({ ok: true, receipt: { blockedReason: blocked,
        steps: [expect.objectContaining({ actionLogId: "winning-log", claimOutcome: blocked }),
          expect.anything(), expect.anything()] } });
    },
  );

  it.each(["unresolved_prior_attempt", "activation_already_consumed"] as const)(
    "does not overwrite a completed winner's receipt when a %s contender finishes last",
    async (blocked) => {
      let releaseLoser!: () => void;
      let bothAtClaim!: () => void;
      const loserMayFinish = new Promise<void>((resolve) => { releaseLoser = resolve; });
      const bothArrived = new Promise<void>((resolve) => { bothAtClaim = resolve; });
      let campaignClaims = 0;
      const journal = journalDouble({
        claim: async (input) => {
          if (input.entityId !== "camp_1") return { id: `log_${input.entityId}` };
          campaignClaims += 1;
          if (campaignClaims === 1) {
            await bothArrived;
            return { id: "winner-campaign-log" };
          }
          bothAtClaim();
          await loserMayFinish;
          return { id: "winner-campaign-log", blocked };
        },
      });
      const winner = activate(journal);
      const loser = activate(journal);
      await winner;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.delivering).toBe(true);
      releaseLoser();
      const result = await loser;
      expect(result).toMatchObject({ ok: true, receipt: { blockedReason: blocked } });
      expect(posted).toEqual(["camp_1", "set_1", "ad_1"]);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.delivering).toBe(true);
    },
  );

  it("sends no provider mutation and writes no claim", async () => {
    const result = await activate(journalDouble({
      // What a pool at its query ceiling does to this read. The production
      // lookup runs one query and catches nothing, so it surfaces as a throw.
      findUnresolved: async () => { throw new Error("statement timeout"); },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /*
      THE POINT.

      An entity whose prior-attempt history could not be read may already carry
      a `pending` or `silent_failure` row for this exact status change. Sending
      the POST would be the second of two writes on a live campaign, decided by
      a check that never ran.
    */
    expect(posted).toEqual([]);
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
    // And no claim either: the gate refuses before the row is written, so
    // there is nothing to terminalise and nothing to reconcile later.
    expect(claimed).toEqual([]);
  });

  it("names the unreadable lookup rather than a provider refusal", async () => {
    const result = await activate(journalDouble({
      findUnresolved: async () => { throw new Error("statement timeout"); },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("campaign");
    expect(result.activation.blockedReason)
      .toBe("activation_unresolved_lookup_unavailable");
    expect(result.activation.delivering).toBe(false);
    /*
      The durable receipt has to say which of the two it was.

      `refused` would claim a provider was asked and declined — evidence the
      entity was reachable and definitely not activated. Nobody asked anything.
    */
    expect(stored).toHaveLength(1);
    expect(stored[0]!.steps[0]).toMatchObject({
      grain: "campaign",
      entityId: "camp_1",
      outcome: "blocked",
      actionLogId: null,
      claimOutcome: "unresolved_lookup_unavailable",
    });
  });

  it("still activates normally once the lookup can be read again", async () => {
    // The same run with a readable journal: the refusal is about the failed
    // read alone, and nothing about it is sticky.
    const result = await activate(journalDouble());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.delivering).toBe(true);
    expect(posted).toEqual(["camp_1", "set_1", "ad_1"]);
    expect(claimed).toEqual(["camp_1", "set_1", "ad_1"]);
  });
});
