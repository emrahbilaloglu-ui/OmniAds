/**
 * Pure mapping from the team endpoints to the Dashboard v2 "Team" view model.
 *
 * Design reference: markup lines 2880-2987, model 4354-4381.
 *
 * The design's four roles map onto three stored roles plus the workspace owner:
 * Owner is the owner of the workspace (stored as `admin`), Operator is `admin`,
 * Analyst is `collaborator`, Viewer is `guest`. Ownership is not grantable, so
 * the invite selector only offers the three storable roles.
 *
 * Two facts the design shows have no source in this backend: per-member 2FA
 * state and a 28-day action count. Both keep their column and render the em
 * dash — the design's "2FA on" and "46 writes" are prototype seed values.
 */

export const TEAM_DASH = "—";

export type StoredTeamRole = "guest" | "collaborator" | "admin";
export type DesignTeamRole = "Owner" | "Operator" | "Analyst" | "Viewer";

export const ROLE_TO_DESIGN: Record<StoredTeamRole, DesignTeamRole> = {
  admin: "Operator",
  collaborator: "Analyst",
  guest: "Viewer",
};

export const INVITE_ROLE_OPTIONS: Array<{ value: StoredTeamRole; label: string }> = [
  { value: "admin", label: "Operator — acts on decisions" },
  { value: "collaborator", label: "Analyst — reads + annotates" },
  { value: "guest", label: "Viewer — share links only" },
];

const ROLE_CHIP: Record<DesignTeamRole, { background: string; foreground: string }> = {
  Owner: { background: "#0B1020", foreground: "#ffffff" },
  Operator: { background: "#EAF0FF", foreground: "#2F6BFF" },
  Analyst: { background: "#F1EBFB", foreground: "#6C41BE" },
  Viewer: { background: "#F1F4F9", foreground: "#45526B" },
};

const AVATAR_TONES = ["#2F6BFF", "#6C41BE", "#0E9F6E", "#7A869E", "#B45309"];

/**
 * The capability matrix, resolved from what the server actually enforces.
 *
 * The captions and their order are the design's nine (data-model.js:4361-4370).
 * The ticks are NOT the design's — they are the real `minRole` on the route
 * that performs each capability, so the table means what its own subtitle says
 * it means. Where no route implements a capability at all, every cell is the em
 * dash rather than a tick the server would not honour.
 */
export type CapabilityGate = "guest" | "collaborator" | "admin" | "owner" | "none";

export const TEAM_CAPABILITIES: Array<{ label: string; gate: CapabilityGate }> = [
  { label: "View dashboards & evidence", gate: "guest" },
  { label: "Open share-link reports", gate: "guest" },
  // No comment or annotation write route exists on this backend.
  { label: "Comment & annotate", gate: "none" },
  { label: "Approve automation proposals", gate: "collaborator" },
  { label: "Launch drafts · provider writes", gate: "collaborator" },
  { label: "Edit Commercial Truth pack", gate: "collaborator" },
  { label: "Manage integrations", gate: "collaborator" },
  { label: "Invite & manage members", gate: "admin" },
  // `/api/billing` POST authenticates but does not check a workspace role.
  { label: "Billing & plan", gate: "guest" },
];

const GATE_RANK: Record<Exclude<CapabilityGate, "none">, number> = {
  guest: 0,
  collaborator: 1,
  admin: 2,
  owner: 3,
};

const ROLE_RANK: Record<DesignTeamRole, number> = {
  Viewer: 0,
  Analyst: 1,
  Operator: 2,
  Owner: 3,
};

export interface TeamMemberSource {
  membership_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  role: StoredTeamRole;
  joined_at: string | null;
  last_login_at?: string | null;
}

export interface TeamInviteSource {
  id: string;
  email: string;
  role: StoredTeamRole;
  status: string;
  created_at: string | null;
  expires_at: string | null;
  invited_by_name?: string | null;
  invited_by_email?: string | null;
}

export interface TeamMemberModel {
  membershipId: string;
  userId: string;
  initials: string;
  avatarBackground: string;
  name: string;
  email: string;
  role: DesignTeamRole;
  storedRole: StoredTeamRole;
  roleBackground: string;
  roleForeground: string;
  scope: string;
  twoFactor: string;
  twoFactorBackground: string;
  twoFactorForeground: string;
  actions: string;
  lastActive: string;
  removable: boolean;
}

export interface TeamInviteModel {
  id: string;
  email: string;
  meta: string;
  role: DesignTeamRole;
}

export interface TeamCapabilityRowModel {
  label: string;
  cells: Array<{ value: string; foreground: string }>;
}

export interface TeamAccessEventModel {
  id: string;
  time: string;
  who: string;
  what: string;
}

export interface TeamSeatsModel {
  eyebrow: string;
  value: string;
  /** CSS width for the meter fill; "0%" when the allowance is unknown. */
  fill: string;
}

export interface TeamExactModel {
  eyebrow: string;
  title: string;
  seats: TeamSeatsModel;
  memberCount: string;
  members: TeamMemberModel[];
  invites: TeamInviteModel[];
  capabilities: TeamCapabilityRowModel[];
  accessEvents: TeamAccessEventModel[];
  scopeOptions: Array<{ value: "all" | "this"; label: string }>;
  /** False when the plan does not entitle this workspace to add seats. */
  canInvite: boolean;
  inviteBlockedReason: string | null;
}

