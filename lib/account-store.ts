import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { MembershipRole } from "@/lib/auth";
import type { AppLanguage } from "@/lib/i18n";
import type { BusinessTimezoneSource } from "@/lib/business-timezone-types";

async function assertAccountStoreTablesReady(
  tables: string[],
  context: string,
) {
  await assertDbSchemaReady({
    tables,
    context,
  });
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  avatar: string | null;
  language: AppLanguage;
  created_at: string;
  suspended_at?: string | null;
  last_login_at?: string | null;
  is_superadmin?: boolean;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["users"],
  });
  if (!readiness.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at, suspended_at, last_login_at, is_superadmin
    FROM users
    WHERE lower(email) = lower(${email})
    LIMIT 1
  `) as UserRow[];
  return rows[0] ?? null;
}

export async function getUserById(userId: string): Promise<UserRow | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["users"],
  });
  if (!readiness.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `) as UserRow[];
  return rows[0] ?? null;
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  language?: AppLanguage;
}): Promise<UserRow> {
  await assertAccountStoreTablesReady(["users"], "account_store:create_user");
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO users (name, email, password_hash, language)
    VALUES (${input.name.trim()}, ${input.email.trim().toLowerCase()}, ${input.passwordHash}, ${input.language ?? "en"})
    RETURNING id, name, email, password_hash, avatar, language, created_at
  `) as UserRow[];
  return rows[0] as UserRow;
}

export async function updateUserProfile(input: {
  userId: string;
  name?: string;
  language?: AppLanguage;
}): Promise<UserRow> {
  await assertAccountStoreTablesReady(["users"], "account_store:update_user_profile");
  const sql = getDb();
  const rows = (await sql`
    UPDATE users
    SET
      name = COALESCE(${input.name?.trim() ?? null}, name),
      language = COALESCE(${input.language ?? null}, language)
    WHERE id = ${input.userId}
    RETURNING id, name, email, password_hash, avatar, language, created_at
  `) as UserRow[];
  return rows[0] as UserRow;
}

export async function updateUserPassword(input: {
  userId: string;
  passwordHash: string;
}): Promise<void> {
  await assertAccountStoreTablesReady(["users"], "account_store:update_user_password");
  const sql = getDb();
  await sql`
    UPDATE users
    SET password_hash = ${input.passwordHash}
    WHERE id = ${input.userId}
  `;
}

/**
 * Find an existing user by Google ID or email, or create a new one.
 * Used by the "Sign in with Google" OAuth flow.
 */
export async function findOrCreateGoogleUser(input: {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
}): Promise<UserRow> {
  await assertAccountStoreTablesReady(["users"], "account_store:find_or_create_google_user");
  const sql = getDb();

  // First try to find by google_id
  const byGoogleId = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at
    FROM users WHERE google_id = ${input.googleId} LIMIT 1
  `) as UserRow[];
  if (byGoogleId[0]) return byGoogleId[0];

  // Then try to find by email (existing password user linking their Google)
  const byEmail = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at
    FROM users WHERE lower(email) = lower(${input.email}) LIMIT 1
  `) as UserRow[];
  if (byEmail[0]) {
    // Link Google ID to existing account
    await sql`
      UPDATE users
      SET google_id = ${input.googleId},
          avatar = COALESCE(users.avatar, ${input.avatar})
      WHERE id = ${byEmail[0].id}
    `;
    return { ...byEmail[0], avatar: byEmail[0].avatar ?? input.avatar };
  }

  // Create new user (no password — Google-only account)
  const created = (await sql`
    INSERT INTO users (name, email, password_hash, avatar, google_id, auth_provider, language)
    VALUES (${input.name.trim()}, ${input.email.trim().toLowerCase()}, '', ${input.avatar}, ${input.googleId}, 'google', 'en')
    RETURNING id, name, email, password_hash, avatar, language, created_at
  `) as UserRow[];
  return created[0] as UserRow;
}

/**
 * Find an existing user by Facebook ID or email, or create a new one.
 * Used by the "Sign in with Facebook" OAuth flow.
 */
export async function findOrCreateFacebookUser(input: {
  facebookId: string;
  email: string;
  name: string;
  avatar: string | null;
}): Promise<UserRow> {
  await assertAccountStoreTablesReady(["users"], "account_store:find_or_create_facebook_user");
  const sql = getDb();

  // First try to find by facebook_id
  const byFacebookId = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at
    FROM users WHERE facebook_id = ${input.facebookId} LIMIT 1
  `) as UserRow[];
  if (byFacebookId[0]) return byFacebookId[0];

  // Then try to find by email (existing user linking their Facebook)
  const byEmail = (await sql`
    SELECT id, name, email, password_hash, avatar, language, created_at
    FROM users WHERE lower(email) = lower(${input.email}) LIMIT 1
  `) as UserRow[];
  if (byEmail[0]) {
    // Link Facebook ID to existing account
    await sql`
      UPDATE users
      SET facebook_id = ${input.facebookId},
          avatar = COALESCE(users.avatar, ${input.avatar})
      WHERE id = ${byEmail[0].id}
    `;
    return { ...byEmail[0], avatar: byEmail[0].avatar ?? input.avatar };
  }

  // Create new user (no password — Facebook-only account)
  const created = (await sql`
    INSERT INTO users (name, email, password_hash, avatar, facebook_id, auth_provider, language)
    VALUES (${input.name.trim()}, ${input.email.trim().toLowerCase()}, '', ${input.avatar}, ${input.facebookId}, 'facebook', 'en')
    RETURNING id, name, email, password_hash, avatar, language, created_at
  `) as UserRow[];
  return created[0] as UserRow;
}

