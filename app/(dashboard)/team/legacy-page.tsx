"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/app-store";
import { StateBanner } from "@/components/ui/product-surface";
import { WorkspaceSurface } from "@/components/workspace/workspace-surface";
import { PlanGate } from "@/components/pricing/PlanGate";
import { cn } from "@/lib/utils";

type TeamRole = "guest" | "collaborator" | "admin";

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

/**
 * The design names four roles; this backend stores three plus an owner id.
 * Owner is the workspace owner (an admin who cannot be removed), Operator is
 * `admin`, Analyst is `collaborator`, Viewer is `guest`. The invite selector
 * only offers the three storable roles — ownership is not grantable.
 */
type DesignRole = "Owner" | "Operator" | "Analyst" | "Viewer";

const ROLE_TO_DESIGN: Record<TeamRole, DesignRole> = {
  admin: "Operator",
  collaborator: "Analyst",
  guest: "Viewer",
};

const INVITE_ROLE_OPTIONS: Array<{ value: TeamRole; label: string }> = [
  { value: "admin", label: "Operator — acts on decisions" },
  { value: "collaborator", label: "Analyst — reads + annotates" },
  { value: "guest", label: "Viewer — share links only" },
];

const ROLE_CHIP: Record<DesignRole, string> = {
  Owner: "bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]",
  Operator: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
  Analyst: "bg-[var(--adv-fill-2)] text-[var(--adv-ink-2)]",
  Viewer: "bg-[var(--adv-fill-2)] text-[var(--adv-ink-3)]",
};

/**
 * Capability rows read from the server's own gating: `minRole: "admin"` guards
 * workspace settings, membership, invites and the kill-switch release;
 * `"collaborator"` guards provider writes; `"guest"` is read access. Owner adds
 * only non-removability on top of admin.
 */
const PERM_ROWS: Array<{ k: string; cells: [boolean, boolean, boolean, boolean] }> = [
  { k: "Read every dashboard", cells: [true, true, true, true] },
  { k: "Trigger provider writes (Launchpad, automation)", cells: [true, true, true, false] },
  { k: "Invite and manage members", cells: [true, true, false, false] },
  { k: "Edit workspace settings", cells: [true, true, false, false] },
  { k: "Release the kill switch", cells: [true, true, false, false] },
  { k: "Delete the workspace", cells: [true, true, false, false] },
  { k: "Cannot be removed from the workspace", cells: [true, false, false, false] },
];

const TH =
  "bg-[var(--adv-fill)] px-4 py-[9px] text-left font-[family-name:var(--adv-font-mono)] text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--adv-ink-3)]";
const TH_TIGHT = TH.replace("px-4", "px-3");

const AVATAR_TONES = ["#2F6BFF", "#7C5CE6", "#0EA5A5", "#E0803A", "#D9475F"];

function initialsOf(name: string, email: string): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarTone(seed: string): string {
  let total = 0;
  for (let i = 0; i < seed.length; i += 1) total += seed.charCodeAt(i);
  return AVATAR_TONES[total % AVATAR_TONES.length];
}

