import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MetaAdDuplicateReconciliationCandidate,
} from "@/lib/meta/duplicate-ad-reconciliation-store";
import type {
  MetaAdDuplicateProviderScan,
} from "@/lib/meta/ads-write";

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));
vi.mock("@/lib/meta/duplicate-ad-reconciliation-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/meta/duplicate-ad-reconciliation-store")
    >();
  return {
    ...actual,
    finalizeMetaAdDuplicatePreProviderFailure: vi.fn(),
    listMetaAdDuplicateReconciliationCandidates: vi.fn(),
    recordMetaAdDuplicateReconciliationObservation: vi.fn(),
    reconcileMetaAdDuplicateAttempt: vi.fn(),
  };
});
vi.mock("@/lib/meta/ads-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/ads-write")>();
  return {
    ...actual,
    readMetaAdDuplicateProviderObservation: vi.fn(),
    scanMetaAdDuplicatesByMarker: vi.fn(),
  };
});

const integrations = await import("@/lib/integrations");
const store = await import("@/lib/meta/duplicate-ad-reconciliation-store");
const adsWrite = await import("@/lib/meta/ads-write");
const {
  reconcileMetaAdDuplicateCandidate,
  runMetaAdDuplicateReconciliationSweep,
} = await import("@/lib/meta/duplicate-ad-reconciliation");

const OBSERVED_AT = "2026-07-19T06:06:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CURSOR_2_HASH =
  "ead520580075b05acea717e42e35fd879348356c2c10ee29cf7bff78c4bb1e9b";
const CURSOR_3_HASH =
  "f1b34292393070cea65f3eb92732a17de8711320106218e4ee5f3beb7f15eee6";
const CURSOR_4_HASH =
  "34d305adaa999ee5a6b7d0a9e16141df3abbf2759d0233259b3527aa00adcca2";
const CURSOR_FINAL_HASH =
  "a156b2cab4c8ce9c89278f6bc3b731328663e4319be959409df6080c6b9b1a6c";

function candidate(
  overrides: Partial<MetaAdDuplicateReconciliationCandidate> = {},
): MetaAdDuplicateReconciliationCandidate {
  return {
    sourceActionLogId: "11111111-1111-4111-8111-111111111111",
    businessId: "22222222-2222-4222-8222-222222222222",
    providerAccountRefId: "33333333-3333-4333-8333-333333333333",
    providerAccountId: "act_123",
    sourceAdId: "source_ad_1",
    sourceCreativeId: "creative_1",
    targetAdsetId: "adset_2",
    marker: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonicalAdName:
      "Copy [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
    requestedStatus: "PAUSED",
    resultingAdId: null,
    status: "pending",
    attemptId: "44444444-4444-4444-8444-444444444444",
    authorityKind: "completed_attempt",
    settlementNotBefore: "2026-07-19T06:00:00.000Z",
    readyForProviderRead: true,
    scanContinuation: null,
    ...overrides,
  };
}

function observation(id = "ad_copy_1") {
  return {
    id,
    name:
      "Copy [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
    providerAccountId: "act_123",
    status: "PAUSED",
    effectiveStatus: "PAUSED",
    targetAdsetId: "adset_2",
    creativeId: "creative_1",
    observedAt: OBSERVED_AT,
    providerGetEvidence: {
      id,
      name:
        "Copy [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
      account_id: "123",
      status: "PAUSED",
      effective_status: "PAUSED",
      adset_id: "adset_2",
      creative: { id: "creative_1" },
    },
  };
}

