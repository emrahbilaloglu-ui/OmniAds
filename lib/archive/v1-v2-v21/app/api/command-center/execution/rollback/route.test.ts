import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  getCommandCenterPermissions: vi.fn(),
}));

vi.mock("@/lib/command-center-service", () => ({
  findCommandCenterActionForRange: vi.fn(),
}));

vi.mock("@/lib/command-center-execution-service", () => ({
  isCommandCenterExecutionError: vi.fn(),
  rollbackCommandCenterExecution: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/command-center-store");
const service = await import("@/lib/command-center-service");
const executionService = await import("@/lib/command-center-execution-service");
const { POST } = await import("@/app/api/command-center/execution/rollback/route");

describe("POST /api/command-center/execution/rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: {
          id: "user_1",
          name: "Operator",
          email: "operator@adsecute.com",
        },
      } as never,
      membership: {
        role: "collaborator",
      } as never,
    });
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
    vi.mocked(service.findCommandCenterActionForRange).mockResolvedValue({
      actionFingerprint: "cc_meta_1",
      sourceSystem: "meta",
      sourceType: "meta_adset_decision",
      title: "Prospecting Wide US",
    } as never);
    vi.mocked(executionService.rollbackCommandCenterExecution).mockResolvedValue({
      contractVersion: "command-center-execution.v1",
      actionFingerprint: "cc_meta_1",
      supportMode: "supported",
      status: "rolled_back",
      previewHash: "preview_hash",
    } as never);
    vi.mocked(executionService.isCommandCenterExecutionError).mockReturnValue(false);
  });

  it("rolls back an executed action", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/execution/rollback", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_meta_1",
          clientMutationId: "rollback_1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(executionService.rollbackCommandCenterExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        clientMutationId: "rollback_1",
      }),
    );
  });

  it("returns a non-dispatching conflict for duplicate rollback retries", async () => {
    vi.mocked(executionService.rollbackCommandCenterExecution).mockRejectedValue({
      code: "execution_rollback_in_progress",
      status: 409,
      message:
        "Rollback is already in progress or could not be safely replayed. Wait for the original attempt to settle and do not retry automatically.",
    });
    vi.mocked(executionService.isCommandCenterExecutionError).mockReturnValue(true);

    const response = await POST(
      new NextRequest("http://localhost/api/command-center/execution/rollback", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_meta_1",
          clientMutationId: "rollback_1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe("execution_rollback_in_progress");
  });
});
