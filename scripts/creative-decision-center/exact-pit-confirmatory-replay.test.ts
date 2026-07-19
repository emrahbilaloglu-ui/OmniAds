import { describe, expect, it } from "vitest";
import {
  buildExactCampaignStatusSelection,
  buildExactConfigReceiptQuery,
  buildExactPitConfirmatoryReport,
  buildRollingCutoffSourceReceipts,
  buildRollingCutoffWindowReceipts,
  parseExactPitArgs,
  summarizePersistedBaseline,
  type ExactConfigReceipt,
  type ExactTargetCandidate,
  type PersistedBaselineRow,
} from "@/scripts/creative-decision-center/exact-pit-confirmatory-replay";
import {
  buildPitIntegrityReport,
  type PitRawSnapshotRow,
} from "@/scripts/creative-decision-center/raw-snapshot-pit-integrity";

const businessId = "59dac76f-eb5e-409b-958c-bba440d1036b";
const accountId = "act_1468627890554405";
const campaignId = "campaign-1";
const adsetId = "adset-1";
const adId = "ad-1";

function snapshot(input: {
  date: string;
  payload?: Array<Record<string, unknown>>;
  providerCursor?: string | null;
  fetchedAt?: string;
}): PitRawSnapshotRow {
  const fetchedAt = input.fetchedAt ?? `${input.date}T02:30:00.000Z`;
  const createdAt = new Date(Date.parse(fetchedAt) + 1_000).toISOString();
  return {
    id: `snapshot-${input.date}`,
    businessId,
    providerAccountId: accountId,
    partitionId: `partition-${input.date}`,
    checkpointId: `checkpoint-${input.date}`,
    runId: `run-${input.date}`,
    endpointName: "ad_insights_bulk",
    entityScope: "ad",
    pageIndex: 0,
    providerCursor: input.providerCursor ?? null,
    startDate: input.date,
    endDate: input.date,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    payloadJson: input.payload ?? [
      {
        ad_id: adId,
        adset_id: adsetId,
        campaign_id: campaignId,
        date_start: input.date,
        date_stop: input.date,
        spend: "10.00",
        impressions: "1000",
        clicks: "25",
        actions: [{ action_type: "purchase", value: "1" }],
      },
    ],
    payloadHash: `stored-${input.date}`,
    providerHttpStatus: 200,
    status: "fetched",
    fetchedAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function campaignStatusSnapshot(input: {
  date: string;
  id: string;
  fetchedAt: string;
  payload?: Array<Record<string, unknown>>;
  snapshotStatus?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}): PitRawSnapshotRow {
  const createdAt =
    input.createdAt === undefined
      ? new Date(Date.parse(input.fetchedAt) + 1_000).toISOString()
      : input.createdAt;
  return {
    id: input.id,
    businessId,
    providerAccountId: accountId,
    partitionId: null,
    checkpointId: null,
    runId: null,
    endpointName: "campaign_statuses",
    entityScope: "campaign",
    pageIndex: null,
    providerCursor: null,
    startDate: input.date,
    endDate: input.date,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    payloadJson: input.payload ?? [
      {
        id: campaignId,
        effective_status: "ACTIVE",
        status: "ACTIVE",
      },
    ],
    payloadHash: `campaign-status-${input.id}`,
    providerHttpStatus: null,
    status: input.snapshotStatus ?? "fetched",
    fetchedAt: input.fetchedAt,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

function integrity(
  date: string,
  overrides?: Partial<
    Pick<PitRawSnapshotRow, "payloadJson" | "providerCursor">
  >,
) {
  const cutoff = `${date}T03:00:00.000Z`;
  return buildPitIntegrityReport({
    rows: [
      snapshot({
        date,
        payload: overrides?.payloadJson as
          Array<Record<string, unknown>> | undefined,
        providerCursor: overrides?.providerCursor,
      }),
    ],
    decisionDate: date,
    cutoff,
    generatedAt: cutoff,
  });
}

function integrityAtDecisionCutoff(
  sourceDate: string,
  decisionDate: string,
  row = snapshot({ date: sourceDate }),
) {
  const cutoff = `${decisionDate}T03:00:00.000Z`;
  return buildPitIntegrityReport({
    rows: [row],
    decisionDate: sourceDate,
    cutoff,
    generatedAt: cutoff,
  });
}

function datesBetween(startDate: string, endDate: string) {
  const values: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    values.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

function rollingReceiptsFor(input: {
  sourceRows: Map<string, PitRawSnapshotRow>;
  decisionDates: string[];
}) {
  return input.decisionDates.flatMap((decisionDate) =>
    Array.from(input.sourceRows.entries()).flatMap(([sourceDate, row]) => {
      if (sourceDate > decisionDate) return [];
      const report = integrityAtDecisionCutoff(sourceDate, decisionDate, row);
      return buildRollingCutoffSourceReceipts({
        decisionDate,
        integrityReport: report,
      });
    }),
  );
}

function config(
  date: string,
  entityType: "campaign" | "adset",
  overrides: Partial<ExactConfigReceipt> = {},
): ExactConfigReceipt {
  return {
    key: `${date}::${businessId}::${accountId}::${campaignId}::${adsetId}`,
    entityType,
    rowId: `${entityType}-config-${date}`,
    businessId,
    providerAccountId: accountId,
    entityId: entityType === "campaign" ? campaignId : adsetId,
    campaignId,
    configFingerprint: `${entityType}-fingerprint`,
    objective: entityType === "campaign" ? "OUTCOME_SALES" : null,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    sourceKind: "raw_snapshot",
    sourceSnapshotId: `snapshot-${date}`,
    capturedAt: `${date}T02:20:00.000Z`,
    createdAt: `${date}T02:40:01.000Z`,
    effectiveFrom: date,
    sourceSnapshotBusinessId: businessId,
    sourceSnapshotProviderAccountId: accountId,
    sourceSnapshotFetchedAt: `${date}T02:30:00.000Z`,
    sourceSnapshotCreatedAt: `${date}T02:30:01.000Z`,
    conflictingAtLatestCapture: false,
    ...overrides,
  };
}

function target(date: string): ExactTargetCandidate {
  return {
    businessId,
    rowId: `target-${date}`,
    source: "business_target_pack_history",
    targetRoas: 2.5,
    breakevenRoas: 1.8,
    effectiveAt: `${date}T00:00:00.000Z`,
    recordedAt: `${date}T00:01:00.000Z`,
  };
}

function baseline(
  overrides: Partial<PersistedBaselineRow> = {},
): PersistedBaselineRow {
  return {
    snapshotId: "decision-1",
    businessId,
    providerAccountId: accountId,
    decisionDate: "2026-07-05",
    engineVersion: "v3-historical",
    creativeId: "creative-1",
    label: "keep",
    rawLabel: "keep",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.5,
    ratioToTarget: 1.02,
    badges: [],
    reason: "Persisted output",
    spend: 100,
    purchases: 4,
    roas: 2.55,
    recent7dRoas: 2.4,
    scopeType: "account",
    scopeId: "*",
    labelTransform: null,
    blockedActionType: null,
    decisionInputHash: null,
    lifecycleInputHash: null,
    calibrationInputHash: null,
    lifecycleComputedAt: "2026-07-05T03:04:00.000Z",
    lifecycleSourceMaxUpdatedAt: "2026-07-05T02:30:00.000Z",
    decisionComputedAt: "2026-07-05T03:05:00.000Z",
    ...overrides,
  };
}

describe("exact PIT confirmatory replay", () => {
  it("parses an explicit range and rejects an inverted range", () => {
    expect(
      parseExactPitArgs([
        "--start=2026-06-01",
        "--end=2026-07-05",
        "--cutoffTimeUtc=03:00:00",
      ]),
    ).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-07-05",
      cutoffTimeUtc: "03:00:00",
    });
    expect(() =>
      parseExactPitArgs(["--start=2026-07-05", "--end=2026-06-01"]),
    ).toThrow("start must be on or before end");
  });

  it.each(["campaign", "adset"] as const)(
    "selects every row tied at the latest %s config capture only after config existence checks and joins raw source proof",
    (entityType) => {
      const query = buildExactConfigReceiptQuery(entityType);

      expect(query).toContain("config.created_at <= keys.cutoff");
      expect(query).toContain("latest.created_at <= keys.cutoff");
      expect(query).toContain("SELECT MAX(latest.captured_at)");
      expect(query).toContain("LEFT JOIN meta_raw_snapshots raw_source");
      expect(query).toContain("raw_source.fetched_at AS source_fetched_at");
      expect(query).toContain("raw_source.created_at AS source_created_at");
      expect(query).not.toContain("LIMIT");
    },
  );

  it("does not project a config backfill created after cutoff into exact provenance", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      configReceipts: [
        config(date, "campaign", {
          objective: "OUTCOME_ENGAGEMENT",
          optimizationGoal: "POST_ENGAGEMENT",
          createdAt: `${date}T04:00:00.000Z`,
        }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary).toMatchObject({
      exactManifestRows: 1,
      campaignConfigCoveredRows: 0,
      unsupportedObjectiveResolvedRows: 0,
    });
    expect(report.manifests[0]?.manifest.configProvenance).toEqual([]);
    expect(report.manifests[0]?.branchTerminalCore).toMatchObject({
      status: "not_evaluable",
      branch: null,
    });
  });

  it.each([
    {
      name: "missing source snapshot",
      overrides: {
        sourceSnapshotId: null,
        sourceSnapshotBusinessId: null,
        sourceSnapshotProviderAccountId: null,
        sourceSnapshotFetchedAt: null,
        sourceSnapshotCreatedAt: null,
      },
    },
    {
      name: "source fetched after cutoff",
      overrides: { sourceSnapshotFetchedAt: "2026-07-05T04:00:00.000Z" },
    },
    {
      name: "source fetched after its config receipt",
      overrides: { sourceSnapshotFetchedAt: "2026-07-05T02:50:00.000Z" },
    },
    {
      name: "source created after cutoff",
      overrides: { sourceSnapshotCreatedAt: "2026-07-05T04:00:00.000Z" },
    },
    {
      name: "source created after its config receipt",
      overrides: { sourceSnapshotCreatedAt: "2026-07-05T02:50:00.000Z" },
    },
    {
      name: "source tenant contradiction",
      overrides: { sourceSnapshotBusinessId: "other-business" },
    },
    {
      name: "source outside selected exact generation",
      overrides: { sourceSnapshotId: "unselected-source" },
    },
    {
      name: "conflicting latest capture",
      overrides: { conflictingAtLatestCapture: true },
    },
  ])("fails config exactness closed for $name", ({ overrides }) => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      configReceipts: [
        config(date, "campaign", {
          objective: "OUTCOME_ENGAGEMENT",
          optimizationGoal: "POST_ENGAGEMENT",
          ...overrides,
        }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.campaignConfigCoveredRows).toBe(0);
    expect(report.summary.unsupportedObjectiveResolvedRows).toBe(0);
    expect(report.manifests[0]?.manifest.configProvenance).toEqual([]);
  });

  it("does not fall back to an older config when the latest existing capture lacks exact source proof", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      configReceipts: [
        config(date, "campaign", {
          rowId: "older-valid-config",
          objective: "OUTCOME_ENGAGEMENT",
          optimizationGoal: "POST_ENGAGEMENT",
          capturedAt: `${date}T01:00:00.000Z`,
          createdAt: `${date}T02:40:01.000Z`,
        }),
        config(date, "campaign", {
          rowId: "latest-unproved-config",
          objective: "OUTCOME_ENGAGEMENT",
          optimizationGoal: "POST_ENGAGEMENT",
          capturedAt: `${date}T02:00:00.000Z`,
          createdAt: `${date}T02:41:00.000Z`,
          sourceSnapshotId: "unselected-source",
        }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.campaignConfigCoveredRows).toBe(0);
    expect(report.summary.unsupportedObjectiveResolvedRows).toBe(0);
    expect(report.manifests[0]?.manifest.configProvenance).toEqual([]);
  });

  it("builds only exact_raw_pit manifests and keeps current dimensions/restated rows at zero", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      configReceipts: [config(date, "campaign"), config(date, "adset")],
      targetCandidates: [target(date)],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary).toMatchObject({
      reconstructableScopeDays: 1,
      exactManifestRows: 1,
      rejectedManifestRows: 0,
      branchTerminalCoreEvaluatedRows: 1,
      branchTerminalCoreResolvedRows: 0,
      fullResolverInputEvaluableRows: 0,
      legacyCreativeOutputHashJoinableRows: 0,
      campaignConfigCoveredRows: 1,
      adsetConfigCoveredRows: 1,
      targetCoveredRows: 1,
      creativeIdentityCoveredRows: 0,
    });
    expect(report.sourceBoundary).toMatchObject({
      restatedAdDailyRows: 0,
      currentDimensionRows: 0,
      exactAndRestatedMetricsMerged: false,
      currentDimensionsPromoted: false,
    });
    expect(report.manifests[0]?.manifest.sourceMode).toBe("exact_raw_pit");
    expect(report.manifests[0]?.manifest.identity.creative).toMatchObject({
      value: null,
      required: false,
      source: "meta_raw_snapshots.payload_json",
    });
    expect(report.manifests[0]?.fullResolverMissingFields).not.toContain(
      "identity.creative.exact_at_cutoff",
    );
    expect(report.manifests[0]?.legacyCreativeOutputHashJoin.status).toBe(
      "creative_identity_unavailable",
    );
    expect(report.evaluability.decisionGrain).toBe("ad_id");
    expect(report.hashes.fullResolverInputSetHash).toBeNull();
    expect(report.hashes.fullResolverDecisionSetHash).toBeNull();
    expect(report.manifests[0]?.decisionHash).toBeNull();
  });

  it("resolves a cutoff-safe unsupported objective at branch-terminal core without claiming a full resolver hash", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      configReceipts: [
        config(date, "campaign", {
          objective: "OUTCOME_ENGAGEMENT",
          optimizationGoal: "POST_ENGAGEMENT",
        }),
        config(date, "adset", { optimizationGoal: "POST_ENGAGEMENT" }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary).toMatchObject({
      branchTerminalCoreEvaluatedRows: 1,
      branchTerminalCoreResolvedRows: 1,
      fullResolverInputEvaluableRows: 0,
    });
    expect(report.manifests[0]?.branchTerminalCore).toMatchObject({
      status: "resolved",
      branch: "unsupported_objective",
      objective: "OUTCOME_ENGAGEMENT",
      exactDecisionLabel: "out_of_scope",
      missingFields: [],
    });
    expect(
      report.manifests[0]?.branchTerminalCore.branchTerminalCoreHash,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(report.manifests[0]?.fullResolverMissingFields).toContain(
      "metrics.exact_28d_window",
    );
    expect(report.manifests[0]?.fullResolverMissingFields).not.toContain(
      "identity.creative.exact_at_cutoff",
    );
    expect(report.hashes.branchTerminalCoreDecisionSetHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(report.hashes.fullResolverInputSetHash).toBeNull();
    expect(report.hashes.fullResolverDecisionSetHash).toBeNull();
    expect(report.manifests[0]?.decisionHash).toBeNull();
  });

  it("keeps optional creative grouping and legacy output hashes separate from ad-grain authority", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [
        integrity(date, {
          payloadJson: [
            {
              ad_id: adId,
              adset_id: adsetId,
              campaign_id: campaignId,
              creative_id: "creative-1",
              date_start: date,
              date_stop: date,
              spend: "10.00",
            },
          ],
        }),
      ],
      baselineRows: [baseline()],
      rawEndpointInventory: [
        {
          endpointName: "ad_insights_bulk",
          entityScope: "ad",
          snapshotRows: 1,
          earliestSourceDate: date,
          latestSourceDate: date,
          earliestFetchedAt: `${date}T02:30:00.000Z`,
          latestFetchedAt: `${date}T02:30:00.000Z`,
          requestedFieldSets: [
            "ad_id,adset_id,campaign_id,date_start,date_stop,spend",
          ],
        },
        {
          endpointName: "breakdown_country",
          entityScope: "ad",
          snapshotRows: 2,
          earliestSourceDate: date,
          latestSourceDate: date,
          earliestFetchedAt: `${date}T02:31:00.000Z`,
          latestFetchedAt: `${date}T02:31:00.000Z`,
          requestedFieldSets: ["ad_id,country,spend"],
        },
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.coverage.creativeIdentityCoveragePct).toBe(100);
    expect(report.summary.legacyCreativeOutputHashJoinableRows).toBe(1);
    expect(report.manifests[0]?.legacyCreativeOutputHashJoin).toMatchObject({
      status: "joinable",
      creativeId: "creative-1",
      matchedOutputRows: 1,
      matchCardinality: "one",
      hashKind: "persisted_output_only",
    });
    expect(
      report.manifests[0]?.legacyCreativeOutputHashJoin.persistedOutputSetHash,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(report.manifests[0]?.decisionHash).toBeNull();
    expect(report.evaluability.legacyCreativeOutputHashJoin).toMatchObject({
      grantsAdExecutionAuthority: false,
      hashKind: "persisted_output_only",
    });
    expect(
      report.retainedRawEndpointInventory.endpoints.map(
        (row) => row.endpointName,
      ),
    ).toContain("breakdown_country");
    expect(
      report.retainedRawEndpointInventory.sourceProof.find(
        (proof) => proof.field === "delivery.effective_status_at_cutoff",
      ),
    ).toMatchObject({
      status: "missing",
      requestedByExactMetricEndpoint: false,
    });
  });

  it("skips an incomplete generation instead of falling back to an older or restated source", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [
        integrity(date, { providerCursor: "missing-terminal-page" }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.reconstructableScopeDays).toBe(0);
    expect(report.manifests).toEqual([]);
    expect(report.hashes.exactObservationManifestSetHash).toBeNull();
  });

  it("excludes future campaign status and selects the latest cutoff-safe observation", () => {
    const date = "2026-07-05";
    const selection = buildExactCampaignStatusSelection({
      decisionScopes: [
        { decisionDate: date, businessId, providerAccountId: accountId },
      ],
      rows: [
        campaignStatusSnapshot({
          date,
          id: "status-before-cutoff",
          fetchedAt: `${date}T02:20:00.000Z`,
          payload: [
            {
              id: campaignId,
              effective_status: "ACTIVE",
              status: "ACTIVE",
            },
          ],
        }),
        campaignStatusSnapshot({
          date,
          id: "status-after-cutoff",
          fetchedAt: `${date}T02:40:00.000Z`,
          createdAt: `${date}T03:20:00.000Z`,
          payload: [
            {
              id: campaignId,
              effective_status: "PAUSED",
              status: "PAUSED",
            },
          ],
        }),
      ],
    });

    expect(selection.summary.postCutoffSnapshotRowsExcluded).toBe(1);
    expect(selection.receipts).toHaveLength(1);
    expect(selection.receipts[0]).toMatchObject({
      sourceSnapshotId: "status-before-cutoff",
      normalizedStatus: "ACTIVE",
    });
  });

  it("does not fall back when the latest campaign-status generation is incomplete", () => {
    const date = "2026-07-05";
    const selection = buildExactCampaignStatusSelection({
      decisionScopes: [
        { decisionDate: date, businessId, providerAccountId: accountId },
      ],
      rows: [
        campaignStatusSnapshot({
          date,
          id: "older-complete-status",
          fetchedAt: `${date}T01:20:00.000Z`,
        }),
        campaignStatusSnapshot({
          date,
          id: "latest-failed-status",
          fetchedAt: `${date}T02:20:00.000Z`,
          snapshotStatus: "failed",
          payload: [],
        }),
      ],
    });

    expect(selection.scopes[0]).toMatchObject({
      generationStatus: "fail",
      generationReason: "latest_generation_incomplete",
      selectedSnapshotIds: ["latest-failed-status"],
      receipts: [],
    });
  });

  it("does not revive an older status after the latest capture was superseded before cutoff", () => {
    const date = "2026-07-05";
    const selection = buildExactCampaignStatusSelection({
      decisionScopes: [
        { decisionDate: date, businessId, providerAccountId: accountId },
      ],
      rows: [
        campaignStatusSnapshot({
          date,
          id: "older-status-before-supersede",
          fetchedAt: `${date}T01:20:00.000Z`,
        }),
        campaignStatusSnapshot({
          date,
          id: "latest-already-superseded",
          fetchedAt: `${date}T02:20:00.000Z`,
          snapshotStatus: "superseded",
          updatedAt: `${date}T02:40:00.000Z`,
        }),
      ],
    });

    expect(selection.scopes[0]).toMatchObject({
      generationStatus: "fail",
      generationReason: "latest_generation_incomplete",
      selectedSnapshotIds: ["latest-already-superseded"],
      receipts: [],
    });
  });

  it("fails closed when equally-latest campaign-status generations conflict", () => {
    const date = "2026-07-05";
    const fetchedAt = `${date}T02:20:00.000Z`;
    const selection = buildExactCampaignStatusSelection({
      decisionScopes: [
        { decisionDate: date, businessId, providerAccountId: accountId },
      ],
      rows: [
        campaignStatusSnapshot({
          date,
          id: "status-tie-active",
          fetchedAt,
          payload: [
            {
              id: campaignId,
              effective_status: "ACTIVE",
              status: "ACTIVE",
            },
          ],
        }),
        campaignStatusSnapshot({
          date,
          id: "status-tie-paused",
          fetchedAt,
          payload: [
            {
              id: campaignId,
              effective_status: "PAUSED",
              status: "PAUSED",
            },
          ],
        }),
      ],
    });

    expect(selection.scopes[0]).toMatchObject({
      generationStatus: "fail",
      generationReason: "latest_generation_conflict",
      selectedSnapshotIds: ["status-tie-active", "status-tie-paused"],
      receipts: [],
    });
    expect(selection.summary.statusConflictCount).toBe(2);
  });

  it("normalizes a cutoff-safe hierarchy pause without inventing ad status or a buyer-action label", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [integrity(date)],
      campaignStatusRows: [
        campaignStatusSnapshot({
          date,
          id: "paused-campaign-status",
          fetchedAt: `${date}T02:20:00.000Z`,
          payload: [
            {
              id: campaignId,
              effective_status: "CAMPAIGN_PAUSED",
              status: "PAUSED",
            },
          ],
        }),
      ],
      configReceipts: [config(date, "campaign"), config(date, "adset")],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.coverage.campaignStatus).toMatchObject({
      statusBearingPayloadRows: 1,
      statusBearingScopes: 1,
      mappedAdManifests: 1,
      unmappedAdManifests: 0,
      resolvedPausedBranches: 1,
      statusConflictCount: 0,
    });
    expect(report.manifests[0]?.campaignStatusReceipt).toMatchObject({
      normalizedStatus: "PAUSED",
      statusSourceField: "effective_status",
    });
    expect(report.manifests[0]?.branchTerminalCore).toMatchObject({
      status: "resolved",
      branch: "campaign_paused",
      resolutionKind: "exact_delivery_state_only",
      normalizedCampaignStatus: "PAUSED",
      exactDecisionLabel: null,
    });
    expect(report.manifests[0]?.fullResolverMissingFields).toContain(
      "delivery.ad_effective_status_at_cutoff",
    );
    expect(report.manifests[0]?.fullResolverMissingFields).toContain(
      "delivery.ad_configured_status_at_cutoff",
    );
    expect(report.manifests[0]?.fullResolverMissingFields).not.toContain(
      "delivery.campaign_effective_status_at_cutoff",
    );
    expect(report.manifests[0]?.decisionHash).toBeNull();
  });

  it("fails closed when exact ad hierarchy conflicts even if a paused campaign status exists", () => {
    const date = "2026-07-05";
    const report = buildExactPitConfirmatoryReport({
      integrityReports: [
        integrity(date, {
          payloadJson: [
            {
              ad_id: adId,
              adset_id: adsetId,
              campaign_id: campaignId,
              date_start: date,
              date_stop: date,
              spend: "10.00",
            },
            {
              ad_id: adId,
              adset_id: "adset-2",
              campaign_id: "campaign-2",
              date_start: date,
              date_stop: date,
              spend: "10.00",
            },
          ],
        }),
      ],
      campaignStatusRows: [
        campaignStatusSnapshot({
          date,
          id: "paused-conflicting-hierarchy",
          fetchedAt: `${date}T02:20:00.000Z`,
          payload: [
            {
              id: campaignId,
              effective_status: "PAUSED",
              status: "PAUSED",
            },
          ],
        }),
      ],
      startDate: date,
      endDate: date,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.exactManifestRows).toBe(0);
    expect(report.summary.campaignPausedResolvedRows).toBe(0);
    expect(report.conflicts.rawHierarchyConflictAdIds).toBeGreaterThan(0);
  });

  it("changes the exact input and report hashes when a raw metric changes", () => {
    const date = "2026-07-05";
    const make = (spend: string) =>
      buildExactPitConfirmatoryReport({
        integrityReports: [
          integrity(date, {
            payloadJson: [
              {
                ad_id: adId,
                adset_id: adsetId,
                campaign_id: campaignId,
                date_start: date,
                date_stop: date,
                spend,
              },
            ],
          }),
        ],
        startDate: date,
        endDate: date,
        generatedAt: "2026-07-12T00:00:00.000Z",
      });

    const first = make("10.00");
    const second = make("11.00");
    expect(first.manifests[0]?.observationHash).not.toBe(
      second.manifests[0]?.observationHash,
    );
    expect(first.manifests[0]?.sourceManifestHash).not.toBe(
      second.manifests[0]?.sourceManifestHash,
    );
    expect(first.reportHash).not.toBe(second.reportHash);
  });

  it("hashes campaign-status selection deterministically regardless of input order", () => {
    const dates = ["2026-07-04", "2026-07-05"];
    const rows = dates.map((date) =>
      campaignStatusSnapshot({
        date,
        id: `status-${date}`,
        fetchedAt: `${date}T02:20:00.000Z`,
      }),
    );
    const scopes = dates.map((decisionDate) => ({
      decisionDate,
      businessId,
      providerAccountId: accountId,
    }));
    const first = buildExactCampaignStatusSelection({
      rows,
      decisionScopes: scopes,
    });
    const second = buildExactCampaignStatusSelection({
      rows: [...rows].reverse(),
      decisionScopes: [...scopes].reverse(),
    });

    expect(first.selectionHash).toBe(second.selectionHash);
    expect(first.scopes.map((scope) => scope.receiptHash)).toEqual(
      second.scopes.map((scope) => scope.receiptHash),
    );
  });

  it("opens 3d/7d/14d receipts only after consecutive exact scope generations", () => {
    const dates = [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
    ];
    const sourceRows = new Map(dates.map((date) => [date, snapshot({ date })]));
    const report = buildExactPitConfirmatoryReport({
      integrityReports: dates.map((date) => integrity(date)),
      rollingSourceReceipts: rollingReceiptsFor({
        sourceRows,
        decisionDates: dates,
      }),
      startDate: dates[0] as string,
      endDate: dates.at(-1) as string,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.exactThreeDayScopeWindows).toBe(5);
    expect(report.summary.exactSevenDayScopeWindows).toBe(1);
    expect(report.summary.exactFourteenDayScopeWindows).toBe(0);
    expect(report.summary.exactTwentyEightDayScopeWindows).toBe(0);
    expect(
      report.manifests.filter(
        (row) => row.exactWindowReceipt.sevenDayScopeWindowComplete,
      ),
    ).toHaveLength(1);
    expect(report.manifests.at(-1)?.fullResolverMissingFields).not.toContain(
      "metrics.exact_7d_window",
    );
    expect(report.manifests.at(-1)?.fullResolverMissingFields).toContain(
      "metrics.exact_28d_window",
    );
  });

  it("makes a 28-day exact window available at a later decision cutoff when late source-day generations pass PIT checks", () => {
    const sourceDates = datesBetween("2026-01-01", "2026-01-29");
    const sourceRows = new Map(
      sourceDates.map((sourceDate) => [
        sourceDate,
        snapshot({
          date: sourceDate,
          fetchedAt:
            sourceDate <= "2026-01-27"
              ? "2026-01-29T01:00:00.000Z"
              : `${sourceDate}T02:30:00.000Z`,
        }),
      ]),
    );
    const decisionDates = ["2026-01-28", "2026-01-29"];
    const rollingSourceReceipts = rollingReceiptsFor({
      sourceRows,
      decisionDates,
    });
    const windows = buildRollingCutoffWindowReceipts({
      decisionScopes: decisionDates.map((decisionDate) => ({
        decisionDate,
        businessId,
        providerAccountId: accountId,
      })),
      sourceReceipts: rollingSourceReceipts,
    });
    const repeated = buildRollingCutoffWindowReceipts({
      decisionScopes: [...decisionDates].reverse().map((decisionDate) => ({
        decisionDate,
        businessId,
        providerAccountId: accountId,
      })),
      sourceReceipts: [...rollingSourceReceipts].reverse(),
    });
    const sourceDayAtOwnCutoff = buildRollingCutoffSourceReceipts({
      decisionDate: "2026-01-02",
      integrityReport: integrityAtDecisionCutoff(
        "2026-01-02",
        "2026-01-02",
        sourceRows.get("2026-01-02"),
      ),
    });
    const sameSourceDayAtLaterCutoff = rollingSourceReceipts.find(
      (receipt) =>
        receipt.sourceDate === "2026-01-02" &&
        receipt.decisionDate === "2026-01-29",
    );

    expect(sourceDayAtOwnCutoff[0]?.reconstructable).toBe(false);
    expect(sameSourceDayAtLaterCutoff?.reconstructable).toBe(true);
    expect(windows[0]?.twentyEightDay).toMatchObject({
      status: "incomplete",
      availableSourceDays: 1,
      requiredSourceDays: 28,
    });
    expect(windows[1]?.twentyEightDay).toMatchObject({
      sourceMode: "exact_raw_pit",
      status: "complete",
      availableSourceDays: 28,
      requiredSourceDays: 28,
      missingSourceDates: [],
    });
    expect(windows[1]?.threeDay.status).toBe("complete");
    expect(windows[1]?.sevenDay.status).toBe("complete");
    expect(windows[1]?.fourteenDay.status).toBe("complete");
    expect(windows.map((receipt) => receipt.receiptHash)).toEqual(
      repeated.map((receipt) => receipt.receiptHash),
    );

    const report = buildExactPitConfirmatoryReport({
      integrityReports: decisionDates.map((decisionDate) =>
        integrityAtDecisionCutoff(
          decisionDate,
          decisionDate,
          sourceRows.get(decisionDate),
        ),
      ),
      rollingSourceReceipts,
      startDate: decisionDates[0] as string,
      endDate: decisionDates[1] as string,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(report.summary.exactTwentyEightDayScopeWindows).toBe(1);
    expect(report.summary.exactThreeDayScopeWindows).toBe(1);
    expect(report.summary.exactSevenDayScopeWindows).toBe(1);
    expect(report.summary.exactFourteenDayScopeWindows).toBe(1);
    expect(report.summary.rollingCutoffWindowCountBasis).toBe(
      "ad_insights_bulk_latest_generation_terminal_supersede_identity_conflict_safe",
    );
    expect(report.dailyCoverage).toMatchObject([
      { decisionDate: "2026-01-28", exactTwentyEightDayScopeWindows: 0 },
      { decisionDate: "2026-01-29", exactTwentyEightDayScopeWindows: 1 },
    ]);
    expect(
      report.manifests.find((row) => row.decisionDate === "2026-01-29")
        ?.exactWindowReceipt,
    ).toMatchObject({
      sourceMode: "exact_raw_pit",
      threeDayScopeWindowComplete: true,
      sevenDayScopeWindowComplete: true,
      fourteenDayScopeWindowComplete: true,
      twentyEightDayScopeWindowComplete: true,
    });
  });

  it("hashes persisted outputs deterministically but never calls them replayable inputs", () => {
    const rows = [
      baseline(),
      baseline({
        snapshotId: "decision-2",
        creativeId: "creative-2",
        label: "cut",
        rawLabel: "cut",
      }),
    ];
    const first = summarizePersistedBaseline({
      rows,
      cutoffTimeUtc: "03:00:00",
      currentEngineVersion: "v3-current",
    });
    const second = summarizePersistedBaseline({
      rows: [...rows].reverse(),
      cutoffTimeUtc: "03:00:00",
      currentEngineVersion: "v3-current",
    });

    expect(first.status).toBe("persisted_output_hash_only");
    expect(first.persistedDecisionSetHash).toBe(
      second.persistedDecisionSetHash,
    );
    expect(first.rowsWithCanonicalSerializedInput).toBe(0);
    expect(first.replayableRows).toBe(0);
    expect(first.lifecycleRowsComputedAfterCutoff).toBe(2);
    expect(first.reasons).toContain(
      "canonical_serialized_decision_input_not_persisted",
    );
  });

  it("produces a stable report hash independent of generatedAt", () => {
    const date = "2026-07-05";
    const base = {
      integrityReports: [integrity(date)],
      startDate: date,
      endDate: date,
    };
    const first = buildExactPitConfirmatoryReport({
      ...base,
      generatedAt: "2026-07-12T00:00:00.000Z",
    });
    const second = buildExactPitConfirmatoryReport({
      ...base,
      generatedAt: "2026-07-12T01:00:00.000Z",
    });

    expect(first.reportHash).toBe(second.reportHash);
    expect(first.generatedAt).not.toBe(second.generatedAt);
  });
});
