import { NextRequest, NextResponse } from "next/server";
import { MembershipRole } from "@/lib/auth";
import {
  createInvite,
  listInvitesByBusiness,
  resendInvite,
  revokeInvite,
} from "@/lib/account-store";
import { requireBusinessAccess } from "@/lib/access";
import { resolveRequestLanguage } from "@/lib/request-language";

interface InviteBody {
  businessId?: string;
  emails?: string[];
  role?: MembershipRole;
  workspaceIds?: string[];
}

interface InviteActionBody {
  businessId?: string;
  inviteId?: string;
  action?: "revoke" | "resend";
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;
  const invites = await listInvitesByBusiness(businessId!);
  return NextResponse.json({ invites });
}

export async function POST(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const body = (await request.json().catch(() => null)) as InviteBody | null;
  const businessId = body?.businessId ?? null;
  const role = body?.role ?? "collaborator";
  const emails = Array.isArray(body?.emails)
    ? body!.emails
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const workspaceIds = Array.isArray(body?.workspaceIds) ? body!.workspaceIds.filter(Boolean) : [];
  if (emails.length === 0) {
    return NextResponse.json({ error: "invalid_payload", message: language === "tr" ? "En az bir email gerekli." : "At least one email is required." }, { status: 400 });
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "admin" });
  if ("error" in access) return access.error;

  const created = [];
  for (const email of emails) {
    const invite = await createInvite({
      email,
      businessId: businessId!,
      role,
      invitedByUserId: access.session.user.id,
      workspaceIds: workspaceIds.length > 0 ? workspaceIds : undefined,
    });
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
    created.push({
      ...invite,
      email,
      role,
      inviteUrl: `${baseUrl}/invite/${invite.token}`,
    });
  }
  return NextResponse.json({ invites: created }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const language = await resolveRequestLanguage(request);
  const body = (await request.json().catch(() => null)) as InviteActionBody | null;
  const businessId = body?.businessId ?? null;
  const inviteId = body?.inviteId ?? "";
  const action = body?.action;
  if (!inviteId || !action) {
    return NextResponse.json(
      { error: "invalid_payload", message: language === "tr" ? "inviteId ve action zorunludur." : "inviteId and action are required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "admin" });
  if ("error" in access) return access.error;

  if (action === "revoke") {
    await revokeInvite({ inviteId, businessId: businessId! });
    return NextResponse.json({ status: "ok" });
  }

  if (action === "resend") {
    // Same admin gate as issuing one, because a resend mints a new token.
    const reissued = await resendInvite({ inviteId, businessId: businessId! });
    if (!reissued) {
      return NextResponse.json(
        {
          error: "invite_not_pending",
          message:
            language === "tr"
              ? "Bu davet beklemede değil, yeniden gönderilemez."
              : "That invite is not pending, so it cannot be resent.",
        },
        { status: 409 },
      );
    }
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
    return NextResponse.json({
      status: "ok",
      invite: { id: reissued.id, expiresAt: reissued.expires_at },
      inviteUrl: `${baseUrl}/invite/${reissued.token}`,
    });
  }

  return NextResponse.json({ status: "ok" });
}
