/**
 * Finding 6, reproduced and then fixed: activation left no durable trace.
 *
 * The activation path drove the resume primitives directly. Nothing claimed a
 * row before a POST, nothing terminalised one after, and the step list existed
 * only in the HTTP response — so a campaign that came ACTIVE under an ad set
 * that failed was, on reload, indistinguishable from an intent nobody had ever
 * touched. Worse, an ambiguous outcome looked exactly like a clean failure,
 * which is precisely the state in which sending the write again is the second
 * of two writes on somebody's live campaign.
 *
 * These are the four sequences the review named. Each drives the real
 * `activateLaunchIntent` against a provider test double and a journal double,
 * and asserts on what the journal was actually told — not on the response.
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
  LAUNCH_ACTIVATION_RECEIPT_CONTRACT,
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

/** Every row the journal was asked to write, in the order it was asked. */
interface JournalRow {
  entityId: string;
  grain: string;
  priorStatus: string | null;
  settledAs: string | null;
  settledReason: string | null;
}
let rows: JournalRow[] = [];
let unresolved: Map<string, string>;
/** Every entity a POST actually reached, in order. */
let posted: string[] = [];

function journalDouble(overrides: Partial<ActivationJournal> = {}): ActivationJournal {
  return {
    findUnresolved: async (input) => {
      const id = unresolved.get(input.entityId);
      return id ? { id } : null;
    },
    claim: async (input) => {
      rows.push({
        entityId: input.entityId,
        grain: input.grain,
        priorStatus: input.observed.status,
        settledAs: null,
        settledReason: null,
      });
      return { id: `log_${input.entityId}` };
    },
    settle: async (input) => {
      const row = rows.find((entry) => `log_${entry.entityId}` === input.id);
      if (!row) throw new Error(`settled a row that was never claimed: ${input.id}`);
      if (row.settledAs) throw new Error(`settled twice: ${input.id}`);
      row.settledAs = input.outcome;
      row.settledReason = input.reason;
    },
    ...overrides,
  };
}

const stored: LaunchActivationReceipt[] = [];

