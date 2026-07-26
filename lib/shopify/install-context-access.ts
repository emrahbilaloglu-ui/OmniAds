import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business-support";
import { isReviewerEmail } from "@/lib/reviewer-access";

/**
 * Who is allowed to SEE a pending Shopify install context, and on what proof.
 *
 * The context row is a bearer credential in the strongest sense: it holds a
 * shop's access token, and it is addressed by a token that travels in a URL —
 * through the browser address bar, session history, a `?next=` parameter on the
 * login page, and anywhere a URL is pasted. The read side used to require
 * nothing at all: `GET /api/oauth/shopify/context?token=...` returned the shop
 * domain, shop name, currency, the business the install was started for and its
 * timestamps to whoever asked, as many times as they asked, for the life of the
 * token. No session, no membership, no single use.
 *
 * Visibility is decided here, in one place, on three independent facts:
 *
 *   1. The caller is authenticated. There is no anonymous view of a pending
 *      install; the page that consumes this only renders anything useful to a
 *      signed-in user in the first place.
 *
 *   2. The context's own actor, when it recorded one. A context created during
 *      an app-initiated install carries the session and user that started it,
 *      and `consumeShopifyInstallContext` already refuses a finalize from any
 *      other actor. Reading it is held to exactly the same rule — a context you
 *      could view but never finalize would be disclosure with no purpose.
 *
 *   3. The browser that completed the Shopify redirect, when the context
 *      recorded NO actor (the Shopify-initiated install: App Store or Shopify
 *      Admin, merchant not signed in to Adsecute yet). See
 *      `buildShopifyInstallProof`.
 *
 * Nothing here ever selects, reads, logs or returns `access_token`. The column
 * is being encrypted at rest separately, and this path has no business
 * decrypting it: the credential is only ever needed by the finalize, which
 * claims the row destructively.
 */

/** httpOnly cookie the OAuth callback sets alongside the redirect. */
export const SHOPIFY_INSTALL_PROOF_COOKIE = "shopify_install_proof";

/** Matches the 30-minute lifetime `createShopifyInstallContext` gives the row. */
export const SHOPIFY_INSTALL_PROOF_COOKIE_MAX_AGE_SECONDS = 30 * 60;

const INSTALL_PROOF_DOMAIN = "adsecute:shopify-install-context-view:v1:";

/**
 * A proof that THIS browser is the one Shopify redirected here.
 *
 * The first authenticated view of an actorless context binds it to the viewer
 * (see `SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL`), and trust-on-first-use is only
 * worth anything if the first use cannot be a stranger's. The obvious
 * cookie — "put the context token in a cookie too" — is worthless: the attacker
 * whose whole premise is holding the token can simply send it as a cookie
 * header. A cookie is only a second factor if it carries something the token
 * does not reveal, so this is an HMAC of the token under the Shopify app secret,
 * domain-separated so it can never be confused with Shopify's own request
 * signatures. Holding the URL token does not let anyone compute it, and the
 * value is httpOnly so page scripts cannot read it back out.
 *
 * Returns null when the secret is unavailable. Callers must treat null as
 * "cannot prove" and refuse, never as "no proof required".
 */
export function buildShopifyInstallProof(token: string): string | null {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !token) return null;
  return createHmac("sha256", secret)
    .update(`${INSTALL_PROOF_DOMAIN}${token}`)
    .digest("hex");
}

/**
 * The only fields the connect page consumes.
 *
 * `components/shopify/shopify-connect-client-page.tsx` renders the shop name (or
 * the domain when there is no name), the currency badge, and pre-selects /
 * labels the recommended workspace from `preferredBusinessId`. It reads the
 * token from its own URL, the return path from its own query string, and never
 * reads `createdAt`, `expiresAt`, `returnTo`, `token` or the timezone — all of
 * which the old response disclosed. What nothing renders is not returned.
 */
export interface ShopifyInstallContextView {
  shopDomain: string;
  shopName: string | null;
  preferredBusinessId: string | null;
  currency: string | null;
}

export type ShopifyInstallContextViewRefusal =
  /** The caller presented no session, or one whose identifiers are malformed. */
  | "no_actor"
  /** No token was presented at all. */
  | "no_token"
  /** The install-contexts schema is not available to serve the read. */
  | "schema_unavailable"
  /**
   * The token names no context the caller may see: it does not exist, it has
   * expired, it belongs to another actor, it was started for a business the
   * caller has no collaborator access to, or it is unbound and the caller cannot
   * prove they are the browser Shopify redirected. These are ONE refusal on
   * purpose — see the note on uniform refusals below.
   */
  | "not_visible";

