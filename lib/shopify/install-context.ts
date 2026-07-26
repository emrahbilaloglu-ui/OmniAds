import crypto from "crypto";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { sanitizeNextPath } from "@/lib/auth-routing";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  IntegrationSecretKeyRequiredError,
  IntegrationSecretUnreadableError,
  isEncryptedIntegrationSecret,
  isIntegrationSecretKeyRequiredError,
  isIntegrationSecretUnreadableError,
} from "@/lib/integration-secrets";
import {
  getIntegration,
  upsertIntegration,
  type IntegrationRow,
} from "@/lib/integrations";
import { registerShopifyCustomerEventsPixel } from "@/lib/shopify/pixels";
import type { ShopifyGrantGuardedInput } from "@/lib/shopify/webhooks";
import { registerShopifySyncWebhooks } from "@/lib/shopify/webhooks";

export interface ShopifyInstallContextRow {
  id: string;
  token: string;
  shop_domain: string;
  shop_name: string | null;
  /**
   * PLAINTEXT on every row this module hands out, and CIPHERTEXT in every row it
   * writes. `encryptInstallContextToken` and `readInstallContextRow` are the only
   * two places that cross that boundary.
   */
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

/**
 * The at-rest form of a shop's Admin API access token, or a refusal.
 *
 * This table held the token in PLAINTEXT while the very same secret was
 * encrypted the instant it became an integration credential — so a dump, a
 * backup, a replica or one `SELECT` by anyone with read access handed over a
 * live shop credential. The scheme is not a new one: it is exactly
 * `lib/integration-secrets.ts`, keyed by `INTEGRATION_TOKEN_ENCRYPTION_KEY`.
 *
 * It THROWS rather than degrading. A missing key is the case in which a
 * "best effort" encryption silently writes the plaintext it was supposed to
 * remove, and a context that was never created is a failed install the user
 * retries — while a plaintext row is a leaked credential nobody notices. The
 * post-encryption assertion is not decoration either: `encryptIntegrationSecret`
 * returns its input unchanged for an already-encrypted value and `null` for an
 * empty one, so "it returned something" is not the same as "it returned
 * ciphertext".
 */
function encryptInstallContextToken(accessToken: string): string {
  if (!accessToken || accessToken.trim().length === 0) {
    throw new IntegrationSecretKeyRequiredError(
      "A Shopify install context cannot be created without an access token.",
    );
  }
  const encrypted = encryptIntegrationSecret(accessToken);
  if (!encrypted || !isEncryptedIntegrationSecret(encrypted)) {
    throw new IntegrationSecretKeyRequiredError(
      "Refusing to persist a Shopify install context whose access token is not encrypted.",
    );
  }
  return encrypted;
}

/**
 * Turn a stored row into one whose `access_token` is the shop's actual token.
 *
 * `decryptIntegrationSecret` passes a value through unchanged when it carries no
 * `enc:v1` prefix, which is what makes rows written before this change readable
 * during the transition, and it THROWS for a value that carries the prefix and
 * cannot be decrypted. That distinction is the whole contract: ciphertext must
 * never be returned as if it were the token — it would be sent to Shopify as a
 * bearer credential, stored as an integration credential, and compared against
 * the stored grant, all of which fail in ways that look like something else.
 */
function readInstallContextRow(
  row: ShopifyInstallContextRow,
): ShopifyInstallContextRow {
  const accessToken = decryptIntegrationSecret(row.access_token);
  if (!accessToken) {
    throw new IntegrationSecretUnreadableError(
      "A Shopify install context holds no readable access token.",
    );
  }
  return { ...row, access_token: accessToken };
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
  // Before the INSERT, deliberately: a throw here means no row exists at all,
  // which is the only outcome that cannot leave a plaintext credential behind.
  const accessToken = encryptInstallContextToken(input.accessToken);

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
      ${accessToken},
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

  // Read back through the same door every other caller uses, so a stored value
  // that cannot be decrypted fails HERE — while the install can still be
  // restarted — rather than at the finalize that has already spent the grant.
  return readInstallContextRow(rows[0] as ShopifyInstallContextRow);
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
  return rows[0] ? readInstallContextRow(rows[0]) : null;
}

export type ShopifyInstallContextClaim =
  | { ok: true; context: ShopifyInstallContextRow }
  | { ok: false; reason: "not_found" | "not_your_context" | "wrong_business" };

/**
 * Claim an install context exactly once, for the actor AND the business it was
 * created for.
 *
 * Three defects, all closed by making this one statement.
 *
 * It was a SELECT followed by a DELETE, so two finalizers racing on the same
 * token both read the row and both proceeded to connect a shop — two
 * integrations, two webhook registrations, from one grant. `DELETE ...
 * RETURNING` makes the claim itself the mutation: exactly one caller can ever
 * receive the row.
 *
 * It was consumed by TOKEN ALONE. The token is created during the Shopify
 * redirect and carries the shop's access token; anyone who obtained it could
 * finalize it into a business they had access to, binding someone else's shop
 * to their own account. The claim now also requires the session or user the
 * context was created for, when the context recorded one.
 *
 * And the actor binding alone was still not the grant the user consented to. A
 * user who belongs to two businesses starts an install for business A, and a
 * finalize naming business B passed every check — same session, same user — so
 * the shop landed on the wrong business, with the wrong members able to read its
 * orders and revenue. When the context recorded a target business, the claim
 * now requires the finalize to name exactly that business; a mismatch is refused
 * and the grant is left intact for the correct one.
 *
 * `targetBusinessId` is mandatory rather than optional because an optional
 * binding is no binding: any caller that forgot to pass it would silently get
 * the old, unbound behaviour back.
 */
export async function consumeShopifyInstallContext(input: {
  token: string;
  sessionId?: string | null;
  userId?: string | null;
  targetBusinessId: string;
}): Promise<ShopifyInstallContextClaim> {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) return { ok: false, reason: "not_found" };

