import fs from "node:fs";
import { runNativeAdCalibrationSchemaGate } from "@/lib/migrations";
import { WarehouseNativeAdAccountProfileDataSource } from "../../ad-account-decision-profile-store";
import { resolveNativeAdAccountDecisionProfile } from "../../ad-account-decision-profile";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/lib/db";
import {
  AD_CALIBRATION_JOB_NAME,
  ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL,
  COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL,
  CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL,
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL,
  ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL,
  NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
  nativeAdCalibrationContractVersionCheck,
  NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  INSERT_NATIVE_AD_CALIBRATION_SQL,
  LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
  NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  NATIVE_AD_CALIBRATION_MIGRATION_SQL,
  NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA,
  NATIVE_AD_CALIBRATION_TABLE,
  NativeAdHistoricalCalibrationUnsafeError,
  READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL,
  READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL,
  READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL,
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  adCalibrationJobAdvisoryLockKey,
  buildNativeAdCalibrationPersistencePayload,
  computeNativeAdCalibrationBatch,
  inspectNativeAdCalibrationSchemaCapability,
  isNativeAdTargetAuthorityCutoffSafe,
  mapNativeAdCalibrationSourceRow,
  replaceNativeAdCalibrationBatch,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdCalibrationCutoff,
  resolveNativeAdCalibrationDate,
  resolveNativeAdTargetAuthority,
  runAdCalibrationJob,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
  type NativeAdTargetAuthorityStatus,
} from "../../jobs/ad-calibration-job";
import { NATIVE_AD_ENGINE_VERSION } from "../../types";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000701";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000702";
const PROVIDER_ACCOUNT_ID = "act-native-1";
const SECOND_PROVIDER_ACCOUNT_REF_ID =
  "00000000-0000-4000-8000-000000000712";
const SECOND_PROVIDER_ACCOUNT_ID = "act-native-2";
const JOB_RUN_ID = "00000000-0000-4000-8000-000000000703";
const BATCH_ID = "00000000-0000-4000-8000-000000000704";
const SECOND_BATCH_ID = "00000000-0000-4000-8000-000000000714";
const AS_OF = "2026-07-12";
const CUTOFF = "2026-07-12T03:05:00.000Z";
const LATER_CUTOFF = "2026-07-12T03:15:00.000Z";

const FRESH_TARGET: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-000000000799",
  operation: "upsert",
  targetCpa: 50,
  targetRoas: 2,
  breakEvenCpa: 70,
  breakEvenRoas: 1.5,
  operatorAovAssumption: 100,
  defaultRiskPosture: "balanced",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  recordedAt: "2026-07-01T00:00:01.000Z",
};
const OLD_TARGET: NativeAdTargetAuthorityInput = {
  ...FRESH_TARGET,
  effectiveAt: "2026-03-01T00:00:00.000Z",
  recordedAt: "2026-03-01T00:00:01.000Z",
};
const AOV_ONLY_TARGET: NativeAdTargetAuthorityInput = {
  ...FRESH_TARGET,
  targetCpa: null,
  operatorAovAssumption: null,
};

function makeRow(
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
): NativeAdCalibrationSourceRow {
  const adId = overrides.adId ?? "ad-1";
  const date = overrides.date ?? "2026-07-11";
  return {
    sourceRowId: overrides.sourceRowId ?? `${adId}-${date}`,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date,
    campaignId: "campaign-1",
    adsetId: "adset-1",
    adId,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    sourceAccountTimezone: "Europe/Istanbul",
    sourceAccountCurrency: "USD",
    metricSchemaVersion: 2,
    objective: "OUTCOME_SALES",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    spend: 100,
    impressions: 10_000,
    clicks: 300,
    linkClicks: 250,
    conversions: 2,
    revenue: 240,
    landingPageViews: 200,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: "2026-07-12T01:00:00.000Z",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    campaignSourceRowId: `campaign-source-${date}`,
    campaignTruthState: "finalized",
    campaignValidationStatus: "passed",
    campaignCreatedAt: "2026-07-12T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
    adsetSourceRowId: `adset-source-${date}`,
    adsetTruthState: "finalized",
    adsetValidationStatus: "passed",
    adsetCreatedAt: "2026-07-12T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
    ...overrides,
  };
}

function toDbSourceRow(row: NativeAdCalibrationSourceRow) {
  return {
    source_row_id: row.sourceRowId,
    business_id: row.businessId,
    provider_account_ref_id: row.providerAccountRefId,
    provider_account_id: row.providerAccountId,
    date: row.date,
    campaign_id: row.campaignId,
    adset_id: row.adsetId,
    ad_id: row.adId,
    account_timezone: row.accountTimezone,
    account_currency: row.accountCurrency,
    source_account_timezone: row.sourceAccountTimezone,
    source_account_currency: row.sourceAccountCurrency,
    metric_schema_version: row.metricSchemaVersion,
    objective: row.objective,
    optimization_goal: row.optimizationGoal,
    custom_event_type: row.customEventType,
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    link_clicks: row.linkClicks,
    conversions: row.conversions,
    revenue: row.revenue,
    landing_page_views: row.landingPageViews,
    add_to_cart: row.addToCart,
    initiate_checkout: row.initiateCheckout,
    thumbstop: row.thumbstop,
    truth_state: row.truthState,
    validation_status: row.validationStatus,
    finalized_at: row.finalizedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    campaign_source_row_id: row.campaignSourceRowId,
    campaign_truth_state: row.campaignTruthState,
    campaign_validation_status: row.campaignValidationStatus,
    campaign_created_at: row.campaignCreatedAt,
    campaign_updated_at: row.campaignUpdatedAt,
    adset_source_row_id: row.adsetSourceRowId,
    adset_truth_state: row.adsetTruthState,
    adset_validation_status: row.adsetValidationStatus,
    adset_created_at: row.adsetCreatedAt,
    adset_updated_at: row.adsetUpdatedAt,
  };
}

function compute(
  sourceRows: NativeAdCalibrationSourceRow[],
  options: {
    cutoff?: string;
    target?: NativeAdTargetAuthorityInput | null;
  } = {},
) {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    asOf: AS_OF,
    computationCutoff: options.cutoff ?? CUTOFF,
    sourceRows,
    targetAuthority:
      options.target === undefined ? FRESH_TARGET : options.target,
  });
}

function proofRows(batch: NativeAdCalibrationBatch) {
  return batch.cells.map((cell) => ({
    business_id: cell.key.businessId,
    provider_account_ref_id: cell.key.providerAccountRefId,
    provider_account_id: cell.key.providerAccountId,
    account_timezone: cell.key.accountTimezone,
    account_currency: cell.key.accountCurrency,
    cell_scope: cell.key.cellScope,
    objective: cell.key.objective,
    funnel_cohort: cell.key.cohort,
    optimization_context: cell.key.optimizationContext,
    input_manifest_hash: cell.inputManifestHash,
    source_manifest_hash: cell.sourceManifestHash,
  }));
}

function fakeDb(
  handler: (query: string, params?: unknown[]) => Record<string, unknown>[],
): DbClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) =>
    handler(sql, params),
  );
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

function enabledFlags() {
  return {
    businessId: BUSINESS_ID,
    enabled: true,
    surfaceVisible: false,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env" as const,
      surfaceVisible: "env" as const,
      shadowOnly: "env" as const,
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
  };
}

function exactSchemaRows(query: string): Record<string, unknown>[] {
  if (query.includes("JOIN pg_attribute")) {
    return Object.entries(
      NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.columns,
    ).flatMap(([tableName, columns]) =>
      Object.entries(columns).map(([columnName, contract]) => ({
        table_name: tableName,
        column_name: columnName,
        data_type: contract.type,
        not_null: contract.notNull,
        column_default: contract.default,
      })),
    );
  }
  if (query.includes("FROM pg_constraint")) {
    return Object.entries(
      NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.constraints,
    ).map(([name, definition]) => ({ name, definition }));
  }
  if (query.includes("FROM pg_index")) {
    return Object.entries(NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.indexes).map(
      ([name, definition]) => ({ name, definition }),
    );
  }
  if (query.includes("FROM pg_trigger")) {
    return Object.entries(NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.triggers).map(
      ([name, definition]) => ({ name, definition }),
    );
  }
  return [];
}

