import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { META_LAUNCHPAD_MANUAL_AUTHORITY } from "@/lib/launchpad/meta-manual-authority";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn((code: string) =>
    code === "provider_account_not_assigned" ? 403 : 400,
  ),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  createMetaLaunchIntent: vi.fn(),
  listMetaLaunchIntents: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-launch-intent-capability", () => ({
  getMetaLaunchIntentCapability: vi.fn(),
}));

const access = await import("@/lib/access");
const validation = await import("@/lib/launchpad/meta-validation");
const store = await import("@/lib/launchpad/meta-launch-intent-store");
const capability = await import("@/lib/launchpad/meta-launch-intent-capability");
const { GET, POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function creativeIds(count: number) {
  return Array.from({ length: count }, (_, index) => `creative_${index + 1}`);
}

function post(body: unknown) {
  const authorizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...META_LAUNCHPAD_MANUAL_AUTHORITY, ...body }
      : body;
  return new NextRequest("http://localhost/api/launchpad/meta/intents", {
    method: "POST",
    body: JSON.stringify(authorizedBody),
    headers: { "content-type": "application/json" },
  });
}

describe("/api/launchpad/meta/intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: "act_123",
    });
    vi.mocked(capability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "ready",
      canRead: true,
      canWrite: true,
      missingTables: [],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });
  });

  it("lists only the requested assigned provider account", async () => {
    vi.mocked(store.listMetaLaunchIntents).mockResolvedValue([
      { id: "intent_1", providerAccountId: "act_123" },
    ] as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/intents?businessId=${BUSINESS_ID}&providerAccountId=act_123`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providerAccountId).toBe("act_123");
    expect(store.listMetaLaunchIntents).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      limit: 25,
    });
  });

  it("creates an immutable PAUSED intent bound to manual authority", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: true,
      intent: {
        id: "intent_1",
        requestedStatus: "PAUSED",
        providerAccountId: "act_123",
      },
    } as never);

    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "idem_1",
        payload: {
          campaign: { name: "Launch", objective: "OUTCOME_SALES" },
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.intent.requestedStatus).toBe("PAUSED");
    expect(store.createMetaLaunchIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "idem_1",
        requestPayload: expect.objectContaining({
          executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        }),
        createdBy: USER_ID,
      }),
    );
  });

  it("accepts a normalized new-campaign intent at the exact provider-create boundary", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: true,
      intent: {
        id: "intent_new_boundary",
        requestedStatus: "PAUSED",
        providerAccountId: "act_123",
      },
    } as never);

    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "idem_new_boundary",
        payload: {
          creativeIds: creativeIds(18),
          adSets: [{ clientId: "adset_1" }],
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(store.createMetaLaunchIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "new_campaign",
        requestPayload: expect.objectContaining({
          creativeIds: creativeIds(18),
          adSets: [expect.objectContaining({ clientId: "adset_1" })],
        }),
      }),
    );
  });

  it("rejects an over-bound normalized new-campaign intent before persistence", async () => {
    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "idem_new_over_bound",
        payload: {
          creativeIds: creativeIds(19),
          adSets: [{ clientId: "adset_1" }],
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error.code).toBe(
      "launchpad_provider_create_limit_exceeded",
    );
    expect(body.counts).toEqual({
      creatives: 19,
      adSetsOrTargets: 1,
      plannedProviderCreates: 21,
    });
    expect(capability.getMetaLaunchIntentCapability).not.toHaveBeenCalled();
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });

  it("accepts a normalized add-to-existing intent at the exact provider-create boundary", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: true,
      intent: {
        id: "intent_add_boundary",
        requestedStatus: "PAUSED",
        providerAccountId: "act_123",
      },
    } as never);

    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "add_to_existing",
        idempotencyKey: "idem_add_boundary",
        payload: {
          copyMode: "reuse_creative",
          creativeIds: creativeIds(20),
          targets: [
            {
              targetCampaignId: "campaign_1",
              targetAdsetId: "adset_1",
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(store.createMetaLaunchIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "add_to_existing",
        requestPayload: expect.objectContaining({
          copyMode: "reuse_creative",
          creativeIds: creativeIds(20),
          targets: [
            expect.objectContaining({
              targetCampaignId: "campaign_1",
              targetAdsetId: "adset_1",
            }),
          ],
        }),
      }),
    );
  });

  it("uses normalized copy mode and rejects an over-bound add-to-existing intent before persistence", async () => {
    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "add_to_existing",
        idempotencyKey: "idem_add_over_bound",
        payload: {
          creativeIds: creativeIds(11),
          targets: [
            {
              targetCampaignId: "campaign_1",
              targetAdsetId: "adset_1",
            },
          ],
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error.code).toBe(
      "launchpad_provider_create_limit_exceeded",
    );
    expect(body.counts).toEqual({
      creatives: 11,
      adSetsOrTargets: 1,
      plannedProviderCreates: 22,
    });
    expect(capability.getMetaLaunchIntentCapability).not.toHaveBeenCalled();
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });

  it("reports the pending LaunchIntent migration without claiming an empty ledger", async () => {
    vi.mocked(capability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingTables: ["meta_launch_intents"],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/intents?businessId=${BUSINESS_ID}&providerAccountId=act_123`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capability: { status: "migration_required", canRead: false },
      intents: [],
    });
    expect(store.listMetaLaunchIntents).not.toHaveBeenCalled();
  });

  it("returns the persisted receipt on duplicate without executing it", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockResolvedValue({
      created: false,
      intent: { id: "intent_1", status: "failed" },
    } as never);

    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "add_to_existing",
        idempotencyKey: "idem_1",
        payload: { mode: "add_to_existing" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("launch_intent_already_exists");
    expect(body.error.message).toContain("not be retried automatically");
  });

  it("fails closed before persistence when provider account is not assigned", async () => {
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: false,
      blocker: {
        code: "provider_account_not_assigned",
        message: "providerAccountId is not assigned to this business.",
      },
    });

    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_other",
        operation: "new_campaign",
        idempotencyKey: "idem_1",
        payload: {},
      }),
    );

    expect(response.status).toBe(403);
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });

  it("rejects native decision lineage on the manual intent contract", async () => {
    const response = await POST(
      post({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        operation: "new_campaign",
        idempotencyKey: "idem_lineage",
        sourceDecisionId: "mdd_unknown",
        sourceDecisionSnapshotId: "018f3f55-630d-7f9f-8c19-bbd7d45db001",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("mixed_action_origin_contract");
    expect(store.createMetaLaunchIntent).not.toHaveBeenCalled();
  });
});
