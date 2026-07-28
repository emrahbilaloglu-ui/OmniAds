import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb, runDbTransaction } from "@/lib/db";
import { PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE } from "@/lib/provider-account-assignments";
import { logAdminAction } from "@/lib/admin-logger";
import { PLAN_ORDER } from "@/lib/pricing/plans";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const { businessId } = await params;
    const sql = getDb();

    const [businesses, members, integrations, subscription] = await Promise.all([
      sql`
        SELECT b.id, b.name, b.created_at, b.timezone, b.currency, b.plan_override, b.is_demo_business,
               u.id AS owner_id, u.name AS owner_name, u.email AS owner_email
        FROM businesses b
        JOIN users u ON u.id = b.owner_id
        WHERE b.id = ${businessId}
        LIMIT 1
      `,
      sql`
        SELECT m.id, m.role, m.status, m.joined_at,
               u.id AS user_id, u.name AS user_name, u.email AS user_email,
               u.suspended_at, u.is_superadmin
        FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.business_id = ${businessId}
        ORDER BY m.joined_at ASC
      `,
      sql`
        SELECT provider, status, created_at
        FROM provider_connections
        WHERE business_id = ${businessId}::text
        ORDER BY provider
      `,
      sql`
        SELECT plan_id, status, billing_cycle, created_at, updated_at
        FROM shopify_subscriptions
        WHERE business_id = ${businessId}
        ORDER BY created_at DESC
        LIMIT 1
      `,
    ]);

    const business = (businesses as any[])[0];
    if (!business) {
      return NextResponse.json({ error: "not_found", message: "Workspace bulunamadı." }, { status: 404 });
    }

    return NextResponse.json({
      business,
      members,
      integrations,
      subscription: (subscription as any[])[0] ?? null,
    });
  } catch (err) {
    console.error("[admin/businesses/[businessId] GET]", err);
    return NextResponse.json({ error: "internal_error", message: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const { businessId } = await params;
    const body = await request.json().catch(() => null);
    const sql = getDb();

    if ("planOverride" in (body ?? {})) {
      const planOverride = body.planOverride;
      if (planOverride !== null && !PLAN_ORDER.includes(planOverride)) {
        return NextResponse.json({ error: "invalid_payload", message: "Geçersiz plan." }, { status: 400 });
      }
      await sql`UPDATE businesses SET plan_override = ${planOverride} WHERE id = ${businessId}`;
      await logAdminAction({
        adminId: auth.session!.user.id,
        action: "business.plan_override",
        targetType: "business",
        targetId: businessId,
        meta: { planOverride },
      });
    }

    if (body?.removeMemberId) {
      await sql`DELETE FROM memberships WHERE business_id = ${businessId} AND user_id = ${body.removeMemberId}`;
      await logAdminAction({
        adminId: auth.session!.user.id,
        action: "business.remove_member",
        targetType: "business",
        targetId: businessId,
        meta: { removedUserId: body.removeMemberId },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/businesses/[businessId] PATCH]", err);
    return NextResponse.json({ error: "internal_error", message: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const { businessId } = await params;
    const sql = getDb();

    const rows = (await sql`SELECT name FROM businesses WHERE id = ${businessId} LIMIT 1`) as any[];

    // This used to be a bare `DELETE FROM businesses`. provider_connections
    // references the business by a TEXT column with no foreign key (its only FK
    // is business_ref_id, declared ON DELETE SET NULL), so the connection rows
    // survived the delete with status='connected' and integration_credentials
    // still holding live encrypted OAuth tokens — orphaned indefinitely, with
    // no UI left that could reach them to disconnect. Several other tables
    // reference businesses ON DELETE RESTRICT, so the bare delete also simply
    // failed for any business that had ever run Meta observation.
    //
    // This is the same transactional, advisory-locked teardown the user-facing
    // delete already performs.
    await runDbTransaction(async () => {
      const tx = getDb();
      await tx`
        SELECT pg_advisory_xact_lock(
          ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
          hashtext(${`provider_account_selection:business:${businessId}`})
        )
      `;
      await tx`DELETE FROM memberships WHERE business_id = ${businessId}`;
      await tx`DELETE FROM invites WHERE business_id = ${businessId}`;
      await tx`DELETE FROM business_cost_models WHERE business_id = ${businessId}`;
      await tx`DELETE FROM provider_account_snapshot_runs WHERE business_id = ${businessId}`;
      await tx`DELETE FROM business_provider_accounts WHERE business_id = ${businessId}`;
      await tx`DELETE FROM provider_connections WHERE business_id = ${businessId}`;
      await tx`
        DELETE FROM creative_share_snapshots
        WHERE payload->>'businessId' = ${businessId}
      `;
      await tx`DELETE FROM businesses WHERE id = ${businessId}`;
      await tx`
        UPDATE sessions
        SET active_business_id = NULL
        WHERE active_business_id = ${businessId}
      `;
    });

    await logAdminAction({
      adminId: auth.session!.user.id,
      action: "business.delete",
      targetType: "business",
      targetId: businessId,
      meta: { name: rows[0]?.name },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/businesses/[businessId] DELETE]", err);
    return NextResponse.json({ error: "internal_error", message: String(err) }, { status: 500 });
  }
}
