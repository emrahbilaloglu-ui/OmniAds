import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TeamExact } from "@/components/team/TeamExact";
import { buildTeamExactModel } from "@/components/team/team-exact-adapter";

const model = buildTeamExactModel({
  members: [
    {
      membership_id: "m1",
      user_id: "u1",
      name: "Emrah B.",
      email: "emrah@grandmix.co",
      role: "admin",
      joined_at: "2026-03-02T09:00:00.000Z",
      last_login_at: "2026-08-17T07:10:00.000Z",
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
  ],
  workspaceOwnerUserId: "u1",
  businessName: "Grandmix",
  planName: "Growth",
  seatAllowance: null,
  canInvite: true,
  inviteBlockedReason: null,
});

function render(overrides: Partial<React.ComponentProps<typeof TeamExact>> = {}) {
  return renderToStaticMarkup(
    React.createElement(TeamExact, {
      model,
      invite: { emails: "", role: "collaborator", scope: "all", pending: false },
      flash: null,
      onInviteChange: () => {},
      onSendInvite: () => {},
      onResendInvite: () => {},
      onRevokeInvite: () => {},
      onChangeRole: () => {},
      onRemoveMember: () => {},
      ...overrides,
    }),
  );
}

const source = readFileSync("components/team/TeamExact.tsx", "utf8");
const routeSource = readFileSync("app/(dashboard)/team/legacy-page.tsx", "utf8");

describe("TeamExact", () => {
  it("draws the screen itself, never an upsell in its place", () => {
    const html = render();
    expect(html).toContain("Workspace · Access");
    expect(html).toContain(">Team</h1>");
    expect(html).toContain("Invite people");
    expect(html).toContain("Members");
    expect(html).toContain("What each role can do");
    expect(source).not.toContain("PlanGate");
    expect(routeSource).not.toContain("PlanGate");
  });

  it("renders the seat meter with its track and fill", () => {
    const html = render();
    expect(html).toContain("Seats · Growth plan");
    expect(html).toContain("1 of — used");
    expect(html).toContain("width:0%");
  });

  it("uses the design's member columns", () => {
    const html = render();
    for (const header of ["Member", "Role", "Scope", "2FA", "Actions · 28d", "Last active"]) {
      expect(html).toContain(header);
    }
    expect(html).toContain("Aug 17");
  });

  it("uses the design's invite placeholder and role options", () => {
    const html = render();
    expect(html).toContain("teammate@company.com");
    expect(html).toContain("Operator — acts on decisions");
    expect(html).toContain("Analyst — reads + annotates");
    expect(html).toContain("Viewer — share links only");
    expect(html).toContain("All businesses");
    expect(html).toContain("Grandmix only");
    expect(html).toContain("Invites expire after 7 days.");
  });

  it("gives every pending invite a Resend beside its Revoke", () => {
    const html = render();
    expect(html).toContain("Resend");
    expect(html).toContain("Revoke");
    expect(html).toContain("invited by Emrah B. · Aug 12 · expires Aug 19");
  });

  it("keeps the invite entitlement on the action, disabling only the button", () => {
    const blocked = buildTeamExactModel({
      members: [],
      invites: [],
      workspaceOwnerUserId: null,
      businessName: "Grandmix",
      planName: "Growth",
      seatAllowance: null,
      canInvite: false,
      inviteBlockedReason: "Adding a seat needs the Scale plan.",
    });
    const html = render({ model: blocked });
    expect(html).toContain("Adding a seat needs the Scale plan.");
    expect(html).toContain("disabled");
    expect(html).toContain("What each role can do");
    expect(html).toContain("Recent access events");
  });

  it("draws no workspace-access modal and no generated invite links", () => {
    const html = render();
    expect(html).not.toContain("Workspace access");
    expect(html).not.toContain("Copy invite link");
    expect(source).not.toContain("Copy invite link");
    expect(source).not.toContain("Select all");
  });

  it("closes the events card with the design's mono footer", () => {
    const html = render();
    expect(html).toContain("full audit trail lives in the Automation ledger");
  });
});
