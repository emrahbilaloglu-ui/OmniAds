import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getDb } from "@/lib/db";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  authorizeLaunchpadCopyHandoff,
  authorizeLaunchpadHandoff,
  EMPTY_LAUNCHPAD_HANDOFF_SELECTION,
  formatLaunchpadHandoffReference,
  LAUNCHPAD_HANDOFF_ENVELOPE_VERSION,
  LAUNCHPAD_HANDOFF_KIND,
  LAUNCHPAD_HANDOFF_PREFILL_TTL_MS,
  LAUNCHPAD_HANDOFF_TTL_MS,
  launchpadModeForAuthorizedAction,
  parseLaunchpadHandoffReference,
  type LaunchpadCopyHandoffCandidate,
  type LaunchpadHandoffAnyRefusal,
  type LaunchpadHandoffConsumeRefusal,
  type LaunchpadHandoffEnvelope,
  type LaunchpadHandoffRefusalCode,
} from "@/lib/meta/launchpad-handoff-contract";

export * from "@/lib/meta/launchpad-handoff-contract";

/**
 * The Decisions -> Launchpad handoff, owned by the server.
 *
 * WHY THIS EXISTS
 * ---------------
 * Rebuild and Duplicate used to hand Launchpad a query string:
 * `?fromMetaBriefing=true&mode=duplicate&campaignIds=...&sourceDecisionId=...`.
 * Every field in it was caller-writable and none of it was re-checked, so
 * Launchpad had exactly two honest options: trust a URL, or refuse. It refused
 * (`hasServerAuthorizedLaunchpadHandoff()` is hard-coded `false`), which is the
 * right call and also why the button never actually did anything.
 *
 * A URL cannot mint authority, so the URL stops carrying any. What travels now
 * is a reference — a handoff id plus a single-use bearer token — to a record
 * this module wrote under the caller's session after re-reading the canonical
 * decision from the server. The Launchpad route re-reads that record
 * server-side and re-checks it against ITS OWN request: same user, same
 * business, same provider account, not expired, not already consumed, still
 * action-eligible. Editing the id in the address bar buys nothing: the record
 * names the business and the account it was minted for, and a mismatch is a
 * refusal, not a widening.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * Nothing here contacts Meta and nothing here executes. A verified handoff
 * opens a Launchpad DRAFT. Provider execution keeps its own separate
 * requirements (an explicit origin contract, a fresh exact provider GET,
 * durable per-attempt receipts) and this envelope satisfies none of them by
 * itself — it carries `exactAdExecutionEligible` as EVIDENCE, never as
 * permission.
 *
 * STORAGE
 * -------
 * `meta_launch_drafts` — the existing table for "a Launchpad launch that has
 * been prepared but not run", which is precisely what a handoff is. Additive
 * DDL belongs to another owner (`lib/migrations.ts`), so no new table is
 * created here; the envelope lives in the row's `payload_json` under a
 * discriminated `kind`, and single-use consumption is enforced by a
 * conditional UPDATE on that JSON rather than by a new column.
 */

/**
 * Server-side only, and that is the point.
 *
 * Hashing lives here rather than in the pure contract module because the
 * contract is imported by a client component, and `node:crypto` has no
 * business in a browser bundle.
 */
export function hashLaunchpadHandoffToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashLaunchpadHandoffToken(token), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

function isEnvelope(value: unknown): value is LaunchpadHandoffEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === LAUNCHPAD_HANDOFF_ENVELOPE_VERSION &&
    typeof record.handoffId === "string" &&
    typeof record.tokenHash === "string" &&
    typeof record.businessId === "string" &&
    typeof record.providerAccountId === "string" &&
    (record.origin === "decision" || record.origin === "copy") &&
    (record.mode === "rebuild" ||
      record.mode === "duplicate" ||
      record.mode === "copy_draft") &&
    typeof record.expiresAt === "string" &&
    typeof record.createdAt === "string"
  );
}

