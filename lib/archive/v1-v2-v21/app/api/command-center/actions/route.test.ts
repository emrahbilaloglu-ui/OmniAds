import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/command-center-config", () => ({
  isCommandCenterV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/command-center-service", () => ({
  findCommandCenterActionForRange: vi.fn(),
}));

vi.mock("@/lib/command-center-store", () => ({
  applyCommandCenterActionMutation: vi.fn(),
  getCommandCenterPermissions: vi.fn(),
  listAssignableCommandCenterUsers: vi.fn(),
}));

const access = await import("@/lib/access");
const config = await import("@/lib/command-center-config");
const service = await import("@/lib/command-center-service");
const store = await import("@/lib/command-center-store");
const { PATCH } = await import("@/app/api/command-center/actions/route");

const actionFixture = {
  actionFingerprint: "cc_123",
  sourceSystem: "creative",
  sourceType: "creative_primary_decision",
  title: "Promo Hook A",
  recommendedAction: "promote_to_scaling",
  confidence: 0.82,
  priority: "high",
  summary: "Promote this concept.",
  decisionSignals: ["Benchmark beat."],
  evidence: [],
  guardrails: [],
  relatedEntities: [{ type: "creative", id: "creative_1", label: "Promo Hook A" }],
  tags: ["scale_promotions"],
  watchlistOnly: false,
  status: "pending",
  assigneeUserId: null,
  assigneeName: null,
  snoozeUntil: null,
  latestNoteExcerpt: null,
  noteCount: 0,
  lastMutatedAt: null,
  lastMutationId: null,
  createdAt: "2026-04-11T00:00:00.000Z",
  sourceContext: {
    sourceLabel: "Creative Decision OS",
    operatingMode: "Exploit",
    sourceDeepLink: "/creatives",
    sourceDecisionId: "creative_1",
  },
} as const;

describe("PATCH /api/command-center/actions", () => {
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
    vi.mocked(config.isCommandCenterV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: true,
      reason: null,
      role: "collaborator",
    });
    vi.mocked(service.findCommandCenterActionForRange).mockResolvedValue(actionFixture as never);
    vi.mocked(store.listAssignableCommandCenterUsers).mockResolvedValue([
      {
        userId: "user_2",
        name: "Closer",
        email: "closer@adsecute.com",
        role: "collaborator",
      },
    ] as never);
    vi.mocked(store.applyCommandCenterActionMutation).mockResolvedValue({
      actionFingerprint: "cc_123",
      workflowStatus: "approved",
    } as never);
  });

  it("applies an approve mutation", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/api/command-center/actions", {
        method: "PATCH",
        body: JSON.stringify({
          businessId: "biz",
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          actionFingerprint: "cc_123",
          clientMutationId: "m_1",
          mutation: "approve",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(store.applyCommandCenterActionMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        clientMutationId: "m_1",
        mutation: "approve",
      }),
    );
  });

  it("blocks read-only reviewer mutations", async () => {
    vi.mocked(store.getCommandCenterPermissions).mockReturnValue({
      canEdit: false,
      reason: "The seeded reviewer remains read-only on the canonical demo business.",
      role: "collaborator",
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/command-center/actions", {
        method: "PATCH",
        body: JSON.stringify({
          businessId: "biz",
          actionFingerprint: "cc_123",
          clientMutationId: "m_2",
          mutation: "approve",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(store.applyCommandCenterActionMutation).not.toHaveBeenCalled();
  });
});
