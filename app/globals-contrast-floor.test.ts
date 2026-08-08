import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");

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

/** First declaration wins here: the light theme is declared before the dark overrides. */
function lightToken(name: string): string {
  const match = css.match(new RegExp(`--${name}: *(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`--${name} not found in globals.css`);
  return match[1];
}

/**
 * The console's own surfaces. Text tokens are checked against all of them
 * because a token that only passes on white still fails wherever the shell
 * tints its background.
 */
const LIGHT_SURFACES = ["adc-s1", "adc-s2", "adc-s3"] as const;

describe("console text tokens meet the contrast floor", () => {
  it("keeps every light-theme ink token at 4.5:1 on every light surface", () => {
    for (const ink of ["adc-ink", "adc-ink2", "adc-ink3"]) {
      for (const surface of LIGHT_SURFACES) {
        const ratio = contrastRatio(lightToken(ink), lightToken(surface));
        expect(ratio, `--${ink} on --${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("keeps the quietest text token usable, not merely present", () => {
    // Regression guard: --adc-ink3 was #7d838c, which measured 3.26–3.82:1
    // across these surfaces while carrying labels and secondary values.
    expect(contrastRatio(lightToken("adc-ink3"), lightToken("adc-s3"))).toBeGreaterThanOrEqual(4.5);
  });

  it("still declares a distinct dark palette rather than reusing light values", () => {
    const inkThreeValues = [...css.matchAll(/--adc-ink3: *(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
    expect(new Set(inkThreeValues).size).toBeGreaterThan(1);
  });
});