describe("native ad calibration computation", () => {
  it("aggregates at ad grain and never lets creative overlays own identity", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "ad-1-day-1",
        adId: "ad-1",
        date: "2026-07-10",
        creativeId: "creative-shared",
      }),
      makeRow({
        sourceRowId: "ad-1-day-2",
        adId: "ad-1",
        creativeId: "creative-shared",
      }),
      makeRow({
        sourceRowId: "ad-2-day-1",
        adId: "ad-2",
        creativeId: "creative-shared",
      }),
    ]);

    expect(batch.observations.map((row) => row.adId)).toEqual(["ad-1", "ad-2"]);
    expect(batch.observations[0]?.sourceDayCount).toBe(2);
    const payload = buildNativeAdCalibrationPersistencePayload(batch, {
      batchId: BATCH_ID,
      jobRunId: JOB_RUN_ID,
    });
    expect(payload[0]).toMatchObject({
      business_id: BUSINESS_ID,
      provider: "meta",
      provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
      provider_account_id: PROVIDER_ACCOUNT_ID,
    });
    expect(payload[0]).not.toHaveProperty("creative_id");
    expect(payload[0]).not.toHaveProperty("ad_id");
  });

  it("keeps legacy finalized peer facts without finalized_at while excluding them from strict account-AOV authority", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      makeRow({
        sourceRowId: `legacy-finalized-${index}`,
        adId: `legacy-finalized-${index}`,
        conversions: 1,
        revenue: 100,
        finalizedAt: index === 0 ? null : "2026-07-12T01:00:00.000Z",
      }),
    );
    const batch = compute(rows, { target: AOV_ONLY_TARGET });
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );

    expect(batch.observations).toHaveLength(20);
    expect(batch.qualityCounts).toMatchObject({
      cutoffSafeSourceRowCount: 20,
      eligibleAdObservationCount: 20,
      peerTruthFinalizedAtMissingSourceRowCount: 1,
      peerTruthFinalizedAtMissingAdCount: 1,
      censoredSourceRowExclusionCount: 0,
      censoredAdExclusionCount: 0,
    });
    expect(exact?.accountCalibration).toMatchObject({
      metaAttributedAovPurchaseCount90d: 20,
    });
    expect(batch.spendUnitAuthority).toMatchObject({
      status: "blocked",
      basis: null,
      accountAovEvidence: {
        status: "insufficient_sample",
        observedPurchaseCount: 19,
        requiredPurchaseCount: 20,
      },
    });
  });

  it("keeps an all-legacy null-finalized peer cohort without borrowing strict account authority", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      makeRow({
        sourceRowId: `legacy-only-${index}`,
        adId: `legacy-only-${index}`,
        conversions: 1,
        revenue: 100,
        finalizedAt: null,
      }),
    );

    const batch = compute(rows, { target: AOV_ONLY_TARGET });

    expect(batch.observations).toHaveLength(20);
    expect(batch.cells.length).toBeGreaterThan(0);
    expect(batch.qualityCounts).toMatchObject({
      cutoffSafeSourceRowCount: 20,
      eligibleAdObservationCount: 20,
      peerTruthFinalizedAtMissingSourceRowCount: 20,
      peerTruthFinalizedAtMissingAdCount: 20,
      censoredSourceRowExclusionCount: 0,
      censoredAdExclusionCount: 0,
    });
    expect(batch.sourceProvenance).toMatchObject({
      currencyAdmission: {
        status: "unavailable",
        admittedRowCount: 0,
      },
      timezoneAdmission: {
        status: "unavailable",
        admittedRowCount: 0,
      },
    });
    expect(batch.spendUnitAuthority).toMatchObject({
      status: "blocked",
      basis: null,
      accountAovEvidence: {
        status: "unavailable",
        observedPurchaseCount: 0,
        canonicalRowCount: 0,
      },
    });
  });

  it("still censors cutoff-unsafe all-legacy peer facts", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "legacy-future-update",
        adId: "legacy-future-update",
        finalizedAt: null,
        updatedAt: "2026-07-12T04:00:00.000Z",
      }),
    ]);

    expect(batch.observations).toHaveLength(0);
    expect(batch.cells).toHaveLength(0);
    expect(batch.qualityCounts).toMatchObject({
      freshnessSourceRowExclusionCount: 1,
      freshnessAdExclusionCount: 1,
      eligibleAdObservationCount: 0,
    });
  });

  it("fails an all-legacy peer Ad closed when its immutable dimensions are mixed", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "legacy-mixed-usd",
        adId: "legacy-mixed",
        date: "2026-07-10",
        finalizedAt: null,
      }),
      makeRow({
        sourceRowId: "legacy-mixed-eur",
        adId: "legacy-mixed",
        date: "2026-07-11",
        accountCurrency: "EUR",
        sourceAccountCurrency: "EUR",
        finalizedAt: null,
      }),
    ]);

    expect(batch.observations).toHaveLength(0);
    expect(batch.cells).toHaveLength(0);
    expect(batch.qualityCounts).toMatchObject({
      mixedContextAdExclusionCount: 1,
      mixedCurrencyAdExclusionCount: 1,
      eligibleAdObservationCount: 0,
    });
    expect(batch.spendUnitAuthority.status).toBe("blocked");
  });

  it("retains every metric day for a legacy finalized peer fact instead of undercounting the ad", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "legacy-day-1",
        adId: "legacy-ad",
        date: "2026-07-10",
        spend: 125,
        conversions: 1,
        revenue: 175,
      }),
      makeRow({
        sourceRowId: "legacy-day-2",
        adId: "legacy-ad",
        date: "2026-07-11",
        spend: 275,
        conversions: 2,
        revenue: 425,
        finalizedAt: null,
      }),
    ]);

    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0]).toMatchObject({
      adId: "legacy-ad",
      sourceDayCount: 2,
      totalSpend: 400,
      totalConversions: 3,
      totalRevenue: 600,
    });
    expect(batch.observations[0]?.sourceRowIds).toEqual([
      "legacy-day-1",
      "legacy-day-2",
    ]);
    expect(batch.qualityCounts).toMatchObject({
      cutoffSafeSourceRowCount: 2,
      eligibleAdObservationCount: 1,
      peerTruthFinalizedAtMissingSourceRowCount: 1,
      peerTruthFinalizedAtMissingAdCount: 1,
      censoredSourceRowExclusionCount: 0,
      censoredAdExclusionCount: 0,
    });
  });

  it("still censors the whole ad when a legacy finalized metric day lacks exact same-day hierarchy truth", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "complete-day",
        adId: "hierarchy-gap-ad",
        date: "2026-07-10",
      }),
      makeRow({
        sourceRowId: "hierarchy-gap-day",
        adId: "hierarchy-gap-ad",
        date: "2026-07-11",
        finalizedAt: null,
        campaignSourceRowId: null,
        campaignTruthState: null,
        campaignValidationStatus: null,
        campaignCreatedAt: null,
        campaignUpdatedAt: null,
        adsetSourceRowId: null,
        adsetTruthState: null,
        adsetValidationStatus: null,
        adsetCreatedAt: null,
        adsetUpdatedAt: null,
      }),
    ]);

    expect(batch.observations).toHaveLength(0);
    expect(batch.cells).toHaveLength(0);
    expect(batch.qualityCounts).toMatchObject({
      cutoffSafeSourceRowCount: 0,
      eligibleAdObservationCount: 0,
      peerTruthFinalizedAtMissingSourceRowCount: 0,
      peerTruthFinalizedAtMissingAdCount: 0,
      censoredSourceRowExclusionCount: 1,
      censoredAdExclusionCount: 1,
    });
  });

  it("keeps a non-null finalized_at after the cutoff out of peer calibration", () => {
    const batch = compute([
      makeRow({
        sourceRowId: "cutoff-safe-anchor",
        adId: "cutoff-safe-anchor",
      }),
      makeRow({
        sourceRowId: "future-finalization",
        adId: "future-finalization",
        finalizedAt: "2026-07-12T04:00:00.000Z",
      }),
    ]);

    expect(batch.observations.map((row) => row.adId)).toEqual([
      "cutoff-safe-anchor",
    ]);
    expect(batch.cells.length).toBeGreaterThan(0);
    expect(batch.qualityCounts).toMatchObject({
      cutoffSafeSourceRowCount: 1,
      freshnessSourceRowExclusionCount: 1,
      freshnessAdExclusionCount: 1,
    });
  });

  it("keeps absent optional events unknown and outside every event floor", () => {
    const batch = compute(
      Array.from({ length: 30 }, (_, index) =>
        makeRow({
          sourceRowId: `missing-events-${index}`,
          adId: `missing-events-${index}`,
          landingPageViews: null,
          addToCart: null,
          initiateCheckout: null,
          thumbstop: null,
        }),
      ),
    );
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    expect(exact?.metricSampleCounts).toMatchObject({
      thumbstop: 0,
      linkToLpv: 0,
      linkToAtc: 0,
      lpvToAtc: 0,
      atcToIc: 0,
      icToPurchase: 0,
    });
    expect(exact?.funnelCalibration.byFormat.overall).toMatchObject({
      thumbstopP25: null,
      linkToLpvP25: null,
      linkToAtcP25: null,
    });
  });

  it("hashes only rows surviving cutoff/exclusion and keeps content identity stable across reruns", () => {
    const eligible = makeRow({ sourceRowId: "eligible" });
    const excludedA = makeRow({
      sourceRowId: "future",
      adId: "future",
      createdAt: "2026-07-12T04:00:00.000Z",
      updatedAt: "2026-07-12T04:00:00.000Z",
    });
    const excludedB = { ...excludedA, spend: 999_999 };
    const first = compute([eligible, excludedA]);
    const changedExcluded = compute([eligible, excludedB]);
    const later = compute([eligible, excludedA], { cutoff: LATER_CUTOFF });

    expect(first.sourceManifestHash).toBe(changedExcluded.sourceManifestHash);
    expect(first.generationContentHash).toBe(later.generationContentHash);
    expect(first.inputManifestHash).not.toBe(later.inputManifestHash);
    expect(first.qualityCounts.freshnessAdExclusionCount).toBe(1);
  });

  it("grants authority per action and makes pooled optimization fallback soft-only", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `sample-${index}`,
        adId: `sample-${index}`,
        revenue: 180 + index * 5,
      }),
    );
    const batch = compute(rows);
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    const pooled = batch.cells.find(
      (cell) =>
        cell.key.optimizationContext ===
        NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
    );
    expect(exact?.actionReadiness.scale).toMatchObject({
      ready: true,
      authorityBasis: "calibrated_relative",
    });
    expect(exact?.actionReadiness.cut).toMatchObject({
      ready: true,
      authorityBasis: "calibrated_relative_with_economic_stop_loss",
      requiredSampleCount: 20,
    });
    expect(pooled?.actionReadiness).toMatchObject({
      scale: { ready: false, reason: "pooled_optimization_context_soft_only" },
      cut: { ready: false, reason: "pooled_optimization_context_soft_only" },
      refresh: {
        ready: false,
        reason: "pooled_optimization_context_soft_only",
      },
    });
  });

  it("keeps a P25-ready PURCHASE cell Cut-ready when an unrelated VALUE context blocks account AOV", () => {
    const purchaseRows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `purchase-ready-${index}`,
        adId: `purchase-ready-${index}`,
        optimizationGoal: "PURCHASE",
        customEventType: "PURCHASE",
      }),
    );
    const contradictoryValueContext = makeRow({
      sourceRowId: "value-context-contradiction",
      adId: "value-context-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 0,
      revenue: 100,
    });
    const batch = compute(
      [...purchaseRows, contradictoryValueContext],
      { target: AOV_ONLY_TARGET },
    );
    const purchaseExact = batch.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext ===
          "goal=PURCHASE|event=PURCHASE",
    );

    expect(batch.spendUnitAuthority).toMatchObject({
      status: "blocked",
      basis: null,
      accountAovEvidence: {
        status: "contradictory_purchase_truth",
      },
    });
    expect(batch.qualityCounts.censoredAdExclusionCount).toBe(1);
    expect(
      batch.cells.some(
        (cell) =>
          cell.key.optimizationContext === "goal=VALUE|event=VALUE",
      ),
    ).toBe(false);
    expect(purchaseExact?.accountCalibration.roasRatioP25).toBeGreaterThan(0);
    /*
      ── ROUND 8 ITEM 4: THE HOLD IS TOTAL ───────────────────────────────────

      Round 6 left this cell READY with basis `calibrated_relative`: the
      account AOV was blocked, so no economic unit existed, but the
      sample-backed positive P25 was treated as authority on its own and a
      downstream gate was trusted to refuse the action.

      That was the wrong place to stop. `actionReadiness.cut.ready` is
      persisted on the calibration row, read back by the retained profile, and
      part of the cell's identity — so the row asserted an authority the
      account does not have, and asserted it in the hash. And a "ready" cell
      with no economic unit still selects a BOUNDARY: the account-relative P25.
      A percentile of peers is not READY Meta AOV over the Target ROAS, and
      under a positive Target ROAS that is the only admissible spend
      arithmetic.

      So readiness itself now holds, and the reason names the thing that is
      actually missing. The P25 is still measured, still positive, still on the
      cell — it simply is not authority here.
    */
    expect(purchaseExact?.actionReadiness.cut).toEqual({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
      observedSampleCount: 30,
      requiredSampleCount: 20,
    });
    expect(
      purchaseExact?.accountCalibration.accountCpaP50,
      "the account CPA is still OBSERVED on the cell; it simply grants nothing",
    ).toBeGreaterThan(0);
    expect(purchaseExact?.actionReadiness.spendUnitAuthority.status).not.toBe(
      "ready",
    );
    // And the target authority IS the reason: a positive Target ROAS is what
    // makes the missing spend unit fatal rather than merely narrowing.
    expect(purchaseExact?.targetAuthority.targetRoasAuthority).toBe(true);
  });

  /*
    ── ROUND 6 AUDIT ITEM 2: THE PAIRED TARGET-ROAS / NO-TARGET COMPATIBILITY ─
    The SAME rows, the SAME blocked account AOV, and one field different: does
    the target authority carry a positive Target ROAS. That is the whole
    difference between "the account's own CPA is observed evidence" and "the
    account's own CPA is the money-per-purchase anchor", and it is the only
    thing allowed to move the readiness basis.
  */
  it("shows the account-CPA arm was only ever reachable where it is now forbidden", () => {
    /*
      ── ROUND 6 AUDIT ITEM 2: THE OTHER HALF OF THE PAIR ────────────────────
      The governed half is the case above ("keeps a P25-ready PURCHASE cell
      Cut-ready when an unrelated VALUE context blocks account AOV"): same
      rows, same blocked account AOV, a positive Target ROAS, and the basis is
      `calibrated_relative` because the account's own CPA is observed evidence
      there rather than a money-per-purchase anchor.

      This is the SAME fixture with one field different — no Target ROAS — and
      it records something stronger than "the legacy branch still works":
      `roasRatios` is EMPTY without a positive Target ROAS (see the note on
      `hasCommercialTargetAuthority` in ad-calibration-job.ts), so
      `cutUsesCalibratedRelativeBoundary` cannot be true, and
      `calibrated_relative_with_economic_stop_loss` is unreachable. The
      account-CPA arm therefore only ever contributed in the governed case —
      exactly the case the contract forbids it in — so gating it removes no
      legitimate reachable behaviour.

      The refusal that remains is named on the BOUNDARY, not on the account CPA
      having been rejected, which is the distinction this pair holds.
    */
    const purchaseRows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `legacy-purchase-ready-${index}`,
        adId: `legacy-purchase-ready-${index}`,
        optimizationGoal: "PURCHASE",
        customEventType: "PURCHASE",
      }),
    );
    const contradictoryValueContext = makeRow({
      sourceRowId: "legacy-value-context-contradiction",
      adId: "legacy-value-context-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 0,
      revenue: 100,
    });
    const batch = compute([...purchaseRows, contradictoryValueContext], {
      target: { ...AOV_ONLY_TARGET, targetRoas: null },
    });
    const purchaseExact = batch.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext === "goal=PURCHASE|event=PURCHASE",
    );
    expect(purchaseExact?.targetAuthority.targetRoasAuthority).toBe(false);
    // A real, sample-backed account CPA is present — so a reachable branch
    // WOULD have fired here if one existed.
    expect(purchaseExact?.accountCalibration.accountCpaP50).toBeGreaterThan(0);
    // And the relative boundary the strip sits on top of does not exist.
    expect(purchaseExact?.accountCalibration.roasRatioP25).toBeNull();
    expect(purchaseExact?.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
    });
  });

  /*
    ── ROUND 8 ITEM 4: ONE CELL, TWO TARGET REGIMES ────────────────────────────

    The pair that decides item 4. Identical rows, identical P25, identical
    BLOCKED spend-unit authority, no account CPA at all — and one field
    different: whether a positive Target ROAS governs.

    Governed: readiness HOLDS. A relative percentile is not READY Meta AOV over
    the Target ROAS, and under a positive Target ROAS that is the only
    admissible spend arithmetic; "ready but a later gate refuses" put an
    authority the account does not have onto a persisted row and into its hash.

    Not governed: `calibrated_relative` survives byte-for-byte. That is the
    legacy compatibility path the item requires be preserved, and it is the
    only place this basis is now reachable.

    Both halves are driven through the real
    `resolveNativeAdCalibrationActionReadiness`, so neither is a restatement of
    the gate expression.
  */
  function relativeOnlyReadinessInputs() {
    const rows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `relative-only-${index}`,
        adId: `relative-only-${index}`,
      }),
    );
    const batch = compute(rows, { target: AOV_ONLY_TARGET });
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    if (!exact) throw new Error("Expected exact calibration cell.");
    // A real, sample-backed relative boundary — the thing under test.
    expect(exact.accountCalibration.roasRatioP25).toBeGreaterThan(0);
    return {
      key: exact.key,
      matureAdCount: exact.matureAdCount,
      metricSampleCounts: exact.metricSampleCounts,
      targetAuthority: exact.targetAuthority,
      accountCalibration: {
        ...exact.accountCalibration,
        accountCpaP50: null,
        accountCpaSampleCount: 0,
      },
      spendUnitAuthority: {
        ...exact.actionReadiness.spendUnitAuthority,
        status: "blocked" as const,
        basis: null,
        baseSpendUnit: null,
      },
    };
  }

  /*
    ── ROUND 9 ITEM 4: THE BATCH GENERATION CONTENT, NOT A HELPER ─────────────

    `nativeAdCalibrationBatchGenerationContent` digested the RAW
    `ResolvedNativeAdTargetAuthority`, so `targetCpa`, `breakEvenCpa`,
    `operatorAovAssumption`, `sourceRowId`, `effectiveAt` and `recordedAt` keyed
    `generationContentHash` -> `inputManifestHash` -> every cell's
    `batchInputManifestHash` -> every cell's `inputManifestHash` -> `cellSetHash`.
    Round 8 projected the CELL manifest and left this one raw, so the leak was
    fully open through the batch.

    Driven through the real `computeNativeAdCalibrationBatch` — a projection
    helper asserted in isolation cannot see which builders actually call it,
    which is exactly how the batch half stayed unprojected for a round.
  */
  describe("the batch hash family under a governing Target ROAS", () => {
    const rows = () =>
      Array.from({ length: 30 }, (_, index) =>
        makeRow({
          sourceRowId: `hash-permutation-${index}`,
          adId: `hash-permutation-${index}`,
        }),
      );

    /** Everything the canonical rule says cannot change a verdict here. */
    const INERT: Array<[string, Partial<NativeAdTargetAuthorityInput>]> = [
      ["a typed Target CPA", { targetCpa: 31 }],
      ["a cleared Target CPA", { targetCpa: null }],
      ["a typed break-even CPA", { breakEvenCpa: 44 }],
      ["an operator AOV assumption", { operatorAovAssumption: 900 }],
      [
        "a re-saved row identity",
        { sourceRowId: "00000000-0000-4000-8000-000000000999" },
      ],
      [
        "advanced row clocks",
        {
          effectiveAt: "2026-07-02T00:00:00.000Z",
          recordedAt: "2026-07-02T00:00:01.000Z",
        },
      ],
      [
        "all of them at once",
        {
          targetCpa: 31,
          breakEvenCpa: 44,
          operatorAovAssumption: 900,
          sourceRowId: "00000000-0000-4000-8000-000000000999",
          effectiveAt: "2026-07-03T00:00:00.000Z",
          recordedAt: "2026-07-03T00:00:01.000Z",
        },
      ],
    ];

    /** The four hashes the leak travelled through, in order. */
    function hashFamily(batch: ReturnType<typeof compute>) {
      return {
        generationContentHash: batch.generationContentHash,
        inputManifestHash: batch.inputManifestHash,
        cellSetHash: batch.cellSetHash,
        cellBatchInputManifestHashes: batch.cells.map(
          (cell) => cell.batchInputManifestHash,
        ),
        cellInputManifestHashes: batch.cells.map((cell) => cell.inputManifestHash),
      };
    }

    it.each(INERT)("is unchanged by %s", (_name, over) => {
      const base = compute(rows(), { target: AOV_ONLY_TARGET });
      const changed = compute(rows(), {
        target: { ...AOV_ONLY_TARGET, ...over },
      });
      // The account IS governed, which is the precondition for the rule.
      expect(base.targetAuthority.targetRoasAuthority).toBe(true);
      expect(changed.targetAuthority.targetRoasAuthority).toBe(true);
      expect(hashFamily(changed)).toEqual(hashFamily(base));
    });

    it("still moves when the governing Target ROAS itself moves", () => {
      /*
        The control that stops every case above from passing on a builder that
        had simply stopped hashing the target authority at all.
      */
      const base = compute(rows(), { target: AOV_ONLY_TARGET });
      const movedRatio = compute(rows(), {
        target: { ...AOV_ONLY_TARGET, targetRoas: 3.1 },
      });
      expect(movedRatio.generationContentHash).not.toBe(
        base.generationContentHash,
      );
      expect(movedRatio.cellSetHash).not.toBe(base.cellSetHash);
    });

    it("still moves when the cutoff-safety verdict moves", () => {
      // What the clocks DECIDED is still hashed, even though their raw values
      // are not: a row that is no longer cutoff-safe is a different fact.
      const base = compute(rows(), { target: AOV_ONLY_TARGET });
      const unsafe = compute(rows(), {
        target: {
          ...AOV_ONLY_TARGET,
          effectiveAt: "2027-01-01T00:00:00.000Z",
          recordedAt: "2027-01-01T00:00:01.000Z",
        },
      });
      expect(unsafe.targetAuthority.targetRoasAuthority).toBe(false);
      expect(unsafe.generationContentHash).not.toBe(base.generationContentHash);
    });

    it("KEEPS CPA sensitivity when no Target ROAS governs", () => {
      /*
        THE NEGATIVE CONTROL the audit asked for. With no ratio to divide, the
        typed Target CPA is the anchor: two accounts differing only in it are
        two different calibrations, and blanking it there would make them share
        an identity.
      */
      const legacy = { ...AOV_ONLY_TARGET, targetRoas: null };
      const base = compute(rows(), { target: legacy });
      const withCpa = compute(rows(), { target: { ...legacy, targetCpa: 31 } });
      expect(base.targetAuthority.targetRoasAuthority).toBe(false);
      expect(withCpa.generationContentHash).not.toBe(base.generationContentHash);
      expect(withCpa.inputManifestHash).not.toBe(base.inputManifestHash);
      expect(withCpa.cellSetHash).not.toBe(base.cellSetHash);
    });
  });

  /*
    ── ROUND 9 ITEM 3: THE COMPLETE PERSISTED READINESS MATRIX ────────────────
    Round 8 closed CUT and left SCALE and REFRESH open on the same cell, so a
    governed account with no READY Meta AOV still persisted two purchase-budget
    grants it does not have.
  */
  it("holds SCALE, CUT and REFRESH together when the spend unit is not ready", () => {
    const purchaseRows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `total-hold-${index}`,
        adId: `total-hold-${index}`,
        optimizationGoal: "PURCHASE",
        customEventType: "PURCHASE",
      }),
    );
    const contradictoryValueContext = makeRow({
      sourceRowId: "total-hold-value-contradiction",
      adId: "total-hold-value-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 0,
      revenue: 100,
    });
    const batch = compute([...purchaseRows, contradictoryValueContext], {
      target: AOV_ONLY_TARGET,
    });
    const exact = batch.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext === "goal=PURCHASE|event=PURCHASE",
    );

    expect(exact?.targetAuthority.targetRoasAuthority).toBe(true);
    expect(exact?.actionReadiness.spendUnitAuthority.status).not.toBe("ready");
    for (const action of ["scale", "cut", "refresh"] as const) {
      expect(
        exact?.actionReadiness[action],
        `${action} must hold on the missing spend unit`,
      ).toMatchObject({
        ready: false,
        reason: "commercial_spend_unit_authority_missing",
        authorityBasis: null,
      });
    }
  });

  it("leaves the three actions on their OWN gates with no governing Target ROAS", () => {
    /*
      The legacy control. Without a positive Target ROAS the spend-unit
      authority is not the question, and Scale and Refresh must still be
      refused (or granted) by the sample gates that have always decided them —
      never by a commercial blocker that does not apply.
    */
    const rows = Array.from({ length: 30 }, (_, index) =>
      makeRow({ sourceRowId: `legacy-gate-${index}`, adId: `legacy-gate-${index}` }),
    );
    const batch = compute(rows, {
      target: { ...AOV_ONLY_TARGET, targetRoas: null },
    });
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    expect(exact?.targetAuthority.targetRoasAuthority).toBe(false);
    expect(exact?.actionReadiness.scale.reason).toBe(
      "target_roas_authority_missing",
    );
    expect(exact?.actionReadiness.refresh.reason).not.toBe(
      "commercial_spend_unit_authority_missing",
    );
  });

  it("HOLDS a P25-backed cell outright when a Target ROAS governs and no spend unit is ready", () => {
    const inputs = relativeOnlyReadinessInputs();
    expect(inputs.targetAuthority.targetRoasAuthority).toBe(true);

    const readiness = resolveNativeAdCalibrationActionReadiness(inputs);

    expect(readiness.cut).toEqual({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
      observedSampleCount: 30,
      requiredSampleCount: 20,
    });
  });

  it("keeps the P25-backed cell legacy-only READY when no Target ROAS governs", () => {
    const inputs = relativeOnlyReadinessInputs();
    const readiness = resolveNativeAdCalibrationActionReadiness({
      ...inputs,
      targetAuthority: {
        ...inputs.targetAuthority,
        targetRoas: null,
        // Break-even alone still satisfies `hasCommercialTargetAuthority`, so
        // the cell has a commercial target and simply no operating ratio.
        targetRoasAuthority: false,
      },
    });

    expect(readiness.cut).toEqual({
      ready: true,
      reason: null,
      authorityBasis: "calibrated_relative",
      observedSampleCount: 30,
      requiredSampleCount: 20,
    });
  });

  it("keeps a P25-null PURCHASE cell blocked when an account-wide contradiction invalidates the only spend proof", () => {
    const thinPurchaseRows = Array.from({ length: 5 }, (_, index) =>
      makeRow({
        sourceRowId: `thin-purchase-${index}`,
        adId: `thin-purchase-${index}`,
        optimizationGoal: "PURCHASE",
        customEventType: "PURCHASE",
      }),
    );
    const valueRows = Array.from({ length: 20 }, (_, index) =>
      makeRow({
        sourceRowId: `value-proof-${index}`,
        adId: `value-proof-${index}`,
        optimizationGoal: "VALUE",
        customEventType: "VALUE",
      }),
    );
    const contradiction = makeRow({
      sourceRowId: "value-proof-contradiction",
      adId: "value-proof-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 2,
      revenue: 0,
    });
    const batch = compute(
      [...thinPurchaseRows, ...valueRows, contradiction],
      { target: AOV_ONLY_TARGET },
    );
    const purchaseExact = batch.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext ===
          "goal=PURCHASE|event=PURCHASE",
    );

    expect(batch.spendUnitAuthority).toMatchObject({
      status: "blocked",
      accountAovEvidence: {
        status: "contradictory_purchase_truth",
      },
    });
    expect(purchaseExact?.accountCalibration.roasRatioP25).toBeNull();
    expect(purchaseExact?.actionReadiness.cut).toEqual({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
      observedSampleCount: 5,
      requiredSampleCount: 0,
    });
  });

  it("authorizes only the commercial stop-loss cut path when peer calibration is thin", () => {
    /*
      RE-PINNED: `conversions: 4` (was the fixture default of 2).

      `FRESH_TARGET` carries a Target ROAS, and with one the spend-unit
      authority is the platform AOV over that ratio — so the account needs
      `NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR` (20) attributed purchases
      before any authority exists. Ten purchases used to be enough here only
      because the pack's legacy Target CPA outranked the platform AOV and
      supplied the unit regardless of the sample; it no longer does.

      Four purchases per row over five rows clears the AOV floor while leaving
      the PEER calibration exactly as thin (still five ads), which is the
      thinness this test is actually about.
    */
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeRow({
        sourceRowId: `thin-stop-loss-${index}`,
        adId: `thin-stop-loss-${index}`,
        conversions: 4,
        revenue: 40 + index,
      }),
    );
    const exact = compute(rows).cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );

    expect(exact?.accountCalibration.roasRatioP25).toBeNull();
    expect(exact?.actionReadiness).toMatchObject({
      scale: {
        ready: false,
        authorityBasis: null,
        reason: "scale_calibration_sample_low",
      },
      cut: {
        ready: true,
        authorityBasis: "commercial_stop_loss",
        requiredSampleCount: 0,
      },
      refresh: {
        ready: false,
        authorityBasis: null,
        reason: "refresh_calibration_sample_low",
      },
    });
  });

  it("uses finalized canonical physical-account AOV for Cut while keeping exact peer calibration thin", () => {
    const exactRows = Array.from({ length: 5 }, (_, index) =>
      makeRow({
        sourceRowId: `exact-aov-${index}`,
        adId: `exact-aov-${index}`,
        conversions: 1,
        revenue: 80,
      }),
    );
    const contextIndependentRows = Array.from({ length: 15 }, (_, index) =>
      makeRow({
        sourceRowId: `account-aov-${index}`,
        adId: `account-aov-${index}`,
        campaignId: null,
        adsetId: null,
        campaignSourceRowId: null,
        campaignTruthState: null,
        campaignValidationStatus: null,
        campaignCreatedAt: null,
        campaignUpdatedAt: null,
        adsetSourceRowId: null,
        adsetTruthState: null,
        adsetValidationStatus: null,
        adsetCreatedAt: null,
        adsetUpdatedAt: null,
        conversions: 1,
        revenue: 100,
      }),
    );
    const batch = compute([...exactRows, ...contextIndependentRows], {
      target: AOV_ONLY_TARGET,
    });
    const exact = batch.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );

    expect(exact?.accountCalibration).toMatchObject({
      metaAttributedAovPurchaseCount90d: 5,
      metaAovQuality: "low_sample",
    });
    expect(batch.spendUnitAuthority).toMatchObject({
      status: "ready",
      basis: "physical_account_purchase_aov_90d",
      accountAovEvidence: {
        status: "ready",
        observedPurchaseCount: 20,
        requiredPurchaseCount: 20,
        totalRevenue: 1900,
        meanAov: 95,
      },
    });
    expect(exact?.actionReadiness.cut).toMatchObject({
      ready: true,
      authorityBasis: "commercial_stop_loss",
      requiredSampleCount: 0,
    });
    expect(exact?.actionReadiness.scale.ready).toBe(false);
    expect(exact?.actionReadiness.refresh.ready).toBe(false);
    expect(batch.qualityCounts.censoredAdExclusionCount).toBe(15);
  });

  it("keeps physical-account AOV fail-closed at 19 purchases and on contradictory or legacy evidence", () => {
    const build = (
      accountOverrides: Partial<NativeAdCalibrationSourceRow> = {},
      accountCount = 14,
    ) =>
      compute(
        [
          ...Array.from({ length: 5 }, (_, index) =>
            makeRow({
              sourceRowId: `floor-exact-${index}`,
              adId: `floor-exact-${index}`,
              conversions: 1,
              revenue: 80,
            }),
          ),
          ...Array.from({ length: accountCount }, (_, index) =>
            makeRow({
              sourceRowId: `floor-account-${index}`,
              adId: `floor-account-${index}`,
              campaignId: null,
              adsetId: null,
              conversions: 1,
              revenue: 100,
              ...accountOverrides,
            }),
          ),
        ],
        { target: AOV_ONLY_TARGET },
      );

    const nineteen = build();
    expect(nineteen.spendUnitAuthority).toMatchObject({
      status: "blocked",
      basis: null,
      accountAovEvidence: {
        status: "insufficient_sample",
        observedPurchaseCount: 19,
      },
    });
    expect(
      nineteen.cells.find(
        (cell) => cell.key.cellScope === "objective_cohort_context",
      )?.actionReadiness.cut,
    ).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
    });

    const contradictory = build({ revenue: 0 }, 15);
    expect(contradictory.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      contradictoryRowCount: 15,
    });
    expect(contradictory.spendUnitAuthority.status).toBe("blocked");

    const legacy = build({ metricSchemaVersion: 1 }, 15);
    expect(legacy.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "insufficient_sample",
      observedPurchaseCount: 5,
      legacySchemaRowCount: 15,
    });
    expect(legacy.spendUnitAuthority.status).toBe("blocked");

    const unsupported = build({ metricSchemaVersion: 3 }, 15);
    expect(unsupported.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      observedPurchaseCount: 5,
      unsupportedSchemaRowCount: 15,
    });
    expect(unsupported.spendUnitAuthority.status).toBe("blocked");

    const malformed = build({ spend: -1 }, 15);
    expect(malformed.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      observedPurchaseCount: 5,
      contradictoryRowCount: 15,
    });
    expect(malformed.spendUnitAuthority.status).toBe("blocked");
  });

  it("keeps conflicting account-AOV duplicate evidence permutation-invariant", () => {
    const exact = makeRow({
      sourceRowId: "duplicate-exact",
      adId: "duplicate-exact",
      conversions: 5,
      revenue: 400,
    });
    const duplicateA = makeRow({
      sourceRowId: "duplicate-a",
      adId: "duplicate-account",
      campaignId: null,
      adsetId: null,
      conversions: 20,
      revenue: 2_000,
    });
    const duplicateB = {
      ...duplicateA,
      sourceRowId: "duplicate-b",
      conversions: 21,
      revenue: 2_100,
    };
    const duplicateBReplay = {
      ...duplicateB,
      sourceRowId: "duplicate-c",
    };
    const first = compute([exact, duplicateA, duplicateB, duplicateBReplay], {
      target: AOV_ONLY_TARGET,
    });
    const permuted = compute(
      [duplicateBReplay, duplicateB, exact, duplicateA],
      { target: AOV_ONLY_TARGET },
    );

    expect(first.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      contradictoryRowCount: 3,
      observedPurchaseCount: 5,
      totalRevenue: 400,
    });
    expect(permuted.spendUnitAuthority).toEqual(first.spendUnitAuthority);
    expect(permuted.sourceManifestHash).toBe(first.sourceManifestHash);
    expect(permuted.generationContentHash).toBe(first.generationContentHash);

    const metricConflict = compute(
      [
        exact,
        duplicateA,
        {
          ...duplicateA,
          sourceRowId: "duplicate-spend-conflict",
          spend: duplicateA.spend + 1,
        },
      ],
      { target: AOV_ONLY_TARGET },
    );
    expect(metricConflict.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      contradictoryRowCount: 2,
      observedPurchaseCount: 5,
    });
    expect(metricConflict.spendUnitAuthority.status).toBe("blocked");
  });

  it("binds account-AOV evidence into manifests and isolates mixed currency or fractional purchase truth", () => {
    const exact = makeRow({
      sourceRowId: "manifest-exact",
      adId: "manifest-exact",
      conversions: 5,
      revenue: 400,
    });
    const accountOnly = makeRow({
      sourceRowId: "manifest-account",
      adId: "manifest-account",
      campaignId: null,
      adsetId: null,
      conversions: 15,
      revenue: 1500,
    });
    const first = compute([exact, accountOnly], { target: AOV_ONLY_TARGET });
    const changed = compute([exact, { ...accountOnly, revenue: 1800 }], {
      target: AOV_ONLY_TARGET,
    });
    expect(first.sourceManifestHash).not.toBe(changed.sourceManifestHash);
    expect(first.generationContentHash).not.toBe(changed.generationContentHash);

    const mixedCurrency = compute([
      exact,
      {
        ...accountOnly,
        sourceRowId: "mixed-currency",
        adId: "mixed-currency",
        accountCurrency: "EUR",
        sourceAccountCurrency: "EUR",
      },
    ]);
    expect(mixedCurrency).toMatchObject({
      expectedCellCount: 0,
      cells: [],
      observations: [],
      sourceProvenance: {
        currencyAdmission: {
          status: "blocked",
          reason: "mixed_source_currency",
          candidateRowCount: 2,
          admittedRowCount: 0,
          anomalyRowCount: 2,
          distinctSourceCurrencyCount: 2,
          distinctResolvedCurrencyCount: 2,
        },
      },
      spendUnitAuthority: {
        status: "blocked",
        basis: null,
        accountAovEvidence: {
          status: "contradictory_purchase_truth",
          contradictoryRowCount: 2,
        },
      },
    });
    expect(
      mixedCurrency.sourceProvenance.currencyAdmission.manifestHash,
    ).toMatch(/^[0-9a-f]{64}$/);

    const fractional = compute(
      [
        exact,
        {
          ...accountOnly,
          sourceRowId: "fractional",
          adId: "fractional",
          conversions: 15.5,
        },
      ],
      { target: AOV_ONLY_TARGET },
    );
    expect(fractional.spendUnitAuthority.accountAovEvidence).toMatchObject({
      status: "contradictory_purchase_truth",
      contradictoryRowCount: 1,
      observedPurchaseCount: 5,
    });
    expect(fractional.observations.map((row) => row.adId)).not.toContain(
      "fractional",
    );

    for (const [label, metrics] of [
      ["negative", { conversions: -1, revenue: 100 }],
      ["non-finite", { conversions: 1, revenue: Number.NaN }],
    ] as const) {
      const malformed = compute(
        [
          exact,
          accountOnly,
          {
            ...accountOnly,
            sourceRowId: `${label}-canonical`,
            adId: `${label}-canonical`,
            ...metrics,
          },
        ],
        { target: AOV_ONLY_TARGET },
      );
      expect(
        malformed.spendUnitAuthority.accountAovEvidence,
        label,
      ).toMatchObject({
        status: "contradictory_purchase_truth",
        contradictoryRowCount: 1,
        observedPurchaseCount: 20,
      });
      expect(malformed.spendUnitAuthority.status, label).toBe("blocked");
      expect(malformed.sourceManifestHash, label).not.toBe(
        first.sourceManifestHash,
      );
    }
  });

  it("hashes missing or mismatched source currency into a complete blocked account generation", () => {
    const missingImmutableSource = compute([
      makeRow({
        sourceRowId: "missing-source-currency",
        sourceAccountCurrency: null,
        accountCurrency: "USD",
      }),
    ]);
    expect(missingImmutableSource).toMatchObject({
      expectedCellCount: 0,
      cells: [],
      observations: [],
      sourceProvenance: {
        currencyAdmission: {
          status: "blocked",
          keyBasis: "bound_provider_fallback",
          accountCurrency: "USD",
          reason: "source_currency_missing",
          candidateRowCount: 1,
          admittedRowCount: 0,
          anomalyRowCount: 1,
          sourceCurrencyMissingRowCount: 1,
        },
      },
      spendUnitAuthority: {
        status: "blocked",
        basis: null,
        baseSpendUnit: null,
        accountAovEvidence: {
          status: "contradictory_purchase_truth",
          accountCurrency: "USD",
          contradictoryRowCount: 1,
        },
      },
    });

    const resolvedSourceMismatch = compute([
      makeRow({
        sourceRowId: "resolved-source-mismatch",
        sourceAccountCurrency: "USD",
        accountCurrency: "EUR",
      }),
    ]);
    expect(resolvedSourceMismatch).toMatchObject({
      expectedCellCount: 0,
      cells: [],
      observations: [],
      sourceProvenance: {
        currencyAdmission: {
          status: "blocked",
          keyBasis: "immutable_source",
          accountCurrency: "USD",
          reason: "resolved_source_currency_mismatch",
          candidateRowCount: 1,
          admittedRowCount: 0,
          anomalyRowCount: 1,
          resolvedSourceMismatchRowCount: 1,
        },
      },
      spendUnitAuthority: {
        status: "blocked",
        basis: null,
        accountAovEvidence: {
          status: "contradictory_purchase_truth",
          accountCurrency: "USD",
          contradictoryRowCount: 1,
        },
      },
    });
    expect(missingImmutableSource.sourceManifestHash).not.toBe(
      resolvedSourceMismatch.sourceManifestHash,
    );
    expect(
      missingImmutableSource.sourceProvenance.currencyAdmission.manifestHash,
    ).not.toBe(
      resolvedSourceMismatch.sourceProvenance.currencyAdmission.manifestHash,
    );
  });

  it("binds the account timezone to the complete singular latest immutable source date", () => {
    const older = makeRow({
      sourceRowId: "timezone-older",
      date: "2026-07-10",
      accountTimezone: "America/Los_Angeles",
      sourceAccountTimezone: "America/Los_Angeles",
    });
    const latest = makeRow({
      sourceRowId: "timezone-latest",
      date: "2026-07-11",
      accountTimezone: "Europe/Istanbul",
      sourceAccountTimezone: "Europe/Istanbul",
    });
    const batch = compute([older, latest]);

    expect(batch.sourceProvenance.timezoneAdmission).toMatchObject({
      contractVersion: "engine-v3-native-ad-timezone-admission.v1",
      status: "ready",
      keyBasis: "immutable_latest_source_date",
      accountTimezone: "Europe/Istanbul",
      reason: null,
      candidateRowCount: 2,
      latestSourceDate: "2026-07-11",
      latestSourceRowCount: 1,
      admittedRowCount: 2,
      anomalyRowCount: 0,
      sourceTimezoneMissingRowCount: 0,
      distinctSourceTimezoneCount: 1,
    });
    expect(batch.sourceProvenance.timezoneAdmission.manifestHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      new Set(batch.observations.map((row) => row.accountTimezone)),
    ).toEqual(new Set(["Europe/Istanbul"]));
    expect(new Set(batch.cells.map((cell) => cell.key.accountTimezone))).toEqual(
      new Set(["Europe/Istanbul"]),
    );

    const olderSourceRestated = compute([
      {
        ...older,
        accountTimezone: "UTC",
        sourceAccountTimezone: "UTC",
      },
      latest,
    ]);
    expect(
      olderSourceRestated.sourceProvenance.timezoneAdmission.accountTimezone,
    ).toBe("Europe/Istanbul");
    expect(
      olderSourceRestated.sourceProvenance.timezoneAdmission.manifestHash,
    ).not.toBe(batch.sourceProvenance.timezoneAdmission.manifestHash);
    expect(olderSourceRestated.inputManifestHash).not.toBe(
      batch.inputManifestHash,
    );
  });

  it("hashes missing or mixed latest-date source timezone into a complete blocked account generation", () => {
    const older = makeRow({
      sourceRowId: "timezone-older-valid",
      date: "2026-07-10",
      accountTimezone: "Europe/Istanbul",
      sourceAccountTimezone: "Europe/Istanbul",
    });
    const missing = compute([
      older,
      makeRow({
        sourceRowId: "timezone-latest-missing",
        date: "2026-07-11",
        accountTimezone: "America/Chicago",
        sourceAccountTimezone: null,
      }),
    ]);
    expect(missing).toMatchObject({
      expectedCellCount: 0,
      cells: [],
      observations: [],
      sourceProvenance: {
        timezoneAdmission: {
          status: "blocked",
          keyBasis: null,
          accountTimezone: null,
          reason: "latest_source_timezone_missing",
          candidateRowCount: 2,
          latestSourceDate: "2026-07-11",
          latestSourceRowCount: 1,
          admittedRowCount: 0,
          anomalyRowCount: 1,
          sourceTimezoneMissingRowCount: 1,
          distinctSourceTimezoneCount: 0,
        },
      },
      spendUnitAuthority: {
        status: "blocked",
        basis: null,
        baseSpendUnit: null,
      },
    });

    const mixed = compute([
      older,
      makeRow({
        sourceRowId: "timezone-latest-a",
        adId: "timezone-latest-a",
        date: "2026-07-11",
        accountTimezone: "Europe/Istanbul",
        sourceAccountTimezone: "Europe/Istanbul",
      }),
      makeRow({
        sourceRowId: "timezone-latest-b",
        adId: "timezone-latest-b",
        date: "2026-07-11",
        accountTimezone: "America/Chicago",
        sourceAccountTimezone: "America/Chicago",
      }),
    ]);
    expect(mixed).toMatchObject({
      expectedCellCount: 0,
      cells: [],
      observations: [],
      sourceProvenance: {
        timezoneAdmission: {
          status: "blocked",
          reason: "mixed_latest_source_timezone",
          candidateRowCount: 3,
          latestSourceDate: "2026-07-11",
          latestSourceRowCount: 2,
          admittedRowCount: 0,
          anomalyRowCount: 2,
          sourceTimezoneMissingRowCount: 0,
          distinctSourceTimezoneCount: 2,
        },
      },
      spendUnitAuthority: {
        status: "blocked",
        basis: null,
        baseSpendUnit: null,
      },
    });
    expect(missing.sourceProvenance.timezoneAdmission.manifestHash).not.toBe(
      mixed.sourceProvenance.timezoneAdmission.manifestHash,
    );
    expect(missing.inputManifestHash).not.toBe(mixed.inputManifestHash);
  });

  it("keeps non-finite database purchase truth in the contradiction receipt", () => {
    const exact = makeRow({
      sourceRowId: "mapper-exact",
      adId: "mapper-exact",
      conversions: 5,
      revenue: 400,
    });
    const accountOnly = makeRow({
      sourceRowId: "mapper-account",
      adId: "mapper-account",
      campaignId: null,
      adsetId: null,
      conversions: 15,
      revenue: 1_500,
    });
    const malformed = mapNativeAdCalibrationSourceRow({
      ...toDbSourceRow(accountOnly),
      source_row_id: "mapper-non-finite",
      ad_id: "mapper-non-finite",
      conversions: "1",
      revenue: "NaN",
    });

    expect(Number.isNaN(malformed.revenue)).toBe(true);
    const batch = compute([exact, accountOnly, malformed], {
      target: AOV_ONLY_TARGET,
    });
    expect(batch.spendUnitAuthority).toMatchObject({
      status: "blocked",
      basis: null,
      accountAovEvidence: {
        status: "contradictory_purchase_truth",
        contradictoryRowCount: 1,
        observedPurchaseCount: 20,
      },
    });
    expect(batch.sourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps thin-cell commercial stop-loss authority closed when NO commercial anchor is configured", () => {
    /*
     * WHAT CHANGED: break-even is no longer a REQUIRED input.
     *
     * This case used to require BOTH a target ROAS and an explicit break-even
     * ROAS, so an account configured with a target ROAS alone had its Cut
     * refused with `break_even_roas_authority_missing` — a refusal on an input
     * nothing on this path consumes. Every lane in
     * `buildNativeAdSpendUnitAuthority` either takes a Target CPA whole or
     * divides an AOV by the Target ROAS, and the relative Cut boundary is a
     * Target-ROAS ratio; break-even reached none of them.
     *
     * The rule is now the one `account-decision-profile.ts` already spells:
     * a commercial ratio of EITHER kind. Break-even is still USED where it is
     * present — it is the better boundary for an economic Cut — it just no
     * longer refuses the action by its absence.
     */
    // RE-PINNED to `conversions: 4` for the same reason as the thin stop-loss
    // case above: the TARGET-ROAS-ONLY branch below now needs the platform AOV
    // sample floor cleared, because the pack's Target CPA no longer outranks it.
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeRow({
        sourceRowId: `thin-missing-anchor-${index}`,
        adId: `thin-missing-anchor-${index}`,
        conversions: 4,
        revenue: 40 + index,
      }),
    );

    // NEITHER anchor: there is no commercial ratio at all, so Cut stays closed.
    // This is the guard against reading the loosening as "no anchor needed".
    const noAnchor = compute(rows, {
      target: { ...FRESH_TARGET, targetRoas: null, breakEvenRoas: null },
    }).cells.find((cell) => cell.key.cellScope === "objective_cohort_context");
    expect(noAnchor?.actionReadiness.cut).toEqual({
      ready: false,
      reason: "target_roas_authority_missing",
      authorityBasis: null,
      observedSampleCount: 0,
      requiredSampleCount: 0,
    });

    // BREAK-EVEN ONLY, no target ROAS. The rule is EITHER anchor, so this
    // authorizes too — and symmetrically, which is the point: the loosening is
    // "a commercial ratio of either kind", not "break-even no longer counts".
    const breakEvenOnly = compute(rows, {
      target: { ...FRESH_TARGET, targetRoas: null },
    }).cells.find((cell) => cell.key.cellScope === "objective_cohort_context");
    expect(breakEvenOnly?.actionReadiness.cut).toEqual({
      ready: true,
      reason: null,
      authorityBasis: "commercial_stop_loss",
      observedSampleCount: 0,
      requiredSampleCount: 0,
    });

    // TARGET ROAS ONLY — the case the canonical rule is about. It used to be
    // refused for a missing break-even; it is now authorized on the commercial
    // stop-loss basis, on this thin cell, with no other input added.
    const targetRoasOnly = compute(rows, {
      target: { ...FRESH_TARGET, breakEvenRoas: null },
    }).cells.find((cell) => cell.key.cellScope === "objective_cohort_context");
    expect(targetRoasOnly?.actionReadiness.cut).toEqual({
      ready: true,
      reason: null,
      authorityBasis: "commercial_stop_loss",
      // All five rows are observed here. They were declared commercially
      // excluded before — `commercialAuthorityAdExclusionCount` counted every
      // purchase observation on a ROAS-only account — which is the second half
      // of the same defect: not only was the action refused, the evidence for
      // it was discarded.
      observedSampleCount: 5,
      requiredSampleCount: 0,
    });
  });

  it("keeps an old but bitemporally valid target authoritative", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      makeRow({
        sourceRowId: `old-target-${index}`,
        adId: `old-target-${index}`,
        revenue: 180 + index * 5,
      }),
    );
    const recent = compute(rows, { target: FRESH_TARGET });
    const old = compute(rows, { target: OLD_TARGET });
    const recentExact = recent.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    const oldExact = old.cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );

    expect(old.targetAuthority).toMatchObject({
      status: "stale",
      targetRoasAuthority: true,
      breakEvenRoasAuthority: true,
    });
    expect(old.qualityCounts.commercialAuthorityAdExclusionCount).toBe(0);
    expect(oldExact?.qualityStatus).toBe(recentExact?.qualityStatus);
    expect(oldExact?.actionReadiness.scale).toEqual(
      recentExact?.actionReadiness.scale,
    );
    expect(oldExact?.actionReadiness.cut).toEqual(
      recentExact?.actionReadiness.cut,
    );
    expect(oldExact?.actionReadiness.refresh).toEqual(
      recentExact?.actionReadiness.refresh,
    );
    /*
      RE-PINNED. `FRESH_TARGET`/`OLD_TARGET` carry a Target ROAS of 2 as well as
      a legacy Target CPA of 50, and with a Target ROAS the basis is the
      platform AOV over that ratio: 60 attributed purchases on 7,575.00 of
      revenue is a mean of 126.25, and 126.25 / 2 = 63.125.

      What this test measures — that an OLD but bitemporally valid target stays
      authoritative, with the same readiness as the fresh one — is unchanged and
      is asserted above. Only the provenance of the unit moved.
    */
    expect(oldExact?.actionReadiness.spendUnitAuthority).toMatchObject({
      status: "ready",
      basis: "physical_account_purchase_aov_90d",
      baseSpendUnit: 63.125,
    });
  });

  it("fails target authority closed for missing, deleted, cutoff-unsafe, and invalid anchors", () => {
    const deleted = resolveNativeAdTargetAuthority(
      { ...FRESH_TARGET, operation: "delete" },
      CUTOFF,
    );
    const futureEffective = resolveNativeAdTargetAuthority(
      {
        ...FRESH_TARGET,
        effectiveAt: "2026-07-12T03:06:00.000Z",
        recordedAt: "2026-07-12T03:06:01.000Z",
      },
      CUTOFF,
    );
    const futureRecorded = resolveNativeAdTargetAuthority(
      {
        ...FRESH_TARGET,
        recordedAt: "2026-07-12T03:06:00.000Z",
      },
      CUTOFF,
    );
    const reversedBitemporalOrder = resolveNativeAdTargetAuthority(
      {
        ...FRESH_TARGET,
        effectiveAt: "2026-07-01T00:00:02.000Z",
        recordedAt: "2026-07-01T00:00:01.000Z",
      },
      CUTOFF,
    );
    const invalidTimestamps = resolveNativeAdTargetAuthority(
      {
        ...FRESH_TARGET,
        effectiveAt: "not-a-date",
        recordedAt: null,
      },
      CUTOFF,
    );

    for (const authority of [
      resolveNativeAdTargetAuthority(null, CUTOFF),
      deleted,
      futureEffective,
      futureRecorded,
      reversedBitemporalOrder,
      invalidTimestamps,
    ]) {
      expect(authority.targetRoasAuthority).toBe(false);
      expect(authority.breakEvenRoasAuthority).toBe(false);
    }
    expect(resolveNativeAdTargetAuthority(null, CUTOFF).status).toBe("missing");
    expect(deleted.status).toBe("missing");
    for (const authority of [
      futureEffective,
      futureRecorded,
      reversedBitemporalOrder,
      invalidTimestamps,
    ]) {
      expect(authority.status).toBe("cutoff_unsafe");
    }

    expect(
      resolveNativeAdTargetAuthority(
        { ...FRESH_TARGET, targetRoas: 0, breakEvenRoas: 1.5 },
        CUTOFF,
      ),
    ).toMatchObject({
      status: "fresh",
      targetRoasAuthority: false,
      breakEvenRoasAuthority: true,
    });
    expect(
      resolveNativeAdTargetAuthority(
        { ...FRESH_TARGET, targetRoas: 2, breakEvenRoas: -1 },
        CUTOFF,
      ),
    ).toMatchObject({
      status: "fresh",
      targetRoasAuthority: true,
      breakEvenRoasAuthority: false,
    });
    expect(
      resolveNativeAdTargetAuthority(
        { ...FRESH_TARGET, targetRoas: Number.NaN, breakEvenRoas: 1.5 },
        CUTOFF,
      ).targetRoasAuthority,
    ).toBe(false);
  });

  it("defines cutoff safety exhaustively for every target authority status", () => {
    const cases: ReadonlyArray<
      readonly [NativeAdTargetAuthorityStatus, boolean]
    > = [
      ["fresh", true],
      ["stale", true],
      ["missing", false],
      ["cutoff_unsafe", false],
    ];

    for (const [status, expected] of cases) {
      expect(isNativeAdTargetAuthorityCutoffSafe(status)).toBe(expected);
    }
  });

  it("hard-disables historical/currently unbound computation", () => {
    expect(() => resolveNativeAdCalibrationDate(`${AS_OF}T03:00:00Z`)).toThrow(
      NativeAdHistoricalCalibrationUnsafeError,
    );
    expect(() => resolveNativeAdCalibrationDate("2026-02-31")).toThrow(
      NativeAdHistoricalCalibrationUnsafeError,
    );
    expect(() =>
      resolveNativeAdCalibrationCutoff("2026-07-11", CUTOFF),
    ).toThrow(NativeAdHistoricalCalibrationUnsafeError);
    expect(() =>
      compute([
        makeRow({
          providerAccountRefId: "00000000-0000-4000-8000-000000000999",
        }),
      ]),
    ).toThrow(/provider binding mismatch/i);
  });
});