  const sql = getDb();
  const sessionId = sanitizeUuid(input.sessionId);
  const userId = sanitizeUuid(input.userId);
  // A target that is not a well-formed uuid can never equal a recorded
  // `preferred_business_id`, so the predicate below refuses every context that
  // named a business. That is the correct direction to fail in.
  const targetBusinessId = sanitizeUuid(input.targetBusinessId);

  const claimed = (await sql`
    DELETE FROM shopify_install_contexts
    WHERE token = ${input.token}
      AND expires_at > now()
      AND (session_id IS NULL OR session_id = ${sessionId}::uuid)
      AND (user_id IS NULL OR user_id = ${userId}::uuid)
      AND (
        preferred_business_id IS NULL
        OR preferred_business_id = ${targetBusinessId}::uuid
      )
    RETURNING *
  `) as ShopifyInstallContextRow[];
  // A claimed row whose token cannot be decrypted throws rather than returning
  // ciphertext. The claim is destructive, so the grant is spent either way — and
  // between "the user reinstalls" and "we send a base64 blob to Shopify as a
  // bearer token and store it as the business's credential", only the first is a
  // recoverable state.
  if (claimed[0]) return { ok: true, context: readInstallContextRow(claimed[0]) };

  // Distinguish "no such context" from "that context is not yours" and from
  // "that context belongs to a different business", so the caller can say
  // something true without leaking whether a token exists to someone who does
  // not own it. Identity is decided first: a stranger holding the token must
  // never learn which business the install was started for.
  const existing = (await sql`
    SELECT session_id::text AS session_id,
           user_id::text AS user_id,
           preferred_business_id::text AS preferred_business_id
    FROM shopify_install_contexts
    WHERE token = ${input.token} AND expires_at > now()
    LIMIT 1
  `) as Array<{
    session_id: string | null;
    user_id: string | null;
    preferred_business_id: string | null;
  }>;
  const row = existing[0];
  if (!row) return { ok: false, reason: "not_found" };
  const actorMatches =
    (row.session_id == null || row.session_id === sessionId) &&
    (row.user_id == null || row.user_id === userId);
  if (!actorMatches) return { ok: false, reason: "not_your_context" };
  return { ok: false, reason: "wrong_business" };
}

