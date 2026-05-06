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
  getCommandCenterExecutionPreview: vi.fn(),
  isCommandCenterExecutionError: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/command-center-store");
const service = await import("@/lib/command-center-service");
const executionService = await import("@/lib/command-center-execution-service");
const { GET } = await import("@/app/api/command-center/execution/route");

describe("GET /api/command-center/execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: {
          id: "user_1",
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
    vi.mocked(executionService.getCommandCenterExecutionPreview).mockResolvedValue({
      contractVersion: "command-center-execution.v1",
      actionFingerprint: "cc_meta_1",
      supportMode: "supported",
      status: "ready_for_apply",
      previewHash: "preview_hash",
    } as never);
    vi.mocked(executionService.isCommandCenterExecutionError).mockReturnValue(false);
  });

  it("returns the typed execution preview payload", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/command-center/execution?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&actionFingerprint=cc_meta_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.contractVersion).toBe("command-center-execution.v1");
    expect(executionService.getCommandCenterExecutionPreview).toHaveBeenCalled();
  });
});
