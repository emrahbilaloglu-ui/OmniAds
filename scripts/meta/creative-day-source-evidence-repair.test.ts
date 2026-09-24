import { describe, expect, it } from "vitest";
import { buildCreativeDaySourceEvidenceRepairPlan } from "./creative-day-source-evidence-repair";
import type { MetaAdDailyRow, MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";

const day = "2026-09-23";
const businessId = "5dbc7147-f051-4681-a4d6-20617170074f";
const accountId = "act_805150454596350";
const adId = "ad-1";
const creativeId = "creative-1";
const pointerId = "11111111-1111-4111-8111-111111111111";
const newSliceId = "22222222-2222-4222-8222-222222222222";
const targetManifestId = "33333333-3333-4333-8333-333333333333";
const oldSliceId = "44444444-4444-4444-8444-444444444444";
const oldManifestId = "55555555-5555-4555-8555-555555555555";
const raw = { ad_id: adId, date_start: day, spend: "10", impressions: "100",
  clicks: "5" } as Record<string, unknown>;
const creative = {
  businessId, providerAccountId: accountId, date: day, creativeId,
  spend: 10, impressions: 100, clicks: 5, reach: 80, frequency: 1.25,
  conversions: 0, revenue: 0, roas: 0, cpa: null, ctr: 5, cpc: null,
  linkClicks: null, updatedAt: "2026-09-24T05:00:00.000Z",
  payloadJson: { source_identity_version: "meta-creative-membership.v2",
    source_ad_ids_complete: true, source_ad_ids: [adId],
    source_creative_ids: [creativeId], associated_ads_count: 1,
    metric_presence: { purchases: false } },
} as MetaCreativeDailyRow;
const ad = {
  businessId, providerAccountId: accountId, date: day, adId,
  spend: 10, impressions: 100, clicks: 5, reach: 80, frequency: 1.25,
  conversions: 0, revenue: 0, linkClicks: null, sourceRunId: "run-1",
  sourceSnapshotId: "snapshot-1", truthState: "finalized",
  validationStatus: "passed", finalizedAt: "2026-09-24T06:00:00.000Z",
  accountTimezone: "Europe/Istanbul", payloadJson: raw,
} as MetaAdDailyRow;
const snapshot = {
  id: "snapshot-1", business_id: businessId, provider_account_id: accountId,
  endpoint_name: "ad_insights_bulk", entity_scope: "ad", start_date: day, end_date: day,
  status: "fetched", provider_http_status: 200, payload_hash: "sha-1",
  payload_json: [raw], fetched_at: "2026-09-24T06:00:00.000Z",
  created_at: "2026-09-24T06:00:00.000Z", partition_id: "partition-1",
  updated_at: "2026-09-24T06:00:00.000Z",
  run_id: "run-1", content_key: "modern-content" as string | null, page_index: 0,
  provider_cursor: null,
  request_context: { level: "ad", source: "bulk_core_sync" } as Record<string, unknown>,
};
const receipt = {
  day, published_by_run_id: "run-1", published_at: "2026-09-24T06:10:00.000Z",
  pointer_id: pointerId, slice_id: newSliceId, manifest_id: targetManifestId,
  publication_reason: "regular_sync", slice_validation_summary: {},
  slice_source_run_id: "run-1", slice_state: "finalized_verified",
  slice_truth_state: "finalized", slice_validation_status: "passed",
  slice_status: "published", staged_row_count: 1,
  manifest_fetch_status: "completed", manifest_account_timezone: "Europe/Istanbul",
  manifest_started_at: "2026-09-24T05:59:00.000Z",
  manifest_completed_at: "2026-09-24T06:05:00.000Z",
  manifest_raw_snapshot_watermark: "snapshot-1",
  manifest_rows_fetched_total: 1, manifest_partition_id: "partition-1",
  manifest_fresh_start_applied: true, manifest_checkpoint_reset_applied: true,
};
const priorSlice = {
  id: oldSliceId, business_id: businessId, provider_account_id: accountId,
  day, surface: "ad_daily", manifest_id: oldManifestId,
  source_run_id: "run-1", status: "superseded",
  truth_state: "finalized", validation_status: "passed",
  published_at: "2026-09-24T06:09:59.997Z",
  superseded_at: "2026-09-24T09:00:00.000Z",
};
const validationEvent = {
  manifest_id: targetManifestId, day, surface: "account_daily",
  event_kind: "validation_passed", result: "passed",
  created_at: "2026-09-24T06:06:00.000Z",
};
const observation = {
  snapshot_id: "snapshot-1", run_id: "run-1", partition_id: "partition-1",
  endpoint_name: "ad_insights_bulk", entity_scope: "ad", page_index: 0,
  status: "fetched", provider_http_status: 200,
  request_context: { level: "ad", source: "bulk_core_sync" },
  observed_at: "2026-09-24T06:01:00.000Z",
  created_at: "2026-09-24T06:01:00.000Z",
};

function plan(overrides: {
  creative?: MetaCreativeDailyRow; ad?: MetaAdDailyRow;
  snapshot?: typeof snapshot; receipt?: typeof receipt;
  observation?: typeof observation; observations?: typeof observation[];
  priorSlices?: typeof priorSlice[];
  validationEvents?: typeof validationEvent[];
} = {}) {
  return buildCreativeDaySourceEvidenceRepairPlan({ businessId, accountId,
    from: day, to: day,
    creativeRows: [overrides.creative ?? creative], adRows: [overrides.ad ?? ad],
    snapshots: [overrides.snapshot ?? snapshot], receipts: [overrides.receipt ?? receipt],
    observations: overrides.observations ?? [overrides.observation ?? observation],
    priorSlices: overrides.priorSlices ?? [],
    validationEvents: overrides.validationEvents ?? [validationEvent] });
}

const legacyRawUpdatedAt = "2026-09-24T07:00:00.000Z";
const legacyProof = {
  repairContract: "meta-historical-source-slice-repair.v2",
  reviewedPlanHash: "a".repeat(64), receiptKind: "legacy_run_bound_raw",
  sourceSnapshotId: snapshot.id, targetManifestId,
  sourcePartitionId: snapshot.partition_id, rawUpdatedAt: legacyRawUpdatedAt,
  oldPointerId: pointerId, oldSliceId, oldManifestId,
  oldPublishedAt: "2026-09-24T06:10:00.000Z", oldRunId: "run-1",
};
function legacyRebind(overrides: {
  proof?: Record<string, unknown>; priorSlices?: typeof priorSlice[];
  snapshot?: typeof snapshot; receipt?: typeof receipt;
  observations?: typeof observation[];
  validationEvents?: typeof validationEvent[];
} = {}) {
  return plan({
    snapshot: overrides.snapshot ?? { ...snapshot, status: "superseded",
      content_key: null, updated_at: legacyRawUpdatedAt },
    receipt: overrides.receipt ?? { ...receipt,
      published_at: "2026-09-24T09:00:00.000Z",
      publication_reason: "manifest_rebind_repair",
      slice_validation_summary: overrides.proof ?? legacyProof },
    priorSlices: overrides.priorSlices ?? [priorSlice],
    observations: overrides.observations ?? [],
    validationEvents: overrides.validationEvents ?? [validationEvent],
  });
}

describe("source-backed creative day evidence repair", () => {
  it("pins the exact sub-millisecond write clock into the reviewed manifest hash", () => {
    const before = plan({ creative: { ...creative,
      updatedAt: "2026-09-24T06:41:08.124868Z" } as MetaCreativeDailyRow });
    const after = plan({ creative: { ...creative,
      updatedAt: "2026-09-24T06:41:08.124999Z" } as MetaCreativeDailyRow });
    expect(before.manifest.changes[0]?.oldUpdatedAt)
      .toBe("2026-09-24T06:41:08.124868Z");
    expect(after.manifest.changes[0]?.oldUpdatedAt)
      .toBe("2026-09-24T06:41:08.124999Z");
    expect(before.manifestHash).not.toBe(after.manifestHash);
  });

  it("recovers omitted Graph actions as measured zero only from exact published source", () => {
    const result = plan();
    expect(result.blockers).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.reason).toBe("evidence_only");
    expect(result.changes[0]!.nextPayload).toMatchObject({
      purchase_evidence: { state: "measured", value: 0 },
      metric_evidence: { stages: {
        link_click: { state: "measured", value: 0 },
        landing_page_view: { state: "measured", value: 0 },
        add_to_cart: { state: "measured", value: 0 },
        initiate_checkout: { state: "measured", value: 0 },
      } },
      metric_presence: { purchases: true, link_clicks: true },
    });
    const change = result.changes[0]!;
    const repaired = { ...creative, ...change.next,
      payloadJson: change.nextPayload } as MetaCreativeDailyRow;
    expect(plan({ creative: repaired }).changes).toHaveLength(0);
  });

  it("includes an impression-bearing zero-spend day but skips a truly empty day", () => {
    const impressionOnly = plan({
      creative: { ...creative, spend: 0 } as MetaCreativeDailyRow,
      ad: { ...ad, spend: 0, payloadJson: { ...raw, spend: "0" } } as MetaAdDailyRow,
      snapshot: { ...snapshot, payload_json: [{ ...raw, spend: "0" }] },
    });
    expect(impressionOnly.manifest.counts.candidates).toBe(1);
    expect(impressionOnly.blockers).toEqual([]);

    const empty = plan({
      creative: { ...creative, spend: 0, impressions: 0, clicks: 0,
        conversions: 0, revenue: 0 } as MetaCreativeDailyRow,
    });
    expect(empty.manifest.counts.candidates).toBe(0);
  });

  it("reconciles a later finalized purchase and keeps unrelated payload keys", () => {
    const actions = [{ action_type: "purchase", value: "1" },
      { action_type: "omni_purchase", value: "1" }];
    const source = { ...raw, actions, spend: "10.05", impressions: "101" };
    const result = plan({
      creative: { ...creative, payloadJson: { ...(creative.payloadJson as Record<string, unknown>),
        thumbnail_url: "https://example.test/image.jpg" } } as MetaCreativeDailyRow,
      ad: { ...ad, spend: 10.05, impressions: 101, conversions: 1, revenue: 90,
        payloadJson: source } as MetaAdDailyRow,
      snapshot: { ...snapshot, payload_json: [source] },
    });
    expect(result.blockers).toEqual([]);
    expect(result.changes[0]).toMatchObject({
      reason: "finalized_ad_day_restatement",
      old: { conversions: 0, revenue: 0, spend: 10, impressions: 100 },
      next: { conversions: 1, revenue: 90, spend: 10.05, impressions: 101 },
      nextPayload: { purchases: 1, purchase_value: 90,
        thumbnail_url: "https://example.test/image.jpg",
        purchase_evidence: { state: "measured", value: 1 } },
    });
  });

  it("blocks malformed or incomplete source instead of minting a zero", () => {
    expect(plan({ snapshot: { ...snapshot, provider_http_status: 500 } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    const malformed = [{ action_type: "purchase", value: "1bad" }];
    expect(plan({
      snapshot: { ...snapshot, payload_json: [{ ...raw, actions: malformed }] },
      ad: { ...ad, payloadJson: { ...raw, actions: malformed } } as MetaAdDailyRow,
    }).blockers)
      .toMatchObject([{ reason: "raw_purchase_conflicts_with_finalized_ad:ad-1" }]);
    expect(plan({ receipt: { ...receipt, staged_row_count: 2 } }).blockers)
      .toMatchObject([{ reason: "published_ad_day_receipt_incomplete" }]);
    expect(plan({ snapshot: { ...snapshot, request_context: { ...snapshot.request_context,
      fields: "spend,impressions,clicks" } } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ snapshot: { ...snapshot, fetched_at: "2026-09-24T06:07:00.000Z" } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ receipt: { ...receipt,
      manifest_completed_at: "2026-09-24T06:12:00.000Z" } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ receipt: { ...receipt,
      manifest_raw_snapshot_watermark: "other-page" } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ observation: { ...observation,
      observed_at: "2026-09-24T06:07:00.000Z" } }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ observations: [] }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ snapshot: { ...snapshot, content_key: null },
      observations: [] }).blockers).toEqual([]);
    expect(plan({ validationEvents: [] }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
    expect(plan({ validationEvents: [validationEvent, {
      ...validationEvent, event_kind: "totals_mismatch", result: "repair_required",
      created_at: "2026-09-24T06:07:00.000Z",
    }] }).blockers)
      .toMatchObject([{ reason: "ad_source_receipt_invalid:ad-1" }]);
  });

  it("accepts only a D113 v2-proved legacy page superseded after its old pointer", () => {
    const result = legacyRebind();
    expect(result.blockers).toEqual([]);
    expect(result.changes[0]?.nextPayload).toMatchObject({
      purchase_evidence: { state: "measured", value: 0 },
      metric_evidence: { stages: { landing_page_view: { state: "measured", value: 0 } } },
    });
    expect(result.manifest.changes[0]?.source[0]).toMatchObject({
      snapshotStatus: "superseded", manifestId: targetManifestId,
      rawUpdatedAt: legacyRawUpdatedAt,
      priorPublication: { pointerId, sliceId: oldSliceId,
        publishedAt: legacyProof.oldPublishedAt,
        reviewedPlanHash: legacyProof.reviewedPlanHash },
    });
    expect(result.manifest.contract).toBe("adsecute.meta-creative-day-source-evidence-repair.v3");
  });

  it("keeps D113 v3's cent-precision rebind eligible for exact creative source evidence", () => {
    const result = legacyRebind({ proof: {
      ...legacyProof,
      repairContract: "meta-historical-source-slice-repair.v3",
      spendVarianceProof: {
        sourceCents: 5002, adCents: 5000, absoluteDeltaCents: 2,
        rowCount: 5, maxQuantizationDoubleCents: 6,
      },
    } });
    expect(result.blockers).toEqual([]);
    expect(result.changes).toHaveLength(1);
  });

  it("rejects superseded raw without the exact old pointer, slice and clock proof", () => {
    const blocked = (result: ReturnType<typeof legacyRebind>) =>
      expect(result.blockers).toMatchObject([{
        reason: "legacy_supersession_receipt_invalid:ad-1",
      }]);
    blocked(legacyRebind({ proof: {} }));
    blocked(legacyRebind({ priorSlices: [] }));
    blocked(legacyRebind({ proof: { ...legacyProof, oldSliceId: newSliceId } }));
    blocked(legacyRebind({ proof: { ...legacyProof, oldManifestId: targetManifestId } }));
    blocked(legacyRebind({ proof: { ...legacyProof, targetManifestId: oldManifestId } }));
    blocked(legacyRebind({ proof: { ...legacyProof,
      rawUpdatedAt: "2026-09-24T07:00:01.000Z" } }));
    blocked(legacyRebind({ proof: { ...legacyProof,
      oldPublishedAt: "2026-09-24T07:00:00.000Z" } }));
    blocked(legacyRebind({ priorSlices: [{ ...priorSlice,
      published_at: "2026-09-24T06:10:00.001Z" }] }));
    blocked(legacyRebind({ priorSlices: [{ ...priorSlice,
      validation_status: "pending" }] }));
    blocked(legacyRebind({ snapshot: { ...snapshot, status: "superseded",
      content_key: null, updated_at: "2026-09-24T06:09:00.000Z" } }));
    blocked(legacyRebind({ observations: [observation] }));
    expect(legacyRebind({ validationEvents: [] }).blockers).toMatchObject([{
      reason: "ad_source_receipt_invalid:ad-1",
    }]);
    blocked(legacyRebind({ receipt: { ...receipt,
      published_at: "2026-09-24T09:00:00.000Z",
      publication_reason: "regular_sync", slice_validation_summary: legacyProof } }));
  });
});
