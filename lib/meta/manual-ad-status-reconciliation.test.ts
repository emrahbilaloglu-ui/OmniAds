import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/ads-action-log", () => ({
  appendManualMetaAdStatusReconciliationEvent: vi.fn(),
  readManualMetaAdStatusReconciliationCandidate: vi.fn(),
}));
vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
}));

import {
  appendManualMetaAdStatusReconciliationEvent,
  readManualMetaAdStatusReconciliationCandidate,
} from "@/lib/meta/ads-action-log";
import {
  exactManualMetaAdReconciliationObservation,
  reconcileManualMetaAdStatusBlocker,
} from "@/lib/meta/manual-ad-status-reconciliation";
import { readMetaAdExecutionState } from "@/lib/meta/ads-write";

const identity = {
  businessId: "11111111-1111-4111-8111-111111111111",
  providerAccountId: "act_123",
  adId: "123456789012345",
};
const ctx = { ...identity, accessToken: "token" };

function candidate(overrides: Record<string, unknown> = {}) {
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
      candidate({
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
          candidate: candidate({ action }),
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
        candidate: candidate(),
        state: { ...state("PAUSED"), ...patch },
        expectedCreativeId: "333333333333333",
      }),
    ).toEqual({ ok: false, blocker: "provider_state_inconclusive" });
  });

  it("persists the exact observation and confirms no blocker remains", async () => {
    vi.mocked(readManualMetaAdStatusReconciliationCandidate)
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(
        candidate({
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
