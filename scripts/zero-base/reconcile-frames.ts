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
// Must run before any component import: these read the real exact bodies, which
// import CSS modules (and next/image). Without the stub Node's CommonJS loader
// hands the stylesheet to the JavaScript parser and the gate dies at step one.
import "./css-module-stub";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { FRAMES, SUBSTITUTED_FRAMES } from "@/scripts/zero-base/frame-registry";
import { compareAnatomy } from "@/scripts/zero-base/verify-reference-anatomy";
import { DESIGN_ZIP_SHA256 } from "@/scripts/zero-base/extract-design-reference";
import {
  compareFingerprints,
  describeDrift,
  renderFingerprint,
  type RenderFingerprint,
} from "@/lib/zero-base/render-provenance";
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

export interface ManifestSelection {
  dir: string;
  entries: ManifestEntry[];
  /** Non-empty when the chosen set no longer describes the working tree. */
  drift: string[];
  /** Every set on disk, for the "which one did you mean" failure. */
  candidates: string[];
}

/**
 * The captured set that actually describes the current tree.
 *
 * Selection used to be "newest manifest.json by mtime", which is how 92
 * screenshots taken before thirteen render-affecting files changed went on
 * passing as current evidence. Recency is not provenance.
 *
 * Now every candidate is checked against a content fingerprint of the
 * render-affecting tree and the accepted archive's digest. Exactly one set must
 * match. Zero matches is stale evidence; more than one means two sets claim the
 * same tree and the run cannot tell which was verified, so both are refused.
 */
/** `<FrameId>:<LeafId>` — how a frame capture records its leaf. */
const FRAME_ENTRY_LEAF = /^[HBPM]\d\d:/;

export function selectManifest(): ManifestSelection | null {
  if (!existsSync(ARTIFACTS)) return null;
  const candidates: string[] = [];
  for (const commit of readdirSync(ARTIFACTS)) {
    const commitDir = path.join(ARTIFACTS, commit);
    if (!statSync(commitDir).isDirectory()) continue;
    for (const set of readdirSync(commitDir)) {
      const manifest = path.join(commitDir, set, "manifest.json");
      if (existsSync(manifest)) candidates.push(manifest);
    }
  }
  if (candidates.length === 0) return null;

  const current = renderFingerprint(DESIGN_ZIP_SHA256);
  const relative = candidates.map((file) => path.relative(ROOT, path.dirname(file)));

  const matching = candidates.filter((file) => {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      provenance?: { digest?: string };
      entries?: { leaf?: string }[];
    };
    if (parsed.provenance?.digest !== current.digest) return false;
    /*
     * Frame captures only.
     *
     * The shell-visual gate writes its own manifest under the same
     * `<commit>/<set>` root, and at one tree both manifests carry the same
     * provenance digest — which read as "two sets claim this tree" and refused
     * a run whose evidence was in fact unambiguous. A frame capture records its
     * leaf as `<FrameId>:<LeafId>`; the shell capture records a bare LeafId.
     * That is a property of the evidence itself, not a naming convention, so it
     * cannot drift out of step with the sets on disk.
     */
    return (parsed.entries ?? []).every((entry) => FRAME_ENTRY_LEAF.test(entry.leaf ?? ""));
  });

  if (matching.length === 1) {
    const parsed = JSON.parse(readFileSync(matching[0], "utf8")) as { entries: ManifestEntry[] };
    return {
      dir: path.relative(ROOT, path.dirname(matching[0])),
      entries: parsed.entries,
      drift: [],
      candidates: relative,
    };
  }

  if (matching.length > 1) {
    return {
      dir: "",
      entries: [],
      drift: [
        `${matching.length} artifact sets claim this exact render tree. Evidence must be`,
        "unambiguous: remove the sets that are not the verified one.",
        ...matching.map((file) => `  ${path.relative(ROOT, path.dirname(file))}`),
      ],
      candidates: relative,
    };
  }

  // Nothing matches. Report the drift of the newest set, which is the one a
  // reader would otherwise have assumed was current.
  const newest = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const parsed = JSON.parse(readFileSync(newest, "utf8")) as {
    entries: ManifestEntry[];
    provenance?: RenderFingerprint;
  };
  const drift = parsed.provenance
    ? describeDrift(compareFingerprints(parsed.provenance, current))
    : ["this capture predates provenance recording and cannot be verified"];

  return {
    dir: path.relative(ROOT, path.dirname(newest)),
    entries: parsed.entries,
    drift,
    candidates: relative,
  };
}

