/**
 * WP-26 step 2 — flow × viewport reconciliation, from executed results only.
 *
 * The first version of this script grepped source files for "Flow X" and a
 * viewport number, so a comment could satisfy it. That was circular: the thing
 * under test was also the evidence.
 *
 * It now reads exactly one input — the manifest written by
 * `components/zero-base/flows/flow-matrix.test.tsx`, which records a case id
 * only *after* that case's assertions have passed. Source text cannot reach
 * this file, and a failing case simply never appears.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLOW_RESULTS_DIR, requiredCases, FLOW_SPECS } from "@/lib/zero-base/flows/flow-cases";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface FlowManifest {
  commit: string;
  required: number;
  executed: number;
  missing: string[];
  cases: string[];
}

/** The most recently written results manifest. */
export function latestResults(): { file: string; manifest: FlowManifest } | null {
  const dir = path.join(ROOT, FLOW_RESULTS_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) return null;
  return { file: files[0], manifest: JSON.parse(readFileSync(files[0], "utf8")) as FlowManifest };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const required = requiredCases();
  const results = latestResults();

  console.log("zero-base flow × viewport matrix (WP-26 step 2)\n");
  console.log(`  flows declared              ${FLOW_SPECS.length}`);
  console.log(`  required cases              ${required.length}`);

  if (!results) {
    console.log("\nFAIL: no executed results manifest. Run the flow matrix suite first:");
    console.log("  npx vitest run components/zero-base/flows/flow-matrix.test.tsx");
    process.exit(1);
  }

  const executed = new Set(results.manifest.cases);
  const missing = required.filter((id) => !executed.has(id));

  console.log(`  executed & passing cases    ${executed.size}`);
  console.log(`  evidence                    ${path.relative(ROOT, results.file)}\n`);

  // Per-flow rollup, so a gap names its flow rather than only a case id.
  for (const flow of FLOW_SPECS) {
    const flowRequired = required.filter((id) => id.startsWith(`${flow.id}::`));
    const flowDone = flowRequired.filter((id) => executed.has(id));
    const status = flowDone.length === flowRequired.length ? "ok" : "INCOMPLETE";
    console.log(
      `  ${flow.id.padEnd(7)} ${status.padEnd(11)} ${flowDone.length}/${flowRequired.length}  ${flow.title}`,
    );
  }

  if (missing.length > 0) {
    console.log(`\n  missing ${missing.length}:`);
    for (const id of missing) console.log(`    ${id}`);
    console.log("\nFAIL: the flow matrix is incomplete.");
    process.exit(1);
  }

  console.log(
    `\nPASS: ${executed.size}/${required.length} required flow cases executed and passed ` +
      `across all ${FLOW_SPECS.length} flows.`,
  );
}
