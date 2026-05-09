import { describe, expect, it } from "vitest";
import {
  briefingStatusLabel,
  isArchiveOnlyEntity,
  isInBriefing,
  parseBriefingStatusFilter,
  type BriefingStatusFilter,
} from "@/lib/meta/briefing-filter";

const NOW = new Date("2026-05-09T12:00:00.000Z");
const FILTERS: BriefingStatusFilter[] = ["active", "active_plus_recent_paused", "all"];

describe("briefing-filter", () => {
  it("parses unsupported values back to the active default", () => {
    expect(parseBriefingStatusFilter(null)).toBe("active");
    expect(parseBriefingStatusFilter("bad")).toBe("active");
    expect(parseBriefingStatusFilter("all")).toBe("all");
  });

  it.each([
    ["ACTIVE", [true, true, true]],
    ["ARCHIVED", [false, false, true]],
    ["DELETED", [false, false, true]],
    ["UNKNOWN", [false, false, true]],
    ["WITH_ISSUES", [false, false, true]],
  ] as const)("classifies %s across status filters", (status, expected) => {
    const actual = FILTERS.map((filter) => isInBriefing({ status }, filter, NOW));
    expect(actual).toEqual(expected);
  });

  it("only includes recently paused entities in the expanded review filter", () => {
    const recentPaused = { status: "PAUSED", statusChangedAt: "2026-05-09T00:30:00.000Z" };
    const stalePaused = { status: "PAUSED", statusChangedAt: "2026-05-07T00:00:00.000Z" };

    expect(FILTERS.map((filter) => isInBriefing(recentPaused, filter, NOW))).toEqual([false, true, true]);
    expect(FILTERS.map((filter) => isInBriefing(stalePaused, filter, NOW))).toEqual([false, false, true]);
  });

  it("keeps closed entities out of the archive only when they are intentionally in scope", () => {
    const recentPaused = { status: "PAUSED", statusChangedAt: "2026-05-09T11:00:00.000Z" };
    const archived = { status: "ARCHIVED" };
    const withIssues = { status: "WITH_ISSUES" };

    expect(isArchiveOnlyEntity(recentPaused, "active", NOW)).toBe(true);
    expect(isArchiveOnlyEntity(recentPaused, "active_plus_recent_paused", NOW)).toBe(false);
    expect(isArchiveOnlyEntity(archived, "active", NOW)).toBe(true);
    expect(isArchiveOnlyEntity(archived, "all", NOW)).toBe(false);
    expect(isArchiveOnlyEntity(withIssues, "active", NOW)).toBe(false);
  });

  it("formats paused status labels with elapsed time when available", () => {
    expect(briefingStatusLabel({ status: "PAUSED", statusChangedAt: "2026-05-09T08:30:00.000Z" }, NOW)).toBe("Paused 4h");
    expect(briefingStatusLabel({ status: "PAUSED", statusChangedAt: "2026-05-07T12:00:00.000Z" }, NOW)).toBe("Paused 2d");
    expect(briefingStatusLabel({ status: "WITH_ISSUES" }, NOW)).toBe("With Issues");
  });
});
