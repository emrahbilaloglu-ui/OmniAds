import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The plan's typography floor, enforced so it cannot quietly regress.
 *
 * Essential data and body text must be at least 12px. 11px was permitted for
 * "demonstrably noncritical compact labels", and in practice that exemption
 * covered account identifiers, a kill-switch badge, the degraded-decisions
 * banner and the decision lane names -- none of which is noncritical. The
 * exemption is withdrawn: anything below 12px is a defect
 * regardless of where it appears — the audit found 7.5–10px table headers,
 * attribution labels, assessment text and reasons, which is essential content
 * rendered at a size people cannot comfortably read.
 *
 * SCOPE, stated honestly: this checks `.css` files only. It does not see
 * Tailwind arbitrary values in TSX (`text-[11.5px]`), and that is where most of
 * this product's small text now lives -- the v2 design's own type scale puts
 * 121 of its 379 non-monospace text elements below 12px, including `<p>`
 * descriptions at 11px. Measured 2026-08-16 against the design file itself, and
 * on `/commercial-truth` alone 38 pieces of essential text render below the
 * floor: target-pack values, assessments like "degraded no scale, review hold",
 * and field explanations -- the exact categories the audit named.
 *
 * So the sentence above ("regardless of where it appears") is the rule's
 * intent, not its coverage. The gap is deliberate to leave visible rather than
 * paper over: closing it means either re-scaling the shipped design or
 * narrowing the rule, and that is a product decision, not a lint fix. The
 * reporting test below prints the size of the gap so it cannot be forgotten.
 *
 * This asserts on shipped stylesheets rather than on a screenshot, because a
 * screenshot proves one viewport on one day and a stylesheet proves the rule.
 */
const STYLESHEETS: string[] = execSync(
  "find app components -name '*.css' -not -path '*/node_modules/*'",
  { encoding: "utf8" },
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const FONT_SIZE = /font-size:\s*([0-9.]+)px/g;

describe("no essential text is rendered below the readable floor", () => {
  it("finds stylesheets to check", () => {
    expect(STYLESHEETS.length).toBeGreaterThan(5);
  });

  it("has no font-size below 12px anywhere in shipped CSS", () => {
    const violations: string[] = [];
    for (const file of STYLESHEETS) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(FONT_SIZE)) {
          const size = Number(match[1]);
          if (size < 12) {
            violations.push(`${file}:${index + 1} — ${size}px`);
          }
        }
      });
    }
    expect(
      violations,
      `text below the 12px floor:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps a real primary reading layer, not a wall of minimum-size text", () => {
    // The floor is not the target. If nothing is 13–14px, the surface has been
    // flattened to its minimum rather than given a reading hierarchy.
    const all = STYLESHEETS.flatMap((file) =>
      Array.from(readFileSync(file, "utf8").matchAll(FONT_SIZE)).map((match) =>
        Number(match[1]),
      ),
    );
    const primaryReading = all.filter((size) => size >= 13 && size <= 14);
    expect(primaryReading.length).toBeGreaterThan(20);
  });
});

/**
 * The uncovered surface, reported rather than enforced.
 *
 * This does not fail. Failing it would either force a redesign of every screen
 * or force an exemption nobody has agreed to. What it does is make the number
 * visible on every run, so "the floor is enforced" can never again be believed
 * about a surface where it is not.
 */
describe("the part of the floor that is not enforced", () => {
  it("reports how much sub-12px text lives in TSX, where this check cannot reach", () => {
    const files = execSync(
      "find app components -name '*.tsx' -not -name '*.test.tsx' -not -path '*/node_modules/*'",
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const ARBITRARY = /text-\[(\d+(?:\.\d+)?)px\]/g;
    let below = 0;
    let total = 0;
    const perFile = new Map<string, number>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(ARBITRARY)) {
        total += 1;
        if (Number(match[1]) < 12) {
          below += 1;
          perFile.set(file, (perFile.get(file) ?? 0) + 1);
        }
      }
    }

    const worst = [...perFile.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([file, count]) => `${count} ${file}`);

    console.warn(
      `[typography-floor] ${below} of ${total} arbitrary text sizes in TSX are below 12px, ` +
        `across ${perFile.size} files. Not enforced here. Worst: ${worst.join(", ")}`,
    );

    // The only assertion: the measurement itself still works. If this ever
    // reads zero, either the debt is gone or the pattern changed -- both are
    // worth noticing.
    expect(total).toBeGreaterThan(0);
  });
});