/**
 * The origin's own integrity rules, restated on the READ side.
 *
 * The write side already refused everything it could see, but a row is not a
 * function call: it can be edited by anything that can write JSON into
 * `meta_launch_drafts`. So the two shapes are pinned here, and a row that does
 * not match its own origin is treated as not being one of ours at all.
 *
 * The copy branch is the load-bearing one. It refuses any copy envelope that
 * arrives claiming an authorized action, action eligibility, exact-Ad execution
 * eligibility or `native_exact` authority — the four fields that would let a
 * warehouse aggregate be mistaken for a canonical decision.
 */
function envelopeMatchesItsOrigin(envelope: LaunchpadHandoffEnvelope): boolean {
  if (envelope.origin === "copy") {
    return (
      envelope.mode === "copy_draft" &&
      envelope.authorizedAction === null &&
      envelope.actionEligible === false &&
      envelope.exactAdExecutionEligible === false &&
      envelope.sourceAuthorityStatus === "warehouse_discovery" &&
      Boolean(envelope.copy?.copyId) &&
      Boolean(envelope.copy?.alternateText)
    );
  }
  return (
    envelope.actionEligible === true &&
    envelope.sourceAuthorityStatus === "native_exact" &&
    envelope.authorizedAction !== null &&
    launchpadModeForAuthorizedAction(envelope.authorizedAction) ===
      envelope.mode &&
    Boolean(envelope.lineage?.sourceDecisionId) &&
    Boolean(envelope.lineage?.sourceSnapshotId)
  );
}

export interface MintLaunchpadHandoffInput {
  businessId: string;
  providerAccountId: string;
  decision: MetaCanonicalDecision;
  createdByUserId: string | null;
  now?: Date;
}

export type MintLaunchpadHandoffResult =
  | {
      ok: true;
      reference: string;
      handoffId: string;
      envelope: LaunchpadHandoffEnvelope;
    }
  | { ok: false; refusal: LaunchpadHandoffAnyRefusal };

type PersistableEnvelope = Omit<LaunchpadHandoffEnvelope, "handoffId">;

/**
 * The one INSERT, shared by both origins.
 *
 * `provider_account_id` is written here and that is not cosmetic. The column
 * exists (lib/migrations.ts) and every account-scoped reader filters on it —
 * `listMetaLaunchDrafts` in lib/launchpad/meta-store.ts is
 * `WHERE business_id = $1 AND provider_account_id = $2`. A handoff row minted
 * with a NULL account was therefore invisible to the account it was minted for:
 * it existed, it was consumable by reference, and it appeared in no list. A
 * record nobody can see is not a draft.
 */
async function insertHandoffRow(input: {
  businessId: string;
  providerAccountId: string;
  createdByUserId: string | null;
  name: string;
  envelope: PersistableEnvelope;
}): Promise<
  | { ok: true; handoffId: string; envelope: LaunchpadHandoffEnvelope }
  | { ok: false; refusal: "persist_failed" }
> {
  const sql = getDb();
  try {
    const rows = (await sql`
      INSERT INTO meta_launch_drafts (
        business_id, provider_account_id, name, payload_json, status, created_by
      )
      VALUES (
        ${input.businessId},
        ${input.providerAccountId},
        ${input.name.slice(0, 240)},
        ${JSON.stringify({
          kind: LAUNCHPAD_HANDOFF_KIND,
          handoff: { ...input.envelope, handoffId: null },
        })}::jsonb,
        'draft',
        ${input.createdByUserId}
      )
      RETURNING id
    `) as Array<{ id: string }>;
    const handoffId = rows[0]?.id;
    if (!handoffId) return { ok: false, refusal: "persist_failed" };

    // The row id is the handoff id, so it is stamped into the envelope after
    // the insert. Minting the UUID client-side would work too, but letting the
    // database own identity keeps the id unforgeable by anything that can only
    // write JSON.
    await sql`
      UPDATE meta_launch_drafts
      SET payload_json = jsonb_set(payload_json, '{handoff,handoffId}', to_jsonb(${handoffId}::text), true),
          updated_at = NOW()
      WHERE id = ${handoffId}
    `;
    return { ok: true, handoffId, envelope: { ...input.envelope, handoffId } };
  } catch {
    return { ok: false, refusal: "persist_failed" };
  }
}

