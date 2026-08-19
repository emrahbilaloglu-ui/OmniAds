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
    // UNKNOWN is in the briefing under every filter. It means the status was
    // not captured, not that the entity is off — and reading it as "off" hid
    // 95% of a real account's spend from every rollup, so the surface reported
    // ROAS 0.00 for an account spending over $1k a day.
    ["UNKNOWN", [true, true, true]],
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

describe("an uncaptured status is never read as an archived one", () => {
  /**
   * The failure this closes: five Grandmix campaigns carried $34,612 of a
   * $36,451 window while their daily rows had a null `campaign_status`. The
   * system knew they were ACTIVE — `meta_entity_state_history` recorded exactly
   * that — but the two tables this filter reads did not carry it. Listing
   * UNKNOWN as archive-only dropped every one of them, and the Decision Center
   * reported ROAS 0.00 and $0 spend for an account spending daily.
   */
  it("keeps an entity with no captured status out of the archive", () => {
    for (const entity of [{ status: null }, { status: "" }, {}]) {
      expect(isArchiveOnlyEntity(entity, "active", NOW)).toBe(false);
      expect(isInBriefing(entity, "active", NOW)).toBe(true);
    }
  });

  it("still archives the statuses that really are closed", () => {
    for (const status of ["PAUSED", "ARCHIVED", "DELETED"]) {
      expect(isArchiveOnlyEntity({ status }, "active", NOW)).toBe(true);
    }
  });
});