export type ShopifyInstallContextViewResult =
  | {
      ok: true;
      context: ShopifyInstallContextView;
      /** Whether this call performed the first-view binding or found one. */
      binding: "claimed" | "already_bound";
    }
  | { ok: false; reason: ShopifyInstallContextViewRefusal };

interface ContextViewRow {
  token: string;
  shop_domain: string;
  shop_name: string | null;
  preferred_business_id: string | null;
  currency: string | null;
}

/**
 * The projection, shared by both statements.
 *
 * `access_token` and `scopes` are absent by construction rather than by
 * discipline: there is exactly one column list, and a test asserts it never
 * names the credential. `metadata` is narrowed to the single key the page
 * renders instead of being handed over whole, so a future writer cannot widen
 * the disclosure by adding a field to it.
 */
const VIEW_COLUMNS = `
      c.shop_domain                 AS shop_domain,
      c.shop_name                   AS shop_name,
      c.preferred_business_id::text AS preferred_business_id,
      c.metadata->>'currency'       AS currency,
      c.token                       AS token`;

/**
 * The business the install was started for, if any, must be one the caller can
 * actually finish the install into.
 *
 * `POST /api/oauth/shopify/finalize` requires `collaborator` on the target, and
 * `consumeShopifyInstallContext` requires the target to be exactly
 * `preferred_business_id`. So a caller without collaborator access to that
 * business can never complete this install, and showing them which shop is
 * pending for someone else's workspace is pure cross-tenant disclosure.
 *
 * `$4` carries the reviewer restriction: `canReviewerAccessBusiness` confines
 * the Shopify review account to the demo business, and a parallel authorization
 * path that quietly dropped that rule would be a hole of its own.
 */
const BUSINESS_VISIBILITY = `
      (
        c.preferred_business_id IS NULL
        OR (
          ($4::uuid IS NULL OR c.preferred_business_id = $4::uuid)
          AND EXISTS (
            SELECT 1
            FROM memberships m
            WHERE m.user_id = $3::uuid
              AND m.business_id = c.preferred_business_id
              AND m.status = 'active'
              AND m.role IN ('admin', 'collaborator')
          )
        )
      )`;

/**
 * The first authenticated view of an actorless context, as ONE statement.
 *
 * Trust on first use, stated plainly: a context created by a Shopify-initiated
 * install records no session and no user, because the merchant had not signed in
 * when Shopify redirected them. There is nothing in the row to check an identity
 * against, so the first authenticated viewer who can prove they are the browser
 * Shopify redirected (the install proof cookie) BECOMES the identity, and every
 * later read and the finalize are held to it.
 *
 * This is not as strong as an identity the context was created with, and it is
 * not pretended to be: it is the strongest bound available for an install that
 * genuinely has no actor yet, without inventing a column to hold one. What it
 * does guarantee is that the binding happens at most once. `UPDATE ... WHERE
 * session_id IS NULL ... RETURNING` makes the bind and the read the same
 * statement, so under N concurrent readers PostgreSQL serialises the row and
 * exactly one sees `session_id IS NULL` still true; the losers re-evaluate the
 * predicate against the committed row and match nothing. A `SELECT` followed by
 * an `UPDATE` would have let every one of them read it first.
 *
 * `$2`/`$3` are asserted non-null in the statement itself, not only by the
 * caller: this statement WRITES the actor, and binding a row to NULL would leave
 * it claimable while handing the contents to an unidentified caller.
 */
export const SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL = `
    UPDATE shopify_install_contexts AS c
       SET session_id = $2::uuid,
           user_id    = $3::uuid
     WHERE c.token = $1
       AND $2::uuid IS NOT NULL
       AND $3::uuid IS NOT NULL
       AND c.expires_at > now()
       AND c.session_id IS NULL
       AND (c.user_id IS NULL OR c.user_id = $3::uuid)
       AND${BUSINESS_VISIBILITY}
    RETURNING${VIEW_COLUMNS}`;

/**
 * A repeat view by the actor the context is bound to.
 *
 * Deliberately the same predicate `consumeShopifyInstallContext` claims under,
 * restricted to rows that HAVE an actor: session must match, and the recorded
 * user must match when there is one. The page mounts this fetch more than once
 * in practice (a refresh, React's development double-invoke), so the read is not
 * single-use — only the binding is. Single-use reads would break a page refresh
 * without denying an attacker anything the binding has not already denied them.
 */
export const SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL = `
    SELECT${VIEW_COLUMNS}
      FROM shopify_install_contexts AS c
     WHERE c.token = $1
       AND c.expires_at > now()
       AND c.session_id = $2::uuid
       AND (c.user_id IS NULL OR c.user_id = $3::uuid)
       AND${BUSINESS_VISIBILITY}
     LIMIT 1`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeUuid(value: string | null | undefined) {
  if (!value) return null;
  return UUID_PATTERN.test(value) ? value : null;
}

