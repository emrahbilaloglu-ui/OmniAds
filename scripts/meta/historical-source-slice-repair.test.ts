import { describe, expect, it } from "vitest";
import { evaluateHistoricalSourceSlice, type RepairEvidence } from "./historical-source-slice-repair";

const BUSINESS = "business-example";
const ACCOUNT = "act_example";
const DAY = "2026-09-21";
const CUTOFF = "2026-09-24T14:15:00.000Z";
const RUN = "capture-run";
const RAW = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const PARTITION = "44444444-4444-4444-8444-444444444444";
const row = { ad_id: "ad-1", spend: "50.00", impressions: "500", actions: [] };

function evidence(): RepairEvidence {
  return {
    pointer: {
      id: "pointer", activeSliceId: "slice-old", activeManifestId: OLD,
      publishedByRunId: RUN, publishedAt: "2026-09-23T06:50:33.000Z",
      publicationReason: "authoritative_refresh", createdAt: "2026-09-22T08:05:00.000Z",
      updatedAt: "2026-09-23T06:50:33.000Z", businessRefId: BUSINESS,
      providerAccountRefId: ACCOUNT,
    },
    ads: [{
      id: "ad-row", adId: "ad-1", sourceRunId: RUN, sourceSnapshotId: RAW,
      payload: row, spend: 50, accountTimezone: "Europe/Istanbul",
      truthState: "finalized", validationStatus: "passed",
      createdAt: "2026-09-22T08:05:00.000Z",
      updatedAt: "2026-09-23T06:50:32.700Z",
      businessRefId: BUSINESS, providerAccountRefId: ACCOUNT,
    }],
    manifests: [{
      id: TARGET, runId: RUN, surface: "account_daily", fetchStatus: "completed",
      accountTimezone: "Europe/Istanbul", watermark: RAW, sourceSpend: 50,
      rowsFetchedTotal: "1", partitionId: PARTITION,
      freshStartApplied: true, checkpointResetApplied: true,
      startedAt: "2026-09-23T06:50:31.000Z",
      completedAt: "2026-09-23T06:50:32.437Z",
      createdAt: "2026-09-23T06:50:32.449Z",
      updatedAt: "2026-09-23T06:50:32.449Z",
      businessRefId: BUSINESS, providerAccountRefId: ACCOUNT,
    }],
    raw: {
      id: RAW, businessId: BUSINESS, accountId: ACCOUNT,
      partitionId: PARTITION, runId: RUN, endpointName: "ad_insights_bulk",
      entityScope: "ad", startDate: DAY, endDate: DAY, pageIndex: 0,
      status: "fetched", httpStatus: 200,
      requestContext: { source: "bulk_core_sync", level: "ad", fields: "ad_id,spend,actions" },
      payload: [row], contentKey: "content-addressed", fetchedAt: "2026-09-23T06:50:31.800Z",
      createdAt: "2026-09-23T06:50:31.800Z",
    },
    observations: [{
      id: "receipt", snapshotId: RAW, partitionId: PARTITION, runId: RUN,
      endpointName: "ad_insights_bulk", entityScope: "ad", pageIndex: 0,
      status: "fetched", httpStatus: 200,
      requestContext: { source: "bulk_core_sync", level: "ad", fields: "ad_id,spend,actions" },
      observedAt: "2026-09-23T06:50:31.810Z",
      createdAt: "2026-09-23T06:50:31.810Z",
    }],
    reconciliations: [{
      id: "validation-receipt", manifestId: TARGET,
      surface: "account_daily", eventKind: "validation_passed",
      result: "passed", sourceSpend: 50, warehouseAccountSpend: 50,
      createdAt: "2026-09-23T06:50:32.900Z",
    }],
  };
}

function plan(value: RepairEvidence) {
  return evaluateHistoricalSourceSlice({
    businessId: BUSINESS, accountId: ACCOUNT, day: DAY, cutoff: CUTOFF,
    evidence: value,
  });
}

describe("historical source slice repair proof", () => {
  it("selects the exact completed capture and preserves the old pointer in its plan", () => {
    const result = plan(evidence());
    expect(result).toMatchObject({
      state: "repairable", blockers: [],
      old: { activeSliceId: "slice-old", manifestId: OLD },
      next: { manifestId: TARGET, sourceSnapshotId: RAW,
        rowCount: 1, aggregatedSpend: 50, receiptKind: "run_observation" },
    });
  });

  it("never binds a capture completed after the published pointer", () => {
    const value = evidence();
    value.manifests[0]!.completedAt = "2026-09-23T06:51:00.000Z";
    expect(plan(value).blockers).toContain("matching_completed_manifest_before_pointer_missing");
  });

  it("rejects an intervening different capture despite the earlier exact payload", () => {
    const value = evidence();
    value.manifests.push({ ...value.manifests[0]!, id: "newer",
      watermark: "different", completedAt: "2026-09-23T06:50:32.900Z" });
    expect(plan(value).blockers).toContain("intervening_different_capture");
  });

  it("rejects superseded or late run receipts", () => {
    const superseded = evidence();
    superseded.observations[0]!.status = "superseded";
    expect(plan(superseded).blockers).toContain("observation_not_causal_or_superseded");
    const late = evidence();
    late.observations[0]!.observedAt = "2026-09-23T06:50:32.900Z";
    expect(plan(late).blockers).toContain("observation_not_causal_or_superseded");
  });

  it("rejects rows written after the pointer and source spend disagreement", () => {
    const laterRow = evidence();
    laterRow.ads[0]!.updatedAt = "2026-09-23T06:50:34.000Z";
    expect(plan(laterRow).blockers).toContain("stored_ad_lineage_invalid");
    const drift = evidence();
    drift.manifests[0]!.sourceSpend = 49;
    expect(plan(drift).blockers).toContain("source_spend_mismatch");
  });

  it("rejects missing actions request and raw payload drift", () => {
    const missingField = evidence();
    missingField.raw!.requestContext = { source: "bulk_core_sync", level: "ad", fields: "spend" };
    expect(plan(missingField).blockers).toContain("raw_page_scope_or_request_invalid");
    const drift = evidence();
    drift.ads[0]!.payload = { ...row, spend: "49.00" };
    expect(plan(drift).blockers).toContain("stored_ad_payload_not_exact_raw");
  });

  it("requires exact-manifest validation before publication and rejects failed reconciliation", () => {
    const missing = evidence();
    missing.reconciliations = [];
    expect(plan(missing).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
    const wrongManifest = evidence();
    wrongManifest.reconciliations[0]!.manifestId = OLD;
    expect(plan(wrongManifest).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
    const mismatch = evidence();
    mismatch.reconciliations.push({ ...mismatch.reconciliations[0]!,
      id: "mismatch-receipt", eventKind: "totals_mismatch", result: "repair_required" });
    expect(plan(mismatch).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
    const late = evidence();
    late.reconciliations[0]!.createdAt = "2026-09-23T06:50:34.000Z";
    expect(plan(late).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
  });

  it("accepts a legacy, run-bound single page when no observation table existed", () => {
    const value = evidence();
    value.observations = [];
    value.raw!.contentKey = null;
    expect(plan(value)).toMatchObject({ state: "repairable",
      next: { receiptKind: "legacy_run_bound_raw" } });
  });

  it("is idempotent after the exact manifest is already bound", () => {
    const value = evidence();
    value.pointer!.activeManifestId = TARGET;
    expect(plan(value).state).toBe("already_bound");
  });
});
