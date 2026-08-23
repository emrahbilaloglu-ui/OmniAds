import { describe, expect, it } from "vitest";

import {
  buildTeamExactModel,
  TEAM_CAPABILITIES,
  UNGATED_MARK,
  type TeamAdapterInput,
} from "@/components/team/team-exact-adapter";

function input(overrides: Partial<TeamAdapterInput> = {}): TeamAdapterInput {
  return {
    members: [
      {
        membership_id: "m1",
        user_id: "u1",
        name: "Emrah B.",
        email: "emrah@grandmix.co",
        role: "admin",
        joined_at: "2026-03-02T09:00:00.000Z",
        last_login_at: "2026-08-17T07:10:00.000Z",
        action_count: 46,
      },
      {
        membership_id: "m2",
        user_id: "u2",
        name: "Selin K.",
        email: "selin@grandmix.co",
        role: "collaborator",
        joined_at: "2026-05-04T09:00:00.000Z",
        last_login_at: null,
        action_count: 0,
      },
      {
        membership_id: "m3",
        user_id: "u3",
        name: null,
        email: "reports@northpeak.agency",
        role: "guest",
        joined_at: "2026-06-01T09:00:00.000Z",
      },
    ],
    invites: [
      {
        id: "i1",
        email: "mert@grandmix.co",
        role: "collaborator",
        status: "pending",
        created_at: "2026-08-12T09:00:00.000Z",
        expires_at: "2026-08-19T09:00:00.000Z",
        invited_by_name: "Emrah B.",
      },
      {
        id: "i2",
        email: "old@grandmix.co",
        role: "guest",
        status: "revoked",
        created_at: "2026-07-01T09:00:00.000Z",
        expires_at: "2026-07-08T09:00:00.000Z",
      },
    ],
    workspaceOwnerUserId: "u1",
    businessName: "Grandmix",
    planName: "Growth",
    seatAllowance: null,
    canInvite: false,
    inviteBlockedReason: "Adding a seat needs the Scale plan.",
    ...overrides,
  };
}

