/**
 * Record, or revoke, the approval that lets an activation run unattended.
 *
 * `activation_approval_json` had a migration and a validator and no writer, so
 * the column was permanently NULL, every scheduled activation refused with
 * `activation_approval_absent`, and the only way to turn anything on was an
 * operator pressing Activate. That was a safe state and not an implemented one.
 *
 * This is the operator's own act, and it is deliberately separate from
 * activating: approving says "this exact payload may be turned on later,
 * without me", which is a different decision from "turn it on now". It is also
 * separate from creating — an intent may only ever create PAUSED entities, and
 * that CHECK is what keeps the two apart.
 *
 * Almost nothing here comes from the request. The payload fingerprint, the
 * operation, the destination, the creative and the copy hash are read from the
 * live intent and its receipt, so an approval can only ever name what this
 * launch actually produced. What the operator supplies is what is genuinely
 * theirs: the scope, the asset version they reviewed, and how long it stands.
 */
import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getDb, runDbTransaction } from "@/lib/db";
import {
  getMetaLaunchIntent,
  recordMetaLaunchIntentActivationApproval,
} from "@/lib/launchpad/meta-launch-intent-store";
import {
  buildActivationApproval,
  revokeActivationApproval,
  type ActivationApproval,
} from "@/lib/meta/launch-activation-approval";
import {
  ACTIVATION_POLICY_VERSION,
  readCreativeIds,
} from "@/lib/meta/launch-intent-activation";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../../../demo-write-authority";

export const dynamic = "force-dynamic";

/** The same two words every other manual Meta write compares exactly. */
const MANUAL_ACTION_ORIGIN = "manual_operator_v1";
const MANUAL_CONFIRMATION = "explicit_operator_confirmation";

/** A day. Long enough to be useful, short enough that a stale one lapses. */
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;

