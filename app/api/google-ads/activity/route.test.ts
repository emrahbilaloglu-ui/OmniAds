import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/google-ads/activity/route";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/google-ads/advisor-memory", () => ({
  listAdvisorExecutionEvents: vi.fn(),
}));

const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const advisorMemory = await import("@/lib/google-ads/advisor-memory");
const retention = await import("@/lib/google-ads/warehouse-retention");

function request(query: string) {
  return new NextRequest(`https://app.test/api/google-ads/activity?${query}`);
}

const entry = {
  id: "log_1",
  createdAt: "2026-08-15T09:12:00.000Z",
  operation: "apply",
  mutateActionType: "adjust_portfolio_target",
  status: "applied",
  accountId: "4931182201",
  receiptId: "gw_01K2F4",
  detail: null,
  actor: { id: "usr_1", name: "Emrah Bilaloglu" },
};

describe("GET /api/google-ads/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(advisorMemory.listAdvisorExecutionEvents).mockResolvedValue([entry]);
  });

  it("refuses a request with no business", async () => {
    const response = await GET(request("accountId=4931182201"));
    expect(response.status).toBe(400);
    expect(advisorMemory.listAdvisorExecutionEvents).not.toHaveBeenCalled();
  });

  it("applies business access before reading the execution log", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValueOnce({
      error: new Response("no", { status: 403 }) as never,
    } as never);

    const response = await GET(request("businessId=biz_1"));

    expect(response.status).toBe(403);
    expect(advisorMemory.listAdvisorExecutionEvents).not.toHaveBeenCalled();
  });

  it("scopes the read to the requested account and returns the retention window", async () => {
    const response = await GET(
      request("businessId=biz_1&accountId=4931182201"),
    );
    const payload = await response.json();

    expect(advisorMemory.listAdvisorExecutionEvents).toHaveBeenCalledWith({
      businessId: "biz_1",
      accountId: "4931182201",
    });
    expect(payload.rows).toEqual([entry]);
    expect(payload.count).toBe(1);
    // The boundary the screen states is the log's own policy, not a client guess.
    expect(payload.retentionDays).toBe(
      retention.GOOGLE_ADS_RETENTION_POLICY.advisor_execution_log.retentionDays,
    );
  });

  it("treats an 'all' account as no account rather than a literal id", async () => {
    await GET(request("businessId=biz_1&accountId=all"));
    expect(advisorMemory.listAdvisorExecutionEvents).toHaveBeenCalledWith({
      businessId: "biz_1",
      accountId: null,
    });
  });

  it("serves a demo business an empty feed rather than seeded activity", async () => {
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValueOnce(true);

    const payload = await (await GET(request("businessId=demo"))).json();

    expect(payload.rows).toEqual([]);
    expect(payload.retentionDays).toBeGreaterThan(0);
    expect(advisorMemory.listAdvisorExecutionEvents).not.toHaveBeenCalled();
  });
});