function parseEmails(input: string): string[] {
  return input
    .split(/[,\n;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TeamPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const businesses = useAppStore((state) => state.businesses);
  const activeBusiness = businesses.find((b) => b.id === selectedBusinessId) ?? null;

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [inviteInput, setInviteInput] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("collaborator");
  const [inviteScope, setInviteScope] = useState<"all" | "this">("all");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [generatedLinks, setGeneratedLinks] = useState<Array<{ email: string; inviteUrl: string }>>(
    [],
  );

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [wsModalMember, setWsModalMember] = useState<TeamMember | null>(null);
  const [wsModalWorkspaces, setWsModalWorkspaces] = useState<Workspace[]>([]);
  const [wsModalSelected, setWsModalSelected] = useState<string[]>([]);
  const [wsModalRole, setWsModalRole] = useState<TeamRole>("collaborator");
  const [wsModalLoading, setWsModalLoading] = useState(false);

  const parsedEmails = useMemo(() => parseEmails(inviteInput), [inviteInput]);
  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === "pending"),
    [invites],
  );

  const showFlash = useCallback((type: "success" | "error", text: string) => {
    setFlash({ type, text });
    setTimeout(() => setFlash(null), 4000);
  }, []);

  const loadTeamData = useCallback(async () => {
    if (!selectedBusinessId) {
      setMembers([]);
      setInvites([]);
      return;
    }
    setLoading(true);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch(`/api/team/members?businessId=${encodeURIComponent(selectedBusinessId)}`, {
          cache: "no-store",
        }),
        fetch(`/api/team/invites?businessId=${encodeURIComponent(selectedBusinessId)}`, {
          cache: "no-store",
        }),
      ]);
      const membersJson = (await membersRes.json().catch(() => null)) as
        | { members?: TeamMember[] }
        | null;
      const invitesJson = (await invitesRes.json().catch(() => null)) as
        | { invites?: InviteRow[] }
        | null;
      setMembers(membersJson?.members ?? []);
      setInvites(invitesJson?.invites ?? []);
    } catch {
      showFlash("error", "Could not load team data.");
    } finally {
      setLoading(false);
    }
  }, [selectedBusinessId, showFlash]);

  useEffect(() => {
    void loadTeamData();
  }, [loadTeamData]);

  function designRoleFor(member: TeamMember): DesignRole {
    if (workspaceOwnerId && member.user_id === workspaceOwnerId) return "Owner";
    return ROLE_TO_DESIGN[member.role];
  }

  async function submitInvite() {
    if (!selectedBusinessId) return;
    if (parsedEmails.length === 0) {
      showFlash("error", "Enter at least one email address.");
      return;
    }
    setInviteLoading(true);
    let workspaceIds = [selectedBusinessId];
    if (inviteScope === "all") {
      try {
        const res = await fetch("/api/team/workspaces", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { workspaces?: Workspace[] } | null;
        const all = (json?.workspaces ?? []).map((w) => w.id);
        if (all.length > 0) workspaceIds = all;
      } catch {
        // fall back to the active workspace only
      }
    }
    const res = await fetch("/api/team/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: selectedBusinessId,
        emails: parsedEmails,
        role: inviteRole,
        workspaceIds,
      }),
    });
    setInviteLoading(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      showFlash("error", payload?.message ?? "Could not send invites.");
      return;
    }
    const payload = (await res.json().catch(() => null)) as
      | { invites?: Array<{ email: string; inviteUrl: string }> }
      | null;
    setGeneratedLinks(payload?.invites ?? []);
    setInviteInput("");
    await loadTeamData();
    showFlash("success", "Invite created.");
  }

  async function changeRole(membershipId: string, role: TeamRole) {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId, role }),
    });
    if (!res.ok) {
      showFlash("error", "Could not update role.");
      return;
    }
    await loadTeamData();
    showFlash("success", "Role updated.");
  }

  async function removeUser(membershipId: string) {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, membershipId }),
    });
    if (!res.ok) {
      showFlash("error", "Could not remove member.");
      return;
    }
    await loadTeamData();
    showFlash("success", "User removed.");
  }

  async function revokeInviteAction(inviteId: string) {
    if (!selectedBusinessId) return;
    const res = await fetch("/api/team/invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: selectedBusinessId, inviteId, action: "revoke" }),
    });
    if (!res.ok) {
      showFlash("error", "Could not revoke invite.");
      return;
    }
    await loadTeamData();
    showFlash("success", "Invite revoked.");
  }

  async function openWsModal(member: TeamMember) {
    setMenuFor(null);
    setWsModalMember(member);
    setWsModalRole(member.role);
    setWsModalLoading(true);
    try {
      const [wsRes, memberWsRes] = await Promise.all([
        fetch("/api/team/workspaces", { cache: "no-store" }),
        fetch(
          `/api/team/members?businessId=${encodeURIComponent(selectedBusinessId!)}&memberUserId=${encodeURIComponent(member.user_id)}`,
          { cache: "no-store" },
        ),
      ]);
      const wsJson = (await wsRes.json().catch(() => null)) as { workspaces?: Workspace[] } | null;
      const memberWsJson = (await memberWsRes.json().catch(() => null)) as
        | { workspaces?: Array<{ business_id: string }> }
        | null;
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
    if (!res.ok) {
      showFlash("error", "Could not update workspace access.");
      return;
    }
    setWsModalMember(null);
    await loadTeamData();
    showFlash("success", "Workspace access updated.");
  }

  return (
    <PlanGate requiredPlan="scale">
      <WorkspaceSurface
        eyebrow="Workspace · Access"
        title="Team"
        meta={
          <div className="text-right">
            <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[10px] uppercase tracking-[0.08em] text-[var(--adv-ink-4)]">
              Seats
            </p>
            <p className="m-0 mt-0.5 text-[12.5px] font-semibold text-[var(--adv-ink)]">
              {members.length} active
            </p>
          </div>
        }
      >
        {flash ? (
          <StateBanner
            tone={flash.type === "success" ? "success" : "danger"}
            title={flash.type === "success" ? "Team updated" : "Team action failed"}
          >
            {flash.text}
          </StateBanner>
        ) : null}

        <div className="flex flex-col gap-4">
          {/* Invite people — the design's single inline row. */}
          <article className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4">
            <h2 className="m-0 mb-2.5 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
              Invite people
            </h2>
            <div className="flex flex-wrap gap-2">
              <input
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
                placeholder="name@company.com"
                className="h-[38px] min-w-[200px] flex-1 rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-fill)] px-3 text-[13px] text-[var(--adv-ink)] outline-none focus:border-[var(--adv-accent-bd)]"
              />
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as TeamRole)}
                className="h-[38px] rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[11px] text-[13px] text-[var(--adv-ink)]"
              >
                {INVITE_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={inviteScope}
                onChange={(event) => setInviteScope(event.target.value as "all" | "this")}
                className="h-[38px] rounded-[9px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[11px] text-[13px] text-[var(--adv-ink)]"
              >
                <option value="all">All businesses</option>
                <option value="this">{activeBusiness?.name ?? "This business"} only</option>
              </select>
              <button
                type="button"
                onClick={() => void submitInvite()}
                disabled={inviteLoading || parsedEmails.length === 0}
                className="h-[38px] rounded-[9px] bg-[var(--adv-accent)] px-4 text-[13px] font-semibold text-white hover:bg-[var(--adv-accent-hover)] disabled:opacity-50"
              >
                {inviteLoading ? "Creating…" : "Send invite"}
              </button>
            </div>
            <p className="m-0 mt-[9px] text-[12px] text-[var(--adv-ink-3)]">
              Roles gate provider writes server-side — a Viewer can never trigger a Launchpad write,
              whatever the UI shows. Invites expire after 7 days.
            </p>
            {generatedLinks.length > 0 ? (
              <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--adv-hairline)] pt-3">
                {generatedLinks.map((link) => (
                  <div key={link.email} className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-[var(--adv-ink)]">
                      {link.email}
                    </span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(link.inviteUrl)}
                      className="h-[27px] rounded-[7px] border border-[var(--adv-border)] px-2.5 text-[11.5px] font-semibold text-[var(--adv-accent)]"
                    >
                      Copy invite link
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </article>

          {/* Members */}
          <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
            <div className="flex items-baseline gap-2 px-4 py-[13px]">
              <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
                Members
              </h2>
              <span className="text-[10.5px] text-[var(--adv-ink-4)]">
                {loading ? "loading…" : `${members.length} active`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={TH}>Member</th>
                    <th className={TH_TIGHT}>Role</th>
                    <th className={TH_TIGHT}>Scope</th>
                    <th className={TH_TIGHT}>2FA</th>
                    <th className={cn(TH_TIGHT, "text-right")}>Actions · 28d</th>
                    <th className={cn(TH_TIGHT, "text-right")}>Last active</th>
                    <th className={cn(TH, "w-[52px]")} />
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-6 text-[12.5px] text-[var(--adv-ink-3)]"
                      >
                        {loading ? "Loading members…" : "No members found for this workspace."}
                      </td>
                    </tr>
                  ) : (
                    members.map((member) => {
                      const role = designRoleFor(member);
                      return (
                        <tr key={member.membership_id} className="border-t border-[var(--adv-hairline)]">
                          <td className="px-4 py-[11px]">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                                style={{ background: avatarTone(member.email || member.name) }}
                              >
                                {initialsOf(member.name, member.email)}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-[13.5px] font-semibold text-[var(--adv-ink)]">
                                  {member.name || member.email}
                                </span>
                                <span className="block truncate text-[12px] text-[var(--adv-ink-3)]">
                                  {member.email}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-[11px]">
                            <span
                              className={cn(
                                "inline-flex rounded-[6px] px-[9px] py-[3px] text-[11px] font-bold",
                                ROLE_CHIP[role],
                              )}
                            >
                              {role}
                            </span>
                          </td>
                          <td className="px-3 py-[11px] text-[12.5px] text-[var(--adv-ink-2)]">
                            {activeBusiness?.name ?? "This business"}
                          </td>
                          {/* 2FA is not enforced by this backend, so the column
                              reports "not tracked" instead of asserting a state. */}
                          <td className="px-3 py-[11px]">
                            <span className="inline-flex rounded-[6px] bg-[var(--adv-fill-2)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--adv-ink-4)]">
                              —
                            </span>
                          </td>
                          <td className="px-3 py-[11px] text-right text-[12px] text-[var(--adv-ink-4)]">
                            —
                          </td>
                          <td className="px-3 py-[11px] text-right text-[12px] text-[var(--adv-ink-4)]">
                            {formatDay(member.joined_at)}
                          </td>
                          <td className="relative px-4 py-[11px] text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setMenuFor((current) =>
                                  current === member.membership_id ? null : member.membership_id,
                                )
                              }
                              className="inline-grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[var(--adv-border)] text-[13px] leading-none text-[var(--adv-ink-3)] hover:bg-[var(--adv-fill)]"
                              aria-label={`Actions for ${member.name || member.email}`}
                            >
                              ⋯
                            </button>
                            {menuFor === member.membership_id ? (
                              <div className="absolute right-4 top-[42px] z-20 w-[196px] rounded-[10px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-1 text-left shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => void openWsModal(member)}
                                  className="block w-full rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
                                >
                                  Workspace access…
                                </button>
                                {INVITE_ROLE_OPTIONS.filter(
                                  (option) => option.value !== member.role,
                                ).map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                      setMenuFor(null);
                                      void changeRole(member.membership_id, option.value);
                                    }}
                                    className="block w-full rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
                                  >
                                    Make {ROLE_TO_DESIGN[option.value]}
                                  </button>
                                ))}
                                {role !== "Owner" ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuFor(null);
                                      void removeUser(member.membership_id);
                                    }}
                                    className="block w-full rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--adc-danger-fg)] hover:bg-[var(--adv-fill)]"
                                  >
                                    Remove from workspace
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </article>

          {/* Role matrix + invites/events — the design's 1.5fr / 300px split. */}
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
            <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
              <div className="flex items-baseline gap-2 px-4 py-[13px]">
                <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
                  What each role can do
                </h2>
                <span className="text-[10.5px] text-[var(--adv-ink-4)]">
                  enforced server-side on every call
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr>
                      <th className={TH}>Capability</th>
                      <th className={cn(TH_TIGHT, "text-center")}>Owner</th>
                      <th className={cn(TH_TIGHT, "text-center")}>Operator</th>
                      <th className={cn(TH_TIGHT, "text-center")}>Analyst</th>
                      <th className={cn(TH, "text-center")}>Viewer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PERM_ROWS.map((row) => (
                      <tr key={row.k} className="border-t border-[var(--adv-hairline)]">
                        <td className="px-4 py-[9px] font-medium text-[var(--adv-ink)]">{row.k}</td>
                        {row.cells.map((allowed, index) => (
                          <td
                            key={index}
                            className={cn(
                              "px-2.5 py-[9px] text-center text-[12px] font-bold",
                              allowed
                                ? "text-[var(--adc-pos-fg)]"
                                : "text-[var(--adv-ink-4)]",
                            )}
                          >
                            {allowed ? "✓" : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <div className="flex flex-col gap-3">
              <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
                <div className="flex items-baseline gap-2 px-4 py-[13px]">
                  <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
                    Pending invites
                  </h2>
                  <span className="text-[10.5px] text-[var(--adv-ink-4)]">
                    {pendingInvites.length}
                  </span>
                </div>
                {pendingInvites.length === 0 ? (
                  <p className="m-0 px-4 pb-[13px] text-[12px] text-[var(--adv-ink-3)]">
                    No pending invites.
                  </p>
                ) : (
                  pendingInvites.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex items-center gap-2.5 border-t border-[var(--adv-hairline)] px-4 py-[11px]"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="m-0 truncate text-[12.5px] font-semibold text-[var(--adv-ink)]">
                          {invite.email}
                        </p>
                        <p className="m-0 mt-0.5 text-[12px] text-[var(--adv-ink-4)]">
                          invited by {invite.invited_by_name ?? invite.invited_by_email ?? "—"} ·
                          expires {formatDay(invite.expires_at)}
                        </p>
                      </div>
                      <span className="inline-flex shrink-0 rounded-[6px] bg-[var(--adv-fill-2)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--adv-ink-2)]">
                        {ROLE_TO_DESIGN[invite.role]}
                      </span>
                      <button
                        type="button"
                        onClick={() => void revokeInviteAction(invite.id)}
                        className="h-[27px] shrink-0 rounded-[7px] border border-[var(--adv-border)] px-2.5 text-[11.5px] font-semibold text-[#E11D48]"
                      >
                        Revoke
                      </button>
                    </div>
                  ))
                )}
              </article>

              <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
                <div className="px-4 py-[13px]">
                  <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
                    Recent access events
                  </h2>
                </div>
                {/* Membership changes are the only access events this backend
                    stamps; sign-ins are not recorded per user. */}
                {members.length === 0 ? (
                  <p className="m-0 px-4 pb-2 text-[12px] text-[var(--adv-ink-3)]">
                    No access events recorded.
                  </p>
                ) : (
                  [...members]
                    .sort((a, b) => Date.parse(b.joined_at ?? "") - Date.parse(a.joined_at ?? ""))
                    .slice(0, 4)
                    .map((member) => (
                      <div
                        key={member.membership_id}
                        className="flex items-start gap-2.5 px-4 py-2.5"
                      >
                        <span className="w-[52px] shrink-0 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
                          {formatDay(member.joined_at)}
                        </span>
                        <p className="m-0 text-[12px] leading-[1.5] text-[var(--adv-ink-2)]">
                          <b className="text-[var(--adv-ink)]">{member.name || member.email}</b>{" "}
                          joined as {designRoleFor(member)}.
                        </p>
                      </div>
                    ))
                )}
                <p className="m-0 px-4 py-2.5 text-[12px] text-[var(--adv-ink-4)]">
                  full audit trail lives in the Automation ledger
                </p>
              </article>
            </div>
          </div>
        </div>

        {/* Workspace access modal — reached from the row's ⋯ menu. */}
        {wsModalMember ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(11,16,32,0.46)] p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) setWsModalMember(null);
            }}
          >
            <div className="w-full max-w-md rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-5 shadow-lg">
              <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
                Workspace access
              </h2>
              <p className="m-0 mt-1 text-[12.5px] text-[var(--adv-ink-3)]">
                Configure which workspaces{" "}
                <span className="font-semibold text-[var(--adv-ink)]">{wsModalMember.name}</span> can
                access.
              </p>

              {wsModalLoading ? (
                <p className="mt-4 text-[12.5px] text-[var(--adv-ink-3)]">Loading…</p>
              ) : (
                <>
                  <div className="mt-4">
                    <p className="m-0 text-[12px] font-semibold text-[var(--adv-ink-3)]">
                      Role in selected workspaces
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {INVITE_ROLE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setWsModalRole(option.value)}
                          className={cn(
                            "h-8 rounded-full border px-3 text-[12px] font-semibold",
                            wsModalRole === option.value
                              ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                              : "border-[var(--adv-border)] text-[var(--adv-ink-2)]",
                          )}
                        >
                          {ROLE_TO_DESIGN[option.value]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <p className="m-0 text-[12px] font-semibold text-[var(--adv-ink-3)]">
                        Workspaces
                      </p>
                      <button
                        type="button"
                        className="text-[11px] text-[var(--adv-ink-3)] hover:text-[var(--adv-ink)]"
                        onClick={() =>
                          wsModalSelected.length === wsModalWorkspaces.length
                            ? setWsModalSelected([])
                            : setWsModalSelected(wsModalWorkspaces.map((w) => w.id))
                        }
                      >
                        {wsModalSelected.length === wsModalWorkspaces.length
                          ? "Deselect all"
                          : "Select all"}
                      </button>
                    </div>
                    <div className="mt-2 max-h-52 divide-y divide-[var(--adv-hairline)] overflow-y-auto rounded-[10px] border border-[var(--adv-border)]">
                      {wsModalWorkspaces.map((ws) => (
                        <label
                          key={ws.id}
                          className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-[var(--adv-fill)]"
                        >
                          <input
                            type="checkbox"
                            checked={wsModalSelected.includes(ws.id)}
                            onChange={() =>
                              setWsModalSelected((prev) =>
                                prev.includes(ws.id)
                                  ? prev.filter((x) => x !== ws.id)
                                  : [...prev, ws.id],
                              )
                            }
                            className="rounded"
                          />
                          <span className="text-[12.5px] text-[var(--adv-ink)]">{ws.name}</span>
                        </label>
                      ))}
                      {wsModalWorkspaces.length === 0 ? (
                        <p className="m-0 px-3 py-3 text-[12.5px] text-[var(--adv-ink-3)]">
                          No workspaces found.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setWsModalMember(null)}
                  disabled={wsModalLoading}
                  className="h-[34px] rounded-[9px] border border-[var(--adv-border)] px-3.5 text-[12.5px] font-semibold text-[var(--adv-ink-2)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveWsModal()}
                  disabled={wsModalLoading}
                  className="h-[34px] rounded-[9px] bg-[var(--adv-accent)] px-3.5 text-[12.5px] font-semibold text-white hover:bg-[var(--adv-accent-hover)]"
                >
                  {wsModalLoading ? "Saving…" : "Save access"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </WorkspaceSurface>
    </PlanGate>
  );
}
