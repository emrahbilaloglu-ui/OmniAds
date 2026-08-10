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

import { reconcileManualMetaAdStatusBlocker } from "@/lib/meta/manual-ad-status-reconciliation";
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
