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
      updatedAt: "2026-09-23T06:50:31.800Z",
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

function centPrecisionEvidence(): RepairEvidence {
  const value = evidence();
  const rows = Array.from({ length: 5 }, (_, index) => ({
    ...row, ad_id: `ad-${index + 1}`, spend: "10.00",
  }));
  value.raw!.payload = rows;
  value.ads = rows.map((payload, index) => ({
    ...value.ads[0]!, id: `ad-row-${index + 1}`,
    adId: payload.ad_id, payload, spend: 10,
  }));
  value.manifests[0]!.rowsFetchedTotal = "5";
  value.manifests[0]!.sourceSpend = 50.02;
  value.reconciliations[0]!.sourceSpend = 50.02;
  return value;
}

function reboundLegacyEvidence(): RepairEvidence {
  const value = evidence();
  const original = value.pointer!;
  value.observations = [];
  value.raw!.contentKey = null;
  value.raw!.status = "superseded";
  value.raw!.updatedAt = "2026-09-23T08:00:00.000Z";
  value.oldSlice = {
    id: original.activeSliceId, businessId: BUSINESS, accountId: ACCOUNT,
    day: DAY, surface: "ad_daily", manifestId: OLD, sourceRunId: RUN,
    publishedAt: "2026-09-23T06:50:32.995Z",
    supersededAt: "2026-09-24T13:00:00.000Z",
    status: "superseded", truthState: "finalized", validationStatus: "passed",
  };
  original.activeSliceId = "slice-new";
  original.activeManifestId = TARGET;
  original.publicationReason = "manifest_rebind_repair";
  original.publishedAt = "2026-09-24T13:00:00.000Z";
  original.updatedAt = original.publishedAt;
  original.activeValidationSummary = {
    repairContract: "meta-historical-source-slice-repair.v2",
    reviewedPlanHash: "a".repeat(64), receiptKind: "legacy_run_bound_raw",
    sourceSnapshotId: RAW, targetManifestId: TARGET,
    sourcePartitionId: PARTITION, rawUpdatedAt: value.raw!.updatedAt,
    oldPointerId: original.id, oldSliceId: value.oldSlice.id,
    oldManifestId: OLD, oldPublishedAt: "2026-09-23T06:50:33.000Z",
    oldRunId: RUN,
  };
  return value;
}

