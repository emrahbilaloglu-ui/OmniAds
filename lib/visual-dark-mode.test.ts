import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Dark mode is not user-exposed on this candidate, and the visual matrix says so
 * rather than running "dark" projects that render light.
 *
 * The stylesheet carries a `.dark` variant, inherited from the component
 * library. Nothing applies it: there is no theme toggle, no theme provider, and
 * no `prefers-color-scheme` rule, so a viewer cannot reach it and Playwright's
 * colorScheme preference changes nothing. Running a dark project would produce
 * light screenshots filed under a dark name — evidence that asserts the
 * opposite of what it shows.
 *
 * This test is the standing proof of that absence. If a real mechanism is ever
 * added, this fails, and whoever adds it has to extend the matrix rather than
 * inherit a stale claim.
 */
const globals = readFileSync("app/globals.css", "utf8");
const config = readFileSync("playwright.full-ui-redesign.config.ts", "utf8");

function grep(pattern: string): string {
  return execSync(
    `grep -rl '${pattern}' app components lib 2>/dev/null | grep -v visual-dark-mode.test.ts || true`,
    { encoding: "utf8" },
  ).trim();
}

describe("dark mode has no user-exposed mechanism", () => {
  it("ships no theme provider or theme setter", () => {
    for (const pattern of ["next-themes", "ThemeProvider", "setTheme("]) {
      expect(grep(pattern), `${pattern} is present`).toBe("");
    }
  });

  it("has no prefers-color-scheme rule, so the OS preference changes nothing", () => {
    expect(globals).not.toContain("prefers-color-scheme");
  });

  it("never applies the .dark class at runtime", () => {
    // The variant exists in CSS; what matters is that nothing sets it.
    for (const pattern of 'classList.add("dark")'.split("\n")) {
      expect(grep(pattern)).toBe("");
    }
    expect(grep('className="dark"')).toBe("");
  });
});

describe("the visual matrix claims only what it runs", () => {
  it("declares no dark project", () => {
    expect(config).not.toContain("dark: true");
    expect(config).not.toContain('colorScheme: project.dark');
  });

  it("pins every project to light", () => {
    expect(config).toContain('colorScheme: "light" as const');
  });

  it("covers the widths the layout actually changes at", () => {
    for (const width of [320, 390, 768, 1280, 1440, 1728]) {
      expect(config, `no project at ${width}px`).toContain(`width: ${width}`);
    }
  });
});
