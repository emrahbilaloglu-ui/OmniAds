import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Assets table reaches past the console's page cap. This pins the two
 * halves of that arithmetic to each other.
 *
 * WHY IT EXISTS. `.adv-page` caps the content column at `--adv-page-max` and
 * centres it. Creative Studio's asset table carries eleven metric columns, so
 * on a wide screen it scrolled horizontally while several hundred pixels of the
 * same column sat empty on either side of the cap. `.creativesTableArticle` now
 * gives that space back with a negative inline margin computed from the shell's
 * own constants: `(100vw - rail - 2*gutter - 100%) / 2`.
 *
 * THAT COMPUTATION SPANS TWO FILES. The constants are declared in
 * `app/globals.css`; the consumer lives in the CSS module. Nothing in CSS fails
 * when a `var()` misses — it silently falls back, and the table quietly stops
 * widening or, worse, starts pulling itself inward. So the drift is what is
 * asserted here.
 *
 * MEASURED, NOT ARGUED. The pixel behaviour was measured in Chromium via
 * Playwright against a harness reproducing the real ancestor chain
 * (`.adv-shell > .adv-rail + .adv-main > .adv-page > .root > article`) with
 * Tailwind's border-box preflight. Per viewport width — article width vs the
 * capped width above it, and whether anything scrolls horizontally:
 *
 *     1280  976 vs  976   +0     page scroll-x: no
 *     1440 1136 vs 1136   +0     page scroll-x: no
 *     1600 1296 vs 1296   +0     page scroll-x: no
 *     1920 1616 vs 1504  +112    page scroll-x: no
 *     2560 2224 vs 1504  +720    page scroll-x: no   (clamped at 360/side)
 *      900  596 vs  596   +0     page scroll-x: no
 *
 * jsdom has no layout engine, so those numbers cannot be re-derived in this
 * suite. What this file guards is the thing that would silently break them.
 */

const GLOBALS = readFileSync("app/globals.css", "utf8");
const MODULE = readFileSync(
  "components/creatives/CreativeStudioExact.module.css",
  "utf8",
);

function bleedDeclaration(): string {
  const start = MODULE.indexOf("--studio-table-bleed: clamp(");
  expect(start, "the asset table no longer computes a bleed").toBeGreaterThan(-1);
  return MODULE.slice(start, MODULE.indexOf(";", start));
}

describe("the Assets table's reach past the page cap", () => {
  it("consumes only variables the shell actually declares", () => {
    const declaration = bleedDeclaration();
    const consumed = [...declaration.matchAll(/var\(\s*(--[\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(consumed.length, "the bleed reads no shell constant at all").toBeGreaterThan(0);

    for (const name of consumed) {
      // Declared, not merely mentioned: `--x: value`, never `var(--x)`.
      const declared = new RegExp(`${name}\\s*:\\s*[^;]+;`).test(GLOBALS);
      expect(
        declared,
        `${name} is read by the asset table's bleed but declared nowhere in ` +
          `app/globals.css. In CSS that failure is silent — the fallback ` +
          `applies and the table stops widening with no error anywhere.`,
      ).toBe(true);
    }
  });

  it("reads the rail and gutter from the same place the shell sets them", () => {
    // The rail is a SIBLING of the content column, so a variable declared on
    // `.adv-rail` would never inherit down to the table. It has to come from
    // the shared ancestor, and the rail has to consume the same one.
    expect(GLOBALS).toMatch(/\.adv-shell\s*{[^}]*--adv-rail-w:\s*248px/);
    expect(GLOBALS).toMatch(/\.adv-rail\s*{[^}]*width:\s*var\(--adv-rail-w/);
    expect(GLOBALS).toMatch(/\.adv-page\s*{[^}]*--adv-page-gutter:\s*28px/);
    expect(GLOBALS).toMatch(
      /\.adv-page\s*{[^}]*padding:\s*24px\s+var\(--adv-page-gutter/,
    );

    const declaration = bleedDeclaration();
    expect(declaration).toContain("--adv-rail-w");
    expect(declaration).toContain("--adv-page-gutter");
    // The gutter is subtracted on BOTH sides of the content box.
    expect(declaration).toMatch(/--adv-page-gutter[^)]*\)\s*\*\s*2/);
  });

  it("can never pull the table inward, and can never run away", () => {
    const declaration = bleedDeclaration();
    // Lower bound 0: below the cap the expression is zero or negative, and a
    // negative bleed would make a NARROW screen lose width — the opposite of
    // the point.
    expect(
      declaration.replace(/\s+/g, " "),
      "the clamp's lower bound is not 0px, so a narrow viewport can pull the " +
        "table inward",
    ).toMatch(/clamp\(\s*0px\s*,/);
    // Upper bound: an ultra-wide monitor must not stretch one table across the
    // whole desk. Any finite px cap satisfies this; its absence does not.
    expect(
      declaration.replace(/\s+/g, " "),
      "the clamp has no upper bound, so an ultra-wide screen stretches the row",
    ).toMatch(/,\s*\d+px\s*\)$/);
  });

  it("widens the asset table alone, not the whole page", () => {
    // The operator asked for this on the bottom table only: the header, tabs
    // and comparison board keep the cap so the page still reads as one column.
    const bled = [...MODULE.matchAll(/^\.([\w-]+)\s*{[^}]*margin-inline:\s*calc\(-1 \* var\(--studio-table-bleed/gm)]
      .map((match) => match[1]);
    expect(bled).toEqual(["creativesTableArticle"]);
  });
});
