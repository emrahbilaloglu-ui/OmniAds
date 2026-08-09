"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { MailPlus, MoreHorizontal, Shield, User, Users, Settings } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { ProductSection, StateBanner } from "@/components/ui/product-surface";
import {
  WorkspaceCard,
  WorkspacePill,
  WorkspaceSurface,
} from "@/components/workspace/workspace-surface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PlanGate } from "@/components/pricing/PlanGate";

type TeamRole = "guest" | "collaborator" | "admin";
type TeamTab = "members" | "invites";

interface TeamMember {
  membership_id: string;
  user_id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: "active" | "invited" | "pending";
  joined_at: string;
}

interface InviteRow {
  id: string;
  email: string;
  role: TeamRole;
  status: string;
  created_at: string;
  expires_at: string;
  token: string;
  invited_by_name?: string | null;
  invited_by_email?: string | null;
}

interface Workspace {
  id: string;
  name: string;
}

const ROLE_META: Record<TeamRole, { label: string; description: string }> = {
  guest: {
    label: "Guest",
    description: "View-only access to assigned workspaces.",
  },
  collaborator: {
    label: "Collaborator",
    description: "Can work in assigned workspaces but cannot invite.",
  },
  admin: {
    label: "Admin",
    description: "Full access. Can manage settings and invite others.",
  },
};