describe("native ad calibration append-only persistence", () => {
  it("persists and proves an empty generation without retaining stale cells", async () => {
    const batch = compute([]);
    const calls: string[] = [];
    const db = fakeDb((query) => {
      calls.push(query);
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) return [];
      if (query === READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL) {
        return [];
      }
      if (query === INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: BATCH_ID }];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL) return [];
      if (query === COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: BATCH_ID }];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    await expect(
      replaceNativeAdCalibrationBatch(
        { batch, jobRunId: JOB_RUN_ID },
        { db, transaction: async (operation) => operation() },
      ),
    ).resolves.toMatchObject({
      batchId: BATCH_ID,
      rowsWritten: 0,
      expectedCellCount: 0,
      idempotentReplay: false,
      generationContentHash: batch.generationContentHash,
    });
    expect(calls).not.toContain(INSERT_NATIVE_AD_CALIBRATION_SQL);
    expect(calls.some((query) => /^DELETE\s/i.test(query.trim()))).toBe(false);
  });

  it("reuses a verified earlier batch when a later transaction sees identical content", async () => {
    const existingBatch = compute([makeRow()]);
    const rerun = compute([makeRow()], { cutoff: LATER_CUTOFF });
    const db = fakeDb((query) => {
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: LATER_CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) return [];
      if (query === READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL) {
        return [
          {
            id: BATCH_ID,
            as_of_cutoff: CUTOFF,
            generation_content_hash: existingBatch.generationContentHash,
            input_manifest_hash: existingBatch.inputManifestHash,
            source_manifest_hash: existingBatch.sourceManifestHash,
            cell_set_hash: existingBatch.cellSetHash,
            expected_cell_count: existingBatch.expectedCellCount,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL) {
        return proofRows(existingBatch);
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await replaceNativeAdCalibrationBatch(
      { batch: rerun, jobRunId: JOB_RUN_ID },
      { db, transaction: async (operation) => operation() },
    );
    expect(result).toMatchObject({
      batchId: BATCH_ID,
      rowsWritten: 0,
      idempotentReplay: true,
      generationContentHash: existingBatch.generationContentHash,
      inputManifestHash: existingBatch.inputManifestHash,
    });
  });

  it("rejects same-cutoff contradictory content and a forged transaction receipt", async () => {
    const batch = compute([makeRow()]);
    const binding = {
      provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
      provider_account_id: PROVIDER_ACCOUNT_ID,
    };
    const conflictDb = fakeDb((query) => {
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) return [binding];
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) {
        return [
          {
            id: BATCH_ID,
            completeness_status: "complete",
            generation_content_hash: "f".repeat(64),
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });
    await expect(
      replaceNativeAdCalibrationBatch(
        { batch, jobRunId: JOB_RUN_ID },
        { db: conflictDb, transaction: async (operation) => operation() },
      ),
    ).rejects.toThrow(/same_cutoff_generation_conflict/);

    const forgedDb = fakeDb((query) =>
      query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL
        ? [
            {
              computation_cutoff: LATER_CUTOFF,
              transaction_isolation: "repeatable read",
            },
          ]
        : [],
    );
    await expect(
      replaceNativeAdCalibrationBatch(
        { batch, jobRunId: JOB_RUN_ID },
        { db: forgedDb, transaction: async (operation) => operation() },
      ),
    ).rejects.toThrow(/transaction receipt does not match/i);

    const tamperedCurrencyReceipt: NativeAdCalibrationBatch = {
      ...batch,
      sourceProvenance: {
        ...batch.sourceProvenance,
        currencyAdmission: {
          ...batch.sourceProvenance.currencyAdmission,
          manifestHash: "not-a-hash",
        },
      },
    };
    await expect(
      replaceNativeAdCalibrationBatch(
        { batch: tamperedCurrencyReceipt, jobRunId: JOB_RUN_ID },
        {
          db: fakeDb(() => {
            throw new Error("Persistence must not run for a forged receipt.");
          }),
          transaction: async (operation) => operation(),
        },
      ),
    ).rejects.toThrow(/currency admission receipt is malformed/i);

    const tamperedTimezoneReceipt: NativeAdCalibrationBatch = {
      ...batch,
      sourceProvenance: {
        ...batch.sourceProvenance,
        timezoneAdmission: {
          ...batch.sourceProvenance.timezoneAdmission,
          manifestHash: "not-a-hash",
        },
      },
    };
    await expect(
      replaceNativeAdCalibrationBatch(
        { batch: tamperedTimezoneReceipt, jobRunId: JOB_RUN_ID },
        {
          db: fakeDb(() => {
            throw new Error("Persistence must not run for a forged receipt.");
          }),
          transaction: async (operation) => operation(),
        },
      ),
    ).rejects.toThrow(/timezone admission receipt is malformed/i);
  });
});

describe("native ad calibration producer and SQL contract", () => {
  it("uses only physical account refs, current transaction receipt, and native epoch", () => {
    for (const fragment of [
      "d.provider_account_ref_id = $3::uuid",
      "d.provider_account_id = $4",
      "d.updated_at <= $5::timestamptz",
      "binding.provider_account_ref_id = d.provider_account_ref_id",
      "NULLIF(BTRIM(account.currency), '')",
      "NULLIF(BTRIM(d.account_timezone), '') AS source_account_timezone",
      "NULLIF(BTRIM(d.account_currency), '') AS source_account_currency",
    ]) {
      expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).toContain(fragment);
    }
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).toContain(
      "NULLIF(BTRIM(d.account_timezone), '') AS account_timezone",
    );
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).not.toContain(
      "NULLIF(BTRIM(account.timezone), '')",
    );
    expect(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL).toMatch(
      /COALESCE\(\s*NULLIF\(BTRIM\(d\.account_currency\), ''\),\s*NULLIF\(BTRIM\(account\.currency\), ''\)\s*\) AS account_currency/,
    );
    expect(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL).toContain(
      "binding.provider_account_ref_id = $2::uuid",
    );
    expect(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL).toContain(
      "history.recorded_at <= $4::timestamptz",
    );
    expect(INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL).toContain(
      "generation_content_hash",
    );
    expect(CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL).toContain(
      "ON DELETE RESTRICT",
    );
    expect(CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL).not.toContain(
      "immutable_generation",
    );
    expect(CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL).toContain(
      "provider_account_ref_id UUID NOT NULL",
    );
    expect(
      NATIVE_AD_CALIBRATION_MIGRATION_SQL.indexOf(
        "idx_provider_accounts_physical_identity",
      ),
    ).toBeLessThan(
      NATIVE_AD_CALIBRATION_MIGRATION_SQL.indexOf(
        "CREATE TABLE IF NOT EXISTS engine_v3_ad_account_calibration_batches",
      ),
    );
    expect(NATIVE_AD_CALIBRATION_POLICY_VERSION).toContain(
      NATIVE_AD_ENGINE_VERSION,
    );
    expect(
      adCalibrationJobAdvisoryLockKey({ businessId: BUSINESS_ID, asOf: AS_OF }),
    ).toBeTypeOf("bigint");
  });

  it("fails the exact schema gate on type/nullability/constraint/index/trigger drift", async () => {
    const readyDb = fakeDb((query) => exactSchemaRows(query));
    await expect(
      inspectNativeAdCalibrationSchemaCapability(readyDb),
    ).resolves.toEqual({ ready: true, missing: [], mismatched: [] });

    const driftedDb = fakeDb((query) => {
      const rows = exactSchemaRows(query);
      if (query.includes("JOIN pg_attribute")) {
        return rows.map((row) =>
          row.column_name === "provider_account_ref_id" &&
          row.table_name === NATIVE_AD_CALIBRATION_TABLE
            ? { ...row, not_null: false }
            : row,
        );
      }
      return rows.filter(
        (row) => row.name !== "engine_v3_ad_calibration_daily_binding_fk",
      );
    });
    await expect(
      inspectNativeAdCalibrationSchemaCapability(driftedDb),
    ).resolves.toMatchObject({
      ready: false,
      missing: ["constraint:engine_v3_ad_calibration_daily_binding_fk"],
      mismatched: [
        `${NATIVE_AD_CALIBRATION_TABLE}.provider_account_ref_id:column_contract`,
      ],
    });
  });

  it("runs the scheduled account loop through a complete empty-source generation", async () => {
    let sourceParams: unknown[] | undefined;
    const db = fakeDb((query, params) => {
      if (query === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        return [];
      if (query.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID }];
      }
      if (query.startsWith("SAVEPOINT")) return [];
      const schema = exactSchemaRows(query);
      if (schema.length > 0 || query.includes("FROM pg_trigger")) return schema;
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_SOURCE_SQL) {
        sourceParams = params;
        return [];
      }
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) return [];
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) return [];
      if (query === READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL) {
        return [];
      }
      if (query === INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: BATCH_ID }];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL) return [];
      if (query === COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: BATCH_ID }];
      }
      if (query.includes("SET status = 'success'")) return [{ id: JOB_RUN_ID }];
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await runAdCalibrationJob(
      { businessId: BUSINESS_ID, asOf: AS_OF },
      {
      /*
        The store was NEVER CONSULTED for these cases, which is what
        `undefined` means in the authority contract.

        This block is about the calibration SQL contract and its persisted
        generation hashes. Returning `null` would say "we asked the store and
        it had nothing", which is a different fact, enters the generation
        content, and changes every pinned hash here for a reason that has
        nothing to do with what these cases measure. The store's own wiring is
        proven in `shopify-anchor-wiring` and in the ephemeral-database seam.
      */
      resolveObservedAov: async () => undefined,
        db,
        transaction: async (operation) => operation(),
        businessGuard: async () => null,
        resolveFlags: async () => enabledFlags(),
      },
    );
    expect(result).toMatchObject({
      status: "success",
      rowsWritten: 0,
      expectedCellCount: 0,
      idempotentReplay: false,
      batches: [
        {
          providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
          providerAccountId: PROVIDER_ACCOUNT_ID,
          batchId: BATCH_ID,
          expectedCellCount: 0,
        },
      ],
    });
    expect(sourceParams).toEqual([
      BUSINESS_ID,
      AS_OF,
      PROVIDER_ACCOUNT_REF_ID,
      PROVIDER_ACCOUNT_ID,
      CUTOFF,
    ]);
  });

  it("keeps a healthy account and a dimension-blocked account in one atomic successful business receipt", async () => {
    const healthySource = makeRow({
      sourceRowId: "healthy-account-source",
      adId: "healthy-account-ad",
    });
    const blockedSource = makeRow({
      sourceRowId: "blocked-account-source",
      providerAccountRefId: SECOND_PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: SECOND_PROVIDER_ACCOUNT_ID,
      adId: "blocked-account-ad",
      sourceAccountCurrency: null,
      accountCurrency: "USD",
      sourceAccountTimezone: null,
      accountTimezone: "America/Chicago",
    });
    const healthyBatch = computeNativeAdCalibrationBatch({
      businessId: BUSINESS_ID,
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      asOf: AS_OF,
      computationCutoff: CUTOFF,
      sourceRows: [healthySource],
      targetAuthority: null,
    });
    const blockedBatch = computeNativeAdCalibrationBatch({
      businessId: BUSINESS_ID,
      providerAccountRefId: SECOND_PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: SECOND_PROVIDER_ACCOUNT_ID,
      asOf: AS_OF,
      computationCutoff: CUTOFF,
      sourceRows: [blockedSource],
      targetAuthority: null,
    });
    expect(healthyBatch.expectedCellCount).toBeGreaterThan(0);
    expect(blockedBatch).toMatchObject({
      expectedCellCount: 0,
      sourceProvenance: {
        currencyAdmission: {
          status: "blocked",
          reason: "source_currency_missing",
        },
        timezoneAdmission: {
          status: "blocked",
          reason: "latest_source_timezone_missing",
        },
      },
    });

    let successReceipt: Record<string, unknown> | null = null;
    let rolledBack = false;
    const db = fakeDb((query, params) => {
      if (query === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        return [];
      if (query.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID }];
      }
      if (query.startsWith("ROLLBACK TO SAVEPOINT")) {
        rolledBack = true;
        return [];
      }
      if (query.startsWith("SAVEPOINT")) return [];
      const schema = exactSchemaRows(query);
      if (schema.length > 0 || query.includes("FROM pg_trigger")) return schema;
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
          {
            provider_account_ref_id: SECOND_PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: SECOND_PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_SOURCE_SQL) {
        return params?.[3] === SECOND_PROVIDER_ACCOUNT_ID
          ? [toDbSourceRow(blockedSource)]
          : [toDbSourceRow(healthySource)];
      }
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) return [];
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: params?.[1],
            provider_account_id: params?.[2],
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) return [];
      if (query === READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL) {
        return [];
      }
      if (query === INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [
          {
            id:
              params?.[3] === SECOND_PROVIDER_ACCOUNT_ID
                ? SECOND_BATCH_ID
                : BATCH_ID,
          },
        ];
      }
      if (query === INSERT_NATIVE_AD_CALIBRATION_SQL) return [];
      if (query === READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL) {
        return params?.[0] === SECOND_BATCH_ID
          ? []
          : proofRows(healthyBatch);
      }
      if (query === COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: params?.[0] }];
      }
      if (query.includes("SET status = 'success'")) {
        successReceipt = JSON.parse(String(params?.[5] ?? "{}")) as Record<
          string,
          unknown
        >;
        return [{ id: JOB_RUN_ID }];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await runAdCalibrationJob(
      { businessId: BUSINESS_ID, asOf: AS_OF },
      {
      /*
        The store was NEVER CONSULTED for these cases, which is what
        `undefined` means in the authority contract.

        This block is about the calibration SQL contract and its persisted
        generation hashes. Returning `null` would say "we asked the store and
        it had nothing", which is a different fact, enters the generation
        content, and changes every pinned hash here for a reason that has
        nothing to do with what these cases measure. The store's own wiring is
        proven in `shopify-anchor-wiring` and in the ephemeral-database seam.
      */
      resolveObservedAov: async () => undefined,
        db,
        transaction: async (operation) => operation(),
        businessGuard: async () => null,
        resolveFlags: async () => enabledFlags(),
      },
    );
    expect(result.status).toBe("success");
    expect(result.batches).toHaveLength(2);
    expect(result.batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerAccountId: PROVIDER_ACCOUNT_ID,
          expectedCellCount: healthyBatch.expectedCellCount,
          currencyAdmission: expect.objectContaining({ status: "ready" }),
          timezoneAdmission: expect.objectContaining({ status: "ready" }),
        }),
        expect.objectContaining({
          providerAccountId: SECOND_PROVIDER_ACCOUNT_ID,
          expectedCellCount: 0,
          currencyAdmission: expect.objectContaining({
            status: "blocked",
            reason: "source_currency_missing",
          }),
          timezoneAdmission: expect.objectContaining({
            status: "blocked",
            reason: "latest_source_timezone_missing",
          }),
        }),
      ]),
    );
    expect(rolledBack).toBe(false);
    expect(successReceipt).toMatchObject({
      metadata: {
        provider_account_count: 2,
        batches: expect.arrayContaining([
          expect.objectContaining({
            provider_account_id: SECOND_PROVIDER_ACCOUNT_ID,
            currency_admission: expect.objectContaining({
              status: "blocked",
              reason: "source_currency_missing",
            }),
            timezone_admission: expect.objectContaining({
              status: "blocked",
              reason: "latest_source_timezone_missing",
            }),
          }),
        ]),
      },
    });
  });

  it("keeps a cross-provider source identity mismatch transaction-fatal for the whole business", async () => {
    const forgedSecondAccountSource = makeRow({
      sourceRowId: "forged-second-account-source",
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    let rolledBack = false;
    let completedFirstBatch = false;
    const db = fakeDb((query, params) => {
      if (query === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        return [];
      if (query.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID }];
      }
      if (query.startsWith("ROLLBACK TO SAVEPOINT")) {
        rolledBack = true;
        return [];
      }
      if (query.startsWith("SAVEPOINT")) return [];
      const schema = exactSchemaRows(query);
      if (schema.length > 0 || query.includes("FROM pg_trigger")) return schema;
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
          {
            provider_account_ref_id: SECOND_PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: SECOND_PROVIDER_ACCOUNT_ID,
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_SOURCE_SQL) {
        return params?.[3] === SECOND_PROVIDER_ACCOUNT_ID
          ? [toDbSourceRow(forgedSecondAccountSource)]
          : [];
      }
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) return [];
      if (query === ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL) {
        return [
          {
            provider_account_ref_id: params?.[1],
            provider_account_id: params?.[2],
          },
        ];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL) return [];
      if (query === READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL) {
        return [];
      }
      if (query === INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        return [{ id: BATCH_ID }];
      }
      if (query === READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL) return [];
      if (query === COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL) {
        completedFirstBatch = true;
        return [{ id: BATCH_ID }];
      }
      if (query.includes("SET status = 'failed'")) return [{ id: JOB_RUN_ID }];
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await runAdCalibrationJob(
      { businessId: BUSINESS_ID, asOf: AS_OF },
      {
      /*
        The store was NEVER CONSULTED for these cases, which is what
        `undefined` means in the authority contract.

        This block is about the calibration SQL contract and its persisted
        generation hashes. Returning `null` would say "we asked the store and
        it had nothing", which is a different fact, enters the generation
        content, and changes every pinned hash here for a reason that has
        nothing to do with what these cases measure. The store's own wiring is
        proven in `shopify-anchor-wiring` and in the ephemeral-database seam.
      */
      resolveObservedAov: async () => undefined,
        db,
        transaction: async (operation) => operation(),
        businessGuard: async () => null,
        resolveFlags: async () => enabledFlags(),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      rowsWritten: 0,
      batches: [],
      errorMessage: expect.stringMatching(/provider binding mismatch/i),
    });
    expect(completedFirstBatch).toBe(true);
    expect(rolledBack).toBe(true);
  });

  it("asserts terminal job UPDATE RETURNING exactly one running row", async () => {
    const db = fakeDb((query) => {
      if (query === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        return [];
      if (query.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID }];
      }
      if (query.startsWith("SAVEPOINT")) return [];
      if (query.startsWith("ROLLBACK TO SAVEPOINT")) return [];
      const schema = exactSchemaRows(query);
      if (schema.length > 0 || query.includes("FROM pg_trigger")) return schema;
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query === LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL) return [];
      if (query.includes("SET status = 'success'")) return [];
      if (query.includes("SET status = 'failed'")) return [{ id: JOB_RUN_ID }];
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await runAdCalibrationJob(
      { businessId: BUSINESS_ID, asOf: AS_OF },
      {
      /*
        The store was NEVER CONSULTED for these cases, which is what
        `undefined` means in the authority contract.

        This block is about the calibration SQL contract and its persisted
        generation hashes. Returning `null` would say "we asked the store and
        it had nothing", which is a different fact, enters the generation
        content, and changes every pinned hash here for a reason that has
        nothing to do with what these cases measure. The store's own wiring is
        proven in `shopify-anchor-wiring` and in the ephemeral-database seam.
      */
      resolveObservedAov: async () => undefined,
        db,
        transaction: async (operation) => operation(),
        businessGuard: async () => null,
        resolveFlags: async () => enabledFlags(),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      errorMessage:
        "Native ad calibration success terminal update did not affect exactly its running job row.",
      batches: [],
    });
  });

  it("records an old date as historical_as_of_unsafe before any warehouse read", async () => {
    const calls: string[] = [];
    const db = fakeDb((query) => {
      calls.push(query);
      if (query === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        return [];
      if (query.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (query.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: JOB_RUN_ID }];
      }
      if (query.startsWith("SAVEPOINT")) return [];
      if (query.startsWith("ROLLBACK TO SAVEPOINT")) return [];
      const schema = exactSchemaRows(query);
      if (schema.length > 0 || query.includes("FROM pg_trigger")) return schema;
      if (query === READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL) {
        return [
          {
            computation_cutoff: CUTOFF,
            transaction_isolation: "repeatable read",
          },
        ];
      }
      if (query.includes("SET status = 'failed'")) return [{ id: JOB_RUN_ID }];
      throw new Error(`Unexpected SQL: ${query}`);
    });

    const result = await runAdCalibrationJob(
      { businessId: BUSINESS_ID, asOf: "2026-07-11" },
      {
      /*
        The store was NEVER CONSULTED for these cases, which is what
        `undefined` means in the authority contract.

        This block is about the calibration SQL contract and its persisted
        generation hashes. Returning `null` would say "we asked the store and
        it had nothing", which is a different fact, enters the generation
        content, and changes every pinned hash here for a reason that has
        nothing to do with what these cases measure. The store's own wiring is
        proven in `shopify-anchor-wiring` and in the ephemeral-database seam.
      */
      resolveObservedAov: async () => undefined,
        db,
        transaction: async (operation) => operation(),
        businessGuard: async () => null,
        resolveFlags: async () => enabledFlags(),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "historical_as_of_unsafe",
      batches: [],
    });
    expect(calls).not.toContain(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL);
  });

  it("exposes the scheduled-chain job contract", () => {
    expect(AD_CALIBRATION_JOB_NAME).toBe(
      "engine_v3_native_ad_calibration_shadow_job",
    );
    expect(runAdCalibrationJob).toBeTypeOf("function");
  });
});

