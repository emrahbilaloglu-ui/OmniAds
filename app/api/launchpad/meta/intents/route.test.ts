import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";

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

function post(body: unknown) {
  return new NextRequest("http://localhost/api/launchpad/meta/intents", {
    method: "POST",
    body: JSON.stringify(body),
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

  it("creates an immutable PAUSED intent with decision and brief lineage", async () => {
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
        sourceDecisionId: "decision_1",
        creativeBriefId: "brief_1",
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
        sourceDecisionId: "decision_1",
        creativeBriefId: "brief_1",
        createdBy: USER_ID,
      }),
    );
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

  it("returns 422 when decision or brief lineage cannot be proven", async () => {
    vi.mocked(store.createMetaLaunchIntent).mockRejectedValue(
      new MetaLaunchIntentLineageError(
        "source_decision_not_found",
        "The source decision snapshot is not available in the selected Meta account.",
      ),
    );

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

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("source_decision_not_found");
  });
});
