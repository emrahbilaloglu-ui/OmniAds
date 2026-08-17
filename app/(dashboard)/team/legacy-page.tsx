"use client";

/**
 * `/team` — the Dashboard v2 Team screen.
 *
 * The design draws this screen for every workspace; the plan only decides
 * whether a new seat can be added. So the entitlement check sits on the invite
 * action, not around the page: an operator on a plan without extra seats still
 * sees who has access, what each role can do and what changed. Every write
 * still passes the same server-side role gate it always did — `minRole: "admin"`
 * on `/api/team/members` and `/api/team/invites`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { TeamExact } from "@/components/team/TeamExact";
import {
  buildTeamExactModel,
  type StoredTeamRole,
  type TeamInviteSource,
  type TeamMemberSource,
} from "@/components/team/team-exact-adapter";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { PLAN_LABELS, type PlanId } from "@/lib/pricing/plans";
import { usePlanState } from "@/lib/pricing/usePlan";
import { planRank } from "@/lib/pricing/usePlanLimits";
import { useAppStore } from "@/store/app-store";

/** Adding a seat is a Scale capability; reading the roster is not. */
const SEAT_PLAN: PlanId = "scale";

function parseEmails(input: string): string[] {
  return input
    .split(/[,\n;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export default function TeamPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const businesses = useAppStore((state) => state.businesses);
  const activeBusiness = businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const { plan } = usePlanState();
  const isDemo = isDemoBusinessSelected(selectedBusinessId, businesses);

  const [members, setMembers] = useState<TeamMemberSource[]>([]);
  const [invites, setInvites] = useState<TeamInviteSource[]>([]);
  const [flash, setFlash] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [invite, setInvite] = useState<{
    emails: string;
    role: StoredTeamRole;
    scope: "all" | "this";
    pending: boolean;
  }>({ emails: "", role: "collaborator", scope: "all", pending: false });

  const showFlash = useCallback((tone: "success" | "error", text: string) => {
    setFlash({ tone, text });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  const load = useCallback(async () => {
    if (!selectedBusinessId) {
      setMembers([]);
      setInvites([]);
      return;
    }
    try {
      const query = `businessId=${encodeURIComponent(selectedBusinessId)}`;
      const [membersResponse, invitesResponse] = await Promise.all([
        fetch(`/api/team/members?${query}`, { cache: "no-store" }),
        fetch(`/api/team/invites?${query}`, { cache: "no-store" }),
      ]);
      const membersPayload = (await membersResponse.json().catch(() => null)) as {
        members?: TeamMemberSource[];
      } | null;
      const invitesPayload = (await invitesResponse.json().catch(() => null)) as {
        invites?: TeamInviteSource[];
      } | null;
      setMembers(membersPayload?.members ?? []);
      setInvites(invitesPayload?.invites ?? []);
    } catch {
      showFlash("error", "Could not load team data.");
    }
  }, [selectedBusinessId, showFlash]);

  useEffect(() => {
    void load();
  }, [load]);

  const canInvite = isDemo || planRank(plan) >= planRank(SEAT_PLAN);

  const model = useMemo(
    () =>
      buildTeamExactModel({
        members,
        invites,
        workspaceOwnerUserId: workspaceOwnerId ?? null,
        businessName: activeBusiness?.name ?? null,
        planName: PLAN_LABELS[plan] ?? null,
        // No plan in lib/pricing/plans.ts carries a seat allowance, so the meter
        // reports the count it can see and leaves the ceiling as an em dash.
        seatAllowance: null,
        canInvite,
        inviteBlockedReason: canInvite
          ? null
          : `Adding a seat needs the ${PLAN_LABELS[SEAT_PLAN]} plan. Everyone already in this workspace keeps their access.`,
      }),
    [activeBusiness?.name, canInvite, invites, members, plan, workspaceOwnerId],
  );

  async function sendInvite() {
    if (!selectedBusinessId) return;
    const emails = parseEmails(invite.emails);
    if (emails.length === 0) {
      showFlash("error", "Enter at least one email address.");
      return;
    }
    setInvite((current) => ({ ...current, pending: true }));
    let workspaceIds = [selectedBusinessId];
    if (invite.scope === "all") {
      try {
        const response = await fetch("/api/team/workspaces", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as {
          workspaces?: Array<{ id: string }>;
        } | null;
        const all = (payload?.workspaces ?? []).map((workspace) => workspace.id);
        if (all.length > 0) workspaceIds = all;
      } catch {
        // fall back to the active workspace only
      }
    }
    const response = await fetch("/api/team/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: selectedBusinessId,
        emails,
        role: invite.role,
        workspaceIds,
      }),
    });
    setInvite((current) => ({ ...current, pending: false }));
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      showFlash("error", payload?.message ?? "Could not send invites.");
      return;
    }
    setInvite((current) => ({ ...current, emails: "" }));
    await load();
    showFlash("success", "Invite created.");
  }

  async function inviteAction(inviteId: string, action: "resend" | "revoke") {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, inviteId, action }),
    });
    if (!response.ok) {
      showFlash("error", action === "resend" ? "Could not resend invite." : "Could not revoke invite.");
      return;
    }
    await load();
    showFlash("success", action === "resend" ? "Invite resent." : "Invite revoked.");
  }

  async function changeRole(membershipId: string, role: StoredTeamRole) {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId, role }),
    });
    if (!response.ok) {
      showFlash("error", "Could not update role.");
      return;
    }
    await load();
    showFlash("success", "Role updated.");
  }

  async function removeMember(membershipId: string) {
    if (!selectedBusinessId) return;
    const response = await fetch("/api/team/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId }),
    });
    if (!response.ok) {
      showFlash("error", "Could not remove member.");
      return;
    }
    await load();
    showFlash("success", "User removed.");
  }

  return (
    <TeamExact
      model={model}
      invite={invite}
      flash={flash}
      onInviteChange={(next) => setInvite((current) => ({ ...current, ...next }))}
      onSendInvite={() => void sendInvite()}
      onResendInvite={(inviteId) => void inviteAction(inviteId, "resend")}
      onRevokeInvite={(inviteId) => void inviteAction(inviteId, "revoke")}
      onChangeRole={(membershipId, role) => void changeRole(membershipId, role)}
      onRemoveMember={(membershipId) => void removeMember(membershipId)}
    />
  );
}