/**
 * What happened to the one copy of the shop's access token when a finalize was
 * put back.
 *
 * Explicit outcomes rather than `void`, because "we restored it" and "we
 * deliberately did not" are different things to tell a user, and the caller must
 * not be free to describe a discarded grant as retryable.
 */
export type ShopifyInstallContextRestoreOutcome =
  | "restored"
  | "expired"
  | "already_present"
  | "unavailable";

/**
 * Put a claimed context back after a finalize that provably did not persist it.
 *
 * The claim is destructive by design, so a finalize that fails AFTER claiming —
 * a database blip during the credential write — would otherwise have destroyed
 * the only copy of the shop's access token and forced the user to reinstall.
 *
 * Restoring is nonetheless a resurrection of a live credential, and the previous
 * version resurrected it unconditionally:
 *
 *   - it rewrote `expires_at` to `now() + 5 minutes`, which EXTENDS a context
 *     that was seconds from expiry and revives one that had already expired, so
 *     a grant outlived the window the user consented to. The expiry is now
 *     clamped with `LEAST` to the original, and an already-expired context is
 *     never re-inserted at all;
 *
 *   - it swallowed `ON CONFLICT DO NOTHING`, so a token that another process had
 *     legitimately re-created was reported as restored when nothing was written.
 *     The outcome now says which happened;
 *
 *   - and `created_at` defaulted to `now()`, which made a restored context look
 *     newer than contexts created after it and moved it to the front of
 *     `getLatestShopifyInstallContextForActor`. The original is carried over.
 *
 * The caller is responsible for the harder half: never calling this after the
 * credential has actually landed, and never calling it for a failure a retry
 * cannot fix. See `finalizeShopifyInstall`.
 */
export async function restoreShopifyInstallContext(
  context: ShopifyInstallContextRow,
): Promise<ShopifyInstallContextRestoreOutcome> {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts"],
  });
  if (!readiness.ready) return "unavailable";
  const sql = getDb();
  // The claim handed this caller a DECRYPTED token, so putting it back writes it
  // again — and a restore that wrote the plaintext straight back would undo the
  // encryption for exactly the rows a failed install leaves behind. Refusing
  // (this throws when the key is gone) is caught by `finalizeShopifyInstall` and
  // reported as a grant that was not restored.
  const accessToken = encryptInstallContextToken(context.access_token);
  const restored = (await sql`
    INSERT INTO shopify_install_contexts (
      token, shop_domain, shop_name, access_token, scopes, metadata,
      return_to, session_id, user_id, preferred_business_id,
      created_at, expires_at
    )
    SELECT
      ${context.token}::text, ${context.shop_domain}::text,
      ${context.shop_name}::text,
      ${accessToken}::text, ${context.scopes}::text,
      ${JSON.stringify(context.metadata ?? {})}::jsonb,
      ${context.return_to}::text,
      ${context.session_id}::uuid,
      ${context.user_id}::uuid,
      ${context.preferred_business_id}::uuid,
      ${context.created_at}::timestamptz,
      LEAST(
        ${context.expires_at}::timestamptz,
        now() + interval '5 minutes'
      )
    WHERE ${context.expires_at}::timestamptz > now()
    ON CONFLICT (token) DO NOTHING
    RETURNING expires_at::text AS expires_at
  `) as Array<{ expires_at: string }>;
  if (restored[0]) return "restored";
  // Nothing was written, and the two reasons are not interchangeable: an expired
  // grant is gone for good, while a token that already exists means a concurrent
  // process is holding the same install.
  const stillThere = (await sql`
    SELECT 1 FROM shopify_install_contexts WHERE token = ${context.token} LIMIT 1
  `) as Array<Record<string, unknown>>;
  return stillThere.length > 0 ? "already_present" : "expired";
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

  return rows[0] ? readInstallContextRow(rows[0]) : null;
}

/**
 * The exact credential identity a Shopify provider call is allowed to run under.
 *
 * `lib/provider-write-authority.ts` performs this check for Meta and Google and
 * is typed to those two providers. Shopify's authority is not the same shape —
 * there is no per-account selection, the shop domain IS the principal — so the
 * binding is expressed here, over the same `connection_generation:status` token
 * those providers use, rather than by widening a module this install path does
 * not own.
 */