type ApprovalBody = {
  businessId?: string;
  actionOrigin?: string;
  manualConfirmation?: string;
  approvedScope?: string;
  approvedAssetVersion?: string;
  ttlHours?: number;
  /** Pass true to withdraw a standing approval. Nothing else is then read. */
  revoke?: boolean;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  /*
    The segment is `[id]`, not `[intentId]`.

    Next refuses two different slug names on one dynamic path, and
    `intents/[id]/route.ts` already owned this position — so the app would not
    boot at all with a second name here. A route that cannot be mounted is not
    a route, whatever an import graph says about it.
  */
  const { id: intentId } = await context.params;
  const body = await readJsonBody<ApprovalBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(
    access,
    "launchpad_approve_activation",
  );
  if (reviewerBlocked) return reviewerBlocked;
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_approve_activation",
  );
  if (demoBlocked) return demoBlocked;

  /*
    No release gate here, on purpose.

    Writing an approval reaches no provider and starts no spending; the
    activation it authorizes does, and that path reads the gate for itself.
    Gating the approval too would mean an operator could not prepare one while
    a deployment was still closed, which is exactly when preparing is useful.
  */
  if (
    body?.actionOrigin !== MANUAL_ACTION_ORIGIN
    || body?.manualConfirmation !== MANUAL_CONFIRMATION
  ) {
    return jsonError(
      400,
      "manual_confirmation_absent",
      "Recording an activation approval requires the operator action origin and explicit confirmation.",
    );
  }

  const intent = await getMetaLaunchIntent({
    businessId: access.businessId,
    id: intentId?.trim() ?? "",
  }).catch(() => null);
  if (!intent) {
    return jsonError(404, "launch_intent_not_found", "No such launch intent.");
  }

  /*
    The state of the approval column this request decided against.

    `recordMetaLaunchIntentActivationApproval` updates on `(business_id, id)`
    and a status predicate and nothing else, so two overlapping POSTs to this
    route both build their document from the read above and the later UPDATE
    simply wins. Approve overlapping revoke is the dangerous order: the
    revocation commits, the older approval request finishes afterwards, and it
    replaces the revoked document with a live one — after which the scheduled
    activation runtime, whose whole authority is this column, may turn real
    provider entities on despite the operator having explicitly withdrawn it.

    This is `upsertIntegration`'s `expectedConnectionGeneration` applied to this
    row: a write computed from an earlier read must not land if the row moved
    since. There is no generation column on `meta_launch_intents`, so the
    document itself is the version — jsonb reads back with normalised key order,
    so two reads of an unchanged column stringify identically.
  */
  const expectedApproval = approvalVersion(intent.activationApproval);
  /*
    Compare-and-set is check-then-act, so it needs the check and the write to be
    one step. Postgres gives `claimMetaAutomationProposal` that in a single
    UPDATE ... RETURNING; the store's writer here carries no version predicate
    to fold the check into, so the lock does it instead — the same
    `pg_advisory_xact_lock(hashtextextended(...))` this table's own
    `createMetaLaunchIntent` takes for its semantic guard. Both branches below
    take it, and they are the only writers of `activation_approval_json` the
    application has, so nothing can commit between a re-read and its write.
  */
  const approvalLockKey = [
    "meta-launch-intent-activation-approval",
    access.businessId,
    intent.id,
  ].join(":");

  try {
    if (body?.revoke === true) {
      /*
        Revoking rewrites the stored document with `revokedAt` set rather than
        clearing the column. The validator already refuses a revoked approval,
        and keeping it means the record still says who approved what, and when
        it was withdrawn.

        Deliberately NOT compare-and-set, unlike the approve path below. A
        revocation is the fail-closed direction, so it withdraws whatever stands
        at the moment it runs: refusing it because an approval landed in between
        would leave that approval live, which is the exact outcome the operator
        pressed Revoke to prevent. Re-reading also means the stored record names
        the approval that was actually withdrawn rather than an older one.
      */
      const revoked = await runDbTransaction(async () => {
        const sql = getDb();
        await sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${approvalLockKey}, 0)
          )
        `;
        const current = await getMetaLaunchIntent({
          businessId: access.businessId,
          id: intent.id,
        });
        if (!current) return { missing: true as const };
        const stored = current.activationApproval as ActivationApproval | null;
        return {
          missing: false as const,
          updated: await recordMetaLaunchIntentActivationApproval({
            businessId: access.businessId,
            id: intent.id,
            approval: stored
              ? revokeActivationApproval(stored, new Date().toISOString())
              : null,
          }),
        };
      });
      if (revoked.missing) {
        return jsonError(404, "launch_intent_not_found", "No such launch intent.");
      }
      const updated = revoked.updated;
      return NextResponse.json({
        ok: true,
        intentId: updated.id,
        approval: updated.activationApproval,
        revoked: true,
      });
    }

    const scope = body?.approvedScope === "hierarchy" ? "hierarchy" : "ad";
    const receipt =
      intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
    if (!receipt) {
      return jsonError(
        409,
        "receipt_absent",
        "This intent has no receipt, so there is nothing an approval could name.",
      );
    }
    const ttlHours = Number.isFinite(body?.ttlHours)
      ? Math.min(Math.max(Number(body!.ttlHours), 1), MAX_TTL_HOURS)
      : DEFAULT_TTL_HOURS;
    const approvedAt = new Date();
    const built = buildActivationApproval({
      intent: {
        id: intent.id,
        businessId: intent.businessId,
        providerAccountId: intent.providerAccountId,
        operation: intent.operation,
        requestFingerprint: intent.requestFingerprint,
      },
      identities: {
        campaignId: receipt.campaignId ?? null,
        /*
          The whole set of each, not the first of each.

          The v1 document held one creative and one ad set, so this route used
          to hand the builder `adsetIds[0]` and a single creative — and an
          unattended run of a multi-creative launch was then either refused or,
          worse, covered by an approval that never mentioned two thirds of what
          it turned on. v2 names sets, and they come from the receipt.
        */
        adsetIds: receipt.adsetIds ?? [],
        adIds: receipt.adIds ?? [],
        creativeIds: readCreativeIds(intent),
      },
      approvedScope: scope,
      approvedBy: access.session.user.id,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(
        approvedAt.getTime() + ttlHours * 60 * 60 * 1000,
      ).toISOString(),
      approvedAssetVersion: body?.approvedAssetVersion?.trim() || "v1",
      approvedCopyHash: intentCopyHash(intent),
      policyVersion: ACTIVATION_POLICY_VERSION,
    });
    if (!built.ok) {
      return jsonError(409, built.refusal, refusalMessage(built.refusal));
    }

    const written = await runDbTransaction(async () => {
      const sql = getDb();
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${approvalLockKey}, 0)
        )
      `;
      const current = await getMetaLaunchIntent({
        businessId: access.businessId,
        id: intent.id,
      });
      if (!current) return { conflict: "launch_intent_not_found" as const };
      if (approvalVersion(current.activationApproval) !== expectedApproval) {
        /*
          409, and one honest exception to it. `runDbTransaction` applies a
          `SET LOCAL statement_timeout` of the default web timeout, and the wait
          for the advisory lock above rides that timeout — so a waiter blocked
          longer than it answers 500 `activation_approval_failed` rather than
          this conflict. Fail-closed either way: no write lands. Not reachable
          in practice, because the winner holds the lock for one SELECT and one
          UPDATE — but the loser's contract is "409 except when the lock wait
          times out", not "409 always".
        */
        return { conflict: "activation_approval_conflict" as const };
      }
      return {
        conflict: null,
        updated: await recordMetaLaunchIntentActivationApproval({
          businessId: access.businessId,
          id: intent.id,
          approval: built.approval,
        }),
      };
    });
    if (written.conflict === "launch_intent_not_found") {
      return jsonError(404, "launch_intent_not_found", "No such launch intent.");
    }
    if (written.conflict) {
      /*
        Refused, not silently dropped, and refused under its own code so the
        caller can tell this apart from a malformed approval: this exact request
        would have undone whatever landed while it was in flight.
      */
      return jsonError(
        409,
        "activation_approval_conflict",
        "This intent's activation approval changed while this request was in flight, so it was not applied. Re-read the intent and approve again.",
      );
    }
    const updated = written.updated;
    return NextResponse.json({
      ok: true,
      intentId: updated.id,
      approval: updated.activationApproval,
      revoked: false,
    });
  } catch (error) {
    return jsonError(500, "activation_approval_failed", sanitizeErrorMessage(error));
  }
}

