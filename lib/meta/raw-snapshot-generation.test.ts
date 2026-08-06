import { describe, expect, it } from "vitest";

import {
  MetaRawSnapshotRestoreError,
  resolveMetaRawSnapshotFetchUrl,
  resolveMetaRawSnapshotResumeState,
  selectLatestMetaRawSnapshotGeneration,
  type MetaRawSnapshotRestorePage,
} from "@/lib/meta/raw-snapshot-generation";

function page(
  id: string,
  pageIndex: number,
  fetchedAt: string,
  providerCursor: string | null,
  overrides: Partial<MetaRawSnapshotRestorePage> = {},
): MetaRawSnapshotRestorePage {
  return {
    id,
    page_index: pageIndex,
    payload_json: [{ ad_id: id }],
    provider_cursor: providerCursor,
    provider_http_status: 200,
    status: "fetched",
    fetched_at: fetchedAt,
    ...overrides,
  };
}

describe("Meta raw snapshot generation restore", () => {
  it("selects only the latest complete generation", () => {
    const selected = selectLatestMetaRawSnapshotGeneration([
      page("old-0", 0, "2026-07-05T01:00:00Z", "old-next"),
      page("old-1", 1, "2026-07-05T01:00:01Z", null),
      page("new-0", 0, "2026-07-05T02:00:00Z", "new-next"),
      page("new-1", 1, "2026-07-05T02:00:01Z", null),
    ]);

    expect(selected.map((entry) => entry.id)).toEqual(["new-0", "new-1"]);
  });

  it("keeps an incomplete latest generation instead of falling back", () => {
    const selected = selectLatestMetaRawSnapshotGeneration([
      page("old-0", 0, "2026-07-05T01:00:00Z", null),
      page("new-0", 0, "2026-07-05T02:00:00Z", "new-next"),
    ]);

    expect(selected.map((entry) => entry.id)).toEqual(["new-0"]);
  });

  it("accepts a terminal poll whose partition-global page index is non-zero", () => {
    const selected = selectLatestMetaRawSnapshotGeneration([
      page("poll-38", 38, "2026-07-05T02:53:10Z", null),
    ]);

    expect(selected.map((entry) => entry.page_index)).toEqual([38]);
  });

  it("fails closed on a duplicate or missing page in the latest generation", () => {
    expect(() =>
      selectLatestMetaRawSnapshotGeneration([
        page("page-0", 0, "2026-07-05T02:00:00Z", "next-1"),
        page("page-2", 2, "2026-07-05T02:00:01Z", null),
      ]),
    ).toThrowError(MetaRawSnapshotRestoreError);
  });

  it("advances a fetch checkpoint to the next page without replaying the last page", () => {
    const pages = [
      page("page-0", 0, "2026-07-05T02:00:00Z", "next-1"),
      page("page-1", 1, "2026-07-05T02:00:01Z", "next-2"),
    ];

    expect(
      resolveMetaRawSnapshotResumeState({
        pages,
        checkpoint: {
          phase: "fetch_raw",
          pageIndex: 1,
          nextPageUrl: "next-2",
          providerCursor: "next-2",
          rowsFetched: 2,
        },
      }),
    ).toMatchObject({ nextPageIndex: 2 });
  });

  it("rejects a checkpoint persisted ahead of its raw page", () => {
    expect(() =>
      resolveMetaRawSnapshotResumeState({
        pages: [],
        checkpoint: {
          phase: "fetch_raw",
          pageIndex: 0,
          nextPageUrl: "next-1",
          providerCursor: "next-1",
          rowsFetched: 1,
        },
      }),
    ).toThrowError(/checkpoint records 1 rows but no raw page is durable/);
  });

  it("rewinds to the durable raw frontier when the checkpoint is one page ahead", () => {
    // The exact production signature: `page_index checkpoint=1 raw=0`, left by
    // an interruption between the checkpoint write and the raw page write.
    const pages = [page("page-0", 0, "2026-07-05T02:00:00Z", "next-1")];

    expect(
      resolveMetaRawSnapshotResumeState({
        pages,
        checkpoint: {
          phase: "fetch_raw",
          pageIndex: 1,
          nextPageUrl: "next-2",
          providerCursor: "next-2",
          // Counts the rows of the page that never became durable.
          rowsFetched: 99,
        },
      }),
    ).toMatchObject({
      nextPageIndex: 1,
      rewoundToDurableFrontier: true,
      // Must be page 0's cursor, NOT the checkpoint's "next-2": resuming from
      // the checkpoint would skip page 1 entirely and lose its rows silently.
      resumeCursor: "next-1",
    });
  });

  it("still rejects a checkpoint further ahead than one interrupted page", () => {
    const pages = [page("page-0", 0, "2026-07-05T02:00:00Z", "next-1")];

    expect(() =>
      resolveMetaRawSnapshotResumeState({
        pages,
        checkpoint: {
          phase: "fetch_raw",
          pageIndex: 3,
          nextPageUrl: "next-4",
          providerCursor: "next-4",
          rowsFetched: 3,
        },
      }),
    ).toThrowError(MetaRawSnapshotRestoreError);
  });

  it("accepts a completed generation at a post-fetch checkpoint", () => {
    const pages = [page("page-0", 0, "2026-07-05T02:00:00Z", null)];
    expect(
      resolveMetaRawSnapshotResumeState({
        pages,
        checkpoint: {
          phase: "bulk_upsert",
          pageIndex: 1,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: 1,
        },
      }),
    ).toMatchObject({ nextPageIndex: 1 });
  });

  it("uses the partition-global next index for a completed non-zero generation", () => {
    const pages = [page("page-38", 38, "2026-07-05T02:00:00Z", null)];
    expect(
      resolveMetaRawSnapshotResumeState({
        pages,
        checkpoint: {
          phase: "bulk_upsert",
          pageIndex: 39,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: 1,
        },
      }),
    ).toMatchObject({ nextPageIndex: 39 });
  });

  it("does not restart page one after a durable terminal checkpoint", () => {
    expect(
      resolveMetaRawSnapshotFetchUrl({
        checkpoint: {
          phase: "bulk_upsert",
          pageIndex: 39,
          nextPageUrl: null,
          providerCursor: null,
          rowsFetched: 1,
        },
        initialPageUrl: "https://graph.facebook.com/first-page",
      }),
    ).toBeNull();
  });

  it("uses the first-page URL only when no checkpoint exists", () => {
    expect(
      resolveMetaRawSnapshotFetchUrl({
        checkpoint: null,
        initialPageUrl: "https://graph.facebook.com/first-page",
      }),
    ).toBe("https://graph.facebook.com/first-page");
  });
});
