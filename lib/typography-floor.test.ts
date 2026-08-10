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
