/**
 * "Read the canonical decision the server is currently serving for this
 * account", in one place.
 *
 * Both ends of the handoff need exactly this and they must not drift. The mint
 * endpoint reads it to decide whether a handoff may exist at all; the Launchpad
 * landing route reads it AGAIN, at consume time, to decide whether the decision
 * that authorized the handoff still says what it said. Two copies of this
 * lookup would eventually disagree, and the disagreement would show up as a
 * launch opening against a decision the engine had already withdrawn.
 *
 * Nothing here writes. The single provider call is a GET of the current active
 * ad inventory, which is the same current-status truth the Decisions surface
 * was showing; a failed GET reports `complete: false` so the read model
 * reconciles delivery to UNKNOWN rather than to "no active ads".
 */
import {
  fetchMetaActiveAdConfigsReceipt,
  resolveMetaCredentials,
} from "@/lib/api/meta";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  applyMetaExecutionGovernanceToReadModel,
  readMetaDecisionsWorkspaceReadModel,
  type MetaCurrentAdStatusSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import {
  buildMetaDecisionPipelineHealth,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";

export type MetaDecisionsWorkspaceModel = Awaited<
  ReturnType<typeof readMetaDecisionsWorkspaceReadModel>
>;

export async function readCurrentMetaAdInventory(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<{ rows: MetaCurrentAdStatusSourceRow[]; complete: boolean }> {
  try {
    const credentials = await resolveMetaCredentials(input.businessId);
    if (
      !credentials ||
      !credentials.accountIds.includes(input.providerAccountId)
    ) {
      return { rows: [], complete: false };
    }
    const receipt = await fetchMetaActiveAdConfigsReceipt(
      input.providerAccountId,
      credentials.accessToken,
    );
    if (!receipt.complete) return { rows: [], complete: false };
    const fetchedAt = new Date().toISOString();
    return {
      complete: true,
      rows: receipt.rows.map((row) => ({
        providerAccountId: input.providerAccountId,
        adId: row.id,
        adName: row.name ?? null,
        campaignId: row.campaign_id ?? null,
        campaignName: row.campaign?.name ?? null,
        adsetId: row.adset_id ?? null,
        creativeId: row.creative?.id ?? null,
        configuredStatus: row.status ?? null,
        effectiveStatus: row.effective_status ?? null,
        providerUpdatedAt: row.updated_time ?? null,
        fetchedAt,
      })),
    };
  } catch {
    // A failed inventory read is not an empty inventory. `complete: false`
    // makes the read model fail the delivery reconciliation closed to UNKNOWN
    // rather than presenting "no active ads" as fact.
    return { rows: [], complete: false };
  }
}

/** Every decision the workspace is actually serving, across all sections. */
export function collectServedMetaDecisions(
  model: MetaDecisionsWorkspaceModel,
): MetaCanonicalDecision[] {
  if (model.status !== "available") return [];
  return [
    ...Object.values(model.queue.sections).flatMap((section) => section.items),
    ...(model.queue.adCandidates?.items ?? []),
    ...(model.queue.inactiveAssets?.items ?? []),
  ];
}

export type ReadServedMetaDecisionResult =
  | { status: "found"; decision: MetaCanonicalDecision }
  | { status: "not_served" }
  | { status: "source_unavailable"; message: string };

/**
 * Finds ONE decision by the pair that identifies it.
 *
 * Both the id and the snapshot id must match. Matching on the decision id alone
 * would let a handoff minted against yesterday's snapshot bind to today's
 * re-evaluation of the same entity, which is a different verdict wearing the
 * same name.
 */
export async function readServedMetaDecision(input: {
  businessId: string;
  providerAccountId: string;
  decisionId: string;
  sourceSnapshotId: string;
}): Promise<ReadServedMetaDecisionResult> {
  const now = new Date();
  const currentAds = await readCurrentMetaAdInventory({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  let model: MetaDecisionsWorkspaceModel;
  try {
    const [decisionModel, governance, operationalPipelineHealth] =
      await Promise.all([
      readMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        currentAds: currentAds.rows,
        currentAdSourceComplete: currentAds.complete,
        generatedAt: now.toISOString(),
      }),
      readEffectiveMetaWriteGovernance({ businessId: input.businessId }),
      readMetaDecisionPipelineOperationalHealth({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        now,
      }),
    ]);
    const pipelineHealth = buildMetaDecisionPipelineHealth({
      operational: operationalPipelineHealth,
      decisionReadModel: decisionModel,
      now,
    });
    model = applyMetaExecutionGovernanceToReadModel({
      model: decisionModel,
      governance,
      pipeline: {
        verified: pipelineHealth.overall !== "unavailable",
        executionReady: pipelineHealth.executionReady,
      },
      now,
    });
  } catch {
    return {
      status: "source_unavailable",
      message:
        "The canonical decision source could not be read, so no handoff was created.",
    };
  }
  if (model.status !== "available") {
    return {
      status: "source_unavailable",
      message:
        model.unavailable?.message ??
        "The canonical decision source is unavailable, so no handoff was created.",
    };
  }
  const decision =
    collectServedMetaDecisions(model).find(
      (candidate) =>
        candidate.decisionId === input.decisionId &&
        candidate.sourceSnapshotId === input.sourceSnapshotId,
    ) ?? null;
  return decision ? { status: "found", decision } : { status: "not_served" };
}
