/**
 * Membership reads and role comparison, with no transport concerns.
 *
 * Split out of `lib/access.ts` so the shared authorizer can depend on the data
 * layer without importing the module that depends on it. `lib/access.ts`
 * re-exports everything here, so existing callers are unaffected.
 */
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { MembershipRole } from "@/lib/auth";
import type { BusinessTimezoneSource } from "@/lib/business-timezone-types";

export interface MembershipRecord {
  id: string;
  userId: string;
  businessId: string;
  role: MembershipRole;
  status: "active" | "invited" | "pending";
  joinedAt: string;
}

const ROLE_WEIGHT: Record<MembershipRole, number> = {
  guest: 1,
  collaborator: 2,
  admin: 3,
};

export function hasRole(required: MembershipRole, actual: MembershipRole): boolean {
  return ROLE_WEIGHT[actual] >= ROLE_WEIGHT[required];
}

/**
 * Distinguishes "schema not migrated" from "no such membership".
 *
 * `findMembership` cannot: it returns null for both, which is correct for its
 * callers but leaves the authorizer unable to say why access was refused.
 */
export async function findMembershipResult(input: {
  userId: string;
  businessId: string;
}): Promise<{ schemaReady: boolean; membership: MembershipRecord | null }> {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { schemaReady: false, membership: null };
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT id, user_id, business_id, role, status, joined_at
    FROM memberships
    WHERE user_id = ${input.userId} AND business_id = ${input.businessId}
    LIMIT 1
  `) as Array<{
    id: string;
    user_id: string;
    business_id: string;
    role: MembershipRole;
    status: "active" | "invited" | "pending";
    joined_at: string;
  }>;
  const row = rows[0];
  if (!row) return { schemaReady: true, membership: null };
  return {
    schemaReady: true,
    membership: {
      id: row.id,
      userId: row.user_id,
      businessId: row.business_id,
      role: row.role,
      status: row.status,
      joinedAt: row.joined_at,
    },
  };
}

export async function findMembership(input: {
  userId: string;
  businessId: string;
}): Promise<MembershipRecord | null> {
  return (await findMembershipResult(input)).membership;
}

export async function listUserBusinesses(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezoneSource: BusinessTimezoneSource;
    currency: string;
    role: MembershipRole;
    membershipStatus: "active" | "invited" | "pending";
    isDemoBusiness?: boolean;
    industry?: string;
    platform?: string;
  }>
> {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT
      b.id,
      b.name,
      b.timezone,
      b.timezone_source,
      b.currency,
      b.is_demo_business,
      b.industry,
      b.platform,
      m.role,
      m.status
    FROM memberships m
    JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ${userId}
    ORDER BY b.created_at ASC
  `) as Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezone_source: BusinessTimezoneSource;
    currency: string;
    is_demo_business?: boolean;
    industry?: string | null;
    platform?: string | null;
    role: MembershipRole;
    status: "active" | "invited" | "pending";
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    timezoneSource: row.timezone_source,
    currency: row.currency,
    role: row.role,
    membershipStatus: row.status,
    isDemoBusiness: Boolean(row.is_demo_business),
    industry: typeof row.industry === "string" ? row.industry : undefined,
    platform: typeof row.platform === "string" ? row.platform : undefined,
  }));
}
