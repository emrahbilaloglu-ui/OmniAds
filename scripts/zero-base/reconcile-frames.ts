/**
 * WP-26 step 3 / gate G10 — H/B/P/M reconciliation.
 *
 * The denominators are not invented here. They are read from the vendored design
 * package's own audit (`docs/zero-base-design/v3/export/audit.json`), which
 * states `frames: { H: 66, B: 9, P: 8, M: 9 }` — 92 reference frames in total,
 * exactly the sets §13.4 of the plan enumerates.
 *
 * The numerator is the canonical screenshot manifest produced by WP-26 step 4.
 * Each captured frame declares the LeafId and state it stands for; the crosswalk
 * below maps design frame ids onto those pairs.
 *
 * This script exists to report a gap accurately, not to make one disappear. An
 * unmapped frame is printed with its id, and the coverage figure is the honest
 * ratio. Nothing here marks G10 green.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { FRAMES } from "@/scripts/zero-base/frame-registry";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACTS = path.join(ROOT, "playwright", "artifacts", "zero-base");

/** Frame denominators, read from the design package rather than hardcoded. */
export function frameDenominators(): Record<"H" | "B" | "P" | "M", number> {
  const audit = JSON.parse(
    readFileSync(path.join(ROOT, "docs", "zero-base-design", "v3", "export", "audit.json"), "utf8"),
  ) as { counts?: { frames?: Record<string, number> } };
  const frames = audit.counts?.frames;
  if (!frames) throw new Error("audit.json carries no frame counts");
  return { H: frames.H, B: frames.B, P: frames.P, M: frames.M } as Record<"H" | "B" | "P" | "M", number>;
}

export function allFrameIds(): string[] {
  const counts = frameDenominators();
  const ids: string[] = [];
  for (const [prefix, total] of Object.entries(counts)) {
    for (let index = 1; index <= total; index += 1) {
      ids.push(`${prefix}${String(index).padStart(2, "0")}`);
    }
  }
  return ids;
}

/**
 * Design frame → the captured (leaf, state) that evidences it.
 *
 * Taken from §13.4's own crosswalk. Only frames whose surface this programme has
 * actually built and captured appear; everything else is deliberately absent so
 * it shows up as a gap rather than as a fabricated mapping.
 */
/**
 * The crosswalk now lives in `scripts/zero-base/frame-registry.tsx`, next to the
 * code that renders each state, so a frame cannot be listed here without a
 * renderable state existing for it.
 */
export function crosswalk(): Record<string, { leaf: string; state: string }> {
  const entries: Record<string, { leaf: string; state: string }> = {};
  for (const spec of FRAMES) entries[spec.id] = { leaf: spec.leaf, state: spec.state };
  return entries;
}

interface ManifestEntry {
  leaf: string;
  state: string;
  width: number;
  theme: string;
  file: string;
  sha256: string;
}

/** The most recent captured artifact set, with its path. */
export function latestManifest(): { dir: string; entries: ManifestEntry[] } | null {
  if (!existsSync(ARTIFACTS)) return null;
  const candidates: string[] = [];
  for (const commit of readdirSync(ARTIFACTS)) {
    const commitDir = path.join(ARTIFACTS, commit);
    for (const set of readdirSync(commitDir)) {
      const manifest = path.join(commitDir, set, "manifest.json");
      if (existsSync(manifest)) candidates.push(manifest);
    }
  }
  if (candidates.length === 0) return null;
  // Newest wins. Sorting by name picked whichever artifact set happened to sort
  // last, which was not necessarily the run that just captured.
  const chosen = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const parsed = JSON.parse(readFileSync(chosen, "utf8")) as { entries: ManifestEntry[] };
  return { dir: path.relative(ROOT, path.dirname(chosen)), entries: parsed.entries };
}

export interface Reconciliation {
  totals: Record<string, number>;
  mapped: string[];
  unmapped: string[];
  /** Mapped but with no matching capture in the manifest. */
  missingEvidence: string[];
  evidenceDir: string | null;
}

export function reconcile(): Reconciliation {
  const manifest = latestManifest();
  // Frame captures record their leaf as `${frameId}:${LeafId}`, so identity is
  // checked per reference rather than per surface.
  const captured = new Set(
    (manifest?.entries ?? []).map((entry) => `${entry.leaf}__${entry.state}`),
  );

  const mapped: string[] = [];
  const unmapped: string[] = [];
  const missingEvidence: string[] = [];

  const map = crosswalk();
  for (const frame of allFrameIds()) {
    const mapping = map[frame];
    if (!mapping) {
      unmapped.push(frame);
      continue;
    }
    if (captured.has(`${frame}:${mapping.leaf}__${mapping.state}`)) mapped.push(frame);
    else missingEvidence.push(frame);
  }

  const counts = frameDenominators();
  return {
    totals: { ...counts, all: allFrameIds().length },
    mapped,
    unmapped,
    missingEvidence,
    evidenceDir: manifest?.dir ?? null,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = reconcile();

  console.log("zero-base H/B/P/M reconciliation (WP-26 step 3 / G10)\n");
  console.log(
    `  denominators (from the design package's own audit): H ${result.totals.H} · B ${result.totals.B} · ` +
      `P ${result.totals.P} · M ${result.totals.M}  =  ${result.totals.all}`,
  );
  console.log(`  evidence set: ${result.evidenceDir ?? "(none captured)"}\n`);

  console.log(`  frames with a crosswalk AND a captured frame   ${result.mapped.length}`);
  console.log(`  frames with a crosswalk but no capture          ${result.missingEvidence.length}`);
  console.log(`  frames with no crosswalk at all                 ${result.unmapped.length}\n`);

  if (result.mapped.length > 0) {
    console.log(`  evidenced: ${result.mapped.join(", ")}\n`);
  }
  if (result.missingEvidence.length > 0) {
    console.log(`  mapped but unevidenced: ${result.missingEvidence.join(", ")}\n`);
  }

  const coverage = (result.mapped.length / result.totals.all) * 100;
  console.log(`  RECONCILED: ${result.mapped.length}/${result.totals.all} (${coverage.toFixed(1)}%)`);

  if (result.unmapped.length > 0) {
    console.log(`\n  unmapped (${result.unmapped.length}): ${result.unmapped.join(", ")}`);
  }
  if (result.missingEvidence.length > 0) {
    console.log(`\n  mapped but unevidenced (${result.missingEvidence.length}): ${result.missingEvidence.join(", ")}`);
  }

  // Fail closed. G10 needs the full denominator, and a reconciler that reports
  // 14% while exiting zero would let the release aggregate go green over it.
  if (result.mapped.length < result.totals.all) {
    console.log(
      `\nFAIL: G10 requires ${result.totals.all}/${result.totals.all}. Every frame must resolve to a\n` +
        "captured artifact or to an explicit, plan-authorized no-frame contract.",
    );
    process.exit(1);
  }
  console.log(`\nPASS: all ${result.totals.all} reference frames resolve to captured evidence.`);
}