/**
 * The version of the stored approval document, for the compare-and-set above.
 *
 * The document itself, hashed, because nothing else on the row identifies it:
 * `updated_at` also moves when `recordMetaLaunchIntentActivation` stores an
 * activation receipt, which would refuse an approval for a change that did not
 * touch this column at all. `?? null` because the column is NULL on every intent
 * that has never been approved, and `JSON.stringify(undefined)` is not a string.
 */
function approvalVersion(stored: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stored ?? null))
    .digest("hex");
}

/**
 * The creative set this launch actually asked for, canonicalised.
 *
 * One entry per creative, each carrying the id and the name the operator gave
 * it — `nameOverride` on an add-to-existing ref, the `names` map the same
 * request may carry instead, or the ref's own name. Sorted by id so two
 * requests that differ only in the order the creatives were selected hash the
 * same.
 */
function readApprovedCreatives(
  payload: Record<string, unknown> | null,
): Array<{ creativeId: string; name: string | null }> {
  const refs = Array.isArray(payload?.creatives) ? payload!.creatives : [];
  const names =
    payload?.names && typeof payload.names === "object" && !Array.isArray(payload.names)
      ? (payload.names as Record<string, unknown>)
      : {};
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return refs
    .map((item) => {
      if (typeof item === "string") {
        const creativeId = item.trim();
        return creativeId
          ? { creativeId, name: read(names[creativeId]) }
          : null;
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const creativeId = read(record.creativeId) ?? read(record.id);
      if (!creativeId) return null;
      return {
        creativeId,
        name:
          read(record.nameOverride) ??
          read(names[creativeId]) ??
          read(record.name),
      };
    })
    .filter((entry): entry is { creativeId: string; name: string | null } =>
      Boolean(entry),
    )
    .sort((left, right) => left.creativeId.localeCompare(right.creativeId));
}

/**
 * The copy hash, derived here rather than taken from the request.
 *
 * Nothing in this repository produces a copy hash — the Launchpad payload
 * references creatives by id and carries no ad copy at all — so the field the
 * body used to supply was either empty, which `buildActivationApproval`
 * refuses, or a value the browser invented, which binds an approval to nothing.
 * A binding a caller can choose is not a binding. This one is computed from the
 * intent's own creative set, so an approval names the creatives and names this
 * launch actually asked for, and an intent edited afterwards hashes
 * differently.
 */
function intentCopyHash(intent: { requestPayload: unknown }): string {
  const entries = readApprovedCreatives(
    intent.requestPayload as Record<string, unknown> | null,
  );
  return createHash("sha256")
    .update(JSON.stringify({ contract: "meta.launch-approved-copy.v1", entries }))
    .digest("hex");
}

function refusalMessage(code: string): string {
  switch (code) {
    case "activation_approval_scope_mismatch":
      return "Only a launch that created its own campaign may be approved for hierarchy activation.";
    case "activation_approval_asset_mismatch":
      return "An approval must name the creative and the copy it approved.";
    case "activation_approval_destination_mismatch":
      return "The receipt names no destination this approval could authorize.";
    case "activation_approval_approver_absent":
      return "An approval must name the person who gave it.";
    default:
      return "The activation approval could not be recorded as stated.";
  }
}
