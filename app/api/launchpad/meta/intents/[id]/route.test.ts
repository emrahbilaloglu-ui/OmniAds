import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn((code: string) =>
    code === "provider_account_not_assigned" ? 403 : 400,
  ),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  getMetaLaunchIntent: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-capability", () => ({
  getMetaLaunchIntentCapability: vi.fn(),
}));

const access = await import("@/lib/access");
const validation = await import("@/lib/launchpad/meta-validation");
const store = await import("@/lib/launchpad/meta-launch-intent-store");
const capability = await import("@/lib/launchpad/meta-launch-intent-capability");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(accountId = "act_123") {
  return new NextRequest(
    `http://localhost/api/launchpad/meta/intents/intent_1?businessId=${BUSINESS_ID}&providerAccountId=${accountId}`,
  );
}

describe("GET /api/launchpad/meta/intents/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
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

  it("returns a receipt only inside its explicit account scope", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue({
      id: "intent_1",
      providerAccountId: "act_123",
      status: "partially_succeeded",
    } as never);

    const response = await GET(request(), {
      params: Promise.resolve({ id: "intent_1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.intent.status).toBe("partially_succeeded");
    expect(store.getMetaLaunchIntent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      id: "intent_1",
    });
  });

  it("conceals an intent belonging to another assigned account", async () => {
    vi.mocked(store.getMetaLaunchIntent).mockResolvedValue({
      id: "intent_1",
      providerAccountId: "act_456",
    } as never);

    const response = await GET(request(), {
      params: Promise.resolve({ id: "intent_1" }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("launch_intent_not_found");
  });
});
