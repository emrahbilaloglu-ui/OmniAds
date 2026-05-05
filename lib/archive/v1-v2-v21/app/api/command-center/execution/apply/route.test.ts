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
  applyCommandCenterExecution: vi.fn(),
  isCommandCenterExecutionError: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/command-center-store");
const service = await import("@/lib/command-center-service");
const executionService = await import("@/lib/command-center-execution-service");
const { POST } = await import("@/app/api/command-center/execution/apply/route");

describe("POST /api/command-center/execution/apply", () => {
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
    vi.mocked(executionService.applyCommandCenterExecution).mockResolvedValue({
      contractVersion: "command-center-execution.v1",
      actionFingerprint: "cc_meta_1",
      supportMode: "supported",
      status: "executed",
      previewHash: "preview_hash",
    } as never);
    vi.mocked(executionService.isCommandCenterExecutionError).mockReturnValue(false);
  });

  it("applies a supported execution preview", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/command-center/execution/apply", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_meta_1",
          previewHash: "preview_hash",
          clientMutationId: "apply_1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(executionService.applyCommandCenterExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        clientMutationId: "apply_1",
        previewHash: "preview_hash",
      }),
    );
  });

  it("returns a non-dispatching conflict for duplicate apply retries", async () => {
    vi.mocked(executionService.applyCommandCenterExecution).mockRejectedValue({
      code: "execution_apply_in_progress",
      status: 409,
      message:
        "Apply is already in progress or could not be safely replayed. Wait for the original attempt to settle and do not retry automatically.",
    });
    vi.mocked(executionService.isCommandCenterExecutionError).mockReturnValue(true);

    const response = await POST(
      new NextRequest("http://localhost/api/command-center/execution/apply", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_meta_1",
          previewHash: "preview_hash",
          clientMutationId: "apply_1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe("execution_apply_in_progress");
  });

  it("blocks read-only reviewers", async () => {
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: false,
      reason: "The seeded reviewer remains read-only on the canonical demo business.",
      role: "collaborator",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/command-center/execution/apply", {
        method: "POST",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_meta_1",
          previewHash: "preview_hash",
          clientMutationId: "apply_1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(executionService.applyCommandCenterExecution).not.toHaveBeenCalled();
  });
});
