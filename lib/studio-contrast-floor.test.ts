import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Creative Studio palette, checked as numbers rather than as intent.
 *
 * Studio defines its own scoped tokens rather than inheriting the console's,
 * so the earlier console-wide contrast pass never reached it. `--ink3` sat at
 * 3.82:1 on white and `--ink4` at 2.31:1, and both are used for essential
 * 12px text — the "Analyzing" line, dates, row metadata, the stacked mobile
 * labels, the per-creative counts. Those are not decoration; they are how a
 * buyer knows what account and window they are reading.
 *
 * A blind global override was the wrong fix, so the tokens are raised where
 * they carry information and a separate token exists for the genuinely
 * decorative case. The dark palette is checked too: nothing here claims a dark
 * mode ships, but the tokens exist and would be wrong the day one does.
 */
const source = readFileSync("components/creatives/StudioOsView.tsx", "utf8");

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const channel = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Reads a token out of a scoped block, so the test tracks the real palette. */
function token(scope: string, name: string): string {
  const block = source.slice(source.indexOf(scope));
  const match = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!match) throw new Error(`token --${name} not found in ${scope}`);
  return match[1].toLowerCase();
}

const LIGHT_SCOPE = ".studio-os{";
const DARK_SCOPE = ".studio-os.studio-dark{";
const ESSENTIAL_MIN = 4.5;

describe("essential Studio text clears the contrast floor", () => {
  it("light --ink3 is readable on the light surface", () => {
    const ratio = contrast(token(LIGHT_SCOPE, "ink3"), token(LIGHT_SCOPE, "s2"));
    expect(
      ratio,
      `--ink3 is ${ratio.toFixed(2)}:1 and carries essential 12px text`,
    ).toBeGreaterThanOrEqual(ESSENTIAL_MIN);
  });

  it("light --ink4 is readable on the light surface", () => {
    // 35 call sites, and the ones sampled are all informational: the row
    // metadata, the aggregation note, dates, counts.
    const ratio = contrast(token(LIGHT_SCOPE, "ink4"), token(LIGHT_SCOPE, "s2"));
    expect(
      ratio,
      `--ink4 is ${ratio.toFixed(2)}:1 and carries essential 12px text`,
    ).toBeGreaterThanOrEqual(ESSENTIAL_MIN);
  });

  it("dark --ink3 and --ink4 clear the floor on the dark surface", () => {
    for (const name of ["ink3", "ink4"]) {
      const ratio = contrast(token(DARK_SCOPE, name), token(DARK_SCOPE, "s2"));
      expect(ratio, `dark --${name} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        ESSENTIAL_MIN,
      );
    }
  });

  it("keeps a separate token for genuinely decorative text", () => {
    // The distinction has to be explicit. Without it, the next low-contrast
    // value gets justified as "decorative" after the fact.
    expect(source).toContain("--ink-decorative");
  });
});

describe("essential Studio text clears the size floor", () => {
  it("uses no font size below 12px", () => {
    const tooSmall = [
      ...source.matchAll(/fontSize:\s*(?:"|')?(\d+)(?:px)?(?:"|')?/g),
    ]
      .map((match) => Number(match[1]))
      .filter((size) => size > 0 && size < 12);
    expect(tooSmall, `sizes below 12px: ${tooSmall.join(", ")}`).toEqual([]);
  });

  it("uses no sub-12px Tailwind arbitrary size", () => {
    const arbitrary = [...source.matchAll(/text-\[(\d+)px\]/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size < 12);
    expect(arbitrary, `arbitrary sizes below 12px: ${arbitrary.join(", ")}`).toEqual(
      [],
    );
  });
});
