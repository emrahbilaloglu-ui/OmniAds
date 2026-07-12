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
