import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS_PATH = "components/meta/os/DecisionsOsView.module.css";
const css = readFileSync(CSS_PATH, "utf8");

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}: *(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token --${name} not found in ${CSS_PATH}`);
  return match[1];
}

const SURFACES = ["s1", "s2", "s3", "s4"] as const;

/**
 * The buyer's primary decision surface is where they spend hours a day. These
 * are the floors from the plan's experience system, asserted rather than
 * assumed: essential text at or above 11px, and any token carrying text at or
 * above 4.5:1 against every surface it can sit on.
 */
describe("Decisions surface typography floor", () => {
  it("has no essential text below 11px", () => {
    const sizes = [...css.matchAll(/font-size: ?([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 11)).toEqual([]);
  });

  it("uses the registered font variables rather than literal family names", () => {
    // next/font emits hashed family names, so a literal "IBM Plex Sans" never
    // matches and the surface silently falls back to system-ui.
    expect(css).not.toContain('"IBM Plex Sans"');
    expect(css).not.toContain('"IBM Plex Mono"');
    expect(css).toContain("var(--font-ibm-plex-sans)");
    expect(css).toContain("var(--font-ibm-plex-mono)");
  });
});

describe("Decisions surface contrast floor", () => {
  it("keeps every text-bearing ink token at 4.5:1 on all surfaces", () => {
    for (const inkName of ["ink", "ink2", "ink3"]) {
      for (const surfaceName of SURFACES) {
        const ratio = contrastRatio(token(inkName), token(surfaceName));
        expect(
          ratio,
          `--${inkName} on --${surfaceName} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the decorative token off text", () => {
    const textUses = css
      .split("\n")
      .filter((line) => line.includes("color: var(--ink4)"));
    // The chevron is a glyph with no reading content; nothing else may use it.
    expect(textUses.every((line) => line.includes(".rowChevron"))).toBe(true);
  });

  it("still recognises the decorative token as below the floor, by measurement", () => {
    expect(contrastRatio(token("ink4"), token("s2"))).toBeLessThan(4.5);
  });
});