export interface TeamAdapterInput {
  members: TeamMemberSource[];
  invites: TeamInviteSource[];
  workspaceOwnerUserId: string | null;
  businessName: string | null;
  planName: string | null;
  /** Seat allowance for the plan, or null when the plan model has no seats. */
  seatAllowance: number | null;
  canInvite: boolean;
  inviteBlockedReason: string | null;
}

function initialsOf(name: string, email: string): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarTone(seed: string): string {
  let total = 0;
  for (let index = 0; index < seed.length; index += 1) total += seed.charCodeAt(index);
  return AVATAR_TONES[total % AVATAR_TONES.length];
}

function formatDay(value: string | null | undefined): string {
  if (!value) return TEAM_DASH;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return TEAM_DASH;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function buildTeamExactModel(input: TeamAdapterInput): TeamExactModel {
  const scopeLabel = input.businessName?.trim() || TEAM_DASH;

  const members: TeamMemberModel[] = input.members.map((member) => {
    const name = member.name?.trim() || member.email?.trim() || TEAM_DASH;
    const email = member.email?.trim() || TEAM_DASH;
    const role: DesignTeamRole =
      input.workspaceOwnerUserId && member.user_id === input.workspaceOwnerUserId
        ? "Owner"
        : ROLE_TO_DESIGN[member.role];
    const chip = ROLE_CHIP[role];
    return {
      membershipId: member.membership_id,
      userId: member.user_id,
      initials: initialsOf(member.name ?? "", member.email ?? ""),
      avatarBackground: avatarTone(member.email || member.name || member.user_id),
      name,
      email,
      role,
      storedRole: member.role,
      roleBackground: chip.background,
      roleForeground: chip.foreground,
      scope: role === "Viewer" ? "Share links only" : scopeLabel,
      // Neither of the next three has a source on this backend.
      twoFactor: TEAM_DASH,
      twoFactorBackground: "#F1F4F9",
      twoFactorForeground: "#98A4BA",
      actions: TEAM_DASH,
      lastActive: formatDay(member.last_login_at ?? null),
      removable: role !== "Owner",
    };
  });

  const pending = input.invites.filter((invite) => invite.status === "pending");
  const invites: TeamInviteModel[] = pending.map((invite) => ({
    id: invite.id,
    email: invite.email,
    meta: `invited by ${
      invite.invited_by_name?.trim() || invite.invited_by_email?.trim() || TEAM_DASH
    } · ${formatDay(invite.created_at)} · expires ${formatDay(invite.expires_at)}`,
    role: ROLE_TO_DESIGN[invite.role],
  }));

  const capabilities: TeamCapabilityRowModel[] = TEAM_CAPABILITIES.map((capability) => ({
    label: capability.label,
    cells: (["Owner", "Operator", "Analyst", "Viewer"] as DesignTeamRole[]).map((role) => {
      if (capability.gate === "none") return { value: TEAM_DASH, foreground: "#C9D2E0" };
      const allowed = ROLE_RANK[role] >= GATE_RANK[capability.gate];
      return allowed
        ? { value: "✓", foreground: "#0E9F6E" }
        : { value: TEAM_DASH, foreground: "#C9D2E0" };
    }),
  }));

  /**
   * Access events this backend can actually evidence: a membership that began
   * and an invite that was issued. Sign-ins are not journalled per workspace,
   * so no sign-in line is claimed.
   */
  const accessEvents: TeamAccessEventModel[] = [
    ...input.members.map((member) => ({
      id: `member:${member.membership_id}`,
      at: member.joined_at,
      who: member.name?.trim() || member.email?.trim() || TEAM_DASH,
      what: `joined as ${
        input.workspaceOwnerUserId && member.user_id === input.workspaceOwnerUserId
          ? "Owner"
          : ROLE_TO_DESIGN[member.role]
      }`,
    })),
    ...pending.map((invite) => ({
      id: `invite:${invite.id}`,
      at: invite.created_at,
      who: invite.invited_by_name?.trim() || invite.invited_by_email?.trim() || TEAM_DASH,
      what: `invited ${invite.email} as ${ROLE_TO_DESIGN[invite.role]}`,
    })),
  ]
    .sort((left, right) => Date.parse(right.at ?? "") - Date.parse(left.at ?? ""))
    .slice(0, 4)
    .map((event) => ({
      id: event.id,
      time: formatDay(event.at),
      who: event.who,
      what: event.what,
    }));

  const used = members.length;
  const allowance = input.seatAllowance;
  const planLabel = input.planName?.trim();

  return {
    eyebrow: "Workspace · Access",
    title: "Team",
    seats: {
      eyebrow: planLabel ? `Seats · ${planLabel} plan` : `Seats · ${TEAM_DASH} plan`,
      value: `${used} of ${allowance === null ? TEAM_DASH : allowance} used`,
      fill:
        allowance === null || allowance <= 0
          ? "0%"
          : `${Math.min(100, (used / allowance) * 100).toFixed(0)}%`,
    },
    memberCount: `${used} active`,
    members,
    invites,
    capabilities,
    accessEvents,
    scopeOptions: [
      { value: "all", label: "All businesses" },
      { value: "this", label: `${scopeLabel} only` },
    ],
    canInvite: input.canInvite,
    inviteBlockedReason: input.inviteBlockedReason,
  };
}
