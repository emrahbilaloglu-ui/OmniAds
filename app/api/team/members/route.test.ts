import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  listBusinessMembers: vi.fn(),
  getBusinessMemberActionCounts: vi.fn(),
  getMemberWorkspaces: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
  updateMemberWorkspaces: vi.fn(),
}));

vi.mock("@/lib/access", () => ({ requireBusinessAccess: mocks.requireBusinessAccess }));
vi.mock("@/lib/account-store", () => ({
  MEMBER_ACTION_WINDOW_DAYS: 28,
  getBusinessMemberActionCounts: mocks.getBusinessMemberActionCounts,
  getMemberWorkspaces: mocks.getMemberWorkspaces,
  listBusinessMembers: mocks.listBusinessMembers,
  removeMember: mocks.removeMember,
  updateMemberRole: mocks.updateMemberRole,
  updateMemberWorkspaces: mocks.updateMemberWorkspaces,
}));

import { GET } from "@/app/api/team/members/route";

function get(query = "businessId=biz_1") {
  return new NextRequest(`http://localhost/api/team/members?${query}`);
}

describe("GET /api/team/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBusinessAccess.mockResolvedValue({
      membership: { role: "guest" },
      session: { user: { id: "user_1" } },
    });
    mocks.listBusinessMembers.mockResolvedValue([
      { membership_id: "m1", user_id: "u1", role: "admin" },
      { membership_id: "m2", user_id: "u2", role: "collaborator" },
    ]);
  });

  it("serves a real 28-day action count per member from the write ledgers", async () => {
    mocks.getBusinessMemberActionCounts.mockResolvedValue({ u1: 46 });

    const response = await GET(get());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      members: Array<{ user_id: string; action_count: number | null }>;
      actionWindowDays: number;
    };

    expect(payload.actionWindowDays).toBe(28);
    expect(payload.members.map((member) => member.action_count)).toEqual([46, 0]);
    expect(mocks.getBusinessMemberActionCounts).toHaveBeenCalledWith("biz_1");
  });

  it("reports an unreadable ledger as unknown, never as a zero count", async () => {
    mocks.getBusinessMemberActionCounts.mockResolvedValue(null);

    const response = await GET(get());
    const payload = (await response.json()) as {
      members: Array<{ action_count: number | null }>;
    };
    expect(payload.members.map((member) => member.action_count)).toEqual([null, null]);
  });

  it("keeps the route's existing guest read gate exactly as it was", async () => {
    await GET(get());
    expect(mocks.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_1", minRole: "guest" }),
    );
  });

  it("refuses before reading anything when the access check fails", async () => {
    mocks.requireBusinessAccess.mockResolvedValue({
      error: new Response(null, { status: 403 }),
    });
    const response = await GET(get());
    expect(response.status).toBe(403);
    expect(mocks.listBusinessMembers).not.toHaveBeenCalled();
    expect(mocks.getBusinessMemberActionCounts).not.toHaveBeenCalled();
  });
});

/**
 * The aggregation itself needs a live PostgreSQL, which this suite has none of.
 * These guard the two properties of the statement that no type checker sees and
 * that would fail only at runtime.
 */
describe("getBusinessMemberActionCounts statement shape", () => {
  const source = readFileSync("lib/account-store.ts", "utf8");
  const statement = source.slice(
    source.indexOf("WITH ledger AS ("),
    source.indexOf("GROUP BY actor_user_id"),
  );

  it("reads all three actor-stamped ledgers", () => {
    expect(statement).toContain("FROM decision_workflow_events");
    expect(statement).toContain("FROM command_center_action_journal");
    expect(statement).toContain("FROM command_center_action_execution_audit");
    // Only operations that actually reached a provider count as executions.
    expect(statement).toContain("operation IN ('apply', 'rollback')");
  });

  it("never reuses one placeholder for both the TEXT and the UUID business id", () => {
    // `decision_workflow_events.business_id` is TEXT; the other two are UUID.
    // One placeholder for both makes PostgreSQL deduce two conflicting types
    // and refuse the whole statement — the trap decision-workflow-store hit.
    expect(statement).toContain("business_id = $1\n");
    expect(statement).toContain("business_id = $2::uuid");
    expect(statement).not.toContain("business_id = $1::uuid");
  });
});
