import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/product-instrumentation", () => ({
  recordProductInstrumentationEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/meta/ads-action-log", () => ({
  appendManualMetaAdStatusReconciliationEvent: vi.fn(),
  readManualMetaAdStatusReconciliationCandidate: vi.fn(),
}));
vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
}));

import {
  exactManualMetaAdReconciliationObservation,
  reconcileManualMetaAdStatusBlocker,
} from "@/lib/meta/manual-ad-status-reconciliation";
import {
  appendManualMetaAdStatusReconciliationEvent,
  readManualMetaAdStatusReconciliationCandidate,
} from "@/lib/meta/ads-action-log";
import { readMetaAdExecutionState } from "@/lib/meta/ads-write";
import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";

/**
 * `guarded_action_reconciled` fires when an ambiguity is actually closed.
 *
 * An ambiguous outcome is the worst state to leave an operator in: they do not
 * know whether their pause took effect. Reconciliation is what resolves it
 * against a fresh exact read, and the event is what makes "how often do we
 * leave people uncertain, and do we get back to them" answerable.
 *
 * The failure mode this guards is emitting it on every call. A reconciliation
 * that was blocked, still settling, or unnecessary has closed nothing, and
 * counting those would show a healthy resolution rate over an unresolved queue.
 */
const CTX = { businessId: "biz-1" } as never;

const INPUT = {
  businessId: "biz-1",
  providerAccountId: "act_1",
  adId: "ad-1",
  expectedCreativeId: "cr-1",
  ctx: CTX,
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    sourceActionLogId: "log-1",
    action: "pause",
    adId: "ad-1",
    providerAccountId: "act_1",
    creativeId: "cr-1",
    campaignId: "camp-1",
    adsetId: "adset-1",
    blockerReason: null,
    readyForProviderRead: true,
    ...overrides,
  } as never;
}

/** An exact, unambiguous provider read: the only shape that can close one. */
function exactState() {
  return {
    ok: true,
    adId: "ad-1",
    providerAccountId: "act_1",
    creativeId: "cr-1",
    campaignId: "camp-1",
    adsetId: "adset-1",
    configuredStatus: "PAUSED",
    effectiveStatus: "PAUSED",
    campaignConfiguredStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    adsetConfiguredStatus: "ACTIVE",
    adsetEffectiveStatus: "ACTIVE",
    policyEligible: true,
    reviewStatus: null,
    observedAt: "2026-08-09T00:00:00.000Z",
    providerGetEvidence: { id: "ad-1", status: "PAUSED" },
  } as never;
}

function reconciledEvents() {
  return vi
    .mocked(recordProductInstrumentationEvent)
    .mock.calls.filter(
      ([event]) => event.eventName === "guarded_action_reconciled",
    );
}

describe("guarded_action_reconciled fires only on a real reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fire when there was no unresolved ambiguity to close", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate).mockResolvedValue(
      candidate({ blockerReason: "no_unresolved_manual_source" }),
    );

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("not_needed");
    expect(reconciledEvents()).toHaveLength(0);
  });

  it("does not fire while the settlement window has not elapsed", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate).mockResolvedValue(
      candidate({ blockerReason: "settlement_not_elapsed" }),
    );

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("waiting");
    // Still waiting is not resolved. Counting it would make the resolution
    // rate a measure of attempts rather than of closed ambiguities.
    expect(reconciledEvents()).toHaveLength(0);
  });

  it("does not fire when the provider state could not be read", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate).mockResolvedValue(
      candidate(),
    );
    vi.mocked(readMetaAdExecutionState).mockResolvedValue({
      ok: false,
    } as never);

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("unavailable");
    // The operator is still holding the ambiguity.
    expect(reconciledEvents()).toHaveLength(0);
  });

  it("does not fire when reading the candidate throws", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate).mockRejectedValue(
      new Error("db down"),
    );

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("unavailable");
    expect(reconciledEvents()).toHaveLength(0);
  });

  it("fires once, business-scoped, when the ambiguity is actually closed", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate)
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(
        candidate({ blockerReason: "no_unresolved_manual_source" }),
      );
    vi.mocked(readMetaAdExecutionState).mockResolvedValue(exactState());
    vi.mocked(appendManualMetaAdStatusReconciliationEvent).mockResolvedValue({
      id: "recon-1",
    } as never);

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("reconciled");

    const events = reconciledEvents();
    expect(events).toHaveLength(1);
    expect(events[0][0]).toMatchObject({
      businessId: "biz-1",
      scope: "business",
      eventName: "guarded_action_reconciled",
      surface: "meta_decision_inspector",
      outcome: "ok",
      provider: "meta",
    });
  });

  it("does not fire when a race leaves the source still unresolved", async () => {
    // The append succeeded but something else is still open against this ad.
    vi.mocked(readManualMetaAdStatusReconciliationCandidate)
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(candidate({ blockerReason: "manual_source_open" }))
      .mockResolvedValue(candidate({ blockerReason: "manual_source_open" }));
    vi.mocked(readMetaAdExecutionState).mockResolvedValue(exactState());
    vi.mocked(appendManualMetaAdStatusReconciliationEvent).mockResolvedValue({
      id: "recon-1",
    } as never);

    const result = await reconcileManualMetaAdStatusBlocker(INPUT);
    expect(result.disposition).toBe("blocked");
    expect(reconciledEvents()).toHaveLength(0);
  });

  it("awaits the write, so a lost sink is a visible failure not a silent gap", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate)
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(
        candidate({ blockerReason: "no_unresolved_manual_source" }),
      );
    vi.mocked(readMetaAdExecutionState).mockResolvedValue(exactState());
    vi.mocked(appendManualMetaAdStatusReconciliationEvent).mockResolvedValue({
      id: "recon-1",
    } as never);

    let settled = false;
    vi.mocked(recordProductInstrumentationEvent).mockImplementation(async () => {
      await Promise.resolve();
      settled = true;
      return { recorded: true } as never;
    });

    await reconcileManualMetaAdStatusBlocker(INPUT);
    // If the call were fire-and-forget, this would still be false on return.
    expect(settled).toBe(true);
  });
});