/*
  ── ROUND 9 ITEM 5: THE DURABLE LINEAGE, PROVEN AGAINST REAL POSTGRESQL ──────

  Everything else about the contract-version work can be asserted in memory. Two
  things cannot:

    1. That the migration is SAFE on a table that already has rows. Both
       calibration tables carry BEFORE UPDATE triggers that raise
       unconditionally, so a backfill written as `UPDATE ... SET
       contract_version` aborts on the first existing row. `ADD COLUMN ...
       DEFAULT ... NOT NULL` is metadata-only on PostgreSQL 11+ and fires no row
       trigger — a claim about the database, provable only in one.
    2. That the PRODUCTION reader hydrates the stamp and refuses a superseded
       row end to end, through the real SQL rather than through a mapper called
       with a hand-built object.
*/
const postgresCandidates = [
  process.env.EPHEMERAL_PG_BIN_DIR
    ? `${process.env.EPHEMERAL_PG_BIN_DIR}/initdb`
    : "",
  "/opt/homebrew/opt/postgresql@16/bin/initdb",
  "/opt/homebrew/bin/initdb",
  "/usr/local/opt/postgresql@16/bin/initdb",
  "/usr/bin/initdb",
].filter(Boolean);
const postgresAvailable = postgresCandidates.some((candidate) =>
  fs.existsSync(candidate),
);

