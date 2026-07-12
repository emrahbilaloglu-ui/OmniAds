import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/automation-control-plane", () => ({
  engageMetaAutomationKillSwitch: vi.fn(),
  releaseMetaAutomationKillSwitch: vi.fn(),
  setMetaAutomationDecisionTypeMode: vi.fn(),
  getMetaAutomationControlPlane: vi.fn(),
  META_AUTOMATION_DECISION_TYPES: ["pause", "bid", "budget", "creative"],
}));

const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const { GET, POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(url = `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`) {
  return new NextRequest(url);
}

function postRequest(body: unknown, url = `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/meta/automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      membership: { businessId: BUSINESS_ID, role: "admin" },
    } as never);
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      contractVersion: "meta-automation-control-plane.v1",
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      globalKillSwitch: { engaged: false, reason: null },
      businessControl: {
        businessId: BUSINESS_ID,
        killSwitchEngaged: true,
        killSwitchReason: "Owner paused automation.",
        autoExecutionEnabled: false,
        readinessTier: "manual_review",
        guardrails: {
          dailyAutoActionCap: 3,
          perActionSpendCeilingMinor: 5000,
          perActionSpendCeilingCurrency: "EUR",
          notificationPolicy: "every_auto_action",
          maxBudgetIncreasePct: 15,
          maxDailyBudgetChangeMinor: null,
          requireCampaignLabel: true,
          requireCommercialAnchor: true,
          requireLivePreflight: true,
          requireRollbackPlan: true,
          dryRunOnly: true,
        },
        updatedAt: null,
        updatedBy: null,
        source: "persisted",
      },
      execution: {
        autoExecutionAllowed: false,
        writeEndpointsBlocked: true,
        blockedReasons: ["business_kill_switch", "auto_execution_not_enabled"],
      },
      promotionRecords: [],
      activityLedger: [],
      decisionTypeModes: [],
    });
    vi.mocked(controlPlane.engageMetaAutomationKillSwitch).mockResolvedValue({
      businessId: BUSINESS_ID,
      killSwitchEngaged: true,
      killSwitchReason: "Emergency stop.",
      autoExecutionEnabled: false,
      readinessTier: "manual_review",
      guardrails: {
        dailyAutoActionCap: 3,
        perActionSpendCeilingMinor: 5000,
        perActionSpendCeilingCurrency: "EUR",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 15,
        maxDailyBudgetChangeMinor: null,
        requireCampaignLabel: true,
        requireCommercialAnchor: true,
        requireLivePreflight: true,
        requireRollbackPlan: true,
        dryRunOnly: true,
      },
      updatedAt: "2026-07-08T10:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
    });
    vi.mocked(controlPlane.releaseMetaAutomationKillSwitch).mockResolvedValue({
      businessId: BUSINESS_ID,
      killSwitchEngaged: false,
      killSwitchReason: null,
      autoExecutionEnabled: false,
      readinessTier: "manual_review",
      guardrails: {
        dailyAutoActionCap: 3,
        perActionSpendCeilingMinor: 5000,
        perActionSpendCeilingCurrency: "EUR",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 15,
        maxDailyBudgetChangeMinor: null,
        requireCampaignLabel: true,
        requireCommercialAnchor: true,
        requireLivePreflight: true,
        requireRollbackPlan: true,
        dryRunOnly: true,
      },
      updatedAt: "2026-07-08T11:00:00.000Z",
      updatedBy: "user_1",
      source: "persisted",
    });
  });

  it("returns the server-composed automation control plane", async () => {
    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "guest" }),
    );
    expect(payload.automation.execution.writeEndpointsBlocked).toBe(true);
    expect(payload.automation.businessControl.killSwitchReason).toBe("Owner paused automation.");
    expect(controlPlane.getMetaAutomationControlPlane).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });
  });

  it("requires a business id", async () => {
    const response = await GET(request("http://localhost/api/meta/automation"));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("missing_business_id");
    expect(controlPlane.getMetaAutomationControlPlane).not.toHaveBeenCalled();
  });

  it("requires explicit account scope when more than one account is assigned", async () => {
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);
    const response = await GET(
      request(`http://localhost/api/meta/automation?businessId=${BUSINESS_ID}`),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("provider_account_required");
    expect(controlPlane.getMetaAutomationControlPlane).not.toHaveBeenCalled();
  });

  it("rejects an unassigned provider account", async () => {
    const response = await GET(
      request(
        `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_other`,
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("account_not_assigned");
  });

  it("engages only the stop-side business kill switch", async () => {
    const response = await POST(
      postRequest({ action: "engage_kill_switch", reason: "Emergency stop." }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "collaborator" }),
    );
    expect(controlPlane.engageMetaAutomationKillSwitch).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      userId: "user_1",
      reason: "Emergency stop.",
    });
    expect(payload.automation.businessControl.killSwitchEngaged).toBe(true);
  });

  it("rejects reviewer read-only stop attempts before persistence", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } },
      membership: { businessId: BUSINESS_ID },
    } as never);

    const response = await POST(
      postRequest({ action: "engage_kill_switch", reason: "Emergency stop." }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("automation_kill_switch_engage");
    expect(controlPlane.engageMetaAutomationKillSwitch).not.toHaveBeenCalled();
  });

  it("rejects unsupported automation writes", async () => {
    const response = await POST(postRequest({ action: "enable_auto_execution" }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("unsupported_automation_action");
    expect(controlPlane.engageMetaAutomationKillSwitch).not.toHaveBeenCalled();
    expect(controlPlane.releaseMetaAutomationKillSwitch).not.toHaveBeenCalled();
  });

  it("releases the business kill switch so the stop is not a one-way trap", async () => {
    const response = await POST(postRequest({ action: "release_kill_switch" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "admin" }),
    );
    expect(controlPlane.releaseMetaAutomationKillSwitch).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      userId: "user_1",
    });
    // Release must not engage, and must re-read the freshly composed control plane.
    expect(controlPlane.engageMetaAutomationKillSwitch).not.toHaveBeenCalled();
    expect(payload.ok).toBe(true);
  });

  it("withholds release when the fresh persisted STOP preflight is not engaged", async () => {
    const current = await controlPlane.getMetaAutomationControlPlane({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValueOnce({
      ...current,
      businessControl: {
        ...current.businessControl,
        killSwitchEngaged: false,
      },
    });

    const response = await POST(postRequest({ action: "release_kill_switch" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "kill_switch_release_preflight_failed" },
    });
    expect(controlPlane.releaseMetaAutomationKillSwitch).not.toHaveBeenCalled();
  });

  it("rejects reviewer read-only release attempts before persistence", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } },
      membership: { businessId: BUSINESS_ID },
    } as never);

    const response = await POST(postRequest({ action: "release_kill_switch" }));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("automation_kill_switch_release");
    expect(controlPlane.releaseMetaAutomationKillSwitch).not.toHaveBeenCalled();
  });

  it("persists a per-decision-type standing mode", async () => {
    vi.mocked(controlPlane.setMetaAutomationDecisionTypeMode).mockResolvedValue([]);

    const response = await POST(
      postRequest({ action: "set_decision_type_mode", decisionType: "bid", mode: "semi_auto" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(controlPlane.setMetaAutomationDecisionTypeMode).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, decisionType: "bid", mode: "semi_auto" }),
    );
  });

  it("rejects an invalid decision type or mode without persisting", async () => {
    const response = await POST(
      postRequest({ action: "set_decision_type_mode", decisionType: "bid", mode: "nonsense" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_decision_type_mode");
    expect(controlPlane.setMetaAutomationDecisionTypeMode).not.toHaveBeenCalled();
  });
});
