/**
 * The real `/api/team/*` contracts.
 *
 * Written from the handlers, not from what a team surface might wish for:
 *
 * - `GET /api/team/members?businessId=` → `{members}`, rows selected as
 *   `membership_id, user_id, business_id, role, status, name, email`. There is
 *   no `id` column on a member row; reading one gave every row `undefined` and
 *   the previous surface keyed on the array index instead.
 * - `PATCH /api/team/members` takes `{businessId, membershipId, role}` **or**
 *   `{businessId, action: "update_workspaces", memberUserId, workspaceIds}`.
 * - `DELETE /api/team/members` takes `{businessId, membershipId}`.
 * - `GET /api/team/members?businessId=&memberUserId=` → `{workspaces}` — the
 *   same route, a different response, selected by a query parameter.
 * - `GET /api/team/invites?businessId=` → `{invites}`;
 *   `POST` takes `{businessId, emails[], role, workspaceIds}` and answers 201
 *   with `{invites}`; `PATCH` takes `{businessId, inviteId, action: "revoke"}`.
 * - `GET/POST /api/team/access-requests` — POST takes
 *   `{businessId, membershipId, action: "approve" | "reject"}`.
 * - `GET /api/team/workspaces` → `{workspaces}`, session-scoped, no businessId.
 *
 * Role gates are the handlers' own: members/invites GET admit `guest`;
 * every write and both access-request verbs require `admin`.
 */

export type TeamRole = "admin" | "collaborator" | "reviewer" | "guest";

/** Minimum role each operation's handler enforces. */
export const TEAM_MIN_ROLE = {
  membersRead: "guest",
  membersWrite: "admin",
  invitesRead: "guest",
  invitesWrite: "admin",
  accessRequestsRead: "admin",
  accessRequestsWrite: "admin",
} as const satisfies Record<string, TeamRole>;

const ROLE_RANK: Record<string, number> = {
  guest: 0,
  reviewer: 1,
  collaborator: 2,
  admin: 3,
};

/**
 * Can this viewer perform this operation?
 *
 * Mirrors `requireBusinessAccess({minRole})`. The UI must refuse before the
 * request, and the refusal must name the role that would be required — a
 * disabled control with no reason reads as a bug.
 */
export function teamPermission(input: {
  role: string | null;
  operation: keyof typeof TEAM_MIN_ROLE;
}): { ok: true } | { ok: false; reason: string } {
  const required = TEAM_MIN_ROLE[input.operation];
  const have = ROLE_RANK[input.role ?? ""] ?? -1;
  if (have >= ROLE_RANK[required]) return { ok: true };
  return {
    ok: false,
    reason: `This needs the ${required} role. Your role on this workspace is ${input.role ?? "not reported"}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface TeamMember {
  /** `membership_id` — the id every write takes. Never the array index. */
  membershipId: string;
  userId: string | null;
  name: string;
  email: string | null;
  role: string;
  status: string;
}

export function adaptMembers(raw: unknown): TeamMember[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return null;
  return raw.members.filter(isRecord).flatMap((row) => {
    // The write routes are keyed by membership id; a row without one cannot be
    // acted on, so it is not offered as if it could be.
    const membershipId = text(row.membership_id) ?? text(row.membershipId);
    if (!membershipId) return [];
    return [
      {
        membershipId,
        userId: text(row.user_id) ?? text(row.userId),
        name: text(row.name) ?? text(row.email) ?? "(name not served)",
        email: text(row.email),
        role: text(row.role) ?? "not reported",
        status: text(row.status) ?? "not reported",
      },
    ];
  });
}

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  status: string;
}

export function adaptInvites(raw: unknown): TeamInvite[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.invites)) return null;
  return raw.invites.filter(isRecord).flatMap((row) => {
    const id = text(row.id) ?? text(row.invite_id);
    if (!id) return [];
    return [
      {
        id,
        email: text(row.email) ?? "(email not served)",
        role: text(row.role) ?? "not reported",
        status: text(row.status) ?? "not reported",
      },
    ];
  });
}

export interface AccessRequest {
  membershipId: string;
  name: string;
  email: string | null;
  role: string;
}

export function adaptAccessRequests(raw: unknown): AccessRequest[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.requests)) return null;
  return raw.requests.filter(isRecord).flatMap((row) => {
    const membershipId = text(row.membership_id) ?? text(row.membershipId) ?? text(row.id);
    if (!membershipId) return [];
    return [
      {
        membershipId,
        name: text(row.name) ?? text(row.email) ?? "(name not served)",
        email: text(row.email),
        role: text(row.role) ?? "not reported",
      },
    ];
  });
}

export interface Workspace {
  id: string;
  name: string;
}

export function adaptWorkspaces(raw: unknown): Workspace[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.workspaces)) return null;
  return raw.workspaces.filter(isRecord).flatMap((row) => {
    const id = text(row.id) ?? text(row.workspace_id);
    if (!id) return [];
    return [{ id, name: text(row.name) ?? id }];
  });
}

/* ------------------------------------------------------------------ bodies */

export function memberRoleBody(input: { businessId: string; membershipId: string; role: string }) {
  return { businessId: input.businessId, membershipId: input.membershipId, role: input.role };
}

export function memberWorkspacesBody(input: {
  businessId: string;
  memberUserId: string;
  workspaceIds: readonly string[];
}) {
  return {
    businessId: input.businessId,
    // The handler branches on this action; without it the role branch runs and
    // refuses for a missing role.
    action: "update_workspaces" as const,
    memberUserId: input.memberUserId,
    workspaceIds: [...input.workspaceIds],
  };
}

export function removeMemberBody(input: { businessId: string; membershipId: string }) {
  return { businessId: input.businessId, membershipId: input.membershipId };
}

export function inviteBody(input: {
  businessId: string;
  emails: readonly string[];
  role: string;
  workspaceIds?: readonly string[];
}): { businessId: string; emails: string[]; role: string; workspaceIds?: string[] } | { error: string } {
  const emails = input.emails.map((email) => email.trim()).filter(Boolean);
  if (emails.length === 0) {
    // The handler answers 400 for this; refusing here keeps the round trip out.
    return { error: "At least one email address is required." };
  }
  return {
    businessId: input.businessId,
    emails,
    role: input.role,
    ...(input.workspaceIds ? { workspaceIds: [...input.workspaceIds] } : {}),
  };
}

export function revokeInviteBody(input: { businessId: string; inviteId: string }) {
  return { businessId: input.businessId, inviteId: input.inviteId, action: "revoke" as const };
}

export function accessRequestBody(input: {
  businessId: string;
  membershipId: string;
  action: "approve" | "reject";
}) {
  return { businessId: input.businessId, membershipId: input.membershipId, action: input.action };
}