/**
 * Writes the handoff and returns the reference exactly once.
 *
 * The token is returned to the caller and never stored — only its digest is —
 * so a database reader cannot replay a handoff, and a leaked row is not a
 * capability.
 */
export async function mintLaunchpadHandoff(
  input: MintLaunchpadHandoffInput,
): Promise<MintLaunchpadHandoffResult> {
  const authorized = authorizeLaunchpadHandoff({
    decision: input.decision,
    providerAccountId: input.providerAccountId,
  });
  if (!authorized.ok) return { ok: false, refusal: authorized.refusal };

  const now = input.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const authorization = authorized.authorization;
  const written = await insertHandoffRow({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    createdByUserId: input.createdByUserId,
    name: `Decision handoff \u00b7 ${authorization.mode} \u00b7 ${authorization.lineage.sourceDecisionId}`,
    envelope: {
      version: LAUNCHPAD_HANDOFF_ENVELOPE_VERSION,
      tokenHash: hashLaunchpadHandoffToken(token),
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      createdByUserId: input.createdByUserId,
      origin: "decision",
      authorizedAction: authorization.authorizedAction,
      mode: authorization.mode,
      actionEligible: true,
      exactAdExecutionEligible: authorization.exactAdExecutionEligible,
      sourceAuthorityStatus: "native_exact",
      lineage: authorization.lineage,
      selection: authorization.selection,
      evidenceWindow: authorization.evidenceWindow,
      copy: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + LAUNCHPAD_HANDOFF_TTL_MS,
      ).toISOString(),
      consumedAt: null,
    },
  });
  if (!written.ok) return written;
  return {
    ok: true,
    handoffId: written.handoffId,
    reference: formatLaunchpadHandoffReference({
      handoffId: written.handoffId,
      token,
    }),
    envelope: written.envelope,
  };
}

export interface MintLaunchpadCopyHandoffInput {
  businessId: string;
  providerAccountId: string;
  /** The copy row as the SERVER read it back, never as a client described it. */
  candidate: LaunchpadCopyHandoffCandidate;
  requestedAlternateText: string;
  window: { startDate: string; endDate: string };
  createdByUserId: string | null;
  now?: Date;
}

/**
 * The Copies -> Launchpad handoff.
 *
 * Same table, same token discipline, same single-use consume — and explicitly
 * NOT a decision. Nothing here can produce an authorized action, because the
 * envelope it writes hard-codes `authorizedAction: null`, `actionEligible:
 * false` and `exactAdExecutionEligible: false`, and the read side re-checks all
 * three against the origin.
 */
export async function mintLaunchpadCopyHandoff(
  input: MintLaunchpadCopyHandoffInput,
): Promise<MintLaunchpadHandoffResult> {
  const authorized = authorizeLaunchpadCopyHandoff({
    candidate: input.candidate,
    providerAccountId: input.providerAccountId,
    requestedAlternateText: input.requestedAlternateText,
    window: input.window,
  });
  if (!authorized.ok) return { ok: false, refusal: authorized.refusal };

  const now = input.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const authorization = authorized.authorization;
  const written = await insertHandoffRow({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    createdByUserId: input.createdByUserId,
    name: `Copy handoff \u00b7 ${authorization.copy.copyId}`,
    envelope: {
      version: LAUNCHPAD_HANDOFF_ENVELOPE_VERSION,
      tokenHash: hashLaunchpadHandoffToken(token),
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      createdByUserId: input.createdByUserId,
      origin: "copy",
      authorizedAction: null,
      mode: "copy_draft",
      actionEligible: false,
      exactAdExecutionEligible: false,
      sourceAuthorityStatus: "warehouse_discovery",
      lineage: null,
      selection: authorization.selection,
      evidenceWindow: authorization.evidenceWindow,
      copy: authorization.copy,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + LAUNCHPAD_HANDOFF_TTL_MS,
      ).toISOString(),
      consumedAt: null,
    },
  });
  if (!written.ok) return written;
  return {
    ok: true,
    handoffId: written.handoffId,
    reference: formatLaunchpadHandoffReference({
      handoffId: written.handoffId,
      token,
    }),
    envelope: written.envelope,
  };
}

