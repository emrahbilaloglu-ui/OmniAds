/**
 * WP-26 step 3/4 — capture and verify all 92 reference frames (G10).
 *
 * Each frame is rendered at its required width and theme, captured into a new
 * immutable artifact set, and then verified on every property that could
 * silently make the evidence worthless:
 *
 * - the page really carries this frame's id, leaf and state markers, so an
 *   image cannot be filed under the wrong reference;
 * - the capture has non-zero bytes and the exact pixel width the frame requires;
 * - the SHA-256 is recorded, and **no two frames may share one**, which is how a
 *   duplicated or copied screenshot is caught;
 * - the rendered surface carries the Ledger root, so a blank or unstyled page
 *   cannot pass as a rendered state.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

import { FRAMES, frameFileName } from "../../scripts/zero-base/frame-registry";
import {
  artifactSetPath,
  buildManifest,
  currentCommit,
  prepareArtifactDir,
  sha256,
  writeManifest,
  type ManifestEntry,
} from "../../lib/zero-base/visual-manifest";

const PAGES = path.resolve(process.cwd(), "playwright/.frames");
const ARTIFACT_ROOT = path.resolve(process.cwd(), "playwright/artifacts");

test("G10 capture and verify the 92 reference frames", async ({ page }) => {
  const artifactSet = process.env.ZERO_BASE_FRAME_SET?.trim();
  test.skip(!artifactSet, "Set ZERO_BASE_FRAME_SET to a new, recorded value to capture evidence.");

  const commit = currentCommit();
  const absolute = path.join(ARTIFACT_ROOT, artifactSetPath(commit, artifactSet!));
  prepareArtifactDir(absolute);

  expect(FRAMES.length, "the crosswalk must cover all 92 reference frames").toBe(92);

  const entries: ManifestEntry[] = [];
  const digests = new Map<string, string>();

  for (const spec of FRAMES) {
    const name = frameFileName(spec);
    await page.setViewportSize({ width: spec.width, height: 900 });
    await page.emulateMedia({ colorScheme: spec.theme });
    await page.goto(`file://${path.join(PAGES, `${name}.html`)}`);

    // Identity: this page is the frame it claims to be.
    const marker = page.locator(`[data-frame="${spec.id}"]`);
    await expect(marker, `${spec.id}: frame marker missing`).toHaveCount(1);
    await expect(marker).toHaveAttribute("data-frame-leaf", spec.leaf);
    await expect(marker).toHaveAttribute("data-frame-state", spec.state);
    // A rendered canonical surface, not a bare fragment.
    await expect(page.locator('[data-adc-ui="zero-base"]')).toHaveCount(1);
    // Non-empty: a blank page is not a state.
    const text = await page.evaluate(() => document.body.innerText.trim().length);
    expect(text, `${spec.id}: rendered no text`).toBeGreaterThan(0);

    const file = path.join(absolute, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });

    const bytes = statSync(file).size;
    expect(bytes, `${spec.id}: empty capture`).toBeGreaterThan(1000);

    // Actual pixel width must match the frame's required width.
    const png = readFileSync(file);
    const pixelWidth = png.readUInt32BE(16);
    const pixelHeight = png.readUInt32BE(20);
    expect(pixelWidth, `${spec.id}: captured at ${pixelWidth}px, required ${spec.width}px`).toBe(spec.width);
    expect(pixelHeight, `${spec.id}: zero height`).toBeGreaterThan(0);

    const digest = sha256(file);
    const clash = digests.get(digest);
    // Two frames with identical pixels means one is a copy of the other, which
    // is exactly the "distinct state per id" rule this gate exists to enforce.
    expect(clash, `${spec.id}: byte-identical to ${clash}`).toBeUndefined();
    digests.set(digest, spec.id);

    entries.push({
      leaf: `${spec.id}:${spec.leaf}`,
      state: spec.state,
      width: spec.width,
      theme: spec.theme,
      file: `${name}.png`,
      sha256: digest,
      bytes,
    });
  }

  const manifest = buildManifest({
    commit,
    wp: artifactSet!,
    createdAt: new Date().toISOString(),
    entries,
  });
  const manifestFile = writeManifest(absolute, manifest);

  expect(manifest.entries).toHaveLength(92);
  const themes = new Set(manifest.entries.map((entry) => entry.theme));
  expect([...themes].sort()).toEqual(["dark", "light"]);

  console.log(`captured and verified ${manifest.entries.length} frames → ${manifestFile}`);
});