export async function createBusinessWithAdminMembership(input: {
  name: string;
  ownerId: string;
  currency: string;
}): Promise<{
  id: string;
  name: string;
  timezone: string | null;
  timezoneSource: BusinessTimezoneSource;
  currency: string;
}> {
  await assertAccountStoreTablesReady(
    ["businesses", "memberships"],
    "account_store:create_business_with_admin_membership",
  );
  const sql = getDb();
  const businessRows = (await sql`
    INSERT INTO businesses (name, owner_id, timezone, timezone_source, currency)
    VALUES (${input.name.trim()}, ${input.ownerId}, NULL, NULL, ${input.currency})
    RETURNING id, name, timezone, timezone_source, currency
  `) as Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezone_source: BusinessTimezoneSource;
    currency: string;
  }>;
  const business = businessRows[0] as {
    id: string;
    name: string;
    timezone: string | null;
    timezone_source: BusinessTimezoneSource;
    currency: string;
  };
  await sql`
    INSERT INTO memberships (user_id, business_id, role, status)
    VALUES (${input.ownerId}, ${business.id}, 'admin', 'active')
    ON CONFLICT (user_id, business_id)
    DO UPDATE SET role = 'admin', status = 'active'
  `;
  return {
    id: business.id,
    name: business.name,
    timezone: business.timezone,
    timezoneSource: business.timezone_source,
    currency: business.currency,
  };
}

export async function updateBusinessCurrency(
  businessId: string,
  currency: string,
): Promise<void> {
  await assertAccountStoreTablesReady(["businesses"], "account_store:update_business_currency");
  const sql = getDb();
  await sql`
    UPDATE businesses
    SET currency = ${currency.trim().toUpperCase()}
    WHERE id = ${businessId}
  `;
}

export async function getBusinessTimezone(businessId: string): Promise<string | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT timezone
    FROM businesses
    WHERE id = ${businessId}
    LIMIT 1
  `) as Array<{ timezone: string | null }>;
  return typeof rows[0]?.timezone === "string" ? rows[0].timezone : null;
}

/**
 * The currency a business's money is denominated in.
 *
 * Returns null when it cannot be established so callers render an unavailable
 * amount rather than assuming a currency the money is not actually in.
 */
export async function getBusinessCurrency(businessId: string): Promise<string | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT currency
    FROM businesses
    WHERE id = ${businessId}
    LIMIT 1
  `) as Array<{ currency: string | null }>;
  const currency = rows[0]?.currency;
  return typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : null;
}

