/**
 * WP-26 step 2 — the flow case denominator, and the record of what executed.
 *
 * The previous reconciler grepped source files for "Flow X" and a viewport
 * number. A comment could satisfy it. That is circular: the artifact under test
 * was also the evidence. This module replaces it with a denominator declared up
 * front and a manifest that only a **passing mounted assertion** can write to.
 *
 * A case id is `<flow>::<width>::<branch>`. Nothing records a case except the
 * test that drove it, and it records *after* its assertions, so a thrown
 * expectation leaves the case absent rather than green.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Widths the plan names for the narrow matrix. */
export const ALL_WIDTHS = [1440, 1280, 768, 390, 320] as const;
/** Flows that must hold at every width, not only 1440. */
export const NARROW_FLOWS = ["Flow A", "Flow B", "Flow I", "Flow L"] as const;

export type Branch =
  | "success"
  | "permission"
  | "empty"
  | "partial"
  | "failure"
  | "read_back";

export interface FlowSpec {
  id: string;
  title: string;
  /** Branches this flow must prove. Success is never sufficient alone. */
  branches: Branch[];
}

/**
 * The 13 flows and the branches each must exercise.
 *
 * Branch sets are per-flow rather than uniform because the flows differ: a read
 * surface has no read-back, and a flow with no permission split cannot prove
 * one. Each set is the plan's "applicable" branches for that flow.
 */
export const FLOW_SPECS: readonly FlowSpec[] = [
  { id: "Flow A", title: "Honest agency entry", branches: ["success", "permission", "empty"] },
  { id: "Flow B", title: "Meta decision to supported action", branches: ["success", "failure", "permission"] },
  { id: "Flow C", title: "Needs Resolution", branches: ["success", "partial"] },
  { id: "Flow D", title: "Creative refresh", branches: ["success", "empty"] },
  { id: "Flow E", title: "Meta launch preparation", branches: ["success", "permission"] },
  { id: "Flow F", title: "Google manual plan & default-off writes", branches: ["success", "permission"] },
  { id: "Flow G", title: "Report delivery", branches: ["success", "failure", "empty"] },
  { id: "Flow H", title: "Integration recovery", branches: ["success", "permission", "read_back"] },
  { id: "Flow I", title: "Meta automation safety", branches: ["success", "permission"] },
  { id: "Flow J", title: "Admin incident response", branches: ["success", "failure", "read_back"] },
  { id: "Flow K", title: "Onboarding & invite", branches: ["success", "failure"] },
  { id: "Flow L", title: "Share lifecycle", branches: ["success", "empty"] },
  { id: "Flow M", title: "Account & business lifecycle", branches: ["success", "permission"] },
] as const;

export function requiredWidths(flowId: string): readonly number[] {
  return (NARROW_FLOWS as readonly string[]).includes(flowId) ? ALL_WIDTHS : [1440];
}

export function caseId(flow: string, width: number, branch: Branch): string {
  return `${flow}::${width}::${branch}`;
}

/**
 * Every case the matrix requires.
 *
 * Narrow flows must prove every branch at every width; a flow that works at
 * 1440 and loses its permission refusal at 320 is exactly the defect the
 * five-width requirement exists to catch.
 */
export function requiredCases(): string[] {
  const cases: string[] = [];
  for (const flow of FLOW_SPECS) {
    for (const width of requiredWidths(flow.id)) {
      for (const branch of flow.branches) cases.push(caseId(flow.id, width, branch));
    }
  }
  return cases;
}

/* ------------------------------------------------------------- recording */

const executed = new Set<string>();

/** Called by a test only after its assertions have passed. */
export function recordFlowCase(flow: string, width: number, branch: Branch): void {
  executed.add(caseId(flow, width, branch));
}

export function executedCases(): string[] {
  return [...executed].sort();
}

export const FLOW_RESULTS_DIR = path.join("playwright", "artifacts", "flow-results");

/**
 * Write the manifest of cases that actually ran and passed.
 *
 * The reconciler reads this and nothing else, so source text can no longer
 * masquerade as coverage.
 */
export function writeFlowResults(commit: string): string {
  const dir = path.resolve(process.cwd(), FLOW_RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${commit}.json`);
  const required = requiredCases();
  const passed = executedCases();
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        commit,
        required: required.length,
        executed: passed.length,
        missing: required.filter((id) => !passed.includes(id)),
        cases: passed,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}