export type ConsumeLaunchpadHandoffResult =
  | { ok: true; envelope: LaunchpadHandoffEnvelope }
  | { ok: false; refusal: LaunchpadHandoffConsumeRefusal };

export interface ConsumeLaunchpadHandoffInput {
  reference: string | null | undefined;
  /** The business Launchpad is actually being opened for. */
  businessId: string;
  /** The account Launchpad actually resolved, assignment-verified. */
  providerAccountId: string | null;
  /** The signed-in user, so a forwarded link is not usable by someone else. */
  actorUserId: string | null;
  now?: Date;
}

/**
 * Re-reads a handoff on the Launchpad side and burns it.
 *
 * Every check here is a re-check: the minting side already refused everything
 * it could see, and this side refuses everything IT can see, because the two
 * requests are not the same request. Between them the operator may have
 * switched business, switched account, waited out the TTL, or forwarded the
 * link to someone else.
 *
 * Single use is enforced by the conditional UPDATE, not by the SELECT above
 * it: the SELECT exists only to name WHICH refusal applies. If two requests
 * race, exactly one UPDATE matches the `consumedAt IS NULL` predicate and the
 * loser is told `already_consumed` rather than both being let through.
 */
export async function consumeLaunchpadHandoff(
  input: ConsumeLaunchpadHandoffInput,
): Promise<ConsumeLaunchpadHandoffResult> {
  const parsed = parseLaunchpadHandoffReference(input.reference);
  if (!parsed) return { ok: false, refusal: "malformed_reference" };

  const sql = getDb();
  let payload: unknown;
  try {
    const rows = (await sql`
      SELECT payload_json
      FROM meta_launch_drafts
      WHERE id = ${parsed.handoffId}
        AND payload_json->>'kind' = ${LAUNCHPAD_HANDOFF_KIND}
      LIMIT 1
    `) as Array<{ payload_json: unknown }>;
    if (rows.length === 0) return { ok: false, refusal: "not_found" };
    payload = rows[0]!.payload_json;
  } catch {
    return { ok: false, refusal: "read_failed" };
  }

  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const envelope = record?.handoff;
  if (!isEnvelope(envelope)) return { ok: false, refusal: "not_found" };

  // Token before identity, so a wrong token cannot be used to probe which
  // business or account a handoff belongs to.
  if (!tokenMatches(parsed.token, envelope.tokenHash)) {
    return { ok: false, refusal: "token_mismatch" };
  }
  if (envelope.businessId !== input.businessId) {
    return { ok: false, refusal: "business_mismatch" };
  }
  if (
    !input.providerAccountId ||
    envelope.providerAccountId !== input.providerAccountId
  ) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }
  if (
    envelope.createdByUserId &&
    envelope.createdByUserId !== input.actorUserId
  ) {
    return { ok: false, refusal: "actor_mismatch" };
  }
  if (envelope.consumedAt) return { ok: false, refusal: "already_consumed" };

  const now = input.now ?? new Date();
  const expiresAt = Date.parse(envelope.expiresAt);
  // An unparseable expiry is not "no expiry". A window the clock cannot locate
  // is refused rather than treated as open.
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, refusal: "expired" };
  }
  // Authority is re-read, never re-derived: a stored envelope that does not
  // satisfy its own origin's rules opens nothing.
  if (!envelopeMatchesItsOrigin(envelope)) {
    return { ok: false, refusal: "not_found" };
  }

  const consumedAt = now.toISOString();
  try {
    const updated = (await sql`
      UPDATE meta_launch_drafts
      SET payload_json = jsonb_set(payload_json, '{handoff,consumedAt}', to_jsonb(${consumedAt}::text), true),
          updated_at = NOW()
      WHERE id = ${parsed.handoffId}
        AND payload_json->>'kind' = ${LAUNCHPAD_HANDOFF_KIND}
        AND payload_json->'handoff'->>'consumedAt' IS NULL
      RETURNING id
    `) as Array<{ id: string }>;
    if (updated.length === 0) return { ok: false, refusal: "already_consumed" };
  } catch {
    return { ok: false, refusal: "read_failed" };
  }

  return { ok: true, envelope: { ...envelope, consumedAt } };
}