describe.runIf(postgresAvailable)(
  "native ad calibration PostgreSQL seam",
  () => {
    it("PRODUCTION GATE: a pre-Round-9 schema is not ready, migrates, and then is", async () => {
      /*
        ── ROUND 10 ITEM 1 ─────────────────────────────────────────────────────

        `lib/migrations.ts` runs the calibration migration ONLY when capability
        reports `ready: false`. The capability contract omitted
        `contract_version` and both CHECK constraints, so a database that had
        every OTHER column reported ready, the ALTER was skipped, and the first
        `SELECT batch.contract_version` — which the production profile reader
        does on every read — crashed against a column that was never added.

        This drives `runNativeAdCalibrationSchemaGate`, the real exported gate,
        NOT `NATIVE_AD_CALIBRATION_MIGRATION_SQL`. Calling the migration
        directly would apply the ALTER unconditionally and could therefore never
        observe the skip, which is the entire defect.
      */
      await withEphemeralPostgres(async (pool) => {
        await createEphemeralSchema(pool);
        const db = poolDb(pool);

        // A legacy row, written by whatever writer this database once had.
        const legacy = await inRepeatableRead(pool, async (client, receipt) => {
          const row = makeRowForReceipt(receipt, "gate-legacy");
          const batch = computeForReceipt([row], receipt, null);
          const result = await replaceNativeAdCalibrationBatch(
            { batch, jobRunId: JOB_RUN_ID },
            {
              db: clientDb(client),
              transaction: async (operation) => operation(),
            },
          );
          return { batch, result };
        });
        expect(legacy.result.rowsWritten).toBeGreaterThan(0);

        /*
          THE PRIOR SCHEMA: exactly these columns and constraints absent, and
          nothing else touched. Dropping the column drops its CHECK with it.
        */
        await pool.query(`
          ALTER TABLE engine_v3_ad_account_calibration_batches
            DROP COLUMN contract_version;
          ALTER TABLE engine_v3_ad_account_calibration_daily
            DROP COLUMN contract_version;
        `);

        const before = await inspectNativeAdCalibrationSchemaCapability(db);
        expect(before.ready).toBe(false);
        // And it is missing for the RIGHT reason, not incidentally.
        expect(before.missing).toEqual(
          expect.arrayContaining([
            "engine_v3_ad_account_calibration_batches.contract_version",
            "engine_v3_ad_account_calibration_daily.contract_version",
            "constraint:engine_v3_ad_calibration_batches_contract_version_check",
            "constraint:engine_v3_ad_calibration_cells_contract_version_check",
          ]),
        );

        // THE PRODUCTION GATE.
        const after = await runNativeAdCalibrationSchemaGate({
          db,
          inspectorDb: db,
        });
        expect(after.ready).toBe(true);

        // Legacy rows are stamped truthfully, not guessed at.
        const stamped = await pool.query(`
          SELECT batch.contract_version AS batch_version,
                 cell.contract_version AS cell_version
          FROM engine_v3_ad_account_calibration_batches batch
          JOIN engine_v3_ad_account_calibration_daily cell
            ON cell.batch_id = batch.id
          LIMIT 1
        `);
        expect(stamped.rows[0]).toEqual({
          batch_version: NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
          cell_version: NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
        });

        // Both constraints exist and carry the exact body the contract names.
        const constraints = await pool.query(
          `
          SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition
          FROM pg_constraint
          WHERE conname = ANY($1::text[])
          `,
          [[
            "engine_v3_ad_calibration_batches_contract_version_check",
            "engine_v3_ad_calibration_cells_contract_version_check",
          ]],
        );
        expect(constraints.rows).toHaveLength(2);
        for (const row of constraints.rows) {
          expect(row.definition).toBe(
            nativeAdCalibrationContractVersionCheck(),
          );
        }

        // An UNSTAMPED insert now fails, so no future writer can reintroduce
        // an unversioned row.
        await expect(
          pool.query(`
            INSERT INTO engine_v3_ad_account_calibration_batches (
              business_ref_id, business_id, provider, provider_account_ref_id,
              provider_account_id, as_of_date, as_of_cutoff,
              transaction_isolation, engine_version, policy_version,
              source_mode, source_provenance_json, expected_cell_count,
              generation_content_hash, input_manifest_hash,
              source_manifest_hash, cell_set_hash, completeness_status,
              job_run_id, computed_at
            )
            SELECT business_ref_id, business_id, provider,
              provider_account_ref_id, provider_account_id, as_of_date,
              as_of_cutoff + interval '5 seconds', transaction_isolation,
              engine_version, policy_version, source_mode,
              source_provenance_json, expected_cell_count,
              repeat('a', 64), repeat('b', 64), repeat('c', 64), repeat('d', 64),
              'writing', job_run_id, as_of_cutoff + interval '5 seconds'
            FROM engine_v3_ad_account_calibration_batches LIMIT 1
          `),
        ).rejects.toThrow(/contract_version/);

        // And a correctly stamped current insert succeeds.
        const stampedInsert = await inRepeatableRead(
          pool,
          async (client, receipt) => {
            const row = makeRowForReceipt(receipt, "gate-current");
            const batch = computeForReceipt([row], receipt, null);
            return replaceNativeAdCalibrationBatch(
              { batch, jobRunId: JOB_RUN_ID },
              {
                db: clientDb(client),
                transaction: async (operation) => operation(),
              },
            );
          },
        );
        expect(stampedInsert.rowsWritten).toBeGreaterThan(0);
        const current = await pool.query(
          `SELECT contract_version FROM engine_v3_ad_account_calibration_batches
           WHERE id = $1::uuid`,
          [stampedInsert.batchId],
        );
        expect(current.rows[0]?.contract_version).toBe(
          NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
        );

        expect(
          (await inspectNativeAdCalibrationSchemaCapability(db)).ready,
        ).toBe(true);
      });
    });

    it("migrates pre-existing rows to legacy_unknown and refuses them as superseded", async () => {
      await withEphemeralPostgres(async (pool) => {
        await createEphemeralSchema(pool);
        const db = poolDb(pool);

        /*
          A row written BEFORE the column existed. Simulated by dropping the
          column, which is exactly the schema such a writer saw, and then
          re-running the additive migration over a table that already has rows —
          the case the trigger would have blocked had this been an UPDATE.
        */
        const written = await inRepeatableRead(pool, async (client, receipt) => {
          const row = makeRowForReceipt(receipt, "legacy-lineage");
          const batch = computeForReceipt([row], receipt, null);
          const result = await replaceNativeAdCalibrationBatch(
            { batch, jobRunId: JOB_RUN_ID },
            {
              db: clientDb(client),
              transaction: async (operation) => operation(),
            },
          );
          return { batch, result };
        });
        expect(written.result.rowsWritten).toBeGreaterThan(0);

        await pool.query(`
          ALTER TABLE engine_v3_ad_account_calibration_batches
            DROP COLUMN contract_version;
          ALTER TABLE engine_v3_ad_account_calibration_daily
            DROP COLUMN contract_version;
        `);

        // THE MIGRATION, over a table that already holds rows.
        await pool.query(ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL);

        const stamped = await pool.query(`
          SELECT batch.contract_version AS batch_version,
                 cell.contract_version AS cell_version
          FROM engine_v3_ad_account_calibration_batches batch
          JOIN engine_v3_ad_account_calibration_daily cell
            ON cell.batch_id = batch.id
          LIMIT 1
        `);
        // Not `.v3`, not `.v4`, not the current one: the writer of these rows is
        // genuinely unknown, and the migration says so rather than guessing.
        expect(stamped.rows[0]).toEqual({
          batch_version: NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
          cell_version: NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
        });

        // The default is dropped, so a future writer cannot inherit it.
        const columnDefault = await pool.query(`
          SELECT column_default
          FROM information_schema.columns
          WHERE table_name = 'engine_v3_ad_account_calibration_batches'
            AND column_name = 'contract_version'
        `);
        expect(columnDefault.rows[0]?.column_default).toBeNull();

        /*
          THROUGH THE PRODUCTION READER, not a hand-built object. The mapper
          hydrates the durable stamp and enforces batch/cell agreement.
        */
        const cellKey = written.batch.cells.find(
          (cell) => cell.key.cellScope === "objective_cohort_context",
        )!.key;
        const source = new WarehouseNativeAdAccountProfileDataSource(db);
        const hydrated = await source.getNativeAdCalibrationCell({
          businessId: cellKey.businessId,
          providerAccountId: cellKey.providerAccountId,
          accountTimezone: cellKey.accountTimezone,
          accountCurrency: cellKey.accountCurrency,
          cellScope: cellKey.cellScope,
          objective: cellKey.objective,
          cohort: cellKey.cohort,
          optimizationContext: cellKey.optimizationContext,
          asOfDate: written.batch.asOfDate,
          engineVersion: NATIVE_AD_ENGINE_VERSION,
          policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
        } as never);
        expect(hydrated?.contractVersion).toBe(
          NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
        );

        /*
          AND THE REFUSAL IS THE SPECIFIC ONE. Not "invalid" — the row is not
          broken — and not silently accepted under today's formula, which is what
          happened before the column existed.
        */
        const profile = await resolveNativeAdAccountDecisionProfile({
          businessId: cellKey.businessId,
          providerAccountId: cellKey.providerAccountId,
          accountTimezone: cellKey.accountTimezone,
          accountCurrency: cellKey.accountCurrency,
          objective: cellKey.objective,
          optimizationGoal: "PURCHASE",
          customEventType: "PURCHASE",
          cohort: "purchase",
          asOf: written.batch.asOfDate,
          dataSource: source as never,
          flags: {
            businessId: cellKey.businessId,
            enabled: true,
            surfaceVisible: false,
            shadowOnly: false,
            presetOverride: null,
            source: {
              enabled: "env",
              surfaceVisible: "env",
              shadowOnly: "env",
              presetOverride: null,
            },
            envDefaults: {
              enabled: true,
              surfaceVisible: false,
              shadowOnly: false,
            },
          } as never,
        });
        expect(profile.status).toBe("fail_closed");
        expect(profile.reason).toBe("native_calibration_contract_superseded");
        expect(profile.profile).toBeNull();
      });
    });

    it("proves empty replacement, append-only generations, RR late-row isolation, savepoints, FK binding, and tamper rejection", async () => {
      await withEphemeralPostgres(async (pool) => {
        await createEphemeralSchema(pool);
        const db = poolDb(pool);
        await expect(
          inspectNativeAdCalibrationSchemaCapability(db),
        ).resolves.toEqual({ ready: true, missing: [], mismatched: [] });

        const providerBindings = await pool.query(
          LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
          [BUSINESS_ID],
        );
        expect(providerBindings.rows).toEqual([
          {
            // The account's own currency travels with the binding now, so the
            // caller can resolve a store benchmark in the SAME currency. No
            // conversion is ever performed, which is why it has to be read
            // here rather than assumed later.
            account_currency: "USD",
            provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
            provider_account_id: PROVIDER_ACCOUNT_ID,
          },
        ]);

        const empty = await inRepeatableRead(pool, async (client, receipt) => {
          const batch = computeForReceipt([], receipt, null);
          const result = await replaceNativeAdCalibrationBatch(
            { batch, jobRunId: JOB_RUN_ID },
            {
              db: clientDb(client),
              transaction: async (operation) => operation(),
            },
          );
          return { batch, result };
        });
        expect(empty.result).toMatchObject({
          rowsWritten: 0,
          expectedCellCount: 0,
          idempotentReplay: false,
        });

        const replay = await inRepeatableRead(pool, async (client, receipt) => {
          const batch = computeForReceipt([], receipt, null);
          return replaceNativeAdCalibrationBatch(
            { batch, jobRunId: JOB_RUN_ID },
            {
              db: clientDb(client),
              transaction: async (operation) => operation(),
            },
          );
        });
        expect(replay).toMatchObject({
          batchId: empty.result.batchId,
          idempotentReplay: true,
        });

        await proveLateSourceRowIsolation(pool);

        const changed = await inRepeatableRead(
          pool,
          async (client, receipt) => {
            const row = makeRowForReceipt(receipt, "changed-content");
            const batch = computeForReceipt([row], receipt, null);
            return replaceNativeAdCalibrationBatch(
              { batch, jobRunId: JOB_RUN_ID },
              {
                db: clientDb(client),
                transaction: async (operation) => operation(),
              },
            );
          },
        );
        expect(changed.idempotentReplay).toBe(false);
        const batchCount = await pool.query(
          "SELECT count(*)::integer AS count FROM engine_v3_ad_account_calibration_batches WHERE completeness_status = 'complete'",
        );
        expect(batchCount.rows[0]?.count).toBe(2);

        await inRepeatableRead(pool, async (client, receipt) => {
          const dbInTransaction = clientDb(client);
          const first = computeForReceipt([], receipt, {
            ...FRESH_TARGET,
            effectiveAt: new Date(
              Date.parse(receipt) - 86_400_000,
            ).toISOString(),
            recordedAt: new Date(
              Date.parse(receipt) - 86_399_000,
            ).toISOString(),
          });
          const persisted = await replaceNativeAdCalibrationBatch(
            { batch: first, jobRunId: JOB_RUN_ID },
            {
              db: dbInTransaction,
              transaction: async (operation) => operation(),
            },
          );
          await client.query("SAVEPOINT contradictory_generation");
          const contradictory = computeForReceipt(
            [makeRowForReceipt(receipt, "same-cutoff-conflict")],
            receipt,
            first.targetAuthority.status === "fresh" ? FRESH_TARGET : null,
          );
          await expect(
            replaceNativeAdCalibrationBatch(
              { batch: contradictory, jobRunId: JOB_RUN_ID },
              {
                db: dbInTransaction,
                transaction: async (operation) => operation(),
              },
            ),
          ).rejects.toThrow(/same_cutoff_generation_conflict/);
          await client.query("ROLLBACK TO SAVEPOINT contradictory_generation");
          const proof = await client.query(
            "SELECT completeness_status FROM engine_v3_ad_account_calibration_batches WHERE id = $1::uuid",
            [persisted.batchId],
          );
          expect(proof.rows[0]?.completeness_status).toBe("complete");
        });

        const completeBatch = await pool.query(
          "SELECT id::text AS id FROM engine_v3_ad_account_calibration_batches WHERE expected_cell_count > 0 ORDER BY created_at DESC LIMIT 1",
        );
        const completeBatchId = String(completeBatch.rows[0]?.id);
        await expectPgError(
          () =>
            pool.query(
              "UPDATE engine_v3_ad_account_calibration_batches SET expected_cell_count = expected_cell_count + 1 WHERE id = $1::uuid",
              [completeBatchId],
            ),
          ["P0001"],
          "completed batch tamper",
        );
        await expectPgError(
          () =>
            pool.query(
              "DELETE FROM engine_v3_ad_account_calibration_daily WHERE batch_id = $1::uuid",
              [completeBatchId],
            ),
          ["P0001"],
          "cell tamper",
        );
        await expectPgError(
          () =>
            pool.query(
              `INSERT INTO engine_v3_ad_account_calibration_daily
             SELECT (
               jsonb_populate_record(
                 NULL::engine_v3_ad_account_calibration_daily,
                 to_jsonb(cell) || jsonb_build_object(
                   'id', gen_random_uuid(),
                   'objective', 'TAMPER_OBJECTIVE',
                   'input_manifest_hash', repeat('e', 64)
                 )
               )
             ).*
             FROM engine_v3_ad_account_calibration_daily cell
             WHERE cell.batch_id = $1::uuid
             LIMIT 1`,
              [completeBatchId],
            ),
          ["P0001"],
          "post-completion cell insert",
        );
        await expectPgError(
          () =>
            pool.query(
              `WITH candidate AS (
                SELECT batch.*, gen_random_uuid() AS wrong_ref,
                  batch.as_of_cutoff + interval '1 second' AS new_cutoff
                FROM engine_v3_ad_account_calibration_batches batch
                WHERE batch.id = $1::uuid
              )
              INSERT INTO engine_v3_ad_account_calibration_batches (
              contract_version,
              business_ref_id, business_id, provider, provider_account_ref_id,
              provider_account_id, as_of_date, as_of_cutoff,
              transaction_isolation, engine_version, policy_version,
              source_mode, source_provenance_json, expected_cell_count,
              generation_content_hash, input_manifest_hash,
              source_manifest_hash, cell_set_hash, completeness_status,
              job_run_id, computed_at
            ) SELECT contract_version, business_ref_id, business_id, provider, wrong_ref,
              provider_account_id, as_of_date, new_cutoff,
              transaction_isolation, engine_version, policy_version,
              source_mode,
              jsonb_set(
                jsonb_set(
                  source_provenance_json,
                  '{providerAccountRefId}',
                  to_jsonb(wrong_ref::text)
                ),
                '{transactionCutoff}',
                to_jsonb(new_cutoff::text)
              ),
              expected_cell_count,
              repeat('a', 64), repeat('b', 64), repeat('c', 64), repeat('d', 64),
              'writing', job_run_id, new_cutoff
            FROM candidate`,
              [completeBatchId],
            ),
          ["23503"],
          "foreign account binding",
        );
        const incomplete = await pool.query(
          `WITH candidate AS (
            SELECT batch.*,
              batch.as_of_cutoff + interval '2 seconds' AS new_cutoff
            FROM engine_v3_ad_account_calibration_batches batch
            WHERE batch.id = $1::uuid
          )
          INSERT INTO engine_v3_ad_account_calibration_batches (
            contract_version,
            business_ref_id, business_id, provider, provider_account_ref_id,
            provider_account_id, as_of_date, as_of_cutoff,
            transaction_isolation, engine_version, policy_version,
            source_mode, source_provenance_json, expected_cell_count,
            generation_content_hash, input_manifest_hash,
            source_manifest_hash, cell_set_hash, completeness_status,
            job_run_id, computed_at
          ) SELECT contract_version, business_ref_id, business_id, provider,
            provider_account_ref_id, provider_account_id, as_of_date,
            new_cutoff, transaction_isolation, engine_version, policy_version,
            source_mode,
            jsonb_set(
              source_provenance_json,
              '{transactionCutoff}',
              to_jsonb(new_cutoff::text)
            ),
            1, repeat('1', 64), repeat('2', 64), repeat('3', 64),
            repeat('4', 64), 'writing', job_run_id, new_cutoff
          FROM candidate
          RETURNING id::text AS id`,
          [completeBatchId],
        );
        await expectPgError(
          () =>
            pool.query(
              `UPDATE engine_v3_ad_account_calibration_batches
               SET completeness_status = 'complete', completed_at = now()
               WHERE id = $1::uuid`,
              [incomplete.rows[0]?.id],
            ),
          ["P0001"],
          "cardinality-free completion",
        );

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SAVEPOINT schema_drift");
          await client.query(
            "DROP INDEX idx_engine_v3_ad_account_calibration_lookup",
          );
          await expect(
            inspectNativeAdCalibrationSchemaCapability(clientDb(client)),
          ).resolves.toMatchObject({ ready: false });
          await client.query("ROLLBACK TO SAVEPOINT schema_drift");
          await expect(
            inspectNativeAdCalibrationSchemaCapability(clientDb(client)),
          ).resolves.toEqual({ ready: true, missing: [], mismatched: [] });
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      });
    }, 120_000);
  },
);

