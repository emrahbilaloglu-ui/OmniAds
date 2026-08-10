import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The console's text tokens must actually be readable.
 *
 * `.ad-console-shell` publishes a short alias layer -- `--ink`, `--ink-2`,
 * `--ink-3`, `--muted`, `--muted-2` -- over the raw `--adc-*` palette, and
 * every surface in the app paints text through it. One of those aliases was
 * pointed at the wrong half of the palette:
 *
 *     --muted-2: var(--adc-b2);   // #cdcdc7 -- a hairline colour
 *
 * `--adc-b2` is a border shade. The very next line aliases the same value as
 * `--border-3`, which is what it is for. So twenty-five text sites -- the Meta
 * digest lines, scope-rail buttons, Launchpad metadata, and the Copies
 * `data as of ...` stamp that tells an operator how old the figures are --
 * were painting words in a colour meant for a one-pixel rule. Measured on the
 * Copies header that came out at 1.60:1.
 *
 * The name never hinted at it. `--muted-2` sits in the ink family and reads
 * like "a bit quieter than --muted", so every call site was written in good
 * faith. Only resolving the alias reveals it, which is exactly what a naming
 * convention cannot catch and this test can.
 *
 * So this asserts the property that matters rather than the spelling: resolve
 * each text alias to its literal colour and require it to stay legible on the
 * lightest surface the console paints on. An alias pointed at a border token
 * fails here on contrast, whatever it is called.
 */

const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/**
 * Read only the block that actually publishes the aliases.
 *
 * `--muted` is defined five times across this file -- twice by the shadcn
 * layer, twice by earlier console scopes, and once here. A file-wide search
 * finds the shadcn one first and reports `--muted` as a near-white surface at
 * 1.17:1, which is a true fact about a token nothing paints text with and a
 * false alarm about this one. Scoping to the declaring block is the difference
 * between measuring the defect and inventing one.
 */
function block(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} block not found`);
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i);
    }
  }
  throw new Error(`${selector} block is unterminated`);
}

const ALIASES = block(".ad-final");

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (pair: string) => {
    const srgb = Number.parseInt(pair, 16) / 255;
    return srgb <= 0.03928
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  const r = channel(value.slice(0, 2));
  const g = channel(value.slice(2, 4));
  const b = channel(value.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The literal value of an `--adc-*` palette entry, light theme.
 *
 * The palette is declared light-first and re-declared under a dark media
 * query. The first declaration is the light one, and light is the only theme
 * the product actually ships a mechanism for, so that is what is asserted
 * here rather than a dark value no operator can currently reach.
 */
function paletteValue(name: string): string {
  const match = CSS.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`palette token ${name} is not defined`);
  return match[1];
}

/** What an alias points at, one hop, as a literal colour. */
function resolveAlias(name: string): { via: string; hex: string } {
  const match = ALIASES.match(
    new RegExp(`${name}:\\s*var\\((--adc-[a-z0-9-]+)\\)`),
  );
  if (!match) throw new Error(`alias ${name} is not defined as a var() alias`);
  return { via: match[1], hex: paletteValue(match[1]) };
}

/**
 * Aliases that paint words. Text at these sizes is essential content, not
 * decoration, so 4.5:1 is the floor.
 */
const TEXT_ALIASES = ["--ink", "--ink-2", "--ink-3", "--muted", "--muted-2"];

/**
 * The margin above 4.5 exists because the console does not paint on pure
 * white. Rows, tints, and cards sit a shade below `--adc-s2`, so a token that
 * only clears the bar against the lightest possible backdrop still fails
 * where the text actually lands.
 */
const TOKEN_FLOOR = 4.9;

describe("console ink aliases", () => {
  const surfaces = ["--adc-s1", "--adc-s2", "--adc-s3"].map(paletteValue);
  /** The lightest surface is the most forgiving backdrop; pass there at minimum. */
  const lightest = surfaces.reduce((best, hex) =>
    relativeLuminance(hex) > relativeLuminance(best) ? hex : best,
  );

  it.each(TEXT_ALIASES)("%s stays legible as text", (alias) => {
    const { hex } = resolveAlias(alias);
    expect(contrast(hex, lightest)).toBeGreaterThanOrEqual(TOKEN_FLOOR);
  });

  it("does not paint text with a border colour", () => {
    // Border tokens are legitimate -- as borders. `--border-3` aliases
    // `--adc-b2` deliberately and must keep doing so; the failure mode is a
    // *text* alias reaching into that half of the palette.
    const borderPalette = new Set(["--adc-b1", "--adc-b2"]);
    const offenders = TEXT_ALIASES.map((alias) => ({
      alias,
      ...resolveAlias(alias),
    })).filter((entry) => borderPalette.has(entry.via));

    expect(offenders).toEqual([]);
  });

  it("keeps the hairline alias available for hairlines", () => {
    // The two non-text users of the old value -- a 6px status dot and a dashed
    // SVG guide line -- moved to this alias. It must keep resolving to the
    // same colour so they render identically.
    expect(resolveAlias("--border-3").hex).toBe(paletteValue("--adc-b2"));
  });
});
