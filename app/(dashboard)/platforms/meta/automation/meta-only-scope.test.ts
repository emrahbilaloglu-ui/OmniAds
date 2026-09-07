import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Automation's kill switch governs Meta writes and nothing else.
 *
 * The screen used to say "Global writes" and "blocks every provider write",
 * which is what the design file draws — and both are false of the control.
 * These assertions pin the *reason* the copy was changed, so that a future
 * edit restoring the design's wording has to first make the wording true.
 *
 * Deliberately a source-level test. A rendering test proves what one screen
 * says today; this proves the claim the screen makes is still a fact about the
 * system, which is the thing that would actually break.
 */
describe("the Meta kill switch is Meta-only", () => {
  const GOOGLE_MUTATE = "lib/google-ads/advisor-mutate.ts";

  it("the Google Ads mutate path does not read the Meta kill switch", () => {
    const source = readFileSync(GOOGLE_MUTATE, "utf8");
    expect(source).not.toContain("META_ADS_WRITE_KILL_SWITCH");
  });

  it("the Google Ads mutate path imports nothing from the Meta control plane", () => {
    const source = readFileSync(GOOGLE_MUTATE, "utf8");
    // Whole-module, not just the flag name: a Google write that started
    // importing the Meta automation control plane would inherit the switch by
    // the back door and the copy would silently become wrong in the other
    // direction.
    expect(source).not.toMatch(/from\s+["']@\/lib\/meta\//);
  });

  it("the switch is declared in the Meta control plane under a Meta-scoped name", () => {
    const source = readFileSync("lib/meta/automation-control-plane.ts", "utf8");
    expect(source).toContain("META_ADS_WRITE_KILL_SWITCH");
    expect(source).toContain("isGlobalMetaAdsWriteKillSwitchEngaged");
  });

  it("keeps provider-scope internals out of the operator surface", () => {
    const view = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );
    expect(view).not.toContain(
      "No control on this screen stops Google Ads writes.",
    );
    expect(view).not.toContain("<span>Global writes</span>");
    expect(view).not.toContain("<dt>Global writes</dt>");
    expect(view).not.toContain("blocks every provider write");
  });
});