async function activate(
  journal = journalDouble(),
  authorize?: (target: { grain: string; entityId: string }) => Promise<string | null>,
) {
  return activateLaunchIntent({
    intent: intent(),
    ctx: {} as never,
    authorization: { kind: "operator", operatorUserId: OPERATOR },
    journal,
    ...(authorize ? { authorize: authorize as never } : {}),
    persistReceipt: async (receipt) => { stored.push(receipt); },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  posted = [];
  stored.length = 0;
  unresolved = new Map();
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
  /*
    The default double turns the entity on, running the pre-POST hook first.

    The real primitives run `beforeMutationAttempt` after every adapter-side
    check and immediately before the single POST, and a throw there returns a
    named failure having built no request. Modelling that here is what lets a
    case below assert that a refusal at the boundary leaves the entity
    RETRYABLE — the cases that pass no gate are unaffected, since the hook is
    then undefined and this is the same double it always was.
  */
  const turnOn = async (
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
    provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
    return { ok: true };
  };
  vi.mocked(adsWrite.resumeCampaign).mockImplementation(turnOn as never);
  vi.mocked(adsWrite.resumeAdset).mockImplementation(turnOn as never);
  vi.mocked(adsWrite.resumeAd).mockImplementation(turnOn as never);
});

describe("campaign succeeds, ad set fails", () => {
  it("journals both steps and never claims the one it did not attempt", async () => {
    vi.mocked(adsWrite.resumeAdset).mockImplementation((async () => ({
      ok: false,
      error: { code: "invalid_parameter", message: "no" },
      providerOutcome: "definite_failure",
    })) as never);

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("adset");
    expect(result.activation.delivering).toBe(false);

    /*
      Two rows, not three.

      The ad was never attempted, so claiming a row for it would put a record
      of a provider call that did not happen next to two that did.
    */
    expect(rows).toEqual([
      {
        entityId: "camp_1", grain: "campaign",
        // Written BEFORE the POST. It is the only thing a compensating action
        // could ever be built from once the provider has moved on.
        priorStatus: "PAUSED",
        settledAs: "activated", settledReason: null,
      },
      {
        entityId: "set_1", grain: "adset", priorStatus: "PAUSED",
        settledAs: "refused", settledReason: "invalid_parameter",
      },
    ]);

    // And the whole sequence survives the response.
    expect(stored).toHaveLength(1);
    expect(stored[0]!.contract).toBe(LAUNCH_ACTIVATION_RECEIPT_CONTRACT);
    expect(stored[0]!.blockedAt).toBe("adset");
    expect(stored[0]!.steps.map((step) => [step.entityId, step.outcome, step.actionLogId]))
      .toEqual([
        ["camp_1", "activated", "log_camp_1"],
        ["set_1", "blocked", "log_set_1"],
        // Never attempted, so it names no durable row rather than a fake one.
        ["ad_1", "not_attempted", null],
      ]);
  });
});

describe("a timeout after the provider may have succeeded", () => {
  it("records the step as ambiguous rather than as a failure", async () => {
    vi.mocked(adsWrite.resumeAdset).mockImplementation((async () => ({
      ok: false,
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
      providerOutcome: "outcome_ambiguous",
    })) as never);

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.steps[1]!.outcome).toBe("ambiguous");
    /*
      `silent_failure` is what the action log calls "nobody knows", and it is
      exactly the state `findUnresolvedMetaAdStatusActionLog` looks for. This
      row is what makes the next attempt refuse instead of re-POSTing.
    */
    expect(rows[1]).toMatchObject({
      entityId: "set_1", settledAs: "ambiguous",
      settledReason: "provider_outcome_ambiguous",
    });
    expect(stored[0]!.steps[1]!.claimOutcome).toBe("ambiguous");
  });

  it("refuses the next attempt on that entity and sends no second POST", async () => {
    // The state the previous test left behind: a row nobody has resolved.
    unresolved.set("set_1", "log_prior_set_1");

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("adset");
    expect(result.activation.blockedReason).toBe("unresolved_prior_attempt");
    // THE POINT: no provider call was made for the ad set at all.
    expect(vi.mocked(adsWrite.resumeAdset)).not.toHaveBeenCalled();
    // And no new claim was written for it — only the campaign's.
    expect(rows.map((row) => row.entityId)).toEqual(["camp_1"]);
    expect(stored[0]!.steps[1]).toMatchObject({
      entityId: "set_1",
      claimOutcome: "unresolved_prior_attempt",
      // It names the row a person has to resolve, rather than a new one.
      actionLogId: "log_prior_set_1",
    });
  });

  it("blocks a retry after an unreadable verification too", async () => {
    /*
      The write was accepted and then nobody could confirm what it did. That is
      not a definite failure, and treating it as one would let the next attempt
      POST on the strength of a state no one has seen.
    */
    vi.mocked(adsWrite.readMetaEntityExecutionState).mockImplementation((async (
      _ctx: unknown, scopeType: string, entityId: string,
    ) => {
      const state = provider.get(entityId)!;
      if (entityId === "set_1" && state.status === "ACTIVE") {
        return { ok: false, error: { code: "read_failed" } };
      }
      return {
        ok: true, scopeType, entityId,
        configuredStatus: state.status, effectiveStatus: state.effective,
      };
    }) as never);

    const result = await activate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedReason).toBe("verification_unreadable");
    expect(rows[1]).toMatchObject({ entityId: "set_1", settledAs: "ambiguous" });
  });
});

describe("a write the provider accepted that read back PAUSED", () => {
  it("records the step as refused, not activated, and stays retryable", async () => {
    // The adapter says the call worked; the independent read-back disagrees.
    vi.mocked(adsWrite.resumeAdset).mockImplementation((async () => ({
      ok: true,
    })) as never);

    const first = await activate();

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.activation.blockedReason).toBe("verified_not_active");
    /*
      The provider call succeeded and the step did not. The durable row follows
      the STEP: writing `activated` here would put an activation in History
      that provably did not happen.
    */
    expect(rows[1]).toMatchObject({
      entityId: "set_1", settledAs: "refused", settledReason: "verified_not_active",
    });

    // A definite non-activation is safe to attempt again — unlike an ambiguous
    // one — so nothing has been left in the unresolved state.
    expect(unresolved.size).toBe(0);

    rows = [];
    stored.length = 0;
    vi.mocked(adsWrite.resumeAdset).mockClear();
    // Second attempt, provider now behaving: the campaign is already ACTIVE so
    // it is read and skipped, and only the ad set is re-sent.
    vi.mocked(adsWrite.resumeAdset).mockImplementation((async (
      _ctx: unknown, id: string,
    ) => {
      provider.set(id, { status: "ACTIVE", effective: "ACTIVE" });
      return { ok: true };
    }) as never);

    const second = await activate();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.activation.delivering).toBe(true);
    expect(vi.mocked(adsWrite.resumeCampaign)).toHaveBeenCalledTimes(1);
    // The retry claimed the ad set and the ad. The campaign was already on, so
    // it cost one read and no row.
    expect(rows.map((row) => row.entityId)).toEqual(["set_1", "ad_1"]);
    expect(second.activation.steps[0]!.outcome).toBe("already_active");
  });
});

