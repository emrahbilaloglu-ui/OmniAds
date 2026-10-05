import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalSha, need, sha256 } from "./common";

/** Allowlisted pinned source pack. Exactly these repo-relative files form the
 * reviewed executor; anything else (free shell/SQL/command paths/assets) is not
 * an input. Files not owned by the batch/admission work must be byte-identical
 * to the target revision blob. This is NOT a transitive closure of every module
 * the libraries import. */
export const REPO_ROOT = resolve(__dirname, "../..");
/** The repo's own tsx loader by absolute path (children run in owned cwd without node_modules). */
export const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");
export const BATCH_FILES = ["common.ts", "rw-unit-inventory.ts", "capture.ts", "restore.ts", "retire.ts", "maintenance.ts",
  "source-pack.ts", "journal.ts", "backend.ts", "stage-entry.ts", "cli.ts", "http-proof.ts", "production-transport.ts", "production-actor.py", "production-cli.ts"].map(f => `scripts/native-storage-batch/${f}`);
/** Codex-owned, reviewed separately; uncommitted at the target revision. */
export const ADMISSION_FILES = ["lib/creative-decision-engine/native-finite-storage-lifecycle.ts",
  "lib/sync/native-storage-maintenance-admission.ts"];
export const PINNED_LIBRARY_FILES = ["lib/creative-decision-engine/canonical-evaluation.ts",
  "lib/creative-decision-engine/native-evidence-archive.ts", "lib/creative-decision-engine/native-calibration-parent-archive.ts",
  "lib/creative-decision-engine/native-archive-pin-census.ts", "lib/creative-decision-engine/native-evaluation-context-unit.ts",
  "lib/creative-decision-engine/native-job-evaluation-selection.ts", "lib/creative-decision-engine/native-job-snapshot-selection.ts",
  "lib/creative-decision-engine/native-reference-archive-segments.ts", "lib/creative-decision-engine/native-historical-archive.ts",
  "lib/creative-decision-engine/native-historical-local-store.ts", "lib/creative-decision-engine/native-historical-catalog-routing.ts",
  "lib/creative-decision-engine/native-historical-catalog-routing-store.ts", "lib/creative-decision-engine/native-historical-archive-reader.ts",
  "lib/creative-decision-engine/native-historical-archive-worker.ts", "lib/creative-decision-engine/native-historical-archive-worker-client.ts",
  "lib/creative-decision-engine/native-historical-read-controls.ts", "lib/sync/db-growth-fence.ts", "lib/db.ts", "lib/migrations.ts",
  "scripts/run-migrations.ts", "scripts/build-native-historical-worker.mjs"];
export const SOURCE_PACK_CONTRACT = "native-storage-batch-source-pack.v2" as const;

/** `targetRevision` = operator source revision (plan); `runtimeRevision` =
 * the live image revision the stage bundle runs inside. Every pinned library
 * must be byte-identical at BOTH revisions, so the bundle the actor ships is
 * the same library code the live runtime already executes. */
export async function computeSourcePack(targetRevision: string, root = REPO_ROOT, runtimeRevision = targetRevision) {
  need(/^[a-f0-9]{40}$/.test(targetRevision) && /^[a-f0-9]{40}$/.test(runtimeRevision), "EXACT_TARGET_REVISION");
  const entries = [];
  for (const path of [...BATCH_FILES, ...ADMISSION_FILES, ...PINNED_LIBRARY_FILES].sort()) {
    const bytes = await readFile(join(root, path));
    entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const pinned = new Set(PINNED_LIBRARY_FILES);
  for (const entry of entries.filter(e => pinned.has(e.path))) {
    // Read-only local object lookups; refuses when the working file drifted
    // from the exact operator revision or the live runtime revision.
    for (const revision of [...new Set([targetRevision, runtimeRevision])]) {
      const blob = execFileSync("git", ["-C", root, "cat-file", "blob", `${revision}:${entry.path}`], { maxBuffer: 64 * 1024 * 1024 });
      need(sha256(blob) === entry.sha256, `SOURCE_UNKNOWN_DRIFT:${entry.path}`);
    }
  }
  const manifest = { contract: SOURCE_PACK_CONTRACT, targetRevision, runtimeRevision, entries };
  return { manifest, sourceManifestSha256: canonicalSha(manifest) };
}

/** The review is the ACTUAL completed review document whose bytes hash to the
 * plan's actualSourceReviewSha256. It must name this exact source manifest and
 * carry an execution approval; any change request or a different manifest
 * refuses. An owned-fixture review is only accepted by the owned host. */
export async function verifySourceReview(reviewPath: string, input: { sourceManifestSha256: string;
  actualSourceReviewSha256: string; mode: "owned" | "production" }) {
  const bytes = await readFile(reviewPath);
  need(bytes.length > 0 && bytes.length <= 512 * 1024, "BOUNDED_REVIEW_DOCUMENT");
  const digest = sha256(bytes), text = bytes.toString("utf8");
  need(digest === input.actualSourceReviewSha256, "ACTUAL_REVIEW_DIGEST_MISMATCH");
  const named = [...new Set(text.match(/\b[a-f0-9]{64}\b/g) ?? [])];
  need(named.includes(input.sourceManifestSha256), "REVIEW_DOES_NOT_NAME_SOURCE_MANIFEST");
  need(/\bAPPROVE_EXECUTION\b/.test(text) && !/\bREQUEST_CHANGES\b/.test(text), "SOURCE_REVIEW_NOT_APPROVED");
  const ownedFixture = /\bOWNED_FIXTURE_REVIEW\b/.test(text);
  need(input.mode === "owned" || !ownedFixture, "OWNED_FIXTURE_REVIEW_NOT_PRODUCTION");
  return { actualSourceReviewSha256: digest, ownedFixtureReview: ownedFixture };
}
