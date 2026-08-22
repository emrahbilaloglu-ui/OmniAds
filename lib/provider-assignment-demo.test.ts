import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));
vi.mock("@/lib/provider-assignment-authorization", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/provider-assignment-authorization")
  >("@/lib/provider-assignment-authorization");
  return {
    ...actual,
    authorizeAssignmentMutation: vi.fn(),
    resolveProviderConnectionAuthority: vi.fn(),
    validateRequestedProviderAccounts: vi.fn(),
  };
});

const businessMode = await import("@/lib/business-mode.server");
const authorization = await import("@/lib/provider-assignment-authorization");
const { handleProviderAssignmentRequest } = await import(
  "@/lib/provider-assignment-service"
);

const CONFIG = {
  provider: "meta" as const,
  label: "test-assign",
  requiredTables: ["provider_account_assignments"],
  schedule: vi.fn(),
};

function request(accountIds: string[]) {
  return new NextRequest("http://localhost/businesses/biz_1/meta/assign-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_ids: accountIds }),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("assignment on a demo workspace", () => {
  it("does not claim a selection was saved", async () => {
    /**
     * The defect this pins: the demo branch answered `selectionSaved: true`
     * with `assigned_accounts` echoing the caller's own request, for a workspace
     * where nothing is written. The operator saw a successful assignment, the
     * drawer closed, and every Meta surface then resolved no account and
     * refused — refusing for a selection the product had just confirmed.
     *
     * No test covered this branch before, which is why it survived.
     */
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);
    vi.mocked(authorization.authorizeAssignmentMutation).mockResolvedValue({
      ok: true,
    } as never);

    const response = await handleProviderAssignmentRequest(
      CONFIG,
      request(["act_111", "act_222"]),
      "biz_1",
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.demo).toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.selectionSaved).toBe(false);
    expect(body.syncScheduled).toBe(false);
    expect(body.success).toBe(false);
    expect(typeof body.message).toBe("string");
  });

  it("does not echo the requested ids back as assigned", async () => {
    // Returning the request as the result is the specific lie. Echoing it "just
    // for the UI" would preserve it exactly where it does its damage — and the
    // ids were never checked against a discovery snapshot, so they may name
    // accounts that do not exist.
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);
    vi.mocked(authorization.authorizeAssignmentMutation).mockResolvedValue({
      ok: true,
    } as never);

    const response = await handleProviderAssignmentRequest(
      CONFIG,
      request(["act_does_not_exist"]),
      "biz_1",
    );
    const body = (await response.json()) as { assigned_accounts: unknown };
    expect(body.assigned_accounts).toEqual([]);
  });

  it("never reaches the connection or scheduling steps", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);
    vi.mocked(authorization.authorizeAssignmentMutation).mockResolvedValue({
      ok: true,
    } as never);

    await handleProviderAssignmentRequest(CONFIG, request(["act_1"]), "biz_1");

    expect(authorization.resolveProviderConnectionAuthority).not.toHaveBeenCalled();
    expect(authorization.validateRequestedProviderAccounts).not.toHaveBeenCalled();
    expect(CONFIG.schedule).not.toHaveBeenCalled();
  });

  it("still refuses an unauthorized caller before the demo branch", async () => {
    // Tenant access is checked first, and the demo shortcut must not become a
    // way around it.
    const refusal = new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
    });
    vi.mocked(authorization.authorizeAssignmentMutation).mockResolvedValue({
      ok: false,
      response: refusal,
    } as never);

    const response = await handleProviderAssignmentRequest(
      CONFIG,
      request(["act_1"]),
      "biz_1",
    );
    expect(response.status).toBe(403);
    expect(businessMode.isDemoBusiness).not.toHaveBeenCalled();
  });
});