describe("a claim that cannot be written", () => {
  it("makes no provider call at all", async () => {
    const result = await activate(journalDouble({
      claim: async () => { throw new Error("db down"); },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.blockedAt).toBe("campaign");
    /*
      No row means nothing could later say a call may be in flight. Making the
      call anyway would enter exactly the state this whole path exists to keep
      out of the system.
    */
    expect(vi.mocked(adsWrite.resumeCampaign)).not.toHaveBeenCalled();
    expect(stored[0]!.steps[0]!.claimOutcome).toBe("claim_unavailable");
  });
});

/**
 * A gate that refused INSIDE the primitive, after the claim was written.
 *
 * The claim is written before the write is handed over, so a refusal at the
 * provider boundary leaves a row behind. That row must be settled and must be
 * settled as a definite non-write: `pending` would say a call may be in flight,
 * and `silent_failure` would say the outcome is unknown — both would arm the
 * no-blind-retry gate against an entity nothing has ever written to, and the
 * operator's next attempt would be refused for a call that was never made.
 */
describe("an authority refused at the provider boundary", () => {
  it("settles the claim as a definite non-write and leaves the entity retryable", async () => {
    /*
      The gate is asked twice per step: once by the sequence, before the claim,
      and once by the primitive's own pre-POST hook. This one answers yes the
      first time and no the second — the STOP engaged in between — which is the
      only way to reach the boundary refusal at all, since a gate that already
      said no would have stopped the step before any row was written.
    */
    let stopped = true;
    const asked = new Map<string, number>();
    const gate = async (target: { entityId: string }) => {
      const seen = (asked.get(target.entityId) ?? 0) + 1;
      asked.set(target.entityId, seen);
      return stopped && seen > 1 ? "kill_switch_engaged" : null;
    };

    const first = await activate(journalDouble(), gate);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(posted).toEqual([]);
    expect(first.activation.blockedAt).toBe("campaign");
    expect(first.activation.blockedReason).toBe("kill_switch_engaged");
    /*
      Claimed, then terminalised. The row exists — the boundary was reached —
      and it says plainly that nothing was sent.
    */
    expect(rows.map((row) => [row.entityId, row.settledAs, row.settledReason]))
      .toEqual([["camp_1", "authority_refused", "kill_switch_engaged"]]);
    expect(first.activation.steps.map((step) => step.outcome)).toEqual([
      "blocked", "not_attempted", "not_attempted",
    ]);

    // The operator releases the STOP and runs it again. Nothing about the
    // refused row may stand in the way, because no write ever happened.
    stopped = false;
    rows = [];
    asked.clear();
    const second = await activate(journalDouble(), gate);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(posted).toEqual(["camp_1", "set_1", "ad_1"]);
    expect(second.activation.delivering).toBe(true);
    expect(rows.map((row) => row.settledAs)).toEqual([
      "activated", "activated", "activated",
    ]);
  });

  it("does not mistake an ambiguous provider outcome for a refused authority", async () => {
    /*
      The two both halt the run and they are not the same fact. An ambiguous
      write may have landed and must block its own retry; a refused authority
      definitely did not and must not.
    */
    vi.mocked(adsWrite.resumeCampaign).mockImplementation((async () => ({
      ok: false,
      providerOutcome: "outcome_ambiguous",
      error: { code: "provider_outcome_ambiguous", message: "timeout" },
    })) as never);

    const result = await activate(journalDouble(), async () => null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activation.steps[0]!.outcome).toBe("ambiguous");
    expect(rows.map((row) => [row.entityId, row.settledAs])).toEqual([
      ["camp_1", "ambiguous"],
    ]);
  });
});
