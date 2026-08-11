/**
 * WP-26 step 4 / gate G10 — canonical screenshot manifest helpers.
 *
 * The plan is unusually specific here, because the existing full-UI smoke has a
 * destructive habit: it recursively deletes its artifact directory before every
 * capture, so a reused set name destroys evidence Appendix C already cites.
 * Three rules follow, and this module enforces all three rather than trusting a
 * convention:
 *
 * 1. Every run writes under a **unique** `zero-base/<commit>/<wp-or-release>/`
 *    directory. The commit comes from `git rev-parse`, not from an argument, so
 *    two runs at the same commit and package collide deliberately and loudly
 *    instead of silently overwriting.
 * 2. Nothing is ever deleted. If the target directory exists and is non-empty,
 *    the run refuses.
 * 3. Entries are keyed by `LeafId + state + width + theme` — never by the
 *    legacy five-name set (`login`, `meta-decisions`, `creative-studio`,
 *    `launchpad`, `automation`), which the plan explicitly forbids as G10
 *    evidence. That name set is rejected by `assertNotLegacyNameSet`.
 *
 * The manifest records a SHA-256 for every captured file, so a later report can
 * cite evidence that can be checked rather than described.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RenderFingerprint } from "@/lib/zero-base/render-provenance";

/** Repo root. Resolved from cwd so this module stays CJS-safe for Playwright. */
const ROOT = process.cwd();

/** The five names the plan forbids as G10 proof. */
export const LEGACY_SMOKE_NAME_SET = [
  "login",
  "meta-decisions",
  "creative-studio",
  "launchpad",
  "automation",
] as const;

export interface ManifestEntry {
  leaf: string;
  state: string;
  width: number;
  theme: "light" | "dark";
  file: string;
  sha256: string;
  bytes: number;
}

export interface ScreenshotManifest {
  commit: string;
  package: string;
  createdAt: string;
  artifactSet: string;
  /**
   * The render-affecting tree this capture was taken from.
   *
   * Recorded so a later run can prove the evidence still describes the code,
   * rather than trusting that the commit has not moved on. See
   * `lib/zero-base/render-provenance.ts`.
   */
  provenance: RenderFingerprint;
  entries: ManifestEntry[];
}

export function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: ROOT }).toString().trim();
}

/** `zero-base/<commit>/<wp-or-release>/`, relative to the artifact root. */
export function artifactSetPath(commit: string, wp: string): string {
  return path.join("zero-base", commit, wp);
}

/**
 * Refuse to reuse the legacy five-name set.
 *
 * A manifest whose entries are exactly those names is the legacy smoke wearing
 * a new filename, and the plan rules it out as G10 evidence by name.
 */
export function assertNotLegacyNameSet(entries: readonly { leaf: string }[]): void {
  const names = new Set(entries.map((entry) => entry.leaf.toLowerCase()));
  const legacy = new Set<string>(LEGACY_SMOKE_NAME_SET);
  if (names.size === legacy.size && [...names].every((name) => legacy.has(name))) {
    throw new Error(
      "This manifest is the legacy five-name smoke set, which the plan forbids as G10 evidence. " +
        "Capture by LeafId + state + width + theme instead.",
    );
  }
}

/** Key for one captured frame. Collisions inside a run are a bug, not a merge. */
export function entryKey(entry: Pick<ManifestEntry, "leaf" | "state" | "width" | "theme">): string {
  return `${entry.leaf}__${entry.state}__${entry.width}__${entry.theme}`;
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Prepare a fresh artifact directory.
 *
 * Never deletes. A non-empty target is an error, because the only reason it
 * would already exist is that a previous run put cited evidence there.
 */
export function prepareArtifactDir(absolute: string): void {
  if (existsSync(absolute) && readdirSync(absolute).length > 0) {
    throw new Error(
      `Refusing to write into a non-empty artifact set: ${absolute}\n` +
        "Evidence here may already be cited. Use a new <wp-or-release> value.",
    );
  }
  mkdirSync(absolute, { recursive: true });
}

export function buildManifest(input: {
  commit: string;
  wp: string;
  createdAt: string;
  provenance: RenderFingerprint;
  entries: ManifestEntry[];
}): ScreenshotManifest {
  assertNotLegacyNameSet(input.entries);

  const seen = new Set<string>();
  for (const entry of input.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) {
      throw new Error(`Duplicate manifest key ${key}: one frame per LeafId+state+width+theme.`);
    }
    seen.add(key);
  }

  return {
    commit: input.commit,
    package: input.wp,
    createdAt: input.createdAt,
    artifactSet: artifactSetPath(input.commit, input.wp),
    provenance: input.provenance,
    entries: [...input.entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b))),
  };
}

export function writeManifest(absoluteDir: string, manifest: ScreenshotManifest): string {
  const file = path.join(absoluteDir, "manifest.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

