/**
 * Canonical zero-base route registry.
 *
 * The 74 leaves are the design's URL authority. Legacy routes stay reachable
 * until WP-27; this module only describes the mapping, it does not redirect.
 */
import {
  GENERATED_LEAVES,
  type GeneratedLeaf,
  type LeafId,
  type LegacyMappingMode,
} from "@/lib/zero-base/generated-contracts";

export type { GeneratedLeaf, LeafId, LegacyMappingMode };

export const LEAVES = GENERATED_LEAVES;

export const LEAF_BY_ID: ReadonlyMap<LeafId, GeneratedLeaf> = new Map(
  LEAVES.map((leaf) => [leaf.leaf, leaf]),
);

export function leafById(id: LeafId): GeneratedLeaf {
  const leaf = LEAF_BY_ID.get(id);
  if (!leaf) throw new Error(`unknown zero-base leaf: ${id}`);
  return leaf;
}

/** Every legacy record, flattened with the leaf that owns it. */
export interface LegacyMapping {
  readonly leaf: LeafId;
  readonly canonicalUrl: string;
  readonly availability: string;
  readonly route: string;
  readonly mode: LegacyMappingMode;
}

export const LEGACY_MAPPINGS: readonly LegacyMapping[] = LEAVES.flatMap((leaf) =>
  leaf.legacy.map((record) => ({
    leaf: leaf.leaf,
    canonicalUrl: leaf.url,
    availability: leaf.availability,
    route: record.route,
    mode: record.mode,
  })),
);

/** An alias keeps its URL; everything else is a changed path needing a shim. */
export const ALIAS_MAPPINGS = LEGACY_MAPPINGS.filter((m) => m.mode === "alias");
export const CHANGED_MAPPINGS = LEGACY_MAPPINGS.filter((m) => m.mode !== "alias");

/** `/settings` splits into two leaves, so records > unique paths. */
export const UNIQUE_CHANGED_PATHS: readonly string[] = [
  ...new Set(CHANGED_MAPPINGS.map((m) => m.route)),
].sort();

export const NEW_SURFACE_LEAVES = LEAVES.filter(
  (leaf) => leaf.availability === "new-surface",
);
export const LEAVES_WITHOUT_LEGACY = LEAVES.filter((leaf) => leaf.legacy.length === 0);