export async function updateBusinessSettings(input: {
  businessId: string;
  name: string;
  currency: string;
}): Promise<{
  id: string;
  name: string;
  timezone: string | null;
  timezoneSource: BusinessTimezoneSource;
  currency: string;
}> {
  await assertAccountStoreTablesReady(["businesses"], "account_store:update_business_settings");
  const sql = getDb();
  const rows = (await sql`
    UPDATE businesses
    SET
      name = ${input.name.trim()},
      currency = ${input.currency.trim().toUpperCase()}
    WHERE id = ${input.businessId}
    RETURNING id, name, timezone, timezone_source, currency
  `) as Array<{
    id: string;
    name: string;
    timezone: string | null;
    timezone_source: BusinessTimezoneSource;
    currency: string;
  }>;
  return {
    id: rows[0]!.id,
    name: rows[0]!.name,
    timezone: rows[0]!.timezone,
    timezoneSource: rows[0]!.timezone_source,
    currency: rows[0]!.currency,
  };
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await assertAccountStoreTablesReady(["sessions"], "account_store:revoke_all_user_sessions");
  const sql = getDb();
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

export async function listOwnedWorkspaces(userId: string): Promise<Array<{ id: string; name: string }>> {
  const readiness = await getDbSchemaReadiness({
    tables: ["businesses", "memberships"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return (await sql`
    SELECT b.id, b.name
    FROM businesses b
    JOIN memberships m ON m.business_id = b.id
    WHERE m.user_id = ${userId} AND m.role = 'admin' AND m.status = 'active'
    ORDER BY b.name ASC
  `) as Array<{ id: string; name: string }>;
}

export async function getMemberWorkspaces(
  memberUserId: string,
  adminUserId: string,
): Promise<Array<{ business_id: string; business_name: string; role: MembershipRole }>> {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return (await sql`
    SELECT m.business_id, b.name AS business_name, m.role
    FROM memberships m
    JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ${memberUserId}
      AND m.status = 'active'
      AND EXISTS (
        SELECT 1 FROM memberships am
        WHERE am.user_id = ${adminUserId}
          AND am.business_id = m.business_id
          AND am.role = 'admin'
          AND am.status = 'active'
      )
    ORDER BY b.name ASC
  `) as Array<{ business_id: string; business_name: string; role: MembershipRole }>;
}

export async function updateMemberWorkspaces(input: {
  memberUserId: string;
  adminUserId: string;
  workspaceIds: string[];
  role: MembershipRole;
}): Promise<void> {
  await assertAccountStoreTablesReady(
    ["memberships", "businesses"],
    "account_store:update_member_workspaces",
  );
  const sql = getDb();
  // Remove memberships from workspaces the admin controls but aren't in the new list
  const adminWorkspaces = await listOwnedWorkspaces(input.adminUserId);
  const adminWorkspaceIds = adminWorkspaces.map((w) => w.id);
  const toRemove = adminWorkspaceIds.filter((id) => !input.workspaceIds.includes(id));
  for (const wsId of toRemove) {
    await sql`
      DELETE FROM memberships
      WHERE user_id = ${input.memberUserId} AND business_id = ${wsId}
    `;
  }
  // Add/update memberships for selected workspaces
  for (const wsId of input.workspaceIds) {
    if (!adminWorkspaceIds.includes(wsId)) continue; // safety: only admin's workspaces
    await sql`
      INSERT INTO memberships (user_id, business_id, role, status)
      VALUES (${input.memberUserId}, ${wsId}, ${input.role}, 'active')
      ON CONFLICT (user_id, business_id)
      DO UPDATE SET role = EXCLUDED.role, status = 'active'
    `;
  }
}

export async function createInvite(input: {
  email: string;
  businessId: string;
  role: MembershipRole;
  invitedByUserId: string;
  workspaceIds?: string[];
}): Promise<{
  id: string;
  token: string;
  created_at: string;
  expires_at: string;
}> {
  await assertAccountStoreTablesReady(["invites"], "account_store:create_invite");
  const sql = getDb();
  const token = randomBytes(32).toString("hex");
  const wsIds = input.workspaceIds && input.workspaceIds.length > 0 ? input.workspaceIds : null;
  const rows = (await sql`
    INSERT INTO invites (email, business_id, role, token, status, invited_by_user_id, expires_at, workspace_ids)
    VALUES (
      ${input.email.trim().toLowerCase()},
      ${input.businessId},
      ${input.role},
      ${token},
      'pending',
      ${input.invitedByUserId},
      ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()},
      ${wsIds}
    )
    RETURNING id, token, created_at, expires_at
  `) as Array<{
    id: string;
    token: string;
    created_at: string;
    expires_at: string;
  }>;
  return rows[0] as {
    id: string;
    token: string;
    created_at: string;
    expires_at: string;
  };
}

export async function listInvitesByBusiness(businessId: string) {
  const readiness = await getDbSchemaReadiness({
    tables: ["invites", "users"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return sql`
    SELECT
      i.id,
      i.email,
      i.business_id,
      i.role,
      i.token,
      i.status,
      i.created_at,
      i.expires_at,
      i.accepted_at,
      i.invited_by_user_id,
      u.name AS invited_by_name,
      u.email AS invited_by_email
    FROM invites i
    LEFT JOIN users u ON u.id = i.invited_by_user_id
    WHERE i.business_id = ${businessId}
    ORDER BY i.created_at DESC
  `;
}

export async function getInviteByToken(token: string) {
  const readiness = await getDbSchemaReadiness({
    tables: ["invites"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT
      id,
      email,
      business_id,
      role,
      token,
      status,
      created_at,
      expires_at,
      accepted_at,
      invited_by_user_id,
      workspace_ids
    FROM invites
    WHERE token = ${token}
    LIMIT 1
  `) as Array<{
    id: string;
    email: string;
    business_id: string;
    role: MembershipRole;
    token: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
    invited_by_user_id: string | null;
    workspace_ids: string[] | null;
  }>;
  return rows[0] ?? null;
}

export async function acceptInvite(
  token: string,
  userId: string,
): Promise<{ businessId: string } | null> {
  await assertAccountStoreTablesReady(
    ["invites", "memberships"],
    "account_store:accept_invite",
  );
  const sql = getDb();
  const invite = await getInviteByToken(token);
  if (!invite || invite.status !== "pending") return null;
  const expiresAt = new Date(invite.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    await sql`UPDATE invites SET status = 'expired' WHERE id = ${invite.id}`;
    return null;
  }

  const targets = invite.workspace_ids && invite.workspace_ids.length > 0
    ? invite.workspace_ids
    : [invite.business_id];
  for (const wsId of targets) {
    await sql`
      INSERT INTO memberships (user_id, business_id, role, status)
      VALUES (${userId}, ${wsId}, ${invite.role}, 'active')
      ON CONFLICT (user_id, business_id)
      DO UPDATE SET role = EXCLUDED.role, status = 'active'
    `;
  }
  await sql`
    UPDATE invites
    SET status = 'accepted', accepted_at = now()
    WHERE id = ${invite.id}
  `;
  return { businessId: invite.business_id };
}

export async function revokeInvite(input: {
  inviteId: string;
  businessId: string;
}) {
  await assertAccountStoreTablesReady(["invites"], "account_store:revoke_invite");
  const sql = getDb();
  await sql`
    UPDATE invites
    SET status = 'revoked'
    WHERE id = ${input.inviteId}
      AND business_id = ${input.businessId}
      AND status = 'pending'
  `;
}

/**
 * Re-issues a pending invite.
 *
 * The design's invite row carries Resend beside Revoke. Resending mints a fresh
 * token and pushes the expiry out by the same seven days a new invite gets, so
 * the previously mailed link stops working — a resend that left the old token
 * live would be a second, unrevoked way in.
 *
 * Only a pending invite for this business can be re-issued; a revoked or
 * accepted one is left exactly as it is and the caller is told nothing changed.
 */
export async function resendInvite(input: {
  inviteId: string;
  businessId: string;
}): Promise<{ id: string; token: string; expires_at: string } | null> {
  await assertAccountStoreTablesReady(["invites"], "account_store:resend_invite");
  const sql = getDb();
  const token = randomBytes(32).toString("hex");
  const rows = (await sql`
    UPDATE invites
    SET token = ${token},
        expires_at = ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}
    WHERE id = ${input.inviteId}
      AND business_id = ${input.businessId}
      AND status = 'pending'
    RETURNING id, token, expires_at
  `) as Array<{ id: string; token: string; expires_at: string }>;
  return rows[0] ?? null;
}

export async function listBusinessMembers(businessId: string) {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "users"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return sql`
    SELECT
      m.id AS membership_id,
      m.user_id,
      m.business_id,
      m.role,
      m.status,
      m.joined_at,
      u.name,
      u.email,
      -- The Team screen's "Last active" column. Membership rows only carry the
      -- join date, which is not activity; the sign-in stamp is.
      u.last_login_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ${businessId}
    ORDER BY m.joined_at ASC
  `;
}

export async function updateMemberRole(input: {
  membershipId: string;
  businessId: string;
  role: MembershipRole;
}) {
  await assertAccountStoreTablesReady(["memberships"], "account_store:update_member_role");
  const sql = getDb();
  await sql`
    UPDATE memberships
    SET role = ${input.role}
    WHERE id = ${input.membershipId} AND business_id = ${input.businessId}
  `;
}

export async function removeMember(input: {
  membershipId: string;
  businessId: string;
}) {
  await assertAccountStoreTablesReady(["memberships"], "account_store:remove_member");
  const sql = getDb();
  await sql`
    DELETE FROM memberships
    WHERE id = ${input.membershipId} AND business_id = ${input.businessId}
  `;
}

export async function listAccessRequestsByBusiness(businessId: string) {
  const readiness = await getDbSchemaReadiness({
    tables: ["memberships", "users", "businesses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return sql`
    SELECT
      m.id AS membership_id,
      m.user_id,
      m.business_id,
      m.role,
      m.status,
      m.joined_at,
      u.name,
      u.email,
      b.name AS business_name
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN businesses b ON b.id = m.business_id
    WHERE m.business_id = ${businessId} AND m.status = 'pending'
    ORDER BY m.created_at DESC
  `;
}

export async function approveAccessRequest(input: {
  membershipId: string;
  businessId: string;
}) {
  await assertAccountStoreTablesReady(["memberships"], "account_store:approve_access_request");
  const sql = getDb();
  await sql`
    UPDATE memberships
    SET status = 'active'
    WHERE id = ${input.membershipId} AND business_id = ${input.businessId} AND status = 'pending'
  `;
}

export async function rejectAccessRequest(input: {
  membershipId: string;
  businessId: string;
}) {
  await assertAccountStoreTablesReady(["memberships"], "account_store:reject_access_request");
  const sql = getDb();
  await sql`
    DELETE FROM memberships
    WHERE id = ${input.membershipId} AND business_id = ${input.businessId} AND status = 'pending'
  `;
}
