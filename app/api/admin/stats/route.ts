import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAdminIntegrationHealth } from "@/lib/admin-integration-health";
import { getAdminOperationsHealth } from "@/lib/admin-operations-health";
import {
  getAdminSystemCapacity,
  summarizeAdminSystemCapacity,
} from "@/lib/admin-system-capacity";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const sql = getDb();

    const [userStats, businessStats, planStats, recentUsers, recentActivity] = await Promise.all([
      sql`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')  AS last_7d,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d,
          COUNT(*) FILTER (WHERE suspended_at IS NOT NULL)                AS suspended,
          COUNT(*) FILTER (WHERE is_superadmin = true)                   AS admins
        FROM users
      `,
      sql`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d,
          COUNT(*) FILTER (WHERE is_demo_business = true)                AS demo
        FROM businesses
      `,
      sql`
        SELECT ss.plan_id, COUNT(*) AS count
        FROM shopify_subscriptions ss
        WHERE ss.status = 'active'
        GROUP BY ss.plan_id
        ORDER BY ss.plan_id
      `,
      sql`
        SELECT id, name, email, created_at, is_superadmin, auth_provider, suspended_at
        FROM users
        ORDER BY created_at DESC
        LIMIT 8
      `,
      sql`
        SELECT al.action, al.target_type, al.meta, al.created_at,
               u.name AS admin_name
        FROM admin_audit_logs al
        JOIN users u ON u.id = al.admin_id
        ORDER BY al.created_at DESC
        LIMIT 10
      `,
    ]);

    const u = (userStats as any[])[0] ?? {};
    const b = (businessStats as any[])[0] ?? {};
    const [integrationHealth, operationsHealth, systemCapacity] = await Promise.all([
      getAdminIntegrationHealth(),
      getAdminOperationsHealth(),
      getAdminSystemCapacity({ relationLimit: 1 }),
    ]);

    return NextResponse.json({
      users: {
        total: Number(u.total ?? 0),
        last7d: Number(u.last_7d ?? 0),
        last30d: Number(u.last_30d ?? 0),
        suspended: Number(u.suspended ?? 0),
        admins: Number(u.admins ?? 0),
      },
      businesses: {
        total: Number(b.total ?? 0),
        last7d: Number(b.last_7d ?? 0),
        demo: Number(b.demo ?? 0),
      },
      planBreakdown: (planStats as any[]).map((r) => ({
        planId: r.plan_id,
        count: Number(r.count),
      })),
      recentUsers: recentUsers as any[],
      recentActivity: recentActivity as any[],
      integrationHealth: integrationHealth.summary.providers,
      integrationHealthSummary: {
        totalAffectedWorkspaces: integrationHealth.summary.totalAffectedWorkspaces,
        topIssue: integrationHealth.summary.topIssue,
      },
      authHealthSummary: operationsHealth.authHealth.summary,
      syncHealthSummary: operationsHealth.syncHealth.summary,
      revenueRiskSummary: operationsHealth.revenueRisk.summary,
      systemCapacitySummary: summarizeAdminSystemCapacity(systemCapacity),
    });
  } catch (err) {
    console.error("[admin/stats GET]", err);
    return NextResponse.json({ error: "internal_error", message: String(err) }, { status: 500 });
  }
}
