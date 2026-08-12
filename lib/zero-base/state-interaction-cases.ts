/**
 * WP-26 group 3 — the G6/G7 case denominators, and the record of what executed.
 *
 * Two denominators, both read from authorities rather than restated:
 *
 * - **G6 state truth**: the nine state matrices `M1…M9` the design spec
 *   declares, crossed with the state branches each one can actually express.
 * - **G7 interaction**: the 142 `InteractionContractKey`s in the generated
 *   contract registry.
 *
 * As with the flow matrix, a case is recorded only *after* its assertions pass,
 * and the reconciler reads the emitted manifest and nothing else. Source text is
 * never evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GENERATED_CONTRACT_KEYS } from "@/lib/zero-base/generated-contracts";

/** The state branches G6 requires wherever a surface can express them. */
export type StateBranch =
  | "loading"
  | "success"
  | "empty"
  | "partial_stale"
  | "error"
  | "rate_limit"
  | "offline"
  | "permission"
  | "row_gone"
  | "confirmation"
  | "progress"
  | "read_back_verified"
  | "read_back_failed"
  | "read_back_ambiguous"
  | "disabled_prerequisite";

export interface MatrixSpec {
  id: string;
  title: string;
  branches: StateBranch[];
}

/**
 * The nine matrices, with the branches each must prove.
 *
 * Per-matrix rather than uniform: M8 (shares) has no read-back ceremony, and
 * M1 (identity) has no row-gone. Requiring every branch everywhere would force
 * fabricated cases, which is the opposite of state truth.
 */
export const MATRIX_SPECS: readonly MatrixSpec[] = [
  { id: "M1", title: "Authentication & identity", branches: ["loading", "success", "error", "permission"] },
  { id: "M2", title: "Plan intent vs real authorization", branches: ["success", "permission", "disabled_prerequisite"] },
  {
    id: "M3",
    title: "Business / provider / account assignment",
    branches: ["success", "empty", "permission", "confirmation", "read_back_verified", "read_back_failed"],
  },
  {
    id: "M4",
    title: "Data states",
    branches: ["loading", "success", "empty", "partial_stale", "error", "rate_limit", "offline"],
  },
  { id: "M5", title: "Meta decision & workflow", branches: ["success", "empty", "row_gone", "permission"] },
  { id: "M6", title: "Creative Engine V3 posture", branches: ["success", "permission", "disabled_prerequisite"] },
  {
    id: "M7",
    title: "Mutation lifecycle",
    branches: ["confirmation", "progress", "read_back_verified", "read_back_failed", "read_back_ambiguous"],
  },
  { id: "M8", title: "Shares", branches: ["success", "empty", "row_gone", "disabled_prerequisite"] },
  { id: "M9", title: "Responsive & delivery targets", branches: ["success", "partial_stale"] },
] as const;

export function stateCaseId(matrix: string, branch: StateBranch): string {
  return `${matrix}::${branch}`;
}

export function requiredStateCases(): string[] {
  return MATRIX_SPECS.flatMap((matrix) => matrix.branches.map((branch) => stateCaseId(matrix.id, branch)));
}

/** The 142 interaction contract keys, from the generated registry. */
export function requiredInteractionKeys(): string[] {
  return [...GENERATED_CONTRACT_KEYS];
}

/* ------------------------------------------------------------- recording */

const states = new Set<string>();
const interactions = new Set<string>();

export function recordState(matrix: string, branch: StateBranch): void {
  states.add(stateCaseId(matrix, branch));
}

/** Records an interaction key as exercised. Unknown keys are rejected. */
export function recordInteraction(key: string): void {
  if (!GENERATED_CONTRACT_KEYS.includes(key as (typeof GENERATED_CONTRACT_KEYS)[number])) {
    throw new Error(`"${key}" is not an interaction contract key in the generated registry.`);
  }
  interactions.add(key);
}

export const STATE_RESULTS_DIR = path.join("playwright", "artifacts", "state-results");

/**
 * Write this worker's fragment.
 *
 * Vitest runs each test file in its own worker, so a single shared module
 * instance cannot accumulate every case. Each file writes a fragment tagged
 * with its own name and the reconciler unions them — which is also why a
 * fragment can never overstate coverage: it only ever contains what that
 * worker actually executed.
 */
export function writeStateResults(commit: string, tag = "states"): string {
  const dir = path.resolve(process.cwd(), STATE_RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${commit}.${tag}.json`);

  const requiredStates = requiredStateCases();
  const requiredKeys = requiredInteractionKeys();
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        commit,
        states: {
          required: requiredStates.length,
          executed: states.size,
          missing: requiredStates.filter((id) => !states.has(id)),
          cases: [...states].sort(),
        },
        interactions: {
          required: requiredKeys.length,
          executed: interactions.size,
          missing: requiredKeys.filter((key) => !interactions.has(key)),
          cases: [...interactions].sort(),
        },
      },
      null,
      2,
    )}\n`,
  );
  return file;
}
