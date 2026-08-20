import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The archive lane shows both inactive grains in the order the SERVER sent them.
 *
 * The first version of this fix read the archive out of `inactiveViewItems`,
 * which is ranked on spend for the mobile inactive view — so both grains were
 * re-ordered while a comment directly above the code claimed "each grain keeps
 * its own served order". Sort order is engine output, not presentation, and a
 * shipped comment asserting the opposite is worse than no comment.
 *
 * Pinned on the source because the defect is which VARIABLE is read: a
 * behavioural test over a fixture would pass against either one whenever the
 * fixture happens to arrive in spend order.
 */
const PAGE = readFileSync(
  "components/meta/redesign/MetaPlatformPage.tsx",
  "utf8",
);

describe("the archive lane preserves the served order", () => {
  it("builds its rows from the unsorted served grains", () => {
    const block = PAGE.slice(
      PAGE.indexOf("const exactArchiveRows"),
      PAGE.indexOf("const exactActionRows"),
    );
    expect(block).toContain("inactiveServedGrains.structures");
    expect(block).toContain("inactiveServedGrains.ads");
    // The spend-ranked list is for the mobile view and must not leak in here.
    expect(block).not.toContain("inactiveViewItems");
  });

  it("keeps the spend ranking confined to the mobile inactive view", () => {
    // The ranking still exists — it is useful there — it simply is not the
    // archive's order.
    expect(PAGE).toContain("const inactiveViewItems");
    expect(PAGE).toContain("right.spend - left.spend");
  });

  it("filters both grains before either is ordered", () => {
    const block = PAGE.slice(
      PAGE.indexOf("const inactiveServedGrains"),
      PAGE.indexOf("const inactiveViewItems"),
    );
    expect(block).toContain("canonicalCreativeSearchMatch");
    expect(block).not.toContain(".sort(");
  });
});