export interface ShopifyGrantAuthority {
  /** `connection_generation:status`, read from the row the token was written into. */
  connectionGeneration: string;
  shopDomain: string;
  accessToken: string;
}

export function readShopifyGrantAuthority(
  integration: IntegrationRow,
): ShopifyGrantAuthority | null {
  if (!integration.provider_account_id || !integration.access_token) return null;
  return {
    connectionGeneration: `${integration.connection_generation ?? 1}:${integration.status}`,
    shopDomain: integration.provider_account_id,
    accessToken: integration.access_token,
  };
}

export type ShopifyGrantAuthorityCheck =
  | { ok: true }
  | {
      ok: false;
      code: "shopify_connection_changed" | "shopify_authority_unknown";
      detail: string;
    };

/**
 * Re-read the stored grant immediately before a Shopify mutation and require it
 * to be IDENTICAL to the one the mutation was built from.
 *
 * A finalize holds a plaintext access token in memory for the whole of its
 * webhook and pixel registration. In that window the same business can be
 * reconnected to a DIFFERENT shop, or disconnected outright, and the in-flight
 * registration would still be sent under the superseded grant — subscribing the
 * old shop's webhooks, or creating a pixel on a store the business no longer
 * has. The generation is what makes a reconnect visible even when the provider
 * hands back byte-identical token material.
 *
 * A read that fails is `unknown`, never "unchanged". Treating a database outage
 * as authority would be exactly the case this exists to refuse.
 */
