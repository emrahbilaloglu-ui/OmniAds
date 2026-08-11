import { describe, expect, it } from "vitest";

import {
  APPLIED_MANUAL_LABEL,
  appliedStepIds,
  markIsReversible,
  type JournalPage,
} from "@/lib/zero-base/google/activity-journal";

const entry = (
  id: string,
  action: JournalPage["entries"][number]["action"],
  at: string,
  stepId: string | null,
): JournalPage["entries"][number] => ({
  id,
  at,
  actor: "Dana Whitfield",
  action,
  stepId,
  detail: "",
});

const page = (entries: JournalPage["entries"]): JournalPage => ({
  entries,
  hasGap: false,
  gapReason: null,
});

describe("google activity journal", () => {
  it("never labels a manual confirmation as verified", () => {
    // The qualifier is the whole point: nothing here read Google back, so the
    // row records that a human said they applied a change, not that it landed.
    expect(APPLIED_MANUAL_LABEL).toContain("manual");
    expect(APPLIED_MANUAL_LABEL).not.toMatch(/verified|confirmed/i);
  });

  it("collects the steps a human marked applied", () => {
    const journal = page([
      entry("1", "marked-applied", "2026-08-09T07:00:00Z", "g1"),
      entry("2", "copied", "2026-08-09T07:01:00Z", "g2"),
    ]);
    expect([...appliedStepIds(journal)]).toEqual(["g1"]);
  });

  it("keeps a mark reversible until the batch has been exported", () => {
    const journal = page([entry("1", "marked-applied", "2026-08-09T07:00:00Z", "g1")]);
    expect(markIsReversible(journal, "g1")).toBe(true);
  });

  it("freezes a mark once the batch it belongs to was exported", () => {
    // After export the record has left the system; un-marking here would make
    // our journal disagree with the file the operator is working from.
    const journal = page([
      entry("1", "marked-applied", "2026-08-09T07:00:00Z", "g1"),
      entry("2", "csv-all", "2026-08-09T07:05:00Z", null),
    ]);
    expect(markIsReversible(journal, "g1")).toBe(false);
  });

  it("leaves a mark made after the export reversible", () => {
    const journal = page([
      entry("1", "csv-all", "2026-08-09T07:00:00Z", null),
      entry("2", "marked-applied", "2026-08-09T07:05:00Z", "g1"),
    ]);
    expect(markIsReversible(journal, "g1")).toBe(true);
  });

  it("a single-step export freezes only that step", () => {
    const journal = page([
      entry("1", "marked-applied", "2026-08-09T07:00:00Z", "g1"),
      entry("2", "marked-applied", "2026-08-09T07:00:00Z", "g2"),
      entry("3", "csv", "2026-08-09T07:05:00Z", "g1"),
    ]);
    expect(markIsReversible(journal, "g1")).toBe(false);
    expect(markIsReversible(journal, "g2")).toBe(true);
  });
});
