/**
 * WP-26 step 4 / gate G10 — capture the canonical screenshot set.
 *
 * Frames come from the generated harness, so the set is deterministic and needs
 * no server. Each file is named and keyed by `LeafId + state + width + theme`,
 * which is what the plan requires and what the legacy five-name smoke set
 * cannot express.
 *
 * The run writes into a fresh `zero-base/<commit>/<artifact-set>/` directory and
 * refuses to touch a non-empty one, because the existing full-UI smoke deletes
 * its target before capture and evidence there may already be cited.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

import { renderFingerprint } from "../../lib/zero-base/render-provenance";
import { DESIGN_ZIP_SHA256 } from "../../scripts/zero-base/extract-design-reference";
import {
  artifactSetPath,
  buildManifest,
  currentCommit,
  prepareArtifactDir,
  sha256,
  writeManifest,
  type ManifestEntry,
} from "../../lib/zero-base/visual-manifest";

const HARNESS = path.resolve(process.cwd(), "playwright/.harness");
const ARTIFACT_ROOT = path.resolve(process.cwd(), "playwright/artifacts");

/**
 * Harness file names carry the surface, width and theme; the leaf they stand
 * for is declared here so the manifest key is a real LeafId rather than a
 * filename. A surface with no dedicated harness page is captured under the
 * shell leaf it renders inside.
 */
const SURFACE_TO_LEAF: Record<string, { leaf: string; state: string }> = {
  shell: { leaf: "L-C-HOME", state: "shell-chrome" },
  home: { leaf: "L-C-HOME", state: "normal" },
  agency: { leaf: "L-AG-TODAY", state: "directory" },
  decisions: { leaf: "L-C-META-DEC", state: "lanes" },
  automation: { leaf: "L-C-META-AUTO", state: "normal" },
  // The mirror state: automation rendered from the shadow projection.
  "automation-mirror": { leaf: "L-C-META-AUTO", state: "mirror" },
  history: { leaf: "L-C-META-HIST", state: "normal" },
  intelligence: { leaf: "L-C-META-INTEL", state: "normal" },
  marketing: { leaf: "L-PUB-ROOT", state: "normal" },
  "ops-incident": { leaf: "L-OPS-INTEGRATIONS", state: "incident-path" },
  "public-share": { leaf: "L-SH-CREATIVE", state: "normal" },
  // A revoked or expired token must be indistinguishable from a fabricated one.
  "public-share-gone": { leaf: "L-SH-CREATIVE", state: "gone" },
};

interface HarnessFrame {
  file: string;
  surface: string;
  width: number;
  theme: "light" | "dark";
}

function harnessFrames(): HarnessFrame[] {
  return readdirSync(HARNESS)
    .filter((file) => file.endsWith(".html"))
    .map((file) => {
      const match = /^(.*)-(\d+)-(light|dark)\.html$/.exec(file);
      if (!match) return null;
      return {
        file,
        surface: match[1],
        width: Number(match[2]),
        theme: match[3] as "light" | "dark",
      };
    })
    .filter((frame): frame is HarnessFrame => frame !== null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

test("G10 capture the canonical screenshot manifest", async ({ page }) => {
  const artifactSet = process.env.ZERO_BASE_ARTIFACT_SET?.trim();
  test.skip(!artifactSet, "Set ZERO_BASE_ARTIFACT_SET to a new, recorded value to capture evidence.");

  const commit = currentCommit();
  const relative = artifactSetPath(commit, artifactSet!);
  const absolute = path.join(ARTIFACT_ROOT, relative);
  prepareArtifactDir(absolute);

  const frames = harnessFrames();
  expect(frames.length, "no harness frames to capture").toBeGreaterThan(0);

  const entries: ManifestEntry[] = [];
  for (const frame of frames) {
    const mapping = SURFACE_TO_LEAF[frame.surface];
    // An unmapped surface is a manifest gap, not something to quietly skip.
    expect(mapping, `harness surface "${frame.surface}" has no LeafId mapping`).toBeTruthy();

    await page.setViewportSize({ width: frame.width, height: 900 });
    await page.goto(`file://${path.join(HARNESS, frame.file)}`);

    const name = `${mapping.leaf}__${mapping.state}__${frame.width}__${frame.theme}.png`;
    const file = path.join(absolute, name);
    await page.screenshot({ path: file, fullPage: true });

    entries.push({
      leaf: mapping.leaf,
      state: mapping.state,
      width: frame.width,
      theme: frame.theme,
      file: name,
      sha256: sha256(file),
      bytes: statSync(file).size,
    });
  }

  const manifest = buildManifest({
    commit,
    wp: artifactSet!,
    // Stamped from the run, not from the clock inside a pure helper.
    createdAt: new Date().toISOString(),
    provenance: renderFingerprint(DESIGN_ZIP_SHA256),
    entries,
  });
  const manifestFile = writeManifest(absolute, manifest);

  // Every frame must be real: a zero-byte screenshot is not evidence.
  for (const entry of manifest.entries) {
    expect(entry.bytes, `${entry.file} is empty`).toBeGreaterThan(1000);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  // Both themes present, or the set cannot support G10's theme parity claim.
  const themes = new Set(manifest.entries.map((entry) => entry.theme));
  expect([...themes].sort()).toEqual(["dark", "light"]);

  console.log(`captured ${manifest.entries.length} frames → ${manifestFile}`);
});
