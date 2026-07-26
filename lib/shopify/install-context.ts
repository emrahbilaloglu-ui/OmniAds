import crypto from "crypto";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { sanitizeNextPath } from "@/lib/auth-routing";

export interface ShopifyInstallContextRow {
  id: string;
  token: string;
  shop_domain: string;
  shop_name: string | null;
  access_token: string;
  scopes: string | null;
  metadata: Record<string, unknown>;
  return_to: string | null;
  session_id: string | null;
  user_id: string | null;
  preferred_business_id: string | null;
  created_at: string;
  expires_at: string;
}

function buildExpiryDate() {
  return new Date(Date.now() + 30 * 60 * 1000);
}

function sanitizeUuid(value: string | null | undefined) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function createShopifyInstallContext(input: {
  shopDomain: string;
  shopName?: string | null;
  accessToken: string;
  scopes?: string | null;
  metadata?: Record<string, unknown>;
  returnTo?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  preferredBusinessId?: string | null;
}): Promise<ShopifyInstallContextRow> {
  await assertDbSchemaReady({
    tables: ["shopify_install_contexts"],
    context: "shopify_install_context_create",
  });
  const sql = getDb();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = buildExpiryDate().toISOString();
  const metadataJson = JSON.stringify(input.metadata ?? {});

  const rows = (await sql`
    INSERT INTO shopify_install_contexts (
      token,
      shop_domain,
      shop_name,
      access_token,
      scopes,
      metadata,
      return_to,
      session_id,
      user_id,
      preferred_business_id,
      expires_at
    )
    VALUES (
      ${token},
      ${input.shopDomain},
      ${input.shopName ?? null},
      ${input.accessToken},
      ${input.scopes ?? null},
      ${metadataJson}::jsonb,
      ${sanitizeNextPath(input.returnTo) ?? null},
      ${input.sessionId ?? null},
      ${input.userId ?? null},
      ${sanitizeUuid(input.preferredBusinessId) ?? null},
      ${expiresAt}
    )
    RETURNING *
  `) as ShopifyInstallContextRow[];

  return rows[0] as ShopifyInstallContextRow;
}

export async function getShopifyInstallContext(
  token: string,
): Promise<ShopifyInstallContextRow | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) {
    return null;
  }
  const sql = getDb();
  await sql`DELETE FROM shopify_install_contexts WHERE expires_at <= now()`;
  const rows = (await sql`
    SELECT *
    FROM shopify_install_contexts
    WHERE token = ${token}
      AND expires_at > now()
    LIMIT 1
  `) as ShopifyInstallContextRow[];
  return rows[0] ?? null;
}

export type ShopifyInstallContextClaim =
  | { ok: true; context: ShopifyInstallContextRow }
  | { ok: false; reason: "not_found" | "not_your_context" };

/**
 * Claim an install context exactly once, for the actor it was created for.
 *
 * Two defects, both closed by making this one statement.
 *
 * It was a SELECT followed by a DELETE, so two finalizers racing on the same
 * token both read the row and both proceeded to connect a shop — two
 * integrations, two webhook registrations, from one grant. `DELETE ...
 * RETURNING` makes the claim itself the mutation: exactly one caller can ever
 * receive the row.
 *
 * And it was consumed by TOKEN ALONE. The token is created during the Shopify
 * redirect and carries the shop's access token; anyone who obtained it could
 * finalize it into a business they had access to, binding someone else's shop
 * to their own account. The claim now also requires the session or user the
 * context was created for, when the context recorded one.
 */
export async function consumeShopifyInstallContext(input: {
  token: string;
  sessionId?: string | null;
  userId?: string | null;
}): Promise<ShopifyInstallContextClaim> {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) return { ok: false, reason: "not_found" };

  const sql = getDb();
  const sessionId = sanitizeUuid(input.sessionId);
  const userId = sanitizeUuid(input.userId);

  const claimed = (await sql`
    DELETE FROM shopify_install_contexts
    WHERE token = ${input.token}
      AND expires_at > now()
      AND (session_id IS NULL OR session_id = ${sessionId}::uuid)
      AND (user_id IS NULL OR user_id = ${userId}::uuid)
    RETURNING *
  `) as ShopifyInstallContextRow[];
  if (claimed[0]) return { ok: true, context: claimed[0] };

  // Distinguish "no such context" from "that context is not yours", so the
  // caller can say something true without leaking whether a token exists to
  // someone who does not own it.
  const exists = (await sql`
    SELECT 1 FROM shopify_install_contexts
    WHERE token = ${input.token} AND expires_at > now()
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  return {
    ok: false,
    reason: exists.length > 0 ? "not_your_context" : "not_found",
  };
}

/**
 * Put a claimed context back after a failed finalize.
 *
 * The claim is destructive by design, so a finalize that fails AFTER claiming —
 * a credential write that errors, a database blip — would otherwise have
 * destroyed the only copy of the shop's access token and forced the user to
 * reinstall. Restoring it makes that failure explicitly retryable, with a
 * shorter window because the grant is already older than it was.
 */
export async function restoreShopifyInstallContext(
  context: ShopifyInstallContextRow,
): Promise<void> {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) return;
  const sql = getDb();
  await sql`
    INSERT INTO shopify_install_contexts (
      token, shop_domain, shop_name, access_token, scopes, metadata,
      return_to, session_id, user_id, preferred_business_id, expires_at
    ) VALUES (
      ${context.token}, ${context.shop_domain}, ${context.shop_name},
      ${context.access_token}, ${context.scopes},
      ${JSON.stringify(context.metadata ?? {})}::jsonb,
      ${context.return_to}, ${context.session_id}, ${context.user_id},
      ${context.preferred_business_id},
      ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}
    )
    ON CONFLICT (token) DO NOTHING
  `;
}

export async function getLatestShopifyInstallContextForActor(input: {
  sessionId?: string | null;
  userId?: string | null;
}): Promise<ShopifyInstallContextRow | null> {
  const sessionId = sanitizeUuid(input.sessionId);
  const userId = sanitizeUuid(input.userId);
  if (!sessionId && !userId) return null;

  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) {
    return null;
  }
  const sql = getDb();
  await sql`DELETE FROM shopify_install_contexts WHERE expires_at <= now()`;

  const rows = (await sql`
    SELECT *
    FROM shopify_install_contexts
    WHERE expires_at > now()
      AND (
        (${sessionId}::uuid IS NOT NULL AND session_id = ${sessionId}::uuid)
        OR (${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
      )
    ORDER BY created_at DESC
    LIMIT 1
  `) as ShopifyInstallContextRow[];

  return rows[0] ?? null;
}
