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
 * Statement-shape guards.
 *
 * The aggregation was validated against production read-only (EXPLAIN plus the
 * aggregate; index scans on all five tables). These pin the properties that no
 * type checker sees and that a later edit could silently break.
 */
describe("getBusinessMemberActionCounts statement shape", () => {
  const source = readFileSync("lib/account-store.ts", "utf8");
  const statement = source.slice(
    source.indexOf("WITH ledger AS ("),
    source.indexOf("GROUP BY actor_user_id"),
  );

  it("reads all five actor-stamped ledgers", () => {
    for (const table of [
      // The Meta provider-write log: the most literal "action" of the five.
      "FROM meta_ads_action_log",
      "FROM meta_automation_activity_ledger",
      "FROM decision_workflow_events",
      "FROM command_center_action_journal",
      "FROM command_center_action_execution_audit",
    ]) {
      expect(statement).toContain(table);
    }
    // Only operations that actually reached a provider count as executions.
    expect(statement).toContain("operation IN ('apply', 'rollback')");
  });

  it("excludes simulated writes but counts requested-but-failed ones", () => {
    // A dry run never reaches Meta, so it is not a write.
    expect(statement).toContain("dry_run IS NOT TRUE");
    // `status` is deliberately unfiltered: rows are inserted `pending` and
    // settled later, so filtering on it would make the count depend on when
    // the page loaded and would hide `silent_failure` entirely.
    expect(statement).not.toContain("status");
  });

  it("attributes nothing it cannot attribute", () => {
    // Every branch drops rows with no actor.
    expect(statement.match(/IS NOT NULL/g) ?? []).toHaveLength(5);
  });

  it("windows each ledger on its own indexed timestamp", () => {
    // meta_ads_action_log is indexed on (business_id, requested_at DESC).
    expect(statement).toContain("requested_at >= now()");
    expect(statement.match(/created_at >= now\(\)/g) ?? []).toHaveLength(4);
  });

  it("never reuses one placeholder for both the TEXT and the UUID business id", () => {
    // `decision_workflow_events.business_id` is TEXT; the other four are UUID.
    // One placeholder for both makes PostgreSQL deduce two conflicting types
    // and refuse the whole statement — the trap decision-workflow-store hit.
    expect(statement).toContain("business_id = $1\n");
    expect(statement.match(/business_id = \$2::uuid/g) ?? []).toHaveLength(4);
    expect(statement).not.toContain("business_id = $1::uuid");
  });
});
