/**
 * WP-26 group 3 — G6/G7 reconciliation, from executed results only.
 *
 * Reads the manifest written by the state-matrix suite and nothing else. Source
 * text is never evidence here, for the same reason it stopped being evidence in
 * the flow matrix: the artifact under test cannot also be the proof.
 *
 * Both gates fail closed below their full denominator.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MATRIX_SPECS,
  STATE_RESULTS_DIR,
  requiredInteractionKeys,
  requiredStateCases,
} from "@/lib/zero-base/state-interaction-cases";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Manifest {
  commit: string;
  states: { required: number; executed: number; missing: string[]; cases: string[] };
  interactions: { required: number; executed: number; missing: string[]; cases: string[] };
}

/**
 * Union every fragment written by this run.
 *
 * Each test file writes its own fragment because vitest isolates workers. The
 * union is safe in the only direction that matters: a fragment records a case
 * only after its assertions passed, so merging can add coverage but never
 * invent it.
 */
export function latestResults(): { files: string[]; states: Set<string>; interactions: Set<string> } | null {
  const dir = path.join(ROOT, STATE_RESULTS_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) return null;

  const states = new Set<string>();
  const interactions = new Set<string>();
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    for (const id of manifest.states?.cases ?? []) states.add(id);
    for (const key of manifest.interactions?.cases ?? []) interactions.add(key);
  }
  return { files: files.map((file) => path.relative(ROOT, file)), states, interactions };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const requiredStates = requiredStateCases();
  const requiredKeys = requiredInteractionKeys();
  const results = latestResults();

  console.log("zero-base state truth & interaction reconciliation (G6 / G7)\n");
  console.log(`  matrices declared          ${MATRIX_SPECS.length}`);
  console.log(`  state cases required       ${requiredStates.length}`);
  console.log(`  interaction keys required  ${requiredKeys.length}`);

  if (!results) {
    console.log("\nFAIL: no executed results manifest. Run the state matrix suite first:");
    console.log("  npx vitest run components/zero-base/states/state-matrix.test.tsx");
    process.exit(1);
  }

  const { states, interactions } = results;
  const missingStates = requiredStates.filter((id) => !states.has(id));
  const missingKeys = requiredKeys.filter((key) => !interactions.has(key));

  console.log(`  evidence                   ${results.files.join(", ")}\n`);

  for (const matrix of MATRIX_SPECS) {
    const need = requiredStates.filter((id) => id.startsWith(`${matrix.id}::`));
    const have = need.filter((id) => states.has(id));
    const status = have.length === need.length ? "ok" : "INCOMPLETE";
    console.log(`  ${matrix.id.padEnd(4)} ${status.padEnd(11)} ${have.length}/${need.length}  ${matrix.title}`);
  }

  console.log(`\n  G6 state cases       ${states.size}/${requiredStates.length}`);
  console.log(`  G7 interaction keys  ${interactions.size}/${requiredKeys.length}`);

  let failed = false;
  if (missingStates.length > 0) {
    console.log(`\n  missing state cases (${missingStates.length}): ${missingStates.join(", ")}`);
    failed = true;
  }
  if (missingKeys.length > 0) {
    console.log(`\n  interaction keys with no executed case: ${missingKeys.length} of ${requiredKeys.length}`);
    console.log(`    first 10: ${missingKeys.slice(0, 10).join(", ")}`);
    failed = true;
  }

  if (failed) {
    console.log("\nFAIL: G6 requires every applicable state branch and G7 every interaction key.");
    process.exit(1);
  }
  console.log("\nPASS: G6 and G7 fully reconciled from executed cases.");
}
