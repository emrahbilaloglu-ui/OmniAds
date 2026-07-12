import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({ query })),
}));

vi.mock("@/lib/meta/creative-brief-store", () => ({
  readMetaCreativeBrief: vi.fn(),
}));

const briefStore = await import("@/lib/meta/creative-brief-store");
const contract = await import("@/lib/meta/creative-brief-contract");
const {
  MetaLaunchIntentLineageError,
  verifyMetaLaunchIntentLineage,
} = await import("@/lib/launchpad/meta-launch-intent-lineage");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "018f3f55-630d-7f9f-8c19-bbd7d45db001";
const BRIEF_ID = "018f3f55-630d-7f9f-8c19-bbd7d45db002";
const DRAFT_ID = "018f3f55-630d-7f9f-8c19-bbd7d45db003";

describe("Meta LaunchIntent lineage verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([]);
  });

  it("does not invent lineage when no source is supplied", async () => {
    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
      }),
    ).resolves.toEqual({
      sourceDecisionId: null,
      sourceDecisionSnapshotId: null,
      creativeBriefId: null,
      sourceDraftId: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("inherits verified decision lineage from an account-scoped Creative Brief", async () => {
    vi.mocked(briefStore.readMetaCreativeBrief).mockResolvedValue({
      id: BRIEF_ID,
      status: "reviewed",
      sourceDecision: {
        decisionId: "mdd_verified",
        snapshotId: SNAPSHOT_ID,
      },
    } as never);

    const result = await verifyMetaLaunchIntentLineage({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      creativeBriefId: BRIEF_ID,
    });

    expect(result).toMatchObject({
      creativeBriefId: BRIEF_ID,
      sourceDecisionId: "mdd_verified",
      sourceDecisionSnapshotId: SNAPSHOT_ID,
    });
    expect(briefStore.readMetaCreativeBrief).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      id: BRIEF_ID,
    });
  });

  it("rejects a draft Creative Brief as launch lineage", async () => {
    vi.mocked(briefStore.readMetaCreativeBrief).mockResolvedValue({
      id: BRIEF_ID,
      status: "draft",
      sourceDecision: {
        decisionId: "mdd_verified",
        snapshotId: SNAPSHOT_ID,
      },
    } as never);

    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        creativeBriefId: BRIEF_ID,
      }),
    ).rejects.toMatchObject({ code: "creative_brief_not_reviewed" });
  });

  it("accepts a source draft only inside the selected Meta account", async () => {
    query.mockResolvedValueOnce([{ id: DRAFT_ID }]);

    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        sourceDraftId: DRAFT_ID,
      }),
    ).resolves.toMatchObject({ sourceDraftId: DRAFT_ID });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("provider_account_id = $2"),
      [BUSINESS_ID, "act_123", DRAFT_ID],
    );
  });

  it("rejects a source draft that is absent from the selected Meta account", async () => {
    query.mockResolvedValueOnce([]);

    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_other",
        sourceDraftId: DRAFT_ID,
      }),
    ).rejects.toMatchObject({ code: "source_draft_not_found" });
  });

  it("requires a snapshot when a decision is linked without a brief", async () => {
    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        sourceDecisionId: "mdd_unverified",
      }),
    ).rejects.toMatchObject({
      name: "MetaLaunchIntentLineageError",
      code: "source_decision_snapshot_required",
    });
  });

  it("proves a direct decision against an account-scoped snapshot", async () => {
    const source = {
      snapshot_id: SNAPSHOT_ID,
      creative_id: "creative_1",
      scope_type: "account",
      scope_id: "*",
    };
    query.mockResolvedValueOnce([source]);
    const decisionId = contract.buildMetaCreativeDecisionId({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      creativeId: source.creative_id,
      scopeType: source.scope_type,
      scopeId: source.scope_id,
    });

    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        sourceDecisionId: decisionId,
        sourceDecisionSnapshotId: SNAPSHOT_ID,
      }),
    ).resolves.toMatchObject({
      sourceDecisionId: decisionId,
      sourceDecisionSnapshotId: SNAPSHOT_ID,
    });
    expect(String(query.mock.calls[0]?.[0] ?? "")).toContain(
      "provider_account_id = $2",
    );
  });

  it("rejects a decision id that does not match the verified snapshot", async () => {
    query.mockResolvedValueOnce([
      {
        snapshot_id: SNAPSHOT_ID,
        creative_id: "creative_1",
        scope_type: "account",
        scope_id: "*",
      },
    ]);

    await expect(
      verifyMetaLaunchIntentLineage({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        sourceDecisionId: "mdd_wrong",
        sourceDecisionSnapshotId: SNAPSHOT_ID,
      }),
    ).rejects.toBeInstanceOf(MetaLaunchIntentLineageError);
  });
});
