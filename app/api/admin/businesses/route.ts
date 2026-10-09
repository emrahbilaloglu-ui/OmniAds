import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim() ?? "";
    const plan   = searchParams.get("plan") ?? "";
    const page   = Math.max(1, Number(searchParams.get("page") ?? 1));
    const limit  = 30;
    const offset = (page - 1) * limit;

    const sql = getDb();

    const condParams: unknown[] = [];
    const conditions: string[] = [];
    if (search) {
      condParams.push(`%${search}%`);
      const n = condParams.length;
      conditions.push(`(b.name ILIKE $${n} OR u.email ILIKE $${n} OR u.name ILIKE $${n})`);
    }
    if (plan) {
      condParams.push(plan);
      conditions.push(`COALESCE(b.plan_override, ss.plan_id, 'starter') = $${condParams.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitIdx  = condParams.length + 1;
    const offsetIdx = condParams.length + 2;
    const listParams = [...condParams, limit, offset];

    const [bizResult, countResult] = await Promise.all([
      sql.query(`
        SELECT
          b.id, b.name, b.created_at, b.plan_override, b.is_demo_business,
          dj.status AS deletion_status, dj.error_code AS deletion_error, dj.hidden_at AS removed_at,
          u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
          ss.plan_id, ss.status AS subscription_status,
          COUNT(DISTINCT m.user_id) AS member_count,
          COUNT(DISTINCT pc.id) AS integration_count
        FROM businesses b
        JOIN users u ON u.id = b.owner_id
        LEFT JOIN shopify_subscriptions ss ON ss.business_id = b.id AND ss.status = 'active'
        LEFT JOIN memberships m ON m.business_id = b.id AND m.status = 'active'
        LEFT JOIN provider_connections pc ON pc.business_id = b.id::text AND pc.status = 'connected'
        LEFT JOIN business_deletion_jobs dj ON dj.business_ref_id=b.id
        ${where}
        GROUP BY b.id, u.id, ss.plan_id, ss.status, dj.business_ref_id
        ORDER BY b.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, listParams),
      sql.query(`
        SELECT COUNT(DISTINCT b.id) AS total
        FROM businesses b
        JOIN users u ON u.id = b.owner_id
        LEFT JOIN shopify_subscriptions ss ON ss.business_id = b.id AND ss.status = 'active'
        ${where}
      `, condParams),
    ]);

    return NextResponse.json({
      businesses: bizResult as any[],
      total: Number((countResult as any[])[0]?.total ?? 0),
      page,
      limit,
    });
  } catch (err) {
    console.error("[admin/businesses GET]", err);
    return NextResponse.json({ error: "internal_error", message: String(err) }, { status: 500 });
  }
}
