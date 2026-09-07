import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A read that never ran must not report itself as a read that found nothing.
 *
 * `metaEvidenceReadState` ended in `fetchStatus === "fetching" ? "loading" :
 * "loaded"`, so a query with no data that was PAUSED (react-query pauses when
 * the browser is offline) or never enabled reported "loaded". The window then
 * printed the same em dash a real absence prints, and an operator could not
 * tell a missing metric from one nobody asked for — the exact honesty rule this
 * surface exists to hold.
 *
 * Pinned on the source because the defect is a collapsed branch: a behavioural
 * test over a resolved query passes either way.
 */
const PAGE = readFileSync(
  "components/meta/redesign/MetaPlatformPage.tsx",
  "utf8",
);
const ADAPTER = readFileSync(
  "components/creatives/creative-evidence-window-exact-adapter.ts",
  "utf8",
);

describe("an unread evidence query is distinguishable from an absence", () => {
  it("does not resolve a dataless, non-fetching query to loaded", () => {
    const fn = PAGE.slice(
      PAGE.indexOf("function metaEvidenceReadState"),
      PAGE.indexOf("function metaEvidenceReadError"),
    );
    expect(fn).toContain('return "unread"');
    expect(fn).not.toContain('? "loading" : "loaded"');
  });

  it("marks an unread cell the same way an unreadable one is marked", () => {
    // The cell must not look like an answer in either case.
    expect(ADAPTER).toContain('state === "error" || state === "unread"');
  });

  it("keeps the two reasons apart in the banner", () => {
    expect(ADAPTER).toContain(
      "Some creative performance data could not be loaded",
    );
    expect(ADAPTER).toContain(
      "Creative performance data is unavailable for this row",
    );
    expect(ADAPTER).not.toContain("the request is paused or was never issued");
  });

  it("still says nothing when the read genuinely completed", () => {
    // A loaded read with data has no banner at all — the honesty rule is
    // about naming what is NOT known, not about narrating success.
    const start = ADAPTER.indexOf("function readNotice");
    const fn = ADAPTER.slice(start, ADAPTER.indexOf("\nfunction ", start + 1));
    expect(fn).toContain("return null;");
  });
});
