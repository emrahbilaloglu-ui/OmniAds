import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionTone } from "./meta-decision-center-exact-adapter";

/**
 * Every decision label the engine actually emits gets a tone.
 *
 * The card draws a 4px `var(--tone-solid)` bar and the stylesheet has carried
 * the full palette all along, so the queue looked flat for one reason only:
 * the mapping covered seven labels, four of which the engine never emits, and
 * missed the ones it emits most. Counted in production, not assumed:
 *
 *   keep 397,933 · out_of_scope 115,917 · diagnose 19,414 · rebuild 3,802 ·
 *   tune 1,959 · refresh 1,746 · cut 1,297 · scale 844 · swap 90 · test_more 83
 *
 * Pinned as the full census so a new label cannot quietly join the neutral pile.
 */
const PRODUCTION_LABELS: ReadonlyArray<[string, string]> = [
  ["keep", "positive"],
  ["scale", "positive"],
  ["cut", "negative"],
  ["diagnose", "warning"],
  ["tune", "warning"],
  ["refresh", "automation"],
  ["rebuild", "automation"],
  ["swap", "automation"],
  ["test_more", "info"],
  // A row outside the sales objective is not a verdict about its performance,
  // so it is deliberately the one production label that stays grey.
  ["out_of_scope", "neutral"],
];

describe("every emitted decision label carries a tone", () => {
  it.each(PRODUCTION_LABELS)("%s is %s", (label, tone) => {
    expect(decisionTone(label)).toBe(tone);
  });

  it("leaves only out_of_scope grey among the labels the engine emits", () => {
    const grey = PRODUCTION_LABELS.filter(([label]) => decisionTone(label) === "neutral");
    expect(grey.map(([label]) => label)).toEqual(["out_of_scope"]);
  });

  it("does not guess a colour for a label it has never seen", () => {
    // An unmapped label is grey on purpose: inventing a tone would tell the
    // operator something about a decision nobody stated.
    expect(decisionTone("some_future_verdict")).toBe("neutral");
    expect(decisionTone(null)).toBe("neutral");
    expect(decisionTone("")).toBe("neutral");
  });

  it("reads the label the way the server spells it", () => {
    expect(decisionTone("  KEEP  ")).toBe("positive");
    expect(decisionTone("Test_More")).toBe("info");
  });
});

describe("a tone name reaches an actual colour on the card", () => {
  /**
   * The last link. `decisionTone` returns a NAME; the card paints
   * `border-left: 4px solid var(--tone-solid)`. If a tone class stopped
   * defining that variable, every label mapped to it would silently fall back
   * to the inherited colour and the queue would look flat again for a new
   * reason — which is close enough to the original defect to be worth pinning.
   */
  const css = readFileSync(
    "components/meta/decision-center/MetaDecisionCenterExact.module.css",
    "utf8",
  );

  it("draws the card edge from the tone variable", () => {
    expect(css).toContain("border-left: 4px solid var(--tone-solid)");
  });

  it.each([
    ["tonePositive", "#0e9f6e"],
    ["toneNegative", "#e11d48"],
    ["toneWarning", "#b45309"],
    ["toneInfo", "#2f6bff"],
    ["toneAutomation", "#6c41be"],
    ["toneNeutral", "#98a4ba"],
  ])("%s resolves --tone-solid to %s", (tone, colour) => {
    const block = css.slice(css.indexOf(`.${tone} {`));
    expect(block.slice(0, block.indexOf("}"))).toContain(`--tone-solid: ${colour}`);
  });
});
