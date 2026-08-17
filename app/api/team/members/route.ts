import { NextRequest, NextResponse } from "next/server";
import { MembershipRole } from "@/lib/auth";
import {
  getBusinessMemberActionCounts,
  getMemberWorkspaces,
  listBusinessMembers,
  MEMBER_ACTION_WINDOW_DAYS,
  removeMember,
  updateMemberRole,
  updateMemberWorkspaces,
} from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";

interface UpdateMemberBody {
  businessId?: string;
  membershipId?: string;
  role?: MembershipRole;
  action?: "update_workspaces";
  memberUserId?: string;
  workspaceIds?: string[];
}

interface RemoveMemberBody {
  businessId?: string;
  membershipId?: string;
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const memberUserId = request.nextUrl.searchParams.get("memberUserId");
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (memberUserId) {
    const workspaces = await getMemberWorkspaces(memberUserId, access.session.user.id);
    return NextResponse.json({ workspaces });
  }

  const members = await listBusinessMembers(businessId!);
  // The Team screen's "Actions · 28d" column. `null` means the write ledger
  // could not be read, and every member's count stays absent so the column can
  // say "unknown" instead of a false zero.
  const actionCounts = await getBusinessMemberActionCounts(businessId!);
  return NextResponse.json({
    members: (members as Array<{ user_id: string }>).map((member) => ({
      ...member,
      action_count: actionCounts ? (actionCounts[member.user_id] ?? 0) : null,
    })),
    actionWindowDays: MEMBER_ACTION_WINDOW_DAYS,
  });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as UpdateMemberBody | null;
  const businessId = body?.businessId ?? null;
  const access = await requireBusinessAccess({ request, businessId, minRole: "admin" });
  if ("error" in access) return access.error;

  if (body?.action === "update_workspaces") {
    const memberUserId = body?.memberUserId ?? "";
    const workspaceIds = Array.isArray(body?.workspaceIds) ? body!.workspaceIds : [];
    const role = body?.role ?? "collaborator";
    if (!memberUserId) {
      return NextResponse.json({ error: "invalid_payload", message: "memberUserId is required." }, { status: 400 });
    }
    await updateMemberWorkspaces({
      memberUserId,
      adminUserId: access.session.user.id,
      workspaceIds,
      role,
    });
    return NextResponse.json({ status: "ok" });
  }

  const membershipId = body?.membershipId ?? "";
  const role = body?.role;
  if (!membershipId || !role) {
    return NextResponse.json({ error: "invalid_payload", message: "membershipId and role are required." }, { status: 400 });
  }
  await updateMemberRole({ membershipId, businessId: businessId!, role });
  return NextResponse.json({ status: "ok" });
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as RemoveMemberBody | null;
  const businessId = body?.businessId ?? null;
  const membershipId = body?.membershipId ?? "";
  if (!membershipId) {
    return NextResponse.json({ error: "invalid_payload", message: "membershipId is required." }, { status: 400 });
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "admin" });
  if ("error" in access) return access.error;
  await removeMember({ membershipId, businessId: businessId! });
  return NextResponse.json({ status: "ok" });
}

