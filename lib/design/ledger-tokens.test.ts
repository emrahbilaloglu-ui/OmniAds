/**
 * The contrast harness and the scoping guard.
 *
 * Two independent jobs here. First, every declared contrast pair is *computed*
 * from the shipped hexes rather than trusted — a token table that claims 4.5:1
 * and delivers 4.1:1 is worse than no claim. Second, the tokens are asserted to
 * exist only under the canonical root, because the whole premise of WP-04 is
 * that 308 legacy components are not restyled.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRAST_REQUIREMENTS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  MIN_PRODUCT_TEXT_PX,
  PALETTES,
  TYPE_SCALE,
  ZERO_BASE_ROOT_SELECTOR,
  contrastRatio,
  cssVariableName,
  paletteToCssDeclarations,
} from "@/lib/design/ledger-tokens";

const GLOBALS = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

describe("Ledger contrast harness", () => {
  it("meets every declared ratio in both themes, computed from the shipped hexes", () => {
    const failures: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      const palette = PALETTES[theme];
      for (const requirement of CONTRAST_REQUIREMENTS) {
        const foreground = palette[requirement.foreground];
        const background = palette[requirement.background];
        const ratio = contrastRatio(foreground, background);
        if (ratio < requirement.ratio) {
          failures.push(
            `${theme} ${requirement.label}: ${ratio.toFixed(2)}:1 < ${requirement.ratio}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("holds text to 4.5:1 and non-text affordances to 3:1", () => {
    const text = CONTRAST_REQUIREMENTS.filter((r) => r.ratio === 4.5);
    const nonText = CONTRAST_REQUIREMENTS.filter((r) => r.ratio === 3);
    expect(text.length).toBeGreaterThan(10);
    expect(nonText.map((r) => r.label).sort()).toEqual([
      "control boundary",
      "focus ring",
      "focus ring on canvas",
    ]);
  });

  it("computes ratios correctly against known anchors", () => {
    // Sanity-checks the formula itself, so a broken helper cannot make the
    // suite above pass vacuously.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#000000"),
      10,
    );
  });

  it("excludes decorative dividers rather than making a false claim about them", () => {
    // border/subtle and the withheld panel edge are separation, not boundaries
    // a user must perceive; both sit near 1.4:1 and are deliberately unlisted.
    const listed = CONTRAST_REQUIREMENTS.map((r) => r.foreground);
    expect(listed).not.toContain("border/subtle");
    expect(listed).not.toContain("state/withheld-border");
    expect(contrastRatio(LIGHT_PALETTE["border/subtle"], LIGHT_PALETTE["bg/surface"])).toBeLessThan(3);
  });
});

describe("type scale", () => {
  it("never renders product text below the 12 px floor", () => {
    for (const entry of TYPE_SCALE) {
      expect(entry.px, entry.token).toBeGreaterThanOrEqual(MIN_PRODUCT_TEXT_PX);
    }
  });

  it("keeps line height above font size at every step", () => {
    for (const entry of TYPE_SCALE) {
      expect(entry.lineHeight, entry.token).toBeGreaterThan(entry.px);
    }
  });

  it("uses only the two Ledger families", () => {
    expect([...new Set(TYPE_SCALE.map((e) => e.family))].sort()).toEqual(["mono", "sans"]);
  });
});

describe("token/CSS parity", () => {
  it("emits every light token into globals.css exactly as the module defines it", () => {
    for (const declaration of paletteToCssDeclarations(LIGHT_PALETTE)) {
      expect(GLOBALS, declaration).toContain(declaration);
    }
  });

  it("emits every dark token into globals.css exactly as the module defines it", () => {
    for (const declaration of paletteToCssDeclarations(DARK_PALETTE)) {
      expect(GLOBALS, declaration).toContain(declaration);
    }
  });

  it("defines both themes for the same token set", () => {
    expect(Object.keys(LIGHT_PALETTE).sort()).toEqual(Object.keys(DARK_PALETTE).sort());
  });

  it("names variables predictably", () => {
    expect(cssVariableName("bg/app")).toBe("--ledger-bg-app");
    expect(cssVariableName("state/withheld-tint")).toBe("--ledger-state-withheld-tint");
  });
});

describe("scoping — legacy must not be restyled", () => {
  it("declares every Ledger token inside the canonical root, never at :root", () => {
    // Split on the canonical root marker; anything before the first occurrence
    // is legacy territory and must contain no Ledger token.
    const firstCanonical = GLOBALS.indexOf(ZERO_BASE_ROOT_SELECTOR);
    expect(firstCanonical).toBeGreaterThan(0);
    // The repo already ships 25 legacy --adc-* variables for .ad-console-shell,
    // so the canonical system uses --ledger-* and the boundary is checkable.
    expect(GLOBALS.slice(0, firstCanonical)).not.toContain("--ledger-");
  });

  it("remaps shadcn variables only inside the canonical root", () => {
    const canonicalBlock = GLOBALS.slice(GLOBALS.indexOf(ZERO_BASE_ROOT_SELECTOR));
    expect(canonicalBlock).toContain("--background: var(--ledger-bg-app);");
    expect(canonicalBlock).toContain("--ring: var(--ledger-focus-ring);");

    // The legacy :root block must still define them from its own values.
    const legacy = GLOBALS.slice(0, GLOBALS.indexOf(ZERO_BASE_ROOT_SELECTOR));
    expect(legacy).toContain(":root {");
    expect(legacy).toContain("--background: oklch(1 0 0);");
    expect(legacy).not.toContain("var(--ledger-");
  });

  it("scopes the focus ring and portal host to the canonical root", () => {
    expect(GLOBALS).toContain(`${ZERO_BASE_ROOT_SELECTOR} :focus-visible`);
    expect(GLOBALS).toContain(`${ZERO_BASE_ROOT_SELECTOR} .adc-portal-host`);
  });

  it("applies the dark palette only under an explicit or unset preference", () => {
    // An explicit light choice must never be overridden by the OS media query.
    expect(GLOBALS).toContain(`html:not([data-adc-theme]) ${ZERO_BASE_ROOT_SELECTOR}`);
    expect(GLOBALS).toContain(`[data-adc-theme="dark"] ${ZERO_BASE_ROOT_SELECTOR}`);
  });

  it("leaves the legacy --adc-* namespace entirely alone", () => {
    const firstCanonical = GLOBALS.indexOf(ZERO_BASE_ROOT_SELECTOR);
    const legacy = GLOBALS.slice(0, firstCanonical);
    const canonical = GLOBALS.slice(firstCanonical);
    const names = (text: string) =>
      new Set((text.match(/--adc-[a-z0-9-]+/g) ?? []).filter((n) => !n.startsWith("--adc-ui")));
    // Legacy still owns its 25 variables...
    expect(names(legacy).size).toBeGreaterThanOrEqual(20);
    // ...and the canonical block introduces none of its own into that prefix.
    expect([...names(canonical)]).toEqual([]);
  });

  it("uses the Ledger font variables rather than the legacy ones", () => {
    const canonicalBlock = GLOBALS.slice(GLOBALS.indexOf(ZERO_BASE_ROOT_SELECTOR));
    expect(canonicalBlock).toContain("var(--font-adc-sans)");
    expect(canonicalBlock).toContain("var(--font-adc-mono)");
  });
});
