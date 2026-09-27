import { getDb, type DbClient } from "@/lib/db";

export interface NativeDecisionWorkflowSource {
  sourceEvaluationId: string;
  sourceSnapshotId: string;
  providerAccountId: string;
  entityType: "ad";
  entityId: string;
}

/** Feedback names one immutable observation. It never grants action authority. */
export async function verifyNativeDecisionWorkflowSource(input: {
  businessId: string;
  decisionKey: string;
  sourceEvaluationId?: unknown;
  sourceSnapshotId?: unknown;
  providerAccountId?: unknown;
  entityType?: unknown;
  entityId?: unknown;
}, db?: DbClient): Promise<"verified" | "mismatch" | "unavailable"> {
  if (typeof input.sourceSnapshotId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sourceSnapshotId) ||
      typeof input.sourceEvaluationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sourceEvaluationId) ||
      input.decisionKey !== `native-ad:${input.sourceSnapshotId}:${input.sourceEvaluationId}` ||
      input.entityType !== "ad" || typeof input.entityId !== "string" ||
      typeof input.providerAccountId !== "string") return "mismatch";
  try {
    const result = await (db ?? getDb()).query<{ id: string }>(`
      SELECT s.id::text AS id
      FROM engine_v3_ad_decision_snapshots_daily s
      JOIN business_provider_accounts bpa ON bpa.business_id = s.business_id
        AND bpa.provider_account_id = s.provider_account_id
        AND bpa.provider = 'meta' AND bpa.is_selected = TRUE
      JOIN engine_v3_ad_decision_evaluations e ON e.id = s.evaluation_id
        AND e.business_id = s.business_id
        AND e.provider_account_id = s.provider_account_id
        AND e.ad_id = s.ad_id
      WHERE s.business_id = $1 AND s.provider_account_id = $2
        AND s.ad_id = $3 AND s.id = $4::uuid AND e.id = $5::uuid
      LIMIT 1`, [input.businessId, input.providerAccountId, input.entityId, input.sourceSnapshotId, input.sourceEvaluationId]);
    return result.length === 1 ? "verified" : "mismatch";
  } catch { return "unavailable"; }
}
