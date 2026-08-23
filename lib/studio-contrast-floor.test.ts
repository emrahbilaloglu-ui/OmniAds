import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Creative Studio palette, checked as numbers rather than as intent.
 *
 * This law used to read `components/creatives/StudioOsView.tsx`, which no route
 * mounts and which is deleted with this change, so every assertion in it was
 * measuring a file no buyer could reach. It is re-pointed at the Studio that
 * actually ships: `CreativeStudioExact`, mounted by five route bodies
 * (`/platforms/meta/{creatives,copies,landing-pages,audiences,creative-inbox}`
 * and their `/app/creative/**` twins) through `legacy-page.tsx`.
 *
 * ## What re-pointing revealed, stated rather than papered over
 *
 * The shipped Studio does not clear 4.5:1 and cannot be made to without
 * repainting the canonical Dashboard v2 reference, which this pass is not
 * allowed to do. Measured against the surface each colour is actually painted
 * on, the essential sub-13px text sits at:
 *
 *     #68707f on #ffffff   2.51:1   17 rules  (row metadata, counts, empties)
 *     #555d6d on #ffffff   3.66:1   14 rules  (eyebrows, table headers, notes)
 *     #555d6d on #f7f9fc   3.47:1    1 rule   (copy/landing/matrix table heads)
 *     #2a5fe2 on #eaf0ff   3.94:1    2 rules  (insight pill, test estimate)
 *     #ffffff on #2a5fe2   4.50:1    1 rule   (inbox primary button)
 *
 * So the assertion is the one that can be true: the floor still holds for every
 * colour, and the set of colours that fall below it is pinned exactly. A new
 * sub-floor colour fails here, widening an existing one to a new background
 * fails here, and a pin that stops being reached fails here too. What it no
 * longer claims is that Studio is readable — it is not, at these five pairs,
 * and that is a design decision to revisit rather than a number to bury.
 *
 * The same shape is already how `lib/typography-floor.test.ts` handles the size
 * floor for this exact stylesheet: pin the canonical-reference exceptions by
 * value so a marker cannot become a general exemption.
 */
const STYLES = readFileSync(
  "components/creatives/CreativeStudioExact.module.css",
  "utf8",
);
const VIEW = readFileSync("components/creatives/CreativeStudioExact.tsx", "utf8");

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** The Studio paints on white unless a rule names its own fill. */
const PAGE_SURFACE = "#ffffff";
/** WCAG AA for text that carries information. */
const ESSENTIAL_MIN = 4.5;
/** Below this the type is small enough that the floor is not negotiable. */
const ESSENTIAL_MAX_PX = 12;

interface Painted {
  readonly selector: string;
  readonly foreground: string;
  readonly background: string;
}

/**
 * Every rule that sets both a sub-13px size and a literal colour.
 *
 * Rules whose fill is a `var()` cannot be resolved from the stylesheet alone;
 * they are reported separately rather than measured against an assumed white,
 * because an unmeasurable pair and a passing pair must not look the same.
 */