function parseEmails(input: string): string[] {
  return input
    .split(/[,\n;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export default function TeamPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const [activeTab, setActiveTab] = useState<TeamTab>("members");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Invite modal state
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("collaborator");
  const [inviteStep, setInviteStep] = useState<"form" | "result">("form");
  const [generatedLinks, setGeneratedLinks] = useState<Array<{ email: string; inviteUrl: string }>>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);

  // Member workspace modal state
  const [wsModalMember, setWsModalMember] = useState<TeamMember | null>(null);
  const [wsModalWorkspaces, setWsModalWorkspaces] = useState<Workspace[]>([]);
  const [wsModalSelected, setWsModalSelected] = useState<string[]>([]);
  const [wsModalRole, setWsModalRole] = useState<TeamRole>("collaborator");
  const [wsModalLoading, setWsModalLoading] = useState(false);

  const parsedEmails = useMemo(() => parseEmails(inviteInput), [inviteInput]);

  const showFlash = useCallback((type: "success" | "error", text: string) => {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  async function loadTeamData() {
    if (!selectedBusinessId) {
      setMembers([]);
      setInvites([]);
      return;
    }
    setLoading(true);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch(`/api/team/members?businessId=${encodeURIComponent(selectedBusinessId)}`, { cache: "no-store" }),
        fetch(`/api/team/invites?businessId=${encodeURIComponent(selectedBusinessId)}`, { cache: "no-store" }),
      ]);
      const membersJson = (await membersRes.json().catch(() => null)) as { members?: TeamMember[] } | null;
      const invitesJson = (await invitesRes.json().catch(() => null)) as { invites?: InviteRow[] } | null;
      setMembers(membersJson?.members ?? []);
      setInvites(invitesJson?.invites ?? []);
    } catch {
      showFlash("error", "Could not load team data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTeamData();
  }, [selectedBusinessId]);

  // Load available workspaces when invite modal opens
  async function openInviteModal() {
    setInviteOpen(true);
    setInviteStep("form");
    setInviteInput("");
    setInviteRole("collaborator");
    setGeneratedLinks([]);
    try {
      const res = await fetch("/api/team/workspaces", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { workspaces?: Workspace[] } | null;
      const wsList = json?.workspaces ?? [];
      setAvailableWorkspaces(wsList);
      // Default: all workspaces selected
      setSelectedWorkspaceIds(wsList.map((w) => w.id));
    } catch {
      setAvailableWorkspaces([]);
      setSelectedWorkspaceIds(selectedBusinessId ? [selectedBusinessId] : []);
    }
  }

  function toggleWorkspace(id: string) {
    setSelectedWorkspaceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const changeRole = async (membershipId: string, role: TeamRole) => {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId, role }),
    });
    if (!res.ok) { showFlash("error", "Could not update role."); return; }
    await loadTeamData();
    showFlash("success", "Role updated.");
  };

  const removeUser = async (membershipId: string) => {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId }),
    });
    if (!res.ok) { showFlash("error", "Could not remove member."); return; }
    await loadTeamData();
    showFlash("success", "User removed.");
  };

  const copyInviteLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    showFlash("success", "Invite link copied.");
  };

  const revokeInviteAction = async (inviteId: string) => {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, inviteId, action: "revoke" }),
    });
    if (!res.ok) { showFlash("error", "Could not revoke invite."); return; }
    await loadTeamData();
    showFlash("success", "Invite revoked.");
  };

  const submitInvite = async () => {
    if (!selectedBusinessId) return;
    if (parsedEmails.length === 0) { showFlash("error", "Enter at least one email address."); return; }
    if (selectedWorkspaceIds.length === 0) { showFlash("error", "Select at least one workspace."); return; }
    setInviteLoading(true);
    const res = await fetch("/api/team/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: selectedBusinessId,
        emails: parsedEmails,
        role: inviteRole,
        workspaceIds: selectedWorkspaceIds,
      }),
    });
    setInviteLoading(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      showFlash("error", payload?.message ?? "Could not send invites.");
      return;
    }
    const payload = (await res.json().catch(() => null)) as { invites?: Array<{ email: string; inviteUrl: string }> } | null;
    setGeneratedLinks(payload?.invites ?? []);
    setInviteStep("result");
    await loadTeamData();
  };

  // Open workspace management modal for a member
  async function openWsModal(member: TeamMember) {
    setWsModalMember(member);
    setWsModalRole(member.role);
    setWsModalLoading(true);
    try {
      const [wsRes, memberWsRes] = await Promise.all([
        fetch("/api/team/workspaces", { cache: "no-store" }),
        fetch(`/api/team/members?businessId=${encodeURIComponent(selectedBusinessId!)}&memberUserId=${encodeURIComponent(member.user_id)}`, { cache: "no-store" }),
      ]);
      const wsJson = (await wsRes.json().catch(() => null)) as { workspaces?: Workspace[] } | null;
      const memberWsJson = (await memberWsRes.json().catch(() => null)) as { workspaces?: Array<{ business_id: string }> } | null;
      setWsModalWorkspaces(wsJson?.workspaces ?? []);
      setWsModalSelected((memberWsJson?.workspaces ?? []).map((w) => w.business_id));
    } finally {
      setWsModalLoading(false);
    }
  }

  async function saveWsModal() {
    if (!wsModalMember) return;
    setWsModalLoading(true);
    const res = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: selectedBusinessId,
        action: "update_workspaces",
        memberUserId: wsModalMember.user_id,
        workspaceIds: wsModalSelected,
        role: wsModalRole,
      }),
    });
    setWsModalLoading(false);
    if (!res.ok) { showFlash("error", "Could not update workspace access."); return; }
    setWsModalMember(null);
    await loadTeamData();
    showFlash("success", "Workspace access updated.");
  }

  return (
    <PlanGate requiredPlan="scale">
    <WorkspaceSurface
      eyebrow="Workspace access"
      title="Team"
      description="Manage members and their workspace access."
      width="narrow"
      meta={<WorkspacePill tone="auto">roles are internal; clients stay scoped</WorkspacePill>}
      actions={
        <Button
          onClick={openInviteModal}
          className="gap-2 bg-[var(--adc-ink)] text-[var(--adc-s2)] hover:bg-[var(--adc-ink2)]"
          disabled={!selectedBusinessId}
        >
          <MailPlus className="h-4 w-4" />
          Invite people
        </Button>
      }
    >

      <div className="flex gap-1 border-b border-[var(--adc-b1)]">
        {(["members", "invites"] as TeamTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "rounded-t-md px-3 py-2 text-sm capitalize",
              activeTab === tab
                ? "border-b-2 border-[var(--adc-ink)] font-medium text-[var(--adc-ink)]"
                : "text-[var(--adc-ink2)] hover:text-[var(--adc-ink)]"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {flash ? (
        <StateBanner tone={flash.type === "success" ? "success" : "danger"} title={flash.type === "success" ? "Team updated" : "Team action failed"}>
          {flash.text}
        </StateBanner>
      ) : null}

      {loading ? <p className="text-[12px] text-[var(--adc-ink3)]">Loading...</p> : null}

      {activeTab === "members" ? (
        <ProductSection title="Members" description="People with access to the selected workspace.">
        <div className="overflow-x-auto rounded-[10px] border border-[var(--adc-b1)]">
          <table className="min-w-full text-[12.5px]">
            <thead className="bg-[var(--adc-s1)] font-mono text-[12px] uppercase tracking-normal text-[var(--adc-ink3)]">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Workspaces</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[12px] text-[var(--adc-ink3)]">No members yet.</td>
                </tr>
              ) : null}
              {members.map((member) => (
                <tr key={member.membership_id} className="border-t border-[var(--adc-b1)]">
                  <td className="px-4 py-3">
                    <p className="font-medium text-[var(--adc-ink)]">{member.name}</p>
                    <p className="text-[11px] text-[var(--adc-ink3)]">{member.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-[5px] border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2 py-0.5 text-[11px] text-[var(--adc-ink2)]">
                      {ROLE_META[member.role].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openWsModal(member)}
                      className="inline-flex items-center gap-1 text-[11.5px] text-[var(--adc-ink3)] hover:text-[var(--adc-ink)]"
                    >
                      <Settings className="h-3 w-3" />
                      Manage workspaces
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => changeRole(member.membership_id, "guest")}>
                          <User className="h-4 w-4" />
                          Change role to Guest
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => changeRole(member.membership_id, "collaborator")}>
                          <Users className="h-4 w-4" />
                          Change role to Collaborator
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => changeRole(member.membership_id, "admin")}>
                          <Shield className="h-4 w-4" />
                          Change role to Admin
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => removeUser(member.membership_id)}
                          className="text-destructive focus:text-destructive"
                        >
                          Remove from this workspace
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </ProductSection>
      ) : null}

      {activeTab === "invites" ? (
        <ProductSection title="Pending invites" description="Generated invitations and their current delivery status.">
        <div className="overflow-x-auto rounded-[10px] border border-[var(--adc-b1)]">
          <table className="min-w-full text-[12.5px]">
            <thead className="bg-[var(--adc-s1)] font-mono text-[12px] uppercase tracking-normal text-[var(--adc-ink3)]">
              <tr>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Invited by</th>
                <th className="px-4 py-3 text-left">Expires</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id} className="border-t border-[var(--adc-b1)]">
                  <td className="px-4 py-3">{invite.email}</td>
                  <td className="px-4 py-3">{ROLE_META[invite.role].label}</td>
                  <td className="px-4 py-3 text-[var(--adc-ink3)]">{invite.invited_by_name ?? invite.invited_by_email ?? "-"}</td>
                  <td className="px-4 py-3 font-mono text-[var(--adc-ink3)]">{new Date(invite.expires_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-[var(--adc-ink3)] capitalize">{invite.status}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyInviteLink(`${window.location.origin}/invite/${invite.token}`)}
                      >
                        Copy link
                      </Button>
                      {invite.status === "pending" ? (
                        <Button variant="outline" size="sm" onClick={() => revokeInviteAction(invite.id)}>
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {invites.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[12px] text-[var(--adc-ink3)]">No pending invites.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        </ProductSection>
      ) : null}

      <WorkspaceCard
        title="Client identities"
        description="Separate client identity rows are part of the reference design, but this backend currently exposes internal members and invites only."
        tone="auto"
      >
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--adc-ink2)]">
          <WorkspacePill tone="auto">NEEDS-SERVER-CONTRACT</WorkspacePill>
          <span>Do not fabricate client-only users here; use generated share links until a scoped client identity model exists.</span>
        </div>
      </WorkspaceCard>

      {/* Invite Modal */}
      {inviteOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,18,22,0.4)] p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setInviteOpen(false); } }}
        >
          <div className="w-full max-w-xl rounded-[10px] border border-[var(--adc-b2)] bg-[var(--adc-s2)] p-5 shadow-lg">
            <h2 className="text-base font-semibold">Invite people</h2>
            {inviteStep === "form" ? (
              <>
                <p className="mt-1 text-sm text-[var(--adc-ink3)]">
                  Add teammates by email, choose their role, and select which workspaces they can access.
                </p>

                <div className="mt-4 space-y-1.5">
                  <label className="text-xs font-medium text-[var(--adc-ink3)]">Email addresses</label>
                  <textarea
                    value={inviteInput}
                    onChange={(e) => setInviteInput(e.target.value)}
                    rows={3}
                    placeholder="name@company.com, teammate@company.com"
                    className="w-full rounded-lg border border-[var(--adc-b1)] bg-[var(--adc-s1)] p-2.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                  />
                </div>

                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-[var(--adc-ink3)]">Role</p>
                  <div className="grid gap-2">
                    {(["guest", "collaborator", "admin"] as TeamRole[]).map((role) => (
                      <button
                        key={role}
                        type="button"
                        onClick={() => setInviteRole(role)}
                        className={cn(
                          "rounded-lg border px-3 py-2 text-left",
                          inviteRole === role ? "border-[var(--adc-b2)] bg-[var(--adc-s3)]" : "hover:border-muted-foreground/30"
                        )}
                      >
                        <p className="text-sm font-medium">{ROLE_META[role].label}</p>
                        <p className="text-xs text-[var(--adc-ink3)]">{ROLE_META[role].description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {availableWorkspaces.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-[var(--adc-ink3)]">Workspace access</p>
                      <button
                        type="button"
                        className="text-xs text-[var(--adc-ink3)] hover:text-foreground"
                        onClick={() =>
                          selectedWorkspaceIds.length === availableWorkspaces.length
                            ? setSelectedWorkspaceIds([])
                            : setSelectedWorkspaceIds(availableWorkspaces.map((w) => w.id))
                        }
                      >
                        {selectedWorkspaceIds.length === availableWorkspaces.length ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                    <div className="rounded-lg border divide-y max-h-40 overflow-y-auto">
                      {availableWorkspaces.map((ws) => (
                        <label key={ws.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[var(--adc-s3)]">
                          <input
                            type="checkbox"
                            checked={selectedWorkspaceIds.includes(ws.id)}
                            onChange={() => toggleWorkspace(ws.id)}
                            className="rounded"
                          />
                          <span className="text-sm">{ws.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-3 space-y-3">
                <p className="text-sm font-medium">Invitation link created</p>
                <p className="text-xs text-[var(--adc-ink3)]">Share this link with the invited user.</p>
                <div className="space-y-2">
                  {generatedLinks.map((row) => (
                    <div key={row.email} className="rounded-lg border p-2.5">
                      <p className="text-xs text-[var(--adc-ink3)]">{row.email}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <input readOnly value={row.inviteUrl} className="h-8 flex-1 rounded-md border border-[var(--adc-b1)] bg-[var(--adc-s1)] px-2 text-xs" />
                        <Button size="sm" variant="outline" onClick={() => copyInviteLink(row.inviteUrl)}>Copy</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => { setInviteOpen(false); setInviteStep("form"); setInviteInput(""); setGeneratedLinks([]); }}
                disabled={inviteLoading}
              >
                {inviteStep === "result" ? "Close" : "Cancel"}
              </Button>
              {inviteStep === "form" ? (
                <Button onClick={submitInvite} disabled={inviteLoading || parsedEmails.length === 0 || selectedWorkspaceIds.length === 0}>
                  {inviteLoading ? "Creating..." : "Create invite"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Workspace Access Modal */}
      {wsModalMember ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,18,22,0.4)] p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setWsModalMember(null); }}
        >
          <div className="w-full max-w-md rounded-[10px] border border-[var(--adc-b2)] bg-[var(--adc-s2)] p-5 shadow-lg">
            <h2 className="text-base font-semibold">Workspace access</h2>
            <p className="mt-1 text-sm text-[var(--adc-ink3)]">
              Configure which workspaces <span className="font-medium text-foreground">{wsModalMember.name}</span> can access.
            </p>

            {wsModalLoading ? (
              <p className="mt-4 text-sm text-[var(--adc-ink3)]">Loading...</p>
            ) : (
              <>
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-[var(--adc-ink3)]">Role in selected workspaces</p>
                  <div className="flex gap-2">
                    {(["guest", "collaborator", "admin"] as TeamRole[]).map((role) => (
                      <button
                        key={role}
                        type="button"
                        onClick={() => setWsModalRole(role)}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs font-medium",
                          wsModalRole === role ? "border-[var(--adc-b2)] bg-[var(--adc-s3)]" : "hover:border-muted-foreground/30"
                        )}
                      >
                        {ROLE_META[role].label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-[var(--adc-ink3)]">Workspaces</p>
                    <button
                      type="button"
                      className="text-xs text-[var(--adc-ink3)] hover:text-foreground"
                      onClick={() =>
                        wsModalSelected.length === wsModalWorkspaces.length
                          ? setWsModalSelected([])
                          : setWsModalSelected(wsModalWorkspaces.map((w) => w.id))
                      }
                    >
                      {wsModalSelected.length === wsModalWorkspaces.length ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="rounded-lg border divide-y max-h-52 overflow-y-auto">
                    {wsModalWorkspaces.map((ws) => (
                      <label key={ws.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[var(--adc-s3)]">
                        <input
                          type="checkbox"
                          checked={wsModalSelected.includes(ws.id)}
                          onChange={() =>
                            setWsModalSelected((prev) =>
                              prev.includes(ws.id) ? prev.filter((x) => x !== ws.id) : [...prev, ws.id]
                            )
                          }
                          className="rounded"
                        />
                        <span className="text-sm">{ws.name}</span>
                      </label>
                    ))}
                    {wsModalWorkspaces.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-[var(--adc-ink3)]">No workspaces found.</p>
                    ) : null}
                  </div>
                </div>
              </>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setWsModalMember(null)} disabled={wsModalLoading}>Cancel</Button>
              <Button onClick={saveWsModal} disabled={wsModalLoading}>
                {wsModalLoading ? "Saving..." : "Save access"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </WorkspaceSurface>
    </PlanGate>
  );
}
