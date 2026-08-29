import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The topbar freshness pill must describe the surface the operator is looking
 * at, or say it does not know — never borrow an age from somewhere else.
 *
 * When a surface registered itself with `asOf: null` (an unavailable read, or a
 * read whose observation time is genuinely unknown), the hook fell through to
 * the account-level `metaStatus.latestSync.finishedAt` and rendered
 * "Synced 9h ago". The screen then carried a confident age for data it did not
 * have — the same class of defect as a missing metric rendering as 0, and it
 * silently undid the per-surface freshness binding the creative work added.
 *
 * The unknown branch now uses the shared `SYNC_AGE_UNKNOWN_LABEL`, because the
 * previous "Synced —" still asserted that a sync had completed.
 *
 * Pinned on the source because the defect is a missing branch: every value the
 * hook returned was individually true, it was simply answering about the wrong
 * subject.
 */
const source = readFileSync("components/layout/v2/use-shell-signals.ts", "utf8");

describe("the freshness pill never borrows another subject's age", () => {
  it("states an unknown surface age instead of falling through", () => {
    const block = source.slice(
      source.indexOf("const surfaceAge = minutesSince("),
      source.indexOf("const ages = ["),
    );
    expect(block).toContain('tone: "unknown"');
    expect(block).toContain("label: SYNC_AGE_UNKNOWN_LABEL");
    expect(block).toContain('freshnessState: "unknown"');
  });

  it("still reports a real surface age when the surface has one", () => {
    const block = source.slice(
      source.indexOf("const surfaceAge = minutesSince("),
      source.indexOf("const ages = ["),
    );
    expect(block).toContain("if (surfaceAge !== null)");
    expect(block).toContain("formatSyncAge(surfaceAge)");
  });
});