export interface Reconciliation {
  totals: Record<string, number>;
  mapped: string[];
  unmapped: string[];
  /** Mapped but with no matching capture in the manifest. */
  missingEvidence: string[];
  evidenceDir: string | null;
  /** Why the selected evidence does not describe this tree. Empty when it does. */
  drift: string[];
}

export function reconcile(): Reconciliation {
  const manifest = selectManifest();
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
    drift: manifest?.drift ?? [],
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = reconcile();

  console.log("zero-base H/B/P/M reconciliation (WP-26 step 3 / G10)\n");

  // Provenance first. Everything below describes captured pixels, and pixels
  // captured from a different tree describe a product that no longer exists.
  if (result.drift.length > 0) {
    console.log(`  evidence set: ${result.evidenceDir ?? "(none)"}`);
    console.log("\n  STALE EVIDENCE — the captured frames do not describe this tree:\n");
    for (const line of result.drift.slice(0, 24)) console.log(`    ${line}`);
    if (result.drift.length > 24) {
      console.log(`    … and ${result.drift.length - 24} more`);
    }
    console.log(
      "\nFAIL: G10 evidence must be captured from the code under test. Recapture with:\n" +
        "  ZERO_BASE_FRAME_SET=<new-name> npx playwright test playwright/tests/zero-base-frames.spec.ts",
    );
    process.exit(1);
  }
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

  /* ------------------------------------------------ reference authority ---- */

  /**
   * Reference fidelity, against the checksum-bound accepted package.
   *
   * An earlier version of this gate reported the comparison as UNAVAILABLE. It
   * was wrong: it generalised a note about the archived v2 *check PNGs* —
   * "history, not evidence" — into a claim about the whole package, without
   * opening the active `.dc.html` artifacts the master plan names as visual
   * authority. Those artifacts declare, per artboard, the `data-el` regions,
   * `data-ctl` controls and `data-collection` collections a composition must
   * carry, and `verify-reference-anatomy` compares the rendered frames against
   * them. The archive is bound to the SHA-256 recorded in SOURCE.md, so a
   * changed reference fails extraction rather than silently redefining
   * correctness.
   */
  const declared = crosswalk();
  const substituted = Object.keys(SUBSTITUTED_FRAMES).filter((id) => declared[id]);
  console.log(`\n  frames rendering a substituted fragment   ${substituted.length}`);
  for (const id of substituted.slice(0, 12)) {
    console.log(`    ${id} — ${SUBSTITUTED_FRAMES[id]}`);
  }
  if (substituted.length > 12) console.log(`    … and ${substituted.length - 12} more`);

  const anatomy = compareAnatomy();
  const unmatched = anatomy.filter(
    (frame) =>
      !frame.rendered ||
      frame.missingEls.length > 0 ||
      frame.missingCtls.length > 0 ||
      frame.missingCollections.length > 0,
  );
  console.log(
    `
  reference comparison                     ${anatomy.length - unmatched.length}/${anatomy.length} artboards`,
  );
  for (const frame of unmatched.slice(0, 8)) {
    console.log(
      `    ${frame.id} — missing ${[...frame.missingEls, ...frame.missingCtls, ...frame.missingCollections].join(", ")}`,
    );
  }

  if (unmatched.length > 0) {
    console.log(
      `
FAIL: G10 is not satisfied. ${unmatched.length} artboards do not carry the anatomy the
` +
        "accepted design package declares. Captures are not fidelity.",
    );
    process.exit(1);
  }

  if (substituted.length > 0) {
    console.log(
      `\nFAIL: G10 is not satisfied. ${substituted.length} frames render a substituted fragment\n` +
        "rather than the canonical leaf composition.",
    );
    process.exit(1);
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
  console.log(
    `\nPASS: all ${result.totals.all} frames captured from canonical compositions, with no\n` +
      `substitutions, and all ${anatomy.length} accepted artboards match the checksum-bound\n` +
      "design package.",
  );
}
