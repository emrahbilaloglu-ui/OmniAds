import { getDb } from "@/lib/db";
import {
  normalizeMetaLaunchIntentLineage,
  type MetaLaunchIntentLineage,
} from "@/lib/launchpad/meta-launch-intent";
import { buildMetaCreativeDecisionId } from "@/lib/meta/creative-brief-contract";
import { readMetaCreativeBrief } from "@/lib/meta/creative-brief-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MetaLaunchIntentLineageError extends Error {
  constructor(
    readonly code:
      | "creative_brief_not_found"
      | "creative_brief_not_reviewed"
      | "source_decision_snapshot_required"
      | "source_decision_not_found"
      | "source_decision_mismatch"
      | "source_draft_not_found",
    message: string,
  ) {
    super(message);
    this.name = "MetaLaunchIntentLineageError";
  }
}

async function readVerifiedDecision(input: {
  businessId: string;
  providerAccountId: string;
  snapshotId: string;
}) {
  if (!UUID_PATTERN.test(input.snapshotId)) return null;
  const rows = await getDb().query<{
    snapshot_id: string;
    creative_id: string;
    scope_type: string;
    scope_id: string;
  }>(
    `
      WITH account_creatives AS (
        SELECT creative_id
        FROM meta_creative_dimensions
        WHERE business_id = $1
          AND provider_account_id = $2
        UNION
        SELECT creative_id
        FROM meta_creative_daily
        WHERE business_id = $1
          AND provider_account_id = $2
      )
      SELECT
        snapshot.id::text AS snapshot_id,
        snapshot.creative_id,
        snapshot.scope_type,
        snapshot.scope_id
      FROM engine_v3_decision_snapshots_daily snapshot
      WHERE snapshot.id = $3::uuid
        AND (
          snapshot.business_id = $1
          OR snapshot.business_ref_id::text = $1
        )
        AND EXISTS (
          SELECT 1
          FROM account_creatives account_creative
          WHERE account_creative.creative_id = snapshot.creative_id
        )
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.snapshotId],
  );
  return rows[0] ?? null;
}

async function sourceDraftExists(input: {
  businessId: string;
  providerAccountId: string;
  sourceDraftId: string;
}) {
  if (!UUID_PATTERN.test(input.sourceDraftId)) return false;
  const rows = await getDb().query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM meta_launch_drafts
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND id = $3::uuid
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId, input.sourceDraftId],
  );
  return Boolean(rows[0]);
}

export async function verifyMetaLaunchIntentLineage(input: {
  businessId: string;
  providerAccountId: string;
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
  sourceDraftId?: string | null;
}): Promise<MetaLaunchIntentLineage> {
  const lineage = normalizeMetaLaunchIntentLineage(input);

  if (lineage.creativeBriefId) {
    const brief = await readMetaCreativeBrief({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      id: lineage.creativeBriefId,
    });
    if (!brief) {
      throw new MetaLaunchIntentLineageError(
        "creative_brief_not_found",
        "Creative Brief was not found in the selected Meta account.",
      );
    }
    if (brief.status !== "reviewed") {
      throw new MetaLaunchIntentLineageError(
        "creative_brief_not_reviewed",
        "Creative Brief must be reviewed before it can become launch lineage.",
      );
    }
    if (
      lineage.sourceDecisionId &&
      lineage.sourceDecisionId !== brief.sourceDecision.decisionId
    ) {
      throw new MetaLaunchIntentLineageError(
        "source_decision_mismatch",
        "sourceDecisionId does not match the Creative Brief source decision.",
      );
    }
    if (
      lineage.sourceDecisionSnapshotId &&
      lineage.sourceDecisionSnapshotId !== brief.sourceDecision.snapshotId
    ) {
      throw new MetaLaunchIntentLineageError(
        "source_decision_mismatch",
        "sourceDecisionSnapshotId does not match the Creative Brief source snapshot.",
      );
    }
    lineage.sourceDecisionId = brief.sourceDecision.decisionId;
    lineage.sourceDecisionSnapshotId = brief.sourceDecision.snapshotId;
  } else if (lineage.sourceDecisionId) {
    if (!lineage.sourceDecisionSnapshotId) {
      throw new MetaLaunchIntentLineageError(
        "source_decision_snapshot_required",
        "sourceDecisionSnapshotId is required when linking a LaunchIntent directly to a decision.",
      );
    }
    const source = await readVerifiedDecision({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      snapshotId: lineage.sourceDecisionSnapshotId,
    });
    if (!source) {
      throw new MetaLaunchIntentLineageError(
        "source_decision_not_found",
        "The source decision snapshot is not available in the selected Meta account.",
      );
    }
    const verifiedDecisionId = buildMetaCreativeDecisionId({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      creativeId: source.creative_id,
      scopeType: source.scope_type,
      scopeId: source.scope_id,
    });
    if (verifiedDecisionId !== lineage.sourceDecisionId) {
      throw new MetaLaunchIntentLineageError(
        "source_decision_mismatch",
        "sourceDecisionId does not match the account-scoped source snapshot.",
      );
    }
  } else if (lineage.sourceDecisionSnapshotId) {
    throw new MetaLaunchIntentLineageError(
      "source_decision_mismatch",
      "sourceDecisionId is required when sourceDecisionSnapshotId is provided.",
    );
  }

  if (
    lineage.sourceDraftId &&
    !(await sourceDraftExists({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      sourceDraftId: lineage.sourceDraftId,
    }))
  ) {
    throw new MetaLaunchIntentLineageError(
      "source_draft_not_found",
      "The source Launchpad draft was not found in the selected Meta account.",
    );
  }

  return lineage;
}

/** Every way the check below can say the staged approval no longer stands. */
export type MetaLaunchIntentApprovalWithdrawalCode =
  | MetaLaunchIntentLineageError["code"]
  | "launch_approval_source_unreadable";

export type MetaLaunchIntentApprovalStanding =
  | { stands: true }
  | {
      stands: false;
      code: MetaLaunchIntentApprovalWithdrawalCode;
      message: string;
    };

/**
 * Does the approval this intent was staged under STILL stand?
 *
 * `verifyMetaLaunchIntentLineage` runs once, inside `createMetaLaunchIntent`.
 * After that the intent stores the brief's ID, and an ID does not change when
 * the brief behind it does: `patchMetaCreativeBrief` writes whatever status the
 * patch states and forces `draft` on any content edit that states none, while
 * every immutability check on the way to a create — account, operation,
 * idempotency key, request fingerprint, the four lineage ids — still matches
 * afterwards. So a review withdrawn between the staging and the provider POST
 * was not seen by anything.
 *
 * This asks the original question again, of the CURRENT rows, and it asks it
 * through the same function that asked it the first time rather than a second
 * copy of the rule.
 *
 * ## Which of those refusals can really answer "withdrawn"
 *
 * `verifyMetaLaunchIntentLineage` can raise six codes, but for an intent that
 * is already STORED only one of them is reachable, and claiming the guard
 * covers "exactly what counted as not approvable at creation" overstated it:
 *
 * - `creative_brief_not_reviewed` is the live one. It is what an explicit
 *   revert to `draft` produces, and what a content edit that states no status
 *   produces — the shipped UPDATE forces `draft` in that second case. An edit
 *   that re-states `reviewed` deliberately does NOT produce it.
 * - `creative_brief_not_found` and `source_draft_not_found` cannot happen while
 *   the intent exists: `meta_launch_intents.creative_brief_id` and
 *   `.source_draft_id` are both `REFERENCES … ON DELETE RESTRICT`, so neither
 *   row can be deleted out from under a binding intent.
 * - `source_decision_mismatch` cannot happen to a brief-bound intent either.
 *   A brief's `source_decision_id` / `source_snapshot_id` are written only by
 *   the INSERT in `creative-brief-store.ts`; its single UPDATE never touches
 *   them, and `parsePatchMetaCreativeBriefRequest` refuses any patch that so
 *   much as names `sourceDecision` (`source_decision_immutable`).
 *
 * The unreachable three stay coded, and stay covered, as defence in depth: this
 * function is the guard, not the schema, and a later migration that relaxed one
 * of those constraints must find the question already being asked rather than
 * find this read silently unable to answer it.
 *
 * An edit that leaves the brief `reviewed` and its source decision unchanged is
 * NOT a withdrawal: nothing here reads the brief's text, its version or its
 * review timestamp, so re-reviewing an edited brief keeps the launch runnable.
 *
 * ## The intents that bind no brief
 *
 * An intent binding neither a brief nor a decision snapshot was composed and
 * confirmed on the Launchpad screen. Its authority is the operator confirmation
 * stored inside its own request payload, and that payload still hashing to
 * `request_fingerprint` — which the callers re-check for themselves — is what
 * proves the confirmation was not swapped for another. There is no staged
 * approval for a later edit to withdraw, so it is answered without a read.
 *
 * An intent binding a DECISION SNAPSHOT and no brief is a different thing, and
 * it used to take the same exemption. `createMetaLaunchIntent` accepts that
 * shape, `READY_LAUNCH_INTENT_SQL` makes it queue-eligible, and the approval it
 * was staged under is the decision snapshot itself — so it is asked the same
 * question as everything else, which is what makes `source_decision_not_found`
 * and the snapshot arm of `source_decision_mismatch` reachable codes rather
 * than advertised ones. The exemption was safe only because the sole writer of
 * decision lineage today happens to join a brief; safe by accident is not safe.
 *
 * The key is the SOURCES that can be re-resolved — a brief, or a snapshot — and
 * that is exact rather than lenient. A lineage naming a decision but no
 * snapshot is not a third case to answer for: `createMetaLaunchIntent` runs
 * `verifyMetaLaunchIntentLineage` before it inserts and refuses that shape with
 * `source_decision_snapshot_required`, so no stored intent carries it, and the
 * code stays coded for the same defence-in-depth reason as the three above.
 *
 * A read that fails is not "unchanged". It returns `launch_approval_source_unreadable`,
 * because an approval nobody can read is not an approval anything may write under.
 */
export async function readMetaLaunchIntentApprovalStanding(input: {
  businessId: string;
  providerAccountId: string;
  lineage: MetaLaunchIntentLineage;
}): Promise<MetaLaunchIntentApprovalStanding> {
  if (
    !input.lineage.creativeBriefId
    && !input.lineage.sourceDecisionSnapshotId
  ) {
    return { stands: true };
  }
  try {
    await verifyMetaLaunchIntentLineage({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      sourceDecisionId: input.lineage.sourceDecisionId,
      sourceDecisionSnapshotId: input.lineage.sourceDecisionSnapshotId,
      creativeBriefId: input.lineage.creativeBriefId,
      sourceDraftId: input.lineage.sourceDraftId,
    });
    return { stands: true };
  } catch (error) {
    if (error instanceof MetaLaunchIntentLineageError) {
      return { stands: false, code: error.code, message: error.message };
    }
    return {
      stands: false,
      code: "launch_approval_source_unreadable",
      message:
        "The approval this launch was staged under could not be read, so nothing was created on Meta.",
    };
  }
}