const identity = {
  businessId: "11111111-1111-4111-8111-111111111111",
  providerAccountId: "act_123",
  adId: "123456789012345",
};
const ctx = {
  ...identity,
  accessToken: "token",
  connectionGeneration: "1:connected",
};

function orchestratorCandidate(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    unresolvedSourceCount: 1,
    sourceActionLogId: "22222222-2222-4222-8222-222222222222",
    action: "pause" as const,
    creativeId: "333333333333333",
    readyForProviderRead: true,
    settlementNotBefore: "2026-07-19T00:05:00.000Z",
    authorityKind: "completed_attempt" as const,
    outcome: "provider_outcome_ambiguous" as const,
    providerAccountRefId: "33333333-3333-4333-8333-333333333333",
    campaignId: "444444444444444",
    adsetId: "555555555555555",
    blockerReason: null,
    ...overrides,
  };
}

function state(status: "ACTIVE" | "PAUSED" = "PAUSED") {
  const providerGetEvidence = {
    id: identity.adId,
    account_id: "123",
    status,
    effective_status: status,
    creative: { id: "333333333333333" },
    campaign: {
      id: "444444444444444",
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
    adset: {
      id: "555555555555555",
      status: "ACTIVE",
      effective_status: "ACTIVE",
    },
  };
  return {
    ok: true as const,
    adId: identity.adId,
    providerAccountId: identity.providerAccountId,
    creativeId: "333333333333333",
    campaignId: "444444444444444",
    campaignConfiguredStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    adsetId: "555555555555555",
    adsetConfiguredStatus: "ACTIVE",
    adsetEffectiveStatus: "ACTIVE",
    configuredStatus: status,
    effectiveStatus: status,
    policyEligible: true,
    reviewStatus: null,
    observedAt: "2026-07-19T00:06:00.000Z",
    providerGetEvidence,
  };
}

describe("manual Meta status reconciliation orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not read the provider before the settlement floor", async () => {
    vi.mocked(
      readManualMetaAdStatusReconciliationCandidate,
    ).mockResolvedValue(
      orchestratorCandidate({
        readyForProviderRead: false,
        blockerReason: "settlement_not_elapsed",
      }),
    );

    await expect(
      reconcileManualMetaAdStatusBlocker({
        ...identity,
        expectedCreativeId: "333333333333333",
        ctx,
      }),
    ).resolves.toMatchObject({ disposition: "waiting" });
    expect(readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(
      appendManualMetaAdStatusReconciliationEvent,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["pause applied", "pause", "PAUSED", "current_state_matches_requested"],
    ["pause precondition", "pause", "ACTIVE", "current_state_matches_precondition"],
    ["resume applied", "resume", "ACTIVE", "current_state_matches_requested"],
    ["resume precondition", "resume", "PAUSED", "current_state_matches_precondition"],
  ] as const)(
    "accepts the exact %s geometry",
    (_label, action, status, resolution) => {
      expect(
        exactManualMetaAdReconciliationObservation({
          candidate: orchestratorCandidate({ action }),
          state: state(status),
          expectedCreativeId: "333333333333333",
        }),
      ).toMatchObject({ ok: true, resolution });
    },
  );

  it.each([
    {
      label: "mixed Ad state",
      patch: { effectiveStatus: "ACTIVE" },
    },
    {
      label: "inactive campaign",
      patch: { campaignEffectiveStatus: "PAUSED" },
    },
    {
      label: "wrong creative",
      patch: { creativeId: "999999999999999" },
    },
    {
      label: "missing provider evidence",
      patch: { providerGetEvidence: undefined },
    },
  ])("fails closed for $label", ({ patch }) => {
    expect(
      exactManualMetaAdReconciliationObservation({
        candidate: orchestratorCandidate(),
        state: { ...state("PAUSED"), ...patch },
        expectedCreativeId: "333333333333333",
      }),
    ).toEqual({ ok: false, blocker: "provider_state_inconclusive" });
  });

  it("persists the exact observation and confirms no blocker remains", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate)
      .mockResolvedValueOnce(orchestratorCandidate())
      .mockResolvedValueOnce(
        orchestratorCandidate({
          unresolvedSourceCount: 0,
          sourceActionLogId: null,
          action: null,
          creativeId: null,
          readyForProviderRead: false,
          settlementNotBefore: null,
          authorityKind: null,
          outcome: null,
          providerAccountRefId: null,
          campaignId: null,
          adsetId: null,
          blockerReason: "no_unresolved_manual_source",
        }),
      );
    vi.mocked(readMetaAdExecutionState).mockResolvedValue(state("PAUSED"));
    vi.mocked(
      appendManualMetaAdStatusReconciliationEvent,
    ).mockResolvedValue({ id: "event-1" } as never);

    const result = await reconcileManualMetaAdStatusBlocker({
      ...identity,
      expectedCreativeId: "333333333333333",
      ctx,
    });

    expect(result).toMatchObject({
      disposition: "reconciled",
      resolution: "current_state_matches_requested",
      event: { id: "event-1" },
    });
    expect(
      appendManualMetaAdStatusReconciliationEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "22222222-2222-4222-8222-222222222222",
        resolution: "current_state_matches_requested",
        providerGetEvidence: state("PAUSED").providerGetEvidence,
      }),
    );
  });
});