/**
 * A candidate secret that exists only to be compared against and never matched.
 *
 * Fresh per process, so it cannot be precomputed, and never written anywhere.
 */
const DECOY_SECRET = randomBytes(32).toString("hex");

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare two secrets in constant time, with no length-dependent branch.
 *
 * `timingSafeEqual` throws on buffers of unequal length, and the usual
 * workaround — `if (a.length !== b.length) return false` — reintroduces exactly
 * the timing signal the function exists to remove, and leaks the length of the
 * expected value to anyone who can measure it. Digesting both sides first makes
 * every comparison a fixed 32-byte one, so a wrong-length candidate and a
 * wrong-but-same-length candidate take the identical path.
 *
 * Honest about its scope: the row LOOKUP is an indexed `token = $1` inside
 * PostgreSQL and is not constant-time, and this does not claim to fix that. What
 * it fixes is the application's own comparison — the last gate before a
 * response is emitted, which no longer trusts the database's notion of equality
 * (collation, padding, a future `citext` or `ILIKE`) — and, via the decoy, the
 * found/not-found asymmetry in the work this module does after the query.
 */
export function constantTimeSecretsMatch(presented: string, expected: string) {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function toView(row: ContextViewRow): ShopifyInstallContextView {
  return {
    shopDomain: row.shop_domain,
    shopName: row.shop_name,
    preferredBusinessId: row.preferred_business_id,
    currency: row.currency,
  };
}

/**
 * Resolve the pending install context a signed-in caller is allowed to see.
 *
 * Every refusal returns the same `not_visible` reason, and callers must render
 * every refusal identically. "That token does not exist" and "that token is not
 * yours" are the same sentence to someone who does not own it; distinguishing
 * them turns this endpoint into an oracle for which install tokens are live.
 * The refusal reason is for the caller's own control flow, never for the body of
 * an HTTP response, and the token itself is never logged.
 */
export async function readShopifyInstallContextForViewer(input: {
  token: string;
  sessionId: string | null;
  userId: string | null;
  userEmail: string | null;
  /** Raw value of `SHOPIFY_INSTALL_PROOF_COOKIE`, if the request carried one. */
  installProof: string | null;
}): Promise<ShopifyInstallContextViewResult> {
  const sessionId = sanitizeUuid(input.sessionId);
  const userId = sanitizeUuid(input.userId);
  if (!sessionId || !userId) return { ok: false, reason: "no_actor" };

  const token = input.token;
  if (!token) return { ok: false, reason: "no_token" };

  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_install_contexts", "memberships"],
  }).catch(() => null);
  if (!readiness?.ready) return { ok: false, reason: "schema_unavailable" };

  // A reviewer may only ever see the demo business's installs; for everyone else
  // this is NULL and the clause it feeds is inert.
  const reviewerOnlyBusinessId = isReviewerEmail(input.userEmail)
    ? DEMO_BUSINESS_ID
    : null;
  const params = [token, sessionId, userId, reviewerOnlyBusinessId];

  const sql = getDb();

  // Bound read first. A context that already has an actor is the common case
  // (app-initiated installs, and every view after the first), and taking it
  // first means a refused request never even attempts the write.
  const bound = (await sql.query(
    SHOPIFY_INSTALL_CONTEXT_BOUND_READ_SQL,
    params,
  )) as ContextViewRow[];
  const boundRow = bound[0] ?? null;
  if (boundRow) {
    return constantTimeSecretsMatch(token, boundRow.token)
      ? { ok: true, context: toView(boundRow), binding: "already_bound" }
      : { ok: false, reason: "not_visible" };
  }

  // Unbound: bind it to this caller, but only on proof that this browser is the
  // one Shopify redirected here. Computed unconditionally so the refusal path
  // does the same work as the acceptance path.
  const expectedProof = buildShopifyInstallProof(token);
  const proofValid =
    expectedProof != null &&
    constantTimeSecretsMatch(input.installProof ?? DECOY_SECRET, expectedProof);
  if (!proofValid) {
    void constantTimeSecretsMatch(token, DECOY_SECRET);
    return { ok: false, reason: "not_visible" };
  }

  const claimed = (await sql.query(
    SHOPIFY_INSTALL_CONTEXT_CLAIM_SQL,
    params,
  )) as ContextViewRow[];
  const claimedRow = claimed[0] ?? null;
  if (!claimedRow) {
    void constantTimeSecretsMatch(token, DECOY_SECRET);
    return { ok: false, reason: "not_visible" };
  }
  return constantTimeSecretsMatch(token, claimedRow.token)
    ? { ok: true, context: toView(claimedRow), binding: "claimed" }
    : { ok: false, reason: "not_visible" };
}