describe("buildTeamExactModel", () => {
  it("maps the four design roles onto the three stored roles plus the owner", () => {
    const model = buildTeamExactModel(input());
    expect(model.members.map((member) => member.role)).toEqual(["Owner", "Analyst", "Viewer"]);
    expect(model.members[0].removable).toBe(false);
    expect(model.members[1].removable).toBe(true);
  });

  it("keeps the 2FA column and dashes it honestly — nothing stores a second factor", () => {
    const model = buildTeamExactModel(input());
    expect(model.members.every((member) => member.twoFactor === "—")).toBe(true);
  });

  it("prints the real 28-day action count, including a real zero", () => {
    const model = buildTeamExactModel(input());
    expect(model.members[0].actions).toBe("46 writes");
    // A member the ledger simply has no rows for is 0, not unknown.
    expect(model.members[1].actions).toBe("0 writes");
  });

  it("says '1 write', not '1 writes'", () => {
    const single = input();
    single.members[1]!.action_count = 1;
    expect(buildTeamExactModel(single).members[1].actions).toBe("1 write");
  });

  it("dashes the action count only when the ledger itself could not be read", () => {
    // The third seeded member carries no `action_count` at all, which is what
    // `/api/team/members` serves when `getBusinessMemberActionCounts` is null.
    const model = buildTeamExactModel(input());
    expect(model.members[2].actions).toBe("—");
  });

  it("reports last active from the sign-in stamp, not the join date", () => {
    const model = buildTeamExactModel(input());
    expect(model.members[0].lastActive).toBe("Aug 17");
    // No sign-in recorded is an em dash, never the day the membership started.
    expect(model.members[1].lastActive).toBe("—");
    expect(model.members[2].lastActive).toBe("—");
  });

  it("meters seats against a real plan and dashes an allowance the plan has no field for", () => {
    const model = buildTeamExactModel(input());
    expect(model.seats.eyebrow).toBe("Seats · Growth plan");
    expect(model.seats.value).toBe("3 of — used");
    expect(model.seats.fill).toBe("0%");

    const withAllowance = buildTeamExactModel(input({ seatAllowance: 5 }));
    expect(withAllowance.seats.value).toBe("3 of 5 used");
    expect(withAllowance.seats.fill).toBe("60%");
  });

  it("uses the design's nine capability captions in the design's order", () => {
    const model = buildTeamExactModel(input());
    expect(model.capabilities.map((row) => row.label)).toEqual([
      "View dashboards & evidence",
      "Open share-link reports",
      "Comment & annotate",
      "Approve automation proposals",
      "Launch drafts · provider writes",
      "Edit Commercial Truth pack",
      "Manage integrations",
      "Invite & manage members",
      "Billing & plan",
    ]);
    expect(TEAM_CAPABILITIES).toHaveLength(9);
  });

  it("ticks each capability from the server gate, not from the prototype's pattern", () => {
    const model = buildTeamExactModel(input());
    const cells = (label: string) =>
      model.capabilities.find((row) => row.label === label)!.cells.map((cell) => cell.value);
    // minRole "guest" on the read routes.
    expect(cells("View dashboards & evidence")).toEqual(["✓", "✓", "✓", "✓"]);
    // minRole "collaborator" on the write routes.
    expect(cells("Launch drafts · provider writes")).toEqual(["✓", "✓", "✓", "—"]);
    // minRole "admin" on /api/team/**.
    expect(cells("Invite & manage members")).toEqual(["✓", "✓", "—", "—"]);
    // No route implements it, so no role is claimed to have it.
    expect(cells("Comment & annotate")).toEqual(["—", "—", "—", "—"]);
  });

  it("marks an ungated capability distinctly instead of ticking it as granted", () => {
    const model = buildTeamExactModel(input());
    const billing = model.capabilities.find((row) => row.label === "Billing & plan")!;
    // `/api/billing` POST authenticates and then checks no workspace role, so
    // every role reaches it — but that is a hole, not an entitlement.
    expect(billing.cells.map((cell) => cell.value)).toEqual([
      UNGATED_MARK,
      UNGATED_MARK,
      UNGATED_MARK,
      UNGATED_MARK,
    ]);
    expect(UNGATED_MARK).not.toBe("✓");
    expect(billing.cells.every((cell) => cell.foreground === "#B45309")).toBe(true);
    expect(billing.cells[0].note).toContain("TRUTH-TEAM-SETTINGS-44");

    // A genuinely granted capability keeps the green tick and carries no note.
    const granted = model.capabilities.find((row) => row.label === "Invite & manage members")!;
    expect(granted.cells[0].value).toBe("✓");
    expect(granted.cells[0].foreground).toBe("#0b7954");
    expect(granted.cells[0].note).toBeNull();
  });

  it("shows only pending invites, with the design's meta line", () => {
    const model = buildTeamExactModel(input());
    expect(model.invites).toHaveLength(1);
    expect(model.invites[0].email).toBe("mert@grandmix.co");
    expect(model.invites[0].meta).toBe("invited by Emrah B. · Aug 12 · expires Aug 19");
    expect(model.invites[0].role).toBe("Analyst");
  });

  it("derives access events only from what this backend stamps", () => {
    const model = buildTeamExactModel(input());
    expect(model.accessEvents).toHaveLength(4);
    expect(model.accessEvents[0].what).toContain("invited mert@grandmix.co as Analyst");
    expect(model.accessEvents.some((event) => event.what.includes("signed in"))).toBe(false);
  });

  it("carries the invite entitlement as an action state, never as a page state", () => {
    const blocked = buildTeamExactModel(input());
    expect(blocked.canInvite).toBe(false);
    expect(blocked.members).toHaveLength(3);
    expect(blocked.capabilities).toHaveLength(9);
  });
});
