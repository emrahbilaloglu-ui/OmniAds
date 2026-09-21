import { createHash } from "node:crypto";

import type { CommerceCostStructure } from "@/src/types/commerce-cost";

/**
 * The concurrency token for a stored cost structure.
 *
 * Canonical: object keys are sorted, so two structures that mean the same
 * thing hash the same however their JSON happened to be ordered. Array order
 * is preserved, because component order is meaningful.
 *
 * `undefined` is dropped and `null` is kept, because absent and explicitly
 * null are different answers in this domain — one is "nobody said", the other
 * is "there is no end date" — and a token that confused them would let a
 * concurrent edit slip through.
 */

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/**
 * The canonical form of any value under the same rules.
 *
 * Shared so that "are these two components the same?" is decided exactly the
 * way "is this the same structure?" is, rather than by a second opinion that
 * could call two things equal when the revision says they differ.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalCostStructureJson(structure: CommerceCostStructure): string {
  return canonicalJson(structure);
}

/** SHA-256 of the canonical form, hex encoded. */
export function costStructureRevision(structure: CommerceCostStructure): string {
  return createHash("sha256").update(canonicalCostStructureJson(structure)).digest("hex");
}

/** The token a caller must echo back to write. Empty structures still have one. */
export function costStructureRevisionOf(structure: CommerceCostStructure | null): string | null {
  return structure ? costStructureRevision(structure) : null;
}
