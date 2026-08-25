/**
 * WP17's saved screenshot matrix, from the mounted routes.
 *
 * D13's runtime gate already proves that real content stays reachable at every
 * width — that is `meta-runtime-a11y.spec.ts`, and it asserts rather than
 * photographs. This is the other half of the acceptance item: the saved
 * artefact, so a person can look at what the assertions were made about.
 *
 * Thirteen surfaces × five widths × two themes. The matrix is enumerated rather
 * than sampled, because a sampled matrix answers "we checked some" to a question
 * that was "at which widths does this hold".
 *
 * ## Why a set name is required
 *
 * Written under a caller-supplied set, and skipped without one. Every artifact
 * writer in this repo that wipes its own directory on each run has, at least
 * once, deleted committed evidence — so this refuses to run rather than choose
 * a name for you. Two runs at the same code with different names sit side by
 * side; two runs with the same name are the same claim recaptured, which is
 * what the caller asked for by reusing it.
 *
 * ## What this is NOT
 *
 * It is not a visual-regression comparison. Nothing here diffs against a
 * baseline; a screenshot that changed is not a failure, it is a screenshot. The
 * pixel-level oracles are the zero-base visual and fidelity gates, which run
 * against the hash-bound design package. This exists so the responsive claim
 * has something behind it that a human can open.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { canonicalRoutesFor, openSurface, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

/** The widths WP17 names, narrowest last so a squeeze reads in file order. */
const WIDTHS = [1440, 1024, 768, 390, 320] as const;
const THEMES = ["light", "dark"] as const;

const SET = process.env.META_RUNTIME_SCREENSHOT_SET?.trim();

const OUT = SET
  ? path.join(process.cwd(), "playwright", "artifacts", "meta-runtime", SET)
  : null;

interface Captured {
  surfaceId: string;
  width: number;
  theme: string;
  file: string;
  sha256: string;
  bytes: number;
}

const captured: Captured[] = [];

test.describe("the responsive matrix, saved", () => {
  test.skip(
    !SET,
    "Set META_RUNTIME_SCREENSHOT_SET to a new, recorded name to capture evidence.",
  );

  for (const route of routes) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        test(`${route.surfaceId} — ${width}px ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: theme });
          await openSurface(page, handle, route.path);

          const name = `${route.surfaceId}-${width}-${theme}.png`;
          const file = path.join(OUT!, name);
          mkdirSync(OUT!, { recursive: true });
          await page.screenshot({ path: file, fullPage: true });

          /*
           * A digest per file, in the manifest below. Without one a directory of
           * PNGs is a directory of PNGs: nothing ties an image to the run that
           * produced it, and a stale file left behind by an earlier capture is
           * indistinguishable from a fresh one.
           */
          const bytes = readFileSync(file);
          captured.push({
            surfaceId: route.surfaceId,
            width,
            theme,
            file: name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.byteLength,
          });

          // A blank or near-blank capture is a failed capture wearing a PNG
          // extension, and would sit in the evidence directory looking complete.
          expect(bytes.byteLength, `${name} is too small to be a rendered page`).
            toBeGreaterThan(4096);
        });
      }
    }
  }

  test.afterAll(() => {
    if (!OUT || captured.length === 0) return;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      path.join(OUT, "manifest.json"),
      `${JSON.stringify(
        {
          set: SET,
          surfaces: routes.length,
          widths: WIDTHS,
          themes: THEMES,
          expected: routes.length * WIDTHS.length * THEMES.length,
          captured: captured.length,
          files: captured.sort((a, b) => a.file.localeCompare(b.file)),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });
});
