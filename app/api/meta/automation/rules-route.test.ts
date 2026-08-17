import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  engageMetaAutomationKillSwitch: vi.fn(),
  releaseMetaAutomationKillSwitch: vi.fn(),
  setMetaAutomationDecisionTypeMode: vi.fn(),
  getMetaAutomationControlPlane: vi.fn(),
  getMetaWriteBlockState: vi.fn(),
  META_AUTOMATION_DECISION_TYPES: ["pause", "bid", "budget", "creative"],
}));
vi.mock("@/lib/meta/automation-rules-evaluation", () => ({
  evaluateBusinessAutomationRules: vi.fn(async () => ({})),
}));
vi.mock("@/lib/meta/automation-rules-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta/automation-rules-store")
  >("@/lib/meta/automation-rules-store");
  return {
    ...actual,
    createAutomationRule: vi.fn(),
    setAutomationRuleActive: vi.fn(),
  };
});

const access = await import("@/lib/access");
const accountAssignments = await import("@/lib/meta/creatives-fetchers");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const store = await import("@/lib/meta/automation-rules-store");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function postRequest(body: unknown) {
  return new NextRequest(
    `http://localhost/api/meta/automation?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

const VALID_RULE = {
  name: "Breakeven guard",
  entityLevel: "adset",
  trigger: {
    kind: "roas_below_anchor",
    anchor: "break_even_roas",
    consecutiveDays: 3,
  },
  action: { kind: "propose_pause" },
  mode: "confirm",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
  vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
    "act_1",
  ]);
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@example.com" } },
    membership: { businessId: BUSINESS_ID, role: "admin" },
  } as never);
  vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
    contractVersion: "meta-automation-control-plane.v1",
    businessId: BUSINESS_ID,
  } as never);
});

describe("POST /api/meta/automation — rule mutations", () => {
  it("requires the same collaborator floor as its closest sibling actions", async () => {
    await POST(postRequest({ action: "create_rule", rule: VALID_RULE }));
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "collaborator" }),
    );

    vi.clearAllMocks();
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      membership: { businessId: BUSINESS_ID, role: "admin" },
    } as never);
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      {} as never,
    );

    await POST(
      postRequest({ action: "set_rule_active", ruleId: "rule_1", active: false }),
    );
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ minRole: "collaborator" }),
    );
  });

  it("returns the membership denial verbatim and never touches the store", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ ok: false }, { status: 403 }),
    } as never);

    const response = await POST(
      postRequest({ action: "create_rule", rule: VALID_RULE }),
    );

    expect(response.status).toBe(403);
    expect(store.createAutomationRule).not.toHaveBeenCalled();
  });

  it("scopes the mutation to the authorized business, not the query string", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      membership: { businessId: "authorized_business", role: "admin" },
    } as never);

    await POST(
      postRequest({ action: "set_rule_active", ruleId: "rule_1", active: false }),
    );

    expect(store.setAutomationRuleActive).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "authorized_business",
        userId: "user_1",
        ruleId: "rule_1",
        active: false,
      }),
    );
  });

  it("refuses an unassigned provider account before mutating", async () => {
    vi.mocked(accountAssignments.fetchAssignedAccountIds).mockResolvedValue([
      "act_other",
    ]);

    const response = await POST(
      postRequest({ action: "create_rule", rule: VALID_RULE }),
    );

    expect(response.status).toBe(403);
    expect(store.createAutomationRule).not.toHaveBeenCalled();
  });

  it("honours the reviewer read-only guard for both rule mutations", async () => {
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ ok: false }, { status: 403 }),
    );

    const created = await POST(
      postRequest({ action: "create_rule", rule: VALID_RULE }),
    );
    expect(created.status).toBe(403);
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.anything(),
      "automation_rule_create",
    );

    const toggled = await POST(
      postRequest({ action: "set_rule_active", ruleId: "rule_1", active: true }),
    );
    expect(toggled.status).toBe(403);
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.anything(),
      "automation_rule_toggle",
    );
    expect(store.createAutomationRule).not.toHaveBeenCalled();
    expect(store.setAutomationRuleActive).not.toHaveBeenCalled();
  });

  it("rejects a rule draft that is not anchored to the Commercial Truth pack", async () => {
    vi.mocked(store.createAutomationRule).mockRejectedValue(
      new (
        await import("@/lib/meta/automation-rules")
      ).AutomationRuleValidationError(
        "trigger.threshold",
        "triggers_must_anchor_to_the_commercial_truth_pack_not_absolute_numbers",
      ),
    );

    const response = await POST(
      postRequest({
        action: "create_rule",
        rule: {
          ...VALID_RULE,
          trigger: { ...VALID_RULE.trigger, threshold: 2.5 },
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_automation_rule" },
    });
  });

  it("surfaces the enforced-guard lock as a conflict rather than a silent no-op", async () => {
    vi.mocked(store.setAutomationRuleActive).mockRejectedValue(
      new store.AutomationRuleLockedError(),
    );

    const response = await POST(
      postRequest({
        action: "set_rule_active",
        ruleId: "rule_guard",
        active: false,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "automation_rule_locked" },
    });
  });

  it("rejects a malformed toggle payload", async () => {
    const response = await POST(
      postRequest({ action: "set_rule_active", ruleId: "  ", active: "yes" }),
    );

    expect(response.status).toBe(400);
    expect(store.setAutomationRuleActive).not.toHaveBeenCalled();
  });

  it("still refuses actions outside the supported set", async () => {
    const response = await POST(
      postRequest({ action: "execute_rule", ruleId: "rule_1" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_automation_action" },
    });
  });

  it("runs an evaluation only inside the authorized business and account scope", async () => {
    const evaluation = await import("@/lib/meta/automation-rules-evaluation");

    await POST(postRequest({ action: "evaluate_rules" }));

    expect(evaluation.evaluateBusinessAutomationRules).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
    });

    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ ok: false }, { status: 403 }),
    );
    vi.mocked(evaluation.evaluateBusinessAutomationRules).mockClear();
    const blocked = await POST(postRequest({ action: "evaluate_rules" }));

    expect(blocked.status).toBe(403);
    expect(evaluation.evaluateBusinessAutomationRules).not.toHaveBeenCalled();
  });

  it("keeps release_kill_switch on its stricter admin floor", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      businessControl: { source: "persisted", killSwitchEngaged: true },
    } as never);

    await POST(postRequest({ action: "release_kill_switch" }));

    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ minRole: "admin" }),
    );
  });
});
