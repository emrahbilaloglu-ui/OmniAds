/**
 * WP-26 / G10 — binding captured evidence to the tree that produced it.
 *
 * A screenshot manifest that records only its commit proves nothing once the
 * commit moves on. That is exactly what happened: 92 frames were captured at
 * one commit, thirteen render-affecting files changed in the next, and the gate
 * stayed green because it selected the newest artifact set on disk by mtime.
 * The evidence described a render tree that no longer existed.
 *
 * So provenance is bound to **content**, not to a commit id:
 *
 * - Every file that can change a rendered frame is hashed, and the manifest
 *   records both the per-file digests and their combined digest.
 * - The reconciler recomputes the digest against the working tree. A mismatch
 *   fails and names the files that moved.
 *
 * Binding by content rather than by commit gives the right answer to the case
 * the plan calls out: an artifact-only or report-only commit after capture
 * leaves the digest unchanged and passes, because nothing that renders moved.
 * A component, token, copy, fixture, harness or dependency change does not.
 *
 * The accepted design archive's own SHA-256 is recorded alongside, because a
 * capture is only evidence against the reference it was compared to.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/**
 * Everything that can change what a captured frame looks like.
 *
 * Directories are walked; files are taken as they are. The list is deliberately
 * wider than "the components in the shot": a token, a copy string, a fixture, a
 * harness change or a dependency bump all move pixels, and a fingerprint that
 * ignored them would be a fingerprint of the wrong thing.
 */
export const RENDER_SOURCE_PATHS: readonly string[] = [
  // The rendered surfaces themselves.
  "components/zero-base",
  // View models, adapters, contracts and the copy catalogue.
  "lib/zero-base",
  "lib/design",
  // Tokens and the canonical stylesheet.
  "app/globals.css",
  /*
   * Production visual owners the harness reaches, or is being repointed at.
   *
   * D2 makes these the pixel owners, and a fingerprint that ignored them would
   * be a fingerprint of the wrong thing: editing the mounted Automation body
   * would leave the hash unchanged and a stale capture would pass as current
   * evidence — precisely the failure this file exists to kill, re-created on
   * the other side. Named narrowly rather than as `components/meta`, because
   * the wider the walk the more often an unrelated edit invalidates the
   * 92-frame capture set.
   */
  "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
  "components/meta/decision-center",
  "components/meta/redesign",
  // The harness: registry, shell wrapper and the renderer.
  "scripts/zero-base/build-shell-harness.tsx",
  "scripts/zero-base/frame-registry.tsx",
  "scripts/zero-base/frame-shell.tsx",
  "scripts/zero-base/build-frame-harness.tsx",
  "scripts/zero-base/extract-design-reference.ts",
  // Dependencies. A React or Radix bump changes markup.
  "pnpm-lock.yaml",
];

/** Files inside the walked directories that cannot affect a rendered frame. */
function isIgnored(relative: string): boolean {
  return (
    /\.test\.[jt]sx?$/.test(relative) ||
    /\.spec\.[jt]sx?$/.test(relative) ||
    relative.endsWith(".d.ts") ||
    relative.includes("/__snapshots__/")
  );
}

function walk(absolute: string, out: string[]): void {
  for (const entry of readdirSync(absolute).sort()) {
    const full = path.join(absolute, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export interface RenderFingerprint {
  /** Combined digest over every render-affecting file, path-ordered. */
  digest: string;
  /** Per-file digests, so a mismatch can name what moved. */
  files: Record<string, string>;
  /** SHA-256 of the accepted design archive this capture was compared to. */
  referenceSha256: string;
}

export function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Hash the render-affecting tree as it stands right now. */
export function renderFingerprint(referenceSha256: string): RenderFingerprint {
  const files: Record<string, string> = {};

  for (const entry of RENDER_SOURCE_PATHS) {
    const absolute = path.join(ROOT, entry);
    if (!existsSync(absolute)) continue;
    const found: string[] = [];
    if (statSync(absolute).isDirectory()) walk(absolute, found);
    else found.push(absolute);

    for (const file of found) {
      const relative = path.relative(ROOT, file);
      if (isIgnored(relative)) continue;
      files[relative] = sha256(readFileSync(file));
    }
  }

  // Path-ordered so the digest is stable across filesystems.
  const combined = Object.keys(files)
    .sort()
    .map((relative) => `${relative}:${files[relative]}`)
    .join("\n");

  return { digest: sha256(`${referenceSha256}\n${combined}`), files, referenceSha256 };
}

export interface FingerprintDrift {
  changed: string[];
  added: string[];
  removed: string[];
  referenceChanged: boolean;
}

export function compareFingerprints(
  recorded: RenderFingerprint,
  current: RenderFingerprint,
): FingerprintDrift {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [file, digest] of Object.entries(recorded.files)) {
    if (!(file in current.files)) removed.push(file);
    else if (current.files[file] !== digest) changed.push(file);
  }
  const added = Object.keys(current.files).filter((file) => !(file in recorded.files));

  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    referenceChanged: recorded.referenceSha256 !== current.referenceSha256,
  };
}

export function isStale(drift: FingerprintDrift): boolean {
  return (
    drift.changed.length > 0 ||
    drift.added.length > 0 ||
    drift.removed.length > 0 ||
    drift.referenceChanged
  );
}

/** A human-readable account of why a capture no longer describes the tree. */
export function describeDrift(drift: FingerprintDrift): string[] {
  const lines: string[] = [];
  if (drift.referenceChanged) {
    lines.push("the accepted design archive changed since this capture");
  }
  for (const file of drift.changed) lines.push(`changed since capture: ${file}`);
  for (const file of drift.added) lines.push(`added since capture:   ${file}`);
  for (const file of drift.removed) lines.push(`removed since capture: ${file}`);
  return lines;
}