function computeForReceipt(
  rows: NativeAdCalibrationSourceRow[],
  receipt: string,
  target: NativeAdTargetAuthorityInput | null,
) {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    asOf: receipt.slice(0, 10),
    computationCutoff: receipt,
    sourceRows: rows,
    targetAuthority: target,
  });
}

function makeRowForReceipt(
  receipt: string,
  id: string,
): NativeAdCalibrationSourceRow {
  const before = new Date(Date.parse(receipt) - 1_000).toISOString();
  return makeRow({
    sourceRowId: id,
    adId: id,
    date: receipt.slice(0, 10),
    finalizedAt: before,
    createdAt: before,
    updatedAt: before,
    campaignCreatedAt: before,
    campaignUpdatedAt: before,
    adsetCreatedAt: before,
    adsetUpdatedAt: before,
  });
}

async function proveLateSourceRowIsolation(pool: Pool) {
  const reader = await pool.connect();
  try {
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const receiptResult = await reader.query(
      READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
    );
    const receipt = new Date(
      receiptResult.rows[0]?.computation_cutoff,
    ).toISOString();
    const params = [
      BUSINESS_ID,
      receipt.slice(0, 10),
      PROVIDER_ACCOUNT_REF_ID,
      PROVIDER_ACCOUNT_ID,
      receipt,
    ];
    const before = await reader.query(
      READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
      params,
    );
    expect(before.rowCount).toBe(0);

    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      const observedAt = new Date().toISOString();
      const date = receipt.slice(0, 10);
      await writer.query(
        `INSERT INTO meta_campaign_daily (
          business_ref_id, provider_account_ref_id, provider_account_id, date,
          campaign_id, objective, optimization_goal, custom_event_type,
          truth_state, validation_status, created_at, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'late-campaign',
          'OUTCOME_SALES', 'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
        [
          BUSINESS_ID,
          PROVIDER_ACCOUNT_REF_ID,
          PROVIDER_ACCOUNT_ID,
          date,
          observedAt,
        ],
      );
      await writer.query(
        `INSERT INTO meta_adset_daily (
          business_ref_id, provider_account_ref_id, provider_account_id, date,
          adset_id, optimization_goal, custom_event_type,
          truth_state, validation_status, created_at, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'late-adset',
          'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
        [
          BUSINESS_ID,
          PROVIDER_ACCOUNT_REF_ID,
          PROVIDER_ACCOUNT_ID,
          date,
          observedAt,
        ],
      );
      await writer.query(
        `INSERT INTO meta_ad_daily (
          business_ref_id, provider_account_ref_id, provider_account_id, date,
          campaign_id, adset_id, ad_id, account_timezone, account_currency,
          spend, impressions, clicks, link_clicks, conversions, revenue,
          payload_json, truth_state, validation_status, finalized_at,
          created_at, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'late-campaign',
          'late-adset', 'late-ad', 'UTC', 'USD', 10, 1000, 20, 15, 1, 30,
          '{}'::jsonb, 'finalized', 'passed', $5, $5, $5)`,
        [
          BUSINESS_ID,
          PROVIDER_ACCOUNT_REF_ID,
          PROVIDER_ACCOUNT_ID,
          date,
          observedAt,
        ],
      );
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }

    const during = await reader.query(
      READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
      params,
    );
    expect(during.rowCount).toBe(0);
    await reader.query("COMMIT");

    await pool.query(
      "UPDATE provider_accounts SET timezone = 'Pacific/Honolulu' WHERE id = $1::uuid",
      [PROVIDER_ACCOUNT_REF_ID],
    );
    await inRepeatableRead(pool, async (client, nextReceipt) => {
      const visible = await client.query(
        READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
        [
          BUSINESS_ID,
          nextReceipt.slice(0, 10),
          PROVIDER_ACCOUNT_REF_ID,
          PROVIDER_ACCOUNT_ID,
          nextReceipt,
        ],
      );
      expect(visible.rowCount).toBe(1);
      expect(visible.rows[0]).toMatchObject({
        account_timezone: "UTC",
        source_account_timezone: "UTC",
        account_currency: "USD",
        source_account_currency: "USD",
      });
      const currentProvider = await client.query(
        "SELECT timezone FROM provider_accounts WHERE id = $1::uuid",
        [PROVIDER_ACCOUNT_REF_ID],
      );
      expect(currentProvider.rows[0]?.timezone).toBe("Pacific/Honolulu");

      const batch = computeForReceipt(
        visible.rows.map(mapNativeAdCalibrationSourceRow),
        nextReceipt,
        null,
      );
      expect(batch.sourceProvenance.timezoneAdmission).toMatchObject({
        status: "ready",
        keyBasis: "immutable_latest_source_date",
        accountTimezone: "UTC",
        latestSourceDate: nextReceipt.slice(0, 10),
      });
      expect(
        new Set(batch.cells.map((cell) => cell.key.accountTimezone)),
      ).toEqual(new Set(["UTC"]));
    });
  } catch (error) {
    await reader.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    reader.release();
  }
}

