export interface MetaRawSnapshotRestorePage {
  id: string;
  page_index: number | null;
  payload_json: unknown;
  provider_cursor: string | null;
  provider_http_status: number | null;
  status: string;
  fetched_at: string | null;
}

export interface MetaRawSnapshotRestoreCheckpoint {
  phase: "fetch_raw" | "transform" | "bulk_upsert" | "finalize";
  pageIndex: number;
  nextPageUrl?: string | null;
  providerCursor?: string | null;
  rowsFetched?: number;
}

export class MetaRawSnapshotRestoreError extends Error {
  constructor(
    public readonly code:
      | "latest_generation_invalid"
      | "orphan_raw_generation"
      | "checkpoint_raw_mismatch",
    detail: string,
  ) {
    super(`Meta raw restore blocked (${code}): ${detail}`);
    this.name = "MetaRawSnapshotRestoreError";
  }
}

function timestampMs(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareObserved(
  left: MetaRawSnapshotRestorePage,
  right: MetaRawSnapshotRestorePage,
) {
  return (
    timestampMs(left.fetched_at) - timestampMs(right.fetched_at) ||
    left.id.localeCompare(right.id)
  );
}

function splitFetchGenerations(rows: readonly MetaRawSnapshotRestorePage[]) {
  const generations: MetaRawSnapshotRestorePage[][] = [];
  let current: MetaRawSnapshotRestorePage[] = [];

  for (const row of [...rows].sort(compareObserved)) {
    const currentPage = row.page_index;
    const startsNewGeneration =
      current.length > 0 && currentPage === 0;

    if (startsNewGeneration) {
      generations.push(current);
      current = [];
    }

    current.push(row);
    if (row.provider_cursor === null) {
      generations.push(current);
      current = [];
    }
  }

  if (current.length > 0) generations.push(current);
  return generations;
}

function payloadRowCount(page: MetaRawSnapshotRestorePage) {
  return Array.isArray(page.payload_json) ? page.payload_json.length : null;
}

function validateGeneration(pages: readonly MetaRawSnapshotRestorePage[]) {
  const failures: string[] = [];
  const indices = pages.map((page) => page.page_index);
  const firstPageIndex = pages[0]?.page_index ?? null;

  pages.forEach((page, offset) => {
    if (page.status !== "fetched") failures.push(`status:${page.id}:${page.status}`);
    if (
      page.page_index === null ||
      !Number.isInteger(page.page_index) ||
      page.page_index < 0
    ) {
      failures.push(`page_index_invalid:${page.id}`);
    }
    if (!Number.isFinite(Date.parse(page.fetched_at ?? ""))) {
      failures.push(`fetched_at_invalid:${page.id}`);
    }
    if (
      page.provider_http_status === null ||
      page.provider_http_status < 200 ||
      page.provider_http_status >= 300
    ) {
      failures.push(`http_status:${page.id}:${page.provider_http_status ?? "missing"}`);
    }
    if (!Array.isArray(page.payload_json)) failures.push(`payload_not_array:${page.id}`);
    const expectedPageIndex =
      firstPageIndex === null ? null : firstPageIndex + offset;
    if (page.page_index !== expectedPageIndex) {
      failures.push(
        `page_sequence:${page.id}:${page.page_index ?? "missing"}:expected_${expectedPageIndex ?? "known_origin"}`,
      );
    }
    if (offset < pages.length - 1 && page.provider_cursor === null) {
      failures.push(`early_terminal_page:${page.id}`);
    }
  });

  if (new Set(indices).size !== indices.length) failures.push("duplicate_page_index");
  return failures;
}

/**
 * Selects only the latest observed fetch generation. An incomplete latest
 * generation is intentionally retained for checkpoint resume; callers must
 * never fall back to an older complete generation.
 */
export function selectLatestMetaRawSnapshotGeneration<
  TPage extends MetaRawSnapshotRestorePage,
>(rows: readonly TPage[]): TPage[] {
  if (rows.length === 0) return [];
  const generations = splitFetchGenerations(rows);
  const latest = (generations.at(-1) ?? []) as TPage[];
  const failures = validateGeneration(latest);
  if (failures.length > 0) {
    throw new MetaRawSnapshotRestoreError(
      "latest_generation_invalid",
      failures.join(", "),
    );
  }
  return latest;
}

/** Verifies that the selected raw generation and checkpoint describe one run. */
export function resolveMetaRawSnapshotResumeState<
  TPage extends MetaRawSnapshotRestorePage,
>(input: {
  pages: readonly TPage[];
  checkpoint: MetaRawSnapshotRestoreCheckpoint | null;
}) {
  const pages = [...input.pages];
  const checkpoint = input.checkpoint;
  const payloadRows = pages.reduce((sum, page) => sum + (payloadRowCount(page) ?? 0), 0);
  const last = pages.at(-1) ?? null;

  if (!checkpoint) {
    if (pages.length > 0) {
      throw new MetaRawSnapshotRestoreError(
        "orphan_raw_generation",
        "raw pages exist without their checkpoint",
      );
    }
    return {
      pages,
      nextPageIndex: 0,
      resumeCursor: null,
      rewoundToDurableFrontier: false,
    };
  }

  if (pages.length === 0) {
    if ((checkpoint.rowsFetched ?? 0) > 0) {
      throw new MetaRawSnapshotRestoreError(
        "checkpoint_raw_mismatch",
        `checkpoint records ${checkpoint.rowsFetched} rows but no raw page is durable`,
      );
    }
    return {
      pages,
      nextPageIndex: 0,
      resumeCursor: null,
      rewoundToDurableFrontier: false,
    };
  }

  const lastPageIndex = last?.page_index;
  const durableFrontier = (lastPageIndex ?? -1) + 1;

  // A checkpoint exactly one page ahead of the durable raw generation is not
  // corruption — it is the expected crash state, and it must heal itself.
  //
  // The fetch loop writes the checkpoint for page N BEFORE it writes raw page
  // N (`upsertOwnedMetaCheckpointOrThrow` then `recordMetaRawSnapshot`). Any
  // interruption between those two writes durably leaves checkpoint = N and
  // raw pages = [0..N-1]. The validator below demanded checkpoint.pageIndex
  // === lastPageIndex for a `fetch_raw` checkpoint, so it read that ordinary
  // window as fatal and threw on every subsequent resume, forever: the
  // checkpoint was never rewound, so each retry rebuilt the same verdict.
  //
  // Measured in production 2026-08-06: `page_index checkpoint=1 raw=0` on
  // Halıcızade (133 runs), Bilsem Zeka (83) and EMOLOS (64) — 280 failed runs
  // in seven days on three businesses, one signature, none of it recoverable
  // without a human.
  //
  // The durable raw pages are the truth and the checkpoint is the claim, so
  // the claim yields: resume AT the frontier and re-fetch the page that never
  // landed. Re-fetching is idempotent; trusting the checkpoint's own cursor
  // here would not be, because that cursor points one page PAST the gap and
  // would skip the missing page's rows silently. That is why this rewinds to
  // the last durable page's cursor rather than simply widening the check.
  if (checkpoint.phase === "fetch_raw" && checkpoint.pageIndex === durableFrontier) {
    return {
      pages,
      nextPageIndex: durableFrontier,
      resumeCursor: last?.provider_cursor ?? null,
      rewoundToDurableFrontier: true,
    };
  }

  const expectedCheckpointPage =
    checkpoint.phase === "fetch_raw" ? lastPageIndex : durableFrontier;
  const mismatches: string[] = [];

  if (checkpoint.pageIndex !== expectedCheckpointPage) {
    mismatches.push(
      `page_index checkpoint=${checkpoint.pageIndex} raw=${expectedCheckpointPage ?? "missing"}`,
    );
  }
  if ((checkpoint.rowsFetched ?? 0) !== payloadRows) {
    mismatches.push(
      `rows_fetched checkpoint=${checkpoint.rowsFetched ?? 0} raw=${payloadRows}`,
    );
  }
  if (checkpoint.phase === "fetch_raw") {
    if ((checkpoint.providerCursor ?? null) !== (last?.provider_cursor ?? null)) {
      mismatches.push("provider_cursor differs");
    }
    if ((checkpoint.nextPageUrl ?? null) !== (last?.provider_cursor ?? null)) {
      mismatches.push("next_page_url differs from the durable raw cursor");
    }
  } else if (last?.provider_cursor !== null) {
    mismatches.push("post-fetch checkpoint references an incomplete generation");
  }

  if (mismatches.length > 0) {
    throw new MetaRawSnapshotRestoreError(
      "checkpoint_raw_mismatch",
      mismatches.join(", "),
    );
  }

  return {
    pages,
    nextPageIndex: durableFrontier,
    resumeCursor: null,
    rewoundToDurableFrontier: false,
  };
}

/** Preserves a durable terminal cursor instead of treating null as "start over". */
export function resolveMetaRawSnapshotFetchUrl(input: {
  checkpoint: MetaRawSnapshotRestoreCheckpoint | null;
  initialPageUrl: string;
}) {
  return input.checkpoint
    ? (input.checkpoint.nextPageUrl ?? null)
    : input.initialPageUrl;
}
