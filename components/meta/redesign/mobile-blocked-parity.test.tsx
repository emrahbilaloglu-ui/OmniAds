import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A decision the engine BLOCKED must read as blocked on the phone too.
 *
 * Mobile was rendering 60 server-blocked creative rows with no state badge, no
 * blocker text and no cap statement — three authority facts the desktop shows
 * from the same payload. INVARIANTS.md is explicit that a blocked, held or
 * review-only decision must never present as an ordinary recommendation; a
 * surface that drops the state is not a smaller view of the truth, it is a
 * different one.
 *
 * Pinned on the source: the defect is fields that were never passed, and a
 * fixture-driven render would pass whether or not the real builder carries them.
 */
const PAGE = readFileSync(
  "components/meta/redesign/MetaPlatformPage.tsx",
  "utf8",
);

describe("mobile carries the served decision state", () => {
  it("takes the state and the blockers off the creative row", () => {
    const start = PAGE.indexOf("function mobileQueueRows");
    const builder = PAGE.slice(
      start,
      PAGE.indexOf('if (lane === "needsres")', start),
    );
    expect(builder).toContain("stateLabel: row.stateLabel");
    expect(builder).toContain("stateTone: row.stateTone");
    expect(builder).toContain("blockedNote: row.blockedNote");
  });

  /*
   * The advisory is the same law one field over.
   *
   * `risk_tier_unclassified` used to live in `blockers`, where it vetoed every
   * exact-Ad action because the risk-tier PRODUCER is not persisted. It moved
   * to a non-gating `advisories` field — and the desktop inspector grew a line
   * for it while this one did not, so the phone silently stopped saying that
   * risk is unclassified at all. Not a refusal, still a fact, and a surface
   * that drops it is a different account of the same decision.
   */
  it("states the advisories the desktop inspector states", () => {
    // `ad-mobile-desktop-note` appears on several mobile screens, and the first
    // one precedes this block — so the end marker is searched FROM the start.
    const start = PAGE.indexOf('data-mobile-posture="inspector"');
    expect(start, "the mobile inspector block is gone").toBeGreaterThan(-1);
    const inspector = PAGE.slice(
      start,
      PAGE.indexOf("ad-mobile-desktop-note", start),
    );
    expect(inspector.length, "the inspector slice is empty").toBeGreaterThan(0);
    expect(inspector).toContain("mobileDisplay(inspector.blockers)");
    expect(inspector).toContain("mobileDisplay(inspector.advisories)");
    // The advisory must not be folded back into the Blockers line: the whole
    // point of the move is that it withholds nothing.
    expect(inspector).not.toMatch(/blockers:\s*{[^}]*advisories/);
  });

  it("renders the state before the decision label, not instead of it", () => {
    const card = PAGE.slice(
      PAGE.indexOf("function MetaMobileQueueRow"),
      PAGE.indexOf("ad-mobile-row-footer"),
    );
    expect(card).toContain("data-mobile-state=");
    expect(card).toContain("data-mobile-blocked-note=");
    expect(card.indexOf("data-mobile-state=")).toBeLessThan(
      card.indexOf("{mobileDisplay(decisionLabel)}"),
    );
  });

  it("withholds the badge rather than printing an em dash for it", () => {
    // An absent state is absent, not a dash in a badge slot.
    const card = PAGE.slice(
      PAGE.indexOf("function MetaMobileQueueRow"),
      PAGE.indexOf("ad-mobile-row-footer"),
    );
    expect(card).toContain('mobileDisplay(stateLabel) !== "—"');
    expect(card).toContain('mobileDisplay(blockedNote) !== "—"');
  });

  it("keeps mobile read-only", () => {
    // The parity being fixed is DATA parity. Writes stay desktop-only, and the
    // row states that in text rather than by hiding a disabled button.
    const card = PAGE.slice(
      PAGE.indexOf("function MetaMobileQueueRow"),
      PAGE.indexOf("function MetaMobileDecisionsScreen"),
    );
    expect(card).toContain("· desktop");
    expect(card).not.toContain("onPrimary");
  });
});