/**
 * THE ENGINE EQUIVALENCE SEAM — the load-bearing proof of the link_clicks
 * null-versus-zero change.
 *
 * THE CLAIM UNDER TEST. `meta_ad_daily.link_clicks` used to be
 * `BIGINT NOT NULL DEFAULT 0`, and the only production writer of it typed a
 * literal `0` because the sync holds no link-click value at all. Storage was
 * widened so an unsupplied count can be stored as NULL instead of that
 * fabricated zero. The engine must not notice: every number it produced from a
 * row storing 0 it must still produce from the same row storing NULL.
 *
 * WHY THIS TEST AND NOT A SMALLER ONE. `mapNativeAdCalibrationSourceRow` read
 * this column through `dbRequiredNumber`, which THROWS on NULL — so the first
 * unsupplied ad-day would have aborted the whole native ad calibration job, and
 * a unit test over a hand-built row object could not show it because the row
 * never came from a database that could hold a NULL. Both worlds here are read
 * out of a REAL PostgreSQL through the REAL exported query
 * (`READ_NATIVE_AD_CALIBRATION_SOURCE_SQL`), mapped by the REAL mapper and
 * folded by the REAL `computeNativeAdCalibrationBatch`.
 *
 * HOW EQUIVALENCE IS ESTABLISHED. One fixture, written once. It is read as the
 * ZERO world, then the single column is flipped 0 -> NULL by an UPDATE that
 * touches nothing else, and it is read again as the NULL world. Every other
 * byte of every row is identical by construction, so any difference in the two
 * batches can only come from this column. The comparison is a deep equality on
 * the whole computed batch — every cell, every count, every ratio, every
 * provenance field — not a spot-check of the metrics someone remembered to
 * name.
 *
 * WHAT THIS TEST IS NOT. It is not a test that link clicks are being supplied.
 * Supplying a real count from the provider payload would CHANGE these numbers
 * and is a different change with a different proof; this file asserts the
 * opposite — that nothing moved.
 */
