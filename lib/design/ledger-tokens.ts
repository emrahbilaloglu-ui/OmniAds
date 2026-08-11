/**
 * The Ledger visual system, as data.
 *
 * These are the design package's token values transcribed exactly. They live
 * in TypeScript rather than only in CSS so the contrast harness can check the
 * real shipped values instead of a copy that can drift: `app/globals.css`
 * emits its custom properties from this table, and a test asserts every
 * declared pair actually meets its ratio.
 *
 * Scope matters as much as value. Every token is emitted under
 * `[data-adc-ui="zero-base"]`, never `:root`, so 308 legacy components keep
 * the variables they already have. Removing the canonical root removes the
 * whole visual system with it.
 */

export const ZERO_BASE_ROOT_ATTRIBUTE = "data-adc-ui";
export const ZERO_BASE_ROOT_VALUE = "zero-base";
/** CSS selector for the canonical root. Nothing outside it is restyled. */
export const ZERO_BASE_ROOT_SELECTOR = `[${ZERO_BASE_ROOT_ATTRIBUTE}="${ZERO_BASE_ROOT_VALUE}"]`;

export type ThemeName = "light" | "dark";

/** Token name → hex. Names mirror the design's `bg/app`-style paths. */
export type LedgerPalette = Readonly<Record<string, string>>;

export const LIGHT_PALETTE = {
  "bg/app": "#f7f6f2",
  "bg/surface": "#fcfcf9",
  "bg/inset": "#f1efeb",
  "border/subtle": "#dfdcd6",
  "border/control": "#8c857c",
  "ink/primary": "#24201a",
  "ink/secondary": "#58514a",
  "ink/tertiary": "#635c55",
  "ink/quiet": "#6b645c",
  "accent/action": "#545e96",
  "accent/hover": "#444d84",
  "accent/tint": "#e3e8fe",
  "semantic/ok": "#33724c",
  "semantic/warn": "#6f4b00",
  "semantic/danger": "#96372b",
  "lane/act-now": "#8d4226",
  "lane/resolve": "#6f4b00",
  "lane/monitor": "#3c4f62",
  "state/withheld": "#7d3c66",
  "state/withheld-tint": "#f8edf3",
  "state/withheld-border": "#e3c8d8",
  "focus/ring": "#545e96",
} as const satisfies LedgerPalette;

/**
 * The design package's dark table is shorter than its light one: it omits
 * `accent/hover`, all three lanes, `ink/quiet` and the withheld border. Those
 * six are marked DERIVED below — they are ours, not transcribed, so they are
 * not presented as design values. Each was chosen on the family's own hue and
 * is held to the same requirement as its light counterpart by the contrast
 * test; the two decorative borders are excluded there for the same reason
 * `border/subtle` is.
 */
export const DARK_PALETTE = {
  "bg/app": "#1c1915",
  "bg/surface": "#24211d",
  "bg/inset": "#15120f",
  "border/subtle": "#3b3732",
  "border/control": "#79746d",
  "ink/primary": "#eae8e3",
  "ink/secondary": "#b4b0aa",
  "ink/tertiary": "#a29e96",
  "ink/quiet": "#a29e96", // DERIVED — matches ink/tertiary; dark needs no quieter step
  "accent/action": "#9ca7de",
  "accent/hover": "#b6bee8", // DERIVED — lighter on dark, mirroring light's darker hover
  "accent/tint": "#2a2e47",
  "semantic/ok": "#75be8f",
  "semantic/warn": "#dbb970",
  "semantic/danger": "#e6867a",
  "lane/act-now": "#e6a37a", // DERIVED
  "lane/resolve": "#dbb970", // DERIVED — shares the warn hue, as light does
  "lane/monitor": "#9fb4c8", // DERIVED
  "state/withheld": "#d9a3c6",
  "state/withheld-tint": "#2a1e27",
  "state/withheld-border": "#4a3541", // DERIVED — decorative, 1.43:1, mirrors light's 1.51:1
  "focus/ring": "#9ca7de",
} as const satisfies LedgerPalette;

export const PALETTES: Readonly<Record<ThemeName, LedgerPalette>> = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
};

/**
 * Type scale. `meta/12` is the floor — nothing in the product renders product
 * text below 12 px, which the harness enforces rather than trusting.
 */
export const TYPE_SCALE = [
  { token: "display/28", family: "sans", px: 28, lineHeight: 34, weight: 700, tracking: "-0.01em" },
  { token: "title/20", family: "sans", px: 20, lineHeight: 26, weight: 700, tracking: "-0.005em" },
  { token: "heading/16", family: "sans", px: 16, lineHeight: 22, weight: 600, tracking: "0" },
  { token: "body-strong/14", family: "sans", px: 14, lineHeight: 20, weight: 600, tracking: "0" },
  { token: "body/13", family: "sans", px: 13, lineHeight: 19, weight: 400, tracking: "0" },
  { token: "meta/12", family: "sans", px: 12, lineHeight: 16, weight: 500, tracking: "0.01em" },
  { token: "data/13", family: "mono", px: 13, lineHeight: 18, weight: 400, tracking: "0" },
  { token: "data-meta/12", family: "mono", px: 12, lineHeight: 16, weight: 400, tracking: "0.02em" },
] as const;

