/**
 * WP-26 step 5 gate: no product copy below 12 px, no failing contrast pair.
 *
 * Two independent checks, both against real sources rather than a list of
 * values someone typed here:
 *
 * 1. **Type floor.** Every `fontSize:` literal in the shipped zero-base
 *    components must be at least 12. The plan's rule is about product copy, and
 *    in this codebase every such literal is copy — the primitives carry no
 *    decorative text — so the scan is the whole surface rather than a sample.
 *
 * 2. **Contrast.** The `--ledger-*` colours are parsed out of `app/globals.css`
 *    itself, for both themes, and every ink/background pair a surface can
 *    actually produce is measured with the WCAG 2.1 relative-luminance formula.
 *    Hard-coding the hexes here would let the stylesheet drift away from its own
 *    gate.
 *
 * Exit code is non-zero on any violation, so it can sit in `test:zero-base:a11y`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The plan's minimum product-copy size, in px. */
export const MIN_PRODUCT_COPY_PX = 12;

/** WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text and UI boundaries. */
export const MIN_CONTRAST_TEXT = 4.5;
export const MIN_CONTRAST_LARGE = 3;

/* ------------------------------------------------------------- type floor */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

export interface TypeViolation {
  file: string;
  line: number;
  size: number;
}

export function findSmallCopy(root = path.join(ROOT, "components", "zero-base")): TypeViolation[] {
  const violations: TypeViolation[] = [];
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = /fontSize:\s*(\d+(?:\.\d+)?)/.exec(line);
      if (!match) return;
      const size = Number(match[1]);
      if (size < MIN_PRODUCT_COPY_PX) {
        violations.push({ file: path.relative(ROOT, file), line: index + 1, size });
      }
    });
  }
  return violations;
}

/* --------------------------------------------------------------- contrast */

export function parseLedgerTokens(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const readBlock = (startIndex: number): Record<string, string> => {
    const end = css.indexOf("}", startIndex);
    const block = css.slice(startIndex, end);
    const tokens: Record<string, string> = {};
    for (const [, name, value] of block.matchAll(/(--ledger-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
      tokens[name] = value;
    }
    return tokens;
  };

  const lightStart = css.indexOf('[data-adc-ui="zero-base"] {');
  if (lightStart < 0) throw new Error("Ledger light token block not found in globals.css");
  const light = readBlock(lightStart);

  // The dark block re-declares the same names under a theme selector.
  const darkStart = css.indexOf("--ledger-bg-surface", css.indexOf("dark", lightStart));
  const dark = darkStart > 0 ? readBlock(css.lastIndexOf("{", darkStart)) : {};

  return { light, dark };
}

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Ink tokens that render copy, and the surfaces they render on. */
const INK_TOKENS = [
  "--ledger-ink-primary",
  "--ledger-ink-secondary",
  "--ledger-ink-tertiary",
  "--ledger-ink-quiet",
  "--ledger-semantic-warn",
  "--ledger-semantic-danger",
  "--ledger-semantic-ok",
  "--ledger-accent-action",
  "--ledger-state-withheld",
  "--ledger-lane-act-now",
  "--ledger-lane-monitor",
  "--ledger-lane-resolve",
] as const;

const SURFACE_TOKENS = ["--ledger-bg-app", "--ledger-bg-surface", "--ledger-bg-inset"] as const;

export interface ContrastViolation {
  theme: string;
  ink: string;
  surface: string;
  ratio: number;
}

export function findContrastFailures(
  tokens: Record<string, string>,
  theme: string,
  threshold = MIN_CONTRAST_TEXT,
): ContrastViolation[] {
  const failures: ContrastViolation[] = [];
  for (const ink of INK_TOKENS) {
    for (const surface of SURFACE_TOKENS) {
      const inkHex = tokens[ink];
      const surfaceHex = tokens[surface];
      if (!inkHex || !surfaceHex) continue;
      const ratio = contrastRatio(inkHex, surfaceHex);
      if (ratio < threshold) failures.push({ theme, ink, surface, ratio });
    }
  }
  return failures;
}

/* ------------------------------------------------------------------- main */

export function runLegibilityCheck(): { typeViolations: TypeViolation[]; contrastViolations: ContrastViolation[] } {
  const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const { light, dark } = parseLedgerTokens(css);
  return {
    typeViolations: findSmallCopy(),
    contrastViolations: [
      ...findContrastFailures(light, "light"),
      ...findContrastFailures(dark, "dark"),
    ],
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { typeViolations, contrastViolations } = runLegibilityCheck();
  console.log("zero-base legibility gate (WP-26 step 5)\n");

  if (typeViolations.length === 0) {
    console.log(`  ok    no product copy below ${MIN_PRODUCT_COPY_PX}px`);
  } else {
    console.log(`  FAIL  ${typeViolations.length} copy declarations below ${MIN_PRODUCT_COPY_PX}px:`);
    for (const violation of typeViolations) {
      console.log(`        ${violation.file}:${violation.line} — ${violation.size}px`);
    }
  }

  if (contrastViolations.length === 0) {
    console.log(`  ok    every ink/surface pair meets ${MIN_CONTRAST_TEXT}:1 in both themes`);
  } else {
    console.log(`  FAIL  ${contrastViolations.length} contrast pairs below ${MIN_CONTRAST_TEXT}:1:`);
    for (const violation of contrastViolations) {
      console.log(
        `        [${violation.theme}] ${violation.ink} on ${violation.surface} — ${violation.ratio.toFixed(2)}:1`,
      );
    }
  }

  if (typeViolations.length > 0 || contrastViolations.length > 0) process.exit(1);
  console.log("\nPASS: type floor and contrast hold in both themes.");
}