describe.runIf(postgresAvailable)(
  "native ad calibration link_clicks: absence is not a measured zero",
  () => {
    it("separates an unsupplied link_clicks from a stored zero, end to end", async () => {
      await withEphemeralPostgres(async (pool) => {
        await createEphemeralSchema(pool);

        // A spread of shapes, because equivalence has to hold for all of them:
        // an ad with spend and impressions, an ad that delivered nothing, and
        // an ad with conversions and revenue. Every one of them stores
        // link_clicks = 0 to begin with, which is exactly what production
        // stores for all 192,464 of its zero rows.
        const day = "2026-08-10";
        const observedAt = "2026-08-11T00:00:00.000Z";
        const fixture = [
          { adId: "eq-ad-spending", spend: 120.5, impressions: 5000, clicks: 90, conversions: 3, revenue: 410.25 },
          { adId: "eq-ad-silent", spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 },
          { adId: "eq-ad-converting", spend: 88.75, impressions: 2400, clicks: 61, conversions: 7, revenue: 933.4 },
        ];

        await pool.query(
          `INSERT INTO meta_campaign_daily (
             business_ref_id, provider_account_ref_id, provider_account_id, date,
             campaign_id, objective, optimization_goal, custom_event_type,
             truth_state, validation_status, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-campaign',
             'OUTCOME_SALES', 'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
          [BUSINESS_ID, PROVIDER_ACCOUNT_REF_ID, PROVIDER_ACCOUNT_ID, day, observedAt],
        );
        await pool.query(
          `INSERT INTO meta_adset_daily (
             business_ref_id, provider_account_ref_id, provider_account_id, date,
             adset_id, optimization_goal, custom_event_type,
             truth_state, validation_status, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-adset',
             'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
          [BUSINESS_ID, PROVIDER_ACCOUNT_REF_ID, PROVIDER_ACCOUNT_ID, day, observedAt],
        );
        for (const row of fixture) {
          await pool.query(
            `INSERT INTO meta_ad_daily (
               business_ref_id, provider_account_ref_id, provider_account_id, date,
               campaign_id, adset_id, ad_id, account_timezone, account_currency,
               spend, impressions, clicks, link_clicks, conversions, revenue,
               payload_json, truth_state, validation_status, finalized_at,
               created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-campaign', 'eq-adset',
               $5, 'UTC', 'USD', $6, $7, $8, 0, $9, $10,
               '{}'::jsonb, 'finalized', 'passed', $11, $11, $11)`,
            [
              BUSINESS_ID,
              PROVIDER_ACCOUNT_REF_ID,
              PROVIDER_ACCOUNT_ID,
              day,
              row.adId,
              row.spend,
              row.impressions,
              row.clicks,
              row.conversions,
              row.revenue,
              observedAt,
            ],
          );
        }

        const readWorld = async () =>
          inRepeatableRead(pool, async (client, receipt) => {
            const source = await client.query(
              READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
              [
                BUSINESS_ID,
                day,
                PROVIDER_ACCOUNT_REF_ID,
                PROVIDER_ACCOUNT_ID,
                receipt,
              ],
            );
            const mapped = source.rows.map(mapNativeAdCalibrationSourceRow);
            // The receipt is a wall-clock value and differs between the two
            // reads, so the batch is computed against ONE fixed receipt. Any
            // difference that survives is attributable to link_clicks alone.
            return {
              linkClicks: mapped.map((mappedRow) => mappedRow.linkClicks),
              rowCount: source.rowCount,
              batch: computeForReceipt(mapped, `${day}T12:00:00.000Z`, null),
            };
          });

        const zeroWorld = await readWorld();
        expect(zeroWorld.rowCount).toBe(fixture.length);
        expect(zeroWorld.linkClicks).toEqual([0, 0, 0]);

        // The ONLY mutation: the stored zero becomes an unsupplied absence.
        const flipped = await pool.query(
          `UPDATE meta_ad_daily SET link_clicks = NULL WHERE business_ref_id = $1::uuid`,
          [BUSINESS_ID],
        );
        expect(flipped.rowCount).toBe(fixture.length);
        const remainingZeros = await pool.query(
          `SELECT count(*)::int AS count FROM meta_ad_daily WHERE link_clicks IS NOT NULL`,
        );
        expect(remainingZeros.rows[0]?.count).toBe(0);

        const nullWorld = await readWorld();

        // 1. The mapper survives the NULL at all. Before the null-safety change
        //    this line threw `link_clicks must be finite.` and took the entire
        //    calibration job with it.
        expect(nullWorld.rowCount).toBe(fixture.length);

        /*
          2. RE-PINNED, IN THE OPPOSITE DIRECTION (Codex B10).

          This asserted the two worlds were EQUIVALENT — that an unsupplied
          link-click day yields the same 0 a measured zero yields, and that the
          whole batch is byte-identical. That equivalence WAS the defect. The
          mapper coerced NULL to 0, so "the provider reported nothing" entered
          the account's link-click rate as "the provider measured zero", and a
          rate was computed over a population that had never been measured.

          Absence and a measured zero are now different answers. The NULL world
          reports no link-click reading at all, and the rates derived from it
          are absent rather than computed from fabricated zeros.
        */
        expect(zeroWorld.linkClicks).toEqual([0, 0, 0]);
        expect(nullWorld.linkClicks).toEqual([null, null, null]);
        expect(nullWorld.linkClicks).not.toEqual(zeroWorld.linkClicks);

        /*
          3. AND THE BATCH IS UNCHANGED HERE, honestly — because this fixture's
             measured value is ZERO. A zero link-click total is not a usable
             denominator either, so every rate derived from it is already null
             in the measured world; absence and zero therefore produce the same
             DERIVED output on this population even though they are now
             different observations. Asserting a difference here would have
             been asserting something untrue of these rows.

             The case where the distinction actually changes an answer needs a
             POSITIVE population, and it is the next test.
        */
        expect(nullWorld.batch).toEqual(zeroWorld.batch);
      });
    }, 120_000);

    /*
      THE CASE THAT CHANGES AN ANSWER (Codex B10).

      With a POSITIVE measured population the link-click total is a real
      denominator and `clickToPurchaseRate` is a real number. Blank one
      contributing day and the population is no longer measured — the old
      mapper coerced that day to 0, quietly shrinking the denominator and
      RAISING the rate; the rate now goes absent instead.
    */
    it("computes a link-click rate only from complete evidence", async () => {
      await withEphemeralPostgres(async (pool) => {
        await createEphemeralSchema(pool);
        const day = "2026-08-10";
        const observedAt = "2026-08-11T00:00:00.000Z";
        const fixture = [
          { adId: "lc-ad-a", spend: 120.5, impressions: 5000, clicks: 90, conversions: 3, revenue: 410.25 },
          { adId: "lc-ad-b", spend: 88.75, impressions: 2400, clicks: 61, conversions: 7, revenue: 933.4 },
        ];
        await pool.query(
          `INSERT INTO meta_campaign_daily (
             business_ref_id, provider_account_ref_id, provider_account_id, date,
             campaign_id, objective, optimization_goal, custom_event_type,
             truth_state, validation_status, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-campaign',
             'OUTCOME_SALES', 'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
          [BUSINESS_ID, PROVIDER_ACCOUNT_REF_ID, PROVIDER_ACCOUNT_ID, day, observedAt],
        );
        await pool.query(
          `INSERT INTO meta_adset_daily (
             business_ref_id, provider_account_ref_id, provider_account_id, date,
             adset_id, optimization_goal, custom_event_type,
             truth_state, validation_status, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-adset',
             'PURCHASE', 'PURCHASE', 'finalized', 'passed', $5, $5)`,
          [BUSINESS_ID, PROVIDER_ACCOUNT_REF_ID, PROVIDER_ACCOUNT_ID, day, observedAt],
        );
        for (const row of fixture) {
          await pool.query(
            `INSERT INTO meta_ad_daily (
               business_ref_id, provider_account_ref_id, provider_account_id, date,
               campaign_id, adset_id, ad_id, account_timezone, account_currency,
               spend, impressions, clicks, link_clicks, conversions, revenue,
               payload_json, truth_state, validation_status, finalized_at,
               created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'eq-campaign', 'eq-adset',
               $5, 'UTC', 'USD', $6, $7, $8, 40, $9, $10,
               '{}'::jsonb, 'finalized', 'passed', $11, $11, $11)`,
            [
              BUSINESS_ID,
              PROVIDER_ACCOUNT_REF_ID,
              PROVIDER_ACCOUNT_ID,
              day,
              row.adId,
              row.spend,
              row.impressions,
              row.clicks,
              row.conversions,
              row.revenue,
              observedAt,
            ],
          );
        }

        const readWorld = async () =>
          inRepeatableRead(pool, async (client, receipt) => {
            const source = await client.query(
              READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
              [BUSINESS_ID, day, PROVIDER_ACCOUNT_REF_ID, PROVIDER_ACCOUNT_ID, receipt],
            );
            const mapped = source.rows.map(mapNativeAdCalibrationSourceRow);
            const batch = computeForReceipt(mapped, `${day}T12:00:00.000Z`, null);
            return {
              linkClicks: mapped.map((mappedRow) => mappedRow.linkClicks),
              // The observable consequence: how many ads contributed a
              // click-to-purchase reading to the account's calibration.
              clickToPurchaseSamples: batch.cells.map(
                (cell) => cell.metricSampleCounts.clickToPurchase,
              ),
              batch,
            };
          });

        // COMPLETE POSITIVE: every contributing row measured 40 link clicks.
        const complete = await readWorld();
        expect(complete.linkClicks).toEqual([40, 40]);

        // MIXED INCOMPLETE: one day goes unreported. The remaining day still
        // measured 40, so the old coercion would have produced a denominator
        // of 40 and a rate — from half the population.
        await pool.query(
          `UPDATE meta_ad_daily SET link_clicks = NULL WHERE ad_id = 'lc-ad-a'`,
        );
        const mixed = await readWorld();
        expect(mixed.linkClicks).toEqual(expect.arrayContaining([null, 40]));

        /*
          THE OBSERVABLE IS THE MAPPED VALUE, and deliberately not the batch.

          This population is two ads, which is far below the sample floor that
          produces calibration cells, so `batch.cells` is empty in BOTH worlds
          and comparing batches here would assert nothing — it would be exactly
          the kind of green this review round exists to remove. What the
          fixture can prove is what the coercion actually did: the unreported
          day now reaches the engine as `null` instead of as a fabricated `0`,
          so it contributes no denominator rather than a false one. The
          rate-level consequence of that null is covered by
          `sumOptionalComplete`, which every link-click rate now goes through.
        */
        expect(complete.linkClicks).not.toContain(null);
        expect(mixed.linkClicks).toContain(null);
        expect(mixed.linkClicks).not.toEqual(complete.linkClicks);
        // And specifically NOT the pre-fix answer, which was a measured zero.
        expect(mixed.linkClicks).not.toContain(0);
      });
    }, 120_000);

    /**
     * The SQL half, on the exact expressions that were changed.
     *
     * PostgreSQL SUM IGNORES nulls, so `SUM(link_clicks)` over an all-null
     * window returns NULL where it returns 0 today — a real behaviour change,
     * and the one thing the widening could genuinely have broken. The fix is
     * `SUM(COALESCE(link_clicks, 0))`, and the coalesce is INSIDE the SUM on
     * purpose: `COALESCE(SUM(x), 0)` would ALSO turn "no rows matched this
     * window" from NULL into 0, which is a different answer than today's.
     *
     * All three window shapes are checked against real PostgreSQL, because this
     * is a claim about the aggregate's null semantics and no amount of reading
     * settles it:
     *   - rows present, all unsupplied  -> 0    (matches today's stored zeros)
     *   - rows present, mixed           -> sum  (unchanged)
     *   - no rows at all                -> NULL (unchanged; NOT coerced to 0)
     */
    it("keeps every changed aggregate identical to the pre-change expression over stored zeros", async () => {
      await withEphemeralPostgres(async (pool) => {
        await pool.query(`
          CREATE TABLE eq_zero  (bucket TEXT NOT NULL, link_clicks BIGINT NOT NULL);
          CREATE TABLE eq_null  (bucket TEXT NOT NULL, link_clicks BIGINT);
          INSERT INTO eq_zero VALUES ('all', 0), ('all', 0), ('mixed', 0), ('mixed', 7);
          INSERT INTO eq_null VALUES ('all', NULL), ('all', NULL), ('mixed', NULL), ('mixed', 7);
        `);

        // Pre-change expression over the zero world vs post-change expression
        // over the null world. Same rows, same grouping, same everything else.
        const before = await pool.query(
          `SELECT bucket, SUM(link_clicks)::text AS total FROM eq_zero GROUP BY bucket ORDER BY bucket`,
        );
        const after = await pool.query(
          `SELECT bucket, SUM(COALESCE(link_clicks, 0))::text AS total FROM eq_null GROUP BY bucket ORDER BY bucket`,
        );
        expect(after.rows).toEqual(before.rows);
        expect(before.rows).toEqual([
          { bucket: "all", total: "0" },
          { bucket: "mixed", total: "7" },
        ]);

        // The empty window must stay NULL on both sides. This is the assertion
        // that rules out `COALESCE(SUM(x), 0)`, which would answer 0 here and
        // silently invent a measured zero for a window with no rows in it.
        const emptyBefore = await pool.query(
          `SELECT SUM(link_clicks) AS total FROM eq_zero WHERE bucket = 'absent'`,
        );
        const emptyAfter = await pool.query(
          `SELECT SUM(COALESCE(link_clicks, 0)) AS total FROM eq_null WHERE bucket = 'absent'`,
        );
        expect(emptyBefore.rows[0]?.total).toBeNull();
        expect(emptyAfter.rows[0]?.total).toBeNull();

        // The row-level coalesce used where the raw column leaves the table
        // (historical_source in data-source.ts and lifecycle-job.ts) so the
        // guarded ratio below it stays textually and numerically identical.
        const ratioBefore = await pool.query(
          `SELECT CASE WHEN SUM(link_clicks) > 0
                       THEN 100::numeric / NULLIF(SUM(link_clicks), 0) END AS rate
             FROM eq_zero WHERE bucket = 'all'`,
        );
        const ratioAfter = await pool.query(
          `SELECT CASE WHEN SUM(link_clicks) > 0
                       THEN 100::numeric / NULLIF(SUM(link_clicks), 0) END AS rate
             FROM (SELECT COALESCE(link_clicks, 0) AS link_clicks
                     FROM eq_null WHERE bucket = 'all') coalesced`,
        );
        expect(ratioAfter.rows[0]?.rate).toEqual(ratioBefore.rows[0]?.rate);
        expect(ratioBefore.rows[0]?.rate).toBeNull();
      });
    }, 120_000);
  },
);

async function createEphemeralSchema(pool: Pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE businesses (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE provider_accounts (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      external_account_id TEXT NOT NULL,
      timezone TEXT,
      currency TEXT
    );
    CREATE TABLE business_provider_accounts (
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL
    );
    CREATE TABLE engine_v3_job_runs (
      id UUID PRIMARY KEY,
      job_name TEXT NOT NULL,
      business_ref_id UUID,
      business_id TEXT,
      as_of_date DATE,
      engine_version TEXT,
      status TEXT,
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      row_count INTEGER,
      source_min_date DATE,
      source_max_date DATE,
      source_max_updated_at TIMESTAMPTZ,
      error_message TEXT,
      error_json JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE business_target_pack_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL,
      operation TEXT NOT NULL,
      target_cpa DOUBLE PRECISION,
      target_roas DOUBLE PRECISION,
      break_even_cpa DOUBLE PRECISION,
      break_even_roas DOUBLE PRECISION,
      aov_assumption DOUBLE PRECISION,
      default_risk_posture TEXT,
      effective_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_campaign_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_ref_id UUID NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      date DATE NOT NULL,
      campaign_id TEXT NOT NULL,
      objective TEXT,
      optimization_goal TEXT,
      custom_event_type TEXT,
      truth_state TEXT,
      validation_status TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_adset_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_ref_id UUID NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      date DATE NOT NULL,
      adset_id TEXT NOT NULL,
      optimization_goal TEXT,
      custom_event_type TEXT,
      truth_state TEXT,
      validation_status TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_ad_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_ref_id UUID NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      date DATE NOT NULL,
      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT NOT NULL,
      account_timezone TEXT,
      account_currency TEXT,
      metric_schema_version INTEGER NOT NULL DEFAULT 2,
      spend DOUBLE PRECISION NOT NULL,
      impressions DOUBLE PRECISION NOT NULL,
      clicks DOUBLE PRECISION NOT NULL,
      -- NULLABLE, mirroring the production column after the 2026-08-19
      -- widening. It was NOT NULL here, which meant the "unsupplied link
      -- clicks" case could not even be expressed in this harness -- the exact
      -- blind spot that let the engine's per-row read keep a dbRequiredNumber
      -- that throws on NULL. See the equivalence seam below.
      link_clicks DOUBLE PRECISION,
      conversions DOUBLE PRECISION NOT NULL,
      revenue DOUBLE PRECISION NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      truth_state TEXT,
      validation_status TEXT,
      finalized_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    INSERT INTO businesses (id, name) VALUES ('${BUSINESS_ID}', 'Test');
    INSERT INTO provider_accounts (
      id, provider, external_account_id, timezone, currency
    ) VALUES (
      '${PROVIDER_ACCOUNT_REF_ID}', 'meta', '${PROVIDER_ACCOUNT_ID}',
      'Europe/Istanbul', 'USD'
    );
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (
      '${BUSINESS_ID}', 'meta', '${PROVIDER_ACCOUNT_REF_ID}', '${PROVIDER_ACCOUNT_ID}'
    );
    INSERT INTO engine_v3_job_runs (
      id, job_name, business_ref_id, business_id, as_of_date,
      engine_version, status
    ) VALUES (
      '${JOB_RUN_ID}', '${AD_CALIBRATION_JOB_NAME}', '${BUSINESS_ID}',
      '${BUSINESS_ID}', CURRENT_DATE, '${NATIVE_AD_ENGINE_VERSION}', 'running'
    );
  `);
  await pool.query(NATIVE_AD_CALIBRATION_MIGRATION_SQL);
}

function clientDb(client: PoolClient): DbClient {
  const query = async <TRow extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => (await client.query<TRow>(sql, params)).rows;
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

function poolDb(pool: Pool): DbClient {
  const query = async <TRow extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => (await pool.query<TRow>(sql, params)).rows;
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

async function inRepeatableRead<T>(
  pool: Pool,
  operation: (client: PoolClient, receipt: string) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const receipt = await client.query(
      READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
    );
    const cutoff = new Date(receipt.rows[0]?.computation_cutoff).toISOString();
    const result = await operation(client, cutoff);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectPgError(
  operation: () => Promise<unknown>,
  codes: readonly string[],
  label: string,
) {
  try {
    await operation();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (codes.includes(code)) return;
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

function postgresBin(name: string) {
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR
      ? path.join(process.env.EPHEMERAL_PG_BIN_DIR, name)
      : "",
    `/opt/homebrew/opt/postgresql@16/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/opt/postgresql@16/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`PostgreSQL binary not found: ${name}`);
  return found;
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * A shell with no locale set is enough to make this seam unrunnable, and the
 * failure does not name itself: `pg_ctl` reports only "could not start server",
 * and the reason is in the cluster log the harness never printed --
 * "postmaster became multithreaded during startup", hinting at LC_ALL. On
 * macOS an empty LC_ALL sends the postmaster's locale lookup through a
 * thread-spawning path, and PostgreSQL refuses to run multithreaded.
 *
 * `initdb --no-locale` is not enough: it fixes the cluster's own collation but
 * not the environment the postmaster then starts in. So the locale is pinned
 * for the child processes rather than inherited, which also keeps the seam
 * reading identical bytes on every machine.
 */
const POSTGRES_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: POSTGRES_ENV,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function withEphemeralPostgres(operation: (pool: Pool) => Promise<void>) {
  const initdb = postgresBin("initdb");
  const pgCtl = postgresBin("pg_ctl");
  const createdb = postgresBin("createdb");
  const port = await freePort();
  if (port === 5432 || port === 15432) {
    throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
  }
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsecute-native-calibration-"),
  );
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  let started = false;
  let pool: Pool | null = null;
  try {
    run(initdb, [
      "-D",
      dataDir,
      "-U",
      "postgres",
      "-A",
      "trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    run(pgCtl, [
      "-D",
      dataDir,
      "-l",
      logFile,
      "-o",
      `-F -h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ]);
    started = true;
    run(createdb, [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "postgres",
      "adsecute_native_calibration",
    ]);
    pool = new Pool({
      connectionString: `postgresql://postgres@127.0.0.1:${port}/adsecute_native_calibration`,
      max: 4,
    });
    await operation(pool);
  } finally {
    await pool?.end().catch(() => undefined);
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
