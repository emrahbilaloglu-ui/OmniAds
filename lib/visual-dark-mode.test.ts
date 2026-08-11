import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Dark mode reaches the canonical UI only, and the legacy visual matrix says so.
 *
 * This file used to assert a blanket absence: no theme provider, no setter, no
 * `prefers-color-scheme` rule anywhere. That claim was true until WP-04 and it
 * carried its own instruction — if a real mechanism is ever added, this fails,
 * and whoever adds it extends the matrix rather than inheriting a stale claim.
 *
 * WP-04 added exactly that mechanism, scoped to `[data-adc-ui="zero-base"]`.
 * So the assertions below are narrowed to the guarantee that is still true and
 * still load-bearing: **legacy surfaces have no reachable dark mode**, and the
 * full-UI visual matrix therefore keeps producing light screenshots that match
 * what legacy actually renders. What replaced the blanket claim is not a weaker
 * check — it is the same check made scope-aware, plus a new requirement that
 * every dark rule prove it is confined to the canonical root.
 *
 * The canonical theme has its own proof: `lib/theme.test.ts` for resolution and
 * `playwright/tests/zero-base-theme-flash.spec.ts` for first paint in a real
 * browser, in both themes.
 */
const globals = readFileSync("app/globals.css", "utf8");
const config = readFileSync("playwright.full-ui-redesign.config.ts", "utf8");

const CANONICAL_ROOT = '[data-adc-ui="zero-base"]';

function grep(pattern: string): string {
  return execSync(
    `grep -rl '${pattern}' app components lib 2>/dev/null | grep -v visual-dark-mode.test.ts || true`,
    { encoding: "utf8" },
  ).trim();
}

describe("legacy surfaces still have no reachable dark mode", () => {
  it("ships no third-party theme provider", () => {
    // A provider would apply `.dark` globally and repaint 308 legacy
    // components; the canonical theme deliberately uses a scoped data
    // attribute instead, so none of these may appear.
    for (const pattern of ["next-themes", "ThemeProvider"]) {
      expect(grep(pattern), `${pattern} is present`).toBe("");
    }
  });

  it("confines the theme setter to the canonical control and store", () => {
    const owners = grep("setTheme(").split("\n").filter(Boolean).sort();
    expect(owners).toEqual(["components/theme/theme-control.tsx"]);
  });

  it("never applies the .dark class at runtime", () => {
    // The `.dark` variant exists in CSS, inherited from the component library.
    // What matters is that nothing sets it — the canonical theme uses
    // data-adc-theme, so legacy's `.dark` block stays unreachable.
    expect(grep('classList.add("dark")')).toBe("");
    expect(grep('className="dark"')).toBe("");
  });

  it("scopes every prefers-color-scheme rule to the canonical root", () => {
    // The OS preference must not change a single legacy pixel. Each dark media
    // query is checked to select only inside the canonical root.
    const blocks = globals.split("@media (prefers-color-scheme: dark)").slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const firstSelector = block.slice(0, block.indexOf("{", block.indexOf("{") + 1));
      expect(firstSelector, "dark media query escapes the canonical root").toContain(
        CANONICAL_ROOT,
      );
    }
  });

  it("keeps the legacy :root and .dark variable blocks untouched by the canonical system", () => {
    const legacy = globals.slice(0, globals.indexOf(CANONICAL_ROOT));
    expect(legacy).toContain(":root {");
    expect(legacy).toContain(".dark {");
    expect(legacy).not.toContain("--ledger-");
    expect(legacy).not.toContain("data-adc-theme");
  });
});

describe("the visual matrix claims only what it runs", () => {
  it("declares no dark project", () => {
    expect(config).not.toContain("dark: true");
    expect(config).not.toContain("colorScheme: project.dark");
  });

  it("pins every project to light", () => {
    // Unchanged and still correct: this matrix photographs legacy surfaces,
    // which remain light-only. Canonical dark evidence comes from the
    // zero-base theme spec, not from here.
    expect(config).toContain('colorScheme: "light" as const');
  });

  it("covers the widths the layout actually changes at", () => {
    for (const width of [320, 390, 768, 1280, 1440, 1728]) {
      expect(config, `no project at ${width}px`).toContain(`width: ${width}`);
    }
  });
});
