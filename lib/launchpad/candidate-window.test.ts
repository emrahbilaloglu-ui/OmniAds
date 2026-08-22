import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  LAUNCHPAD_CANDIDATE_WINDOW_DAYS,
  LAUNCHPAD_CANDIDATE_WINDOW_LABEL,
} from "@/lib/launchpad/candidate-window";

/**
 * WP5 item 3 — a window label must name the window that was read.
 *
 * The Launchpad creative table headed its metrics column "28d metrics" over a
 * read of `isoDateDaysAgo(29)` → today, which is thirty inclusive days. Every
 * spend, ROAS and CTR in that column therefore covered two more days than the
 * header claimed, and nothing could catch it because the two numbers lived in
 * different files.
 */
describe("Launchpad candidate window", () => {
  it("derives the label from the day count", () => {
    expect(LAUNCHPAD_CANDIDATE_WINDOW_LABEL).toBe(
      `${LAUNCHPAD_CANDIDATE_WINDOW_DAYS}d metrics`,
    );
  });

  it("is the window the fetch actually asks for", () => {
    // The fetch is inclusive of both ends, so N days back from today is N-1.
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx",
      "utf8",
    );
    expect(source).toContain(
      "isoDateDaysAgo(LAUNCHPAD_CANDIDATE_WINDOW_DAYS - 1)",
    );
    // The literal that used to disagree with the header is gone.
    expect(source).not.toContain("isoDateDaysAgo(29)");
  });

  it("is the label the column header renders", () => {
    const source = readFileSync(
      "components/launchpad/LaunchpadCreativeSelection.tsx",
      "utf8",
    );
    expect(source).toContain("{LAUNCHPAD_CANDIDATE_WINDOW_LABEL}");
    // The rendered literal, not the prose: the comment above the header still
    // says "28d metrics" because it is explaining what the header used to say.
    expect(source).not.toMatch(/>\s*28d metrics\s*</);
  });
});