function scan(
  overrides: Partial<MetaAdDuplicateProviderScan> = {},
): MetaAdDuplicateProviderScan {
  return {
    complete: true,
    blocker: null,
    pageCount: 1,
    observationCount: 0,
    exactMatches: [],
    exactMatchIds: [],
    segmentStartAfterCursor: null,
    segmentStartCursorHash: null,
    segmentEndAfterCursor: null,
    segmentEndCursorHash: null,
    visitedCursorHashes: [HASH_A],
    observedAt: OBSERVED_AT,
    evidence: {
      contractVersion: "meta-ad-duplicate-provider-scan.v1",
      providerAccountId: "123",
      marker: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canonicalAdName:
        "Copy [ADSECUTE_DUP:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]",
      targetAdsetId: "adset_2",
      creativeId: "creative_1",
      requestedStatus: "PAUSED",
      complete: true,
      blocker: null,
      pageCount: 1,
      observationCount: 0,
      exactMatchIds: [],
      segmentStartCursorHash: null,
      segmentEndCursorHash: null,
      observedAt: OBSERVED_AT,
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("duplicate-ad GET-only reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "secret",
    } as never);
    vi.mocked(
      store.finalizeMetaAdDuplicatePreProviderFailure,
    ).mockResolvedValue();
    vi.mocked(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      attemptOrdinal: 1,
      nextAttemptNotBefore: "2026-07-19T06:16:00.000Z",
    });
    vi.mocked(store.reconcileMetaAdDuplicateAttempt).mockResolvedValue();
  });

  it("reconciles an already-known resulting id with one exact point GET", async () => {
    vi.mocked(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).mockResolvedValue({ ok: true, observation: observation() });

    const result = await reconcileMetaAdDuplicateCandidate(
      candidate({ resultingAdId: "ad_copy_1" }),
    );

    expect(result).toMatchObject({
      disposition: "reconciled_match",
      resultingAdId: "ad_copy_1",
    });
    expect(adsWrite.scanMetaAdDuplicatesByMarker).not.toHaveBeenCalled();
    expect(store.reconcileMetaAdDuplicateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "exact_provider_match",
        resultingAdId: "ad_copy_1",
        scanComplete: true,
        scannedPageCount: 0,
        observationCount: 1,
        exactMatchCount: 1,
      }),
    );
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).not.toHaveBeenCalled();
  });

  it("terminalizes an expired prepared claim without credentials or provider reads", async () => {
    const expired = candidate({
      authorityKind: "expired_prepared",
      resultingAdId: null,
    });

    await expect(
      reconcileMetaAdDuplicateCandidate(expired),
    ).resolves.toMatchObject({
      disposition: "reconciled_no_provider_attempt",
      resultingAdId: null,
      blocker: null,
    });

    expect(
      store.finalizeMetaAdDuplicatePreProviderFailure,
    ).toHaveBeenCalledWith({
      sourceActionLogId: expired.sourceActionLogId,
      errorCode: "duplicate_prepared_lease_expired_without_start",
      errorMessage: expect.stringContaining("no provider POST was authorized"),
      durationMs: 0,
    });
    expect(integrations.getIntegration).not.toHaveBeenCalled();
    expect(adsWrite.scanMetaAdDuplicatesByMarker).not.toHaveBeenCalled();
    expect(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).not.toHaveBeenCalled();
    expect(store.reconcileMetaAdDuplicateAttempt).not.toHaveBeenCalled();
  });

  it("keeps a complete zero-match scan quarantined instead of releasing a started claim", async () => {
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker).mockResolvedValue(
      scan({
        pageCount: 3,
        observationCount: 201,
        visitedCursorHashes: [HASH_A, HASH_B],
        evidence: {
          ...scan().evidence,
          pageCount: 3,
          observationCount: 201,
          visitedCursorHashes: [HASH_A, HASH_B],
        },
      }),
    );

    const result = await reconcileMetaAdDuplicateCandidate(candidate());

    expect(result).toEqual({
      sourceActionLogId: candidate().sourceActionLogId,
      disposition: "absence_observed_quarantined",
      resultingAdId: null,
      blocker: "provider_absence_is_not_final",
    });
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "complete_scan_absence",
        scanComplete: true,
        scannedPageCount: 3,
        observationCount: 201,
        exactMatchCount: 0,
        scanCheckpoint: expect.objectContaining({
          segmentIndex: 0,
          segmentStartAfterCursor: null,
          segmentEndAfterCursor: null,
          cycleComplete: true,
          cumulativePageCount: 3,
          cumulativeObservationCount: 201,
          cumulativeExactMatchIds: [],
        }),
      }),
    );
    expect(store.reconcileMetaAdDuplicateAttempt).not.toHaveBeenCalled();
    expect(
      store.finalizeMetaAdDuplicatePreProviderFailure,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "incomplete",
      providerScan: scan({
        complete: false,
        blocker: "provider_read_unavailable",
        pageCount: 0,
        visitedCursorHashes: [],
        evidence: {
          ...scan().evidence,
          complete: false,
          blocker: "provider_read_unavailable",
          pageCount: 0,
        },
      }),
      expectedDisposition: "quarantined_incomplete",
      persistedDisposition: "provider_read_incomplete",
    },
    {
      label: "multiple",
      providerScan: scan({
        pageCount: 2,
        observationCount: 150,
        exactMatches: [observation(), observation("ad_copy_2")],
        exactMatchIds: ["ad_copy_1", "ad_copy_2"],
        evidence: {
          ...scan().evidence,
          pageCount: 2,
          observationCount: 150,
          exactMatchIds: ["ad_copy_1", "ad_copy_2"],
        },
      }),
      expectedDisposition: "quarantined_multiple",
      persistedDisposition: "multiple_exact_provider_matches",
    },
    {
      label: "drift",
      providerScan: scan({
        complete: false,
        blocker: "provider_identity_drift",
        observationCount: 1,
        evidence: {
          ...scan().evidence,
          complete: false,
          blocker: "provider_identity_drift",
          observationCount: 1,
        },
      }),
      expectedDisposition: "quarantined_drift",
      persistedDisposition: "provider_identity_drift",
    },
  ] as const)(
    "persists $label evidence and keeps the claim unresolved",
    async ({
      providerScan,
      expectedDisposition,
      persistedDisposition,
    }) => {
      vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker).mockResolvedValue(
        providerScan,
      );

      await expect(
        reconcileMetaAdDuplicateCandidate(candidate()),
      ).resolves.toMatchObject({ disposition: expectedDisposition });
      expect(
        store.recordMetaAdDuplicateReconciliationObservation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          disposition: persistedDisposition,
          scanCheckpoint: expect.any(Object),
        }),
      );
      expect(store.reconcileMetaAdDuplicateAttempt).not.toHaveBeenCalled();
    },
  );

  it("persists bounded segment progress with cumulative unique match ids", async () => {
    const continuation = {
      cycleId: "66666666-6666-4666-8666-666666666666",
      segmentIndex: 3,
      afterCursor: "cursor_3",
      visitedCursorHashes: [HASH_A],
      cumulativePageCount: 100,
      cumulativeObservationCount: 9_000,
      cumulativeExactMatchIds: ["ad_copy_1"],
    };
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker).mockResolvedValue(
      scan({
        complete: false,
        blocker: "pagination_segment_limit",
        pageCount: 150,
        observationCount: 12_000,
        exactMatchIds: ["ad_copy_1"],
        segmentStartAfterCursor: "cursor_3",
        segmentStartCursorHash: CURSOR_3_HASH,
        segmentEndAfterCursor: "cursor_4",
        segmentEndCursorHash: CURSOR_4_HASH,
        visitedCursorHashes: [HASH_A, HASH_B],
        evidence: {
          ...scan().evidence,
          complete: false,
          blocker: "pagination_segment_limit",
          pageCount: 150,
          observationCount: 12_000,
          exactMatchIds: ["ad_copy_1"],
          segmentStartCursorHash: CURSOR_3_HASH,
          segmentEndCursorHash: CURSOR_4_HASH,
        },
      }),
    );

    await expect(
      reconcileMetaAdDuplicateCandidate(candidate({
        scanContinuation: continuation,
      })),
    ).resolves.toMatchObject({
      disposition: "quarantined_incomplete",
      blocker: "pagination_segment_limit",
    });

    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        afterCursor: "cursor_3",
        visitedCursorHashes: [HASH_A],
        cumulativePageCount: 100,
        cumulativeObservationCount: 9_000,
        cumulativeExactMatchIds: ["ad_copy_1"],
      }),
    );
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "scan_segment_progress",
        exactMatchCount: 1,
        scanCheckpoint: {
          cycleId: continuation.cycleId,
          segmentIndex: 3,
          segmentStartAfterCursor: "cursor_3",
          segmentStartCursorHash: CURSOR_3_HASH,
          segmentEndAfterCursor: "cursor_4",
          segmentEndCursorHash: CURSOR_4_HASH,
          cycleComplete: false,
          visitedCursorHashes: [HASH_A, HASH_B],
          cumulativePageCount: 150,
          cumulativeObservationCount: 12_000,
          cumulativeExactMatchIds: ["ad_copy_1"],
        },
      }),
    );
  });

  it("resumes the same failed-page cursor on the next wave without refetching earlier pages", async () => {
    const cycleId = "77777777-7777-4777-8777-777777777777";
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker)
      .mockResolvedValueOnce(
        scan({
          complete: false,
          blocker: "provider_read_unavailable",
          pageCount: 1,
          observationCount: 100,
          segmentStartAfterCursor: "cursor_2",
          segmentStartCursorHash: CURSOR_2_HASH,
          segmentEndAfterCursor: "cursor_2",
          segmentEndCursorHash: CURSOR_2_HASH,
          visitedCursorHashes: [HASH_A],
          evidence: {
            ...scan().evidence,
            complete: false,
            blocker: "provider_read_unavailable",
            pageCount: 1,
            observationCount: 100,
            segmentStartCursorHash: CURSOR_2_HASH,
            segmentEndCursorHash: CURSOR_2_HASH,
          },
        }),
      )
      .mockResolvedValueOnce(
        scan({
          pageCount: 2,
          observationCount: 101,
          segmentStartAfterCursor: "cursor_2",
          segmentStartCursorHash: CURSOR_2_HASH,
          segmentEndAfterCursor: null,
          segmentEndCursorHash: null,
          visitedCursorHashes: [HASH_A, HASH_B],
          evidence: {
            ...scan().evidence,
            pageCount: 2,
            observationCount: 101,
            segmentStartCursorHash: CURSOR_2_HASH,
            segmentEndCursorHash: null,
            visitedCursorHashes: [HASH_A, HASH_B],
          },
        }),
      );

    await reconcileMetaAdDuplicateCandidate(candidate({
      scanContinuation: {
        cycleId,
        segmentIndex: 1,
        afterCursor: "cursor_2",
        visitedCursorHashes: [HASH_A],
        cumulativePageCount: 1,
        cumulativeObservationCount: 100,
        cumulativeExactMatchIds: [],
      },
    }));
    await reconcileMetaAdDuplicateCandidate(candidate({
      scanContinuation: {
        cycleId,
        segmentIndex: 2,
        afterCursor: "cursor_2",
        visitedCursorHashes: [HASH_A],
        cumulativePageCount: 1,
        cumulativeObservationCount: 100,
        cumulativeExactMatchIds: [],
      },
    }));

    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(
      adsWrite.scanMetaAdDuplicatesByMarker,
    ).mock.calls) {
      expect(input).toMatchObject({
        afterCursor: "cursor_2",
        visitedCursorHashes: [HASH_A],
        cumulativePageCount: 1,
        cumulativeObservationCount: 100,
      });
    }
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        disposition: "provider_read_incomplete",
        scanCheckpoint: expect.objectContaining({
          segmentIndex: 1,
          segmentStartAfterCursor: "cursor_2",
          segmentStartCursorHash: CURSOR_2_HASH,
          segmentEndAfterCursor: "cursor_2",
          segmentEndCursorHash: CURSOR_2_HASH,
        }),
      }),
    );
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        disposition: "complete_scan_absence",
        scanCheckpoint: expect.objectContaining({
          segmentIndex: 2,
          segmentStartAfterCursor: "cursor_2",
          segmentStartCursorHash: CURSOR_2_HASH,
          segmentEndAfterCursor: null,
          segmentEndCursorHash: null,
          cycleComplete: true,
        }),
      }),
    );
  });

  it("carries a prior-wave unique match through scan completion and confirms it by point GET", async () => {
    const continuation = {
      cycleId: "88888888-8888-4888-8888-888888888888",
      segmentIndex: 2,
      afterCursor: "cursor_final",
      visitedCursorHashes: [HASH_A],
      cumulativePageCount: 250,
      cumulativeObservationCount: 25_000,
      cumulativeExactMatchIds: ["ad_copy_1"],
    };
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker).mockResolvedValue(
      scan({
        pageCount: 251,
        observationCount: 25_001,
        exactMatches: [],
        exactMatchIds: ["ad_copy_1"],
        segmentStartAfterCursor: "cursor_final",
        segmentStartCursorHash: CURSOR_FINAL_HASH,
        visitedCursorHashes: [HASH_A, HASH_B],
        evidence: {
          ...scan().evidence,
          pageCount: 251,
          observationCount: 25_001,
          exactMatchIds: ["ad_copy_1"],
          segmentStartCursorHash: CURSOR_FINAL_HASH,
          segmentEndCursorHash: null,
        },
      }),
    );
    vi.mocked(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).mockResolvedValue({ ok: true, observation: observation() });

    await expect(
      reconcileMetaAdDuplicateCandidate(candidate({
        scanContinuation: continuation,
      })),
    ).resolves.toMatchObject({
      disposition: "reconciled_match",
      resultingAdId: "ad_copy_1",
    });

    expect(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ adId: "ad_copy_1" }),
    );
    expect(store.reconcileMetaAdDuplicateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "exact_provider_match",
        resultingAdId: "ad_copy_1",
        scannedPageCount: 251,
        observationCount: 25_001,
        exactMatchCount: 1,
        scanEvidence: expect.objectContaining({
          exactMatchIds: ["ad_copy_1"],
          scanCheckpoint: expect.objectContaining({
            cycleId: continuation.cycleId,
            segmentIndex: 2,
            cumulativeExactMatchIds: ["ad_copy_1"],
            cycleComplete: true,
          }),
        }),
      }),
    );
  });

  it("durably carries an exact scan match across deadline exhaustion, then point-verifies it without starving the next candidate", async () => {
    const first = candidate();
    const firstWithDurableMatch = candidate({
      resultingAdId: "ad_copy_1",
    });
    const second = candidate({
      sourceActionLogId: "99999999-9999-4999-8999-999999999999",
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      marker: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      canonicalAdName:
        "Copy [ADSECUTE_DUP:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb]",
    });
    vi.mocked(
      store.listMetaAdDuplicateReconciliationCandidates,
    )
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([firstWithDurableMatch, second]);
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker)
      .mockResolvedValueOnce(
        scan({
          pageCount: 2,
          observationCount: 101,
          exactMatches: [observation()],
          exactMatchIds: ["ad_copy_1"],
          visitedCursorHashes: [HASH_A, HASH_B],
          evidence: {
            ...scan().evidence,
            pageCount: 2,
            observationCount: 101,
            exactMatchIds: ["ad_copy_1"],
            visitedCursorHashes: [HASH_A, HASH_B],
          },
        }),
      )
      .mockResolvedValueOnce(
        scan({
          visitedCursorHashes: [HASH_A],
          evidence: {
            ...scan().evidence,
            marker: second.marker,
            canonicalAdName: second.canonicalAdName,
          },
        }),
      );
    vi.mocked(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).mockResolvedValue({
      ok: true,
      observation: observation(),
    });
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    const firstWave = await runMetaAdDuplicateReconciliationSweep({
      limit: 2,
      maxDurationMs: 1_000,
    });

    expect(firstWave).toMatchObject({
      scanned: 2,
      attempted: 1,
      reconciled: 0,
      deadlineExhausted: true,
      results: [
        {
          sourceActionLogId: first.sourceActionLogId,
          disposition: "quarantined_incomplete",
          resultingAdId: "ad_copy_1",
          blocker: "provider_deadline_exhausted",
        },
      ],
    });
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(1);
    expect(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).not.toHaveBeenCalled();
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: first,
        observationMethod: "account_ads_scan",
        disposition: "point_verification_pending",
        resultingAdId: "ad_copy_1",
        scanComplete: true,
        scannedPageCount: 2,
        observationCount: 101,
        exactMatchCount: 1,
        observationEvidence: expect.objectContaining({
          exactMatchIds: ["ad_copy_1"],
          pointVerificationBlocker: "provider_deadline_exhausted",
        }),
        scanCheckpoint: expect.objectContaining({
          segmentIndex: 0,
          segmentStartAfterCursor: null,
          segmentStartCursorHash: null,
          segmentEndAfterCursor: null,
          segmentEndCursorHash: null,
          cycleComplete: true,
          visitedCursorHashes: [HASH_A, HASH_B],
          cumulativePageCount: 2,
          cumulativeObservationCount: 101,
          cumulativeExactMatchIds: ["ad_copy_1"],
        }),
      }),
    );

    nowSpy.mockReset();
    nowSpy.mockReturnValue(3_000);
    const secondWave = await runMetaAdDuplicateReconciliationSweep({
      limit: 2,
      maxDurationMs: 25_000,
    });

    expect(secondWave).toMatchObject({
      scanned: 2,
      attempted: 2,
      reconciled: 1,
      deadlineExhausted: false,
      results: [
        {
          sourceActionLogId: first.sourceActionLogId,
          disposition: "reconciled_match",
          resultingAdId: "ad_copy_1",
        },
        {
          sourceActionLogId: second.sourceActionLogId,
          disposition: "absence_observed_quarantined",
        },
      ],
    });
    expect(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).toHaveBeenCalledTimes(1);
    expect(
      adsWrite.readMetaAdDuplicateProviderObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: "ad_copy_1",
        target: expect.objectContaining({ marker: first.marker }),
      }),
    );
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(2);
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: expect.objectContaining({ marker: second.marker }),
      }),
    );
    expect(store.reconcileMetaAdDuplicateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: firstWithDurableMatch,
        resolution: "exact_provider_match",
        resultingAdId: "ad_copy_1",
      }),
    );
  });

  it("preserves candidate order, runs provider reads sequentially, and leaves no background read", async () => {
    const first = candidate();
    const second = candidate({
      sourceActionLogId: "99999999-9999-4999-8999-999999999999",
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    vi.mocked(
      store.listMetaAdDuplicateReconciliationCandidates,
    ).mockResolvedValue([first, second]);
    const firstRead = deferred<MetaAdDuplicateProviderScan>();
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker)
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(scan());

    const sweepPromise = runMetaAdDuplicateReconciliationSweep({ limit: 2 });
    await vi.waitFor(() => {
      expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(1);
    });
    expect(sweepPromise).toBeInstanceOf(Promise);
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(1);

    firstRead.resolve(scan());
    const result = await sweepPromise;

    expect(result).toMatchObject({
      scanned: 2,
      attempted: 2,
      reconciled: 0,
      deadlineExhausted: false,
      results: [
        { sourceActionLogId: first.sourceActionLogId },
        { sourceActionLogId: second.sourceActionLogId },
      ],
    });
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(2);
  });

  it("enforces one 25-second sweep deadline and does not start a later candidate after exhaustion", async () => {
    vi.mocked(
      store.listMetaAdDuplicateReconciliationCandidates,
    ).mockResolvedValue([
      candidate(),
      candidate({
        sourceActionLogId: "99999999-9999-4999-8999-999999999999",
        attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ]);
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker).mockResolvedValue(scan());
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(26_001);

    const result = await runMetaAdDuplicateReconciliationSweep({
      limit: 2,
      maxDurationMs: 25_000,
    });

    expect(result).toMatchObject({
      scanned: 2,
      attempted: 1,
      reconciled: 0,
      deadlineExhausted: true,
    });
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledTimes(1);
    expect(adsWrite.scanMetaAdDuplicatesByMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        maxDurationMs: 25_000,
      }),
    );
  });

  it("isolates one unexpected candidate failure and continues the sweep", async () => {
    vi.mocked(
      store.listMetaAdDuplicateReconciliationCandidates,
    ).mockResolvedValue([
      candidate(),
      candidate({
        sourceActionLogId: "99999999-9999-4999-8999-999999999999",
        attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ]);
    vi.mocked(adsWrite.scanMetaAdDuplicatesByMarker)
      .mockRejectedValueOnce(new Error("unexpected adapter exception"))
      .mockResolvedValueOnce(scan());

    const result = await runMetaAdDuplicateReconciliationSweep({ limit: 2 });

    expect(result).toMatchObject({
      scanned: 2,
      attempted: 2,
      reconciled: 0,
      deadlineExhausted: false,
      results: [
        {
          disposition: "quarantined_incomplete",
          blocker: "unexpected_reconciliation_error",
        },
        {
          disposition: "absence_observed_quarantined",
          blocker: "provider_absence_is_not_final",
        },
      ],
    });
    expect(
      store.recordMetaAdDuplicateReconciliationObservation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observationMethod: "internal",
        disposition: "unexpected_reconciliation_error",
      }),
    );
  });
});