export async function assertShopifyGrantUnchanged(input: {
  businessId: string;
  authority: ShopifyGrantAuthority;
}): Promise<ShopifyGrantAuthorityCheck> {
  let current: IntegrationRow | null;
  try {
    current = await getIntegration(input.businessId, "shopify");
  } catch (error: unknown) {
    return {
      ok: false,
      code: "shopify_authority_unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const observed = current ? readShopifyGrantAuthority(current) : null;
  if (!observed || current?.status !== "connected") {
    return {
      ok: false,
      code: "shopify_connection_changed",
      detail: "The Shopify connection is no longer connected for this business.",
    };
  }
  if (observed.connectionGeneration !== input.authority.connectionGeneration) {
    return {
      ok: false,
      code: "shopify_connection_changed",
      detail: `The Shopify connection moved from generation ${input.authority.connectionGeneration} to ${observed.connectionGeneration} while this install was finalizing.`,
    };
  }
  if (
    observed.shopDomain.toLowerCase() !== input.authority.shopDomain.toLowerCase() ||
    observed.accessToken !== input.authority.accessToken
  ) {
    return {
      ok: false,
      code: "shopify_connection_changed",
      detail: "The stored Shopify credential is not the one this install wrote.",
    };
  }
  return { ok: true };
}

/**
 * The metadata key recording a completed customer-events pixel registration.
 *
 * `webPixelCreate` is a create, not an upsert, and nothing in the mutation says
 * "only if absent". A second finalize for the same shop — a retry after a lost
 * response, a reinstall — therefore issues a second create, and every customer
 * event would arrive twice, double-counting revenue on a surface nobody would
 * think to check. Recording the completed registration on the integration the
 * credential lives on is what makes the second finalize a no-op.
 */
export const SHOPIFY_CUSTOMER_EVENTS_PIXEL_METADATA_KEY =
  "shopifyCustomerEventsPixel";

interface ShopifyCustomerEventsPixelMarker {
  shopDomain: string;
  pixelId: string | null;
  registeredAt: string;
}

function readPixelMarker(
  metadata: Record<string, unknown> | null | undefined,
): ShopifyCustomerEventsPixelMarker | null {
  const raw = metadata?.[SHOPIFY_CUSTOMER_EVENTS_PIXEL_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.shopDomain !== "string") return null;
  return {
    shopDomain: record.shopDomain,
    pixelId: typeof record.pixelId === "string" ? record.pixelId : null,
    registeredAt:
      typeof record.registeredAt === "string" ? record.registeredAt : "",
  };
}

export type ShopifySideEffectOutcome =
  | {
      status: "registered";
      pixelId?: string | null;
      /**
       * False when the registration happened but recording it failed, which is
       * the one state in which a later finalize will register it a second time.
       */
      registrationRecorded?: boolean;
    }
  | { status: "already_registered" }
  | { status: "failed"; detail: string }
  | {
      status: "refused";
      code: "shopify_connection_changed" | "shopify_authority_unknown";
      detail: string;
    };

/**
 * The provider mutations a finalize performs, declared so that a guardless one
 * cannot be substituted.
 *
 * Written as PROPERTIES holding arrow types, not as method shorthand. Method
 * shorthand is compared bivariantly even under `strictFunctionTypes`, so a
 * function requiring `assertStillAuthorized` was assignable to a slot declaring
 * it did not — which is precisely how a guardless implementation would slip
 * back in without a type error.
 */
export interface ShopifyInstallSideEffects {
  registerWebhooks: (input: ShopifyGrantGuardedInput) => Promise<unknown>;
  registerPixel: (
    input: ShopifyGrantGuardedInput,
  ) => Promise<{ pixelId?: string | null } | { status: string }>;
}

const LIVE_SIDE_EFFECTS: ShopifyInstallSideEffects = {
  registerWebhooks: registerShopifySyncWebhooks,
  registerPixel: registerShopifyCustomerEventsPixel,
};

export interface ShopifyInstallFinalizeFailure {
  code:
    | "context_not_found"
    | "context_not_yours"
    | "context_wrong_business"
    | "integration_save_failed"
    | "integration_save_failed_terminal"
    | "integration_save_unverified";
  httpStatus: 403 | 404 | 500 | 503;
  message: string;
  /**
   * Whether repeating this exact finalize can succeed. A false here is a
   * promise that the grant is gone, and the caller must say so rather than
   * inviting a retry that cannot work.
   */
  retryable: boolean;
  /** What became of the single copy of the shop's access token. */
  grant: "not_claimed" | "restored" | "discarded" | "persisted";
  detail: string | null;
}

export interface ShopifyInstallFinalizeSuccess {
  ok: true;
  context: ShopifyInstallContextRow;
  integration: IntegrationRow;
  /**
   * The credential was already stored by an earlier attempt whose response was
   * lost, and this finalize converged onto it instead of writing it again.
   */
  credentialAlreadyPersisted: boolean;
  webhooks: ShopifySideEffectOutcome;
  pixel: ShopifySideEffectOutcome;
}

export type ShopifyInstallFinalizeResult =
  | ShopifyInstallFinalizeSuccess
  | { ok: false; failure: ShopifyInstallFinalizeFailure };

function errorCode(error: unknown) {
  if (typeof error !== "object" || !error || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return code == null ? null : String(code);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Whether a failed credential write is worth retrying at all.
 *
 * `lib/db.ts` classifies errors too, but for a different question — whether to
 * transparently re-issue a query — and it does not export that classifier. The
 * question here is stricter: a retryable failure is the ONLY case in which a
 * live shop credential is put back into a table anyone holding the token can
 * claim. Everything not positively recognised as transient is therefore
 * terminal, including a missing encryption key, a constraint violation and a
 * malformed identifier, all of which fail identically on every retry and would
 * leave the grant sitting there until it expired.
 */
function isTransientPersistenceFailure(error: unknown) {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code) {
    // Connection exceptions, insufficient resources, operator intervention.
    if (code.startsWith("08") || code.startsWith("53")) return true;
    if (code === "57P01" || code === "57P02" || code === "57P03") return true;
    // Serialization failure, deadlock, lock timeout, statement timeout. Each
    // rolls the transaction back, so the write provably did not land.
    if (code === "40001" || code === "40P01" || code === "55P03") return true;
    if (code === "57014") return true;
    // Node-level socket failures surfaced by the driver.
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE"
    ) {
      return true;
    }
    // An internal server error is what a crashed or restarting backend reports.
    if (code === "XX000") return true;
    return false;
  }
  return (
    message.includes("timed out after") ||
    message.includes("statement timeout") ||
    message.includes("Connection terminated unexpectedly") ||
    message.includes("terminating connection") ||
    message.includes("connection closed")
  );
}

/**
 * Whether the exact grant this finalize was carrying is already stored.
 *
 * A credential write can commit and still report failure — the response is lost,
 * the pool connection dies after COMMIT. Restoring the context in that state
 * publishes a SECOND live copy of a credential that is already connected, and a
 * later claim of that copy connects the same shop somewhere else. This is the
 * positive evidence required before a restore is allowed, and a probe that
 * cannot be answered is not evidence.
 */
async function readPersistedGrant(input: {
  businessId: string;
  context: ShopifyInstallContextRow;
}): Promise<
  { state: "persisted"; integration: IntegrationRow } | { state: "absent" } | { state: "unknown" }
> {
  try {
    const integration = await getIntegration(input.businessId, "shopify");
    if (
      integration &&
      integration.status === "connected" &&
      (integration.provider_account_id ?? "").toLowerCase() ===
        input.context.shop_domain.toLowerCase() &&
      integration.access_token === input.context.access_token
    ) {
      return { state: "persisted", integration };
    }
    return { state: "absent" };
  } catch {
    return { state: "unknown" };
  }
}

async function runGuardedSideEffect(input: {
  businessId: string;
  authority: ShopifyGrantAuthority;
  run: (
    assertStillAuthorized: () => Promise<void>,
  ) => Promise<{ pixelId?: string | null; status?: string } | void>;
}): Promise<ShopifySideEffectOutcome> {
  /**
   * The guard handed INTO the sequence, so it runs before every request it
   * makes rather than once before the first.
   *
   * Checking here and then handing over the token was still a race: webhook
   * registration lists and then issues one create per missing topic, and a
   * reconnect between two of those creates sent the rest under a credential the
   * user had already replaced. It throws, because a throw is what stops a
   * sequence mid-flight; the sequence converts it into a stopped receipt.
   */
  const assertStillAuthorized = async () => {
    const still = await assertShopifyGrantUnchanged({
      businessId: input.businessId,
      authority: input.authority,
    });
    if (!still.ok) {
      throw new ShopifyGrantMovedError(still.code, still.detail);
    }
  };

  const authorised = await assertShopifyGrantUnchanged({
    businessId: input.businessId,
    authority: input.authority,
  });
  if (!authorised.ok) {
    return {
      status: "refused",
      code: authorised.code,
      detail: authorised.detail,
    };
  }
  try {
    const result = await input.run(assertStillAuthorized);
    // A sequence that stopped part-way reports itself as stopped. Reading that
    // as success is the defect this whole path exists to prevent — and for the
    // pixel it is worse than cosmetic: a "registered" outcome writes the marker
    // that suppresses the NEXT shop's pixel entirely.
    if (result && typeof result === "object" && result.status === "stopped") {
      return {
        status: "refused",
        code: "shopify_connection_changed",
        detail:
          "The Shopify connection moved while the provider sequence was running; the remaining requests were not sent.",
      };
    }
    return result && "pixelId" in result
      ? { status: "registered", pixelId: result.pixelId ?? null }
      : { status: "registered" };
  } catch (error: unknown) {
    if (error instanceof ShopifyGrantMovedError) {
      return { status: "refused", code: error.code, detail: error.detail };
    }
    return { status: "failed", detail: errorMessage(error) };
  }
}

/** A grant that moved mid-sequence, distinguishable from a provider failure. */
class ShopifyGrantMovedError extends Error {
  readonly code: "shopify_connection_changed" | "shopify_authority_unknown";
  readonly detail: string;
  constructor(
    code: "shopify_connection_changed" | "shopify_authority_unknown",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ShopifyGrantMovedError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Turn one claimed install grant into a connected Shopify integration.
 *
 * This lives beside the claim rather than in the route because the three steps
 * are one authority decision and must not be reorderable by the HTTP layer: the
 * claim destroys the only copy of the credential, the credential write is what
 * makes it durable, and every provider mutation afterwards must still be running
 * under the exact grant that was written. Splitting them across a route handler
 * is how the original grew a restore that could resurrect a live credential and
 * provider calls that ran under a connection that had already moved.
 */
export async function finalizeShopifyInstall(input: {
  token: string;
  businessId: string;
  sessionId?: string | null;
  userId?: string | null;
  sideEffects?: ShopifyInstallSideEffects;
}): Promise<ShopifyInstallFinalizeResult> {
  const sideEffects = input.sideEffects ?? LIVE_SIDE_EFFECTS;

  let claim: ShopifyInstallContextClaim;
  try {
    claim = await consumeShopifyInstallContext({
      token: input.token,
      sessionId: input.sessionId,
      userId: input.userId,
      targetBusinessId: input.businessId,
    });
  } catch (error: unknown) {
    // The two secret errors are raised only AFTER the destructive claim has
    // already returned the row, so the grant is provably spent and
    // `discarded` is the truth rather than a guess. Every other error — a
    // database failure during the DELETE itself — may have left the grant
    // intact, and describing that as discarded would be a lie the caller acts
    // on, so it propagates untouched.
    if (
      !isIntegrationSecretKeyRequiredError(error) &&
      !isIntegrationSecretUnreadableError(error)
    ) {
      throw error;
    }
    return {
      ok: false,
      failure: {
        code: "integration_save_failed_terminal",
        httpStatus: 500,
        message:
          "The Shopify install could not be completed because its stored credential could not be read. Start the install again from Shopify.",
        retryable: false,
        grant: "discarded",
        detail: errorMessage(error),
      },
    };
  }
  if (!claim.ok) {
    if (claim.reason === "not_your_context") {
      return {
        ok: false,
        failure: {
          code: "context_not_yours",
          httpStatus: 403,
          message:
            "This Shopify install was started by a different session. Start the install again from this account.",
          retryable: false,
          grant: "not_claimed",
          detail: null,
        },
      };
    }
    if (claim.reason === "wrong_business") {
      return {
        ok: false,
        failure: {
          code: "context_wrong_business",
          httpStatus: 403,
          message:
            "This Shopify install was started for a different business. Finish it from that business, or start the install again from this one.",
          retryable: false,
          grant: "not_claimed",
          detail: null,
        },
      };
    }
    return {
      ok: false,
      failure: {
        code: "context_not_found",
        httpStatus: 404,
        message: "Shopify install context not found or expired.",
        retryable: false,
        grant: "not_claimed",
        detail: null,
      },
    };
  }

  const context = claim.context;
  // The pixel marker is ours to write and only after a registration we actually
  // performed. Carrying one in from the install context — which is assembled
  // from a provider response — would let an unregistered shop claim to be
  // registered and silently suppress the pixel forever.
  const contextMetadata = { ...(context.metadata ?? {}) };
  delete contextMetadata[SHOPIFY_CUSTOMER_EVENTS_PIXEL_METADATA_KEY];

  let integration: IntegrationRow;
  let credentialAlreadyPersisted = false;
  try {
    integration = await upsertIntegration({
      businessId: input.businessId,
      provider: "shopify",
      status: "connected",
      providerAccountId: context.shop_domain,
      providerAccountName: context.shop_name ?? context.shop_domain,
      accessToken: context.access_token,
      scopes: context.scopes ?? undefined,
      metadata: {
        ...contextMetadata,
        shopifyProductionServingMode: "auto",
      },
    });
  } catch (error: unknown) {
    const transient = isTransientPersistenceFailure(error);
    const persisted = await readPersistedGrant({
      businessId: input.businessId,
      context,
    });

    if (persisted.state === "persisted") {
      // The write did land; the failure was in reporting it. Restoring here
      // would publish a second claimable copy of a credential that is already
      // connected, so the install converges onto what is stored instead.
      integration = persisted.integration;
      credentialAlreadyPersisted = true;
    } else if (!transient) {
      // Terminal. A retry fails the same way, so putting the credential back
      // would leave a live shop token claimable by anyone holding the install
      // token until it expired, for no possible benefit.
      return {
        ok: false,
        failure: {
          code: "integration_save_failed_terminal",
          httpStatus: 500,
          message:
            "The Shopify connection could not be saved and retrying will not help. Start the install again from Shopify.",
          retryable: false,
          grant: "discarded",
          detail: errorMessage(error),
        },
      };
    } else if (persisted.state === "unknown") {
      // Fail closed: without positive evidence that the credential is unstored,
      // resurrecting it risks a second live copy of the same grant. The install
      // token is spent and the user reinstalls.
      return {
        ok: false,
        failure: {
          code: "integration_save_unverified",
          httpStatus: 503,
          message:
            "The Shopify connection could not be saved and its state could not be verified. Start the install again from Shopify.",
          retryable: false,
          grant: "discarded",
          detail: errorMessage(error),
        },
      };
    } else {
      const restore = await restoreShopifyInstallContext(context).catch(
        () => "unavailable" as const,
      );
      return {
        ok: false,
        failure: {
          code: "integration_save_failed",
          httpStatus: 503,
          message:
            restore === "restored" || restore === "already_present"
              ? "The Shopify connection could not be saved. The install is still valid — retry shortly."
              : "The Shopify connection could not be saved and the install has expired. Start the install again from Shopify.",
          retryable: restore === "restored" || restore === "already_present",
          grant:
            restore === "restored" || restore === "already_present"
              ? "restored"
              : "discarded",
          detail: errorMessage(error),
        },
      };
    }
  }

  const authority = readShopifyGrantAuthority(integration);
  if (!authority) {
    // The row exists but carries no credential or no shop, so there is nothing a
    // provider call could legitimately run under.
    return {
      ok: false,
      failure: {
        code: "integration_save_unverified",
        httpStatus: 503,
        message:
          "The Shopify connection was saved without a usable credential. Start the install again from Shopify.",
        retryable: false,
        grant: "persisted",
        detail: null,
      },
    };
  }

  const webhooks = await runGuardedSideEffect({
    businessId: input.businessId,
    authority,
    run: (assertStillAuthorized) =>
      sideEffects.registerWebhooks({
        shopId: authority.shopDomain,
        accessToken: authority.accessToken,
        assertStillAuthorized,
      }) as Promise<{ status?: string }>,
  });

  const existingMarker = readPixelMarker(integration.metadata);
  let pixel: ShopifySideEffectOutcome;
  if (
    existingMarker &&
    existingMarker.shopDomain.toLowerCase() === authority.shopDomain.toLowerCase()
  ) {
    pixel = { status: "already_registered" };
  } else {
    pixel = await runGuardedSideEffect({
      businessId: input.businessId,
      authority,
      run: (assertStillAuthorized) =>
        sideEffects.registerPixel({
          shopId: authority.shopDomain,
          accessToken: authority.accessToken,
          assertStillAuthorized,
        }),
    });
    if (pixel.status === "registered") {
      const marker: ShopifyCustomerEventsPixelMarker = {
        shopDomain: authority.shopDomain,
        pixelId: pixel.pixelId ?? null,
        registeredAt: new Date().toISOString(),
      };
      try {
        // Bound to the same generation the pixel was created under, so a
        // reconnect that lands during registration cannot have this recorded
        // against it — which would suppress the next shop's pixel entirely.
        integration = await upsertIntegration({
          businessId: input.businessId,
          provider: "shopify",
          status: "connected",
          providerAccountId: authority.shopDomain,
          metadata: { [SHOPIFY_CUSTOMER_EVENTS_PIXEL_METADATA_KEY]: marker },
          expectedConnectionGeneration: authority.connectionGeneration,
        });
        pixel = { ...pixel, registrationRecorded: true };
      } catch (error: unknown) {
        // The pixel exists and nothing durable says so, which is exactly the
        // state in which the next finalize for this shop creates a second one.
        // Reported rather than thrown — the connection itself is complete — so
        // the caller can log it as the repairable gap it is.
        pixel = { ...pixel, registrationRecorded: false };
        console.warn("[shopify-install] customer_events_pixel_marker_unrecorded", {
          businessId: input.businessId,
          shopDomain: authority.shopDomain,
          message: errorMessage(error),
        });
      }
    }
  }

  return {
    ok: true,
    context,
    integration,
    credentialAlreadyPersisted,
    webhooks,
    pixel,
  };
}
