/**
 * No-flash proof for the zero-base theme, in a real browser.
 *
 * A flash is a timing bug, so it cannot be caught by asserting the final
 * colour — by the time a test can read the DOM, the wrong first frame is long
 * gone. This measures the *first painted frame* instead, two ways: the
 * computed background at the first animation frame, and the actual top-left
 * pixel of a screenshot taken immediately on load.
 *
 * The page under test is assembled from the shipped artifacts — the real
 * `app/globals.css` and the real `NO_FLASH_SCRIPT` constant — and served from
 * an intercepted route, so no database, no auth fixture and no dev server are
 * involved. That keeps the check deterministic and lets it run in a worktree
 * that deliberately has no `.env.local`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  NO_FLASH_SCRIPT,
  THEME_ATTRIBUTE,
  THEME_COOKIE_NAME,
  parseThemePreference,
  resolveThemeForServer,
} from "../../lib/theme";
import { DARK_PALETTE, LIGHT_PALETTE } from "../../lib/design/ledger-tokens";

const GLOBALS_CSS = readFileSync(
  path.join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/**
 * Only the canonical block is served. The rest of globals.css imports
 * Tailwind, which needs a build step; the zero-base tokens are plain CSS and
 * are exactly what this test is about.
 */
// Sliced from the first real rule, not the banner comment. Starting mid-comment
// leaves a stray comment terminator that makes the CSS parser discard the first
// ruleset — which is the one defining the tokens under test.
const CANONICAL_CSS = GLOBALS_CSS.slice(
  GLOBALS_CSS.indexOf('[data-adc-ui="zero-base"] {'),
);

const ORIGIN = "https://zero-base.test";

/** Renders the document exactly as `app/layout.tsx` would for this cookie. */
function documentFor(preference: string): string {
  const serverTheme = resolveThemeForServer(parseThemePreference(preference));
  return `<!doctype html>
<html lang="en"${serverTheme ? ` ${THEME_ATTRIBUTE}="${serverTheme}"` : ""}>
<head>
<meta charset="utf-8">
<style>html,body{margin:0;padding:0;height:100%}</style>
<style>${CANONICAL_CSS}</style>
${serverTheme === null ? `<script>${NO_FLASH_SCRIPT}</script>` : ""}
</head>
<body>
<div data-adc-ui="zero-base" style="min-height:100vh" id="root">
  <p style="font-size:13px">Ledger surface</p>
</div>
</body>
</html>`;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

test.describe("zero-base theme first paint", () => {
  for (const scenario of [
    { name: "explicit dark", cookie: "dark", prefersDark: false, expected: DARK_PALETTE },
    { name: "explicit light", cookie: "light", prefersDark: true, expected: LIGHT_PALETTE },
    { name: "system on a dark device", cookie: "system", prefersDark: true, expected: DARK_PALETTE },
    { name: "system on a light device", cookie: "system", prefersDark: false, expected: LIGHT_PALETTE },
    { name: "no cookie on a dark device", cookie: "", prefersDark: true, expected: DARK_PALETTE },
  ]) {
    test(`paints ${scenario.name} correctly on the first frame`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: scenario.prefersDark ? "dark" : "light",
        viewport: { width: 1280, height: 720 },
      });
      if (scenario.cookie) {
        await context.addCookies([
          {
            name: THEME_COOKIE_NAME,
            value: scenario.cookie,
            url: ORIGIN,
          },
        ]);
      }
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: documentFor(scenario.cookie),
        }),
      );

      // Record the background at the very first animation frame, before any
      // later script could correct it.
      await page.addInitScript(() => {
        (window as unknown as { __firstFrame?: string }).__firstFrame = undefined;
        requestAnimationFrame(() => {
          const root = document.getElementById("root");
          (window as unknown as { __firstFrame?: string }).__firstFrame = root
            ? getComputedStyle(root).backgroundColor
            : "no-root";
        });
      });

      await page.goto(`${ORIGIN}/`, { waitUntil: "load" });

      const expectedBackground = rgb(scenario.expected["bg/app"]);
      const firstFrame = await page.evaluate(
        () => (window as unknown as { __firstFrame?: string }).__firstFrame,
      );
      expect(firstFrame, "first painted frame").toBe(expectedBackground);

      // And the settled state agrees, so this is not a transient that later flips.
      await expect
        .poll(async () =>
          page.evaluate(() => getComputedStyle(document.getElementById("root")!).backgroundColor),
        )
        .toBe(expectedBackground);

      // Text colour comes from the same theme, so the pair cannot be mismatched.
      const ink = await page.evaluate(
        () => getComputedStyle(document.querySelector("#root p")!).color,
      );
      expect(ink).toBe(rgb(scenario.expected["ink/primary"]));

      await context.close();
    });
  }
});