function reboundObservationEvidence(): RepairEvidence {
  const value = evidence();
  const original = value.pointer!;
  // A canonical payload may have been captured under another partition. The
  // run observation, rather than that payload row, binds it to this manifest.
  value.raw!.partitionId = null;
  value.oldSlice = {
    id: original.activeSliceId, businessId: BUSINESS, accountId: ACCOUNT,
    day: DAY, surface: "ad_daily", manifestId: OLD, sourceRunId: RUN,
    publishedAt: "2026-09-23T06:50:32.995Z",
    supersededAt: "2026-09-24T13:00:00.000Z",
    status: "superseded", truthState: "finalized", validationStatus: "passed",
  };
  original.activeSliceId = "slice-new";
  original.activeManifestId = TARGET;
  original.publicationReason = "manifest_rebind_repair";
  original.publishedAt = "2026-09-24T13:00:00.000Z";
  original.updatedAt = original.publishedAt;
  original.activeValidationSummary = {
    repairContract: "meta-historical-source-slice-repair.v2",
    reviewedPlanHash: "a".repeat(64), receiptKind: "run_observation",
    sourceSnapshotId: RAW, targetManifestId: TARGET,
    sourcePartitionId: PARTITION, rawUpdatedAt: value.raw!.updatedAt,
    oldPointerId: original.id, oldSliceId: value.oldSlice.id,
    oldManifestId: OLD, oldPublishedAt: "2026-09-23T06:50:33.000Z",
    oldRunId: RUN,
  };
  return value;
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

  it("never treats a manifest updated after the old pointer as prior evidence", () => {
    const value = evidence();
    value.manifests[0]!.updatedAt = "2026-09-23T06:50:34.000Z";
    expect(plan(value).blockers).toContain("manifest_clock_invalid");
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

  it("accepts only raw pages superseded after the old pointer", () => {
    const laterReset = evidence();
    laterReset.raw!.status = "superseded";
    laterReset.raw!.updatedAt = "2026-09-23T08:00:00.000Z";
    expect(plan(laterReset).state).toBe("repairable");
    const earlierReset = evidence();
    earlierReset.raw!.status = "superseded";
    earlierReset.raw!.updatedAt = "2026-09-23T06:50:32.000Z";
    expect(plan(earlierReset).blockers).toContain("raw_page_scope_or_request_invalid");
  });

  it("rejects rows written after the pointer and source spend disagreement", () => {
    const laterRow = evidence();
    laterRow.ads[0]!.updatedAt = "2026-09-23T06:50:34.000Z";
    expect(plan(laterRow).blockers).toContain("stored_ad_lineage_invalid");
    const drift = evidence();
    drift.manifests[0]!.sourceSpend = 49;
    expect(plan(drift).blockers).toContain("source_spend_mismatch");
  });

  it("admits only a cent-bounded variance with exact raw Ad spend and a passing manifest receipt", () => {
    const result = plan(centPrecisionEvidence());
    expect(result).toMatchObject({
      state: "repairable", blockers: [],
      contract: "meta-historical-source-slice-repair.v3",
      next: { spendVarianceProof: {
        sourceCents: 5002, adCents: 5000, absoluteDeltaCents: 2,
        rowCount: 5, maxQuantizationDoubleCents: 6,
      } },
    });
    const oneCent = centPrecisionEvidence();
    oneCent.manifests[0]!.sourceSpend = 50.01;
    oneCent.reconciliations[0]!.sourceSpend = 50.01;
    const oneCentResult = plan(oneCent);
    expect(oneCentResult).toMatchObject({
      state: "repairable", contract: "meta-historical-source-slice-repair.v2",
    });
    expect(oneCentResult.next).not.toHaveProperty("spendVarianceProof");
  });

  it("keeps failed, missing, wide and malformed cent evidence held", () => {
    const failed = centPrecisionEvidence();
    failed.reconciliations[0]!.eventKind = "totals_mismatch";
    failed.reconciliations[0]!.result = "repair_required";
    expect(plan(failed).blockers).toEqual(expect.arrayContaining([
      "source_spend_mismatch", "exact_manifest_validation_receipt_missing_or_failed",
    ]));
    const laterFailure = centPrecisionEvidence();
    laterFailure.reconciliations.push({
      ...laterFailure.reconciliations[0]!, id: "later-failure",
      eventKind: "totals_mismatch", result: "repair_required",
      createdAt: "2026-09-23T06:50:32.950Z",
    });
    expect(plan(laterFailure).blockers).toEqual(expect.arrayContaining([
      "source_spend_mismatch", "exact_manifest_validation_receipt_missing_or_failed",
    ]));
    const wide = centPrecisionEvidence();
    wide.manifests[0]!.sourceSpend = 50.04;
    wide.reconciliations[0]!.sourceSpend = 50.04;
    expect(plan(wide).blockers).toContain("source_spend_mismatch");
    const malformed = centPrecisionEvidence();
    (malformed.raw!.payload as Array<typeof row>)[0] = {
      ...(malformed.raw!.payload as Array<typeof row>)[0]!, spend: "10.001",
    };
    malformed.ads[0]!.payload = (malformed.raw!.payload as Array<typeof row>)[0]!;
    malformed.ads[0]!.spend = 10.001;
    expect(plan(malformed).blockers).toContain("source_spend_mismatch");
    const storedDrift = centPrecisionEvidence();
    storedDrift.ads[0]!.spend = 9.99;
    expect(plan(storedDrift).blockers).toContain("source_spend_mismatch");
    const missingAd = centPrecisionEvidence();
    (missingAd.raw!.payload as Array<typeof row>).push({
      ...row, ad_id: "unmatched", spend: "0.00",
    });
    expect(plan(missingAd).blockers).toEqual(expect.arrayContaining([
      "ad_population_or_page_count_mismatch", "source_spend_mismatch",
    ]));
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
    const premature = evidence();
    premature.reconciliations[0]!.createdAt = "2026-09-23T06:50:32.000Z";
    expect(plan(premature).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
    const laterFailure = evidence();
    laterFailure.reconciliations.push({ ...laterFailure.reconciliations[0]!,
      id: "later-failure", eventKind: "totals_mismatch", result: "repair_required",
      createdAt: "2026-09-23T07:00:00.000Z" });
    expect(plan(laterFailure).blockers).toContain("exact_manifest_validation_receipt_missing_or_failed");
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

  it("accepts a legacy page superseded after the witnessed old publication", () => {
    const result = plan(reboundLegacyEvidence());
    expect(result).toMatchObject({ state: "already_bound", blockers: [],
      next: { manifestId: TARGET, receiptKind: "legacy_run_bound_raw",
        rawUpdatedAt: "2026-09-23T08:00:00.000Z" } });
  });

  it("binds a shared raw page through its run observation after publication", () => {
    const value = reboundObservationEvidence();
    expect(plan(value)).toMatchObject({ state: "already_bound", blockers: [],
      next: { manifestId: TARGET, partitionId: PARTITION,
        receiptKind: "run_observation" } });
    (value.pointer!.activeValidationSummary as Record<string, unknown>)
      .sourcePartitionId = "another-partition";
    expect(plan(value).blockers).toContain("rebind_target_partition_receipt_mismatch");
  });

  it("still requires direct raw partition identity for legacy-only receipts", () => {
    const value = reboundLegacyEvidence();
    value.raw!.partitionId = null;
    expect(plan(value).blockers).toContain("rebind_prior_publication_receipt_invalid");
  });

  it("requires the same cent-precision proof on v3 rebind readback", () => {
    const value = reboundLegacyEvidence();
    const precision = centPrecisionEvidence();
    value.ads = precision.ads;
    value.raw!.payload = precision.raw!.payload;
    value.manifests[0]!.rowsFetchedTotal = "5";
    value.manifests[0]!.sourceSpend = 50.02;
    value.reconciliations[0]!.sourceSpend = 50.02;
    const summary = value.pointer!.activeValidationSummary as Record<string, unknown>;
    summary.repairContract = "meta-historical-source-slice-repair.v3";
    summary.spendVarianceProof = {
      sourceCents: 5002, adCents: 5000, absoluteDeltaCents: 2,
      rowCount: 5, maxQuantizationDoubleCents: 6,
    };
    expect(plan(value)).toMatchObject({
      state: "already_bound", blockers: [],
      contract: "meta-historical-source-slice-repair.v3",
    });
    summary.spendVarianceProof = {
      ...summary.spendVarianceProof as Record<string, unknown>,
      sourceCents: 5003,
    };
    expect(plan(value).blockers).toContain("rebind_spend_variance_receipt_invalid");
  });

  it("rejects a rebinding without the exact old slice and publication clock", () => {
    const missingOldSlice = reboundLegacyEvidence();
    missingOldSlice.oldSlice = null;
    expect(plan(missingOldSlice).blockers).toContain("rebind_prior_publication_receipt_invalid");
    const wrongClock = reboundLegacyEvidence();
    (wrongClock.pointer!.activeValidationSummary as Record<string, unknown>).oldPublishedAt =
      "2026-09-23T06:50:32.000Z";
    expect(plan(wrongClock).blockers).toContain("rebind_prior_publication_receipt_invalid");
    const wrongRawClock = reboundLegacyEvidence();
    (wrongRawClock.pointer!.activeValidationSummary as Record<string, unknown>).rawUpdatedAt =
      "2026-09-23T07:00:00.000Z";
    expect(plan(wrongRawClock).blockers).toContain("rebind_prior_publication_receipt_invalid");
  });
});