export type ReadConsumedLaunchpadHandoffResult =
  | { ok: true; envelope: LaunchpadHandoffEnvelope }
  | {
      ok: false;
      refusal:
        | LaunchpadHandoffConsumeRefusal
        | "prefill_expired";
    };

export interface ReadConsumedLaunchpadHandoffInput {
  handoffId: string | null | undefined;
  businessId: string;
  providerAccountId: string | null;
  actorUserId: string | null;
  now?: Date;
}

/**
 * Reads a handoff that has ALREADY been burned, so the wizard survives a reload.
 *
 * WHY THIS EXISTS, and why it is not a second door.
 *
 * The bearer token is single-use and must not survive into the address bar, so
 * the landing route burns it and redirects to a URL that no longer contains it.
 * Everything the wizard needs to be prefilled with is in the record — but the
 * record can no longer be named by a token. Without this read the prefill would
 * have to travel in the redirect URL, which is exactly the "a URL carries the
 * selection" design this whole seam replaced.
 *
 * So the redirect names the record and this read re-checks WHO is asking, every
 * time, in SQL:
 *
 *   - the row must belong to this business AND this assignment-verified account
 *     (both are predicates below, not comparisons on a value the caller sent);
 *   - the envelope must have been created by this signed-in user;
 *   - the envelope must already be consumed — an UNCONSUMED handoff is not
 *     readable here, so this can never be used to bypass the token;
 *   - the consumption must be recent (`LAUNCHPAD_HANDOFF_PREFILL_TTL_MS`).
 *
 * It grants nothing. It returns a prefill for a draft wizard, and every
 * Launchpad write route still refuses on its own authority.
 */
export async function readConsumedLaunchpadHandoff(
  input: ReadConsumedLaunchpadHandoffInput,
): Promise<ReadConsumedLaunchpadHandoffResult> {
  const handoffId = input.handoffId?.trim() ?? "";
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      handoffId,
    )
  ) {
    return { ok: false, refusal: "malformed_reference" };
  }
  if (!input.providerAccountId) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }

  const sql = getDb();
  let payload: unknown;
  try {
    const rows = (await sql`
      SELECT payload_json
      FROM meta_launch_drafts
      WHERE id = ${handoffId}
        AND payload_json->>'kind' = ${LAUNCHPAD_HANDOFF_KIND}
        AND business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
      LIMIT 1
    `) as Array<{ payload_json: unknown }>;
    if (rows.length === 0) return { ok: false, refusal: "not_found" };
    payload = rows[0]!.payload_json;
  } catch {
    return { ok: false, refusal: "read_failed" };
  }

  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const envelope = record?.handoff;
  if (!isEnvelope(envelope)) return { ok: false, refusal: "not_found" };
  if (envelope.businessId !== input.businessId) {
    return { ok: false, refusal: "business_mismatch" };
  }
  if (envelope.providerAccountId !== input.providerAccountId) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }
  if (
    envelope.createdByUserId &&
    envelope.createdByUserId !== input.actorUserId
  ) {
    return { ok: false, refusal: "actor_mismatch" };
  }
  if (!envelopeMatchesItsOrigin(envelope)) {
    return { ok: false, refusal: "not_found" };
  }
  // Unconsumed is refused, not honoured. The token is the only way to open a
  // handoff for the first time; this read exists solely to keep an already
  // opened one readable.
  if (!envelope.consumedAt) return { ok: false, refusal: "not_found" };

  const consumedAt = Date.parse(envelope.consumedAt);
  const now = (input.now ?? new Date()).getTime();
  // An unparseable consumption time is not "just now". A window the clock
  // cannot locate is refused rather than treated as open.
  if (
    !Number.isFinite(consumedAt) ||
    now - consumedAt > LAUNCHPAD_HANDOFF_PREFILL_TTL_MS ||
    consumedAt - now > 60_000
  ) {
    return { ok: false, refusal: "prefill_expired" };
  }

  return { ok: true, envelope };
}