export const MIN_PRODUCT_TEXT_PX = 12;

/** 4-base spacing scale; page gutter 40 desktop / 16 mobile. */
export const SPACE_SCALE = [4, 8, 12, 16, 20, 24, 32, 40, 56] as const;

export const RADIUS = {
  chip: 4,
  input: 6,
  button: 7,
  card: 10,
  panel: 12,
  dialog: 14,
} as const;

export const FOCUS_RING = { width: 2, offset: 2 } as const;

/** Every pointer target ≥24×24 (WCAG 2.5.8); primary mobile controls ≥44. */
export const TARGET_SIZE = { minimum: 24, mobilePrimary: 44 } as const;

export const MOTION = {
  fastMs: 120,
  panelMs: 180,
  easing: "cubic-bezier(.2,.7,.3,1)",
  reducedMaxMs: 80,
} as const;

/**
 * Pairs that must meet a ratio, and the ratio each must meet.
 *
 * `border/subtle` is deliberately absent: it is a decorative divider, not a
 * boundary a user must perceive, so holding it to 3:1 would be a false claim.
 * Anything a user must perceive as a boundary uses `border/control`.
 */
export interface ContrastRequirement {
  readonly label: string;
  readonly foreground: keyof typeof LIGHT_PALETTE;
  readonly background: keyof typeof LIGHT_PALETTE;
  readonly ratio: number;
}

export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  { label: "body text on surface", foreground: "ink/primary", background: "bg/surface", ratio: 4.5 },
  { label: "body text on canvas", foreground: "ink/primary", background: "bg/app", ratio: 4.5 },
  { label: "supporting text", foreground: "ink/secondary", background: "bg/surface", ratio: 4.5 },
  { label: "supporting text on inset", foreground: "ink/secondary", background: "bg/inset", ratio: 4.5 },
  { label: "meta text", foreground: "ink/tertiary", background: "bg/surface", ratio: 4.5 },
  { label: "quietest text", foreground: "ink/quiet", background: "bg/surface", ratio: 4.5 },
  { label: "action", foreground: "accent/action", background: "bg/surface", ratio: 4.5 },
  { label: "action on tint", foreground: "accent/action", background: "accent/tint", ratio: 4.5 },
  { label: "verified", foreground: "semantic/ok", background: "bg/surface", ratio: 4.5 },
  { label: "caution", foreground: "semantic/warn", background: "bg/surface", ratio: 4.5 },
  { label: "danger", foreground: "semantic/danger", background: "bg/surface", ratio: 4.5 },
  { label: "lane act-now", foreground: "lane/act-now", background: "bg/surface", ratio: 4.5 },
  { label: "lane resolve", foreground: "lane/resolve", background: "bg/surface", ratio: 4.5 },
  { label: "lane monitor", foreground: "lane/monitor", background: "bg/surface", ratio: 4.5 },
  { label: "withheld", foreground: "state/withheld", background: "bg/surface", ratio: 4.5 },
  { label: "withheld on its tint", foreground: "state/withheld", background: "state/withheld-tint", ratio: 4.5 },
  // Non-text: a control boundary and a focus ring need 3:1, not 4.5:1.
  { label: "control boundary", foreground: "border/control", background: "bg/surface", ratio: 3 },
  { label: "focus ring", foreground: "focus/ring", background: "bg/surface", ratio: 3 },
  { label: "focus ring on canvas", foreground: "focus/ring", background: "bg/app", ratio: 3 },
];

function channelLuminance(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return (
    0.2126 * channelLuminance((value >> 16) & 255) +
    0.7152 * channelLuminance((value >> 8) & 255) +
    0.0722 * channelLuminance(value & 255)
  );
}

/** WCAG 2.x contrast ratio. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * `bg/app` → `--ledger-bg-app`.
 *
 * Deliberately NOT `--adc-*`: this repo already ships 25 `--adc-*` variables
 * for the legacy console shell (`.ad-console-shell`, `.ad-auth-page`,
 * `.ad-client-panel`). Reusing that prefix would make "every --adc- token is
 * zero-base" untestable, and a reader could not tell the two systems apart.
 * The font variables keep their mandated `--font-adc-*` names, which are free.
 */
export function cssVariableName(token: string): string {
  return `--ledger-${token.replace(/\//g, "-")}`;
}

/** Emits the custom-property block for one theme, sorted for stable diffs. */
export function paletteToCssDeclarations(palette: LedgerPalette): string[] {
  return Object.entries(palette)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([token, hex]) => `${cssVariableName(token)}: ${hex};`);
}
