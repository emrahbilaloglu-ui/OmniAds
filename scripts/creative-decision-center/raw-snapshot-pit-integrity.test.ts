import { describe, expect, it } from "vitest";
import {
  buildPitIntegrityReport,
  normalizePitSnapshotDbRow,
  parsePitIntegrityArgs,
  type PitRawSnapshotRow,
} from "@/scripts/creative-decision-center/raw-snapshot-pit-integrity";

const decisionDate = "2026-07-05";
const cutoff = "2026-07-05T03:00:00.000Z";
const generatedAt = "2026-07-12T00:00:00.000Z";

function snapshot(
  overrides: Partial<PitRawSnapshotRow> & Pick<PitRawSnapshotRow, "id" | "pageIndex">,
): PitRawSnapshotRow {
  const { id, pageIndex, ...rest } = overrides;
  return {
    id,
    businessId: "business-1",
    providerAccountId: "act_1",
    partitionId: "partition-1",
    checkpointId: `checkpoint-${pageIndex}`,
    runId: "run-1",
    endpointName: "ad_insights_bulk",
    entityScope: "ad",
    pageIndex,
    providerCursor: pageIndex === 0 ? "next-page" : null,
    startDate: decisionDate,
    endDate: decisionDate,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    payloadJson: [
      {
        ad_id: `ad-${pageIndex}`,
        adset_id: `adset-${pageIndex}`,
        campaign_id: `campaign-${pageIndex}`,
        ...(pageIndex === 0 ? { spend: "12.50" } : {}),
      },
    ],
    payloadHash: `stored-hash-${pageIndex}`,
    providerHttpStatus: 200,
    status: "fetched",
    fetchedAt: `2026-07-05T02:0${pageIndex}:00.000Z`,
    createdAt: `2026-07-05T02:0${pageIndex}:01.000Z`,
    updatedAt: `2026-07-05T02:0${pageIndex}:01.000Z`,
    ...rest,
  };
}

