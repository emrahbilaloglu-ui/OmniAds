import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  createMetaLaunchIntent: vi.fn(),
  getMetaLaunchIntent: vi.fn(),
}));

const store = await import("@/lib/launchpad/meta-launch-intent-store");
const { prepareMetaLaunchIntentForExecution } = await import(
  "@/lib/launchpad/meta-launch-intent-service"
);
const { metaLaunchIntentRequestFingerprint } = await import(
  "@/lib/launchpad/meta-launch-intent"
);

const base = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  operation: "new_campaign" as const,
  idempotencyKey: "idem_1",
  requestPayload: { campaign: { name: "Launch" } },
};

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent_1",
    ...base,
    requestedStatus: "PAUSED",
    requestFingerprint: metaLaunchIntentRequestFingerprint(base),
    lineage: {
      sourceDecisionId: null,
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    },
    status: "prepared",
    ...overrides,
  };
}

describe("prepareMetaLaunchIntentForExecution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one immutable execution attempt when no id is supplied", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: true,
      intent: intent(),
    } as never);

    const result = await prepareMetaLaunchIntentForExecution(base);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(store.createMetaLaunchIntent).toHaveBeenCalledWith(base);
  });

  it("accepts a prepared intent only when account, operation, key, and payload match", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue(intent() as never);

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      launchIntentId: "intent_1",
    });

    expect(result).toMatchObject({ ok: true, created: false });
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });

  it("rejects a consumed intent instead of presenting an automatic retry", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue(
      intent({ status: "failed" }) as never,
    );

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      launchIntentId: "intent_1",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "launch_intent_already_consumed" },
    });
  });

  it("forbids a fresh-key or replay attempt while provider outcome is ambiguous", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue(
      intent({
        status: "silent_failure",
        errorReceipt: {
          code: "provider_outcome_ambiguous",
          partialResult: {
            campaignId: null,
            adsetIds: [],
            adIds: [],
            steps: [
              {
                providerOutcome: "outcome_ambiguous",
                retryAllowed: false,
              },
            ],
          },
        },
      }) as never,
    );

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      launchIntentId: "intent_1",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "launch_intent_provider_outcome_ambiguous",
        message: expect.stringContaining("do not create a new intent"),
      },
    });
    expect(result.ok || result.error.message).toContain(
      "Reconcile the exact Meta state",
    );
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });

  it("rejects account or payload drift against a prepared intent", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue(
      intent({ providerAccountId: "act_456" }) as never,
    );

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      launchIntentId: "intent_1",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "launch_intent_contract_mismatch" },
    });
  });

  it("rejects supplied lineage that differs from the immutable intent", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue(intent() as never);

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      launchIntentId: "intent_1",
      creativeBriefId: "brief_other",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "launch_intent_contract_mismatch" },
    });
  });

  it("does not consume an existing idempotency tuple as a new attempt", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: false,
      intent: intent({ status: "succeeded" }),
    } as never);

    const result = await prepareMetaLaunchIntentForExecution(base);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "launch_intent_already_exists" },
    });
  });

  it("does not suggest a new intent when an existing idempotency tuple is ambiguous", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: false,
      intent: intent({
        status: "silent_failure",
        errorReceipt: {
          code: "provider_outcome_ambiguous",
          partialResult: {
            campaignId: null,
            adsetIds: [],
            adIds: [],
            steps: [],
          },
        },
      }),
    } as never);

    const result = await prepareMetaLaunchIntentForExecution(base);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "launch_intent_provider_outcome_ambiguous",
        message: expect.stringContaining("do not create a new intent"),
      },
    });
  });

  it("blocks a different idempotency key for the same unresolved semantic request", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockRejectedValue(
      Object.assign(
        new Error(
          "Reconcile the exact Meta state before another provider mutation.",
        ),
        {
          code: "launch_intent_provider_outcome_ambiguous",
          intent: intent({
            id: "intent_ambiguous",
            idempotencyKey: "old-key",
            status: "silent_failure",
          }),
        },
      ),
    );

    const result = await prepareMetaLaunchIntentForExecution({
      ...base,
      idempotencyKey: "fresh-key",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "launch_intent_provider_outcome_ambiguous" },
      intent: { id: "intent_ambiguous" },
    });
    expect(store.createMetaLaunchIntent).toHaveBeenCalledTimes(1);
  });
});