function paintedEssentialText(): { measured: Painted[]; unresolved: string[] } {
  const measured: Painted[] = [];
  const unresolved: string[] = [];
  for (const [, rawSelector, body] of STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const size = /font-size:\s*([0-9.]+)px/.exec(body);
    if (!size || Number(size[1]) > ESSENTIAL_MAX_PX) continue;
    const colour = /(?:^|[;\s])color:\s*(#[0-9a-fA-F]{3,6})/.exec(body);
    if (!colour) continue;
    const selector = rawSelector.trim().replace(/\s+/g, " ");
    const fill = /background:\s*(#[0-9a-fA-F]{3,6})/.exec(body);
    if (!fill && /background:\s*var\(/.test(body)) {
      unresolved.push(selector);
      continue;
    }
    measured.push({
      selector,
      foreground: colour[1].toLowerCase(),
      background: (fill?.[1] ?? PAGE_SURFACE).toLowerCase(),
    });
  }
  return { measured, unresolved };
}

/**
 * The Dashboard v2 colours that ship below the floor. There are none.
 *
 * This list used to hold six pairs — the muted inks on white and on the two
 * fills, the accent on its own tint, and white on the accent — recorded as
 * accepted debt because the palette was treated as fixed.
 *
 * It was not fixed in the sense that mattered. Those six pairs produced 253
 * serious `color-contrast` findings when axe was finally pointed at the
 * mounted routes rather than at a component harness, and D1 lists contrast
 * among the micro-changes the locked visual direction permits. The five palette
 * values moved to the smallest value that clears 4.5:1 on every surface they
 * are painted on, hue preserved and the ink hierarchy preserved with them.
 *
 * The empty list is the assertion: a new sub-floor pair fails here, and the
 * only way to add one is to write it down.
 */
const BELOW_FLOOR_REFERENCE_PAIRS: readonly string[] = [];

describe("essential Creative Studio text and the contrast floor", () => {
  it("introduces no sub-floor colour beyond the pinned canonical ones", () => {
    const { measured } = paintedEssentialText();
    expect(measured.length).toBeGreaterThan(0);

    const offenders = new Map<string, { ratio: number; selectors: string[] }>();
    for (const rule of measured) {
      const ratio = contrast(rule.foreground, rule.background);
      if (ratio >= ESSENTIAL_MIN) continue;
      const key = `${rule.foreground} on ${rule.background}`;
      const entry = offenders.get(key) ?? { ratio, selectors: [] };
      entry.selectors.push(rule.selector);
      offenders.set(key, entry);
    }

    const found = [...offenders.keys()].sort();
    const detail = found
      .map((key) => `${key} = ${offenders.get(key)!.ratio.toFixed(2)}:1`)
      .join("; ");
    expect(found, `sub-floor pairs measured: ${detail}`).toEqual([
      ...BELOW_FLOOR_REFERENCE_PAIRS,
    ]);
  });

  it("cannot hide a colour behind a fill the stylesheet does not resolve", () => {
    // `.avatar` paints white on `--tone-solid`, whose six declared values
    // include #68707f — white on that is 2.51:1. It is left unmeasured rather
    // than measured against a value it may not take, but the list is pinned so
    // a second unmeasurable rule cannot appear unnoticed.
    const { unresolved } = paintedEssentialText();
    expect(unresolved).toEqual([".avatar"]);
  });
});

describe("essential Creative Studio text clears the size floor", () => {
  it("uses no inline font size below 12px", () => {
    // The stylesheet floor in lib/typography-floor.test.ts reads `.css` only,
    // so an inline size in the component would escape it entirely. Studio ships
    // all of its type in the module; this keeps it that way.
    const tooSmall = [
      ...VIEW.matchAll(/fontSize:\s*(?:"|')?(\d+(?:\.\d+)?)(?:px)?(?:"|')?/g),
    ]
      .map((match) => Number(match[1]))
      .filter((size) => size > 0 && size < 12);
    expect(tooSmall, `inline sizes below 12px: ${tooSmall.join(", ")}`).toEqual([]);
  });

  it("uses no sub-12px Tailwind arbitrary size", () => {
    const arbitrary = [...VIEW.matchAll(/text-\[([0-9.]+)px\]/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size < 12);
    expect(arbitrary, `arbitrary sizes below 12px: ${arbitrary.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps the shipped stylesheet under the pinned typography floor", () => {
    // The size half of this law lives in typography-floor.test.ts, which pins
    // Studio's 8.5-11px reference type exactly. Deleting that entry would drop
    // the floor for the whole surface without any test going red, so the entry
    // itself is asserted here.
    const typographyFloor = readFileSync("lib/typography-floor.test.ts", "utf8");
    expect(typographyFloor).toContain(
      'file: "components/creatives/CreativeStudioExact.module.css"',
    );
  });
});