describe("raw snapshot point-in-time integrity shadow", () => {
  it("preserves PostgreSQL DATE calendar values without a UTC day shift", () => {
    class LocalPgDate extends Date {
      override getFullYear() { return 2026; }
      override getMonth() { return 6; }
      override getDate() { return 5; }
    }
    const pgDate = new LocalPgDate("2026-07-04T21:00:00.000Z");
    const row = normalizePitSnapshotDbRow({
      id: "snapshot-1",
      business_id: "business-1",
      provider_account_id: "act_1",
      partition_id: "partition-1",
      checkpoint_id: "checkpoint-1",
      run_id: "run-1",
      endpoint_name: "ad_insights_bulk",
      entity_scope: "ad",
      page_index: 0,
      provider_cursor: null,
      start_date: pgDate,
      end_date: pgDate,
      account_timezone: "Europe/Istanbul",
      account_currency: "TRY",
      payload_json: [],
      payload_hash: "hash-1",
      provider_http_status: 200,
      status: "fetched",
      fetched_at: "2026-07-05T02:00:00.000Z",
      created_at: "2026-07-05T02:00:01.000Z",
      updated_at: "2026-07-05T02:00:01.000Z",
    });

    expect(row.startDate).toBe(decisionDate);
    expect(row.endDate).toBe(decisionDate);
  });

  it("parses the required date and defaults cutoff to 03:00Z", () => {
    expect(parsePitIntegrityArgs(["--decisionDate=2026-07-05"])).toEqual({
      decisionDate,
      cutoff,
      businessId: null,
      providerAccountId: null,
      jsonOut: null,
    });
    expect(() => parsePitIntegrityArgs([])).toThrow("--decisionDate=YYYY-MM-DD is required");
    expect(() => parsePitIntegrityArgs(["--decisionDate=2026-02-30"])).toThrow(
      "not a valid calendar date",
    );
  });

  it("reconstructs a multi-page generation from its partition-global page origin", () => {
    const report = buildPitIntegrityReport({
      rows: [
        snapshot({ id: "page-5", pageIndex: 5, providerCursor: "next-page" }),
        snapshot({ id: "page-6", pageIndex: 6, providerCursor: null }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.overallStatus).toBe("pass");
    expect(report.reconstructionEligible).toBe(true);
    expect(report.gates).toMatchObject({
      postCutoffRows: { status: "pass", includedRows: 0 },
      generationCompleteness: { status: "pass", completeScopes: 1 },
      conflicts: { status: "pass" },
      identityCoverage: { status: "pass", creativeIdentityStatus: "unknown" },
      manifestHash: { status: "pass", algorithm: "sha256" },
    });
    expect(report.scopes[0]?.selectedGeneration).toMatchObject({
      pageIndices: [5, 6],
      expectedPageIndices: [5, 6],
      terminalPageCount: 1,
      terminalPageIndex: 6,
      structurallyComplete: true,
    });
    expect(report.scopes[0]?.evidence[1]?.payload).not.toHaveProperty("spend");
    expect(report.scopes[0]?.identityCoverage.dimensions).toContainEqual(
      expect.objectContaining({
        field: "creative_id",
        endpointContractProvidesField: false,
        status: "unknown",
      }),
    );
  });

  it("segments repeated terminal polls within one partition and run", () => {
    const repeatedPayload = [
      { ad_id: "ad-repeat", adset_id: "adset-repeat", campaign_id: "campaign-repeat" },
    ];
    const report = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "poll-0",
          pageIndex: 0,
          providerCursor: null,
          payloadJson: repeatedPayload,
          fetchedAt: "2026-07-05T01:00:00.000Z",
          createdAt: "2026-07-05T01:00:01.000Z",
        }),
        snapshot({
          id: "poll-1",
          pageIndex: 1,
          providerCursor: null,
          payloadJson: repeatedPayload,
          fetchedAt: "2026-07-05T02:00:00.000Z",
          createdAt: "2026-07-05T02:00:01.000Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.scopes[0]?.generations).toHaveLength(2);
    expect(report.scopes[0]?.selectedGeneration).toMatchObject({
      pageIndices: [1],
      terminalPageCount: 1,
      structurallyComplete: true,
    });
    expect(report.scopes[0]?.evidence).toHaveLength(1);
    expect(report.gates.conflicts).toMatchObject({
      status: "pass",
      exactDuplicateAdRows: 0,
      conflictingAdIds: 0,
    });
  });

  it("accepts a superseded row only when supersession happened after cutoff", () => {
    const accepted = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "superseded-after",
          pageIndex: 0,
          providerCursor: null,
          status: "superseded",
          updatedAt: "2026-07-05T04:00:00.000Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });
    const rejected = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "superseded-before",
          pageIndex: 0,
          providerCursor: null,
          status: "superseded",
          updatedAt: "2026-07-05T02:30:00.000Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(accepted.gates.generationCompleteness.status).toBe("pass");
    expect(rejected.gates.generationCompleteness.status).toBe("fail");
    expect(rejected.summary.rejectionCounts.status_not_valid_at_cutoff).toBe(1);
  });

  it("excludes a post-cutoff terminal page and fails the incomplete latest generation", () => {
    const report = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "older-complete-poll",
          pageIndex: 0,
          providerCursor: null,
          fetchedAt: "2026-07-05T01:00:00.000Z",
          createdAt: "2026-07-05T01:00:01.000Z",
        }),
        snapshot({
          id: "latest-page-before-cutoff",
          pageIndex: 1,
          providerCursor: "next-page",
          fetchedAt: "2026-07-05T02:30:00.000Z",
          createdAt: "2026-07-05T02:30:01.000Z",
        }),
        snapshot({
          id: "latest-terminal-after-cutoff",
          pageIndex: 2,
          providerCursor: null,
          fetchedAt: "2026-07-05T03:00:00.001Z",
          createdAt: "2026-07-05T03:00:01.000Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.gates.postCutoffRows).toMatchObject({
      status: "pass",
      includedRows: 0,
      observedExcludedRows: 1,
    });
    expect(report.gates.generationCompleteness.status).toBe("fail");
    expect(report.scopes[0]?.generations).toHaveLength(2);
    expect(report.scopes[0]?.selectedGeneration).toMatchObject({
      pageIndices: [1],
      terminalPageCount: 0,
      structurallyComplete: false,
    });
    expect(report.scopes[0]?.generationReason).toBe("latest_generation_incomplete");
    expect(report.reconstructionEligible).toBe(false);
  });

  it("does not hide an incomplete latest generation behind an older complete one", () => {
    const report = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "old-complete",
          pageIndex: 0,
          partitionId: "partition-old",
          runId: "run-old",
          providerCursor: null,
          fetchedAt: "2026-07-05T01:00:00.000Z",
          createdAt: "2026-07-05T01:00:01.000Z",
        }),
        snapshot({
          id: "new-incomplete",
          pageIndex: 0,
          partitionId: "partition-new",
          runId: "run-new",
          providerCursor: "missing-terminal-page",
          fetchedAt: "2026-07-05T02:30:00.000Z",
          createdAt: "2026-07-05T02:30:01.000Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.scopes[0]?.selectedGeneration).toMatchObject({
      partitionId: "partition-new",
      structurallyComplete: false,
    });
    expect(report.scopes[0]?.evidence).toEqual([]);
    expect(report.gates.generationCompleteness.status).toBe("fail");
  });

  it("separates repeated complete page sequences by observation time", () => {
    const report = buildPitIntegrityReport({
      rows: [
        snapshot({
          id: "old-0",
          pageIndex: 0,
          providerCursor: "old-next",
          fetchedAt: "2026-07-05T01:00:00.000Z",
          createdAt: "2026-07-05T01:00:00.100Z",
        }),
        snapshot({
          id: "old-1",
          pageIndex: 1,
          providerCursor: null,
          fetchedAt: "2026-07-05T01:00:01.000Z",
          createdAt: "2026-07-05T01:00:01.100Z",
        }),
        snapshot({
          id: "new-0",
          pageIndex: 0,
          providerCursor: "new-next",
          fetchedAt: "2026-07-05T02:00:00.000Z",
          createdAt: "2026-07-05T02:00:00.100Z",
        }),
        snapshot({
          id: "new-1",
          pageIndex: 1,
          providerCursor: null,
          fetchedAt: "2026-07-05T02:00:01.000Z",
          createdAt: "2026-07-05T02:00:01.100Z",
        }),
      ],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.scopes[0]?.generations).toHaveLength(2);
    expect(report.scopes[0]?.selectedGeneration?.snapshotIds).toEqual([
      "new-0",
      "new-1",
    ]);
  });

  it("keeps broad windows as inventory without letting them poison exact-day selection", () => {
    const exact = snapshot({
      id: "exact-day",
      pageIndex: 0,
      providerCursor: null,
      fetchedAt: "2026-07-05T01:00:00.000Z",
      createdAt: "2026-07-05T01:00:01.000Z",
    });
    const broad = snapshot({
      id: "broad-window",
      pageIndex: 99,
      providerCursor: null,
      startDate: "2026-07-01",
      endDate: decisionDate,
      fetchedAt: "2026-07-05T02:30:00.000Z",
      createdAt: "2026-07-05T02:30:01.000Z",
    });
    const report = buildPitIntegrityReport({
      rows: [exact, broad],
      decisionDate,
      cutoff,
      generatedAt,
    });
    const broadOnly = buildPitIntegrityReport({
      rows: [broad],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.scopes[0]).toMatchObject({
      observedSnapshotRows: 2,
      exactDayAtCutoffSnapshotRows: 1,
      spanningWindowSnapshotRowsObserved: 1,
      generationStatus: "pass",
    });
    expect(report.scopes[0]?.selectedGeneration?.snapshotIds).toEqual(["exact-day"]);
    expect(report.summary.rejectionCounts.source_window_not_single_decision_day).toBe(1);
    expect(broadOnly.gates.generationCompleteness.status).toBe("unknown");
    expect(broadOnly.gates.conflicts.status).toBe("unknown");
    expect(broadOnly.scopes[0]?.generationReason).toBe("no_exact_day_rows_at_cutoff");
    expect(broadOnly.scopes[0]?.selectedGeneration).toBeNull();
  });

  it("treats duplicate pages and conflicting ad hierarchy as non-compensable", () => {
    const initial = snapshot({
      id: "page-0",
      pageIndex: 0,
      providerCursor: "next-page",
      payloadJson: [{ ad_id: "ad-0", adset_id: "adset-0", campaign_id: "campaign-0" }],
    });
    const first = snapshot({
      id: "page-1-a",
      pageIndex: 1,
      providerCursor: "next-page-2",
      payloadJson: [{ ad_id: "ad-1", adset_id: "adset-1", campaign_id: "campaign-1" }],
    });
    const second = snapshot({
      id: "page-1-b",
      pageIndex: 1,
      providerCursor: "next-page-2",
      payloadJson: [{ ad_id: "ad-1", adset_id: "adset-2", campaign_id: "campaign-2" }],
    });
    const terminal = snapshot({
      id: "page-2-terminal",
      pageIndex: 2,
      providerCursor: null,
      payloadJson: [{ ad_id: "ad-2", adset_id: "adset-2", campaign_id: "campaign-2" }],
    });
    const report = buildPitIntegrityReport({
      rows: [initial, first, second, terminal],
      decisionDate,
      cutoff,
      generatedAt,
    });

    expect(report.gates.conflicts).toMatchObject({
      status: "fail",
      conflictingPageIndices: 1,
      conflictingAdIds: 1,
      hierarchyConflictAdIds: 1,
    });
    expect(report.gates.manifestHash.status).toBe("fail");
    expect(report.overallStatus).toBe("fail");
  });

  it("produces the same manifest hash regardless of query row order", () => {
    const rows = [snapshot({ id: "page-0", pageIndex: 0 }), snapshot({ id: "page-1", pageIndex: 1 })];
    const forward = buildPitIntegrityReport({ rows, decisionDate, cutoff, generatedAt });
    const reverse = buildPitIntegrityReport({ rows: [...rows].reverse(), decisionDate, cutoff, generatedAt });

    expect(forward.gates.manifestHash.value).toMatch(/^[a-f0-9]{64}$/);
    expect(reverse.gates.manifestHash.value).toBe(forward.gates.manifestHash.value);
  });
});
